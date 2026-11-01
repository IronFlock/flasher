// The packaging steps of a build machine, in this order:
//   1. scripts/fetch-node.js: the bundled Node runtime of the flash subprocess
//   2. electron-builder install-app-deps: the native modules for Electron's ABI
//   3. scripts/rebuild-flash-natives.js: mountutils for the bundled Node's ABI
//      (after 2, which would otherwise revert it)
// `npm install` runs them through scripts/postinstall.js, except in CI; the
// package build runs them with `just natives` (locally and in release.yml).
const path = require('path')
const { execFileSync } = require('child_process')

const run = (...args) =>
  execFileSync(process.execPath, args, { stdio: 'inherit', cwd: path.join(__dirname, '..') })

run(path.join(__dirname, 'fetch-node.js'))
// The CLI's JS entry, not the node_modules/.bin shim: it runs the same on every
// platform and outside npm's PATH (see rebuild-flash-natives.js).
run(require.resolve('electron-builder/cli.js'), 'install-app-deps')
run(path.join(__dirname, 'rebuild-flash-natives.js'))
