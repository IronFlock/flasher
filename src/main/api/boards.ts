import { homedir } from 'node:os'
import { createGunzip } from 'node:zlib'
import { access, mkdir } from 'node:fs/promises'
import { createWriteStream, createReadStream } from 'node:fs'
import path from 'node:path'
import { ImageInfo, Progress } from '../../types'
import { calculateETA, calculateSpeed, downloadFile } from '../utils'
import { cachedImageName } from '../../shared/images'

// The boards themselves come from ./catalogs (the signed IronFlockOS catalog);
// this caches and unpacks their images.
const CONFIG_PATH = '.Reflasher'
export const REFLASHER_CONFIG_PATH = path.join(homedir(), CONFIG_PATH)

export default class ImageManager {
  getImagePath(image: ImageInfo) {
    return path.join(REFLASHER_CONFIG_PATH, cachedImageName(image.file))
  }

  async createReflasherDirIfNotExists() {
    try {
      await access(REFLASHER_CONFIG_PATH)
    } catch {
      console.log(`Creating config folder at ${REFLASHER_CONFIG_PATH}`)
      try {
        await mkdir(REFLASHER_CONFIG_PATH)
      } catch (error) {
        console.log('Could not create config folder')
        throw error
      }
    }
  }

  async checkIfImageZipExists(image: ImageInfo): Promise<boolean> {
    try {
      await access(path.join(REFLASHER_CONFIG_PATH, image.file))
      return true
    } catch {
      return false
    }
  }

  async checkIfImageFileExists(image: ImageInfo): Promise<boolean> {
    try {
      await access(this.getImagePath(image))
      return true
    } catch {
      return false
    }
  }

  async downloadImageToFile(
    image: ImageInfo,
    tempPath: string,
    progress?: (payload: Partial<Progress>) => void
  ) {
    if (progress) {
      progress({ averageSpeed: 0, eta: 0, percentage: 0, speed: 0, bytesWritten: 0 })
    }

    return downloadFile(image.download, tempPath, progress)
  }

  unZipImage(
    image: ImageInfo,
    tempPath: string,
    progress?: (progress: {
      percentage: number
      averageSpeed: number
      speed: number
      eta: number
      bytesWritten: number
    }) => void
  ): Promise<void> {
    const sourcePath = tempPath
    const fileExtension = path.extname(sourcePath)

    if (fileExtension !== '.gz') {
      throw new Error(`Unzip error: file extension '${fileExtension}' is not supported!`)
    }

    const targetPath = sourcePath.slice(0, -3)

    let written = 0
    // Set once at the start: `written` is cumulative, so elapsed time must be measured
    // from the beginning of the whole decompression, not reset on every chunk.
    const startTime = Date.now()

    if (progress) {
      progress({ averageSpeed: 0, eta: 0, percentage: 0, speed: 0, bytesWritten: 0 })
    }

    return new Promise((resolve, reject) => {
      const readStream = createReadStream(sourcePath)
      const writeStream = createWriteStream(targetPath)
      const zipTransform = createGunzip()

      // Any stream error (corrupt/truncated gzip, read/write failure) now rejects
      // instead of throwing an unhandled 'error' event that could crash the process.
      const onError = (err: Error) => {
        readStream.destroy()
        zipTransform.destroy()
        writeStream.destroy()
        reject(err)
      }
      readStream.on('error', onError)
      zipTransform.on('error', onError)
      writeStream.on('error', onError)

      // image.size is the COMPRESSED .gz size (the registry publishes the download's
      // content-length), so track compressed bytes READ against it for a correct
      // 0-100%. Counting decompressed output would overshoot badly — the image is
      // several times larger than its .gz.
      readStream.on('data', (chunk: string | Buffer) => {
        written += chunk.length
        if (progress && image.size > 0) {
          const elapsedTime = (Date.now() - startTime) / 1000
          const { speed, averageSpeed } = calculateSpeed(written, elapsedTime)
          const eta = calculateETA(written, speed, image.size)
          const percentage = Math.min(100, (written / image.size) * 100)
          progress({ percentage, averageSpeed, eta, speed, bytesWritten: written })
        }
      })

      // Resolve only once the output is fully flushed to disk.
      writeStream.on('finish', () => resolve())

      readStream.pipe(zipTransform).pipe(writeStream)
    })
  }
}
