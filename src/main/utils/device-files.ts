import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isSafePathSegment } from '../security/validation'
import { CommandRunner, mountConfigPartition } from './config-partition'

// Writes the device file (and, on an installer stick, installer.conf) onto a
// flashed drive: the FAT partition labelled IRONFLOCKOS, else the first FAT
// partition, found by label and file system rather than by order, and mounted
// for the purpose if the OS did not mount it (macOS and Windows mount no EFI
// system partition by themselves). Electron-free: FlockFlasher and the
// command-line tool (src/cli) pass their own command runners.

export type DeviceFile = { name: string; data: Buffer }

export type DeviceFileDeps = {
  run: CommandRunner
  // macOS and Linux: through sudo in FlockFlasher; the command-line tool runs
  // as root already. On Windows the app is elevated already.
  runElevated: CommandRunner
  uid?: number
  gid?: number
}

const tempDir = () => mkdtemp(path.join(os.tmpdir(), 'flockflasher-'))

const writeFileDurably = async (target: string, data: Buffer) => {
  const handle = await open(target, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export const writeDeviceFiles = async (
  platform: NodeJS.Platform,
  device: string,
  files: DeviceFile[],
  deps: DeviceFileDeps
): Promise<void> => {
  for (const { name } of files) {
    if (!isSafePathSegment(name)) {
      throw new Error(`Not a file name for the IRONFLOCKOS partition: ${name}`)
    }
  }
  const mounted = await mountConfigPartition(platform, device, {
    run: deps.run,
    runElevated: deps.runElevated,
    makeTempDir: tempDir,
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
    writeTempFile: async (content) => {
      const file = path.join(await tempDir(), 'assign.txt')
      await writeFile(file, content)
      return file
    },
    // the temp file sits in a directory of its own
    removeFile: (file) => rm(path.dirname(file), { recursive: true, force: true }),
    uid: deps.uid,
    gid: deps.gid
  })
  console.log(
    `Writing the device file to ${mounted.partition.id} (${mounted.reason}) at ${mounted.mountpoint}`
  )
  try {
    for (const { name, data } of files) {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- name is a single safe path segment (checked above)
      const target = path.join(mounted.mountpoint, name)
      try {
        await writeFileDurably(target, data)
      } catch (error: any) {
        // A volume that only mounted through sudo (macOS) belongs to root.
        if (platform === 'win32' || (error?.code !== 'EACCES' && error?.code !== 'EPERM')) {
          throw error
        }
        // A temp copy, so that cp copies only data FlockFlasher made.
        const dir = await tempDir()
        try {
          await writeFile(path.join(dir, name), data)
          await deps.runElevated('cp', [path.join(dir, name), target])
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
