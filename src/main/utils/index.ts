import fs from 'fs/promises'
import { is } from '@electron-toolkit/utils'
import { app } from 'electron'
import path from 'path'
import { APPIMAGE_MOUNT_POINT, elevatedSpawn } from '../api/permissions'

// Pure progress math lives in ./progress so it can be unit-tested without Electron.
export { calculateSpeed, calculateETA } from './progress'
// The downloads live in ./download, which the command-line tool shares.
export { downloadFile, getRemoteFileSize } from './download'

export const getNodeModulesResourcePath = (moduleName: string, opts?: { unpacked?: boolean }) => {
  // The elevated subprocess runs a temp script whose module loader does NOT walk up
  // into the project's node_modules, so we must hand it an absolute path. In dev
  // that is the project's node_modules (app.getAppPath() is the project root).
  // moduleName is a constant of the callers ('etcher-sdk', 'mountutils').
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  if (is.dev) return path.join(app.getAppPath(), 'node_modules', moduleName)

  const resourcePath = process.env.APPIMAGE
    ? path.join(APPIMAGE_MOUNT_POINT, 'resources')
    : process.resourcesPath

  // The flash subprocess runs under REAL node (see getNodeBinaryPath), which cannot
  // read inside app.asar — etcher-sdk must be requested from app.asar.unpacked (it
  // is asarUnpack'd for exactly this reason). Electron-node consumers (the unmount
  // script) can read the packed asar directly.
  const nodeModules = opts?.unpacked ? 'app.asar.unpacked/node_modules' : 'app.asar/node_modules'
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- moduleName is a constant (above)
  return path.join(resourcePath, nodeModules, moduleName)
}

// Absolute path to the bundled standalone Node binary used to run the elevated
// FLASH subprocess. Electron's V8 memory cage (Electron 21+) forbids the external
// buffers etcher-sdk's @ronomon/direct-io needs for O_DIRECT block writes, so
// flashing cannot run via ELECTRON_RUN_AS_NODE — a real Node has no cage. The
// binary is fetched per-platform by scripts/fetch-node.js and bundled under
// resources/binaries (asarUnpack'd in production). See README "Flashing runtime".
export const getNodeBinaryPath = () => {
  const binaryName = process.platform === 'win32' ? 'node.exe' : 'node'
  const relative = path.join('resources', 'binaries', process.platform, binaryName)

  if (is.dev) return path.join(app.getAppPath(), relative)

  const resourcePath = process.env.APPIMAGE
    ? path.join(APPIMAGE_MOUNT_POINT, 'resources')
    : process.resourcesPath

  return path.join(resourcePath, 'app.asar.unpacked', relative)
}

export async function isFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch {
    // noop
  }
  return false
}

export const fileExists = async (filePath: string) => {
  try {
    await fs.access(filePath)
    return true
  } catch (err) {
    return false
  }
}

export const killProcessDarwin = (signal: number, pid: number) => {
  return elevatedSpawn('kill', [`-${signal}`, String(pid)])
}
