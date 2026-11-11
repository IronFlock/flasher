import type { CommandRunner } from '../main/utils/config-partition'
import { parsePlist, PlistValue } from './plist'

// The disks `flockflasher` may write, and the checks before it writes one:
// a whole disk, writable, not the disk of the running system, not held by
// LVM, RAID or dm-crypt, and (macOS) not an internal disk of the Mac. Linux
// reads lsblk, macOS diskutil. The parsers are pure, so they are unit-tested.

export type Disk = {
  // /dev/sdb, /dev/disk4
  device: string
  // what is written: /dev/sdb, /dev/rdisk4 (macOS's raw device, unbuffered)
  rawDevice: string
  size: number
  model: string
  transport: string
  removable: boolean
  // Linux: the mounted file systems of the disk, unmounted before writing
  mounted: { device: string; mountpoint: string }[]
  // why the disk is never written, if it is not
  refusal?: string
}

export type DiskDeps = { platform: NodeJS.Platform; run: CommandRunner }

export const SUPPORTED_PLATFORMS: NodeJS.Platform[] = ['linux', 'darwin']

export const assertSupportedPlatform = (platform: NodeJS.Platform): void => {
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(
      `flockflasher writes disks on Linux and macOS; on ${platform} use the FlockFlasher app`
    )
  }
}

// ------------------------------------------------------------------ linux --

// Mount points of the running system (installed or live): a disk with one of
// them is never written.
const SYSTEM_MOUNTS = new Set([
  '/',
  '/boot',
  '/usr',
  '/var',
  '/home',
  '/etc',
  '/opt',
  '/srv',
  '/data',
  '[SWAP]',
  '/cdrom',
  '/run/live/medium',
  '/run/initramfs/live',
  '/lib/live/mount/medium'
])
const isSystemMount = (mountpoint: string) =>
  SYSTEM_MOUNTS.has(mountpoint) || mountpoint.startsWith('/boot/')

export const LSBLK_ARGS = [
  '--json',
  '--bytes',
  '--paths',
  '--output',
  'NAME,PKNAME,TYPE,SIZE,RM,RO,TRAN,MODEL,MOUNTPOINT'
]

// lsblk prints booleans as true/false or "1"/"0", sizes as numbers or strings,
// depending on its version.
const flag = (value: unknown) => value === true || value === 1 || value === '1'
const number = (value: unknown) => (typeof value === 'number' ? value : Number(value) || 0)
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

type LsblkNode = {
  name?: unknown
  pkname?: unknown
  type?: unknown
  size?: unknown
  rm?: unknown
  ro?: unknown
  tran?: unknown
  model?: unknown
  mountpoint?: unknown
  children?: unknown
}

const children = (node: LsblkNode): LsblkNode[] =>
  Array.isArray(node.children) ? (node.children as LsblkNode[]) : []

const linuxDisk = (node: LsblkNode): Disk => {
  const device = text(node.name)
  const mounted: Disk['mounted'] = []
  let system: string | undefined
  let holder: string | undefined
  const visit = (current: LsblkNode, depth: number) => {
    const mountpoint = text(current.mountpoint)
    if (mountpoint !== '') {
      if (isSystemMount(mountpoint)) system ??= mountpoint
      else mounted.push({ device: text(current.name), mountpoint })
    }
    if (depth > 0 && text(current.type) !== 'part') {
      holder ??= `${text(current.type)} ${text(current.name)}`
    }
    for (const child of children(current)) visit(child, depth + 1)
  }
  visit(node, 0)

  let refusal: string | undefined
  if (system) refusal = `holds ${system} of the running system`
  else if (holder) refusal = `is in use by ${holder}: release it first`
  else if (flag(node.ro)) refusal = 'is read-only'
  else if (number(node.size) === 0) refusal = 'has no medium'

  return {
    device,
    rawDevice: device,
    size: number(node.size),
    model: text(node.model),
    transport: text(node.tran),
    removable: flag(node.rm),
    mounted,
    refusal
  }
}

const lsblkNodes = (stdout: string): LsblkNode[] => {
  const doc = JSON.parse(stdout)
  return Array.isArray(doc?.blockdevices) ? doc.blockdevices : []
}

// The disks of `lsblk` without a device: physical disks only (no loop
// devices, no zram, no optical drives).
export const parseLinuxDisks = (stdout: string): Disk[] =>
  lsblkNodes(stdout)
    .filter((node) => text(node.type) === 'disk' && !/^\/dev\/zram\d+$/.test(text(node.name)))
    .map(linuxDisk)

// The disk of `lsblk DEVICE`: a whole disk (or a loop device, named on purpose).
export const parseLinuxDisk = (stdout: string, device: string): Disk => {
  const [node] = lsblkNodes(stdout)
  if (!node) throw new Error(`${device} is not a block device`)
  const type = text(node.type)
  if (type === 'part') {
    const parent = text(node.pkname)
    throw new Error(`${device} is a partition: pass the whole disk${parent ? ` (${parent})` : ''}`)
  }
  if (type !== 'disk' && type !== 'loop') throw new Error(`${device} is a ${type}, not a disk`)
  return linuxDisk(node)
}

// ------------------------------------------------------------------ macOS --

type Dict = { [key: string]: PlistValue }
const asDict = (value: PlistValue): Dict =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}

// disk4, rdisk4, /dev/disk4 and /dev/rdisk4 all name disk4.
export const darwinDiskId = (device: string): string => {
  const id = device.replace(/^(\/dev\/)?r?(?=disk\d)/, '')
  if (!/^disk\d+(s\d+)*$/.test(id)) throw new Error(`${device} is not a macOS disk (/dev/diskN)`)
  return id
}

// A disk from its `diskutil info -plist`; systemDisks are the whole disks the
// running system lives on (the APFS container and its physical stores).
export const darwinDisk = (info: Dict, systemDisks: Set<string>): Disk => {
  const id = text(info.DeviceIdentifier)
  const parent = text(info.ParentWholeDisk)
  let refusal: string | undefined
  if (info.WholeDisk !== true) refusal = `is a partition: pass the whole disk (/dev/${parent})`
  else if (Array.isArray(info.APFSPhysicalStores)) refusal = 'is an APFS container, not a disk'
  else if (systemDisks.has(id)) refusal = 'holds the running system'
  // The built-in SD card reader is internal too, but its medium is removable
  // (so is an attached disk image's).
  else if (info.Internal === true && info.RemovableMedia !== true)
    refusal = 'is an internal disk of this Mac'
  else if (info.WritableMedia === false) refusal = 'is read-only'
  return {
    device: `/dev/${id}`,
    rawDevice: `/dev/r${id}`,
    size: number(info.Size ?? info.TotalSize),
    model: text(info.MediaName) || text(info.IORegistryEntryName),
    transport: text(info.BusProtocol),
    removable: info.RemovableMedia === true || info.Ejectable === true,
    mounted: [],
    refusal
  }
}

const darwinInfo = async (run: CommandRunner, target: string): Promise<Dict> =>
  asDict(parsePlist((await run('diskutil', ['info', '-plist', target])).stdout))

// The whole disks of the volume mounted at /: its APFS container and the
// container's physical stores.
const darwinSystemDisks = async (run: CommandRunner): Promise<Set<string>> => {
  const disks = new Set<string>()
  const root = await darwinInfo(run, '/')
  const container = text(root.ParentWholeDisk)
  if (container) disks.add(container)
  const stores = container ? (await darwinInfo(run, container)).APFSPhysicalStores : undefined
  for (const store of Array.isArray(stores) ? stores : []) {
    const id = text(asDict(store).APFSPhysicalStore)
    if (!id) continue
    const whole = text((await darwinInfo(run, id)).ParentWholeDisk)
    if (whole) disks.add(whole)
  }
  return disks
}

// ----------------------------------------------------------------- common --

export const inspectDisk = async (device: string, deps: DiskDeps): Promise<Disk> => {
  assertSupportedPlatform(deps.platform)
  if (deps.platform === 'linux') {
    if (!/^\/dev\/[A-Za-z0-9/._:-]+$/.test(device)) {
      throw new Error(`${device} is not a disk (/dev/...)`)
    }
    return parseLinuxDisk((await deps.run('lsblk', [...LSBLK_ARGS, device])).stdout, device)
  }
  const id = darwinDiskId(device)
  return darwinDisk(await darwinInfo(deps.run, id), await darwinSystemDisks(deps.run))
}

export const listDisks = async (deps: DiskDeps): Promise<Disk[]> => {
  assertSupportedPlatform(deps.platform)
  if (deps.platform === 'linux') {
    return parseLinuxDisks((await deps.run('lsblk', LSBLK_ARGS)).stdout)
  }
  const list = asDict(parsePlist((await deps.run('diskutil', ['list', '-plist'])).stdout))
  const ids = Array.isArray(list.WholeDisks) ? list.WholeDisks.map(text).filter(Boolean) : []
  const systemDisks = await darwinSystemDisks(deps.run)
  const disks: Disk[] = []
  for (const id of ids) disks.push(darwinDisk(await darwinInfo(deps.run, id), systemDisks))
  return disks
}

// Unmounts what the disk has mounted; a file system that will not unmount
// stops the flash before anything is written.
export const unmountDisk = async (disk: Disk, deps: DiskDeps): Promise<void> => {
  if (deps.platform === 'darwin') {
    await deps.run('diskutil', ['unmountDisk', disk.device])
    return
  }
  for (const { device, mountpoint } of disk.mounted) {
    try {
      await deps.run('umount', [device])
    } catch (error) {
      throw new Error(`Cannot unmount ${mountpoint} (${device}): ${(error as Error).message}`)
    }
  }
}

// Drops the kernel's cached blocks of the disk (Linux), so that reading it
// back reads the disk. macOS reads the raw device, which has no cache.
export const flushDiskCache = async (disk: Disk, deps: DiskDeps): Promise<boolean> => {
  if (deps.platform !== 'linux') return true
  try {
    await deps.run('blockdev', ['--flushbufs', disk.device])
    return true
  } catch {
    return false
  }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

// Decimal units, as disks are sold.
export const humanSize = (bytes: number): string => {
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`
}

export const describeDisk = (disk: Disk): string =>
  [disk.device, humanSize(disk.size), disk.transport, disk.model].filter(Boolean).join('  ')
