// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createPasteCommands } from '../../../src/main/output/pasteCommand'
import { platformProfile, updatesInApp } from '../../../src/main/platformProfile'
import { defaultHotkey } from '../../../src/shared/platform'

describe('platformProfile', () => {
  it('describes Windows exactly as the app behaves today', () => {
    const profile = platformProfile('win32')

    expect(profile.platform).toBe('win32')
    expect(profile.mainWindowChrome).toBe('frameless')
    expect(profile.trafficLightPosition).toBeNull()
    expect(profile.applicationMenu).toBe('none')
    expect(profile.widgetAlwaysOnTopLevel).toBe('normal')
    expect(profile.widgetFocusable).toBe(false)
    expect(profile.widgetVisibleOnAllWorkspaces).toBe(false)
    expect(profile.trayIcon).toEqual({ kind: 'executable' })
    expect(profile.pasteRequiresAccessibilityTrust).toBe(false)
    expect(profile.pasteUsesWarmHelper).toBe(true)
    expect(profile.requiresMediaAccessGate).toBe(false)
    expect(profile.defaultHotkey).toBe('CommandOrControl+Shift+Space')
  })

  it('describes the whole Windows row without extra fields', () => {
    expect(platformProfile('win32')).toEqual({
      platform: 'win32',
      mainWindowChrome: 'frameless',
      trafficLightPosition: null,
      applicationMenu: 'none',
      widgetAlwaysOnTopLevel: 'normal',
      widgetFocusable: false,
      widgetVisibleOnAllWorkspaces: false,
      widgetIsPanel: false,
      trayIcon: { kind: 'executable' },
      inAppUpdateTracks: ['stable', 'owl'],
      pasteRequiresAccessibilityTrust: false,
      pasteUsesWarmHelper: true,
      requiresMediaAccessGate: false,
      defaultHotkey: 'CommandOrControl+Shift+Space',
      defaultHoldShortcuts: ['CommandOrControl+Super'],
    })
  })

  it('describes the whole macOS row', () => {
    expect(platformProfile('darwin')).toEqual({
      platform: 'darwin',
      mainWindowChrome: 'hidden-inset',
      trafficLightPosition: { x: 16, y: 16 },
      applicationMenu: 'macos',
      widgetAlwaysOnTopLevel: 'floating',
      widgetFocusable: false,
      widgetVisibleOnAllWorkspaces: true,
      widgetIsPanel: true,
      trayIcon: { kind: 'template', relativePath: 'tray/sottoTemplate.png' },
      inAppUpdateTracks: ['owl'],
      pasteRequiresAccessibilityTrust: true,
      pasteUsesWarmHelper: false,
      requiresMediaAccessGate: true,
      defaultHotkey: 'Control+Shift+Space',
      defaultHoldShortcuts: ['Fn'],
    })
  })

  it('keeps Linux frameless, with the colour app PNG tray and Hyprland output', () => {
    const profile = platformProfile('linux')
    expect(profile).toEqual({
      platform: 'linux',
      mainWindowChrome: 'frameless',
      trafficLightPosition: null,
      applicationMenu: 'none',
      widgetAlwaysOnTopLevel: 'normal',
      widgetFocusable: false,
      widgetVisibleOnAllWorkspaces: false,
      widgetIsPanel: false,
      trayIcon: { kind: 'image', relativePath: 'icon.png' },
      inAppUpdateTracks: [],
      pasteRequiresAccessibilityTrust: false,
      pasteUsesWarmHelper: false,
      requiresMediaAccessGate: false,
      defaultHotkey: 'Super+CommandOrControl+X',
      defaultHoldShortcuts: ['F9'],
    })
    if (profile.trayIcon.kind !== 'image') throw new Error('Linux needs a colour PNG')
    expect(existsSync(join('build', profile.trayIcon.relativePath))).toBe(true)
    expect(createPasteCommands('linux').oneShot()).toEqual({ executable: 'hyprctl', args: ['activewindow', '-j'] })
  })

  // macOS takes an update only when it is signed by the running app's developer, and only Owl is (ADR-0093).
  it.each([
    ['win32', 'stable', true],
    ['win32', 'owl', true],
    ['darwin', 'stable', false],
    ['darwin', 'owl', true],
    ['linux', 'stable', false],
    ['linux', 'owl', false],
  ] as const)('updates in the app on %s %s: %s', (platform, track, expected) => {
    expect(updatesInApp(platformProfile(platform), track)).toBe(expected)
  })

  it.each(['win32', 'darwin', 'linux'] as const)(
    'takes the %s default hotkey from the shared platform table',
    (platform) => {
      expect(platformProfile(platform).defaultHotkey).toBe(defaultHotkey(platform))
    },
  )

  it.each(['win32', 'darwin', 'linux'] as const)(
    'keeps the %s warm-helper flag in step with the paste command table',
    (platform) => {
      // index.ts guards the warm helper on the command table, so a row that
      // disagreed with the profile would spawn (or skip) the helper silently.
      expect(platformProfile(platform).pasteUsesWarmHelper).toBe(
        createPasteCommands(platform).helper !== null,
      )
    },
  )

  it.each(['win32', 'darwin', 'linux'] as const)(
    'returns the same frozen %s row on every call',
    (platform) => {
      const profile = platformProfile(platform)

      expect(Object.isFrozen(profile)).toBe(true)
      expect(Object.isFrozen(profile.trayIcon)).toBe(true)
      expect(Object.isFrozen(profile.inAppUpdateTracks)).toBe(true)
      if (profile.trafficLightPosition !== null) {
        expect(Object.isFrozen(profile.trafficLightPosition)).toBe(true)
      }
      expect(platformProfile(platform)).toBe(profile)
    },
  )
})
