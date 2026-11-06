import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  cachedImageName,
  defaultImage,
  defaultImageKey,
  hardwareTitle,
  imageKey,
  installerFor,
  installerKeyFor,
  isConfigFileName,
  matchBoard,
  rebindChoice,
  sortImages,
  variantImages
} from '../src/shared/images'
import {
  openCatalog,
  FLOCKOS_CATALOG_PUBLIC_KEYS,
  parsePublicKeys
} from '../src/main/security/catalog'

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const boards = openCatalog(
  readFileSync(here('./fixtures/flockos/manifest.json')),
  parsePublicKeys(FLOCKOS_CATALOG_PUBLIC_KEYS)
).boards
const board = (model: string) => boards.find((b) => b.model === model)!

describe('variant selection', () => {
  it('defaults to base with the standard kernel, not latestImages[0]', () => {
    const pc = board('amd64-efi')
    const reordered = [...pc.latestImages].reverse() // installer, base-rt, nvidia, base
    expect(defaultImage(reordered)?.image_id).toBe('flockos-amd64-efi-base')
    expect(defaultImageKey(pc)).toBe('flockos-amd64-efi-base@0.10.0')
  })

  it('falls back to any base, then to the first image', () => {
    const pc = board('amd64-efi')
    const noStd = pc.latestImages.filter((i) => i.kernel === 'rt' || i.variant !== 'base')
    expect(defaultImage(noStd)?.image_id).toBe('flockos-amd64-efi-base-rt')
    // the installer stick is never a variant, so never the default
    const onlyInstaller = pc.latestImages.filter((i) => i.variant === 'installer')
    expect(defaultImage(onlyInstaller)).toBeUndefined()
    expect(defaultImage([])).toBeUndefined()
    expect(defaultImageKey(undefined)).toBeUndefined()
  })

  it('orders base, base rt, nvidia, installer', () => {
    expect(sortImages(board('amd64-efi').latestImages).map((i) => i.image_id)).toEqual([
      'flockos-amd64-efi-base',
      'flockos-amd64-efi-base-rt',
      'flockos-amd64-efi-nvidia',
      'flockos-amd64-efi-installer'
    ])
  })

  it('keys images by id and version', () => {
    const rpi = board('raspberrypi5').latestImages[0]
    expect(imageKey(rpi)).toBe('flockos-rpi-arm64-base@0.10.0')
    // the same image under both Pi boards
    expect(imageKey(board('raspberrypi4').latestImages[0])).toBe(imageKey(rpi))
  })
})

describe('matchBoard', () => {
  it('takes the board of the model the device file names', () => {
    expect(matchBoard(boards, { board: { model: 'raspberrypi4' } })?.model).toBe('raspberrypi4')
  })

  it('offers nothing for a model the catalog does not list', () => {
    expect(matchBoard(boards, { board: { model: 'raspberrypi3' } })).toBeUndefined()
    expect(matchBoard(boards, { architecture: 'armv7', board: { model: 'efi' } })).toBeUndefined()
  })

  it('picks the one board of the architecture of a .flock without a board', () => {
    expect(matchBoard(boards, { architecture: 'amd64' })?.model).toBe('amd64-efi')
    // arm64: arm64-efi, Pi 4 and Pi 5; the user chooses
    expect(matchBoard(boards, { architecture: 'arm64' })).toBeUndefined()
    expect(matchBoard(boards, undefined)).toBeUndefined()
  })
})

describe('file names', () => {
  it('takes device files only, no disk images', () => {
    for (const name of ['a.flock', '/home/u/b.flock', 'C:\\x\\A.FLOCK']) {
      expect(isConfigFileName(name)).toBe(true)
    }
    for (const name of [
      'a.reswarm',
      'a.img',
      'a.img.gz',
      'a.img.xz',
      'a.iso',
      'a.flock.img',
      '.flock',
      'a.json'
    ]) {
      expect(isConfigFileName(name)).toBe(false)
    }
  })

  it('caches a catalog image decompressed', () => {
    expect(cachedImageName('flockos-amd64-efi-base-0.10.0.img.gz')).toBe(
      'flockos-amd64-efi-base-0.10.0.img'
    )
  })
})

describe('rebindChoice', () => {
  // the same catalog, one release later
  const next = boards.map((b) => ({
    ...b,
    latestImages: b.latestImages.map((i) => ({ ...i, version: '0.11.0' }))
  }))

  it('keeps the board and the variant on a new release', () => {
    const choice = rebindChoice(next, board('amd64-efi'), 'flockos-amd64-efi-nvidia@0.10.0')
    expect(choice.board).toBe(next[0])
    expect(choice.imageKey).toBe('flockos-amd64-efi-nvidia@0.11.0')
  })

  it('falls back to the default image when the variant is gone', () => {
    const withoutNvidia = next.map((b) => ({
      ...b,
      latestImages: b.latestImages.filter((i) => i.variant !== 'nvidia')
    }))
    expect(
      rebindChoice(withoutNvidia, board('amd64-efi'), 'flockos-amd64-efi-nvidia@0.10.0').imageKey
    ).toBe('flockos-amd64-efi-base@0.11.0')
  })

  it('drops a board the catalog no longer lists', () => {
    expect(
      rebindChoice(next.slice(1), board('amd64-efi'), 'flockos-amd64-efi-base@0.10.0')
    ).toEqual({ board: undefined, imageKey: undefined })
    expect(rebindChoice(next, undefined, undefined)).toEqual({
      board: undefined,
      imageKey: undefined
    })
  })
})

describe('hardwareTitle', () => {
  it('names the hardware only, no OS name or version', () => {
    expect(boards.map((b) => hardwareTitle(b, boards))).toEqual([
      'x86-64 PC with UEFI',
      'ARM64 machine with UEFI',
      'Raspberry Pi 4, 400 and CM4',
      'Raspberry Pi 5 and CM5'
    ])
  })

  it('adds the architecture when two boards share a name', () => {
    const twin = { ...board('arm64-efi'), model: 'amd64-twin', modelname: 'x86-64 PC with UEFI' }
    expect(hardwareTitle(board('amd64-efi'), [...boards, twin])).toBe('x86-64 PC with UEFI (amd64)')
    expect(hardwareTitle(twin, [...boards, twin])).toBe('x86-64 PC with UEFI (arm64)')
  })
})

describe('variants and the installer stick', () => {
  const ALL = ['flockos-amd64-efi-base', 'flockos-amd64-efi-base-rt', 'flockos-amd64-efi-nvidia']
  // amd64-efi with an installer that carries every variant
  const pcCarryingAll = {
    ...board('amd64-efi'),
    latestImages: board('amd64-efi').latestImages.map((i) =>
      i.variant === 'installer' ? { ...i, payloads: ALL } : i
    )
  }

  it('offers the variants without the installer, in order', () => {
    expect(variantImages(board('amd64-efi')).map((i) => i.image_id)).toEqual(ALL)
    expect(variantImages(board('raspberrypi5')).map((i) => i.image_id)).toEqual([
      'flockos-rpi-arm64-base'
    ])
    expect(variantImages(undefined)).toEqual([])
  })

  it('offers the installer stick only for a variant it carries (v0.10.0: base)', () => {
    const pc = board('amd64-efi')
    expect(installerKeyFor(pc, 'flockos-amd64-efi-base@0.10.0')).toBe(
      'flockos-amd64-efi-installer@0.10.0'
    )
    expect(installerFor(pc, 'flockos-amd64-efi-base-rt@0.10.0')).toBeUndefined()
    expect(installerFor(pc, 'flockos-amd64-efi-nvidia@0.10.0')).toBeUndefined()
    expect(installerFor(pc, 'flockos-amd64-efi-installer@0.10.0')).toBeUndefined()
    expect(installerFor(pc, undefined)).toBeUndefined()
    // no installer for the Pis
    expect(installerFor(board('raspberrypi4'), 'flockos-rpi-arm64-base@0.10.0')).toBeUndefined()
  })

  it('offers it for every variant a stick carries', () => {
    for (const id of ALL) {
      expect(installerKeyFor(pcCarryingAll, `${id}@0.10.0`)).toBe(
        'flockos-amd64-efi-installer@0.10.0'
      )
    }
  })

  it('keeps the installer stick on a new release only while it carries the variant', () => {
    const next = [pcCarryingAll, board('raspberrypi4')].map((b) => ({
      ...b,
      latestImages: b.latestImages.map((i) =>
        i.image_id === 'flockos-amd64-efi-installer'
          ? { ...i, version: '0.11.0', payloads: ['flockos-amd64-efi-base'] }
          : { ...i, version: '0.11.0' }
      )
    }))
    const pc = board('amd64-efi')
    expect(rebindChoice(next, pc, 'flockos-amd64-efi-base@0.10.0', true)).toMatchObject({
      imageKey: 'flockos-amd64-efi-base@0.11.0',
      installerKey: 'flockos-amd64-efi-installer@0.11.0'
    })
    expect(rebindChoice(next, pc, 'flockos-amd64-efi-nvidia@0.10.0', true)).toMatchObject({
      imageKey: 'flockos-amd64-efi-nvidia@0.11.0',
      installerKey: undefined
    })
    expect(
      rebindChoice(next, pc, 'flockos-amd64-efi-base@0.10.0', false).installerKey
    ).toBeUndefined()
  })
})
