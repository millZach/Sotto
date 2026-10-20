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
// seam existed; changing one changes Windows-visible copy.
const PLATFORM_COPY: Readonly<Record<SottoPlatform, PlatformCopy>> = Object.freeze({
  win32: Object.freeze({
    platform: 'win32',
    helpMicrophoneAccess:
      'If recording cannot start, open Windows Settings, then Privacy or Privacy & security, then Microphone, and allow desktop apps. Choose an available input in Sotto Settings.',
    helpPasteFallback:
      'Sotto is clipboard first: successful text is always copied. Automatic paste may be blocked in elevated, protected, or password fields and applications with custom input handling. When that happens, paste manually with Ctrl+V.',
    accessibilityHelp: null,
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
    settingsUpdatesByHand: null,
    widgetMicrophoneBlockedDetail: 'Allow microphone access in Windows Settings.',
    widgetPermissionPromptDetail: 'Approve access in Windows',
    widgetProcessingDetail: 'Transcribed on this computer, never saved',
  }),
  linux: Object.freeze({
    platform: 'linux',
    helpMicrophoneAccess:
      'If recording cannot start, check that your microphone is connected and not muted. Choose an available input in Sotto Settings, then test again.',
    helpPasteFallback:
      'Sotto copies your text, then pastes into the focused window on Hyprland, terminals included. If paste does not get through, use Super+V, Omarchy’s universal paste for apps and terminals. Release any held keys first.',
    accessibilityHelp: null,
    openRouterKeyUnreadable:
      'Sotto could not read the saved OpenRouter key. Nothing was deleted. Unlock your keyring and reopen Sotto, or enter the key again in Settings → Cleanup.',
    homeMicrophonePermissionDenied:
      'Microphone access is off. Check your microphone access, then try again.',
    homeRequestingPermissionDetail: 'Allow microphone access if asked.',
    onboardingMicrophoneDenied:
      'Allow microphone access if asked, then test again.',
    onboardingMicrophoneMissing:
      'Connect or enable an input device in your sound settings, then try again.',
    settingsReducedMotionDescription: 'Follow the system or minimize non-essential motion.',
    settingsMicrophoneUnavailable: 'Microphones are unavailable. Check your input device, then test again.',
    settingsMicrophoneDenied: 'Microphone access is blocked. Allow access if asked, then test again.',
    settingsMicrophoneDefaultOption: 'System default',
    settingsGlobalShortcutDescription: 'Compositor bindings live in Hyprland, not in Sotto. Once Sotto’s bindings are installed, change them in Settings › Dictation: press a shortcut, hold the new keys and let go, and Sotto rewrites its bindings and reloads Hyprland.',
    settingsAutoPasteDescription: 'Pastes into the focused window, terminals included. If it doesn’t arrive, press Super+V.',
    settingsLaunchAtStartupLabel: 'Launch when you sign in',
    settingsStartupFailureNotice: 'Launch at sign-in could not be updated.',
    settingsStartMinimizedDescription: 'Open directly in the tray when Sotto launches.',
    settingsUpdatesLead: 'Sotto never updates itself on Linux. New versions come through pacman.',
    settingsUpdatesByHand: 'Install the next sotto-bin package with sudo pacman -U. Once sotto-bin is in a package repository, omarchy update brings it.',
    widgetMicrophoneBlockedDetail: 'Allow microphone access if asked.',
    widgetPermissionPromptDetail: 'Allow microphone access if asked',
    widgetProcessingDetail: 'Transcribed on this computer, never saved',
  }),
  darwin: Object.freeze({
    platform: 'darwin',
    helpMicrophoneAccess:
      'If recording cannot start, open System Settings, then Privacy & Security, then Microphone, and allow Sotto. Choose an available input in Sotto Settings.',
    helpPasteFallback:
      'Sotto is clipboard first: successful text is always copied. Automatic paste may be blocked in secure input fields and applications with custom input handling. When that happens, paste manually with ⌘V.',
    accessibilityHelp:
      'Automatic paste needs two macOS permissions: System Settings > Privacy & Security > Accessibility, and System Settings > Privacy & Security > Automation, where Sotto must be allowed to control System Events. Until both are granted, transcripts are copied to the clipboard instead and you can paste them manually with ⌘V. After an update, if paste still fails, remove Sotto from the Accessibility list and add it again.',
    openRouterKeyUnreadable:
      'Sotto could not read the saved OpenRouter key. Nothing was deleted. Quit and reopen Sotto, then allow Keychain access when macOS asks, or enter the key again in Settings → Cleanup.',
    homeMicrophonePermissionDenied:
      'Microphone access is off. Check System Settings > Privacy & Security > Microphone, then try again.',
    homeRequestingPermissionDetail: 'macOS may ask for access.',
    onboardingMicrophoneDenied:
      'Turn on Sotto in System Settings > Privacy & Security > Microphone, then test again.',
    onboardingMicrophoneMissing:
      'Connect or enable an input device in System Settings > Sound, then try again.',
    settingsReducedMotionDescription: 'Follow macOS or minimize non-essential motion.',
    settingsMicrophoneUnavailable:
      'Microphones are unavailable. Check System Settings > Privacy & Security > Microphone.',
    settingsMicrophoneDenied:
      'Microphone access is blocked. Turn on Sotto in System Settings > Privacy & Security > Microphone, then test again.',
    settingsMicrophoneDefaultOption: 'System default',
    settingsGlobalShortcutDescription: 'Starts and stops dictation from anywhere in macOS.',
    settingsAutoPasteDescription: 'Presses ⌘V in the app you were using. Some apps block it.',
    settingsLaunchAtStartupLabel: 'Launch when your Mac starts',
    settingsStartupFailureNotice: 'The login item could not be updated.',
    settingsStartMinimizedDescription: 'Open directly in the menu bar when Sotto launches.',
    settingsUpdatesLead: 'Sotto looks for new releases on GitHub and installs them itself.',
    settingsUpdatesByHand: null,
    widgetMicrophoneBlockedDetail: 'Allow microphone access in System Settings.',
    widgetPermissionPromptDetail: 'Approve access in macOS',
    widgetProcessingDetail: 'Transcribed on this computer, never saved',
  }),
})

/** Manual compositor-binding instructions, also linked from Linux help. */
export const LINUX_BINDINGS_GUIDE_URL = 'https://github.com/millZach/Sotto/blob/main/apps/omarchy/README.md#install-the-bindings'

export function platformCopy(platform: SottoPlatform): PlatformCopy {
  return PLATFORM_COPY[platform]
}
