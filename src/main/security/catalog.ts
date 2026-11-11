import { KeyObject, createHash, createPublicKey, verify } from 'node:crypto'
import type { ImageInfo, ImageKernel, ImageVariant, SupportedBoard } from '../../types'
import { isHttpsUrl, isSafePathSegment } from './validation'

// The signed IronFlockOS catalog, dl/ironflockos/manifest.json (IronFlockOS ADR-0009,
// docs/manifest.schema.json in IronFlock/ironflockos). It is published as the
// device-agent's envelope (device-agent src/updatesig):
//
//   {"payload": "<standard base64 of the payload JSON>",
//    "signature": "<standard base64 of a 64-byte Ed25519 signature>"}
//
// at most 64 KiB, the signature over the ASCII lines
//
//   ironflockos-manifest:v1
//   ironflockos/manifest.json
//   <lowercase hex SHA-256 of the decoded payload>
//
// joined by "\n", no trailing newline. Nothing in an envelope that does not
// verify is ever used. Electron-free, so it is unit-tested.

export const IRONFLOCKOS_MANIFEST_URL =
  'https://instance-registry.ironflock.com/dl/ironflockos/manifest.json'
export const CATALOG_CONTEXT = 'ironflockos-manifest:v1'
export const CATALOG_SUBJECT = 'ironflockos/manifest.json'
export const MAX_ENVELOPE_BYTES = 64 * 1024

// The keys the catalog may be signed with, in the device-agent's format
// (IRONFLOCKOS_CATALOG_PUBLIC_KEYS in device-agent src/osupdate/catalog.go): one
// standard base64 raw 32-byte Ed25519 key per line, "#" starts a comment.
//
// The line below is the Cloud KMS key ironflock-release/ironflockos-catalog,
// version 1 (pki/ironflockos-catalog.pub in IronFlock/ironflockos is its PEM
// form). Rotation: a FlockFlasher release that lists both the old and the new
// key ships before IronFlockOS signs with the new one; the old line goes in a
// later release.
export const IRONFLOCKOS_CATALOG_PUBLIC_KEYS = `
+OG0Ylau0tkCKEDT+WGc9RYHOa9VCSxiOGBBTp7IEQc= # key 036ef3bd, Cloud KMS ironflock-release/ironflockos-catalog v1
`

export type CatalogErrorCode =
  'no-keys' | 'oversize' | 'malformed' | 'unsigned' | 'bad-signature' | 'invalid' | 'rollback'

export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CatalogError'
  }
}

export type TrustedKey = { id: string; key: KeyObject }

// DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the raw key follows.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const ED25519_KEY_BYTES = 32
const ED25519_SIGNATURE_BYTES = 64

// Standard alphabet, padded, canonical (re-encoding gives the same text).
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export const decodeBase64Strict = (value: string): Buffer | undefined => {
  if (!BASE64.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64') === value ? decoded : undefined
}

// The first 8 hex characters of the SHA-256 of the raw key, as the agent names keys.
export const keyId = (raw: Buffer): string =>
  createHash('sha256').update(raw).digest('hex').slice(0, 8)

// All or nothing, like the agent: one bad line rejects the list, so a typo can
// never quietly trust fewer keys.
export const parsePublicKeys = (list: string): TrustedKey[] => {
  const keys: TrustedKey[] = []
  list.split('\n').forEach((line, index) => {
    const text = line.replace(/#.*$/, '').trim()
    if (text === '') return
    const raw = decodeBase64Strict(text)
    if (!raw || raw.length !== ED25519_KEY_BYTES) {
      throw new CatalogError(
        'no-keys',
        `Catalog key line ${index + 1} is not a base64 ${ED25519_KEY_BYTES}-byte Ed25519 key`
      )
    }
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki'
    })
    keys.push({ id: keyId(raw), key })
  })
  if (keys.length === 0)
    throw new CatalogError('no-keys', 'No IronFlockOS catalog key is configured')
  return keys
}

// The bytes the signature covers.
export const catalogMessage = (payload: Buffer): Buffer =>
  Buffer.from(
    `${CATALOG_CONTEXT}\n${CATALOG_SUBJECT}\n${createHash('sha256').update(payload).digest('hex')}`,
    'utf8'
  )

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Verifies an envelope and returns its payload bytes and the id of the key
// that signed it. Throws a CatalogError otherwise.
export const openEnvelope = (
  data: Buffer,
  keys: TrustedKey[]
): { payload: Buffer; keyId: string } => {
  if (keys.length === 0)
    throw new CatalogError('no-keys', 'No IronFlockOS catalog key is configured')
  if (data.length > MAX_ENVELOPE_BYTES) {
    throw new CatalogError(
      'oversize',
      `The catalog is ${data.length} bytes; at most ${MAX_ENVELOPE_BYTES} are accepted`
    )
  }

  let envelope: unknown
  try {
    envelope = JSON.parse(data.toString('utf8'))
  } catch {
    throw new CatalogError('malformed', 'The catalog is not JSON')
  }
  if (!isPlainObject(envelope)) {
    throw new CatalogError('malformed', 'The catalog is not a signed envelope')
  }
  if (typeof envelope.signature !== 'string' || envelope.signature.trim() === '') {
    throw new CatalogError('unsigned', 'The catalog carries no signature')
  }
  if (typeof envelope.payload !== 'string') {
    throw new CatalogError('malformed', 'The catalog envelope has no payload')
  }

  const payload = decodeBase64Strict(envelope.payload)
  if (!payload) throw new CatalogError('malformed', 'The catalog payload is not base64')
  const signature = decodeBase64Strict(envelope.signature.trim())
  if (!signature || signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new CatalogError('malformed', 'The catalog signature is not base64 of 64 bytes')
  }

  const message = catalogMessage(payload)
  for (const { id, key } of keys) {
    if (verify(null, message, key, signature)) return { payload, keyId: id }
  }
  throw new CatalogError(
    'bad-signature',
    'The catalog signature does not verify against any trusted key'
  )
}

// ---------------------------------------------------------------- payload --

export type IronFlockOSCatalog = {
  keyId: string
  issuedAt: string
  issuedAtMs: number
  production: string
  test?: string
  boards: SupportedBoard[]
}

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const IMAGE_ID = /^ironflockos-[a-z0-9]+(-[a-z0-9]+)*$/
// schema 1: <image-id>-<version>.img.gz
const IMAGE_FILE = /\.img\.gz$/
const VARIANTS: readonly string[] = ['base', 'nvidia', 'installer']
const KERNELS: readonly string[] = ['std', 'rt']
const ARCHITECTURES: readonly string[] = ['amd64', 'arm64']

// An image of a variant, kernel or architecture this FlockFlasher does not know
// (from a newer release) is skipped with a log line, not a reason to refuse the
// catalog, so an older FlockFlasher keeps offering what it can write.
const unknownPart = (variant: string, kernel: string, architecture: string): string | undefined => {
  if (!VARIANTS.includes(variant)) return `variant ${variant}`
  if (!KERNELS.includes(kernel)) return `kernel ${kernel}`
  if (!ARCHITECTURES.includes(architecture)) return `architecture ${architecture}`
  return undefined
}

const skip = (what: string, reason: string) =>
  console.warn(`IronFlockOS catalog: skipping ${what}: ${reason} is unknown to this FlockFlasher`)

const invalid = (message: string) =>
  new CatalogError('invalid', `Invalid IronFlockOS catalog: ${message}`)

const requireString = (value: unknown, label: string, allowEmpty = false): string => {
  if (typeof value !== 'string' || (!allowEmpty && value === ''))
    throw invalid(`${label} is not a string`)
  return value
}

const requireVersion = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !VERSION.test(value)) throw invalid(`${label} is not a version`)
  return value
}

const requireSize = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalid(`${label} is not a positive integer`)
  }
  return value
}

type Artifact = { url: string; sha256: string; size: number }
type ReleaseImage = {
  target: string
  variant: string
  kernel: string
  image: Artifact
  // installer images only: the ids of the images the stick carries
  payloads?: string[]
}

// An installer stick carries images of its release and target (schema 1:
// `payloads`, both on the release image and on the board's entry for it). A
// catalog without it (v0.10.0) means the target's base image, which is what
// those sticks carry. Ids that are not images of the release and target are
// dropped with a log line.
const parsePayloads = (
  raw: unknown,
  label: string,
  target: string,
  images: Map<string, ReleaseImage>
): string[] => {
  const list = raw === undefined ? [`ironflockos-${target}-base`] : raw
  if (!Array.isArray(list) || list.some((id) => typeof id !== 'string')) {
    throw invalid(`${label}.payloads is not a list of image ids`)
  }
  const payloads: string[] = []
  for (const id of list as string[]) {
    const image = images.get(id)
    if (!image || image.variant === 'installer' || image.target !== target) {
      console.warn(
        `IronFlockOS catalog: dropping payload ${id} of ${label}: not an image of target ${target} in the release`
      )
    } else if (!payloads.includes(id)) {
      payloads.push(id)
    }
  }
  return payloads
}

const parseArtifact = (value: unknown, label: string): Artifact => {
  if (!isPlainObject(value)) throw invalid(`${label} is not an object`)
  if (!isHttpsUrl(value.url)) throw invalid(`${label}.url is not an https URL`)
  if (typeof value.sha256 !== 'string' || !SHA256_HEX.test(value.sha256)) {
    throw invalid(`${label}.sha256 is not a SHA-256 hex digest`)
  }
  return { url: value.url, sha256: value.sha256, size: requireSize(value.size, `${label}.size`) }
}

// releases[version].images[image_id], the source of truth the boards view must agree with.
const parseReleases = (value: unknown): Map<string, Map<string, ReleaseImage>> => {
  if (!isPlainObject(value)) throw invalid('releases is not an object')
  const releases = new Map<string, Map<string, ReleaseImage>>()
  for (const [version, release] of Object.entries(value)) {
    requireVersion(version, `release ${version}`)
    if (!isPlainObject(release) || !isPlainObject(release.images)) {
      throw invalid(`release ${version} has no images`)
    }
    const images = new Map<string, ReleaseImage>()
    const rawPayloads = new Map<string, unknown>()
    for (const [id, entry] of Object.entries(release.images)) {
      if (!IMAGE_ID.test(id)) throw invalid(`release ${version} names image ${id}`)
      if (!isPlainObject(entry)) throw invalid(`image ${id} of ${version} is not an object`)
      const variant = requireString(entry.variant, `${id}.variant`)
      const kernel = requireString(entry.kernel, `${id}.kernel`)
      const architecture = requireString(entry.architecture, `${id}.architecture`)
      const unknown = unknownPart(variant, kernel, architecture)
      if (unknown) {
        skip(`image ${id} of ${version}`, unknown)
        continue
      }
      const target = requireString(entry.target, `${id}.target`)
      images.set(id, { target, variant, kernel, image: parseArtifact(entry.image, `${id}.image`) })
      if (variant === 'installer') rawPayloads.set(id, entry.payloads)
    }
    for (const [id, raw] of rawPayloads) {
      const installer = images.get(id)!
      installer.payloads = parsePayloads(raw, `${id} ${version}`, installer.target, images)
    }
    releases.set(version, images)
  }
  return releases
}

const lastPathSegment = (url: string): string => {
  const segments = new URL(url).pathname.split('/')
  try {
    return decodeURIComponent(segments[segments.length - 1] ?? '')
  } catch {
    return ''
  }
}

// A board image, or undefined for one this FlockFlasher does not know.
const parseImage = (
  value: unknown,
  label: string,
  architecture: string,
  releases: Map<string, Map<string, ReleaseImage>>
): ImageInfo | undefined => {
  if (!isPlainObject(value)) throw invalid(`${label} is not an object`)
  const variant = requireString(value.variant, `${label}.variant`)
  const kernel = requireString(value.kernel, `${label}.kernel`)
  const unknown = unknownPart(variant, kernel, architecture)
  if (unknown) {
    skip(`${label} (${String(value.image_id)})`, unknown)
    return undefined
  }
  const download = value.download
  if (!isHttpsUrl(download)) throw invalid(`${label}.download is not an https URL`)
  const file = value.file
  if (!isSafePathSegment(file) || !IMAGE_FILE.test(file) || lastPathSegment(download) !== file) {
    throw invalid(`${label}.file is not the .img.gz that download names`)
  }
  if (typeof value.sha256 !== 'string' || !SHA256_HEX.test(value.sha256)) {
    throw invalid(`${label}.sha256 is not a SHA-256 hex digest`)
  }
  if (value.osvariant !== 'image') throw invalid(`${label}.osvariant is not "image"`)
  const imageId = requireString(value.image_id, `${label}.image_id`)
  if (!IMAGE_ID.test(imageId)) throw invalid(`${label}.image_id is not an IronFlockOS image id`)
  const update = requireString(value.update ?? '', `${label}.update`, true)
  if (update !== '' && !isHttpsUrl(update)) throw invalid(`${label}.update is not an https URL`)

  const image: ImageInfo = {
    buildtime: requireString(value.buildtime, `${label}.buildtime`),
    download,
    file,
    osname: requireString(value.osname, `${label}.osname`),
    osvariant: 'image',
    sha256: value.sha256,
    size: requireSize(value.size, `${label}.size`),
    update,
    version: requireVersion(value.version, `${label}.version`),
    image_id: imageId,
    variant: variant as ImageVariant,
    kernel: kernel as ImageKernel
  }

  // The boards view is a view of a listed release: the same file, digest and
  // size, the same variant and kernel. Disagreement is a broken release, and so
  // is a known board image whose release entry was skipped as unknown.
  const listed = releases.get(image.version)?.get(imageId)
  if (
    !listed ||
    listed.image.url !== image.download ||
    listed.image.sha256 !== image.sha256 ||
    listed.image.size !== image.size ||
    listed.variant !== image.variant ||
    listed.kernel !== image.kernel
  ) {
    throw invalid(`${label} (${imageId} ${image.version}) does not match the release it belongs to`)
  }

  if (variant === 'installer') {
    // The board's view of what the stick carries must be the release's.
    const payloads = listed.payloads ?? []
    if (value.payloads !== undefined) {
      const images = releases.get(image.version)!
      const board = parsePayloads(value.payloads, `${label} (${imageId})`, listed.target, images)
      if (board.length !== payloads.length || board.some((id) => !payloads.includes(id))) {
        throw invalid(`${label} (${imageId}) carries other payloads than its release says`)
      }
    }
    image.payloads = payloads
  }
  return image
}

// A board with the images this FlockFlasher knows, or undefined (hidden) when
// it knows none of them.
const parseBoard = (
  value: unknown,
  index: number,
  releases: Map<string, Map<string, ReleaseImage>>
): SupportedBoard | undefined => {
  const label = `boards[${index}]`
  if (!isPlainObject(value)) throw invalid(`${label} is not an object`)
  if (!Array.isArray(value.latestImages) || value.latestImages.length === 0) {
    throw invalid(`${label} lists no images`)
  }
  const architecture = requireString(value.architecture, `${label}.architecture`)
  const latestImages = value.latestImages
    .map((image, i) => parseImage(image, `${label}.latestImages[${i}]`, architecture, releases))
    .filter((image): image is ImageInfo => image !== undefined)
  if (latestImages.length === 0) {
    console.warn(
      `IronFlockOS catalog: hiding ${label} (${String(value.model)}): no image this FlockFlasher knows`
    )
    return undefined
  }
  return {
    architecture,
    board: requireString(value.board, `${label}.board`),
    boardname: requireString(value.boardname, `${label}.boardname`),
    cpu: requireString(value.cpu, `${label}.cpu`, true),
    docs: requireString(value.docs ?? '', `${label}.docs`, true),
    reflasher: value.reflasher === true,
    model: requireString(value.model, `${label}.model`),
    modelname: requireString(value.modelname, `${label}.modelname`),
    latestImages
  }
}

// Parses a verified payload (schema 1). Fields it does not know are ignored,
// and so are images of a variant, kernel or architecture it does not know (a
// board left without images is hidden); fields it uses must be well-formed,
// and a known board image must match its release, or the whole catalog is
// refused.
export const parseCatalogPayload = (payload: Buffer): Omit<IronFlockOSCatalog, 'keyId'> => {
  let doc: unknown
  try {
    doc = JSON.parse(payload.toString('utf8'))
  } catch {
    throw invalid('the payload is not JSON')
  }
  if (!isPlainObject(doc)) throw invalid('the payload is not an object')
  if (doc.schema !== 1)
    throw invalid(`schema ${String(doc.schema)}; this FlockFlasher reads schema 1`)

  const issuedAt = doc.issued_at
  const issuedAtMs =
    typeof issuedAt === 'string' && TIME.test(issuedAt) ? Date.parse(issuedAt) : NaN
  if (typeof issuedAt !== 'string' || !Number.isFinite(issuedAtMs))
    throw invalid('issued_at is not a UTC time')

  if (!isPlainObject(doc.channels)) throw invalid('channels is not an object')
  const production = requireVersion(doc.channels.production, 'channels.production')
  const test =
    doc.channels.test === undefined ? undefined : requireVersion(doc.channels.test, 'channels.test')

  const releases = parseReleases(doc.releases)
  for (const version of [production, test]) {
    if (version !== undefined && !releases.has(version)) {
      throw invalid(`a channel names ${version}, which releases does not list`)
    }
  }

  if (!Array.isArray(doc.boards)) throw invalid('boards is not a list')
  const boards = doc.boards
    .map((board, index) => parseBoard(board, index, releases))
    .filter((board): board is SupportedBoard => board !== undefined)

  return { issuedAt, issuedAtMs, production, test, boards }
}

// Verifies and parses a published catalog.
export const openCatalog = (data: Buffer, keys: TrustedKey[]): IronFlockOSCatalog => {
  const { payload, keyId } = openEnvelope(data, keys)
  return { keyId, ...parseCatalogPayload(payload) }
}

// A reader refuses a catalog older than the one it last accepted (ADR-0009),
// so a mirror cannot roll the flasher back to an older signed release.
export const assertNotOlder = (
  next: IronFlockOSCatalog,
  accepted: IronFlockOSCatalog | undefined
): void => {
  if (accepted && next.issuedAtMs < accepted.issuedAtMs) {
    throw new CatalogError(
      'rollback',
      `The catalog was issued at ${next.issuedAt}, before the one accepted last (${accepted.issuedAt})`
    )
  }
}
