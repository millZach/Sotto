// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { platformCopy, type PlatformCopy } from '../../../src/renderer/src/platformCopy'
import type { SottoPlatform } from '../../../src/shared/platform'

const platforms: readonly SottoPlatform[] = ['win32', 'darwin', 'linux']

// Every string the renderer used to hardcode, exactly as it shipped on Windows.
const win32Strings: Omit<PlatformCopy, 'platform' | 'accessibilityHelp' | 'settingsUpdatesByHand'> = {
  helpMicrophoneAccess:
    'If recording cannot start, open Windows Settings, then Privacy or Privacy & security, then Microphone, and allow desktop apps. Choose an available input in Sotto Settings.',
  helpPasteFallback:
    'Sotto is clipboard first: successful text is always copied. Automatic paste may be blocked in elevated, protected, or password fields and applications with custom input handling. When that happens, paste manually with Ctrl+V.',
  openRouterKeyUnreadable:
    'Sotto could not read the saved OpenRouter key. Nothing was deleted. Enter the key again in Settings → Cleanup.',
  homeMicrophonePermissionDenied:
    'Microphone access is off. Check Windows privacy settings, then try again.',
  homeRequestingPermissionDetail: 'Windows may ask for access.',
  onboardingMicrophoneDenied:
    'Open Windows Settings > Privacy & security > Microphone, allow desktop apps, then try again.',
  onboardingMicrophoneMissing:
    'Connect or enable an input device in Windows Settings > System > Sound, then try again.',
  settingsReducedMotionDescription: 'Follow Windows or minimize non-essential motion.',
  settingsMicrophoneUnavailable: 'Microphones are unavailable. Check Windows privacy settings.',
  settingsMicrophoneDenied: 'Microphones are unavailable. Check Windows privacy settings.',
  settingsMicrophoneDefaultOption: 'Windows default',
  settingsGlobalShortcutDescription: 'Starts and stops dictation from anywhere in Windows.',
  settingsAutoPasteDescription: 'Presses Ctrl+V in the app you were using. Some apps block it.',
  settingsLaunchAtStartupLabel: 'Launch when Windows starts',
  settingsStartupFailureNotice: 'Windows startup could not be updated.',
  settingsStartMinimizedDescription: 'Open directly in the tray when Sotto launches.',
  settingsUpdatesLead: 'Sotto looks for new releases on GitHub and installs them itself.',
  widgetMicrophoneBlockedDetail: 'Allow microphone access in Windows Settings.',
  widgetPermissionPromptDetail: 'Approve access in Windows',
  widgetProcessingDetail: 'Transcribed on this computer, never saved',
}

describe('platformCopy', () => {
  it('reproduces the previously hardcoded Windows strings field for field', () => {
    expect(platformCopy('win32')).toEqual({
      platform: 'win32',
      accessibilityHelp: null,
      settingsUpdatesByHand: null,
      ...win32Strings,
    })
  })

  it.each(platforms)('carries a non-empty string in every %s field', (platform) => {
    const copy = platformCopy(platform)
    expect(copy.platform).toBe(platform)
    for (const [field, value] of Object.entries(copy)) {
      if (field === 'accessibilityHelp' || field === 'settingsUpdatesByHand') continue
      expect(value, field).toBeTypeOf('string')
      expect((value as string).trim(), field).not.toBe('')
    }
  })

  it('asks for accessibility permission only where auto-paste needs it', () => {
    expect(platformCopy('linux').accessibilityHelp).toBeNull()
    expect(platformCopy('win32').accessibilityHelp).toBeNull()
    const help = platformCopy('darwin').accessibilityHelp ?? ''
    expect(help).toContain('Accessibility')
    expect(help).toContain('Automation')
    expect(help).toContain('clipboard')
    expect(help).toContain('remove Sotto from the Accessibility list and add it again')
  })

  it('names the Keychain only where the saved key lives in it', () => {
    expect(platformCopy('win32').openRouterKeyUnreadable).not.toContain('Keychain')
    expect(platformCopy('darwin').openRouterKeyUnreadable).toContain('allow Keychain access')
    for (const platform of platforms) expect(platformCopy(platform).openRouterKeyUnreadable).toContain('Nothing was deleted')
  })

  it('tells a Mac user where to turn the microphone back on', () => {
    const copy = platformCopy('darwin')
    for (const line of [copy.onboardingMicrophoneDenied, copy.settingsMicrophoneDenied]) {
      expect(line).toContain('Turn on Sotto in System Settings > Privacy & Security > Microphone, then test again.')
    }
  })

  it('never mentions the other platform in a row', () => {
    for (const value of Object.values(platformCopy('linux'))) {
      expect(String(value)).not.toMatch(/Windows|macOS|Keychain|⌘/u)
    }
    for (const value of Object.values(platformCopy('darwin'))) {
      expect(String(value)).not.toMatch(/Windows|Ctrl\+/u)
    }
    for (const value of Object.values(platformCopy('win32'))) {
      expect(String(value)).not.toMatch(/macOS|System Settings|⌘/u)
    }
  })

  it('tells Linux users to paste and set compositor bindings in Hyprland', () => {
    expect(platformCopy('linux').helpPasteFallback).toContain('Super+V')
    expect(platformCopy('linux').helpPasteFallback).toContain('apps and terminals')
    expect(platformCopy('linux').settingsAutoPasteDescription).toContain('focused window, terminals included')
    expect(platformCopy('linux').settingsGlobalShortcutDescription).toContain('Compositor bindings live in Hyprland')
    expect(platformCopy('linux').settingsGlobalShortcutDescription).toContain('hold F9')
    expect(platformCopy('linux').settingsGlobalShortcutDescription).toContain('Super+Ctrl+X')
    expect(platformCopy('linux').settingsGlobalShortcutDescription).not.toContain('first')
  })

  it('sends Linux updates through pacman and leaves the other rows offering checks', () => {
    expect(platformCopy('linux').settingsUpdatesLead).toBe('Sotto never updates itself on Linux. New versions come through pacman.')
    expect(platformCopy('linux').settingsUpdatesByHand).toContain('sudo pacman -U')
    expect(platformCopy('linux').settingsUpdatesByHand).toContain('omarchy update')
    for (const platform of ['win32', 'darwin'] as const) {
      expect(platformCopy(platform).settingsUpdatesLead).toBe('Sotto looks for new releases on GitHub and installs them itself.')
      expect(platformCopy(platform).settingsUpdatesByHand).toBeNull()
    }
  })

  it('returns the same frozen row on every call', () => {
    for (const platform of platforms) {
      expect(platformCopy(platform)).toBe(platformCopy(platform))
      expect(Object.isFrozen(platformCopy(platform))).toBe(true)
    }
  })
})
