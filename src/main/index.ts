import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { sendToRenderer, setupIpcHandlers, stopDriveScanner } from './ipcHandlers'
import { join } from 'path'
import { setTimeout as sleep } from 'timers/promises'
import { activeProcesses, cleanupAppImageIfExists } from './api/permissions'
import { whenDrivelistIdle } from './api/drives'
import { isFile, killProcessDarwin } from './utils'
import { isConfigFileName } from '../shared/images'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log/main'
import fixPath from 'fix-path'
import semver from 'semver'
import installExtension from 'electron-devtools-installer'
import { version } from '../../package.json'
import icon from '../../resources/icon.png?asset'

// Initialization
log.initialize({ preload: true })
autoUpdater.autoDownload = false
fixPath()

const setupAutoUpdate = (mainWindow: BrowserWindow) => {
  const page = mainWindow.webContents

  page.once('did-frame-finish-load', async () => {
    autoUpdater.on('error', (err) => {
      sendToRenderer(mainWindow, 'update-status', { error: err })
    })

    autoUpdater.on('checking-for-update', () => {})
    autoUpdater.on('update-available', (info) => {
      const comparison = semver.compare(info.version, version)
      if (comparison > 0) {
        sendToRenderer(mainWindow, 'update-status', { state: 'update-available' })
      }
    })

    autoUpdater.on('download-progress', (progressObj) => {
      sendToRenderer(mainWindow, 'update-status', {
        state: 'update-progress',
        progress: progressObj
      })
    })

    autoUpdater.on('update-downloaded', () => {
      sendToRenderer(mainWindow, 'update-status', { state: 'update-downloaded' })
    })

    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Failed to check for updates:', err)
    })
  })

  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Failed to check for updates:', err)
    })
  }, 60000)
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 600,
    frame: true,
    resizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      // The renderer only reaches the main process through the contextBridge in
      // preload, so it does not need Node in-process. Disabling nodeIntegration and
      // enabling contextIsolation means an XSS/renderer flaw can no longer touch
      // Node/root directly. sandbox stays false because the preload currently
      // require()s bundled deps; enabling it needs a self-contained preload and is
      // tracked with the Electron upgrade spike.
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Confine the top frame to the app's own content; anything else (a redirect to a
  // remote origin, a dropped file:// URL) is refused. External links are already
  // routed to the OS browser by setWindowOpenHandler below.
  const isAppUrl = (url: string): boolean => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (is.dev && rendererUrl) return url.startsWith(rendererUrl)
    return url.startsWith('file://')
  }
  const blockOffAppNavigation = (event: Electron.Event, url: string) => {
    if (!isAppUrl(url)) {
      event.preventDefault()
      console.warn('Blocked navigation to', url)
    }
  }
  mainWindow.webContents.on('will-navigate', blockOffAppNavigation)
  mainWindow.webContents.on('will-redirect', blockOffAppNavigation)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.setTitle(`FlockFlasher v${version}`)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  setupIpcHandlers(mainWindow)

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  setupAutoUpdate(mainWindow)

  return mainWindow
}

const imageItemListReady = new Promise((res) => ipcMain.on('image-item-store-ready', res))

async function handleArguments(argv: string[]) {
  if (process.platform === 'linux' || process.platform === 'win32') {
    const parameters = argv.slice(app.isPackaged ? 1 : 2)

    if (!parameters.length) return

    const param = parameters[parameters.length - 1]
    if (param.startsWith('--')) {
      return
    }

    // Device files only: FlockFlasher flashes no local image files.
    if (!isConfigFileName(param) || !(await isFile(param))) return

    await imageItemListReady

    BrowserWindow.getAllWindows().forEach((window) =>
      window.webContents.send('add-image-item', { filePath: param })
    )
  }
}

app.on('before-quit', () => {
  app.releaseSingleInstanceLock()
})

app.setAsDefaultProtocolClient('flock')
app.on('open-file', async (event, path) => {
  event.preventDefault()

  if (!isConfigFileName(path) || !(await isFile(path))) return

  await imageItemListReady

  BrowserWindow.getAllWindows().forEach((window) =>
    window.webContents.send('add-image-item', { filePath: path })
  )
})

// FlockFlasher is a single-window tool: closing the window quits it on every
// platform, macOS included. Kept alive without a window, the drive scanner, the
// agent and the updater went on sending to the destroyed window ("Object has
// been destroyed"), and a click on the dock icon created a second window whose
// IPC handlers were already registered.
app.on('window-all-closed', () => {
  app.quit()
})

// The subprocesses still running: a flash or an unmount (root, through sudo)
// and the device agent. On macOS a root process can only be signalled through
// sudo; without a sudo password the plain kill still reaches the agent.
async function killActiveProcesses() {
  const kills = [...activeProcesses].map(async (p) => {
    if (process.platform === 'darwin' && p.pid) {
      await killProcessDarwin(9, p.pid).catch(() => p.kill('SIGKILL'))
    } else {
      p.kill('SIGKILL')
    }
  })
  await Promise.allSettled(kills)
}

const SHUTDOWN_TIMEOUT_MS = 5000

// Runs before every quit (the window closed, Cmd+Q, quitAndInstall): stop the
// drive scanner, kill the subprocesses, undo the AppImage mount and wait for the
// drivelist calls still running, which abort the app if they return during the
// teardown (api/drives.ts trackDrivelistCall). At most SHUTDOWN_TIMEOUT_MS, so a
// hung call cannot keep the app from quitting.
async function shutDown() {
  stopDriveScanner()
  const cleanup = Promise.allSettled([
    killActiveProcesses().then(cleanupAppImageIfExists),
    whenDrivelistIdle()
  ])
  const timedOut = await Promise.race([
    cleanup.then(() => false),
    sleep(SHUTDOWN_TIMEOUT_MS, true, { ref: false })
  ])
  if (timedOut) console.warn(`Quitting before the cleanup finished (${SHUTDOWN_TIMEOUT_MS} ms)`)
}

let shutdown: 'pending' | 'running' | 'done' = 'pending'
app.on('will-quit', (event) => {
  if (shutdown === 'done') return
  event.preventDefault()
  if (shutdown === 'running') return
  shutdown = 'running'
  shutDown().finally(() => {
    shutdown = 'done'
    app.quit()
  })
})

async function main() {
  if (!app.requestSingleInstanceLock()) return app.quit()

  await app.whenReady()

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.ironflock.flockflasher') // = electron-builder.yml appId

  if (is.dev) {
    // Installing Vue devtools downloads a .crx from the Chrome Web Store, which can
    // fail (e.g. "Invalid header: Does not start with Cr24"). It must never block
    // startup — a failed devtools install previously rejected main() before
    // createWindow(), so no window appeared in dev.
    try {
      await installExtension('nhdogjmejiglipccpnnnanhbledajbpd', {
        loadExtensionOptions: {
          allowFileAccess: true
        }
      })
    } catch (err) {
      console.warn('Skipping Vue devtools install (continuing without it):', err)
    }
  }

  const window = createWindow()
  app.on('second-instance', async (_event, argv) => {
    // The window is gone only while the app quits.
    if (window.isDestroyed()) return
    if (window.isMinimized()) {
      window.restore()
    }
    window.focus()

    await handleArguments(argv)
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await handleArguments(process.argv)
}

main()
