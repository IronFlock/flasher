// The install steps of a packaging machine: Windows driver tooling, the
// bundled Node runtime and the native modules rebuilt for Electron. The CI
// gate (lint, unit tests, the app bundle) needs none of them, and the native
// rebuilds need each platform's build toolchain, so CI (CI=true) skips them.
const { execSync } = require('child_process')

if (process.env.CI) {
  console.log('postinstall: CI, packaging steps skipped')
  process.exit(0)
}

for (const step of [
  'node scripts/windows.js',
  'node scripts/fetch-node.js',
  'electron-builder install-app-deps',
  'node scripts/rebuild-flash-natives.js'
]) {
  execSync(step, { stdio: 'inherit' })
}
