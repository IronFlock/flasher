import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash, generateKeyPairSync, sign, KeyObject } from 'node:crypto'
import {
  CatalogError,
  FLOCKOS_CATALOG_PUBLIC_KEYS,
  MAX_ENVELOPE_BYTES,
  assertNotOlder,
  catalogMessage,
  decodeBase64Strict,
  openCatalog,
  openEnvelope,
  parseCatalogPayload,
  parsePublicKeys
} from '../src/main/security/catalog'

// dl/flockos/manifest.json of IronFlockOS v0.10.0 as published (2026-11-06), and its
// decoded payload.
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/flockos/${name}`, import.meta.url)))
const ENVELOPE = fixture('manifest.json')
const PAYLOAD = fixture('payload.json')

const PRODUCTION_KEYS = parsePublicKeys(FLOCKOS_CATALOG_PUBLIC_KEYS)

// A throwaway signing key, and its line in the FLOCKOS_CATALOG_PUBLIC_KEYS format.
const testKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12)
  return { privateKey, line: raw.toString('base64') }
}

const seal = (payload: Buffer, privateKey: KeyObject, message = catalogMessage(payload)) =>
  Buffer.from(
    JSON.stringify({
      payload: payload.toString('base64'),
      signature: sign(null, message, privateKey).toString('base64')
    })
  )

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogError)
    expect((error as CatalogError).code).toBe(code)
    return
  }
  throw new Error(`expected a CatalogError ${code}`)
}

const mutatePayload = (change: (doc: any) => void) => {
  const doc = JSON.parse(PAYLOAD.toString('utf8'))
  change(doc)
  return Buffer.from(JSON.stringify(doc))
}

describe('catalog keys', () => {
  it('compiles in the Cloud KMS key ironflock-release/flockos-catalog v1', () => {
    expect(PRODUCTION_KEYS.map((k) => k.id)).toEqual(['f5e1308e'])
  })

  it('accepts several keys (rotation) and comments', () => {
    const extra = testKey()
    const keys = parsePublicKeys(`${FLOCKOS_CATALOG_PUBLIC_KEYS}\n${extra.line} # next key\n`)
    expect(keys).toHaveLength(2)
  })

  it('rejects the whole list for one bad line, and an empty list', () => {
    expect(() => parsePublicKeys(`${FLOCKOS_CATALOG_PUBLIC_KEYS}\nTODO-KEY\n`)).toThrow(/line 4/)
    expect(() => parsePublicKeys('# no keys\n')).toThrow(/No IronFlockOS catalog key/)
    expect(() => parsePublicKeys('AAAA\n')).toThrow(/32-byte/)
  })
})

describe('decodeBase64Strict', () => {
  it('accepts canonical padded base64 only', () => {
    expect(decodeBase64Strict('aGk=')?.toString()).toBe('hi')
    expect(decodeBase64Strict('aGk')).toBeUndefined()
    expect(decodeBase64Strict('aGl=')).toBeUndefined() // non-zero padding bits
    expect(decodeBase64Strict('aG k=')).toBeUndefined()
    expect(decodeBase64Strict('aGk-')).toBeUndefined()
  })
})

describe('openEnvelope', () => {
  it('verifies the published v0.10.0 catalog with the production key', () => {
    const { payload, keyId } = openEnvelope(ENVELOPE, PRODUCTION_KEYS)
    expect(keyId).toBe('f5e1308e')
    expect(payload.equals(PAYLOAD)).toBe(true)
  })

  it('signs the documented message', () => {
    const digest = createHash('sha256').update(PAYLOAD).digest('hex')
    expect(catalogMessage(PAYLOAD).toString()).toBe(
      `flockos-manifest:v1\nflockos/manifest.json\n${digest}`
    )
  })

  it('rejects a tampered payload', () => {
    const envelope = JSON.parse(ENVELOPE.toString())
    const tampered = PAYLOAD.toString().replace(
      'e1a09aa008a3b4fb95ee755c5a4fef76aec3f61b2c4367e3787a05540ed39270',
      'f'.repeat(64)
    )
    expect(tampered).not.toBe(PAYLOAD.toString())
    envelope.payload = Buffer.from(tampered).toString('base64')
    expectCode(
      () => openEnvelope(Buffer.from(JSON.stringify(envelope)), PRODUCTION_KEYS),
      'bad-signature'
    )
  })

  it('rejects a signature made with a key it does not trust', () => {
    const other = testKey()
    expectCode(
      () => openEnvelope(seal(PAYLOAD, other.privateKey), PRODUCTION_KEYS),
      'bad-signature'
    )
  })

  it('accepts a second listed key (rotation)', () => {
    const next = testKey()
    const keys = parsePublicKeys(`${FLOCKOS_CATALOG_PUBLIC_KEYS}\n${next.line}`)
    expect(openEnvelope(seal(PAYLOAD, next.privateKey), keys).keyId).toBe(keys[1].id)
  })

  it('rejects a signature over another subject (domain separation)', () => {
    const key = testKey()
    const keys = parsePublicKeys(key.line)
    const digest = createHash('sha256').update(PAYLOAD).digest('hex')
    const agentManifest = Buffer.from(
      `device-agent-manifest:v1\ndevice-agent/manifest.json\n${digest}`
    )
    expectCode(
      () => openEnvelope(seal(PAYLOAD, key.privateKey, agentManifest), keys),
      'bad-signature'
    )
  })

  it('rejects an unsigned catalog: the bare payload, or no or an empty signature', () => {
    expectCode(() => openEnvelope(PAYLOAD, PRODUCTION_KEYS), 'unsigned')
    const envelope = JSON.parse(ENVELOPE.toString())
    delete envelope.signature
    expectCode(
      () => openEnvelope(Buffer.from(JSON.stringify(envelope)), PRODUCTION_KEYS),
      'unsigned'
    )
    envelope.signature = '  '
    expectCode(
      () => openEnvelope(Buffer.from(JSON.stringify(envelope)), PRODUCTION_KEYS),
      'unsigned'
    )
  })

  it('rejects an envelope over 64 KiB, even a validly signed one', () => {
    const key = testKey()
    const big = seal(PAYLOAD, key.privateKey)
    const padded = Buffer.concat([big, Buffer.alloc(MAX_ENVELOPE_BYTES + 1 - big.length, ' ')])
    expect(padded.length).toBe(MAX_ENVELOPE_BYTES + 1)
    expectCode(() => openEnvelope(padded, parsePublicKeys(key.line)), 'oversize')
  })

  it('rejects what is not an envelope', () => {
    expectCode(() => openEnvelope(Buffer.from('<html>502</html>'), PRODUCTION_KEYS), 'malformed')
    expectCode(() => openEnvelope(Buffer.from('[1,2]'), PRODUCTION_KEYS), 'malformed')
    const envelope = JSON.parse(ENVELOPE.toString())
    expectCode(
      () =>
        openEnvelope(Buffer.from(JSON.stringify({ ...envelope, payload: 42 })), PRODUCTION_KEYS),
      'malformed'
    )
    expectCode(
      () =>
        openEnvelope(
          Buffer.from(JSON.stringify({ ...envelope, payload: '%%not base64%%' })),
          PRODUCTION_KEYS
        ),
      'malformed'
    )
    expectCode(
      () =>
        openEnvelope(
          Buffer.from(
            JSON.stringify({ ...envelope, signature: Buffer.alloc(63).toString('base64') })
          ),
          PRODUCTION_KEYS
        ),
      'malformed'
    )
  })

  it('trusts nothing without keys', () => {
    expectCode(() => openEnvelope(ENVELOPE, []), 'no-keys')
  })
})

describe('parseCatalogPayload', () => {
  const catalog = openCatalog(ENVELOPE, PRODUCTION_KEYS)

  it('reads the production release and its boards', () => {
    expect(catalog.production).toBe('0.10.0')
    expect(catalog.issuedAt).toBe('2026-11-06T00:18:10Z')
    expect(catalog.boards.map((b) => b.model)).toEqual([
      'amd64-efi',
      'arm64-efi',
      'raspberrypi4',
      'raspberrypi5'
    ])
    const pc = catalog.boards[0]
    expect(pc.latestImages.map((i) => `${i.variant}/${i.kernel}`)).toEqual([
      'base/std',
      'nvidia/std',
      'base/rt',
      'installer/std'
    ])
    expect(pc.latestImages[0]).toMatchObject({
      image_id: 'flockos-amd64-efi-base',
      file: 'flockos-amd64-efi-base-0.10.0.img.gz',
      osvariant: 'image',
      sha256: 'e1a09aa008a3b4fb95ee755c5a4fef76aec3f61b2c4367e3787a05540ed39270',
      size: 620764500
    })
  })

  it('refuses another schema', () => {
    expectCode(() => parseCatalogPayload(mutatePayload((d) => (d.schema = 2))), 'invalid')
  })

  it('refuses a channel naming an unlisted release', () => {
    expectCode(
      () => parseCatalogPayload(mutatePayload((d) => (d.channels.test = '9.9.9'))),
      'invalid'
    )
  })

  it('refuses a board image that disagrees with its release', () => {
    expectCode(
      () =>
        parseCatalogPayload(
          mutatePayload((d) => (d.boards[0].latestImages[0].sha256 = 'a'.repeat(64)))
        ),
      'invalid'
    )
    expectCode(
      () =>
        parseCatalogPayload(mutatePayload((d) => (d.boards[0].latestImages[0].variant = 'nvidia'))),
      'invalid'
    )
  })

  it('refuses unsafe downloads and file names', () => {
    expectCode(
      () =>
        parseCatalogPayload(
          mutatePayload((d) => {
            const http = d.boards[0].latestImages[0].download.replace('https:', 'http:')
            d.boards[0].latestImages[0].download = http
            d.releases['0.10.0'].images['flockos-amd64-efi-base'].image.url = http
          })
        ),
      'invalid'
    )
    expectCode(
      () =>
        parseCatalogPayload(
          mutatePayload((d) => (d.boards[0].latestImages[0].file = '../evil.img.gz'))
        ),
      'invalid'
    )
  })

  it('refuses anything but a raw image (no ISO repack for IronFlockOS)', () => {
    expectCode(
      () =>
        parseCatalogPayload(
          mutatePayload((d) => (d.boards[0].latestImages[0].osvariant = 'installer'))
        ),
      'invalid'
    )
  })

  it('refuses anything but an .img.gz (schema 1)', () => {
    for (const ext of ['.img.xz', '.img', '.iso.gz']) {
      expectCode(
        () =>
          parseCatalogPayload(
            mutatePayload((d) => {
              const url = d.boards[0].latestImages[0].download.replace('.img.gz', ext)
              d.boards[0].latestImages[0].download = url
              d.boards[0].latestImages[0].file = url.split('/').pop()
              d.releases['0.10.0'].images['flockos-amd64-efi-base'].image.url = url
            })
          ),
        'invalid'
      )
    }
  })

  it('ignores unknown fields', () => {
    const parsed = parseCatalogPayload(
      mutatePayload((d) => {
        d.future_field = { anything: true }
        d.boards[0].latestImages[0].future_field = 1
      })
    )
    expect(parsed.boards[0].latestImages[0]).not.toHaveProperty('future_field')
  })

  it('refuses a payload that is not JSON even when correctly signed', () => {
    const key = testKey()
    expectCode(
      () => openCatalog(seal(Buffer.from('not json'), key.privateKey), parsePublicKeys(key.line)),
      'invalid'
    )
  })
})

describe('forward compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Adds an image to release 0.10.0 and returns its board entry.
  const addImage = (d: any, id: string, variant: string, kernel: string, architecture: string) => {
    const base = d.boards[0].latestImages[0]
    const url = base.download.replace('flockos-amd64-efi-base', id)
    d.releases['0.10.0'].images[id] = {
      target: id.replace(/^flockos-/, ''),
      variant,
      kernel,
      architecture,
      image: { url, sha256: base.sha256, size: base.size }
    }
    return { ...base, image_id: id, variant, kernel, download: url, file: url.split('/').pop() }
  }

  it('skips images of an unknown variant, kernel or architecture and hides their boards', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const parsed = parseCatalogPayload(
      mutatePayload((d) => {
        d.boards[0].latestImages.push(
          addImage(d, 'flockos-amd64-efi-kiosk', 'kiosk', 'std', 'amd64')
        )
        d.boards[0].latestImages.push(
          addImage(d, 'flockos-amd64-efi-base-ll', 'base', 'lowlatency', 'amd64')
        )
        d.boards.push({
          ...d.boards[0],
          architecture: 'riscv64',
          model: 'riscv64-efi',
          modelname: 'RISC-V machine with UEFI',
          latestImages: [addImage(d, 'flockos-riscv64-efi-base', 'base', 'std', 'riscv64')]
        })
      })
    )
    expect(parsed.boards.map((b) => b.model)).toEqual([
      'amd64-efi',
      'arm64-efi',
      'raspberrypi4',
      'raspberrypi5'
    ])
    expect(parsed.boards[0].latestImages.map((i) => i.image_id)).toEqual([
      'flockos-amd64-efi-base',
      'flockos-amd64-efi-nvidia',
      'flockos-amd64-efi-base-rt',
      'flockos-amd64-efi-installer'
    ])
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toMatch(/variant kiosk is unknown/)
    expect(logged).toMatch(/kernel lowlatency is unknown/)
    expect(logged).toMatch(/architecture riscv64 is unknown/)
    expect(logged).toMatch(/hiding boards\[4\] \(riscv64-efi\)/)
  })

  it('hides a board whose images are all unknown', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const parsed = parseCatalogPayload(
      mutatePayload((d) => {
        d.boards[1].latestImages = [
          addImage(d, 'flockos-arm64-efi-kiosk', 'kiosk', 'std', 'arm64'),
          addImage(d, 'flockos-arm64-efi-base-ll', 'base', 'lowlatency', 'arm64')
        ]
      })
    )
    expect(parsed.boards.map((b) => b.model)).toEqual(['amd64-efi', 'raspberrypi4', 'raspberrypi5'])
  })

  it('still refuses a malformed image, and a known image its release does not list as such', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expectCode(
      () => parseCatalogPayload(mutatePayload((d) => (d.boards[0].latestImages[0].variant = 7))),
      'invalid'
    )
    expectCode(
      () =>
        parseCatalogPayload(
          mutatePayload(
            (d) => (d.releases['0.10.0'].images['flockos-amd64-efi-base'].variant = 'kiosk')
          )
        ),
      'invalid'
    )
  })
})

describe('installer payloads', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const INSTALLER = 'flockos-amd64-efi-installer'
  const ALL = ['flockos-amd64-efi-base', 'flockos-amd64-efi-base-rt', 'flockos-amd64-efi-nvidia']
  const installerOf = (parsed: { boards: any[] }, model: string) =>
    parsed.boards
      .find((b) => b.model === model)
      ?.latestImages.find((i: any) => i.variant === 'installer')
  const withPayloads = (release: unknown, board?: unknown) =>
    mutatePayload((d) => {
      if (release !== undefined) d.releases['0.10.0'].images[INSTALLER].payloads = release
      if (board !== undefined) {
        d.boards[0].latestImages.find((i: any) => i.variant === 'installer').payloads = board
      }
    })

  it('reads a missing payloads as the target base image (v0.10.0)', () => {
    const catalog = openCatalog(ENVELOPE, PRODUCTION_KEYS)
    expect(installerOf(catalog, 'amd64-efi')?.payloads).toEqual(['flockos-amd64-efi-base'])
    expect(installerOf(catalog, 'arm64-efi')?.payloads).toEqual(['flockos-arm64-efi-base'])
    expect(installerOf(catalog, 'raspberrypi4')).toBeUndefined()
    expect(catalog.boards[0].latestImages[0].payloads).toBeUndefined()
  })

  it('reads the images an installer carries, on the release and the board', () => {
    expect(installerOf(parseCatalogPayload(withPayloads(ALL, ALL)), 'amd64-efi')?.payloads).toEqual(
      ALL
    )
    // a board entry without payloads takes the release's
    expect(installerOf(parseCatalogPayload(withPayloads(ALL)), 'amd64-efi')?.payloads).toEqual(ALL)
  })

  it('drops payloads that are not images of the release and target, with a log line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const odd = [
      'flockos-amd64-efi-base',
      'flockos-amd64-efi-kiosk',
      'flockos-arm64-efi-base',
      INSTALLER,
      'flockos-amd64-efi-base'
    ]
    const parsed = parseCatalogPayload(withPayloads(odd))
    expect(installerOf(parsed, 'amd64-efi')?.payloads).toEqual(['flockos-amd64-efi-base'])
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /dropping payload flockos-amd64-efi-kiosk/
    )
  })

  it('refuses payloads that are not a list of ids, or that differ between board and release', () => {
    expectCode(() => parseCatalogPayload(withPayloads('flockos-amd64-efi-base')), 'invalid')
    expectCode(() => parseCatalogPayload(withPayloads([42])), 'invalid')
    expectCode(() => parseCatalogPayload(withPayloads(ALL, ['flockos-amd64-efi-base'])), 'invalid')
  })
})

describe('assertNotOlder', () => {
  const current = openCatalog(ENVELOPE, PRODUCTION_KEYS)
  const older = {
    ...current,
    issuedAt: '2026-11-01T00:00:00Z',
    issuedAtMs: Date.parse('2026-11-01T00:00:00Z')
  }

  it('refuses a catalog older than the one accepted last', () => {
    expectCode(() => assertNotOlder(older, current), 'rollback')
  })

  it('accepts the same or a newer one, or a first one', () => {
    expect(() => assertNotOlder(current, current)).not.toThrow()
    expect(() => assertNotOlder(current, older)).not.toThrow()
    expect(() => assertNotOlder(current, undefined)).not.toThrow()
  })
})
