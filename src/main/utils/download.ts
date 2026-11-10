import { createWriteStream } from 'fs'
import fs from 'fs/promises'
import https from 'https'
import { Progress } from '../../types'
import { calculateSpeed, calculateETA } from './progress'
import { verifyFileSha256 } from '../security/integrity'

// HTTPS downloads. Electron-free, so the command-line tool (src/cli) shares it.

export const getRemoteFileSize = (url: string): Promise<number> => {
  return new Promise((res, rej) => {
    const request = https.request(url, { method: 'HEAD' }, (result) => {
      result.on('error', rej)
      result.resume() // drain any body so the socket can close
      result.on('end', () => {
        const status = result.statusCode ?? 0
        // Follow one redirect for the HEAD probe (the GET follows them too).
        if (status >= 300 && status < 400 && result.headers.location) {
          const next = new URL(result.headers.location, url).toString()
          return getRemoteFileSize(next).then(res, rej)
        }
        if (status < 200 || status >= 300) return rej(new Error(`HEAD failed: HTTP ${status}`))
        res(parseInt(result.headers['content-length'] ?? '0', 10) || 0)
      })
    })

    request.on('error', rej) // the request itself had no error handler before
    request.end()
  })
}

type DownloadOptions = {
  mode?: number | undefined
  // Verify the downloaded bytes against this SHA-256 hex digest before committing.
  expectedSha256?: string
}

// Download over HTTPS to a temporary `.part` file, then atomically rename into
// place. Rejects on non-2xx status, on network/stream errors, on a truncated
// transfer (bytes != content-length), and on a SHA-256 mismatch — and never leaves
// a partial file at the final path. Redirects are followed (bounded).
export const downloadFile = async (
  url: string,
  destPath: string,
  progress?: (progress: Partial<Progress>) => void,
  options?: DownloadOptions
): Promise<void> => {
  const tempPath = `${destPath}.part`
  const writeStream = createWriteStream(tempPath, { mode: options?.mode })

  let written = 0
  const startTime = Date.now()

  if (progress) {
    progress({ averageSpeed: 0, eta: 0, percentage: 0, speed: 0, bytesWritten: 0 })
  }

  const size = await getRemoteFileSize(url).catch(() => 0)

  const cleanupPartial = async () => {
    writeStream.destroy()
    await fs.unlink(tempPath).catch(() => undefined)
  }

  await new Promise<void>((resolve, reject) => {
    const fail = (err: unknown) => {
      cleanupPartial().finally(() => reject(err))
    }

    const request = (currentUrl: string, redirectsLeft: number) => {
      https
        .get(currentUrl, (res) => {
          const status = res.statusCode ?? 0

          // Follow redirects to a bounded depth.
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume() // drain
            if (redirectsLeft <= 0) return fail(new Error('Too many redirects'))
            const next = new URL(res.headers.location, currentUrl).toString()
            return request(next, redirectsLeft - 1)
          }

          if (status < 200 || status >= 300) {
            res.resume()
            return fail(new Error(`Download failed: HTTP ${status} for ${currentUrl}`))
          }

          res.on('error', fail)

          res.on('data', (buf) => {
            const ok = writeStream.write(buf, (err) => {
              if (err) fail(err)
            })
            written += buf.length
            if (progress) {
              const elapsedTime = (Date.now() - startTime) / 1000
              const { speed, averageSpeed } = calculateSpeed(written, elapsedTime)
              const eta = calculateETA(written, speed, size)
              const percentage = size > 0 ? (written / size) * 100 : 0
              progress({ percentage, averageSpeed, eta, speed, bytesWritten: written })
            }
            if (!ok) res.pause()
          })

          writeStream.on('drain', () => res.resume())

          res.on('end', () => {
            writeStream.end(() => resolve())
          })
        })
        .on('error', fail)
    }

    writeStream.on('error', fail)
    request(url, 5)
  })

  // Detect truncated downloads when the server told us the size.
  if (size > 0 && written !== size) {
    await cleanupPartial()
    throw new Error(`Incomplete download: expected ${size} bytes, got ${written}`)
  }

  if (options?.expectedSha256) {
    try {
      await verifyFileSha256(tempPath, options.expectedSha256)
    } catch (err) {
      await cleanupPartial()
      throw err
    }
  }

  await fs.rename(tempPath, destPath)
}
