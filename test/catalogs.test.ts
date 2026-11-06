import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeyPairSync, sign } from 'node:crypto'
import {
  CatalogStore,
  CatalogUnreachableError,
  assertInstallerCarries,
  FLOCKOS_CATALOG_CACHE_FILE,
  REFRESH_INTERVAL_MS,
  fetchCapped,
  loadFlockOSCatalog
} from '../src/main/api/catalogs'
import {
  CatalogError,
  FLOCKOS_CATALOG_PUBLIC_KEYS,
  MAX_ENVELOPE_BYTES,
  catalogMessage,
  parsePublicKeys
} from '../src/main/security/catalog'

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const ENVELOPE = readFileSync(here('./fixtures/flockos/manifest.json'))
const PAYLOAD = readFileSync(here('./fixtures/flockos/payload.json'))

const respond = (body: BodyInit | null, init?: ResponseInit) =>
  vi.fn(async () => new Response(body, init)) as unknown as typeof fetch
const unreachable = () =>
  vi.fn(async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch

// A catalog signed with a throwaway key that the store also trusts.
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const TEST_KEY_LINE = publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(12)
  .toString('base64')
const KEY_LIST = `${FLOCKOS_CATALOG_PUBLIC_KEYS}\n${TEST_KEY_LINE}\n`
const KEYS = parsePublicKeys(KEY_LIST)
const sealWithTestKey = (change: (doc: any) => void) => {
  const doc = JSON.parse(PAYLOAD.toString())
  change(doc)
  const payload = Buffer.from(JSON.stringify(doc))
  return Buffer.from(
    JSON.stringify({
      payload: payload.toString('base64'),
      signature: sign(null, catalogMessage(payload), privateKey).toString('base64')
    })
  )
}
const tamperedEnvelope = () => {
  const envelope = JSON.parse(ENVELOPE.toString())
  envelope.payload = Buffer.from(PAYLOAD.toString().replace('"0.10.0"', '"0.10.1"')).toString(
    'base64'
  )
  return Buffer.from(JSON.stringify(envelope))
}

let cacheDir: string
const cachePath = () => path.join(cacheDir, FLOCKOS_CATALOG_CACHE_FILE)

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'ff-catalog-'))
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(cacheDir, { recursive: true, force: true })
})

describe('fetchCapped', () => {
  it('returns the body', async () => {
    const body = await fetchCapped('https://x/m.json', MAX_ENVELOPE_BYTES, respond(ENVELOPE))
    expect(body.equals(ENVELOPE)).toBe(true)
  })

  it('refuses a declared or streamed body over the cap as oversize', async () => {
    const declared = respond('{}', {
      headers: { 'content-length': String(MAX_ENVELOPE_BYTES + 1) }
    })
    await expect(fetchCapped('https://x', MAX_ENVELOPE_BYTES, declared)).rejects.toMatchObject({
      code: 'oversize'
    })
    const streamed = respond(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(20 * 1024))
          controller.close()
        }
      })
    )
    await expect(fetchCapped('https://x', MAX_ENVELOPE_BYTES, streamed)).rejects.toBeInstanceOf(
      CatalogError
    )
  })

  it('reports network and HTTP failures as unreachable', async () => {
    await expect(fetchCapped('https://x', 10, unreachable())).rejects.toBeInstanceOf(
      CatalogUnreachableError
    )
    await expect(
      fetchCapped('https://x', 10, respond('no', { status: 503 }))
    ).rejects.toBeInstanceOf(CatalogUnreachableError)
  })
})

describe('loadFlockOSCatalog', () => {
  it('verifies the fetched catalog and caches it', async () => {
    const { catalog, fromCache } = await loadFlockOSCatalog({
      cacheDir,
      keys: KEYS,
      fetchFn: respond(ENVELOPE)
    })
    expect(fromCache).toBe(false)
    expect(catalog.production).toBe('0.10.0')
    expect((await readFile(cachePath())).equals(ENVELOPE)).toBe(true)
  })

  it('uses the verified cache only when the catalog cannot be reached', async () => {
    await writeFile(cachePath(), ENVELOPE)
    const { catalog, fromCache } = await loadFlockOSCatalog({
      cacheDir,
      keys: KEYS,
      fetchFn: unreachable()
    })
    expect(fromCache).toBe(true)
    expect(catalog.production).toBe('0.10.0')
  })

  it('never falls back to the cache for a tampered or unsigned catalog', async () => {
    await writeFile(cachePath(), ENVELOPE)
    await expect(
      loadFlockOSCatalog({ cacheDir, keys: KEYS, fetchFn: respond(tamperedEnvelope()) })
    ).rejects.toMatchObject({ code: 'bad-signature' })
    await expect(
      loadFlockOSCatalog({ cacheDir, keys: KEYS, fetchFn: respond(PAYLOAD) })
    ).rejects.toMatchObject({ code: 'unsigned' })
    // the cache is left as it was
    expect((await readFile(cachePath())).equals(ENVELOPE)).toBe(true)
  })

  it('ignores a cache that does not verify', async () => {
    await writeFile(cachePath(), tamperedEnvelope())
    await expect(
      loadFlockOSCatalog({ cacheDir, keys: KEYS, fetchFn: unreachable() })
    ).rejects.toBeInstanceOf(CatalogUnreachableError)
  })

  it('refuses a catalog older than the cached one (rollback)', async () => {
    await writeFile(
      cachePath(),
      sealWithTestKey((d) => (d.issued_at = '2026-12-01T00:00:00Z'))
    )
    await expect(
      loadFlockOSCatalog({ cacheDir, keys: KEYS, fetchFn: respond(ENVELOPE) })
    ).rejects.toMatchObject({ code: 'rollback' })
  })
})

describe('CatalogStore', () => {
  const store = (fetchFn: typeof fetch) =>
    new CatalogStore({ cacheDir, keyList: KEY_LIST, fetchFn })

  it('offers the boards of the verified catalog only, in its order', async () => {
    const result = await store(respond(ENVELOPE)).load()
    expect(result.flockos).toMatchObject({ ok: true, production: '0.10.0', fromCache: false })
    expect(result.boards.map((b) => b.model)).toEqual([
      'amd64-efi',
      'arm64-efi',
      'raspberrypi4',
      'raspberrypi5'
    ])
  })

  it('offers no board, and an error, for a catalog that does not verify', async () => {
    const s = store(respond(tamperedEnvelope()))
    const result = await s.load()
    expect(result.flockos).toMatchObject({ ok: false, code: 'bad-signature' })
    expect(result.boards).toEqual([])
    await expect(s.resolve('flockos-amd64-efi-base@0.10.0')).rejects.toThrow(/not available/)
  })

  it('resolves an image key from the verified catalog only', async () => {
    const s = store(respond(ENVELOPE))
    await s.load()
    const image = await s.resolve('flockos-amd64-efi-nvidia@0.10.0')
    expect(image.sha256).toBe('05d2f330a2a1a826244eaf61a09e12cabd6ee7fedc9cc03957efd4dc8ea2b6d7')
    await expect(s.resolve('flockos-amd64-efi-base@0.9.0')).rejects.toThrow(
      /not in the signed FlockOS catalog/
    )
    await expect(s.resolve('flockos-raspberrypi4-base-0.10.0.img.gz')).rejects.toThrow(
      /not in the signed FlockOS catalog/
    )
    await expect(s.resolve('https://evil/x.img.gz')).rejects.toThrow(/not in the signed/)
    await expect(s.resolve(undefined)).rejects.toThrow(/choose a board/)
  })

  it('loads the catalog on demand for a flash before the board list', async () => {
    const fetchFn = respond(ENVELOPE)
    const image = await store(fetchFn).resolve('flockos-rpi-arm64-base@0.10.0')
    expect(image.file).toBe('flockos-rpi-arm64-base-0.10.0.img.gz')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})

describe('CatalogStore.refresh', () => {
  const counting = (bodies: () => Buffer) =>
    vi.fn(async () => new Response(bodies())) as unknown as typeof fetch & {
      mock: { calls: unknown[] }
    }

  it('fetches again only after 5 minutes, or at once on a retry', async () => {
    let now = 1_000_000
    const fetchFn = counting(() => ENVELOPE)
    const s = new CatalogStore({ cacheDir, keyList: KEY_LIST, fetchFn, now: () => now })
    await s.refresh()
    expect(fetchFn.mock.calls).toHaveLength(1)
    now += REFRESH_INTERVAL_MS - 1
    expect((await s.refresh()).flockos).toMatchObject({ ok: true })
    expect(fetchFn.mock.calls).toHaveLength(1)
    await s.refresh({ force: true })
    expect(fetchFn.mock.calls).toHaveLength(2)
    now += REFRESH_INTERVAL_MS
    await s.refresh()
    expect(fetchFn.mock.calls).toHaveLength(3)
  })

  it('joins a load in flight', async () => {
    const fetchFn = counting(() => ENVELOPE)
    const s = new CatalogStore({ cacheDir, keyList: KEY_LIST, fetchFn })
    await Promise.all([s.refresh(), s.refresh(), s.refresh({ force: true }), s.load()])
    expect(fetchFn.mock.calls).toHaveLength(1)
  })

  it('keeps the last verified boards when a refresh fails, and flashes from them', async () => {
    let now = 0
    let body = ENVELOPE
    const s = new CatalogStore({
      cacheDir,
      keyList: KEY_LIST,
      fetchFn: counting(() => body),
      now: () => now
    })
    await s.refresh()
    body = tamperedEnvelope()
    now += REFRESH_INTERVAL_MS
    const result = await s.refresh()
    expect(result.flockos).toEqual({
      ok: false,
      code: 'bad-signature',
      error: expect.any(String),
      kept: { production: '0.10.0', issuedAt: '2026-11-06T00:18:10Z' }
    })
    expect(result.boards.map((b) => b.model)).toHaveLength(4)
    await expect(s.resolve('flockos-amd64-efi-base@0.10.0')).resolves.toMatchObject({
      image_id: 'flockos-amd64-efi-base'
    })
  })

  it('picks up a release published while running, and refuses an older catalog after it', async () => {
    let now = 0
    let body = ENVELOPE
    const s = new CatalogStore({
      cacheDir,
      keyList: KEY_LIST,
      fetchFn: counting(() => body),
      now: () => now
    })
    expect((await s.refresh()).boards[0].modelname).toBe('x86-64 PC with UEFI')

    body = sealWithTestKey((d) => {
      d.issued_at = '2026-12-01T00:00:00Z'
      d.boards[0].modelname = 'x86-64 PC with UEFI, new'
    })
    now += REFRESH_INTERVAL_MS
    const newer = await s.refresh()
    expect(newer.flockos).toMatchObject({ ok: true, issuedAt: '2026-12-01T00:00:00Z' })
    expect(newer.boards[0].modelname).toBe('x86-64 PC with UEFI, new')

    // The rollback check holds against the catalog in use, cache or not.
    await rm(cachePath(), { force: true })
    body = ENVELOPE
    now += REFRESH_INTERVAL_MS
    const older = await s.refresh()
    expect(older.flockos).toMatchObject({
      ok: false,
      code: 'rollback',
      kept: { issuedAt: '2026-12-01T00:00:00Z' }
    })
    expect(older.boards[0].modelname).toBe('x86-64 PC with UEFI, new')
  })
})

describe('CatalogStore.plan', () => {
  const ALL = ['flockos-amd64-efi-base', 'flockos-amd64-efi-base-rt', 'flockos-amd64-efi-nvidia']
  const store = (body: Buffer) =>
    new CatalogStore({ cacheDir, keyList: KEY_LIST, fetchFn: respond(body) })

  it('writes the variant itself, or the installer stick with the variant as payload', async () => {
    const s = store(ENVELOPE)
    const direct = await s.plan('flockos-amd64-efi-base@0.10.0')
    expect(direct.write.image_id).toBe('flockos-amd64-efi-base')
    expect(direct.payload).toBeUndefined()
    const stick = await s.plan(
      'flockos-amd64-efi-base@0.10.0',
      'flockos-amd64-efi-installer@0.10.0'
    )
    expect(stick.write.image_id).toBe('flockos-amd64-efi-installer')
    expect(stick.payload?.image_id).toBe('flockos-amd64-efi-base')
  })

  it('refuses a payload the installer does not carry (v0.10.0 carries base only)', async () => {
    const s = store(ENVELOPE)
    await expect(
      s.plan('flockos-amd64-efi-nvidia@0.10.0', 'flockos-amd64-efi-installer@0.10.0')
    ).rejects.toThrow(/does not carry flockos-amd64-efi-nvidia/)
    await expect(
      s.plan('flockos-arm64-efi-base@0.10.0', 'flockos-amd64-efi-installer@0.10.0')
    ).rejects.toThrow(/does not carry/)
  })

  it('accepts every payload a stick carries', async () => {
    const s = store(
      sealWithTestKey((d) => {
        d.releases['0.10.0'].images['flockos-amd64-efi-installer'].payloads = ALL
      })
    )
    for (const id of ALL) {
      const plan = await s.plan(`${id}@0.10.0`, 'flockos-amd64-efi-installer@0.10.0')
      expect(plan.payload?.image_id).toBe(id)
    }
  })

  it('refuses the installer as a variant, and a variant as the installer', async () => {
    const s = store(ENVELOPE)
    await expect(s.plan('flockos-amd64-efi-installer@0.10.0')).rejects.toThrow(/not a variant/)
    await expect(
      s.plan('flockos-amd64-efi-base@0.10.0', 'flockos-amd64-efi-nvidia@0.10.0')
    ).rejects.toThrow(/not an installer stick/)
  })

  it('checks the release too', () => {
    const installer = {
      image_id: 'flockos-amd64-efi-installer',
      variant: 'installer',
      version: '0.11.0',
      payloads: ['flockos-amd64-efi-base']
    } as any
    const base = { image_id: 'flockos-amd64-efi-base', variant: 'base', version: '0.10.0' } as any
    expect(() => assertInstallerCarries(installer, base)).toThrow(/does not carry/)
    expect(() => assertInstallerCarries(installer, { ...base, version: '0.11.0' })).not.toThrow()
  })
})
