import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ImageInfo } from '../src/types'
import { verifiedImage } from '../src/cli/image'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cli-image-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const BYTES = Buffer.from('the image of the catalog')
const image = {
  file: 'flockos-amd64-efi-base-0.13.0.img.gz',
  download: 'https://dl.example/flockos/0.13.0/flockos-amd64-efi-base-0.13.0.img.gz',
  size: BYTES.length,
  sha256: createHash('sha256').update(BYTES).digest('hex')
} as ImageInfo

const fakeDownload = (data: Buffer) =>
  vi.fn(async (_url: string, dest: string) => {
    writeFileSync(dest, data)
  })

describe('verifiedImage', () => {
  it('downloads into the cache and checks the download', async () => {
    const download = fakeDownload(BYTES)
    const source = await verifiedImage(image, { cacheDir: dir, download })
    expect(source).toEqual({ path: path.join(dir, image.file), from: 'download' })
    expect(download).toHaveBeenCalledWith(
      image.download,
      path.join(dir, image.file),
      expect.any(Function),
      { expectedSha256: image.sha256 }
    )
  })

  it('takes the cached file when it still matches, and downloads again when not', async () => {
    writeFileSync(path.join(dir, image.file), BYTES)
    const download = fakeDownload(BYTES)
    expect(await verifiedImage(image, { cacheDir: dir, download })).toMatchObject({ from: 'cache' })
    expect(download).not.toHaveBeenCalled()

    writeFileSync(path.join(dir, image.file), Buffer.from('the image of the catalog?'))
    expect(await verifiedImage(image, { cacheDir: dir, download })).toMatchObject({
      from: 'download'
    })
  })

  it('refuses and removes a download that is not the catalog image', async () => {
    const download = fakeDownload(Buffer.from('the image of somebody else'))
    await expect(verifiedImage(image, { cacheDir: dir, download })).rejects.toThrow(
      /bytes; the catalog's/
    )
    expect(existsSync(path.join(dir, image.file))).toBe(false)
  })

  it('takes a local file only when it is the catalog image', async () => {
    const good = path.join(dir, 'mine.img.gz')
    writeFileSync(good, BYTES)
    expect(await verifiedImage(image, { cacheDir: dir, imageFile: good })).toEqual({
      path: good,
      from: 'file'
    })

    const bad = path.join(dir, 'other.img.gz')
    // the same size, other bytes
    writeFileSync(bad, Buffer.from('THE IMAGE OF THE CATALOG'))
    await expect(verifiedImage(image, { cacheDir: dir, imageFile: bad })).rejects.toThrow(
      /SHA-256 .*not the image of the signed catalog/
    )
  })
})
