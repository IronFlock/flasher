import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeDeviceFiles } from '../src/main/utils/device-files'

let mountpoint: string
beforeEach(() => {
  mountpoint = mkdtempSync(path.join(tmpdir(), 'device-files-'))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => rmSync(mountpoint, { recursive: true, force: true }))

// lsblk of a flashed stick whose IRONFLOCKOS partition is mounted already.
const lsblk = () =>
  JSON.stringify({
    blockdevices: [
      {
        name: '/dev/sdb',
        type: 'disk',
        children: [
          { name: '/dev/sdb1', type: 'part', fstype: 'vfat', label: 'IRONFLOCKOS', mountpoint },
          { name: '/dev/sdb2', type: 'part', fstype: 'ext4', label: 'rootfs-a' }
        ]
      }
    ]
  })

describe('writeDeviceFiles', () => {
  it('writes the files onto the IRONFLOCKOS partition', async () => {
    const run = vi.fn(async () => ({ stdout: lsblk() }))
    await writeDeviceFiles(
      'linux',
      '/dev/sdb',
      [
        { name: 'kitchen-pi.flock', data: Buffer.from('{"name":"kitchen-pi"}') },
        { name: 'installer.conf', data: Buffer.from('payload=ironflockos-amd64-efi-base\n') }
      ],
      { run, runElevated: run }
    )
    expect(readdirSync(mountpoint).sort()).toEqual(['installer.conf', 'kitchen-pi.flock'])
    expect(readFileSync(path.join(mountpoint, 'kitchen-pi.flock'), 'utf8')).toBe(
      '{"name":"kitchen-pi"}'
    )
  })

  it('refuses a name that is a path', async () => {
    const run = vi.fn(async () => ({ stdout: lsblk() }))
    await expect(
      writeDeviceFiles('linux', '/dev/sdb', [{ name: '../evil.flock', data: Buffer.from('') }], {
        run,
        runElevated: run
      })
    ).rejects.toThrow(/Not a file name/)
    expect(run).not.toHaveBeenCalled()
  })
})
