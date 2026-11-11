import { describe, it, expect } from 'vitest'
import { UsageError, parseCommandLine } from '../src/cli/args'

describe('parseCommandLine', () => {
  it('shows the usage without a command, with help and with --help', () => {
    expect(parseCommandLine([])).toEqual({ command: 'help' })
    expect(parseCommandLine(['help'])).toEqual({ command: 'help' })
    expect(parseCommandLine(['flash', '--help'])).toEqual({ command: 'help' })
    expect(parseCommandLine(['--version'])).toEqual({ command: 'version' })
  })

  it('reads images and drives', () => {
    expect(parseCommandLine(['images', '--json'])).toEqual({ command: 'images', json: true })
    expect(parseCommandLine(['drives', '--all'])).toEqual({
      command: 'drives',
      all: true,
      json: false
    })
  })

  it('reads a flash with its defaults', () => {
    expect(parseCommandLine(['flash', '-c', 'pi.flock', '-d', '/dev/sdb'])).toEqual({
      command: 'flash',
      flock: 'pi.flock',
      device: '/dev/sdb',
      image: undefined,
      installer: undefined,
      wifiSsid: undefined,
      wifiPassword: undefined,
      imageFile: undefined,
      cacheDir: undefined,
      verify: true,
      yes: false
    })
  })

  it('reads the installer options', () => {
    const command = parseCommandLine([
      'flash',
      '--flock=ipc.flock',
      '--device=/dev/sdc',
      '--image',
      'amd64-efi-nvidia',
      '--installer',
      '--installer-disk',
      'by-id:nvme-Samsung_1',
      '--installer-confirm',
      'no',
      '--installer-after',
      'reboot',
      '--installer-allow-usb',
      'yes',
      '--no-verify',
      '-y'
    ])
    expect(command).toMatchObject({
      command: 'flash',
      image: 'amd64-efi-nvidia',
      installer: { disk: 'by-id:nvme-Samsung_1', confirm: false, after: 'reboot', allowUsb: true },
      verify: false,
      yes: true
    })
  })

  it('refuses what it does not know or what does not fit', () => {
    const bad = [
      ['format'],
      ['images', 'extra'],
      ['images', '--yes'],
      ['drives', '--flock', 'x.flock'],
      ['flash', '-d', '/dev/sdb'],
      ['flash', '-c', 'x.flock'],
      ['flash', '-c', 'x.flock', '-d', '/dev/sdb', '--installer-confirm', 'no'],
      ['flash', '-c', 'x.flock', '-d', '/dev/sdb', '--installer', '--installer-confirm', 'maybe'],
      ['flash', '-c', 'x.flock', '-d', '/dev/sdb', '--installer', '--installer-after', 'halt'],
      ['flash', '-c', 'x.flock', '-d', '/dev/sdb', '--wifi-password', 'secret'],
      ['flash', '-c', 'x.flock', '-d', '/dev/sdb', '--force']
    ]
    for (const argv of bad) {
      expect(() => parseCommandLine(argv), argv.join(' ')).toThrow(UsageError)
    }
  })
})
