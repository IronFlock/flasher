import { readFile, stat } from 'node:fs/promises'
import type { ImageInfo, SupportedBoard } from '../types'
import { assertValidFlockConfig } from '../main/security/validation'
import { assertInstallerCarries, FlashPlan } from '../main/api/catalogs'
import { configFileName } from '../main/utils/config-partition'
import {
  defaultImage,
  imageKey,
  installerFor,
  isConfigFileName,
  matchBoard
} from '../shared/images'

// What `flockflasher flash` writes: the device file and the catalog image,
// chosen the way FlockFlasher chooses them. Pure apart from reading the file.

// FlockFlasher reads device files up to this size (ipcHandlers.ts).
const MAX_FLOCK_BYTES = 5 * 1024 * 1024

export type FlockFile = {
  // the file's name on the FLOCKOS partition
  name: string
  data: Buffer
  config: Record<string, unknown>
}

// Reads and checks a device file. With a WiFi network, the copy for the
// device carries it (as FlockFlasher's WiFi fields do); the file itself is not
// changed.
export const readDeviceFile = async (
  file: string,
  wifi?: { ssid?: string; password?: string }
): Promise<FlockFile> => {
  if (!isConfigFileName(file)) throw new Error(`${file} is not a device file (.flock)`)
  const info = await stat(file)
  if (!info.isFile()) throw new Error(`${file} is not a file`)
  if (info.size > MAX_FLOCK_BYTES) throw new Error(`${file} is too large for a device file`)
  const original = await readFile(file)
  let config: unknown
  try {
    config = JSON.parse(original.toString('utf8'))
  } catch {
    throw new Error(`${file} is not a device file: it is not JSON`)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${file} is not a device file`)
  }
  assertValidFlockConfig(config)
  const record = config as Record<string, unknown>
  if (wifi?.ssid === undefined)
    return { name: configFileName(file), data: original, config: record }
  const changed = { ...record, wlanssid: wifi.ssid, password: wifi.password ?? '' }
  return { name: configFileName(file), data: Buffer.from(JSON.stringify(changed)), config: changed }
}

export type Choice = FlashPlan & { board: SupportedBoard; warnings: string[] }

const allImages = (boards: SupportedBoard[]) => boards.flatMap((b) => b.latestImages)

// --image takes an image id, with or without its flockos- prefix.
export const normalizeImageId = (id: string): string =>
  id.startsWith('flockos-') ? id : `flockos-${id}`

// The image to write: --image, else the default variant of the board the
// device file asks for; with --installer, the board's installer stick that
// carries it.
export const choosePlan = (
  boards: SupportedBoard[],
  config: Record<string, unknown>,
  options: { image?: string; installer: boolean }
): Choice => {
  const warnings: string[] = []
  let board: SupportedBoard | undefined
  let image: ImageInfo | undefined

  if (options.image !== undefined) {
    const id = normalizeImageId(options.image)
    board = boards.find((b) => b.latestImages.some((i) => i.image_id === id))
    image = board?.latestImages.find((i) => i.image_id === id)
    if (!board || !image) {
      const known = [...new Set(allImages(boards).map((i) => i.image_id))].join(', ')
      throw new Error(`${id} is not an image of the catalog (it has ${known})`)
    }
    if (image.variant === 'installer') {
      const carried = (image.payloads ?? []).join(', ')
      throw new Error(
        `${id} is the installer stick: choose the image it installs with --image and add --installer (it carries ${carried})`
      )
    }
  } else {
    board = matchBoard(boards, config as Parameters<typeof matchBoard>[1])
    if (!board) {
      const architecture = typeof config.architecture === 'string' ? config.architecture : 'none'
      throw new Error(
        `The device file does not tell which hardware it is for (architecture ${architecture}): choose the image with --image (flockflasher images lists them)`
      )
    }
    image = defaultImage(board.latestImages)
    if (!image) throw new Error(`The catalog has no image for ${board.modelname}`)
  }

  const architecture = config.architecture
  if (
    typeof architecture === 'string' &&
    architecture !== '' &&
    architecture !== board.architecture
  ) {
    warnings.push(
      `The device file is for ${architecture}, the image for ${board.architecture}: the device would not run its apps`
    )
  }

  if (!options.installer) return { board, write: image, warnings }
  const installer = installerFor(board, imageKey(image))
  if (!installer) {
    const sticks = board.latestImages.filter((i) => i.variant === 'installer')
    throw new Error(
      sticks.length === 0
        ? `${board.modelname} has no installer stick: write the image to the device's disk instead`
        : `The installer stick of ${board.modelname} does not carry ${image.image_id} (it carries ${(sticks[0].payloads ?? []).join(', ')})`
    )
  }
  assertInstallerCarries(installer, image)
  return { board, write: installer, payload: image, warnings }
}
