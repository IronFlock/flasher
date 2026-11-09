# FlockFlasher

All you need to debug the application is:

`npm run dev`

## Rolling out a new version

`main` takes changes only through pull requests whose checks are green. `just release-patch`
(or `-minor`, `-major`) on a feature branch bumps the version in `package.json` and
`package-lock.json`, opens the release pull request and waits for its merge. Changes that release
nothing go in with `just merge`.

The release pull request also builds the Linux and Windows installers as a dry run (nothing
published), so a broken build never reaches `main`. Its merge runs
[`release.yml`](.github/workflows/release.yml) on GitHub Actions:

1. The Linux and Windows installers are built, one runner each, unsigned.
2. They are uploaded, with the `latest*.yml` files the in-app updater reads, to a **draft**
   [GitHub Release](https://github.com/IronFlock/flasher/releases). The updater does not see drafts.
3. The tag `v<version>` is set, and the draft becomes the published, latest release.

Nothing is built or published from a laptop. A failed release run is re-run from the Actions tab.
A version given up after step 2 leaves a draft behind: delete it with
`gh release delete v<version> --yes`.

`just package` builds the installer of your own OS into `dist/` the same way, without publishing.

### macOS is not released

macOS blocks apps that Apple has not notarized, and notarization needs a membership in the Apple
Developer Program, which has ended. Releases therefore hold no macOS installer. Installed Mac apps
stay on v2.1.2: their updater finds no `latest-mac.yml` in a newer release and offers nothing. On a
Mac, `just package` still builds an app for local use.

### Windows installers are unsigned

The Windows installer carries no code signature. On first start, Windows SmartScreen shows
"Windows protected your PC": choose **More info**, then **Run anyway**. Auto-updates work without a
signature, because the installed app has no publisher name to check updates against.

### Release secrets

The repository's `release` environment (deployments from `main` only) holds the release GitHub
App's key, `RELEASE_APP_PRIVATE_KEY`, and its variable `RELEASE_APP_CLIENT_ID`. The release needs
nothing else. `gh secret list -R IronFlock/flasher -e release` shows the names and dates, never the
values.

## Board catalog

FlockFlasher writes nothing but the IronFlockOS images of one catalog, the signed IronFlockOS catalog. A
device is added by its device file (`.flock`); the user picks the hardware
(menu "Hardware") and then its variant (menu "IronFlockOS variant"). The main process keeps the
verified catalog, looks up the image there by its key (`<image_id>@<version>`, `imageKey` in
`src/shared/images.ts`), downloads it, and checks the catalog's size and SHA-256 before it writes
it. A flash request can name nothing else: no
local image file, path or URL (`assertFlashRequest` in `src/main/security/validation.ts`, checked
by the flash IPC handler and again in `flashDevice`). Files the app opens (file dialog, drag and
drop, file association) are device files only.

### The signed IronFlockOS catalog

`https://instance-registry.ironflock.com/dl/flockos/manifest.json`, published by every IronFlockOS
release ([IronFlockOS ADR-0009](https://github.com/IronFlock/ironflockos/blob/main/docs/adr/0009-phase-2-decisions-hostname-channels-firmware.md),
[schema](https://github.com/IronFlock/ironflockos/blob/main/docs/manifest.schema.json)). It is the
device-agent's envelope, `{"payload": "<base64 of the payload JSON>", "signature": "<base64 of a
64-byte Ed25519 signature>"}`, at most 64 KiB, signed over the lines `flockos-manifest:v1`,
`flockos/manifest.json` and the payload's SHA-256 (lowercase hex), joined by `\n` without a
trailing newline. `src/main/security/catalog.ts` verifies it with Node's `crypto`:

- The trusted keys are compiled in as `FLOCKOS_CATALOG_PUBLIC_KEYS` (the Cloud KMS key
  `ironflock-release/flockos-catalog`, version 1, key id `f5e1308e`;
  [PEM form](https://github.com/IronFlock/ironflockos/blob/main/pki/flockos-catalog.pub)). To rotate,
  release a FlockFlasher that lists both keys before IronFlockOS signs with the new one, and drop the
  old line in a later release.
- A catalog that is unsigned, tampered with, signed by another key, larger than 64 KiB, not JSON,
  of another `schema`, malformed, internally inconsistent (a board's image differs from its
  release) or issued before the one accepted last is refused: the app shows the error and offers
  no board, or, after a failed refresh, the boards verified before. It never falls back to
  unverified data.
- Forward compatible: an image of a `variant`, `kernel` or `architecture` this FlockFlasher does
  not know (from a newer release) is skipped with a log line, and a board left without a known
  image is hidden. Unknown fields are ignored.
- The catalog is fetched at start and again whenever the board list is shown (adding a device,
  opening the board list), at most every 5 minutes, and at once with Retry after an error, so a
  release published while the app is open appears without a restart. Idle devices keep their
  board and variant on the new release.
- The last verified catalog is kept in `~/.Reflasher/flockos-manifest.json`. It is used only when
  the catalog cannot be reached (network or HTTP error), with a notice. The rollback check is
  against the newer of it and the catalog in use.

The `boards` of the catalog show the production release. The menus of a device:

1. "Hardware": the board (its model name).
2. "IronFlockOS variant": the board's images without the installer, `base` (the default), `base` with
   the real-time kernel (`rt`) and `nvidia`.
3. "How to install", only when the board's installer stick carries the chosen variant: write the
   variant's image to the drive (the default; the drive becomes the device's boot disk), or write
   the installer stick, which installs the variant onto the device's internal disk. The stick is
   a way to deliver a variant, not a variant. Its catalog entry lists the image ids it carries
   (`payloads`); a catalog without them (v0.10.0) means the target's base image. Payload ids that
   are not images of the release and target are dropped with a log line.

Every IronFlockOS image is a raw image published as `.img.gz` (schema 1 allows nothing else); size and
SHA-256 are checked on the download, which is then decompressed into `~/.Reflasher` and written
from there. For an installer stick the main process checks that the chosen variant is one of the
stick's payloads in the verified catalog (`CatalogStore.plan`) before it writes anything.

### The device file on the flashed drive

After writing a `.flock` item, FlockFlasher puts the device file onto the FAT partition labelled
`FLOCKOS` (every IronFlockOS image has one, the installer stick included), or, as a fallback, onto the
first FAT partition. It finds the partition by label and file system, not by
order (`src/main/utils/config-partition.ts`), and mounts it if the OS did not:

- Linux: `lsblk` (through sudo when the udev database has no file systems yet), `udisksctl mount`,
  else `mount -t vfat` through sudo into a temporary directory.
- macOS: `diskutil list` and `diskutil info`, `diskutil mount` (through sudo if needed). macOS does
  not mount an EFI system partition by itself, and `FLOCKOS` is the EFI system partition on
  `amd64-efi` and `arm64-efi`.
- Windows: PowerShell's Storage cmdlets list the partitions; a partition without a drive letter
  gets one from `Add-PartitionAccessPath`, or from `diskpart` for an EFI system partition.

The file is synced, and a partition FlockFlasher mounted is unmounted again (on Windows, the drive
letter it assigned is removed). The device gets `<name>.flock` only;
its enroll removes the file after use, so no copy with the device's credentials is left behind.
An installer stick also gets `installer.conf` with the one line `payload=<image id>` (the chosen
variant); every other key keeps the installer's default (`confirm=yes`: it asks on the console
before it writes).

## EtcherSDK

FlockFlasher uses the etcher-sdk to flash and mount drives.

The `etcher-sdk` requires root permissions to access drives and flash drives.

In the current build for MacOS and Linux, we must spawn a subprocess within the FlockFlasher that gets elevated.

The easiest way to do that is to spawn a root process using sudo. This process will be a node process that runs the `etcher-sdk` code.

To do so, we create an external JavaScript script that uses the `etcher-sdk`. This script needs to point to the node_modules that are contained within the application (for production). To do so, we point to the compressed (ASAR) node_modules [in the code](https://github.com/IronFlock/flasher/blob/3400ca34a438af2653ee1dfc364cd3f066cdc7fd/src/main/api/flash.ts#L121).


To learn more about the compressed ASAR package: https://www.electronjs.org/docs/latest/tutorial/asar-archives


Since we don't want to rely on the user having the `node` binary installed, we can use the `electron` binary that comes with the application and run that as a node process to spawn an elevated process.

The electron binary can be accessed on `process.execPath` within the application and can be put into 'node mode' using the `ELECTRON_RUN_AS_NODE` environment variable.

Since we spawn a subprocess, we need to be able to read back the flashing progress of this subprocess. To do so, we print the progress data to the stdout in JSON string, which is then read and parsed in the frontend. ([Line in code](https://github.com/IronFlock/flasher/blob/3400ca34a438af2653ee1dfc364cd3f066cdc7fd/src/main/api/flash.ts#L154))


### Windows

In order to access the USB drives in Windows, the `etcher-sdk` must include the `winusb-driver-generator` package. It is an optional dependency limited to Windows, so `npm install` adds it on Windows only.

Its native module compiles during `npm install`, which needs Python and the Visual Studio Build Tools (the GitHub-hosted Windows runner has both). The package bundles the WDK co-installer files it needs. npm does not fail when an optional dependency fails to build, so check that `node_modules/winusb-driver-generator/build/Release` holds a `.node` file; the release build fails without one.


### AppImages (Linux)

For AppImages, it is sadly not straightforward to access the packaged node_modules within the application. Since the AppImage is technically a drive, we must first mount it to a temporary folder ([link to code](https://github.com/IronFlock/flasher/blob/3400ca34a438af2653ee1dfc364cd3f066cdc7fd/src/main/api/permissions.ts#L169)) and then access the packaged node modules within.


## Electron / Vue

### API

Electron uses an RPC API to facilitate communication between frontend and backend tasks. All operations requiring system API calls must be executed on the Electron backend.

To streamline this process, we have defined a types file (`types/index.ts`) that contains all the RPC endpoints. These endpoints can be called from the frontend and are executed on the backend.

The RPCs that are executed on the backend are defined in `main/ipcHandlers.ts`, while the frontend RPCs, defined in `preload/index.ts`, simply call the RPCs registered on the backend.

### Store

We use [Pinia](https://github.com/vuejs/pinia), a straightforward and simple global state management tool, to manage global state in the Vue frontend. Event listeners and backend API calls are made and registered within Pinia. All stores are located in the `renderer/src/store` folder.

### Translations

For app-wide translations, we utilize the `I18next` internationalization framework. Adding, updating, creating, and deleting translations is as simple as creating or editing a file in the `renderer/locales` folder and then registering the new languages in the `renderer/src/main.ts` file.

## Flashing runtime (why there is a bundled Node binary)

The app runs on **Electron 43 with etcher-sdk 10** (Node 22 via `.nvmrc`). The old Electron-19
pin existed because etcher-sdk breaks on Electron 20+ (https://github.com/balena-io/etcher/issues/4087):
Electron's **V8 memory cage** (Electron 21+) forbids the *external buffers* that etcher-sdk's
`@ronomon/direct-io` needs for `O_DIRECT` block writes, so running the flasher via
`ELECTRON_RUN_AS_NODE` aborts (`napi_create_external_buffer` assertion).

The fix: the elevated flash + unmount subprocesses run under a **bundled standalone Node binary**
(no memory cage), fetched per-platform by `scripts/fetch-node.js` (postinstall, git-ignored) into
`resources/binaries/<platform>/`. The flash-path native deps that are N-API (`drivelist`,
`@ronomon/direct-io`, `xxhash-addon`) work under both runtimes unchanged; `mountutils` (nan) is
rebuilt for the bundled Node's ABI by `scripts/rebuild-flash-natives.js` (postinstall, after
`install-app-deps`; CI skips these packaging steps, see `scripts/postinstall.js`). Keep `NODE_VERSION` in sync between those two scripts. When upgrading Electron,
bump both `package.json` `electron` and `electron-builder.yml` `electronVersion`.

The native modules (`drivelist`, `mountutils`) compile from source on macOS, so `npm install`
needs a complete Command Line Tools install. If it fails with `'functional'`/`'cstdlib' file not
found`, the CLT is missing its C++ stdlib headers — reinstall it:
`sudo rm -rf /Library/Developer/CommandLineTools && sudo xcode-select --install`.

On Linux, GCC fails on Electron 43's V8 headers with `expected identifier before '__attribute__'`
when deprecation warnings are on, which node-gyp turns on for every addon.
`scripts/prepare-natives.js` turns them off for the Electron build on Linux. The `usb` module
also needs the udev headers: `sudo apt-get install libudev-dev`.
