import { describe, it, expect, vi } from 'vitest'
import {
  DiskDeps,
  darwinDisk,
  darwinDiskId,
  humanSize,
  inspectDisk,
  listDisks,
  parseLinuxDisk,
  parseLinuxDisks,
  unmountDisk
} from '../src/cli/disks'
import { parsePlist } from '../src/cli/plist'

// ------------------------------------------------------------------ linux --

const LSBLK = JSON.stringify({
  blockdevices: [
    {
      name: '/dev/nvme0n1',
      pkname: null,
      type: 'disk',
      size: 512110190592,
      rm: false,
      ro: false,
      tran: 'nvme',
      model: 'Samsung SSD 980',
      mountpoint: null,
      children: [
        { name: '/dev/nvme0n1p1', pkname: '/dev/nvme0n1', type: 'part', mountpoint: '/boot/efi' },
        { name: '/dev/nvme0n1p2', pkname: '/dev/nvme0n1', type: 'part', mountpoint: '/' }
      ]
    },
    {
      name: '/dev/sdb',
      type: 'disk',
      size: 15931539456,
      rm: true,
      ro: false,
      tran: 'usb',
      model: 'Ultra ',
      mountpoint: null,
      children: [
        { name: '/dev/sdb1', pkname: '/dev/sdb', type: 'part', mountpoint: '/media/me/STICK' },
        { name: '/dev/sdb2', pkname: '/dev/sdb', type: 'part', mountpoint: null }
      ]
    },
    {
      // an old lsblk: strings for flags and sizes
      name: '/dev/sdc',
      type: 'disk',
      size: '1000204886016',
      rm: '0',
      ro: '0',
      tran: 'sata',
      model: 'WDC',
      children: [
        {
          name: '/dev/sdc1',
          type: 'part',
          children: [{ name: '/dev/mapper/vg-data', type: 'lvm', mountpoint: '/srv/data' }]
        }
      ]
    },
    { name: '/dev/sdd', type: 'disk', size: 0, rm: true, tran: 'usb', model: 'Card Reader' },
    { name: '/dev/sde', type: 'disk', size: 8e9, rm: true, ro: true, tran: 'usb', model: 'Locked' },
    { name: '/dev/loop0', type: 'loop', size: 1e8, mountpoint: '/snap/core/1' },
    { name: '/dev/zram0', type: 'disk', size: 4e9, mountpoint: '[SWAP]' },
    { name: '/dev/sr0', type: 'rom', size: 1e9, rm: true }
  ]
})

describe('parseLinuxDisks', () => {
  const disks = parseLinuxDisks(LSBLK)

  it('lists physical disks only', () => {
    expect(disks.map((d) => d.device)).toEqual([
      '/dev/nvme0n1',
      '/dev/sdb',
      '/dev/sdc',
      '/dev/sdd',
      '/dev/sde'
    ])
  })

  it('never writes the disk of the running system', () => {
    expect(disks[0].refusal).toBe('holds /boot/efi of the running system')
  })

  it('writes a stick after unmounting its file systems', () => {
    expect(disks[1]).toEqual({
      device: '/dev/sdb',
      rawDevice: '/dev/sdb',
      size: 15931539456,
      model: 'Ultra',
      transport: 'usb',
      removable: true,
      mounted: [{ device: '/dev/sdb1', mountpoint: '/media/me/STICK' }],
      refusal: undefined
    })
  })

  it('never writes a disk held by LVM, a reader without a card or a locked card', () => {
    expect(disks[2].refusal).toBe('is in use by lvm /dev/mapper/vg-data: release it first')
    expect(disks[2].size).toBe(1000204886016)
    expect(disks[3].refusal).toBe('has no medium')
    expect(disks[4].refusal).toBe('is read-only')
  })
})

describe('parseLinuxDisk', () => {
  const one = (node: object) => JSON.stringify({ blockdevices: [node] })

  it('refuses a partition and names its disk', () => {
    expect(() =>
      parseLinuxDisk(one({ name: '/dev/sdb1', pkname: '/dev/sdb', type: 'part' }), '/dev/sdb1')
    ).toThrow('/dev/sdb1 is a partition: pass the whole disk (/dev/sdb)')
  })

  it('takes a loop device named on purpose', () => {
    expect(
      parseLinuxDisk(one({ name: '/dev/loop7', type: 'loop', size: 4e9 }), '/dev/loop7').refusal
    ).toBeUndefined()
  })

  it('refuses what is not a disk', () => {
    expect(() => parseLinuxDisk(one({ name: '/dev/sr0', type: 'rom' }), '/dev/sr0')).toThrow(
      /rom, not a disk/
    )
    expect(() => parseLinuxDisk(JSON.stringify({ blockdevices: [] }), '/dev/x')).toThrow(
      /not a block device/
    )
  })
})

describe('inspectDisk and unmountDisk on Linux', () => {
  it('asks lsblk about the device and unmounts its file systems', async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'lsblk') {
        expect(args[args.length - 1]).toBe('/dev/sdb')
        return { stdout: JSON.stringify({ blockdevices: [JSON.parse(LSBLK).blockdevices[1]] }) }
      }
      return { stdout: '' }
    })
    const deps: DiskDeps = { platform: 'linux', run }
    const disk = await inspectDisk('/dev/sdb', deps)
    await unmountDisk(disk, deps)
    expect(run).toHaveBeenLastCalledWith('umount', ['/dev/sdb1'])
  })

  it('stops when a file system will not unmount', async () => {
    const run = vi.fn(async (command: string) => {
      if (command === 'umount') throw new Error('target is busy')
      return { stdout: JSON.stringify({ blockdevices: [JSON.parse(LSBLK).blockdevices[1]] }) }
    })
    const deps: DiskDeps = { platform: 'linux', run }
    await expect(unmountDisk(await inspectDisk('/dev/sdb', deps), deps)).rejects.toThrow(
      'Cannot unmount /media/me/STICK (/dev/sdb1): target is busy'
    )
  })

  it('refuses a name that is not under /dev', async () => {
    await expect(inspectDisk('sdb; rm -rf /', { platform: 'linux', run: vi.fn() })).rejects.toThrow(
      /not a disk/
    )
  })
})

// ------------------------------------------------------------------ macOS --

const xml = (value: unknown): string => {
  if (value === true) return '<true/>'
  if (value === false) return '<false/>'
  if (typeof value === 'number') return `<integer>${value}</integer>`
  if (typeof value === 'string')
    return `<string>${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`
  if (Array.isArray(value)) return `<array>${value.map(xml).join('')}</array>`
  const entries = Object.entries(value as object).map(([k, v]) => `<key>${k}</key>${xml(v)}`)
  return `<dict>${entries.join('\n\t')}</dict>`
}
const plist = (value: unknown) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${xml(value)}\n</plist>\n`

// What diskutil says on a Mac with an SD card and a USB stick.
const INFO: Record<string, object> = {
  '/': { DeviceIdentifier: 'disk3s1s1', ParentWholeDisk: 'disk3', WholeDisk: false },
  disk3: {
    DeviceIdentifier: 'disk3',
    ParentWholeDisk: 'disk3',
    WholeDisk: true,
    Internal: true,
    APFSPhysicalStores: [{ APFSPhysicalStore: 'disk0s2' }]
  },
  disk0s2: { DeviceIdentifier: 'disk0s2', ParentWholeDisk: 'disk0', WholeDisk: false },
  disk0: {
    DeviceIdentifier: 'disk0',
    WholeDisk: true,
    Internal: true,
    RemovableMedia: false,
    BusProtocol: 'Apple Fabric',
    Size: 500277792768,
    MediaName: 'APPLE SSD AP0512R'
  },
  disk4: {
    DeviceIdentifier: 'disk4',
    WholeDisk: true,
    Internal: false,
    RemovableMedia: true,
    BusProtocol: 'USB',
    Size: 31914983424,
    MediaName: 'SanDisk Ultra',
    WritableMedia: true
  },
  disk4s1: { DeviceIdentifier: 'disk4s1', ParentWholeDisk: 'disk4', WholeDisk: false },
  disk5: {
    DeviceIdentifier: 'disk5',
    WholeDisk: true,
    Internal: true,
    RemovableMedia: true,
    BusProtocol: 'Secure Digital',
    Size: 15931539456,
    MediaName: 'Built In SDXC Reader',
    WritableMedia: true
  },
  disk6: {
    DeviceIdentifier: 'disk6',
    WholeDisk: true,
    Internal: false,
    RemovableMedia: true,
    BusProtocol: 'USB',
    Size: 8e9,
    MediaName: 'Locked SD',
    WritableMedia: false
  }
}

const darwinRun = vi.fn(async (command: string, args: string[]) => {
  if (command === 'diskutil' && args[0] === 'list') {
    return { stdout: plist({ WholeDisks: ['disk0', 'disk3', 'disk4', 'disk5', 'disk6'] }) }
  }
  if (command === 'diskutil' && args[0] === 'info') {
    const info = INFO[args[2]]
    if (!info) throw new Error(`diskutil info: ${args[2]}: no such disk`)
    return { stdout: plist(info) }
  }
  throw new Error(`unexpected ${command} ${args.join(' ')}`)
})
const darwin: DiskDeps = { platform: 'darwin', run: darwinRun }

describe('macOS disks', () => {
  it('lists every whole disk with the reason it is not written', async () => {
    const disks = await listDisks(darwin)
    expect(disks.map((d) => [d.device, d.refusal])).toEqual([
      ['/dev/disk0', 'holds the running system'],
      ['/dev/disk3', 'is an APFS container, not a disk'],
      ['/dev/disk4', undefined],
      ['/dev/disk5', undefined],
      ['/dev/disk6', 'is read-only']
    ])
  })

  it('writes the raw device of a USB stick and of the built-in SD card reader', async () => {
    const stick = await inspectDisk('/dev/disk4', darwin)
    expect(stick).toMatchObject({ rawDevice: '/dev/rdisk4', size: 31914983424, transport: 'USB' })
    expect((await inspectDisk('rdisk5', darwin)).refusal).toBeUndefined()
  })

  it('refuses a partition, and an internal disk that is not removable', async () => {
    expect((await inspectDisk('/dev/disk4s1', darwin)).refusal).toBe(
      'is a partition: pass the whole disk (/dev/disk4)'
    )
    expect(darwinDisk(INFO.disk0 as never, new Set()).refusal).toBe(
      'is an internal disk of this Mac'
    )
  })

  it('takes disk names only', () => {
    expect(darwinDiskId('/dev/rdisk4')).toBe('disk4')
    expect(() => darwinDiskId('/dev/sdb')).toThrow(/not a macOS disk/)
    expect(() => darwinDiskId('disk4; reboot')).toThrow(/not a macOS disk/)
  })

  it('unmounts the whole disk with diskutil', async () => {
    const run = vi.fn(async () => ({ stdout: '' }))
    await unmountDisk(await inspectDisk('/dev/disk4', darwin), { platform: 'darwin', run })
    expect(run).toHaveBeenCalledWith('diskutil', ['unmountDisk', '/dev/disk4'])
  })
})

describe('inspectDisk elsewhere', () => {
  it('refuses Windows', async () => {
    await expect(
      inspectDisk('\\\\.\\PhysicalDrive1', { platform: 'win32', run: vi.fn() })
    ).rejects.toThrow(/Linux and macOS/)
  })
})

describe('parsePlist', () => {
  it('reads what diskutil prints', () => {
    expect(
      parsePlist(
        plist({
          a: 'x &amp; <y>',
          n: 42,
          t: true,
          f: false,
          list: [1, 'two', { deep: [] }],
          empty: {}
        })
      )
    ).toEqual({
      a: 'x &amp; <y>',
      n: 42,
      t: true,
      f: false,
      list: [1, 'two', { deep: [] }],
      empty: {}
    })
  })

  it('reads entities, empty strings and data', () => {
    expect(
      parsePlist(
        '<plist version="1.0"><dict><key>s</key><string>a&lt;b&amp;c&#65;</string><key>e</key><string/><key>d</key><data>\n  AAEC\n  </data></dict></plist>'
      )
    ).toEqual({ s: 'a<b&cA', e: '', d: 'AAEC' })
  })

  it('refuses what is not a property list', () => {
    expect(() => parsePlist('<html></html>')).toThrow(/Not a property list/)
    expect(() => parsePlist('<plist><dict><key>a</key><string>x</string>')).toThrow(
      /Not a property list/
    )
  })
})

describe('humanSize', () => {
  it('uses decimal units, as disks are sold', () => {
    expect(humanSize(512)).toBe('512 B')
    expect(humanSize(15931539456)).toBe('15.9 GB')
    expect(humanSize(638_100_000)).toBe('638.1 MB')
  })
})
