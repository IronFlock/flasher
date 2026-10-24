# FlockFlasher

All you need to debug the application is:

`npm run dev`

## Rolling out a new version

`main` takes changes only through pull requests whose checks are green. `just release-patch`
(or `-minor`, `-major`) on a feature branch bumps the version in `package.json` and
`package-lock.json`, opens the release pull request and waits for its merge; the merge sets the
tag `v<version>`. Changes that release nothing go in with `just merge`.

Then, on every machine that you wish to create a version on (macOS first, it notarizes), check out
that tag (`git fetch --tags && git switch --detach v<version>`) and run `just release`. It uses
`GH_TOKEN` from the environment or `.env`, else your `gh` login.

The machine itself should do the rest.

On Github, it should automatically create a release entry in the list with the latest version string.

[Releases](https://github.com/IronFlock/flasher/releases)

Before putting the release public, make sure that all releases have been pushed for all devices.

### MacOS  - ! IMPORTANT !

The electron builder release system currently does NOT support automatically combining the `latest-mac.yml` files when releasing the amd64 AND arm versions.

In other words, you have to manually stitch both files together as follows:

```
version: 2.0.3
files:
  - url: FlockFlasher-2.0.3-mac.zip
    sha512: pfNijx9AZuFEzN7/UTDhoKlKeG72A+c3EdGoBE+X6fyn7nO1ZO8McNcZFaExbO0RhN+svnqF6JrWPenIKEfdSQ==
    size: 133448877
  - url: FlockFlasher-2.0.3-arm64-mac.zip
    sha512: 8XOTrqvnGfmM1V9MAivyQ9BPbWyqtkTQ16pZAzSCRUwgLTtRswJZJ0cHIqYw1+6+yRWFdIgQXt1cu6YWkUpWzg==
    size: 128751915
  - url: flockflasher-x64.dmg
    sha512: b9XzDuF/+c3JCA/LLFciLUqyOw12xHmh0vZkZpvS6V8GCzFmz1maEXOkBYAYv9YQLcxhGaM0aMMVuQNiWHgjGg==
    size: 138481744
  - url: flockflasher-arm64.dmg
    sha512: jFZIxhz615EI2autjm4wnKOLGZchSKNOd3zmlRMFXdQjFEIZz6C8szgzjlYyzCfYH5hPOc+EQgbDVPIOla3Zew==
    size: 133845710
path: FlockFlasher-2.0.3-mac.zip
sha512: pfNijx9AZuFEzN7/UTDhoKlKeG72A+c3EdGoBE+X6fyn7nO1ZO8McNcZFaExbO0RhN+svnqF6JrWPenIKEfdSQ==
releaseDate: '2024-01-10T13:54:20.948Z'
```

#### Notarization

In order to notarize the app for MacOS, you need to have the correct keys installed (see specific laptops).

After that, you need to supply a .env file which includes the correct `APPLEID` and `APPLEIDPASS` variables.

The APPLEID would be the email you use to login, and the APPLEIDPASS is the app-specific password that you can generate on your account. ([How to](https://support.apple.com/en-us/102654))

After that, the `npm run release` process will automatically notarize the app for you.

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

In order to access the USB drives in Windows, the `etcher-sdk` must include the `winusb-driver-generator` package. When running the `npm i` command on Windows, it will automatically and temporarily add this package using the `scripts/windows.js` script.

In order for Gulp to be able to build FlockFlasher on Windows, it must compile the underlying winusb driver.

Before you can do this, you must have the [Windows Driver Kit](https://learn.microsoft.com/en-us/windows-hardware/drivers/download-the-wdk) (WDK) installed. This can also be installed as a component during the Visual Studio installation process.

I 

There's a known issue where the `WDF redistributable co-installers don't work`, which is required in order to build the windows usb driver. Solutions can be found [here](https://learn.microsoft.com/en-us/windows-hardware/drivers/wdk-known-issues).

Install python and the Visual Studio Build Tools as well. Install `pip install setuptools`. Also I ended up finding and copying two files into this path:
C:\Program Files (x86)\Windows Kits\10\Redist\wdf\x64

WdfCoInstaller01011.dll
winusbcoinstaller2.dll


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

### Extra binaries

To rebuild the `.iso` image, we use the `xorriso` binary. Unfortunately, this binary is not available on macOS and Windows. Therefore, we provide a statically cross-compiled binary for both Windows and Linux.

These binaries are distributed using the [extraResources](https://www.electron.build/configuration/contents.html#extraresources) property of Electron Builder and are utilized during the flashing process.

You can find the binaries in the `resources/binaries` folder.

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
