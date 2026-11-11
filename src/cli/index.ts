import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { IronFlockOSCatalog } from '../main/security/catalog'
import { IRONFLOCKOS_CATALOG_PUBLIC_KEYS, parsePublicKeys } from '../main/security/catalog'
import { loadIronFlockOSCatalog } from '../main/api/catalogs'
import { CommandRunner, INSTALLER_CONF_FILE, installerConf } from '../main/utils/config-partition'
import { DeviceFile, writeDeviceFiles } from '../main/utils/device-files'
import { sortImages } from '../shared/images'
import type { ImageInfo } from '../types'
import { Command, FlashOptions, USAGE, UsageError, parseCommandLine } from './args'
import {
  Disk,
  DiskDeps,
  assertSupportedPlatform,
  describeDisk,
  flushDiskCache,
  humanSize,
  inspectDisk,
  listDisks,
  unmountDisk
} from './disks'
import { verifiedImage } from './image'
import { choosePlan, readDeviceFile } from './plan'
import { writeImage } from './write'

// flockflasher, the command-line tool: FlockFlasher's catalog, image checks
// and device-file handling without the app (README, "Command line"). Messages
// and progress go to stderr, tables and JSON to stdout.

declare const __FLOCKFLASHER_VERSION__: string
export const VERSION =
  typeof __FLOCKFLASHER_VERSION__ === 'string' ? __FLOCKFLASHER_VERSION__ : 'dev'

// FlockFlasher's cache (REFLASHER_CONFIG_PATH in api/boards.ts): the verified
// catalog and the downloads.
const DEFAULT_CACHE_DIR = path.join(homedir(), '.Reflasher')

const out = (line = '') => process.stdout.write(`${line}\n`)
const say = (line = '') => process.stderr.write(`${line}\n`)

// Commands run without a shell, from an argv array.
export const run: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim()
          reject(new Error(`${command} ${args[0] ?? ''} failed: ${detail}`))
        } else {
          resolve({ stdout })
        }
      }
    )
  })

// A progress line that rewrites itself on a terminal and prints every 10%
// otherwise (a log file, CI).
const progressLine = (label: string) => {
  const tty = process.stderr.isTTY === true
  let shown = -1
  return {
    update(done: number, total: number) {
      const percent = total > 0 ? Math.min(100, Math.floor((done * 100) / total)) : 0
      if (tty) {
        if (percent !== shown) {
          process.stderr.write(
            `\r${label} ${percent}% (${humanSize(done)} of ${humanSize(total)})  `
          )
          shown = percent
        }
      } else {
        const step = percent - (percent % 10)
        if (step > shown) {
          say(`${label} ${step}%`)
          shown = step
        }
      }
    },
    end() {
      if (tty && shown >= 0) process.stderr.write('\n')
      shown = -1
    }
  }
}

const loadCatalog = async (cacheDir: string): Promise<IronFlockOSCatalog> => {
  const { catalog, fromCache } = await loadIronFlockOSCatalog({
    cacheDir,
    keys: parsePublicKeys(IRONFLOCKOS_CATALOG_PUBLIC_KEYS)
  })
  say(
    `IronFlockOS catalog of ${catalog.issuedAt}, signed with key ${catalog.keyId}` +
      (fromCache ? ' (the copy verified before: the download server did not answer)' : '')
  )
  return catalog
}

// ----------------------------------------------------------------- images --

type ImageRow = ImageInfo & { hardware: string[] }

const catalogImages = (catalog: IronFlockOSCatalog): ImageRow[] => {
  const rows = new Map<string, ImageRow>()
  for (const board of catalog.boards) {
    for (const image of sortImages(board.latestImages)) {
      const row = rows.get(image.image_id) ?? { ...image, hardware: [] }
      row.hardware.push(board.modelname)
      rows.set(image.image_id, row)
    }
  }
  return [...rows.values()]
}

const table = (rows: string[][]) => {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)))
  for (const row of rows)
    out(
      row
        .map((cell, i) => cell.padEnd(widths[i]))
        .join('  ')
        .trimEnd()
    )
}

const images = async (json: boolean) => {
  const catalog = await loadCatalog(DEFAULT_CACHE_DIR)
  const rows = catalogImages(catalog)
  if (json) {
    out(
      JSON.stringify(
        { production: catalog.production, issued_at: catalog.issuedAt, images: rows },
        null,
        2
      )
    )
    return
  }
  table([
    ['IMAGE', 'VERSION', 'DOWNLOAD', 'HARDWARE'],
    ...rows.map((image) => [
      image.image_id,
      image.version,
      humanSize(image.size),
      image.hardware.join(', ') +
        (image.variant === 'installer'
          ? ` (installer stick for ${(image.payloads ?? []).join(', ')})`
          : '')
    ])
  ])
}

// ----------------------------------------------------------------- drives --

const drives = async (all: boolean, json: boolean, deps: DiskDeps) => {
  const disks = (await listDisks(deps)).filter((disk) => all || !disk.refusal)
  if (json) {
    out(JSON.stringify(disks, null, 2))
    return
  }
  if (disks.length === 0) {
    say('No disk to write: insert an SD card or a USB stick (--all lists every disk)')
    return
  }
  table([
    ['DEVICE', 'SIZE', 'BUS', 'MODEL', ...(all ? ['WRITABLE'] : [])],
    ...disks.map((disk) => [
      disk.device,
      humanSize(disk.size),
      disk.transport || '-',
      disk.model || '-',
      ...(all ? [disk.refusal ? `no: ${disk.refusal}` : 'yes'] : [])
    ])
  ])
}

// ------------------------------------------------------------------ flash --

const confirmErase = async (disk: Disk) => {
  if (!process.stdin.isTTY) {
    throw new Error(`No terminal to ask on: pass --yes to erase ${disk.device}`)
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await prompt.question(
      `Everything on ${disk.device} is erased. Type yes to write it: `
    )
    if (answer.trim() !== 'yes') throw new Error('Stopped: nothing was written')
  } finally {
    prompt.close()
  }
}

const sameDisk = (a: Disk, b: Disk) => a.size === b.size && a.model === b.model

export const flash = async (options: FlashOptions, deps: DiskDeps) => {
  assertSupportedPlatform(deps.platform)
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR

  const flock = await readDeviceFile(
    options.flock,
    options.wifiSsid === undefined
      ? undefined
      : { ssid: options.wifiSsid, password: options.wifiPassword }
  )
  const catalog = await loadCatalog(cacheDir)
  const plan = choosePlan(catalog.boards, flock.config, {
    image: options.image,
    installer: options.installer !== undefined
  })
  for (const warning of plan.warnings) say(`Warning: ${warning}`)
  const files: DeviceFile[] = [{ name: flock.name, data: flock.data }]
  if (plan.payload) {
    files.push({
      name: INSTALLER_CONF_FILE,
      data: Buffer.from(installerConf(plan.payload.image_id, options.installer))
    })
  }

  const disk = await inspectDisk(options.device, deps)
  if (disk.refusal) throw new Error(`${disk.device} ${disk.refusal}: nothing was written`)

  say(`Device file:  ${flock.name} (${String(flock.config.name)})`)
  if (plan.payload) {
    say(`Image:        ${plan.write.image_id} ${plan.write.version}, the installer stick`)
    say(`It installs:  ${plan.payload.image_id} on ${plan.board.modelname}`)
  } else {
    say(`Image:        ${plan.write.image_id} ${plan.write.version} (${plan.board.modelname})`)
  }
  if (options.wifiSsid !== undefined) say(`WiFi:         ${options.wifiSsid}`)
  say(`Disk:         ${describeDisk(disk)}`)
  if (!options.yes) await confirmErase(disk)

  const download = progressLine('Downloading')
  const source = await verifiedImage(plan.write, {
    cacheDir,
    imageFile: options.imageFile,
    onChecking: (file) => say(`Checking ${file} against the catalog`),
    onDownload: (done, total) => download.update(done, total)
  })
  download.end()
  if (source.from === 'download') say(`Downloaded and checked ${plan.write.file}`)

  // The disk may have been swapped while the image was prepared.
  const target = await inspectDisk(options.device, deps)
  if (target.refusal || !sameDisk(disk, target)) {
    throw new Error(`${disk.device} changed while the image was prepared: nothing was written`)
  }
  await unmountDisk(target, deps)

  const writing = progressLine('Writing')
  const verifying = progressLine('Checking')
  let phase: 'writing' | 'verifying' = 'writing'
  let result
  try {
    result = await writeImage({
      source: source.path,
      sourceBytes: plan.write.size,
      target: target.rawDevice,
      verify: options.verify,
      onProgress: (progress) => {
        if (progress.phase !== phase) {
          writing.end()
          phase = progress.phase
        }
        ;(progress.phase === 'writing' ? writing : verifying).update(progress.done, progress.total)
      },
      beforeVerify: () => flushDiskCache(target, deps),
      onWarning: (message) => say(`Warning: ${message}`)
    })
  } catch (error: any) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new Error(`No permission to write ${target.rawDevice}: run flockflasher with sudo`)
    }
    if (error?.code === 'EBUSY') {
      throw new Error(`${target.device} is in use (mounted or opened by another program)`)
    }
    throw error
  } finally {
    writing.end()
    verifying.end()
  }
  say(
    `Wrote ${humanSize(result.bytes)} to ${target.device}` +
      (result.verified ? ' and read it back: it matches' : ' (not read back)')
  )

  await writeDeviceFiles(deps.platform, target.device, files, {
    run: deps.run,
    runElevated: deps.run,
    uid: process.getuid?.(),
    gid: process.getgid?.()
  })
  say(`Wrote ${files.map((f) => f.name).join(' and ')} to its IRONFLOCKOS partition`)

  if (plan.payload) {
    const installer = options.installer ?? {}
    say(
      `Done. Boot the PC from the stick: the installer writes ${plan.payload.image_id} to ` +
        `${installer.disk && installer.disk !== 'largest' ? installer.disk : 'its largest internal disk'}` +
        (installer.confirm === false ? ' without asking.' : ' once you confirm on its console.')
    )
  } else {
    say(
      `Done. Start the device from ${target.device}: it enrolls with ${flock.name} on its first boot.`
    )
  }
}

// ------------------------------------------------------------------- main --

export const main = async (argv: string[], deps?: Partial<DiskDeps>): Promise<number> => {
  // Logs of the shared modules go to stderr with the messages.
  console.log = console.error
  console.info = console.error

  let command: Command
  try {
    command = parseCommandLine(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    say(`flockflasher: ${error.message}`)
    say('flockflasher help shows the usage.')
    return 2
  }

  const diskDeps: DiskDeps = { platform: process.platform, run, ...deps }
  try {
    switch (command.command) {
      case 'help':
        out(USAGE)
        break
      case 'version':
        out(`flockflasher ${VERSION}`)
        break
      case 'images':
        await images(command.json)
        break
      case 'drives':
        assertSupportedPlatform(diskDeps.platform)
        await drives(command.all, command.json, diskDeps)
        break
      case 'flash':
        await flash(command, diskDeps)
        break
    }
    return 0
  } catch (error) {
    say(`flockflasher: ${(error as Error)?.message ?? error}`)
    return 1
  }
}
