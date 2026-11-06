// Finds and mounts the partition a device file goes to after flashing: the FAT
// partition labelled FLOCKOS (every FlockOS image has one, the installer stick
// included), else, as a fallback, the first FAT partition. The partition order
// is never relied on. Commands run through injected runners (argv, no shell),
// so the logic is unit-tested without disks or Electron.

export const FLOCKOS_LABEL = 'FLOCKOS'

export type PartitionInfo = {
  // linux: /dev/sdb1; darwin: disk4s1; win32: the partition number
  id: string
  // the partition number (1-based)
  index: number
  label?: string
  fsType?: string
  // GPT type GUID (lowercase, no braces) or MBR type ('0x0c')
  partType?: string
  // linux and darwin: the mount path; win32: 'E:\'
  mountpoint?: string
}

export type ChoiceReason = 'label' | 'first-fat' | 'fat-partition-type'
export type PartitionChoice = { partition: PartitionInfo; reason: ChoiceReason }

const ESP_TYPE = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b'
const FAT_MBR_TYPES = new Set([0x01, 0x04, 0x06, 0x0b, 0x0c, 0x0e, 0xef])

export const isFatFilesystem = (fsType: string | undefined): boolean => {
  if (!fsType) return false
  const value = fsType.trim().toLowerCase()
  return (
    ['vfat', 'fat', 'fat12', 'fat16', 'fat32', 'msdos'].includes(value) ||
    value.startsWith('ms-dos fat')
  )
}

export const normalizePartType = (value: unknown): string | undefined => {
  if (typeof value === 'number') {
    return value > 0 ? `0x${value.toString(16).padStart(2, '0')}` : undefined
  }
  if (typeof value !== 'string') return undefined
  const text = value
    .trim()
    .replace(/^\{|\}$/g, '')
    .toLowerCase()
  if (text === '') return undefined
  if (/^0x[0-9a-f]+$/.test(text)) return normalizePartType(parseInt(text, 16))
  return text
}

// A partition type that holds FAT (the EFI system partition, the MBR FAT types).
export const isFatPartitionType = (partType: string | undefined): boolean => {
  if (!partType) return false
  if (partType === ESP_TYPE) return true
  return partType.startsWith('0x') && FAT_MBR_TYPES.has(parseInt(partType, 16))
}

const hasFat = (p: PartitionInfo) =>
  isFatFilesystem(p.fsType) || (!p.fsType && isFatPartitionType(p.partType))

// FLOCKOS by FAT label first, then the first FAT file system, then (when the
// OS could not tell the file system, as Windows for an EFI system partition
// without a drive letter) the first partition of a FAT partition type.
export const chooseConfigPartition = (partitions: PartitionInfo[]): PartitionChoice | undefined => {
  const ordered = partitions.slice().sort((a, b) => a.index - b.index)
  const labelled = ordered.find(
    (p) => (p.label ?? '').trim().toUpperCase() === FLOCKOS_LABEL && hasFat(p)
  )
  if (labelled) return { partition: labelled, reason: 'label' }
  const fat = ordered.find((p) => isFatFilesystem(p.fsType))
  if (fat) return { partition: fat, reason: 'first-fat' }
  const typed = ordered.find((p) => !p.fsType && isFatPartitionType(p.partType))
  if (typed) return { partition: typed, reason: 'fat-partition-type' }
  return undefined
}

// The name the device file gets on the partition: <name>.flock, also for a
// .reswarm file (FlockOS reads *.flock only). Nothing else is written; enroll
// removes the .flock after use, so no copy with the device's credentials stays.
export const configFileName = (sourcePath: string): string => {
  const base = sourcePath.split(/[\\/]/).pop() ?? ''
  const stem =
    base
      .replace(/\.(flock|reswarm)$/i, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
      .replace(/[. ]+$/, '') || 'device'
  return `${stem}.flock`
}

// installer.conf on an installer stick's FLOCKOS partition (KEY=value, read by
// the FlockOS installer): only `payload`, the id of the image to install; every
// other key keeps its default (confirm=yes: the installer asks on the console
// before it writes).
export const INSTALLER_CONF_FILE = 'installer.conf'

export const installerConf = (payload: string): string => {
  if (!/^flockos-[a-z0-9]+(-[a-z0-9]+)*$/.test(payload)) {
    throw new Error(`Not a FlockOS image id: ${payload}`)
  }
  return `payload=${payload}\n`
}

// ----------------------------------------------------------------- parsers --

const trailingNumber = (text: string): number | undefined => {
  const match = /(\d+)$/.exec(text)
  return match ? Number(match[1]) : undefined
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

// lsblk --json --paths --output NAME,TYPE,FSTYPE,LABEL,PARTTYPE,MOUNTPOINT
export const parseLsblk = (stdout: string): PartitionInfo[] => {
  const doc = JSON.parse(stdout)
  const partitions: PartitionInfo[] = []
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'part' && typeof node.name === 'string') {
      partitions.push({
        id: node.name,
        index: trailingNumber(node.name) ?? partitions.length + 1,
        label: nonEmpty(node.label),
        fsType: nonEmpty(node.fstype),
        partType: normalizePartType(node.parttype),
        mountpoint: nonEmpty(node.mountpoint)
      })
    }
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child)
  }
  for (const device of Array.isArray(doc?.blockdevices) ? doc.blockdevices : []) visit(device)
  return partitions
}

// The partition identifiers (disk4s1, ...) of `diskutil list /dev/disk4`.
export const parseDiskutilList = (stdout: string, disk: string): string[] => {
  const pattern = new RegExp(`^${disk}s\\d+$`)
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/).pop() ?? '')
    .filter((id) => pattern.test(id))
}

// `diskutil info` prints "   Key:   value" lines.
export const parseDiskutilInfo = (stdout: string): Record<string, string> => {
  const info: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const match = /^\s*([^:]+?):\s*(.*?)\s*$/.exec(line)
    if (match && !(match[1] in info)) info[match[1]] = match[2]
  }
  return info
}

export const darwinPartition = (id: string, info: Record<string, string>): PartitionInfo => {
  const mountpoint = info['Mount Point']
  const partType = info['Partition Type']
  return {
    id,
    index: trailingNumber(id) ?? 0,
    label: nonEmpty(info['Volume Name']),
    fsType: nonEmpty(info['Type (Bundle)']) ?? nonEmpty(info['File System Personality']),
    partType: partType === 'EFI' ? ESP_TYPE : normalizePartType(partType),
    mountpoint: mountpoint?.startsWith('/') ? mountpoint : undefined
  }
}

export const windowsDiskNumber = (device: string): number | undefined => {
  const match = /^\\\\\.\\PHYSICALDRIVE(\d+)$/i.exec(device)
  return match ? Number(match[1]) : undefined
}

// The JSON WINDOWS_LIST_SCRIPT prints.
export const parseWindowsPartitions = (stdout: string): PartitionInfo[] => {
  const start = stdout.search(/[[{]/)
  if (start < 0) return []
  const doc = JSON.parse(stdout.slice(start))
  return (Array.isArray(doc) ? doc : [doc])
    .filter((p) => Number.isSafeInteger(p?.number) && p.number > 0)
    .map((p) => {
      const letter = typeof p.letter === 'string' && /^[A-Za-z]$/.test(p.letter) ? p.letter : ''
      return {
        id: String(p.number),
        index: p.number,
        label: nonEmpty(p.label),
        fsType: nonEmpty(p.fs),
        partType: normalizePartType(p.gptType) ?? normalizePartType(p.mbrType),
        mountpoint: letter ? `${letter.toUpperCase()}:\\` : undefined
      }
    })
}

// Only integers (and a drive letter checked by parseWindowsPartitions) go into
// these scripts.
const windowsListScript = (disk: number) => `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { Update-HostStorageCache } catch {}
$out = @(Get-Partition -DiskNumber ${disk} -ErrorAction SilentlyContinue | ForEach-Object {
  $p = $_
  $v = $null
  try { $v = $p | Get-Volume -ErrorAction Stop } catch {}
  [pscustomobject]@{
    number = [int]$p.PartitionNumber
    letter = if ([int][char]$p.DriveLetter -ne 0) { [string]$p.DriveLetter } else { '' }
    fs = if ($v) { [string]$v.FileSystem } else { '' }
    label = if ($v) { [string]$v.FileSystemLabel } else { '' }
    gptType = [string]$p.GptType
    mbrType = if ($p.MbrType) { [int]$p.MbrType } else { 0 }
  }
})
ConvertTo-Json -InputObject $out -Compress`

// -EncodedCommand (UTF-16LE base64) keeps Windows command-line quoting out of it.
export const powershell = (script: string) => [
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64')
]

// ----------------------------------------------------------- orchestration --

export type CommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>

export type MountDeps = {
  run: CommandRunner
  // macOS and Linux: through sudo; on Windows the app is elevated already.
  runElevated: CommandRunner
  sleep?: (ms: number) => Promise<void>
  makeTempDir?: () => Promise<string>
  removeDir?: (dir: string) => Promise<void>
  writeTempFile?: (content: string) => Promise<string>
  removeFile?: (file: string) => Promise<void>
  uid?: number
  gid?: number
  // how long to wait for the partition table to show up after the write
  attempts?: number
  intervalMs?: number
}

export type MountedConfigPartition = PartitionChoice & {
  mountpoint: string
  // Unmounts what this module mounted (or removes the drive letter it
  // assigned); a partition that was mounted already stays mounted.
  release: () => Promise<void>
}

const noop = async () => undefined

const waitForChoice = async (
  device: string,
  list: () => Promise<PartitionInfo[]>,
  deps: MountDeps
): Promise<PartitionChoice> => {
  const attempts = deps.attempts ?? 60
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  let seen: PartitionInfo[] = []
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      seen = await list()
      const choice = chooseConfigPartition(seen)
      if (choice) return choice
    } catch (error) {
      lastError = error
    }
    if (attempt < attempts) await sleep(deps.intervalMs ?? 1000)
  }
  const found = seen.map((p) => `${p.id} ${p.fsType ?? '?'} ${p.label ?? ''}`.trim()).join(', ')
  throw new Error(
    `No ${FLOCKOS_LABEL} or FAT partition found on ${device}` +
      (found ? ` (partitions: ${found})` : '') +
      (lastError ? `: ${(lastError as Error)?.message ?? lastError}` : '')
  )
}

const LSBLK_OUTPUT = ['--json', '--paths', '--output', 'NAME,TYPE,FSTYPE,LABEL,PARTTYPE,MOUNTPOINT']

const mountLinux = async (device: string, deps: MountDeps): Promise<MountedConfigPartition> => {
  // Have the kernel read the new partition table; fails harmlessly (EBUSY)
  // when the desktop already mounted a partition of it.
  await deps.runElevated('blockdev', ['--rereadpt', device]).catch(() => undefined)

  const list = async () => {
    await deps.run('udevadm', ['settle']).catch(() => undefined)
    const parts = parseLsblk((await deps.run('lsblk', [...LSBLK_OUTPUT, device])).stdout)
    if (chooseConfigPartition(parts)) return parts
    // A user's lsblk reads the udev database only; root's probes the disk.
    return parseLsblk((await deps.runElevated('lsblk', [...LSBLK_OUTPUT, device])).stdout)
  }
  const choice = await waitForChoice(device, list, deps)
  const { partition } = choice
  if (partition.mountpoint) return { ...choice, mountpoint: partition.mountpoint, release: noop }

  const block = partition.id
  try {
    await deps.run('udisksctl', ['mount', '--block-device', block, '--no-user-interaction'])
    const [mounted] = parseLsblk((await deps.run('lsblk', [...LSBLK_OUTPUT, block])).stdout)
    if (mounted?.mountpoint) {
      return {
        ...choice,
        mountpoint: mounted.mountpoint,
        release: async () => {
          await deps.run('udisksctl', ['unmount', '--block-device', block, '--no-user-interaction'])
        }
      }
    }
  } catch (error) {
    console.warn(`udisksctl could not mount ${block}; mounting it directly:`, error)
  }

  if (!deps.makeTempDir) throw new Error(`Cannot mount ${block}`)
  const dir = await deps.makeTempDir()
  const owner = deps.uid !== undefined ? `uid=${deps.uid},gid=${deps.gid ?? deps.uid},` : ''
  try {
    await deps.runElevated('mount', ['-t', 'vfat', '-o', `${owner}umask=022`, block, dir])
  } catch (error) {
    await deps.removeDir?.(dir).catch(() => undefined)
    throw error
  }
  return {
    ...choice,
    mountpoint: dir,
    release: async () => {
      await deps.runElevated('umount', [dir])
      await deps.removeDir?.(dir)
    }
  }
}

const mountDarwin = async (device: string, deps: MountDeps): Promise<MountedConfigPartition> => {
  const disk = device.replace(/^\/dev\/r?/, '')
  if (!/^disk\d+$/.test(disk)) throw new Error(`Unexpected macOS disk ${device}`)

  const info = async (id: string) =>
    darwinPartition(
      id,
      parseDiskutilInfo((await deps.run('diskutil', ['info', `/dev/${id}`])).stdout)
    )
  const list = async () => {
    const ids = parseDiskutilList(
      (await deps.run('diskutil', ['list', `/dev/${disk}`])).stdout,
      disk
    )
    const parts: PartitionInfo[] = []
    for (const id of ids) parts.push(await info(id))
    return parts
  }
  const choice = await waitForChoice(device, list, deps)
  const { partition } = choice
  if (partition.mountpoint) return { ...choice, mountpoint: partition.mountpoint, release: noop }

  // macOS mounts no EFI system partition by itself (FLOCKOS on amd64-efi).
  const node = `/dev/${partition.id}`
  try {
    await deps.run('diskutil', ['mount', node])
  } catch {
    await deps.runElevated('diskutil', ['mount', node])
  }
  const { mountpoint } = await info(partition.id)
  if (!mountpoint) throw new Error(`${node} did not mount`)
  return {
    ...choice,
    mountpoint,
    release: async () => {
      await deps.run('diskutil', ['unmount', node])
    }
  }
}

const mountWindows = async (device: string, deps: MountDeps): Promise<MountedConfigPartition> => {
  const disk = windowsDiskNumber(device)
  if (disk === undefined) throw new Error(`Unexpected Windows disk ${device}`)

  const list = async () =>
    parseWindowsPartitions(
      (await deps.run('powershell.exe', powershell(windowsListScript(disk)))).stdout
    )
  const choice = await waitForChoice(device, list, deps)
  const { partition } = choice
  if (partition.mountpoint) return { ...choice, mountpoint: partition.mountpoint, release: noop }

  const number = partition.index
  try {
    await deps.run(
      'powershell.exe',
      powershell(
        `$ErrorActionPreference = 'Stop'; Add-PartitionAccessPath -DiskNumber ${disk} -PartitionNumber ${number} -AssignDriveLetter`
      )
    )
  } catch (error) {
    // The Storage cmdlets refuse a drive letter for some partition types (an
    // EFI system partition); diskpart assigns one.
    console.warn('Add-PartitionAccessPath failed, trying diskpart:', error)
    if (!deps.writeTempFile) throw error
    const script = await deps.writeTempFile(
      `select disk ${disk}\r\nselect partition ${number}\r\nassign\r\n`
    )
    try {
      await deps.run('diskpart', ['/s', script])
    } finally {
      await deps.removeFile?.(script).catch(() => undefined)
    }
  }

  // The volume shows up under its new letter after a moment.
  const assigned = await waitForChoice(
    device,
    async () => (await list()).filter((p) => p.index === number && p.mountpoint),
    { ...deps, attempts: Math.min(deps.attempts ?? 15, 15) }
  ).catch(() => undefined)
  const mountpoint = assigned?.partition.mountpoint
  if (!mountpoint) throw new Error(`Partition ${number} of disk ${disk} got no drive letter`)
  const letter = mountpoint[0]
  return {
    ...choice,
    mountpoint,
    release: async () => {
      await deps.run(
        'powershell.exe',
        powershell(
          `$ErrorActionPreference = 'Stop'; Remove-PartitionAccessPath -DiskNumber ${disk} -PartitionNumber ${number} -AccessPath '${letter}:\\'`
        )
      )
    }
  }
}

export const mountConfigPartition = (
  platform: NodeJS.Platform,
  device: string,
  deps: MountDeps
): Promise<MountedConfigPartition> => {
  switch (platform) {
    case 'linux':
      return mountLinux(device, deps)
    case 'darwin':
      return mountDarwin(device, deps)
    case 'win32':
      return mountWindows(device, deps)
    default:
      throw new Error(`Unsupported platform ${platform}`)
  }
}
