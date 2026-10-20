import type { Drive } from 'drivelist'
import type { WriteStep } from 'etcher-sdk/build/multi-write'

export const imageTypes = ['flock', 'reswarm', 'iso', 'img'] as const
export type ImageType = (typeof imageTypes)[number]

export enum RPC {
  ListDrives = 'list-drives',
  ListPartitions = 'list-partitions',
  Unmount = 'unmount',
  Mount = 'mount',
  ChooseFile = 'choose-file',
  ReadFile = 'read-file',
  GetSupportedBoards = 'get-supported-boards',
  ScanWifi = 'scan-wifi',
  FlashDevice = 'flash-device',
  CancelFlashing = 'cancel-flashing',
  SetSudoPassword = 'set-sudo-password',
  IsSudoPasswordSet = 'isset-sudo-password',
  GetPlatform = 'get-platform',
  TestDevice = 'test-device',
  StopDevice = 'stop-device',
  GetAgentDownloadStatus = 'get-agent-download-status',
  HasDocker = 'has-docker',
  HasUpdate = 'has-update',
  UpdateStatus = 'update-status',
  DownloadUpdate = 'download-update',
  InstallUpdate = 'install-update'
}

export type ImageInfo = {
  buildtime: string
  download: string
  file: string
  osname: string
  osvariant: string
  sha256: string
  size: number
  update: string
  version: string
}

export type SupportedBoard = {
  architecture: string
  board: string
  docs: string
  reflasher: boolean
  boardname: string
  cpu: string
  latestImages: ImageInfo[]
  model: string
  modelname: string
}

export type ReswarmConfig = {
  name: string
  board: {
    cpu: string
    docs: string
    board: string
    latestImages: ImageInfo[]
    model: string
    boardname: string
    modelname: string
    reflasher: boolean
    architecture: string
  }
  secret: string
  status: string
  password: string
  wlanssid: string
  swarm_key: number
  device_key: number
  swarm_name: string
  description: string
  architecture: string
  serial_number: string
  authentication: {
    key: string
    certificate: string
  }
  swarm_owner_name: string
  config_passphrase: string
  device_endpoint_url: string
  docker_registry_url: string
  docker_main_repository: string
  owner_account_key: number
}

export type FlashState =
  | WriteStep
  | 'idle'
  | 'failed'
  | 'flashing-canceled'
  | 'verification-canceled'
  | 'downloading'
  | 'configuring'
  | 'starting'
  | 'extracting-iso'
  | 'recreating-iso'

export type Progress = {
  canceled: boolean
  position: number
  bytes: number
  speed: number
  averageSpeed: number
  active: number
  failed: number
  type: FlashState
  sparse: boolean
  size: number
  bytesWritten: number
  percentage: number
  eta: number
}

// Progress of the background IronFlock device agent binary download.
export type AgentDownloadState = 'idle' | 'downloading' | 'finished' | 'failed'
export type AgentDownloadStatus = { state: AgentDownloadState; progress?: Partial<Progress> }

export type FlashItem = {
  id: number
  fullPath: string
  reswarm?: {
    configPath?: string
    config?: ReswarmConfig
    board?: SupportedBoard
    wifiPassword?: string
    wifiSSID?: string
    showPassword?: boolean
  }
  flash: {
    state: FlashState
    progress: number
    avgSpeed: number
    speed: number
    eta: number
  }
  fileDirectory: string
  fileName: string
  fileType: string
  drive?: Drive
}
