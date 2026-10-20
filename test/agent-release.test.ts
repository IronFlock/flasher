import { describe, it, expect, vi } from 'vitest'
import {
  AVAILABLE_VERSIONS_URL,
  agentBinaryName,
  agentBinaryUrl,
  agentSha256Url,
  parseSha256Sidecar,
  downloadAgentBinary
} from '../src/main/api/agent-release'

const DIGEST = 'a'.repeat(64)

const fakeFetch = (body: string, status = 200) =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch

describe('agent release URLs', () => {
  it('uses the device-agent tree for the version list', () => {
    expect(AVAILABLE_VERSIONS_URL).toBe(
      'https://instance-registry.ironflock.com/dl/device-agent/availableVersions.json'
    )
  })

  it('names the binary device-agent, with .exe only on windows', () => {
    expect(agentBinaryName('linux')).toBe('device-agent')
    expect(agentBinaryName('darwin')).toBe('device-agent')
    expect(agentBinaryName('windows')).toBe('device-agent.exe')
  })

  it('builds binary and checksum URLs in the new tree', () => {
    expect(agentBinaryUrl('darwin', 'arm64', '1.3.1')).toBe(
      'https://instance-registry.ironflock.com/dl/device-agent/darwin/arm64/1.3.1/device-agent'
    )
    expect(agentBinaryUrl('windows', 'amd64', '1.3.1')).toBe(
      'https://instance-registry.ironflock.com/dl/device-agent/windows/amd64/1.3.1/device-agent.exe'
    )
    expect(agentSha256Url('linux', 'amd64', '1.3.1')).toBe(
      'https://instance-registry.ironflock.com/dl/device-agent/linux/amd64/1.3.1/device-agent.sha256'
    )
  })

  it('never points at the frozen re-agent tree', () => {
    expect(agentBinaryUrl('linux', 'amd64', '1.0.0')).not.toContain('re-agent')
    expect(AVAILABLE_VERSIONS_URL).not.toContain('re-agent')
  })
})

describe('parseSha256Sidecar', () => {
  it('accepts a bare digest and sha256sum style output', () => {
    expect(parseSha256Sidecar(`${DIGEST}\n`)).toBe(DIGEST)
    expect(parseSha256Sidecar(`${DIGEST.toUpperCase()}  device-agent\n`)).toBe(DIGEST)
  })

  it('rejects malformed content', () => {
    expect(() => parseSha256Sidecar('')).toThrow(/Malformed/)
    expect(() => parseSha256Sidecar('<html>not found</html>')).toThrow(/Malformed/)
    expect(() => parseSha256Sidecar('abc123')).toThrow(/Malformed/)
  })
})

describe('downloadAgentBinary', () => {
  const params = { os: 'linux', arch: 'amd64', version: '1.3.1', destPath: '/tmp/x/device-agent' }

  it('passes the sidecar digest to the downloader and requests an executable file', async () => {
    const download = vi.fn(async () => undefined)
    const fetchFn = fakeFetch(`${DIGEST}  device-agent\n`)
    await downloadAgentBinary(params, { download, fetchFn })

    expect(fetchFn).toHaveBeenCalledWith(
      'https://instance-registry.ironflock.com/dl/device-agent/linux/amd64/1.3.1/device-agent.sha256'
    )
    expect(download).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith(
      'https://instance-registry.ironflock.com/dl/device-agent/linux/amd64/1.3.1/device-agent',
      '/tmp/x/device-agent',
      undefined,
      { mode: 0o755, expectedSha256: DIGEST }
    )
  })

  it('does not download when the checksum cannot be fetched', async () => {
    const download = vi.fn(async () => undefined)
    await expect(
      downloadAgentBinary(params, { download, fetchFn: fakeFetch('nope', 404) })
    ).rejects.toThrow(/HTTP 404/)
    expect(download).not.toHaveBeenCalled()
  })

  it('does not download when the checksum file is malformed', async () => {
    const download = vi.fn(async () => undefined)
    await expect(
      downloadAgentBinary(params, { download, fetchFn: fakeFetch('garbage') })
    ).rejects.toThrow(/Malformed/)
    expect(download).not.toHaveBeenCalled()
  })

  it('surfaces a checksum mismatch from the downloader', async () => {
    const download = vi.fn(async () => {
      throw new Error('SHA-256 mismatch')
    })
    await expect(
      downloadAgentBinary(params, { download, fetchFn: fakeFetch(DIGEST) })
    ).rejects.toThrow(/SHA-256 mismatch/)
  })
})
