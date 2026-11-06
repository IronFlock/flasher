import type { Drive } from 'drivelist'
import type { WriteStep } from 'etcher-sdk/build/multi-write'

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

// Boards and images come from the signed FlockOS catalog
// (dl/flockos/manifest.json, see the README "Board catalogs"); its boards view
// keeps the shape of FlockFlasher's earlier catalog.
export type ImageVariant = 'base' | 'nvidia' | 'installer'
export type ImageKernel = 'std' | 'rt'

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
  // manifest schema 1: the variant choice
  image_id: string
  variant: ImageVariant
  kernel: ImageKernel
  // installer images only: the image ids the stick carries
  payloads?: string[]
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

// What RPC.GetSupportedBoards returns. A catalog that does not verify yields
// no boards and an error, never unverified boards.
export type FlockOSCatalogStatus =
  | { ok: true; production: string; issuedAt: string; fromCache: boolean }
  // kept: the last verified catalog, still offered after a refresh failed
  | {
      ok: false
      code: string
      error: string
      kept?: { production: string; issuedAt: string }
    }

export type BoardCatalogs = {
  boards: SupportedBoard[]
  flockos: FlockOSCatalogStatus
}

export type FlockConfig = {
  name: string
  // Today's .flock files carry no board; FlockFlasher sets the one chosen.
  board?: SupportedBoard
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
  flock?: {
    configPath?: string
    config?: FlockConfig
    board?: SupportedBoard
    // imageKey (src/shared/images.ts) of the variant chosen from the board.
    imageKey?: string
    // Set to install through the board's installer stick (its imageKey)
    // instead of writing the variant's image to the drive.
    installerKey?: string
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
