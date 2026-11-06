// Pure helpers about boards and images, shared by the main process and the
// renderer (no Node or Electron imports). The main process resolves what the
// renderer picked against its own verified catalog; nothing here is a trust
// decision.

import type { ImageInfo, SupportedBoard } from '../types'

// The only files FlockFlasher takes: device files. What it flashes is always a
// FlockOS image of the signed catalog, never a local image file.
export const CONFIG_FILE_SUFFIXES = ['.flock'] as const
export const FILE_DIALOG_EXTENSIONS = ['flock']

export const isConfigFileName = (name: string): boolean => {
  const lower = name.toLowerCase()
  return CONFIG_FILE_SUFFIXES.some(
    (suffix) => lower.endsWith(suffix) && lower.length > suffix.length
  )
}

// The file a catalog image (<image-id>-<version>.img.gz) is flashed from in the
// cache: the download, decompressed.
export const cachedImageName = (file: string): string => file.replace(/\.gz$/, '')

// What the renderer sends to name the image to flash. The main process looks it
// up in its own verified catalog, so the download URL and digest it uses never
// come from the renderer or from a .flock file.
export const imageKey = (image: ImageInfo): string => `${image.image_id}@${image.version}`

const VARIANT_ORDER = ['base', 'nvidia', 'installer']

// base before nvidia before installer, the standard kernel before rt; stable
// otherwise.
export const sortImages = (images: ImageInfo[]): ImageInfo[] =>
  images
    .map((image, index) => ({ image, index }))
    .sort((a, b) => {
      const variant =
        VARIANT_ORDER.indexOf(a.image.variant) - VARIANT_ORDER.indexOf(b.image.variant)
      if (variant !== 0) return variant
      const kernel = (a.image.kernel === 'rt' ? 1 : 0) - (b.image.kernel === 'rt' ? 1 : 0)
      return kernel !== 0 ? kernel : a.index - b.index
    })
    .map(({ image }) => image)

// The installer stick is not a variant but a way to install one (see
// installerFor): the variants of a board are its other images.
export const variantImages = (board: SupportedBoard | undefined): ImageInfo[] =>
  sortImages((board?.latestImages ?? []).filter((i) => i.variant !== 'installer'))

// The variant a board offers by default: base with the standard kernel.
export const defaultImage = (images: ImageInfo[] | undefined): ImageInfo | undefined => {
  const variants = (images ?? []).filter((i) => i.variant !== 'installer')
  return (
    variants.find((i) => i.variant === 'base' && i.kernel === 'std') ??
    variants.find((i) => i.variant === 'base') ??
    variants[0]
  )
}

// The board's installer stick that carries the image with this key, if any:
// "How to install" is offered only then.
export const installerFor = (
  board: SupportedBoard | undefined,
  key: string | undefined
): ImageInfo | undefined => {
  const image = board?.latestImages.find((i) => imageKey(i) === key && i.variant !== 'installer')
  if (!image) return undefined
  return board!.latestImages.find(
    (i) =>
      i.variant === 'installer' &&
      i.version === image.version &&
      (i.payloads ?? []).includes(image.image_id)
  )
}

export const installerKeyFor = (
  board: SupportedBoard | undefined,
  key: string | undefined
): string | undefined => {
  const installer = installerFor(board, key)
  return installer ? imageKey(installer) : undefined
}

export const defaultImageKey = (board: SupportedBoard | undefined): string | undefined => {
  const image = defaultImage(board?.latestImages)
  return image ? imageKey(image) : undefined
}

// The board a device file asks for: its board model; without one (today's
// .flock files carry only the architecture) the one board of that
// architecture, if there is exactly one. Otherwise the user chooses.
export const matchBoard = (
  boards: SupportedBoard[],
  config: { architecture?: string; board?: { model?: string } } | undefined
): SupportedBoard | undefined => {
  const model = config?.board?.model
  if (model) {
    const match = boards.find((b) => b.model === model)
    if (match) return match
  }
  const architecture = config?.architecture
  if (architecture) {
    const candidates = boards.filter((b) => b.architecture === architecture)
    if (candidates.length === 1) return candidates[0]
  }
  return undefined
}

// A device's choice after the catalog changed (a refresh brought a new
// release): the same board model and the same variant (by image_id) in the new
// catalog, else that board's default variant, and the installer stick if it
// was chosen and still carries the variant; no board if the catalog no longer
// lists the model.
export const rebindChoice = (
  boards: SupportedBoard[],
  board: SupportedBoard | undefined,
  key: string | undefined,
  useInstaller = false
): {
  board: SupportedBoard | undefined
  imageKey: string | undefined
  installerKey: string | undefined
} => {
  const next = board ? boards.find((b) => b.model === board.model) : undefined
  if (!next) return { board: undefined, imageKey: undefined, installerKey: undefined }
  const imageId = key?.split('@')[0]
  const image =
    variantImages(next).find((i) => i.image_id === imageId) ?? defaultImage(next.latestImages)
  const nextKey = image ? imageKey(image) : undefined
  return {
    board: next,
    imageKey: nextKey,
    installerKey: useInstaller ? installerKeyFor(next, nextKey) : undefined
  }
}

// The hardware menu shows the hardware only: the model name, with the
// architecture when another board has the same name.
export const hardwareTitle = (board: SupportedBoard, boards: SupportedBoard[]): string =>
  boards.some((b) => b.model !== board.model && b.modelname === board.modelname)
    ? `${board.modelname} (${board.architecture})`
    : board.modelname
