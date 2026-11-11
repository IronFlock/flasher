import { mkdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { ImageInfo } from '../types'
import { sha256File } from '../main/security/integrity'
import { downloadFile } from '../main/utils/download'

// The .img.gz of a catalog image, checked against the catalog's size and
// SHA-256 every time it is used: a file the user names (--image-file), else
// the cached download, else a new download into the cache.

export type ImageSource = { path: string; from: 'file' | 'cache' | 'download' }

const matches = async (file: string, image: ImageInfo): Promise<string | undefined> => {
  const info = await stat(file)
  if (!info.isFile()) return `${file} is not a file`
  if (info.size !== image.size) {
    return `${file} is ${info.size} bytes; the catalog's ${image.file} is ${image.size}`
  }
  const sha256 = await sha256File(file)
  if (sha256 !== image.sha256) {
    return `${file} has the SHA-256 ${sha256}; the catalog's ${image.file} has ${image.sha256}`
  }
  return undefined
}

export const verifiedImage = async (
  image: ImageInfo,
  opts: {
    cacheDir: string
    imageFile?: string
    onChecking?: (file: string) => void
    onDownload?: (done: number, total: number) => void
    download?: typeof downloadFile
  }
): Promise<ImageSource> => {
  if (opts.imageFile !== undefined) {
    opts.onChecking?.(opts.imageFile)
    const mismatch = await matches(opts.imageFile, image)
    if (mismatch) throw new Error(`${mismatch}: it is not the image of the signed catalog`)
    return { path: opts.imageFile, from: 'file' }
  }

  // image.file comes from the verified catalog and is a single path segment
  // (isSafePathSegment in security/catalog.ts).
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const cached = path.join(opts.cacheDir, image.file)
  const present = await stat(cached).then(
    () => true,
    () => false
  )
  if (present) {
    opts.onChecking?.(cached)
    if ((await matches(cached, image)) === undefined) return { path: cached, from: 'cache' }
    await unlink(cached)
  }

  await mkdir(opts.cacheDir, { recursive: true })
  await (opts.download ?? downloadFile)(
    image.download,
    cached,
    (progress) => opts.onDownload?.(progress.bytesWritten ?? 0, image.size),
    { expectedSha256: image.sha256 }
  )
  const mismatch = await matches(cached, image)
  if (mismatch) {
    await unlink(cached).catch(() => undefined)
    throw new Error(mismatch)
  }
  return { path: cached, from: 'download' }
}
