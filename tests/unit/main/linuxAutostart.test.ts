// @vitest-environment node
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { linuxAutostart } from '../../../src/main/startup/linuxAutostart'
import { StartupService } from '../../../src/main/startup/startupService'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), mkdirSync: vi.fn(actual.mkdirSync) }
})

const roots: string[] = []
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'sotto-autostart-')); roots.push(root); return root }
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Linux XDG autostart', () => {
  it.each([false, true])('keeps startup running with remembered startup=%s when the entry is unreadable', enabled => {
    const log = vi.fn()
    const configHome = temporary()
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw Object.assign(new Error('private path'), { code: 'EACCES' }) })
    const startup = new StartupService(linuxAutostart({ isPackaged: true, executable: '/opt/sotto/sotto', configHome, log }))
    expect(startup.set(enabled)).toEqual({ enabled: false, supported: false })
    expect(startup.get()).toEqual({ enabled: false, supported: false })
    expect(log.mock.calls).toEqual([['linux-autostart-read-failed']])
    expect(read).toHaveBeenCalledOnce()
    expect(existsSync(join(configHome, 'autostart'))).toBe(false)
  })

  it.each([false, true])('keeps startup running with remembered startup=%s when the entry is a directory', enabled => {
    const configHome = temporary()
    const file = join(configHome, 'autostart/sotto.desktop')
    mkdirSync(file, { recursive: true })
    const log = vi.fn()
    const startup = new StartupService(linuxAutostart({ isPackaged: true, executable: '/opt/sotto/sotto', configHome, log }))
    expect(startup.set(enabled)).toEqual({ enabled: false, supported: false })
    expect(fs.statSync(file).isDirectory()).toBe(true)
    expect(log.mock.calls).toEqual([['linux-autostart-read-failed']])
  })

  it('contains a failed write rather than aborting startup', () => {
    const configHome = temporary()
    const log = vi.fn()
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => { throw Object.assign(new Error('private path'), { code: 'EACCES' }) })
    const startup = new StartupService(linuxAutostart({ isPackaged: true, executable: '/opt/sotto/sotto', configHome, log }))
    expect(startup.set(true)).toEqual({ enabled: false, supported: false })
    expect(log.mock.calls).toEqual([['linux-autostart-write-failed']])
  })

  it('writes and removes a packaged sign-in command in XDG_CONFIG_HOME, idempotently', () => {
    const configHome = temporary()
    const file = join(configHome, 'autostart', 'sotto.desktop')
    const startup = new StartupService(linuxAutostart({ isPackaged: true, executable: '/opt/sotto/sotto', configHome }))
    expect(startup.get()).toEqual({ enabled: false, supported: true })
    expect(startup.set(true)).toEqual({ enabled: true, supported: true })
    expect(readFileSync(file, 'utf8')).toContain('Exec="/opt/sotto/sotto"\n')
    expect(startup.set(true)).toEqual({ enabled: true, supported: true })
    expect(startup.set(false)).toEqual({ enabled: false, supported: true })
    expect(startup.set(false)).toEqual({ enabled: false, supported: true })
    expect(existsSync(file)).toBe(false)
  })

  it('falls back to HOME/.config and quotes a path containing desktop Exec metacharacters', () => {
    const home = temporary()
    const executable = '/some folder/Sotto%$`"\\/sotto'
    const startup = new StartupService(linuxAutostart({ isPackaged: true, executable, home, configHome: 'relative-config' }))
    startup.set(true)
    expect(readFileSync(join(home, '.config/autostart/sotto.desktop'), 'utf8')).toContain('Exec="/some folder/Sotto%%\\\\$\\\\`\\\\"\\\\\\\\/sotto"\n')
  })

  it('leaves development builds disabled without touching a configuration folder', () => {
    const home = temporary()
    const startup = new StartupService(linuxAutostart({ isPackaged: false, executable: 'electron', home }))
    expect(startup.set(true)).toEqual({ enabled: false, supported: false })
    expect(existsSync(join(home, '.config'))).toBe(false)
  })

  it('refuses a command that could inject a desktop entry line', () => {
    expect(() => linuxAutostart({ isPackaged: true, executable: '/opt/sotto\nHidden=true' })).toThrow(/sign-in command/)
  })
})
