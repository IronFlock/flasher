import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCatalogPayload } from '../src/main/security/catalog'
import { choosePlan, normalizeImageId, readDeviceFile } from '../src/cli/plan'

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
// 0.10.0: amd64-efi (base, nvidia, base-rt, installer carrying base only),
// arm64-efi, raspberrypi4 and raspberrypi5 (the same image)
const boards = () =>
  parseCatalogPayload(readFileSync(here('./fixtures/flockos/payload.json'))).boards

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('choosePlan', () => {
  it('takes the base image of the one board of the device file architecture', () => {
    const plan = choosePlan(boards(), { architecture: 'amd64' }, { installer: false })
    expect(plan.write.image_id).toBe('flockos-amd64-efi-base')
    expect(plan.payload).toBeUndefined()
    expect(plan.warnings).toEqual([])
  })

  it('asks for --image when several boards share the architecture', () => {
    expect(() => choosePlan(boards(), { architecture: 'arm64' }, { installer: false })).toThrow(
      /choose the image with --image/
    )
  })

  it('takes --image with or without the flockos- prefix', () => {
    expect(normalizeImageId('rpi-arm64-base')).toBe('flockos-rpi-arm64-base')
    const plan = choosePlan(
      boards(),
      { architecture: 'arm64' },
      { image: 'rpi-arm64-base', installer: false }
    )
    expect(plan.write.image_id).toBe('flockos-rpi-arm64-base')
    expect(plan.board.board).toBe('raspberrypi')
  })

  it('refuses an image the catalog does not have', () => {
    expect(() =>
      choosePlan(boards(), {}, { image: 'flockos-amd64-efi-desktop', installer: false })
    ).toThrow(/not an image of the catalog/)
  })

  it('writes the installer stick that carries the image, with the image as its payload', () => {
    const plan = choosePlan(boards(), { architecture: 'amd64' }, { installer: true })
    expect(plan.write.image_id).toBe('flockos-amd64-efi-installer')
    expect(plan.payload?.image_id).toBe('flockos-amd64-efi-base')
  })

  it('refuses an installer stick that does not carry the image', () => {
    expect(() => choosePlan(boards(), {}, { image: 'amd64-efi-nvidia', installer: true })).toThrow(
      /does not carry flockos-amd64-efi-nvidia/
    )
  })

  it('refuses the installer stick as the image', () => {
    expect(() =>
      choosePlan(boards(), {}, { image: 'amd64-efi-installer', installer: false })
    ).toThrow(/add --installer/)
  })

  it('refuses --installer where the board has no stick', () => {
    expect(() => choosePlan(boards(), {}, { image: 'rpi-arm64-base', installer: true })).toThrow(
      /has no installer stick/
    )
  })

  it('warns when the device file is for another architecture', () => {
    const plan = choosePlan(
      boards(),
      { architecture: 'arm64' },
      { image: 'amd64-efi-base', installer: false }
    )
    expect(plan.warnings).toEqual([expect.stringMatching(/for arm64, the image for amd64/)])
  })
})

describe('readDeviceFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cli-plan-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const file = (name: string, content: string) => {
    const target = path.join(dir, name)
    writeFileSync(target, content)
    return target
  }
  const config = {
    name: 'kitchen-pi',
    serial_number: 'abc-123',
    architecture: 'arm64',
    wlanssid: 'Old'
  }

  it('keeps the file as it is without WiFi options', async () => {
    const text = JSON.stringify(config, null, 2)
    const flock = await readDeviceFile(file('Kitchen Pi.flock', text))
    expect(flock.name).toBe('Kitchen Pi.flock')
    expect(flock.data.toString()).toBe(text)
  })

  it('puts the WiFi into the copy for the device, not into the file', async () => {
    const source = file('pi.flock', JSON.stringify(config))
    const flock = await readDeviceFile(source, { ssid: 'Workshop', password: 'pw' })
    expect(JSON.parse(flock.data.toString())).toEqual({
      ...config,
      wlanssid: 'Workshop',
      password: 'pw'
    })
    expect(JSON.parse(readFileSync(source, 'utf8'))).toEqual(config)
  })

  it('refuses what is not a device file', async () => {
    await expect(readDeviceFile(file('pi.json', JSON.stringify(config)))).rejects.toThrow(/\.flock/)
    await expect(readDeviceFile(file('pi.flock', 'not json'))).rejects.toThrow(/not JSON/)
    await expect(readDeviceFile(file('list.flock', '[]'))).rejects.toThrow(/not a device file/)
    await expect(
      readDeviceFile(file('evil.flock', JSON.stringify({ ...config, serial_number: '../x' })))
    ).rejects.toThrow(/serial_number/)
  })
})
