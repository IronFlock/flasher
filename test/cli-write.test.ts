import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { BLOCK_BYTES, WriteProgress, imageBlocks, readBack, writeImage } from '../src/cli/write'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cli-write-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// An image of `bytes` bytes as .img.gz, and a "disk" of `diskBytes` zeros.
const fixture = (bytes: number, diskBytes = bytes + 2 * BLOCK_BYTES) => {
  const image = randomBytes(bytes)
  const source = path.join(dir, 'image.img.gz')
  const gz = gzipSync(image)
  writeFileSync(source, gz)
  const target = path.join(dir, 'disk')
  writeFileSync(target, Buffer.alloc(diskBytes))
  return { image, source, sourceBytes: gz.length, target }
}

const sectors = (n: number) => Math.ceil(n / 512) * 512

describe('imageBlocks', () => {
  it('cuts the image into whole blocks and pads the last one to a whole sector', async () => {
    const { image, source } = fixture(2 * BLOCK_BYTES + 1000)
    const blocks: Buffer[] = []
    for await (const block of imageBlocks(source)) blocks.push(Buffer.from(block))
    expect(blocks.map((b) => b.length)).toEqual([BLOCK_BYTES, BLOCK_BYTES, 1024])
    const joined = Buffer.concat(blocks)
    expect(joined.subarray(0, image.length).equals(image)).toBe(true)
    expect(joined.subarray(image.length).equals(Buffer.alloc(24))).toBe(true)
  })

  it('ends with the error of a corrupt image', async () => {
    const source = path.join(dir, 'broken.img.gz')
    writeFileSync(source, gzipSync(randomBytes(100_000)).subarray(0, 5_000))
    const read = async () => {
      for await (const _ of imageBlocks(source)) void _
    }
    await expect(read()).rejects.toThrow()
  })
})

describe('writeImage', () => {
  it('writes the image, reads it back and reports both phases', async () => {
    const { image, source, sourceBytes, target } = fixture(BLOCK_BYTES + 12_345)
    const seen: WriteProgress[] = []
    const result = await writeImage({
      source,
      sourceBytes,
      target,
      verify: true,
      onProgress: (p) => seen.push(p)
    })
    const written = readFileSync(target)
    expect(written.subarray(0, image.length).equals(image)).toBe(true)
    expect(result.bytes).toBe(sectors(image.length))
    expect(result.verified).toBe(true)
    expect(result.sha256).toBe(
      createHash('sha256').update(written.subarray(0, result.bytes)).digest('hex')
    )
    expect(seen.at(-1)).toEqual({ phase: 'verifying', done: result.bytes, total: result.bytes })
    const writing = seen.filter((p) => p.phase === 'writing')
    expect(writing.at(-1)).toEqual({ phase: 'writing', done: sourceBytes, total: sourceBytes })
  })

  it('leaves the rest of the disk alone', async () => {
    const { image, source, sourceBytes, target } = fixture(10_000)
    writeFileSync(target, Buffer.alloc(BLOCK_BYTES, 0xab))
    await writeImage({ source, sourceBytes, target, verify: false })
    const written = readFileSync(target)
    expect(written.subarray(0, image.length).equals(image)).toBe(true)
    expect(written[sectors(image.length)]).toBe(0xab)
    expect(written.length).toBe(BLOCK_BYTES)
  })

  it('finds a disk that does not read back what was written', async () => {
    const { source, sourceBytes, target } = fixture(100_000)
    const warnings: string[] = []
    await expect(
      writeImage({
        source,
        sourceBytes,
        target,
        verify: true,
        // a faulty disk: one byte flips
        beforeVerify: async () => {
          const data = readFileSync(target)
          data[4096] ^= 0xff
          writeFileSync(target, data)
          return false
        },
        onWarning: (message) => warnings.push(message)
      })
    ).rejects.toThrow(/does not read back what was written/)
    expect(warnings).toEqual([expect.stringMatching(/Could not drop the disk cache/)])
  })

  it('does not create a missing target', async () => {
    const { source, sourceBytes } = fixture(1000)
    await expect(
      writeImage({ source, sourceBytes, target: path.join(dir, 'nope'), verify: false })
    ).rejects.toThrow(/ENOENT/)
  })
})

describe('readBack', () => {
  it('hashes the first bytes and refuses a disk that ends early', async () => {
    const target = path.join(dir, 'disk')
    const data = randomBytes(3 * 1024 * 1024)
    writeFileSync(target, data)
    expect(await readBack(target, 1024 * 1024)).toBe(
      createHash('sha256')
        .update(data.subarray(0, 1024 * 1024))
        .digest('hex')
    )
    await expect(readBack(target, 4 * 1024 * 1024)).rejects.toThrow(/ended at/)
  })
})
