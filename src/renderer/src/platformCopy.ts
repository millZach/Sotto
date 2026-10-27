import { i18n } from '@lingui/core'
import { t } from '@lingui/core/macro'

import type { SottoPlatform } from '../../shared/platform'

export interface PlatformCopy {
  readonly platform: SottoPlatform
  readonly helpMicrophoneAccess: string
  readonly helpPasteFallback: string
  /** null where auto-paste needs no permission grant; a Help card renders it when present. */
  readonly accessibilityHelp: string | null
  /** The notice when a saved OpenRouter key exists but the credential store will not unlock it. */
  readonly openRouterKeyUnreadable: string
  readonly homeMicrophonePermissionDenied: string
  readonly homeRequestingPermissionDetail: string
  readonly onboardingMicrophoneDenied: string
  readonly onboardingMicrophoneMissing: string
  readonly settingsReducedMotionDescription: string
  readonly settingsMicrophoneUnavailable: string
  /** The Settings microphone test's line when access is blocked. */
  readonly settingsMicrophoneDenied: string
  readonly settingsMicrophoneDefaultOption: string
  readonly settingsGlobalShortcutDescription: string
  readonly settingsAutoPasteDescription: string
  readonly settingsLaunchAtStartupLabel: string
  readonly settingsStartupFailureNotice: string
  readonly settingsStartMinimizedDescription: string
  /** The line under Settings' Updates heading. */
  readonly settingsUpdatesLead: string
  /** null where Settings offers update checks; otherwise how to update by hand, shown in their place. */
  readonly settingsUpdatesByHand: string | null
  readonly widgetMicrophoneBlockedDetail: string
  readonly widgetPermissionPromptDetail: string
  readonly widgetProcessingDetail: string
}

// The win32 row holds the strings this renderer shipped before the platform
// seam existed; changing one changes Windows-visible copy. A row is written
// each time it is asked for, so it follows the interface language (ADR-0123).
const PLATFORM_COPY: Readonly<Record<SottoPlatform, () => PlatformCopy>> = Object.freeze({
  win32: (): PlatformCopy => ({
    platform: 'win32',
    helpMicrophoneAccess:
      t`If recording cannot start, open Windows Settings, then Privacy or Privacy & security, then Microphone, and allow desktop apps. Choose an available input in Sotto Settings.`,
    helpPasteFallback:
      t`Sotto is clipboard first: successful text is always copied. Automatic paste may be blocked in elevated, protected, or password fields and applications with custom input handling. When that happens, paste manually with Ctrl+V.`,
    accessibilityHelp: null,
    openRouterKeyUnreadable:
      t`Sotto could not read the saved OpenRouter key. Nothing was deleted. Enter the key again in Settings → Cleanup.`,
    homeMicrophonePermissionDenied:
      t`Microphone access is off. Check Windows privacy settings, then try again.`,
    homeRequestingPermissionDetail: t`Windows may ask for access.`,
    onboardingMicrophoneDenied:
      t`Open Windows Settings > Privacy & security > Microphone, allow desktop apps, then try again.`,
    onboardingMicrophoneMissing:
      t`Connect or enable an input device in Windows Settings > System > Sound, then try again.`,
    settingsReducedMotionDescription: t`Follow Windows or minimize non-essential motion.`,
    settingsMicrophoneUnavailable: t`Microphones are unavailable. Check Windows privacy settings.`,
    settingsMicrophoneDenied: t`Microphones are unavailable. Check Windows privacy settings.`,
    settingsMicrophoneDefaultOption: t`Windows default`,
    settingsGlobalShortcutDescription: t`Starts and stops dictation from anywhere in Windows.`,
    settingsAutoPasteDescription: t`Presses Ctrl+V in the app you were using. Some apps block it.`,
    settingsLaunchAtStartupLabel: t`Launch when Windows starts`,
    settingsStartupFailureNotice: t`Windows startup could not be updated.`,
    settingsStartMinimizedDescription: t`Open directly in the tray when Sotto launches.`,
    settingsUpdatesLead: t`Sotto looks for new releases on GitHub and installs them itself.`,
    settingsUpdatesByHand: null,
    widgetMicrophoneBlockedDetail: t`Allow microphone access in Windows Settings.`,
    widgetPermissionPromptDetail: t`Approve access in Windows`,
    widgetProcessingDetail: t`Transcribed on this computer, never saved`,
  }),
  linux: (): PlatformCopy => ({
    platform: 'linux',
    helpMicrophoneAccess:
      t`If recording cannot start, check that your microphone is connected and not muted. Choose an available input in Sotto Settings, then test again.`,
    helpPasteFallback:
      t`Sotto copies your text, then pastes into the focused window on Hyprland, terminals included. If paste does not get through, use Super+V, Omarchy’s universal paste for apps and terminals. Release any held keys first.`,
    accessibilityHelp: null,
    openRouterKeyUnreadable:
      t`Sotto could not read the saved OpenRouter key. Nothing was deleted. Unlock your keyring and reopen Sotto, or enter the key again in Settings → Cleanup.`,
    homeMicrophonePermissionDenied:
      t`Microphone access is off. Check your microphone access, then try again.`,
    homeRequestingPermissionDetail: t`Allow microphone access if asked.`,
    onboardingMicrophoneDenied:
      t`Allow microphone access if asked, then test again.`,
    onboardingMicrophoneMissing:
      t`Connect or enable an input device in your sound settings, then try again.`,
    settingsReducedMotionDescription: t`Follow the system or minimize non-essential motion.`,
    settingsMicrophoneUnavailable: t`Microphones are unavailable. Check your input device, then test again.`,
    settingsMicrophoneDenied: t`Microphone access is blocked. Allow access if asked, then test again.`,
    settingsMicrophoneDefaultOption: t`System default`,
    settingsGlobalShortcutDescription: t`Compositor bindings live in Hyprland, not in Sotto. Once Sotto’s bindings are installed, change them in Settings › Dictation: press a shortcut, hold the new keys and let go, and Sotto rewrites its bindings and reloads Hyprland.`,
    settingsAutoPasteDescription: t`Pastes into the focused window, terminals included. If it doesn’t arrive, press Super+V.`,
    settingsLaunchAtStartupLabel: t`Launch when you sign in`,
    settingsStartupFailureNotice: t`Launch at sign-in could not be updated.`,
    settingsStartMinimizedDescription: t`Open directly in the tray when Sotto launches.`,
    settingsUpdatesLead: t`Sotto never updates itself on Linux. New versions come through pacman.`,
    settingsUpdatesByHand: t`Install the next sotto-bin package with sudo pacman -U. Once sotto-bin is in a package repository, omarchy update brings it.`,
    widgetMicrophoneBlockedDetail: t`Allow microphone access if asked.`,
    widgetPermissionPromptDetail: t`Allow microphone access if asked`,
    widgetProcessingDetail: t`Transcribed on this computer, never saved`,
  }),
  darwin: (): PlatformCopy => ({
    platform: 'darwin',
    helpMicrophoneAccess:
      t`If recording cannot start, open System Settings, then Privacy & Security, then Microphone, and allow Sotto. Choose an available input in Sotto Settings.`,
    helpPasteFallback:
      t`Sotto is clipboard first: successful text is always copied. Automatic paste may be blocked in secure input fields and applications with custom input handling. When that happens, paste manually with ⌘V.`,
    accessibilityHelp:
      t`Automatic paste needs two macOS permissions: System Settings > Privacy & Security > Accessibility, and System Settings > Privacy & Security > Automation, where Sotto must be allowed to control System Events. Until both are granted, transcripts are copied to the clipboard instead and you can paste them manually with ⌘V. After an update, if paste still fails, remove Sotto from the Accessibility list and add it again.`,
    openRouterKeyUnreadable:
      t`Sotto could not read the saved OpenRouter key. Nothing was deleted. Quit and reopen Sotto, then allow Keychain access when macOS asks, or enter the key again in Settings → Cleanup.`,
    homeMicrophonePermissionDenied:
      t`Microphone access is off. Check System Settings > Privacy & Security > Microphone, then try again.`,
    homeRequestingPermissionDetail: t`macOS may ask for access.`,
    onboardingMicrophoneDenied:
      t`Turn on Sotto in System Settings > Privacy & Security > Microphone, then test again.`,
    onboardingMicrophoneMissing:
      t`Connect or enable an input device in System Settings > Sound, then try again.`,
    settingsReducedMotionDescription: t`Follow macOS or minimize non-essential motion.`,
    settingsMicrophoneUnavailable:
      t`Microphones are unavailable. Check System Settings > Privacy & Security > Microphone.`,
    settingsMicrophoneDenied:
      t`Microphone access is blocked. Turn on Sotto in System Settings > Privacy & Security > Microphone, then test again.`,
    settingsMicrophoneDefaultOption: t`System default`,
    settingsGlobalShortcutDescription: t`Starts and stops dictation from anywhere in macOS.`,
    settingsAutoPasteDescription: t`Presses ⌘V in the app you were using. Some apps block it.`,
    settingsLaunchAtStartupLabel: t`Launch when your Mac starts`,
    settingsStartupFailureNotice: t`The login item could not be updated.`,
    settingsStartMinimizedDescription: t`Open directly in the menu bar when Sotto launches.`,
    settingsUpdatesLead: t`Sotto looks for new releases on GitHub and installs them itself.`,
    settingsUpdatesByHand: null,
    widgetMicrophoneBlockedDetail: t`Allow microphone access in System Settings.`,
    widgetPermissionPromptDetail: t`Approve access in macOS`,
    widgetProcessingDetail: t`Transcribed on this computer, never saved`,
  }),
})

/** Manual compositor-binding instructions, also linked from Linux help. */
export const LINUX_BINDINGS_GUIDE_URL = 'https://github.com/millZach/Sotto/blob/main/apps/omarchy/README.md#install-the-bindings'

/** The rows written in the language shown, one frozen object per platform until the language changes. */
let written: { readonly locale: string; readonly rows: Partial<Record<SottoPlatform, PlatformCopy>> } = { locale: '', rows: {} }

export function platformCopy(platform: SottoPlatform): PlatformCopy {
  if (written.locale !== i18n.locale) written = { locale: i18n.locale, rows: {} }
  return written.rows[platform] ??= Object.freeze(PLATFORM_COPY[platform]())
}
