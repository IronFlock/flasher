// Rebuilds the flash subprocess's ABI-specific native modules for the BUNDLED Node
// (see scripts/fetch-node.js), NOT Electron. Runs after `electron-builder
// install-app-deps` (which builds everything for Electron's ABI) so the final state
// is: N-API modules (drivelist, @ronomon/direct-io, xxhash-addon) work under both
// runtimes, and mountutils (nan — ABI-specific) is built for the bundled Node.
//
// Why: the elevated flash + unmount subprocesses run under the bundled Node (Electron's
// V8 memory cage forbids the external buffers etcher-sdk/direct-io needs). The Electron
// main process never loads mountutils in-process (only the subprocesses do), so building
// it for the Node ABI does not break the GUI. See README "Flashing runtime".
//
// Re-run this if you ever run `electron-builder install-app-deps` or `npm rebuild`
// again, since those revert mountutils to Electron's ABI.

const path = require('path')
const { execFileSync } = require('child_process')

// Resolve node-gyp's real JS entry point rather than the node_modules/.bin shim.
// On Windows the .bin/node-gyp file is a bash wrapper (no .cmd extension), and
// handing it to process.execPath (node.exe) fails with a JS syntax error; the .js
// entry runs identically under node on every platform.
const nodeGypBin = require.resolve('node-gyp/bin/node-gyp.js')

// Keep in sync with scripts/fetch-node.js. Node 24 (not 22): Node 22.19's libuv
// mangles `\\.\PhysicalDrive<n>` paths (trailing backslash -> EINVAL on elevated
// flash); Node 24 opens them correctly.
const NODE_VERSION = '24.18.0'

// nan-based modules used on the flash/unmount path that must match the bundled Node.
const NAN_MODULES = ['mountutils']

const arch = process.platform === 'darwin' ? process.arch : 'x64'

for (const mod of NAN_MODULES) {
  const cwd = path.join(__dirname, '..', 'node_modules', mod)
  console.log(`[rebuild-flash-natives] building ${mod} for Node v${NODE_VERSION} (${arch})`)
  execFileSync(
    process.execPath,
    [
      nodeGypBin,
      'rebuild',
      `--target=${NODE_VERSION}`,
      `--arch=${arch}`,
      '--dist-url=https://nodejs.org/dist'
    ],
    {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        // The bundled Node's V8 headers set the C++ standard: Node 24 requires C++20
        // (concepts, std::ranges; v8config.h: "C++20 or later required"). Electron's
        // build sets this for us, a bare node-gyp build does not. MSVC ignores CXXFLAGS.
        CXXFLAGS: `${process.env.CXXFLAGS ?? ''} -std=c++20`.trim()
      }
    }
  )
}

console.log('[rebuild-flash-natives] done')
