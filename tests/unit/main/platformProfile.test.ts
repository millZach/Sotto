import { describe, expect, it } from 'vitest'

import { createPasteCommands } from '../../../src/main/output/pasteCommand'
import { platformProfile } from '../../../src/main/platformProfile'
import { defaultHotkey } from '../../../src/shared/platform'

describe('platformProfile', () => {
  it('describes Windows exactly as the app behaves today', () => {
    const profile = platformProfile('win32')

    expect(profile.platform).toBe('win32')
    expect(profile.mainWindowChrome).toBe('frameless')
    expect(profile.trafficLightPosition).toBeNull()
    expect(profile.applicationMenu).toBe('none')
    expect(profile.dockPresence).toBe('regular')
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
      dockPresence: 'regular',
      widgetAlwaysOnTopLevel: 'normal',
      widgetFocusable: false,
      widgetVisibleOnAllWorkspaces: false,
      trayIcon: { kind: 'executable' },
      pasteRequiresAccessibilityTrust: false,
      pasteUsesWarmHelper: true,
      requiresMediaAccessGate: false,
      defaultHotkey: 'CommandOrControl+Shift+Space',
    })
  })

  it('describes the whole macOS row', () => {
    expect(platformProfile('darwin')).toEqual({
      platform: 'darwin',
      mainWindowChrome: 'hidden-inset',
      trafficLightPosition: { x: 16, y: 16 },
      applicationMenu: 'macos',
      dockPresence: 'dynamic',
      widgetAlwaysOnTopLevel: 'floating',
      widgetFocusable: false,
      widgetVisibleOnAllWorkspaces: true,
      trayIcon: { kind: 'template', relativePath: 'tray/sottoTemplate.png' },
      pasteRequiresAccessibilityTrust: true,
      pasteUsesWarmHelper: false,
      requiresMediaAccessGate: true,
      defaultHotkey: 'Control+Shift+Space',
    })
  })

  it.each(['win32', 'darwin'] as const)(
    'takes the %s default hotkey from the shared platform table',
    (platform) => {
      expect(platformProfile(platform).defaultHotkey).toBe(defaultHotkey(platform))
    },
  )

  it.each(['win32', 'darwin'] as const)(
    'keeps the %s warm-helper flag in step with the paste command table',
    (platform) => {
      // index.ts guards the warm helper on the command table, so a row that
      // disagreed with the profile would spawn (or skip) the helper silently.
      expect(platformProfile(platform).pasteUsesWarmHelper).toBe(
        createPasteCommands(platform).helper !== null,
      )
    },
  )

  it.each(['win32', 'darwin'] as const)(
    'returns the same frozen %s row on every call',
    (platform) => {
      const profile = platformProfile(platform)

      expect(Object.isFrozen(profile)).toBe(true)
      expect(Object.isFrozen(profile.trayIcon)).toBe(true)
      if (profile.trafficLightPosition !== null) {
        expect(Object.isFrozen(profile.trafficLightPosition)).toBe(true)
      }
      expect(platformProfile(platform)).toBe(profile)
    },
  )
})
