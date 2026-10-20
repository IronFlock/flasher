// Pure helpers for locating and verifying the IronFlock device agent release.
// Kept free of Electron imports so they can be unit-tested directly.

export const AGENT_BASE_URL = 'https://instance-registry.ironflock.com/dl/device-agent'
export const AVAILABLE_VERSIONS_URL = `${AGENT_BASE_URL}/availableVersions.json`

// Name of the binary in the release tree (and of the local copy).
export const agentBinaryName = (os: string): string =>
  `device-agent${os === 'windows' ? '.exe' : ''}`

export const agentBinaryUrl = (os: string, arch: string, version: string): string =>
  `${AGENT_BASE_URL}/${os}/${arch}/${version}/${agentBinaryName(os)}`

export const agentSha256Url = (os: string, arch: string, version: string): string =>
  `${agentBinaryUrl(os, arch, version)}.sha256`

// A `.sha256` sidecar holds the hex digest, optionally followed by a file name
// (`sha256sum` style). Returns the lower-cased digest or throws.
export const parseSha256Sidecar = (text: string): string => {
  const token = text.trim().split(/\s+/)[0] ?? ''
  if (!/^[0-9a-fA-F]{64}$/.test(token)) {
    throw new Error('Malformed SHA-256 checksum file for the device agent')
  }
  return token.toLowerCase()
}

export const fetchExpectedSha256 = async (
  os: string,
  arch: string,
  version: string,
  fetchFn: typeof fetch = fetch
): Promise<string> => {
  const response = await fetchFn(agentSha256Url(os, arch, version))
  if (!response.ok) {
    throw new Error(`Failed to fetch device agent checksum: HTTP ${response.status}`)
  }
  return parseSha256Sidecar(await response.text())
}

export type AgentDownloader = (
  url: string,
  destPath: string,
  progress?: (progress: any) => void,
  options?: { mode?: number; expectedSha256?: string }
) => Promise<void>

// Downloads the agent binary, refusing to commit it unless its SHA-256 matches the
// published sidecar (the downloader deletes the partial file on mismatch).
export const downloadAgentBinary = async (
  params: {
    os: string
    arch: string
    version: string
    destPath: string
    progress?: (progress: any) => void
  },
  deps: { download: AgentDownloader; fetchFn?: typeof fetch }
): Promise<void> => {
  const { os, arch, version, destPath, progress } = params
  const expectedSha256 = await fetchExpectedSha256(os, arch, version, deps.fetchFn)
  await deps.download(agentBinaryUrl(os, arch, version), destPath, progress, {
    mode: 0o755,
    expectedSha256
  })
}
