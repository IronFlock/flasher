import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MountDeps,
  PartitionInfo,
  chooseConfigPartition,
  configFileName,
  installerConf,
  darwinPartition,
  isFatFilesystem,
  mountConfigPartition,
  parseDiskutilInfo,
  parseDiskutilList,
  parseLsblk,
  parseWindowsPartitions,
  windowsDiskNumber
} from '../src/main/utils/config-partition'

const BASIC_DATA = 'ebd0a0a2-b9e5-4433-87c0-68b6b72699c7'
const ESP = 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b'
const LINUX_FS = '0fc63daf-8483-4772-8e79-3d69d8477de4'

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('chooseConfigPartition', () => {
  const part = (index: number, extra: Partial<PartitionInfo>): PartitionInfo => ({
    id: `p${index}`,
    index,
    ...extra
  })

  it('takes the FAT partition labelled FLOCKOS, wherever it is', () => {
    const choice = chooseConfigPartition([
      part(3, { fsType: 'ext4', label: 'rootfs-a' }),
      part(1, { fsType: 'vfat', label: 'boot-a' }),
      part(2, { fsType: 'vfat', label: 'FLOCKOS' })
    ])
    expect(choice).toEqual({ partition: expect.objectContaining({ index: 2 }), reason: 'label' })
  })

  it('matches the label without regard to case or padding, but only on FAT', () => {
    expect(chooseConfigPartition([part(1, { fsType: 'FAT32', label: ' flockos ' })])?.reason).toBe(
      'label'
    )
    const choice = chooseConfigPartition([
      part(1, { fsType: 'ext4', label: 'FLOCKOS' }),
      part(2, { fsType: 'vfat', label: 'BOOT' })
    ])
    expect(choice).toEqual({
      partition: expect.objectContaining({ index: 2 }),
      reason: 'first-fat'
    })
  })

  it('falls back to the first FAT partition (an image without the label)', () => {
    const choice = chooseConfigPartition([
      part(2, { fsType: 'ext4' }),
      part(3, { fsType: 'msdos', label: 'DATA' }),
      part(1, { fsType: 'vfat', label: 'BOOT' })
    ])
    expect(choice?.partition.index).toBe(1)
    expect(choice?.reason).toBe('first-fat')
  })

  it('falls back to a FAT partition type when the file system is unknown (Windows ESP)', () => {
    const choice = chooseConfigPartition([
      part(2, { partType: LINUX_FS }),
      part(1, { partType: ESP }),
      part(3, { partType: BASIC_DATA })
    ])
    expect(choice).toEqual({
      partition: expect.objectContaining({ index: 1 }),
      reason: 'fat-partition-type'
    })
    expect(chooseConfigPartition([part(1, { partType: '0x0c' })])?.reason).toBe(
      'fat-partition-type'
    )
  })

  it('finds nothing on a disk without FAT', () => {
    expect(chooseConfigPartition([part(1, { fsType: 'ext4' }), part(2, { fsType: 'exfat' })])).toBe(
      undefined
    )
    expect(chooseConfigPartition([])).toBeUndefined()
  })

  it('knows the FAT file system names of the three platforms', () => {
    for (const name of ['vfat', 'FAT32', 'fat16', 'msdos', 'MS-DOS FAT32']) {
      expect(isFatFilesystem(name)).toBe(true)
    }
    for (const name of ['exFAT', 'ntfs', 'ext4', '', undefined]) {
      expect(isFatFilesystem(name)).toBe(false)
    }
  })
})

describe('configFileName', () => {
  it('writes <name>.flock', () => {
    expect(configFileName('/home/u/kitchen-pi.flock')).toBe('kitchen-pi.flock')
    expect(configFileName('C:\\Users\\u\\Kitchen-Pi.FLOCK')).toBe('Kitchen-Pi.flock')
  })

  it('makes the name valid on FAT', () => {
    expect(configFileName('/x/a:b?c.flock')).toBe('a_b_c.flock')
    expect(configFileName('/x/.flock')).toBe('device.flock')
  })
})

describe('installerConf', () => {
  it('names the image the installer stick installs, nothing else', () => {
    expect(installerConf('flockos-amd64-efi-nvidia')).toBe('payload=flockos-amd64-efi-nvidia\n')
  })

  it('refuses anything but an image id', () => {
    for (const bad of ['', 'nvidia\nconfirm=no', 'flockos-amd64-efi-base@0.10.0', '../x']) {
      expect(() => installerConf(bad)).toThrow(/Not an IronFlockOS image id/)
    }
  })
})

// ---------------------------------------------------------------- linux --

const lsblk = (parts: object[]) =>
  JSON.stringify({
    blockdevices: [
      {
        name: '/dev/sdb',
        type: 'disk',
        fstype: null,
        label: null,
        mountpoint: null,
        children: parts
      }
    ]
  })

const RPI_PARTS = [
  {
    name: '/dev/sdb1',
    type: 'part',
    fstype: 'vfat',
    label: 'FLOCKOS',
    parttype: BASIC_DATA,
    mountpoint: null
  },
  {
    name: '/dev/sdb2',
    type: 'part',
    fstype: 'vfat',
    label: 'boot-a',
    parttype: BASIC_DATA,
    mountpoint: '/media/u/boot-a'
  },
  {
    name: '/dev/sdb3',
    type: 'part',
    fstype: null,
    label: null,
    parttype: BASIC_DATA,
    mountpoint: null
  },
  {
    name: '/dev/sdb4',
    type: 'part',
    fstype: 'ext4',
    label: 'rootfs-a',
    parttype: LINUX_FS,
    mountpoint: null
  }
]

type Call = { command: string; args: string[]; elevated: boolean }

const fake = (handler: (call: Call) => string | Error, extra: Partial<MountDeps> = {}) => {
  const calls: Call[] = []
  const runner = (elevated: boolean) => async (command: string, args: string[]) => {
    const call = { command, args, elevated }
    calls.push(call)
    const out = handler(call)
    if (out instanceof Error) throw out
    return { stdout: out }
  }
  const deps: MountDeps = {
    run: runner(false),
    runElevated: runner(true),
    sleep: async () => undefined,
    attempts: 3,
    intervalMs: 0,
    ...extra
  }
  return { calls, deps }
}

const commands = (calls: Call[]) =>
  calls.map((c) => `${c.elevated ? 'sudo ' : ''}${c.command} ${c.args.join(' ')}`)

describe('parseLsblk', () => {
  it('reads the partitions of a disk with labels, types and mount points', () => {
    const parts = parseLsblk(lsblk(RPI_PARTS))
    expect(parts.map((p) => p.index)).toEqual([1, 2, 3, 4])
    expect(parts[0]).toEqual({
      id: '/dev/sdb1',
      index: 1,
      label: 'FLOCKOS',
      fsType: 'vfat',
      partType: BASIC_DATA,
      mountpoint: undefined
    })
    expect(parts[1].mountpoint).toBe('/media/u/boot-a')
  })

  it('reads a single partition and mmc/nvme names', () => {
    const parts = parseLsblk(
      JSON.stringify({
        blockdevices: [{ name: '/dev/mmcblk0p12', type: 'part', fstype: 'vfat', parttype: '0xc' }]
      })
    )
    expect(parts).toEqual([
      expect.objectContaining({ id: '/dev/mmcblk0p12', index: 12, partType: '0x0c' })
    ])
  })
})

describe('mountConfigPartition on linux', () => {
  it('mounts FLOCKOS with udisksctl and unmounts it again', async () => {
    let mounted = false
    const { calls, deps } = fake(({ command, args }) => {
      if (command === 'lsblk' && args.at(-1) === '/dev/sdb1') {
        return lsblk([{ ...RPI_PARTS[0], mountpoint: mounted ? '/media/u/FLOCKOS' : null }])
      }
      if (command === 'lsblk') return lsblk(RPI_PARTS)
      if (command === 'udisksctl' && args[0] === 'mount') mounted = true
      return ''
    })
    const result = await mountConfigPartition('linux', '/dev/sdb', deps)
    expect(result.mountpoint).toBe('/media/u/FLOCKOS')
    expect(result.reason).toBe('label')
    expect(commands(calls)).toContain(
      'udisksctl mount --block-device /dev/sdb1 --no-user-interaction'
    )
    await result.release()
    expect(commands(calls).at(-1)).toBe(
      'udisksctl unmount --block-device /dev/sdb1 --no-user-interaction'
    )
  })

  it('uses a partition the desktop already mounted, and leaves it mounted', async () => {
    const parts = [{ ...RPI_PARTS[0], mountpoint: '/run/media/u/FLOCKOS' }, ...RPI_PARTS.slice(1)]
    const { calls, deps } = fake(({ command }) => (command === 'lsblk' ? lsblk(parts) : ''))
    const result = await mountConfigPartition('linux', '/dev/sdb', deps)
    expect(result.mountpoint).toBe('/run/media/u/FLOCKOS')
    await result.release()
    expect(commands(calls).some((c) => c.startsWith('udisksctl'))).toBe(false)
  })

  it('asks root to probe when the udev database has no file systems yet', async () => {
    const bare = RPI_PARTS.map((p) => ({ ...p, fstype: null, label: null }))
    const { calls, deps } = fake(
      ({ command, elevated }) => {
        if (command === 'lsblk') return lsblk(elevated ? RPI_PARTS : bare)
        if (command === 'udisksctl') return new Error('no udisks')
        return ''
      },
      {
        makeTempDir: async () => '/tmp/ff-x',
        removeDir: async () => undefined,
        uid: 1000,
        gid: 1000
      }
    )
    const result = await mountConfigPartition('linux', '/dev/sdb', deps)
    expect(commands(calls)).toContain(
      'sudo lsblk --json --paths --output NAME,TYPE,FSTYPE,LABEL,PARTTYPE,MOUNTPOINT /dev/sdb'
    )
    // and, without udisks, mounts it itself, owned by the user
    expect(commands(calls)).toContain(
      'sudo mount -t vfat -o uid=1000,gid=1000,umask=022 /dev/sdb1 /tmp/ff-x'
    )
    expect(result.mountpoint).toBe('/tmp/ff-x')
    await result.release()
    expect(commands(calls).at(-1)).toBe('sudo umount /tmp/ff-x')
  })

  it('gives up with the partitions it saw when there is no FAT partition', async () => {
    const { deps } = fake(({ command }) => (command === 'lsblk' ? lsblk([RPI_PARTS[3]]) : ''))
    await expect(mountConfigPartition('linux', '/dev/sdb', deps)).rejects.toThrow(
      /No FLOCKOS or FAT partition found on \/dev\/sdb \(partitions: \/dev\/sdb4 ext4 rootfs-a\)/
    )
  })
})

// ---------------------------------------------------------------- macOS --

const DISKUTIL_LIST = `/dev/disk4 (external, physical):
   #:                       TYPE NAME                    SIZE       IDENTIFIER
   0:      GUID_partition_scheme                        *31.9 GB    disk4
   1:                        EFI FLOCKOS                 268.4 MB   disk4s1
   2:           Linux Filesystem                         4.3 GB     disk4s2
`

const diskutilInfo = (id: string, mounted: boolean) =>
  id === 'disk4s1'
    ? `   Device Identifier:         disk4s1
   Device Node:               /dev/disk4s1
   Whole:                     No
   Part of Whole:             disk4

   Volume Name:               FLOCKOS
   Mounted:                   ${mounted ? 'Yes' : 'No'}
${mounted ? '   Mount Point:               /Volumes/FLOCKOS\n' : ''}
   Partition Type:            EFI
   File System Personality:   MS-DOS FAT32
   Type (Bundle):             msdos
   Name (User Visible):       MS-DOS (FAT32)
`
    : `   Device Identifier:         disk4s2
   Volume Name:               Not applicable (no file system)
   Mounted:                   Not applicable (no file system)
   Partition Type:            Linux Filesystem
`

describe('diskutil parsing', () => {
  it('lists the partition identifiers of the disk', () => {
    expect(parseDiskutilList(DISKUTIL_LIST, 'disk4')).toEqual(['disk4s1', 'disk4s2'])
  })

  it('reads an unmounted EFI system partition labelled FLOCKOS', () => {
    const p = darwinPartition('disk4s1', parseDiskutilInfo(diskutilInfo('disk4s1', false)))
    expect(p).toEqual({
      id: 'disk4s1',
      index: 1,
      label: 'FLOCKOS',
      fsType: 'msdos',
      partType: ESP,
      mountpoint: undefined
    })
    const none = darwinPartition('disk4s2', parseDiskutilInfo(diskutilInfo('disk4s2', false)))
    expect(none.fsType).toBeUndefined()
  })
})

describe('mountConfigPartition on macOS', () => {
  it('mounts the EFI system partition macOS leaves unmounted, and unmounts it after', async () => {
    let mounted = false
    const { calls, deps } = fake(({ command, args }) => {
      if (command !== 'diskutil') return ''
      if (args[0] === 'list') return DISKUTIL_LIST
      if (args[0] === 'info') return diskutilInfo(args[1].replace('/dev/', ''), mounted)
      if (args[0] === 'mount') mounted = true
      return ''
    })
    const result = await mountConfigPartition('darwin', '/dev/disk4', deps)
    expect(result.mountpoint).toBe('/Volumes/FLOCKOS')
    expect(commands(calls)).toContain('diskutil mount /dev/disk4s1')
    await result.release()
    expect(commands(calls).at(-1)).toBe('diskutil unmount /dev/disk4s1')
  })

  it('mounts through sudo when the user may not', async () => {
    let mounted = false
    const { calls, deps } = fake(({ command, args, elevated }) => {
      if (args[0] === 'list') return DISKUTIL_LIST
      if (args[0] === 'info') return diskutilInfo(args[1].replace('/dev/', ''), mounted)
      if (command === 'diskutil' && args[0] === 'mount') {
        if (!elevated) return new Error('not privileged')
        mounted = true
      }
      return ''
    })
    await mountConfigPartition('darwin', '/dev/disk4', deps)
    expect(commands(calls)).toContain('sudo diskutil mount /dev/disk4s1')
  })

  it('refuses a device that is not a disk', async () => {
    const { deps } = fake(() => '')
    await expect(mountConfigPartition('darwin', '/dev/disk4s1', deps)).rejects.toThrow(/Unexpected/)
  })
})

// -------------------------------------------------------------- Windows --

const psScript = (args: string[]) =>
  Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')

describe('Windows parsing', () => {
  it('reads the disk number of a physical drive', () => {
    expect(windowsDiskNumber('\\\\.\\PhysicalDrive3')).toBe(3)
    expect(windowsDiskNumber('\\\\.\\PHYSICALDRIVE12')).toBe(12)
    expect(windowsDiskNumber('E:\\')).toBeUndefined()
  })

  it('reads one partition or many, with drive letters', () => {
    const one = parseWindowsPartitions(
      '{"number":1,"letter":"E","fs":"FAT32","label":"FLOCKOS","gptType":"","mbrType":12}'
    )
    expect(one).toEqual([
      {
        id: '1',
        index: 1,
        label: 'FLOCKOS',
        fsType: 'FAT32',
        partType: '0x0c',
        mountpoint: 'E:\\'
      }
    ])
    const many = parseWindowsPartitions(
      `[{"number":1,"letter":"","fs":"","label":"","gptType":"{${ESP.toUpperCase()}}","mbrType":0},` +
        `{"number":2,"letter":"","fs":"","label":"","gptType":"{${LINUX_FS}}","mbrType":0}]`
    )
    expect(many.map((p) => [p.index, p.partType, p.mountpoint])).toEqual([
      [1, ESP, undefined],
      [2, LINUX_FS, undefined]
    ])
    expect(parseWindowsPartitions('')).toEqual([])
  })
})

describe('mountConfigPartition on Windows', () => {
  const amd64 = (letter: string) =>
    JSON.stringify([
      {
        number: 1,
        letter,
        fs: letter ? 'FAT32' : '',
        label: letter ? 'FLOCKOS' : '',
        gptType: `{${ESP}}`,
        mbrType: 0
      },
      { number: 2, letter: '', fs: '', label: '', gptType: `{${LINUX_FS}}`, mbrType: 0 }
    ])

  it('gives the EFI system partition a drive letter (diskpart when the cmdlet refuses) and removes it after', async () => {
    let letter = ''
    let diskpartScript = ''
    const { calls, deps } = fake(
      ({ command, args }) => {
        if (command === 'diskpart') {
          letter = 'F'
          return ''
        }
        const script = psScript(args)
        if (script.includes('Get-Partition -DiskNumber 2')) return amd64(letter)
        if (script.includes('Add-PartitionAccessPath')) return new Error('not supported')
        return ''
      },
      {
        writeTempFile: async (content) => {
          diskpartScript = content
          return 'C:\\Temp\\ff\\assign.txt'
        },
        removeFile: async () => undefined
      }
    )
    const result = await mountConfigPartition('win32', '\\\\.\\PhysicalDrive2', deps)
    expect(result.reason).toBe('fat-partition-type')
    expect(result.mountpoint).toBe('F:\\')
    expect(diskpartScript).toBe('select disk 2\r\nselect partition 1\r\nassign\r\n')
    expect(commands(calls)).toContain('diskpart /s C:\\Temp\\ff\\assign.txt')
    expect(calls.every((c) => !c.elevated)).toBe(true)
    await result.release()
    expect(psScript(calls.at(-1)!.args)).toContain(
      "Remove-PartitionAccessPath -DiskNumber 2 -PartitionNumber 1 -AccessPath 'F:\\'"
    )
  })

  it('uses a drive letter Windows assigned, and keeps it', async () => {
    const { calls, deps } = fake(() => amd64('E'))
    const result = await mountConfigPartition('win32', '\\\\.\\PhysicalDrive2', deps)
    expect(result.mountpoint).toBe('E:\\')
    expect(result.reason).toBe('label')
    await result.release()
    expect(calls).toHaveLength(1)
  })

  it('refuses a device that is not a physical drive', async () => {
    const { deps } = fake(() => '')
    await expect(mountConfigPartition('win32', 'E:\\', deps)).rejects.toThrow(/Unexpected/)
  })
})
