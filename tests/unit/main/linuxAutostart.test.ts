// @vitest-environment node
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linuxAutostart } from '../../../src/main/startup/linuxAutostart'
import { StartupService } from '../../../src/main/startup/startupService'

const roots: string[] = []
const temporary = () => { const root = mkdtempSync(join(tmpdir(), 'sotto-autostart-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Linux XDG autostart', () => {
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
