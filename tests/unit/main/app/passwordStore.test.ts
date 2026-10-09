// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { configurePasswordStore } from '../../../../src/main/app/passwordStore'

describe('configurePasswordStore', () => {
  it.each(['', 'Hyprland', 'GNOME', 'Sway', 'GNOME:Hyprland', 'NotKDE'])('selects libsecret on Linux desktop %j when no password store was passed', desktop => {
    const commandLine = { hasSwitch: vi.fn(() => false), appendSwitch: vi.fn() }
    configurePasswordStore('linux', commandLine, desktop)
    expect(commandLine.hasSwitch).toHaveBeenCalledWith('password-store')
    expect(commandLine.appendSwitch).toHaveBeenCalledExactlyOnceWith('password-store', 'gnome-libsecret')
  })

  it.each(['KDE', 'kde', 'KDE:Plasma', 'Plasma:KDE', 'GNOME:KDE', ' KDE '])('leaves Chromium to choose KWallet on desktop %j', desktop => {
    const commandLine = { hasSwitch: vi.fn(() => false), appendSwitch: vi.fn() }
    configurePasswordStore('linux', commandLine, desktop)
    expect(commandLine.appendSwitch).not.toHaveBeenCalled()
  })

  it.each(['basic', 'kwallet6', 'gnome-libsecret', ''])('preserves a user-supplied Linux password store %j', value => {
    const switches = new Map([['password-store', value]])
    const commandLine = { hasSwitch: (name: string) => switches.has(name), appendSwitch: vi.fn() }
    configurePasswordStore('linux', commandLine)
    expect(commandLine.appendSwitch).not.toHaveBeenCalled()
    expect(switches.get('password-store')).toBe(value)
  })

  it.each(['win32', 'darwin'] as const)('does nothing on %s', platform => {
    const commandLine = { hasSwitch: vi.fn(() => false), appendSwitch: vi.fn() }
    configurePasswordStore(platform, commandLine)
    expect(commandLine.hasSwitch).not.toHaveBeenCalled()
    expect(commandLine.appendSwitch).not.toHaveBeenCalled()
  })
})
