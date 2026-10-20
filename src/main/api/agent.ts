import path from 'path'
import { AgentDownloadStatus, FlashItem, Progress } from '../../types'
import { downloadFile } from '../utils'
import { REFLASHER_CONFIG_PATH } from './boards'
import { childProcess, execAsync, spawnAsync } from './permissions'
import fs, { access, mkdir } from 'fs/promises'
import { ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'stream'
import { AVAILABLE_VERSIONS_URL, agentBinaryName, downloadAgentBinary } from './agent-release'

// Names used by earlier builds, when the agent was still called "REagent". They are
// only referenced to clean up leftovers from an existing install.
const LEGACY_FILES = ['reagent', 'reagent.exe', 'reagent.log', 'reagent.db']

type AgentState = 'active' | 'inactive' | 'failed'

export const hasDocker = async () => {
  try {
    await Promise.all([
      execAsync('docker --version', { env: { PATH: process.env.PATH } }),
      execAsync('docker ps', { env: { PATH: process.env.PATH } })
    ])
    return true
  } catch (error) {
    return false
  }
}

class AgentManager extends EventEmitter {
  private logs: string[] = []
  private activeItem: FlashItem | null = null
  private state: AgentState = 'inactive'
  private downloadPromise: Promise<void> | null = null
  // Latest agent-download status, retained so a renderer that subscribes after the
  // startup download already began can pull the current state (see getDownloadStatus).
  private downloadStatus: AgentDownloadStatus = { state: 'idle' }
  private agentProcess: ChildProcessWithoutNullStreams | null = null
  private agentDir = path.join(REFLASHER_CONFIG_PATH, 'agent')
  private availableVersionsURL = AVAILABLE_VERSIONS_URL

  constructor() {
    super()
    // init() does network I/O and a download; without a catch a failure here would
    // surface as an unhandled promise rejection at module load.
    this.init().catch((err) => console.error('Agent initialization failed:', err))
  }

  private async getLatestVersion() {
    const response = await fetch(this.availableVersionsURL)
    if (!response.ok) {
      throw new Error(`Failed to fetch agent versions: HTTP ${response.status}`)
    }

    const res = (await response.json()) as { production?: string }
    if (!res || typeof res.production !== 'string') {
      throw new Error('Malformed agent versions response')
    }

    return res.production
  }

  async createAgentDirIfNotExists() {
    try {
      await access(this.agentDir)
    } catch {
      console.log(`Creating config folder at ${this.agentDir}`)
      try {
        await mkdir(this.agentDir)
      } catch (error) {
        console.log('Could not create agent folder')
        throw error
      }
    }
  }

  get architecture() {
    return process.arch === 'arm64' ? 'arm64' : 'amd64'
  }

  get os() {
    if (process.platform === 'win32') return 'windows'
    return process.platform
  }

  get binaryName() {
    return agentBinaryName(this.os)
  }

  get agentPath() {
    return path.join(this.agentDir, this.binaryName)
  }

  async getAgentVersion() {
    // Use the absolute agentPath, not the bare binary name (which relies on PATH
    // and would never resolve to the downloaded binary in ~/.Reflasher/agent).
    // spawnAsync (no shell) keeps this working when the home dir contains spaces.
    const { stdout } = await spawnAsync(this.agentPath, ['-version'])
    return stdout.trim()
  }

  async stopAgent() {
    if (!this.agentProcess) return

    const success = this.agentProcess.kill('SIGKILL')
    if (success) {
      this.agentProcess = null
      this.logs = []
      this.emit('logs', this.logs)
    } else {
      throw new Error('failed to stop agent process: ' + this.agentProcess.pid)
    }
  }

  async shouldDownloadAgent() {
    try {
      const { stdout } = await spawnAsync(this.agentPath, ['-version'])
      const currentVersion = stdout.trim()

      const latestVersion = await this.getLatestVersion()

      return currentVersion !== latestVersion
    } catch (error) {
      return true
    }
  }

  async startAgent(flashItem: FlashItem) {
    if (this.downloadPromise) {
      await this.downloadPromise
    }

    const isDockerInitialized = await hasDocker()

    if (!isDockerInitialized) throw new Error('docker is not initialized!')

    if (this.agentProcess) throw new Error('an existing agent process is already running!')

    const logFilePath = path.join(this.agentDir, 'device-agent.log')
    const dbFilePath = path.join(this.agentDir, 'device-agent.db')
    const appsDir = path.join(this.agentDir, 'apps')

    await fs.rm(dbFilePath, { force: true })
    await fs.rm(logFilePath, { force: true })

    this.logs = []
    this.emit('logs', this.logs)

    const args = [
      `-dbFileName=${dbFilePath}`,
      `-agentDir=${REFLASHER_CONFIG_PATH}`,
      `-appsDir=${appsDir}`,
      '-config',
      `${flashItem.reswarm!.configPath}`,
      `-logFile=${logFilePath}`,
      '-update=false',
      '-prettyLogging'
    ]

    this.state = 'active'
    this.activeItem = flashItem

    this.emit('state', { state: this.state, activeItem: this.activeItem })

    this.agentProcess = childProcess(
      this.agentPath,
      args,
      (stdout) => {
        this.logs.push(stdout)

        if (this.logs.length === 200) {
          this.logs.splice(0, 1)
        }

        this.emit('logs', this.logs)
      },
      console.error
    )

    this.agentProcess.on('exit', (code) => {
      this.agentProcess = null
      this.activeItem = null

      if (code && code !== 0) {
        this.state = 'failed'
      } else {
        this.state = 'inactive'
      }

      this.emit('state', { state: this.state, activeItem: this.activeItem })
    })
  }

  // Records the latest download status and pushes it to any listener (the main
  // process forwards it to the renderer over 'agent-download-progress').
  private emitDownloadStatus(status: AgentDownloadStatus) {
    this.downloadStatus = status
    this.emit('download-progress', status)
  }

  // Current agent-download status. The renderer pulls this on startup so it can
  // show progress even when the download began before its listener was attached.
  getDownloadStatus(): AgentDownloadStatus {
    return this.downloadStatus
  }

  async init() {
    await this.createAgentDirIfNotExists()

    const shouldDownload = await this.shouldDownloadAgent()
    if (shouldDownload) {
      try {
        this.emitDownloadStatus({ state: 'downloading' })
        await this.downloadAgent((progress) => {
          this.emitDownloadStatus({ state: 'downloading', progress })
        })
        this.emitDownloadStatus({ state: 'finished' })
      } catch (err) {
        // Surface the failure to the UI instead of masking it as 'finished'.
        this.emitDownloadStatus({ state: 'failed' })
        throw err
      } finally {
        this.downloadPromise = null
      }
    }
  }

  async downloadAgent(progress?: (progress: Partial<Progress>) => void) {
    const latestVersion = await this.getLatestVersion()

    if (progress) {
      progress({ averageSpeed: 0, eta: 0, percentage: 0, speed: 0, bytesWritten: 0 })
    }

    // The binary is only moved into place after its SHA-256 matches the published
    // checksum; a mismatch rejects and leaves no file behind.
    this.downloadPromise = downloadAgentBinary(
      {
        os: this.os,
        arch: this.architecture,
        version: latestVersion,
        destPath: this.agentPath,
        progress
      },
      { download: downloadFile }
    ).then(() => this.removeLegacyFiles())

    return this.downloadPromise
  }

  // Best-effort removal of the files an older build left behind under the previous
  // agent name. The log and db are recreated on every start, so nothing is lost.
  private async removeLegacyFiles() {
    await Promise.all(
      LEGACY_FILES.map((name) => fs.rm(path.join(this.agentDir, name), { force: true }))
    ).catch(() => undefined)
  }
}

export const agentManager = new AgentManager()
