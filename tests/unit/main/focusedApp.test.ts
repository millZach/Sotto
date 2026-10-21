// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import {
  createHyprlandFocusedApp,
  createLsappinfoFocusedApp,
  FOCUSED_APP_TIMEOUT_MS,
  hyprlandAppName,
  parseLsappinfoFront,
  parseLsappinfoName,
  readableWindowClass,
} from '../../../src/main/output/focusedApp'

describe('macOS delivered app through lsappinfo', () => {
  it('reads the front application serial number and nothing else', () => {
    expect(parseLsappinfoFront('ASN:0x0-0x1d01d:\n')).toBe('ASN:0x0-0x1d01d:')
    expect(parseLsappinfoFront('  ASN:0x0-0xABCDEF:  ')).toBe('ASN:0x0-0xABCDEF:')
    expect(parseLsappinfoFront('')).toBeNull()
    expect(parseLsappinfoFront('ASN:0x0-0x1d01d:; rm -rf ~')).toBeNull()
    expect(parseLsappinfoFront('[ NULL ]')).toBeNull()
  })

  it('reads the display name from the info answer', () => {
    expect(parseLsappinfoName('"LSDisplayName"="Mail"\n')).toBe('Mail')
    expect(parseLsappinfoName('"LSDisplayName"="Microsoft Outlook"')).toBe('Microsoft Outlook')
    expect(parseLsappinfoName('"name"="Visual Studio Code"')).toBe('Visual Studio Code')
    expect(parseLsappinfoName('"LSDisplayName"="Say \\"Hi\\""')).toBe('Say "Hi"')
    expect(parseLsappinfoName('"LSDisplayName"="Ünïcode"')).toBe('Ünïcode')
    expect(parseLsappinfoName('"LSDisplayName"=""')).toBeNull()
    expect(parseLsappinfoName('')).toBeNull()
    expect(parseLsappinfoName('"bundleID"="com.apple.mail"')).toBeNull()
  })

  it('asks lsappinfo by its absolute path, front first, and never System Events', async () => {
    const run = vi.fn(async (_executable: string, args: readonly string[]) =>
      args[0] === 'front' ? 'ASN:0x0-0x2b02b:\n' : '"LSDisplayName"="Slack"\n')
    await expect(createLsappinfoFocusedApp(run)()).resolves.toBe('Slack')
    expect(run.mock.calls).toEqual([
      ['/usr/bin/lsappinfo', ['front'], FOCUSED_APP_TIMEOUT_MS],
      ['/usr/bin/lsappinfo', ['info', '-only', 'name', 'ASN:0x0-0x2b02b:'], FOCUSED_APP_TIMEOUT_MS],
    ])
    expect(JSON.stringify(run.mock.calls)).not.toMatch(/osascript|System Events/u)
  })

  it('answers null without asking for a name when there is no front application', async () => {
    const run = vi.fn(async () => '[ NULL ]\n')
    await expect(createLsappinfoFocusedApp(run)()).resolves.toBeNull()
    expect(run).toHaveBeenCalledOnce()
  })
})

describe('Linux delivered app through hyprctl', () => {
  it('turns a window class into a readable name where it is cheap', () => {
    expect(readableWindowClass('org.gnome.Nautilus')).toBe('Nautilus')
    expect(readableWindowClass('com.mitchellh.ghostty')).toBe('Ghostty')
    expect(readableWindowClass('org.mozilla.firefox')).toBe('Firefox')
    expect(readableWindowClass('firefox')).toBe('Firefox')
    expect(readableWindowClass('brave-browser')).toBe('Brave browser')
    expect(readableWindowClass('Alacritty')).toBe('Alacritty')
    expect(readableWindowClass('Code')).toBe('Code')
    expect(readableWindowClass('zoom.us')).toBe('zoom.us')
    // An installed web app names its site in the class; only the browser is kept.
    expect(readableWindowClass('chrome-mail.google.com__-Default')).toBe('Google Chrome')
    expect(readableWindowClass('brave-app.slack.com__client-Profile_2')).toBe('Brave')
    expect(readableWindowClass('msedge-outlook.office.com__mail-Default')).toBe('Microsoft Edge')
    expect(readableWindowClass('chrome-fmgjjmmmlfnkbppncabfkddbjimcfncm-Default')).toBe('Google Chrome')
    expect(readableWindowClass('  ')).toBeNull()
  })

  it('names the window by its class and never its title', () => {
    expect(hyprlandAppName({ class: 'org.telegram.desktop', title: 'Private chat' })).toBe('Desktop')
    expect(hyprlandAppName({ class: '', initialClass: 'kitty', title: 'ssh forge' })).toBe('Kitty')
    expect(hyprlandAppName({ title: 'Only a title' })).toBeNull()
    expect(hyprlandAppName({})).toBeNull()
    expect(hyprlandAppName(null)).toBeNull()
    expect(hyprlandAppName('kitty')).toBeNull()
  })

  it('reads the active window with the paste adapter\'s own call', async () => {
    const run = vi.fn(async () => JSON.stringify({ address: '0x1', class: 'obsidian', title: 'Secret note' }))
    await expect(createHyprlandFocusedApp(run)()).resolves.toBe('Obsidian')
    expect(run).toHaveBeenCalledWith({ executable: 'hyprctl', args: ['activewindow', '-j'] }, FOCUSED_APP_TIMEOUT_MS)
  })
})
