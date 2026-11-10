import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream'
import { createGunzip } from 'node:zlib'

// Writes a verified .img.gz to a disk without a temporary copy: decompressed
// as it is read, in whole blocks (macOS's raw devices take whole sectors
// only), synced to the disk as it goes, then read back and compared. Plain
// Node, no native modules: it writes any path (the tests write a file).

export const BLOCK_BYTES = 4 * 1024 * 1024
const SECTOR_BYTES = 512
// Synced every this many bytes, so the progress is the disk's, not the cache's.
const SYNC_BYTES = 64 * 1024 * 1024

export type WriteProgress = {
  phase: 'writing' | 'verifying'
  // writing: compressed bytes read of `total` (the .img.gz); verifying: disk
  // bytes read of `total` (the image)
  done: number
  total: number
}

export type WriteResult = { bytes: number; sha256: string; verified: boolean }

// The decompressed image in BLOCK_BYTES pieces; the last one is padded with
// zeros to a whole sector.
export async function* imageBlocks(
  source: string,
  onRead?: (compressedBytes: number) => void
): AsyncGenerator<Buffer> {
  const input = createReadStream(source, { highWaterMark: 1024 * 1024 })
  let read = 0
  input.on('data', (chunk) => {
    read += chunk.length
    onRead?.(read)
  })
  // pipeline destroys every stream on an error, so a broken file or a corrupt
  // gzip ends the loop below with that error.
  const output = pipeline(input, createGunzip(), () => undefined)
  let block = Buffer.allocUnsafe(BLOCK_BYTES)
  let filled = 0
  for await (const chunk of output as AsyncIterable<Buffer>) {
    let offset = 0
    while (offset < chunk.length) {
      const take = Math.min(chunk.length - offset, BLOCK_BYTES - filled)
      chunk.copy(block, filled, offset, offset + take)
      filled += take
      offset += take
      if (filled === BLOCK_BYTES) {
        yield block
        block = Buffer.allocUnsafe(BLOCK_BYTES)
        filled = 0
      }
    }
  }
  if (filled > 0) {
    const padded = Math.ceil(filled / SECTOR_BYTES) * SECTOR_BYTES
    block.fill(0, filled, padded)
    yield block.subarray(0, padded)
  }
}

// Linux: O_EXCL on a block device fails (EBUSY) while it, or a partition of
// it, is mounted or otherwise in use, and keeps it so while it is open.
const openFlags = async (target: string): Promise<number> => {
  const info = await stat(target)
  const exclusive = process.platform === 'linux' && info.isBlockDevice() ? constants.O_EXCL : 0
  return constants.O_WRONLY | exclusive
}

export const writeImage = async (opts: {
  // the .img.gz, already checked against the catalog
  source: string
  sourceBytes: number
  // the raw device (or a file)
  target: string
  verify: boolean
  onProgress?: (progress: WriteProgress) => void
  // drops cached blocks before the read-back; false when it could not
  beforeVerify?: () => Promise<boolean>
  onWarning?: (message: string) => void
}): Promise<WriteResult> => {
  const hash = createHash('sha256')
  let bytes = 0
  const handle = await open(opts.target, await openFlags(opts.target))
  try {
    let sinceSync = 0
    for await (const block of imageBlocks(opts.source, (done) =>
      opts.onProgress?.({ phase: 'writing', done, total: opts.sourceBytes })
    )) {
      let offset = 0
      while (offset < block.length) {
        const { bytesWritten } = await handle.write(block, offset, block.length - offset, bytes)
        if (bytesWritten === 0) throw new Error(`${opts.target} took no more bytes at ${bytes}`)
        offset += bytesWritten
        bytes += bytesWritten
      }
      hash.update(block)
      sinceSync += block.length
      if (sinceSync >= SYNC_BYTES) {
        await handle.datasync()
        sinceSync = 0
      }
    }
    await handle.sync()
  } catch (error: any) {
    if (error?.code === 'ENOSPC' || error?.code === 'EIO') {
      throw new Error(
        `${opts.target} is too small for the image or failed (${error.code} after ${bytes} bytes)`
      )
    }
    throw error
  } finally {
    await handle.close()
  }
  const sha256 = hash.digest('hex')

  if (!opts.verify) return { bytes, sha256, verified: false }
  if (opts.beforeVerify && !(await opts.beforeVerify())) {
    opts.onWarning?.('Could not drop the disk cache: the check may read the cache, not the disk')
  }
  const actual = await readBack(opts.target, bytes, (done) =>
    opts.onProgress?.({ phase: 'verifying', done, total: bytes })
  )
  if (actual !== sha256) {
    throw new Error(`${opts.target} does not read back what was written: the disk may be faulty`)
  }
  return { bytes, sha256, verified: true }
}

// The SHA-256 of the first `length` bytes of a disk (or file).
export const readBack = async (
  target: string,
  length: number,
  onProgress?: (done: number) => void
): Promise<string> => {
  const hash = createHash('sha256')
  const handle = await open(target, constants.O_RDONLY)
  try {
    const buffer = Buffer.allocUnsafe(BLOCK_BYTES)
    let position = 0
    while (position < length) {
      const want = Math.min(BLOCK_BYTES, length - position)
      const { bytesRead } = await handle.read(buffer, 0, want, position)
      if (bytesRead === 0) throw new Error(`${target} ended at ${position} of ${length} bytes`)
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
      onProgress?.(position)
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}
