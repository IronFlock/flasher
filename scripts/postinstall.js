// The packaging steps of `npm install` on a build machine (scripts/prepare-natives.js:
// the bundled Node runtime, the native modules rebuilt for Electron and for the
// bundled Node). The CI gate (lint, unit tests, the app bundle) needs none of
// them, and the native rebuilds need each platform's build toolchain, so CI
// (CI=true) skips them here; the release build runs them itself (`just natives`
// in .github/actions/package).
if (process.env.CI) {
  console.log('postinstall: CI, packaging steps skipped')
  process.exit(0)
}

require('./prepare-natives')
