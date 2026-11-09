import { BrowserWindow, OpenDialogOptions, dialog, ipcMain } from 'electron'
import { FlashItem, RPC } from '../types'
import {
  automountDrive,
  listDrives,
  listPartitions,
  trackDrivelistCall,
  unmountDisk
} from '../main/api/drives'
import { scanner } from 'etcher-sdk'
import { readFile, stat } from 'fs/promises'
import path from 'path'
import { scanNetworks } from './api/wifi'
import { cancelFlashing, catalogStore, flashDevice } from './api/flash'
import { isSudoPasswordSet, setSudoPassword } from './api/permissions'
import { Drive } from 'drivelist'
import { agentManager, hasDocker } from './api/agent'
import { autoUpdater } from 'electron-updater'
import {
  assertFlashRequest,
  assertValidDevicePath,
  assertValidFlockConfig
} from './security/validation'
import { FILE_DIALOG_EXTENSIONS } from '../shared/images'

// Config files the renderer is allowed to read back through RPC.ReadFile.
const READABLE_CONFIG_EXTENSIONS = ['.flock']
// Cap on a config file read so a malicious path can't stream a huge file into memory.
const MAX_CONFIG_READ_BYTES = 5 * 1024 * 1024

// Cross-check a renderer-supplied drive against the real removable-drive list so a
// compromised renderer can't aim a privileged write at an arbitrary/system disk.
// Returns the matched drivelist Drive so the caller flashes the trusted, freshly
// enumerated object (correct raw/device/size/blockSize) rather than trusting the
// renderer-supplied fields.
async function assertFlashableDrive(drive: Drive | undefined): Promise<Drive> {
  const device = assertValidDevicePath(drive?.device)
  const available = await listDrives()
  const match = available.find((d) => d.device === device)
  if (!match) {
    throw new Error(`Selected drive is not an available removable drive: ${device}`)
  }
  return match
}

// Push an event to the renderer. The scanner, the agent and the updater go on
// emitting while the app quits, after the window has closed, and a send to a
// destroyed window throws "Object has been destroyed" in the main process.
export function sendToRenderer(window: BrowserWindow, channel: string, payload: unknown) {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(channel, payload)
}

function handleListDrives() {
  return listDrives()
}

function handleUnmount(_, drivePath: string) {
  assertValidDevicePath(drivePath)
  unmountDisk(drivePath)
  return
}

function handleMount(_, drive: Drive) {
  assertValidDevicePath(drive?.device)
  return automountDrive(drive)
}

function handleGetPlatform() {
  return process.platform
}

// etcher-sdk's BlockDeviceAdapter lists the drives every second, and its stop()
// only clears a flag: a drivelist call already running goes on running. Its
// (private) listDrives is wrapped so the quit can wait for that call as well
// (trackDrivelistCall in api/drives.ts says why it must).
function trackScans(adapter: scanner.adapters.BlockDeviceAdapter) {
  const scans = adapter as unknown as { listDrives?: () => Promise<unknown> }
  const listDrives = scans.listDrives?.bind(adapter)
  if (!listDrives) {
    console.error('etcher-sdk BlockDeviceAdapter has no listDrives: a quit during a scan may abort')
    return adapter
  }
  scans.listDrives = () => trackDrivelistCall(listDrives())
  return adapter
}

let deviceScanner: scanner.Scanner | undefined

export function stopDriveScanner() {
  deviceScanner?.stop()
  deviceScanner = undefined
}

function handleDriveScanner(mainWindow: BrowserWindow) {
  const adapters: scanner.adapters.Adapter[] = [
    trackScans(
      new scanner.adapters.BlockDeviceAdapter({
        includeSystemDrives: () => true
      })
    ),
    new scanner.adapters.UsbbootDeviceAdapter()
  ]
  if (process.platform === 'win32') {
    if (scanner.adapters.DriverlessDeviceAdapter !== undefined) {
      adapters.push(new scanner.adapters.DriverlessDeviceAdapter())
    }
  }
  deviceScanner = new scanner.Scanner(adapters)
  deviceScanner.on('attach', async (drive: scanner.adapters.AdapterSourceDestination) => {
    sendToRenderer(mainWindow, 'drive-scanner-attach', drive)
    if (drive.emitsProgress) {
      drive.on('progress', (progress: number) => {
        sendToRenderer(mainWindow, 'drive-scanner-progress', { drive, progress })
      })
    }
  })
  deviceScanner.on('detach', (drive: scanner.adapters.AdapterSourceDestination) => {
    sendToRenderer(mainWindow, 'drive-scanner-detach', drive)
  })
  deviceScanner.on('error', (error: Error) => {
    sendToRenderer(mainWindow, 'drive-scanner-error', error)
  })
  deviceScanner.start()
}

function handleChooseFile(mainWindow: BrowserWindow) {
  const options: OpenDialogOptions = {
    title: 'Select file',
    defaultPath: process.env.HOME + '/Downloads',
    filters: [
      {
        name: 'Device files (.flock)',
        extensions: FILE_DIALOG_EXTENSIONS
      }
    ],
    properties: ['openFile', 'multiSelections']
  }

  return dialog.showOpenDialog(mainWindow, options)
}

// Scoped config reader. This used to be an arbitrary-file-read primitive exposed
// to the renderer; it now only reads .flock config files, as utf8, with a
// size cap — the sole legitimate use (parsing the config being flashed).
async function handleReadFile(_, filePath: string) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Invalid file path')
  }

  const ext = path.extname(filePath).toLowerCase()
  if (!READABLE_CONFIG_EXTENSIONS.includes(ext)) {
    throw new Error(`Refusing to read non-config file: ${ext || '(no extension)'}`)
  }

  const info = await stat(filePath)
  if (!info.isFile()) throw new Error('Not a regular file')
  if (info.size > MAX_CONFIG_READ_BYTES) throw new Error('Config file too large')

  return readFile(filePath, { encoding: 'utf8' })
}

// The boards of the signed IronFlockOS catalog, fetched and verified again when
// the last load is more than 5 minutes old, or now with `force` (a retry).
// A catalog that does not verify comes back as an error, with the boards
// verified before, if any.
function handleSupportedBoards(force: unknown) {
  return catalogStore.refresh({ force: force === true })
}

function handleWifiScan() {
  return scanNetworks()
}

async function handleFlashDevice(_, mainWindow: BrowserWindow, flashItem: FlashItem) {
  // A device file and the key of an IronFlockOS catalog image, nothing else: no
  // local image file, path or URL. The image is resolved, downloaded and
  // checked from the verified catalog in flashDevice.
  assertFlashRequest(flashItem)
  // Flash the trusted, freshly enumerated drive object, not the renderer-supplied one.
  flashItem.drive = await assertFlashableDrive(flashItem.drive)

  return flashDevice(flashItem, (progress) => {
    sendToRenderer(mainWindow, 'flash-progress', { progress, id: flashItem.id })
  })
}

function handleAgentEvents(mainWindow: BrowserWindow) {
  agentManager.on('logs', (logs) => {
    sendToRenderer(mainWindow, 'agent-logs', { logs })
  })

  agentManager.on('state', ({ activeItem, state }) => {
    sendToRenderer(mainWindow, 'agent-state', { activeItem, state })
  })

  agentManager.on('download-progress', ({ progress, state }) => {
    sendToRenderer(mainWindow, 'agent-download-progress', { progress, state })
  })
}

async function handleTestDevice(flashItem: FlashItem) {
  const configPath = flashItem?.flock?.configPath
  if (
    typeof configPath !== 'string' ||
    !READABLE_CONFIG_EXTENSIONS.includes(path.extname(configPath).toLowerCase())
  ) {
    throw new Error('Invalid or missing device config path')
  }
  if (flashItem.flock?.config) {
    assertValidFlockConfig(flashItem.flock.config)
  }
  return agentManager.startAgent(flashItem)
}

function handleStopDevice() {
  return agentManager.stopAgent()
}

function handleGetAgentDownloadStatus() {
  return agentManager.getDownloadStatus()
}

async function handleHasDocker() {
  return hasDocker()
}

function handleSetSudoPassword(password: string) {
  return setSudoPassword(password)
}

function handleIsSudoPasswordSet() {
  return isSudoPasswordSet()
}

function handleDownloadUpdate() {
  return autoUpdater.downloadUpdate()
}

function handleInstallUpdate() {
  return autoUpdater.quitAndInstall()
}

function handleCancelFlashing(id: number) {
  return cancelFlashing(id)
}

function handleListPartitions(drive: Drive) {
  assertValidDevicePath(drive?.device)
  return listPartitions(drive)
}

export function setupIpcHandlers(mainWindow: BrowserWindow) {
  ipcMain.handle(RPC.ListDrives, handleListDrives)
  ipcMain.handle(RPC.ListPartitions, (_, drive) => handleListPartitions(drive))
  ipcMain.handle(RPC.Unmount, handleUnmount)
  ipcMain.handle(RPC.Mount, handleMount)
  ipcMain.handle(RPC.ChooseFile, () => handleChooseFile(mainWindow))
  ipcMain.handle(RPC.ReadFile, handleReadFile)
  ipcMain.handle(RPC.GetSupportedBoards, (_, force) => handleSupportedBoards(force))
  ipcMain.handle(RPC.ScanWifi, handleWifiScan)
  ipcMain.handle(RPC.FlashDevice, (_, flashItem) => handleFlashDevice(_, mainWindow, flashItem))
  ipcMain.handle(RPC.SetSudoPassword, (_, password) => handleSetSudoPassword(password))
  ipcMain.handle(RPC.IsSudoPasswordSet, handleIsSudoPasswordSet)
  ipcMain.handle(RPC.CancelFlashing, (_, id) => handleCancelFlashing(id))
  ipcMain.handle(RPC.GetPlatform, handleGetPlatform)
  ipcMain.handle(RPC.TestDevice, (_, flashItem) => handleTestDevice(flashItem))
  ipcMain.handle(RPC.StopDevice, handleStopDevice)
  ipcMain.handle(RPC.GetAgentDownloadStatus, handleGetAgentDownloadStatus)
  ipcMain.handle(RPC.HasDocker, handleHasDocker)
  ipcMain.handle(RPC.DownloadUpdate, handleDownloadUpdate)
  ipcMain.handle(RPC.InstallUpdate, handleInstallUpdate)

  handleDriveScanner(mainWindow)
  handleAgentEvents(mainWindow)
}
