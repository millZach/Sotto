import { describe, expect, it } from 'vitest'

import { platformCopy, type PlatformCopy } from '../../../src/renderer/src/platformCopy'
import type { SottoPlatform } from '../../../src/shared/platform'

const platforms: readonly SottoPlatform[] = ['win32', 'darwin']

// Every string the renderer used to hardcode, exactly as it shipped on Windows.
const win32Strings: Omit<PlatformCopy, 'platform' | 'accessibilityHelp'> = {
  helpMicrophoneAccess:
    'If recording cannot start, open Windows Settings, then Privacy or Privacy & security, then Microphone, and allow desktop apps. Choose an available input in Sotto Settings.',
  helpPasteFallback:
    'Sotto is clipboard first: successful text is always copied. Automatic paste may be blocked in elevated, protected, or password fields and applications with custom input handling. When that happens, paste manually with Ctrl+V.',
  homeMicrophonePermissionDenied:
    'Microphone access is off. Check Windows privacy settings, then try again.',
  homeRequestingPermissionDetail: 'Windows may ask for access.',
  onboardingMicrophoneDenied:
    'Open Windows Settings > Privacy & security > Microphone, allow desktop apps, then try again.',
  onboardingMicrophoneMissing:
    'Connect or enable an input device in Windows Settings > System > Sound, then try again.',
  settingsThemeDescription: 'Follow Windows or force a complete light or dark theme.',
  settingsReducedMotionDescription: 'Follow Windows or minimize non-essential motion.',
  settingsMicrophoneUnavailable: 'Microphones are unavailable. Check Windows privacy settings.',
  settingsMicrophoneDefaultOption: 'Windows default',
  settingsGlobalShortcutDescription: 'Used anywhere in Windows to start and stop dictation.',
  settingsAutoPasteDescription: 'Best-effort Ctrl+V into the previously focused application.',
  settingsLaunchAtStartupLabel: 'Launch when Windows starts',
  settingsStartupFailureNotice: 'Windows startup could not be updated.',
  settingsStartMinimizedDescription: 'Open directly in the tray when Sotto launches.',
  widgetMicrophoneBlockedDetail: 'Allow microphone access in Windows Settings.',
  widgetPermissionPromptDetail: 'Approve access in Windows',
  widgetProcessingDetail: 'Audio stays on this PC',
}

describe('platformCopy', () => {
  it('reproduces the previously hardcoded Windows strings field for field', () => {
    expect(platformCopy('win32')).toEqual({
      platform: 'win32',
      accessibilityHelp: null,
      ...win32Strings,
    })
  })

  it.each(platforms)('carries a non-empty string in every %s field', (platform) => {
    const copy = platformCopy(platform)
    expect(copy.platform).toBe(platform)
    for (const [field, value] of Object.entries(copy)) {
      if (field === 'accessibilityHelp') continue
      expect(value, field).toBeTypeOf('string')
      expect((value as string).trim(), field).not.toBe('')
    }
  })

  it('asks for accessibility permission only where auto-paste needs it', () => {
    expect(platformCopy('win32').accessibilityHelp).toBeNull()
    const help = platformCopy('darwin').accessibilityHelp ?? ''
    expect(help).toContain('Accessibility')
    expect(help).toContain('Automation')
    expect(help).toContain('clipboard')
  })

  it('never mentions the other platform in a row', () => {
    for (const value of Object.values(platformCopy('darwin'))) {
      expect(String(value)).not.toMatch(/Windows|Ctrl\+/u)
    }
    for (const value of Object.values(platformCopy('win32'))) {
      expect(String(value)).not.toMatch(/macOS|System Settings|⌘/u)
    }
  })

  it('returns the same frozen row on every call', () => {
    for (const platform of platforms) {
      expect(platformCopy(platform)).toBe(platformCopy(platform))
      expect(Object.isFrozen(platformCopy(platform))).toBe(true)
    }
  })
})
