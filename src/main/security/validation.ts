// Pure validation helpers for data that crosses the renderer -> main IPC boundary
// or is parsed from untrusted .flock config files. Electron-free so it
// can be unit-tested. Even though the privileged sinks are now parameterized
// (no shell/code interpolation), these guards are defense-in-depth: they keep a
// malicious device path off a real disk and refuse a crafted device file at the
// IPC boundary.

// Matches any C0 control character (U+0000..U+001F).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F]/

/** A string usable as a single path segment: no separators, no traversal, no control chars. */
export const isSafePathSegment = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('/') || value.includes('\\')) return false
  if (value === '.' || value === '..') return false
  if (CONTROL_CHARS.test(value)) return false
  return true
}

/** Validate a block-device path the way each platform names it. */
export const isValidDevicePath = (
  devicePath: unknown,
  platform: NodeJS.Platform = process.platform
): devicePath is string => {
  if (typeof devicePath !== 'string' || devicePath.length === 0) return false
  if (CONTROL_CHARS.test(devicePath)) return false

  if (platform === 'win32') {
    // \\.\PhysicalDrive0 (drivelist / mountutils form) or a drive letter
    return /^\\\\[.?]\\[A-Za-z0-9]+$/.test(devicePath) || /^[A-Za-z]:\\?$/.test(devicePath)
  }

  // darwin: /dev/disk2 (or /dev/rdisk2); linux: /dev/sdb — restrict to /dev/*.
  return /^\/dev\/[A-Za-z0-9/]+$/.test(devicePath)
}

export const assertSafePathSegment = (value: unknown, label: string): string => {
  if (!isSafePathSegment(value)) {
    throw new Error(`Invalid ${label}: must be a single safe path segment`)
  }
  return value
}

export const assertValidDevicePath = (
  devicePath: unknown,
  platform: NodeJS.Platform = process.platform
): string => {
  if (!isValidDevicePath(devicePath, platform)) {
    throw new Error(`Invalid device path: ${String(devicePath)}`)
  }
  return devicePath
}

/** An https: URL is required for every remote artifact we download. */
export const isHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export const assertHttpsUrl = (value: unknown, label: string): string => {
  if (!isHttpsUrl(value)) {
    throw new Error(`Invalid ${label}: expected an https URL`)
  }
  return value as string
}

type MinimalImage = { file?: unknown; download?: unknown }
type MinimalConfig = {
  name?: unknown
  serial_number?: unknown
  board?: { latestImages?: MinimalImage[] }
}

/**
 * Validate the identifying fields of a parsed .flock config and the
 * images of the board it carries. Throws on the first offending field. (The
 * image to flash is resolved from the verified catalog, not from the config.)
 */
export const assertValidFlockConfig = (config: MinimalConfig): void => {
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid config: not an object')
  }

  // serial_number and name identify the device; neither may hold a path.
  assertSafePathSegment(config.serial_number, 'serial_number')
  assertSafePathSegment(config.name, 'device name')

  const images = config.board?.latestImages
  if (images && Array.isArray(images)) {
    for (const image of images) {
      // image.file is joined onto the ~/.Reflasher cache path.
      if (image.file !== undefined) assertSafePathSegment(image.file, 'image file name')
      // image.download is fetched over the network.
      if (image.download !== undefined) assertHttpsUrl(image.download, 'image download URL')
    }
  }
}

// <image_id>@<version> (imageKey in src/shared/images.ts): the only way a flash
// request names its image.
const IMAGE_KEY =
  /^flockos-[a-z0-9]+(-[a-z0-9]+)*@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/

export const isImageKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 256 && IMAGE_KEY.test(value)

const CONFIG_FILE = /[^\\/]\.flock$/i

type FlashRequest = {
  fullPath?: unknown
  flock?: {
    configPath?: unknown
    config?: MinimalConfig
    imageKey?: unknown
    installerKey?: unknown
  }
}

/**
 * Validate a flash request from the renderer: a device file (.flock),
 * the key of an IronFlockOS catalog image (the variant), and optionally the key of
 * the installer stick to write instead, which installs that variant. A request
 * cannot name a local image file, a path or a URL to write: the main process
 * resolves the keys against the verified catalog (CatalogStore.plan, which
 * also checks that the installer carries the variant), downloads the image and
 * checks it. Throws otherwise.
 */
export const assertFlashRequest = (
  request: unknown
): { configPath: string; imageKey: string; installerKey?: string } => {
  const item = (request && typeof request === 'object' ? request : {}) as FlashRequest
  const { fullPath, flock } = item
  if (
    typeof fullPath !== 'string' ||
    CONTROL_CHARS.test(fullPath) ||
    !CONFIG_FILE.test(fullPath) ||
    !flock ||
    typeof flock !== 'object' ||
    !flock.config ||
    (flock.configPath !== undefined && flock.configPath !== fullPath)
  ) {
    throw new Error('Only a device file (.flock) can be flashed, with an IronFlockOS image')
  }
  if (!isImageKey(flock.imageKey)) {
    throw new Error('No IronFlockOS image chosen: choose the hardware and an IronFlockOS variant')
  }
  const installerKey = flock.installerKey
  if (installerKey !== undefined && !isImageKey(installerKey)) {
    throw new Error('Invalid installer stick choice')
  }
  assertValidFlockConfig(flock.config)
  return { configPath: fullPath, imageKey: flock.imageKey, installerKey }
}
