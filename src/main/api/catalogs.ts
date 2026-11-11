import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BoardCatalogs, ImageInfo } from '../../types'
import {
  CatalogError,
  IRONFLOCKOS_CATALOG_PUBLIC_KEYS,
  IRONFLOCKOS_MANIFEST_URL,
  IronFlockOSCatalog,
  MAX_ENVELOPE_BYTES,
  TrustedKey,
  assertNotOlder,
  openCatalog,
  parsePublicKeys
} from '../security/catalog'
import { imageKey } from '../../shared/images'

// The boards FlockFlasher offers: those of the signed IronFlockOS catalog, fetched
// and verified on every start. The main process keeps the verified catalog and
// resolves the image to flash from it, so a download URL or digest never comes
// from the renderer or a .flock file. Electron-free (the cache directory and
// fetch are passed in), so it is unit-tested.

// The verified envelope of the catalog last accepted: used when the network is
// unreachable, and the reference for the rollback check.
export const IRONFLOCKOS_CATALOG_CACHE_FILE = 'ironflockos-manifest.json'

// A failure to reach the catalog, as opposed to a catalog that was reached and
// refused. Only the former falls back to the verified cache.
export class CatalogUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogUnreachableError'
  }
}

// Fetches at most `max` bytes; more is refused as a CatalogError ('oversize').
export const fetchCapped = async (
  url: string,
  max: number,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 30_000
): Promise<Buffer> => {
  let response: Response
  try {
    response = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new CatalogUnreachableError(`Cannot reach ${url}: ${(error as Error)?.message ?? error}`)
  }
  if (!response.ok) {
    throw new CatalogUnreachableError(`Cannot fetch ${url}: HTTP ${response.status}`)
  }
  const oversize = () =>
    new CatalogError('oversize', `The catalog is larger than the ${max} bytes accepted`)
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined)
    throw oversize()
  }
  if (!response.body) return Buffer.alloc(0)

  const chunks: Buffer[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) {
        await reader.cancel().catch(() => undefined)
        throw oversize()
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    if (error instanceof CatalogError) throw error
    throw new CatalogUnreachableError(`Cannot read ${url}: ${(error as Error)?.message ?? error}`)
  }
  return Buffer.concat(chunks)
}

export type IronFlockOSCatalogResult = { catalog: IronFlockOSCatalog; fromCache: boolean }

// Fetches, verifies and caches the IronFlockOS catalog. A document that is reached
// but does not verify (unsigned, tampered, wrong key, oversize, not JSON, an
// invalid payload, older than the one accepted last) is refused with a
// CatalogError and never replaced by the cache; only an unreachable catalog
// falls back to the verified cache. `accepted` is the catalog in use, if any.
export const loadIronFlockOSCatalog = async (opts: {
  cacheDir: string
  keys: TrustedKey[]
  url?: string
  fetchFn?: typeof fetch
  accepted?: IronFlockOSCatalog
}): Promise<IronFlockOSCatalogResult> => {
  const cachePath = path.join(opts.cacheDir, IRONFLOCKOS_CATALOG_CACHE_FILE)

  let cached: IronFlockOSCatalog | undefined
  try {
    cached = openCatalog(await readFile(cachePath), opts.keys)
  } catch {
    // No cache, or one that no longer verifies (a rotated key): ignore it.
  }
  // The catalog accepted last: the cache, or a newer one in use (if caching it failed).
  const accepted =
    opts.accepted && (!cached || opts.accepted.issuedAtMs > cached.issuedAtMs)
      ? opts.accepted
      : cached

  let data: Buffer
  try {
    data = await fetchCapped(opts.url ?? IRONFLOCKOS_MANIFEST_URL, MAX_ENVELOPE_BYTES, opts.fetchFn)
  } catch (error) {
    if (error instanceof CatalogUnreachableError && accepted) {
      console.warn(`${error.message}; using the catalog issued at ${accepted.issuedAt}`)
      return { catalog: accepted, fromCache: true }
    }
    throw error
  }

  const catalog = openCatalog(data, opts.keys)
  assertNotOlder(catalog, accepted)

  try {
    await mkdir(opts.cacheDir, { recursive: true })
    await writeFile(`${cachePath}.part`, data)
    await rename(`${cachePath}.part`, cachePath)
  } catch (error) {
    console.error('Could not cache the IronFlockOS catalog:', error)
  }
  return { catalog, fromCache: false }
}

// ------------------------------------------------------------- resolution --

// What a flash writes: the variant's image, or the installer stick that
// carries it, with the variant as the stick's payload (installer.conf).
export type FlashPlan = { write: ImageInfo; payload?: ImageInfo }

// An installer stick installs only an image it carries (its payloads, from the
// verified catalog) of its own release.
export const assertInstallerCarries = (installer: ImageInfo, payload: ImageInfo): void => {
  if (installer.variant !== 'installer') {
    throw new Error(`${installer.image_id} is not an installer stick`)
  }
  if (
    payload.variant === 'installer' ||
    payload.version !== installer.version ||
    !(installer.payloads ?? []).includes(payload.image_id)
  ) {
    throw new Error(
      `The installer stick ${installer.image_id} ${installer.version} does not carry ${payload.image_id} ${payload.version}`
    )
  }
}

// How often showing the board list fetches the catalog again, so a release
// published while the app is open appears without a restart.
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000

export class CatalogStore {
  private keys: TrustedKey[] | undefined
  private keysError: CatalogError | undefined
  // the last verified catalog, kept when a later refresh fails
  private ironflockos: IronFlockOSCatalog | undefined
  private inFlight: Promise<BoardCatalogs> | undefined
  private lastAttemptAt: number | undefined
  private lastResult: BoardCatalogs | undefined
  private readonly now: () => number

  constructor(
    private readonly opts: {
      cacheDir: string
      keyList?: string
      url?: string
      fetchFn?: typeof fetch
      now?: () => number
    }
  ) {
    this.now = opts.now ?? Date.now
    try {
      this.keys = parsePublicKeys(opts.keyList ?? IRONFLOCKOS_CATALOG_PUBLIC_KEYS)
    } catch (error) {
      this.keysError = error as CatalogError
    }
  }

  // Loads the catalog unless the last load started less than
  // REFRESH_INTERVAL_MS ago, in which case its result is returned; `force` (an
  // explicit retry) loads anyway. A call during a load joins it.
  refresh(opts: { force?: boolean } = {}): Promise<BoardCatalogs> {
    if (this.inFlight) return this.inFlight
    const fresh =
      this.lastResult !== undefined &&
      this.lastAttemptAt !== undefined &&
      this.now() - this.lastAttemptAt < REFRESH_INTERVAL_MS
    if (fresh && !opts.force) return Promise.resolve(this.lastResult!)
    return this.load()
  }

  // Loads the catalog now; a call during a load joins it.
  load(): Promise<BoardCatalogs> {
    this.inFlight ??= (async () => {
      this.lastAttemptAt = this.now()
      this.lastResult = await this.doLoad()
      return this.lastResult
    })().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async doLoad(): Promise<BoardCatalogs> {
    try {
      if (!this.keys) throw this.keysError
      const { catalog, fromCache } = await loadIronFlockOSCatalog({
        cacheDir: this.opts.cacheDir,
        keys: this.keys,
        url: this.opts.url,
        fetchFn: this.opts.fetchFn,
        accepted: this.ironflockos
      })
      this.ironflockos = catalog
      console.log(
        `IronFlockOS catalog issued at ${catalog.issuedAt}, production ${catalog.production}, key ${catalog.keyId}`
      )
      return {
        // in the catalog's order (amd64-efi first)
        boards: catalog.boards,
        ironflockos: {
          ok: true,
          production: catalog.production,
          issuedAt: catalog.issuedAt,
          fromCache
        }
      }
    } catch (error) {
      const code = error instanceof CatalogError ? error.code : 'unreachable'
      const message = (error as Error)?.message ?? String(error)
      console.error(`IronFlockOS catalog refused (${code}): ${message}`)
      // A failed refresh keeps the boards verified before, with the error.
      const kept = this.ironflockos
      return {
        boards: kept?.boards ?? [],
        ironflockos: {
          ok: false,
          code,
          error: message,
          ...(kept ? { kept: { production: kept.production, issuedAt: kept.issuedAt } } : {})
        }
      }
    }
  }

  // The image an imageKey names, from the verified catalog; anything else is
  // refused.
  async resolve(key: unknown): Promise<ImageInfo> {
    if (typeof key !== 'string' || key.length === 0 || key.length > 512) {
      throw new Error('No image chosen: choose a board and an OS image')
    }
    // Not loaded yet, or never verified: try once more.
    if (!this.ironflockos) await this.load()
    if (!this.ironflockos) {
      throw new Error(
        'The IronFlockOS catalog is not available (it did not verify or could not be fetched)'
      )
    }
    const image = this.ironflockos.boards
      .flatMap((b) => b.latestImages)
      .find((i) => imageKey(i) === key)
    if (!image) throw new Error(`${key} is not in the signed IronFlockOS catalog`)
    return image
  }

  // The flash a request asks for: the variant `key`, written directly or, with
  // `installerKey`, through that installer stick, which must carry it.
  async plan(key: unknown, installerKey?: unknown): Promise<FlashPlan> {
    const image = await this.resolve(key)
    if (image.variant === 'installer') {
      throw new Error('The installer stick is a way to install a variant, not a variant')
    }
    if (installerKey === undefined) return { write: image }
    const installer = await this.resolve(installerKey)
    assertInstallerCarries(installer, image)
    return { write: installer, payload: image }
  }
}
