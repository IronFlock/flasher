import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { RPC } from '../types'
import type { AgentDownloadStatus, BoardCatalogs, FlashItem } from '../types'
import type { Drive } from 'drivelist'
import type { WiFiNetwork } from 'node-wifi'

// Only these push channels may cross the bridge. Renderer -> main is limited to a
// single ready signal; main -> renderer is the fixed set of progress/event
// channels. An arbitrary channel name from the renderer is ignored, so the bridge
// can't be used to reach unrelated ipcMain listeners.
const SEND_CHANNELS = ['image-item-store-ready'] as const
const RECEIVE_CHANNELS = [
  'add-image-item',
  'flash-progress',
  'agent-logs',
  'agent-state',
  'agent-download-progress',
  'drive-scanner-attach',
  'drive-scanner-detach',
  'drive-scanner-progress',
  'drive-scanner-error',
  'update-status'
] as const

// Custom APIs for renderer
const api = {
  listDrives: () => ipcRenderer.invoke(RPC.ListDrives) as Promise<Drive[]>,
  listPartitions: (drive: Drive, password?: string) =>
    ipcRenderer.invoke(RPC.ListPartitions, drive, password),
  unmount: (path: string) => ipcRenderer.invoke(RPC.Unmount, path) as Promise<void>,
  mount: (drive: Drive) => ipcRenderer.invoke(RPC.Mount, drive) as Promise<void>,
  chooseFile: () => ipcRenderer.invoke(RPC.ChooseFile) as Promise<Electron.OpenDialogReturnValue>,
  // Scoped in the main process to .flock config files; returns utf8 text.
  readFile: (path: string) => ipcRenderer.invoke(RPC.ReadFile, path) as Promise<string>,
  // Electron 32+ removed File.path; getPathForFile is the supported way to resolve
  // the absolute path of a drag-and-dropped file from the renderer.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  // Throttled in the main process (5 minutes); force: an explicit retry.
  getSupportedBoards: (force = false) =>
    ipcRenderer.invoke(RPC.GetSupportedBoards, force) as Promise<BoardCatalogs>,
  scanWifi: () => ipcRenderer.invoke(RPC.ScanWifi) as Promise<WiFiNetwork[]>,
  testDevice: (flashItem: FlashItem) => ipcRenderer.invoke(RPC.TestDevice, flashItem),
  stopDevice: () => ipcRenderer.invoke(RPC.StopDevice),
  getAgentDownloadStatus: () =>
    ipcRenderer.invoke(RPC.GetAgentDownloadStatus) as Promise<AgentDownloadStatus>,
  flashDevice: (flashItem: FlashItem) => ipcRenderer.invoke(RPC.FlashDevice, flashItem),
  cancelFlashing: (id: number) => ipcRenderer.invoke(RPC.CancelFlashing, id),
  setSudoPassword: (password: string) => ipcRenderer.invoke(RPC.SetSudoPassword, password),
  isSudoPasswordSet: () => ipcRenderer.invoke(RPC.IsSudoPasswordSet) as Promise<boolean>,
  getPlatform: () => ipcRenderer.invoke(RPC.GetPlatform) as Promise<string>,
  hasDocker: () => ipcRenderer.invoke(RPC.HasDocker) as Promise<boolean>,
  downloadUpdate: () => ipcRenderer.invoke(RPC.DownloadUpdate) as Promise<void>,
  installUpdate: () => ipcRenderer.invoke(RPC.InstallUpdate) as Promise<void>
}

export type Api = typeof api

// Context isolation must be on (it is set explicitly on the BrowserWindow). If it
// is ever disabled, fail loudly rather than silently dumping the full electronAPI
// and a raw ipcRenderer onto window — the old else-branch defeated the bridge.
if (!process.contextIsolated) {
  throw new Error('contextIsolation must be enabled')
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
  contextBridge.exposeInMainWorld('ipcRenderer', {
    send: (channel: string, data: unknown) => {
      if (!(SEND_CHANNELS as readonly string[]).includes(channel)) return
      ipcRenderer.send(channel, data)
    },
    receive: (channel: string, func: (...args: unknown[]) => void) => {
      if (!(RECEIVE_CHANNELS as readonly string[]).includes(channel)) return
      ipcRenderer.on(channel, (_, ...args) => func(...args))
    }
  })
} catch (error) {
  console.error(error)
}
