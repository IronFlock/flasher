// The packaging steps of a build machine, in this order:
//   1. scripts/fetch-node.js: the bundled Node runtime of the flash subprocess
//   2. electron-builder install-app-deps: the native modules for Electron's ABI
//   3. scripts/rebuild-flash-natives.js: mountutils for the bundled Node's ABI
//      (after 2, which would otherwise revert it)
// `npm install` runs them through scripts/postinstall.js, except in CI; the
// package build runs them with `just natives` (locally and in release.yml).
const path = require('path')
const { execFileSync } = require('child_process')

const run = (args, env = process.env) =>
  execFileSync(process.execPath, args, { stdio: 'inherit', cwd: path.join(__dirname, '..'), env })

// Linux: node-gyp builds every addon with USING_V8_SHARED and V8_DEPRECATION_WARNINGS
// (its addon.gypi). Electron 43's V8 headers then declare a deprecated class as
// `class [[deprecated(...)]] __attribute__((visibility("default"))) Value`
// (v8-primitive.h), an attribute order GCC rejects ("expected identifier before
// '__attribute__'"; clang accepts it). gyp puts CPPFLAGS after its own defines, so
// undefining the warning macros there drops the deprecation warnings and nothing else.
const electronEnv =
  process.platform === 'linux'
    ? {
        ...process.env,
        CPPFLAGS:
          `${process.env.CPPFLAGS ?? ''} -UV8_DEPRECATION_WARNINGS -UV8_IMMINENT_DEPRECATION_WARNINGS`.trim()
      }
    : process.env

run([path.join(__dirname, 'fetch-node.js')])
// The CLI's JS entry, not the node_modules/.bin shim: it runs the same on every
// platform and outside npm's PATH (see rebuild-flash-natives.js).
run([require.resolve('electron-builder/cli.js'), 'install-app-deps'], electronEnv)
run([path.join(__dirname, 'rebuild-flash-natives.js')])
