import { spawn, exec, SpawnOptionsWithoutStdio, ExecOptions, ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { fileExists, getNodeBinaryPath } from '../utils'
import { is } from '@electron-toolkit/utils'
import { buildSudoArgs } from '../security/args'

export const APPIMAGE_MOUNT_POINT = path.join(tmpdir(), 'ReflasherAppImage')

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let sudoPassword = ''
let sudoPasswordSet = false

export const activeProcesses: ChildProcess[] = []

export const setSudoPassword = async (password: string) => {
  sudoPassword = password
  sudoPasswordSet = true

  const isValidSudoPassword = await isSudoPasswordSet()

  if (!isValidSudoPassword) {
    sudoPassword = ''
    sudoPasswordSet = false

    throw new Error('invalidPassword')
  }
}

export const isSudoPasswordSet = async (): Promise<boolean> => {
  if (!sudoPassword) return false
  try {
    await elevatedSpawn('ls')
    return true
  } catch (error) {
    return false
  }
}

export const getSudoPassword = () => {
  if (!sudoPasswordSet) throw new Error('sudo password not set')
  return sudoPassword
}

// `useBundledNode` runs the script under the bundled standalone Node binary instead
// of the Electron binary in ELECTRON_RUN_AS_NODE mode. The flash and unmount paths
// both use it: the flash needs it because Electron's V8 memory cage rejects the
// external buffers etcher-sdk/direct-io needs; the unmount needs it because
// mountutils (nan) is rebuilt for the bundled Node's ABI, not Electron's.
export const elevatedNodeChildProcess = (
  code: string,
  scriptArgs: string[] = [],
  onStdout?: (data: string) => void,
  onStderr?: (data: string) => void,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  options?: SpawnOptionsWithoutStdio,
  useBundledNode = false
) => {
  const platform = process.platform
  if (platform === 'darwin' || platform === 'linux') {
    return elevatedNodeChildProcessUnix(
      code,
      scriptArgs,
      onStdout,
      onStderr,
      onExit,
      options,
      useBundledNode
    )
  }

  // No need to elevate the child process in Windows as the Windows app will run in elevated mode anyways
  return nodeChildProcessWindows(code, scriptArgs, onStdout, onStderr, onExit, options, useBundledNode)
}

// Env for the bundled-node subprocess: a copy of the parent env with the Electron
// node flag removed (the bundled binary is real Node, not Electron).
const bundledNodeEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

export const execAsync = async (
  command: string,
  options?: {
    encoding?: BufferEncoding
  } & ExecOptions
): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((res, rej) => {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- callers pass constant commands only (docker --version, docker ps)
    exec(command, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        rej(error)
        return
      }

      res({ stdout, stderr })
    })
  })
}

export type SpawnResult = {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
}

// Run a command with an explicit argv array and no shell. This is the safe
// replacement for the old string-based elevatedExec/elevatedExecUnix.
export const elevatedSpawn = async (command: string, args: string[] = []): Promise<SpawnResult> => {
  // On Windows the app already runs elevated, so no sudo wrapper is needed.
  if (process.platform === 'win32') {
    return spawnAsync(command, args)
  }
  return spawnAsync('sudo', buildSudoArgs(command, args), getSudoPassword())
}

// Non-shell spawn returning collected stdout/stderr. `stdin`, if provided, is
// written and the stream closed (used to feed the sudo password).
export const spawnAsync = async (
  command: string,
  args: string[] = [],
  stdin?: string,
  options?: SpawnOptionsWithoutStdio
): Promise<SpawnResult> => {
  return new Promise((res, rej) => {
    const stdoutData: string[] = []
    const stderrData: string[] = []
    let error: Error | undefined

    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- an argv array, no shell
    const childProcess = spawn(command, args, options)
    activeProcesses.push(childProcess)

    if (stdin !== undefined) {
      childProcess.stdin.write(stdin)
      childProcess.stdin.end()
    }

    const removeFromActive = () => {
      const idx = activeProcesses.indexOf(childProcess)
      if (idx !== -1) activeProcesses.splice(idx, 1)
    }

    childProcess.stdout.on('data', (data) => stdoutData.push(data.toString()))
    childProcess.stderr.on('data', (data) => stderrData.push(data.toString()))

    // A spawn failure (e.g. ENOENT for a missing binary) emits 'error' but never
    // 'exit', so the promise must be rejected here or it would hang forever.
    childProcess.on('error', (err) => {
      error = err
      removeFromActive()
      rej({
        error,
        code: null,
        signal: null,
        stdout: stdoutData.join(''),
        stderr: stderrData.join('')
      })
    })

    childProcess.on('exit', (code, signal) => {
      removeFromActive()

      if (error || (code != null && code !== 0)) {
        return rej({
          error,
          code,
          signal,
          stdout: stdoutData.join(''),
          stderr: stderrData.join('')
        })
      }

      res({ stdout: stdoutData.join(''), stderr: stderrData.join(''), code, signal })
    })
  })
}

const elevatedNodeChildProcessUnix = async (
  code: string,
  scriptArgs: string[] = [],
  onStdout?: (data: string) => void,
  onStderr?: (data: string) => void,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  options?: SpawnOptionsWithoutStdio,
  useBundledNode = false
) => {
  const uniqueID = randomUUID()
  const fileName = uniqueID + '.js'
  const scriptPath = path.join(is.dev ? process.resourcesPath : tmpdir(), fileName)

  // On an AppImage the resources (bundled node binary + node_modules) live inside
  // the image, so it must be loop-mounted before the elevated subprocess can reach
  // them — needed for both the bundled-node and Electron-node paths.
  if (process.platform === 'linux' && process.env.APPIMAGE) {
    await cleanupAppImageIfExists()
    await mountAppImage()
  }

  let command: string
  if (useBundledNode) {
    // Real Node (no V8 memory cage) — required for the flash subprocess.
    command = getNodeBinaryPath()
  } else {
    command = process.execPath
    if (process.platform === 'linux' && process.env.APPIMAGE) {
      const executableName = is.dev ? 'reflasher' : process.execPath.split('/').pop()
      if (!executableName) throw new Error('executable name in execPath is undefined')
      command = path.join(APPIMAGE_MOUNT_POINT, executableName)
    }
  }

  // Script is written with owner-only permissions since it is executed as root.
  await fs.writeFile(scriptPath, code, { mode: 0o700 })

  return childProcess(
    command,
    // Untrusted data (image path, drive JSON, device path) is passed as argv to
    // the script, never interpolated into its source. The script reads it via
    // process.argv, so metacharacters can't become code.
    [scriptPath, ...scriptArgs],
    onStdout,
    onStderr,
    (code, signal) => {
      if (onExit) {
        onExit(code, signal)
      }

      fs.unlink(scriptPath)

      if (process.platform === 'linux' && process.env.APPIMAGE) cleanupAppImageIfExists()
    },
    {
      ...options,
      env: useBundledNode ? bundledNodeEnv() : { ELECTRON_RUN_AS_NODE: '1' },
      elevated: true
    }
  )
}

export const mountAppImage = async () => {
  if (process.platform !== 'linux') {
    throw new Error('trying to mount app image on a non-linux machine')
  }

  if (!process.env.APPIMAGE) {
    throw new Error('AppImage mount called, but environment variable not set')
  }

  const { stdout } = await spawnAsync(process.env.APPIMAGE, ['--appimage-offset'], undefined, {
    env: { ...process.env, APPIMAGELAUNCHER_DISABLE: '1' }
  })

  const appImageOffset = stdout.trim()

  await fs.mkdir(APPIMAGE_MOUNT_POINT, { recursive: true })

  await elevatedSpawn('mount', [
    '-o',
    `loop,ro,offset=${appImageOffset}`,
    process.env.APPIMAGE,
    APPIMAGE_MOUNT_POINT
  ])

  const executableName = is.dev ? 'reflasher' : process.execPath.split('/').pop()
  if (!executableName) throw new Error('executable name in execPath is undefined')

  const command = path.join(APPIMAGE_MOUNT_POINT, executableName)

  // Poll for the mounted executable with a delay and an overall timeout, instead of
  // a tight busy-loop that pegs a CPU core and can hang forever if the mount fails.
  const timeoutMs = 15000
  const intervalMs = 100
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await fileExists(command)) return true
    } catch (error) {
      console.error(error)
    }
    await delay(intervalMs)
  }

  throw new Error('Timed out waiting for the AppImage to mount')
}

export const cleanupAppImageIfExists = async () => {
  const appImageMountPointExists = await fileExists(APPIMAGE_MOUNT_POINT)
  if (!appImageMountPointExists) return

  try {
    await elevatedSpawn('umount', [APPIMAGE_MOUNT_POINT])
  } catch (error) {
    console.log('failed to unmount AppImage path:', error)
  }
}

export const childProcess = (
  command: string,
  args: string[],
  onStdout?: (data: string) => void,
  onStderr?: (data: string) => void,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  options?: SpawnOptionsWithoutStdio & { elevated?: boolean }
) => {
  const sudoSupportedOS = process.platform === 'linux' || process.platform === 'darwin'
  let finalCommand = command
  let finalArgs = args
  if (options?.elevated && sudoSupportedOS) {
    finalCommand = 'sudo'
    finalArgs = buildSudoArgs(command, args)
  }

  const { elevated, ...optionsWithoutElevated } = options ?? {}
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- an argv array, no shell
  const childProcess = spawn(finalCommand, finalArgs, optionsWithoutElevated)
  activeProcesses.push(childProcess)

  if (options?.elevated && sudoSupportedOS) {
    childProcess.stdin.write(getSudoPassword())
    childProcess.stdin.end()
  }

  if (onStdout) {
    childProcess.stdout.on('data', (data) => onStdout(data.toString()))
  }

  if (onStderr) {
    childProcess.stderr.on('data', (data) => onStderr(data.toString()))
  }

  childProcess.on('error', (err) => console.log('error', err))

  childProcess.on('exit', (code, signal) => {
    activeProcesses.splice(activeProcesses.indexOf(childProcess), 1)

    if (onExit) {
      onExit(code, signal)
    }
  })

  return childProcess
}

const nodeChildProcessWindows = async (
  code: string,
  scriptArgs: string[] = [],
  onStdout?: (data: string) => void,
  onStderr?: (data: string) => void,
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
  options?: SpawnOptionsWithoutStdio,
  useBundledNode = false
) => {
  const uniqueID = randomUUID()
  const fileName = uniqueID + '.js'
  const scriptPath = path.join(is.dev ? process.resourcesPath : tmpdir(), fileName)

  await fs.writeFile(scriptPath, code, { mode: 0o700 })

  // The Windows app already runs elevated, so no sudo wrapper is needed here. The
  // flash path still needs REAL node (bundled) to avoid Electron's memory cage.
  const command = useBundledNode ? getNodeBinaryPath() : process.execPath
  const args = [scriptPath, ...scriptArgs]

  return childProcess(
    command,
    args,
    onStdout,
    onStderr,
    (code, signal) => {
      if (onExit) {
        onExit(code, signal)
      }

      fs.unlink(scriptPath)
    },
    {
      ...options,
      env: useBundledNode ? bundledNodeEnv() : { ELECTRON_RUN_AS_NODE: '1' }
    }
  )
}
