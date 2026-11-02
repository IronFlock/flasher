# FlockFlasher - AI Coding Instructions

## Overview
Electron desktop app (by Record Evolution) for flashing IronFlock OS onto IoT devices. The renderer is Vue 3 + Vuetify + Pinia + vue-i18n (English/German); the main process uses etcher-sdk for drive operations. Users drop `.flock` / `.reswarm` device-config files (JSON, see `ReswarmConfig` in `src/types/index.ts`) or plain `.iso` / `.img` images, pick a target drive, and flash.

## Commands
```bash
npm run dev            # Development mode with HMR (electron-vite)
npm run dev:debug      # Dev mode with --inspect for the main process
npm run build          # Typecheck + electron-vite build
npm run typecheck      # tsc for main/preload (tsconfig.node.json) + vue-tsc for renderer (tsconfig.web.json)
npm test               # Vitest unit tests (test/*.test.ts) — pure logic in src/main/security + utils
npm run test:watch     # Vitest watch mode
npm run lint           # ESLint 9 flat config (eslint.config.mjs) with --fix
npm run format         # Prettier (owns formatting; eslint uses flat/essential + skip-formatting)
just package           # This OS's installer into dist/ (just natives + build + installer), never publishes
just release-patch     # Release PR (-minor/-major); its merge builds, publishes and tags in CI
just merge [TITLE]     # No-release PR
```
Vitest covers only the pure, Electron-free modules (validation, sudo-arg building, sha256, progress math); elevated flashing and drive I/O are covered by manual per-OS smoke tests. VS Code users can use the "Debug All" compound launch config (main + renderer debugging). Dev/CI Node is pinned by `.nvmrc` + `engines` to Node 22 (`nvm use`).

**Native build requirement (macOS):** `drivelist` and `mountutils` compile from source (no arm64 prebuilds), so `npm install` needs working Command Line Tools **with the C++ stdlib headers in the toolchain path**. On very new macOS/Xcode a stale CLT can miss them (`fatal error: 'functional'/'cstdlib' file not found`); fix with `sudo rm -rf /Library/Developer/CommandLineTools && sudo xcode-select --install` (or install full Xcode). **Linux (GCC):** with node-gyp's `V8_DEPRECATION_WARNINGS`, Electron 43's `v8-primitive.h` puts `[[deprecated]]` before a GNU visibility attribute, which GCC rejects (`expected identifier before '__attribute__'`); `prepare-natives.js` undefines the warning macros via `CPPFLAGS` for `install-app-deps` on Linux. `usb` needs `libudev-dev` there. Natives are (re)built by `postinstall` → `scripts/prepare-natives.js` (`fetch-node.js` → `electron-builder install-app-deps` → `rebuild-flash-natives.js`). With `CI` set, postinstall skips these packaging steps (the CI gate needs none of them); the release build runs them itself with `just natives`.

## Critical Constraints
- **Electron 43 + etcher-sdk 10.** The old Electron-19 pin (etcher-sdk broke on Electron 20+, balena-io/etcher#4087) is lifted: etcher-sdk 10 + Electron 37+ is what balena Etcher itself ships, and etcher-sdk runs only in the spawned Node subprocess, never the renderer. When bumping Electron, change **both** `package.json` `electron` and `electron-builder.yml` `electronVersion`, then rebuild natives. Note Electron removed `File.path` — the renderer resolves dropped-file paths via `webUtils.getPathForFile` exposed through the preload (`window.api.getPathForFile`).
- Flashing requires root/admin. On macOS/Linux the app spawns `sudo` subprocesses; on Windows the whole app runs elevated (`requestedExecutionLevel: requireAdministrator`).
- `~/.Reflasher` is the app's config/cache directory (downloaded OS images, agent binary, `supportedBoardsImages.json`).
- Board/image metadata and binaries are fetched from `https://instance-registry.ironflock.com`.

## Architecture

### Three Electron layers
- `src/main/` — main process. `index.ts` handles window creation, auto-update (electron-updater, checks every 60s), single-instance lock, and `.flock`/`.reswarm` file/protocol associations (opening a file sends `add-image-item` to the renderer, gated on the renderer signalling `image-item-store-ready`). `ipcHandlers.ts` registers all RPC handlers; the real work lives in `src/main/api/`.
- `src/preload/index.ts` — exposes `window.api` (typed wrappers around `ipcRenderer.invoke`) and `window.ipcRenderer.receive` for push events.
- `src/renderer/` — Vue app. Pinia stores in `src/renderer/src/store/` own all backend calls and event subscriptions (e.g. `flash.ts` listens for `flash-progress`). Locales live in `src/renderer/src/locales/`; `@renderer` is aliased to `src/renderer/src`.

### RPC contract
The `RPC` enum in `src/types/index.ts` is the single registry of invoke channel names. Adding an endpoint means touching three files: `src/types/index.ts` (enum), `src/main/ipcHandlers.ts` (handler), `src/preload/index.ts` (api wrapper). Main→renderer push events use `webContents.send` with ad-hoc channels: `flash-progress`, `drive-scanner-attach/detach/progress/error`, `agent-logs`, `agent-state`, `agent-download-progress`, `update-status`, `add-image-item`. The preload allowlists these channel names (`SEND_CHANNELS` / `RECEIVE_CHANNELS`) — new channels must be added there too.

### Security model (`src/main/security/`) — read before touching privileged code
The main process runs as **root**, and `.flock`/`.reswarm` files plus board metadata are **untrusted input**. Two rules hold the line:
- **Never interpolate untrusted data into a shell string or into elevated-script source.** All privileged commands go through argv: `elevatedSpawn(cmd, argsArray)` / `spawnAsync` (no shell, no `command.split(' ')`) in `permissions.ts`. The two elevated Node scripts are FIXED constants in `security/elevated-scripts.ts` that read their inputs from `process.argv`; `elevatedNodeChildProcess(code, scriptArgs)` passes data as argv. There is a test (`test/elevated-scripts.test.ts`) asserting these scripts contain no `${…}`.
- **Validate at the boundary.** `security/validation.ts` (`assertValidDevicePath`, `assertValidReswarmConfig`, `isSafePathSegment`) is enforced in every privileged `ipcHandlers.ts` handler and again at config ingestion in `flash.ts`. `ipcHandlers` also cross-checks the flash target against `listDrives()` so the renderer can't aim a write at a system disk. `RPC.ReadFile` is scoped to `.flock`/`.reswarm` reads only.
- Downloaded artifacts are verified: `security/integrity.ts` (`verifyFileSha256`) is wired into the image download — `flash.ts` checks `ImageInfo.sha256` against the **compressed `.gz` download** (the registry publishes the digest of the compressed artifact, matching `ImageInfo.size` = the `.gz` content-length) before decompressing; `downloadFile` (`utils/index.ts`) checks HTTP status, verifies byte count, and writes to a `.part` temp then atomically renames.
- Renderer runs with `nodeIntegration:false` + `contextIsolation:true`; navigation is confined to the app origin (`will-navigate`/`will-redirect` in `index.ts`). `sandbox:true` is still pending (needs a self-contained preload) — see the Electron upgrade note below.

### Elevated flashing (`flash.ts` + `permissions.ts` + `utils/index.ts`) — flashing runtime
`flashDevice()` runs the FIXED `FLASH_SCRIPT` (from `security/elevated-scripts.ts`) under a **bundled standalone Node binary** (`getNodeBinaryPath()` → `resources/binaries/<platform>/node`, `useBundledNode: true`), NOT the Electron binary. **Why:** Electron's V8 memory cage (Electron 21+) forbids external buffers, which etcher-sdk's `@ronomon/direct-io` needs for O_DIRECT block writes — running the flasher via `ELECTRON_RUN_AS_NODE` aborts (`napi_create_external_buffer` assertion). A real Node has no cage. This is the real reason the app was historically pinned to Electron 19. The image path, drive JSON, final state and etcher-sdk module path are passed as `process.argv[2..5]` — never interpolated into the script.
- **Native ABI split:** etcher-sdk's flash-path native deps `drivelist`, `@ronomon/direct-io`, `xxhash-addon` are **N-API** (ABI-stable → one build works under both Electron and the bundled Node). `mountutils` is **nan** (ABI-specific); etcher-sdk always loads it to unmount a drive before writing (`block-device.js`), and the `unmountDisk` IPC path uses it too. Both those paths run under the bundled Node, so `scripts/rebuild-flash-natives.js` (postinstall, after `install-app-deps`) rebuilds mountutils for the bundled **Node** ABI with `-std=c++20` (Node 24's V8 headers require C++20). The Electron main process never loads mountutils in-process (only `drivelist` via the scanner), so this is safe. Re-running `install-app-deps` reverts mountutils to Electron's ABI — re-run `rebuild-flash-natives.js` after.
- The bundled Node binary is fetched per-platform by `scripts/fetch-node.js` (postinstall, git-ignored) and pinned via `NODE_VERSION` (keep it in sync between `fetch-node.js` and `rebuild-flash-natives.js`).
- macOS/Linux: spawned via `sudo -E -S` with the sudo password piped to stdin (collected by `SudoDialog.vue`, held in memory in `permissions.ts`, never persisted). Windows: no elevation needed (app already runs as admin).
- **Module resolution:** the bundled real Node cannot read inside `app.asar`, so etcher-sdk + mountutils are requested from `app.asar.unpacked/node_modules` (`getNodeModulesResourcePath(name, { unpacked: true })`), and `node_modules/**` is `asarUnpack`'d in `electron-builder.yml`. In dev the path is `app.getAppPath()/node_modules`. On Linux AppImage the image is loop-mounted first (`mountAppImage`).
- Progress flows back as JSON `Progress` objects on the subprocess stdout, parsed by the parent, forwarded to the renderer. Cancellation sends SIGTERM (via elevated `kill` on macOS).

### Flash pipeline for `.flock` / `.reswarm` items (`getReswarmImage` in `flash.ts`)
1. The config file is JSON containing the target board; the board's latest OS image (gzipped) is downloaded to `~/.Reflasher` and gunzipped (`boards.ts` / `ImageManager`), skipped if cached.
2. ISO-variant images are extracted (`iso.ts`), the device config is written into `boot/`, and the ISO is rebuilt with `xorriso` — bundled static binaries for macOS/Windows live in `resources/binaries/` (distributed via `asarUnpack`; `dd`/`du` for Windows too). Plain image variants instead get the config file copied onto the drive's boot partition after flashing.
3. Backwards compatibility: `.flock` configs are always duplicated as `.reswarm` on the device.

### Device test mode (`agent.ts`)
`AgentManager` downloads the `device-agent` binary from the instance registry (verified against its published SHA-256 checksum) into `~/.Reflasher/agent` and can run a "virtual device" locally against a `.flock` config. Requires a running Docker daemon (`hasDocker()`); streams agent logs/state to the renderer.

### Drive discovery (`drives.ts` + `ipcHandlers.ts`)
etcher-sdk `scanner` adapters (BlockDevice, Usbboot, DriverlessDevice on Windows) push attach/detach events to the renderer; `drivelist` handles listing/partitions and `mountutils` mounting.

## Release Process
Releases follow the IronFlock pattern of [IronFlock/workflows](https://github.com/IronFlock/workflows): nothing is built or published from a laptop.
1. `just release-patch` (or `-minor`/`-major`) bumps `package.json` + `package-lock.json` and opens the release PR `release flockflasher v<x>`. Its CI also runs `release.yml` as a dry run (`release-build`: the Linux and Windows installers built, nothing published).
2. The squash merge runs `.github/workflows/release.yml`: `verify` (harness `release.sh mode`) → `build` (Linux on `ubuntu-22.04` for the glibc floor, Windows; both unsigned) → `publish` (a **draft** GitHub Release with the installers, blockmaps and `latest*.yml`) → `tag` (`release-tag.yml@v1`, release GitHub App) → `finalize` (draft → published, latest). Drafts are invisible to electron-updater, so clients never see a half-uploaded release.
3. All build steps live in `.github/actions/package` (`npm ci`, `just natives`, `just build`, `just installer`), shared by the dry run and the release.
4. The only secret is the release App's key in the repo's `release` environment (main only): `RELEASE_APP_PRIVATE_KEY` (+ var `RELEASE_APP_CLIENT_ID`). `GITHUB_TOKEN` stays read-only; every GitHub write uses the App token.
5. A failed run is re-run; a version abandoned after `publish` leaves a draft to delete (`gh release delete v<x> --yes`).

### macOS
- **Not released.** Notarization needs an Apple Developer Program membership, which has ended (`mac.notarize: false`). Releases carry no `latest-mac.yml`; installed Mac apps stay on v2.1.2, whose updater ignores the resulting check error. `just package` on a Mac (arm64) builds an app for local use only.

### Windows
- The installer is **unsigned** (no certificate): SmartScreen warns on first start, and electron-updater verifies no signature because `app-update.yml` has no `publisherName`. Adding signing later sets `publisherName`, after which every update must be signed by that publisher.
- `winusb-driver-generator` is an `optionalDependencies` entry limited to `win32`. Its native build needs Visual Studio Build Tools; npm does not fail on an optional build error, so the package action asserts the `.node` file exists.
