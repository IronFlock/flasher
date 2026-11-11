import { parseArgs } from 'node:util'
import type { InstallerOptions } from '../main/utils/config-partition'

// The command line of flockflasher, the command-line tool (README, "Command
// line"). Pure, so it is unit-tested.

export const USAGE = `flockflasher: installs IronFlockOS from the command line

Usage:
  flockflasher images [--json]
  flockflasher drives [--all] [--json]
  flockflasher flash --flock FILE --device DISK [options]
  flockflasher help | version

images   The images of the signed IronFlockOS catalog (the production channel).
drives   The disks this computer can write (--all: every disk, with the reason
         for the others).
flash    Writes an IronFlockOS image and the device's .flock to a disk:
  -c, --flock FILE         the device file from IronFlock
  -d, --device DISK        the whole disk: /dev/sdX (Linux), /dev/diskN (macOS);
                           everything on it is erased
  -i, --image ID           the image, for example ironflockos-amd64-efi-nvidia
                           (default: the base image of the .flock's hardware,
                           when only one hardware has its architecture)
      --installer          write the installer stick that installs the image on
                           a PC's internal disk, instead of the image itself
      --installer-disk RULE        largest, /dev/<name> or by-id:<id>
      --installer-confirm yes|no   ask on the PC's console before writing
      --installer-after poweroff|reboot
      --installer-allow-usb yes|no also install to USB disks
      --wifi-ssid SSID     the WiFi the device connects to (else the .flock's)
      --wifi-password PW
      --image-file FILE    a downloaded .img.gz to write instead of downloading
                           it; it must be the catalog's (same size and SHA-256)
      --cache-dir DIR      where downloads are kept (default ~/.Reflasher)
      --no-verify          do not read the disk back after writing
  -y, --yes                do not ask before erasing the disk

Every image comes from the signed catalog at
https://instance-registry.ironflock.com/dl/ironflockos/manifest.json and is checked
against its size and SHA-256 before it is written. Writing a disk needs root
(sudo) on Linux and macOS.`

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export type FlashOptions = {
  flock: string
  device: string
  image?: string
  installer?: InstallerOptions
  wifiSsid?: string
  wifiPassword?: string
  imageFile?: string
  cacheDir?: string
  verify: boolean
  yes: boolean
}

export type Command =
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'images'; json: boolean }
  | { command: 'drives'; all: boolean; json: boolean }
  | ({ command: 'flash' } & FlashOptions)

const yesNo = (value: string | undefined, option: string): boolean | undefined => {
  if (value === undefined) return undefined
  if (value === 'yes') return true
  if (value === 'no') return false
  throw new UsageError(`--${option} must be yes or no`)
}

const OPTIONS = {
  json: { type: 'boolean' },
  all: { type: 'boolean' },
  flock: { type: 'string', short: 'c' },
  device: { type: 'string', short: 'd' },
  image: { type: 'string', short: 'i' },
  installer: { type: 'boolean' },
  'installer-disk': { type: 'string' },
  'installer-confirm': { type: 'string' },
  'installer-after': { type: 'string' },
  'installer-allow-usb': { type: 'string' },
  'wifi-ssid': { type: 'string' },
  'wifi-password': { type: 'string' },
  'image-file': { type: 'string' },
  'cache-dir': { type: 'string' },
  'no-verify': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' }
} as const

// The options each command takes, besides --help.
const ACCEPTS: Record<string, string[]> = {
  images: ['json'],
  drives: ['all', 'json'],
  flash: [
    'flock',
    'device',
    'image',
    'installer',
    'installer-disk',
    'installer-confirm',
    'installer-after',
    'installer-allow-usb',
    'wifi-ssid',
    'wifi-password',
    'image-file',
    'cache-dir',
    'no-verify',
    'yes'
  ]
}

const parse = (argv: string[]) => {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}

export const parseCommandLine = (argv: string[]): Command => {
  const { values, positionals } = parse(argv)
  if (values.version) return { command: 'version' }
  const [command, ...rest] = positionals
  if (values.help || command === undefined || command === 'help') return { command: 'help' }
  if (command === 'version') return { command: 'version' }
  if (!(command in ACCEPTS)) throw new UsageError(`Unknown command ${command}`)
  if (rest.length > 0) throw new UsageError(`Unexpected argument ${rest[0]}`)
  for (const name of Object.keys(values)) {
    if (name !== 'help' && !ACCEPTS[command].includes(name)) {
      throw new UsageError(`${command} takes no --${name}`)
    }
  }

  if (command === 'images') return { command, json: values.json === true }
  if (command === 'drives') return { command, all: values.all === true, json: values.json === true }

  if (!values.flock) throw new UsageError('flash needs --flock FILE, the device file')
  if (!values.device) throw new UsageError('flash needs --device DISK, the disk to write')

  const installerValues = [
    values['installer-disk'],
    values['installer-confirm'],
    values['installer-after'],
    values['installer-allow-usb']
  ]
  if (!values.installer && installerValues.some((v) => v !== undefined)) {
    throw new UsageError('The --installer-* options need --installer')
  }
  let installer: InstallerOptions | undefined
  if (values.installer) {
    const after = values['installer-after']
    if (after !== undefined && after !== 'poweroff' && after !== 'reboot') {
      throw new UsageError('--installer-after must be poweroff or reboot')
    }
    installer = {
      disk: values['installer-disk'],
      confirm: yesNo(values['installer-confirm'], 'installer-confirm'),
      after,
      allowUsb: yesNo(values['installer-allow-usb'], 'installer-allow-usb')
    }
  }
  if (values['wifi-password'] !== undefined && values['wifi-ssid'] === undefined) {
    throw new UsageError('--wifi-password needs --wifi-ssid')
  }

  return {
    command: 'flash',
    flock: values.flock,
    device: values.device,
    image: values.image,
    installer,
    wifiSsid: values['wifi-ssid'],
    wifiPassword: values['wifi-password'],
    imageFile: values['image-file'],
    cacheDir: values['cache-dir'],
    verify: values['no-verify'] !== true,
    yes: values.yes === true
  }
}
