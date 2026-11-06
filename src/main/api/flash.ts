import { getNodeModulesResourcePath, killProcessDarwin } from '../utils'
import { ChildProcess } from 'child_process'
import { FlashItem, ImageInfo, Progress } from '../../types'
import { elevatedNodeChildProcess, elevatedSpawn, spawnAsync } from './permissions'
import { FLASH_SCRIPT } from '../security/elevated-scripts'
import { assertFlashRequest } from '../security/validation'
import { verifyFileSha256 } from '../security/integrity'
import { mkdtemp, open, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import ImageManager, { REFLASHER_CONFIG_PATH } from './boards'
import { CatalogStore } from './catalogs'
import {
  CommandRunner,
  INSTALLER_CONF_FILE,
  configFileName,
  installerConf,
  mountConfigPartition
} from '../utils/config-partition'
import { cachedImageName } from '../../shared/images'
import os from 'os'
import path from 'path'
import { Drive } from 'drivelist'

const activeFlashProcesses = new Map<number, ChildProcess>()
export const imageManager = new ImageManager()
imageManager.createReflasherDirIfNotExists().catch(console.error)
export const catalogStore = new CatalogStore({ cacheDir: REFLASHER_CONFIG_PATH })

// spawnAsync rejects with { code, stderr, ... }; the partition code wants Errors.
const asRunner =
  (spawner: typeof spawnAsync): CommandRunner =>
  async (command, args) => {
    try {
      return await spawner(command, args)
    } catch (failure: any) {
      const detail = String(failure?.stderr ?? failure?.error?.message ?? '').trim()
      throw new Error(`${command} ${args[0] ?? ''} failed (${failure?.code ?? 'error'}) ${detail}`)
    }
  }
const run = asRunner(spawnAsync)
const runElevated = asRunner(elevatedSpawn)

const writeFileDurably = async (target: string, data: Buffer) => {
  const handle = await open(target, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// Writes the device file onto the flashed drive: the FAT partition labelled
// FLOCKOS, else the first FAT partition, found by label and file system rather
// than by order, and mounted for the purpose if the OS did not mount it (macOS
// and Windows mount no EFI system partition by themselves). On an installer
// stick, installer.conf names the image it installs (`payload`).
const writeDeviceConfig = async (drive: Drive, configPath: string, payload?: string) => {
  const files: [string, Buffer][] = [[configFileName(configPath), await readFile(configPath)]]
  if (payload) files.push([INSTALLER_CONF_FILE, Buffer.from(installerConf(payload))])
  const mounted = await mountConfigPartition(process.platform, drive.device, {
    run,
    runElevated,
    makeTempDir: () => mkdtemp(path.join(os.tmpdir(), 'flockflasher-')),
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
    writeTempFile: async (content) => {
      const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'flockflasher-')), 'assign.txt')
      await writeFile(file, content)
      return file
    },
    // the temp file sits in a directory of its own
    removeFile: (file) => rm(path.dirname(file), { recursive: true, force: true }),
    uid: process.getuid?.(),
    gid: process.getgid?.()
  })
  console.log(
    `Writing the device file to ${mounted.partition.id} (${mounted.reason}) at ${mounted.mountpoint}`
  )
  try {
    for (const [name, data] of files) {
      const target = path.join(mounted.mountpoint, name)
      try {
        await writeFileDurably(target, data)
      } catch (error: any) {
        // A volume that only mounted through sudo (macOS) belongs to root.
        if (process.platform === 'win32' || (error?.code !== 'EACCES' && error?.code !== 'EPERM')) {
          throw error
        }
        // A temp copy, so that cp copies only data FlockFlasher made.
        const dir = await mkdtemp(path.join(os.tmpdir(), 'flockflasher-'))
        try {
          await writeFile(path.join(dir, name), data)
          await runElevated('cp', [path.join(dir, name), target])
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      }
    }
  } finally {
    await mounted
      .release()
      .catch((error) => console.warn('Could not release the partition:', error))
  }
}

// Downloads (or finds in the cache) a catalog image and returns the path of the
// raw image to write. The image comes from the verified catalog
// (catalogStore.resolve), never from the renderer or the .flock file, and the
// download is checked against the catalog's size and SHA-256 (both of the
// .img.gz) before it is decompressed and written.
const getCatalogImage = async (
  image: ImageInfo,
  updateState: (data: Partial<Progress>) => void
): Promise<string> => {
  const cachedImagePath = imageManager.getImagePath(image)
  if (await imageManager.checkIfImageFileExists(image)) return cachedImagePath

  const downloadTempPath = path.join(REFLASHER_CONFIG_PATH, 'temp-' + image.file)
  const realImageTempPath = path.join(REFLASHER_CONFIG_PATH, 'temp-' + cachedImageName(image.file))

  try {
    await imageManager.downloadImageToFile(image, downloadTempPath, (progress) => {
      updateState({ ...progress, type: 'downloading' })
    })

    const { size } = await stat(downloadTempPath)
    if (size !== image.size) {
      throw new Error(`${image.file} is ${size} bytes; the catalog says ${image.size}`)
    }
    await verifyFileSha256(downloadTempPath, image.sha256)

    await imageManager.unZipImage(image, downloadTempPath, (progress) => {
      updateState({ ...progress, type: 'decompressing' })
    })
    await rename(realImageTempPath, cachedImagePath)
    return cachedImagePath
  } finally {
    // Clean up both temp artifacts. They are normally consumed by the rename
    // above, but if download/verify/decompress threw they can be left behind.
    await Promise.allSettled([unlink(downloadTempPath), unlink(realImageTempPath)])
  }
}

// Flashes the FlockOS image a device file asks for, or the installer stick that
// installs it. There is no other kind of flash: assertFlashRequest refuses
// anything but a device file with catalog image keys, and what is written is
// always a catalog image (catalogStore.plan), downloaded and checked here.
export const flashDevice = async (
  flashItem: FlashItem,
  updateState: (data: Partial<Progress>) => void
) => {
  if (!flashItem.drive) throw new Error('drive not set')
  const { configPath, imageKey, installerKey } = assertFlashRequest(flashItem)

  let imagePath: string
  let payload: string | undefined
  try {
    const plan = await catalogStore.plan(imageKey, installerKey)
    payload = plan.payload?.image_id

    // Update the device file (for WiFi information, etc.)
    await writeFile(configPath, JSON.stringify(flashItem.reswarm!.config))

    imagePath = await getCatalogImage(plan.write, updateState)
  } catch (error) {
    updateState({ type: 'failed' })
    throw error
  }

  const stringifiedDrive = JSON.stringify(flashItem.drive)
  const finalType = 'configuring'
  // Requested from app.asar.unpacked: the flash subprocess runs under real Node
  // (below), which cannot require modules from inside the packed asar.
  const etcherSDKRequire = getNodeModulesResourcePath('etcher-sdk', { unpacked: true })

  // FLASH_SCRIPT is a FIXED script body — no untrusted data is interpolated into
  // it. The image path, drive JSON, final state and etcher-sdk module path are
  // passed as argv (process.argv[2..5]) and read as data, so a crafted filename /
  // drive description / serial number can never break out and run as root.
  const scriptContent = FLASH_SCRIPT

  async function handleOnExit(code: number | null, signal: NodeJS.Signals | null) {
    activeFlashProcesses.delete(flashItem.id)

    // Copy the file over when the flashing process has exited without an error code
    if (code === 0 && signal === null) {
      try {
        // Every FlockOS image is a raw image with a FLOCKOS partition
        // (the catalog accepts osvariant "image" only).
        await writeDeviceConfig(flashItem.drive!, configPath, payload)

        updateState({ type: 'finished' })
      } catch (error) {
        // This runs as an (unawaited) child-process exit callback, so a throw here
        // would become an unhandled rejection. Report it through the UI instead.
        console.error('Post-flash config copy failed:', error)
        updateState({ type: 'failed' })
      }
    }
  }

  updateState({ type: 'starting' })

  const childProcess = await elevatedNodeChildProcess(
    scriptContent,
    [imagePath, stringifiedDrive, finalType, etcherSDKRequire],
    (data) => {
      try {
        updateState(JSON.parse(data))
      } catch (error) {
        console.error('An error occurred while flashing:', data)
        updateState({ type: 'failed' })
      }
    },
    console.error,
    handleOnExit,
    undefined,
    // Run under the bundled real Node — Electron's V8 memory cage rejects the
    // external buffers etcher-sdk/direct-io needs for O_DIRECT block writes.
    true
  )

  activeFlashProcesses.set(flashItem.id, childProcess)
}

export const cancelFlashing = async (id: number) => {
  const flashProcess = activeFlashProcesses.get(id)
  if (flashProcess && flashProcess.pid) {
    if (process.platform === 'darwin') {
      // Elevated kill returns a promise; await + surface failures instead of letting
      // it float as an unhandled rejection.
      await killProcessDarwin(15, flashProcess.pid).catch((err) =>
        console.error('Failed to cancel flashing:', err)
      )
    } else {
      flashProcess.kill('SIGTERM')
    }
  }
}
