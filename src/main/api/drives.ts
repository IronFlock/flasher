import { Drive, list as listdrives } from 'drivelist'
import { elevatedNodeChildProcess, elevatedSpawn, spawnAsync } from './permissions'
import { UNMOUNT_SCRIPT } from '../security/elevated-scripts'
import { getNodeModulesResourcePath } from '../utils'

// drivelist calls still running on the libuv thread pool. One that returns
// while Electron tears the main process down aborts the app: drivelist cannot
// hand its result to JS any more and throws a Napi::Error nothing catches
// (SIGABRT, "terminating due to uncaught exception of type Napi::Error"). The
// quit therefore waits for them (whenDrivelistIdle).
const drivelistCalls = new Set<Promise<unknown>>()

export function trackDrivelistCall<T>(call: Promise<T>): Promise<T> {
  drivelistCalls.add(call)
  const done = () => drivelistCalls.delete(call)
  call.then(done, done)
  return call
}

export async function whenDrivelistIdle(): Promise<void> {
  while (drivelistCalls.size > 0) {
    await Promise.allSettled([...drivelistCalls])
  }
}

export async function listDrives() {
  const drives = await trackDrivelistCall(listdrives())
  return drives.filter((d) => d.busType !== 'UNKNOWN' && !d.isSystem && !d.isReadOnly)
}

function parseUnixPartitionOutput(output: string) {
  const splitOutput = output.split('\n')
  const indexOfHeader = splitOutput.findIndex((l) => {
    const potentialHeaderSplit = l.split(/\s/g).filter((e) => e)
    const device = potentialHeaderSplit[0] === 'Device'

    return device
  })

  const partitionInfoStringArr = splitOutput.slice(indexOfHeader + 1).filter((e) => e)

  const partitions: {
    device: string
    boot: boolean
    start: string
    end: string
    sectors: string
    size: string
    id: string
    type: string
  }[] = []
  for (const partLine of partitionInfoStringArr) {
    const splitPartLine = partLine.split(/\s+/).filter((e) => e)

    const boot = splitPartLine[1] === '*'
    const offset = boot ? 1 : 0

    partitions.push({
      device: splitPartLine[0],
      boot,
      start: splitPartLine[offset + 1],
      end: splitPartLine[offset + 2],
      sectors: splitPartLine[offset + 3],
      size: splitPartLine[offset + 4],
      id: splitPartLine[offset + 5],
      type: splitPartLine.slice(offset + 6).join(' ')
    })
  }

  return partitions
}

type DarwinPartition = { typeName: string; name?: string; size: string; identifier: string }
const parseDarwinPartitionOutput = (output: string) => {
  const lines = output.split('\n').slice(3) // remove title, header, and disk partition
  const partitions: DarwinPartition[] = []

  for (const line of lines) {
    const splitLine = line.split(/\s+/)

    if (splitLine.length === 6 || splitLine.length === 7) {
      const [, , typeName, ...rest] = splitLine
      const [size, sizeUnit, identifier] = rest.slice(-3)

      if (identifier !== '-') {
        const partition: DarwinPartition = {
          typeName,
          size: `${size} ${sizeUnit}`,
          identifier
        }

        if (splitLine.length === 7) {
          partition.name = rest[0]
        }

        partitions.push(partition)
      }
    }
  }

  return partitions
}

export const automountDrive = (drive: Drive) => {
  switch (process.platform) {
    case 'darwin': {
      return automountDriveDarwin(drive)
    }
    case 'linux': {
      return automountDriveLinux(drive)
    }
    case 'win32': {
      return
    }
    default:
      throw new Error('invalid process')
  }
}

export const listPartitionsDarwin = async (drive: Drive) => {
  const { stdout } = await spawnAsync('diskutil', ['list', drive.device])
  return parseDarwinPartitionOutput(stdout)
}

export const listPartitionsLinux = async (drive: Drive) => {
  const { stdout } = await elevatedSpawn('fdisk', ['-l', drive.device])
  return parseUnixPartitionOutput(stdout)
}

export const listPartitions = async (drive: Drive) => {
  switch (process.platform) {
    case 'darwin': {
      return listPartitionsDarwin(drive)
    }
    case 'linux': {
      return listPartitionsLinux(drive)
    }
    case 'win32': {
      return
    }
    default:
      throw new Error('invalid process')
  }
}

export const automountDriveDarwin = async (drive: Drive) => {
  const partitions = await listPartitionsDarwin(drive)
  for (const partition of partitions) {
    try {
      await spawnAsync('diskutil', ['mount', `/dev/${partition.identifier}`])
    } catch (error) {
      console.error('failed to mount:', partition.identifier, error)
    }
  }
}

export const automountDriveLinux = async (drive: Drive) => {
  const partitions = await listPartitionsLinux(drive)
  await spawnAsync('udevadm', ['settle'])

  for (const partition of partitions) {
    try {
      await spawnAsync('udisksctl', ['mount', '-b', partition.device])
    } catch (error) {
      console.error('failed to mount:', partition.device, error)
    }
  }
}

export async function unmountDisk(drivePath: string) {
  // mountutils is (nan) built for the bundled Node's ABI, so the unmount script must
  // run under that same bundled Node — not the Electron binary. Requested from the
  // unpacked node_modules because real Node cannot read inside the packed asar.
  const mountutilsRequire = getNodeModulesResourcePath('mountutils', { unpacked: true })

  // The drive path and the module path are passed to the elevated script as argv,
  // never interpolated into its source, so they can't inject code.
  return elevatedNodeChildProcess(
    UNMOUNT_SCRIPT,
    [drivePath, mountutilsRequire],
    undefined,
    undefined,
    undefined,
    undefined,
    true
  )
}
