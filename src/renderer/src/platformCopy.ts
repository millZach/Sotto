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
      'Sotto could not read the saved OpenRouter key. Nothing was deleted. Enter the key again in Settings → Transcription.',
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
    settingsGlobalShortcutDescription: 'Used anywhere in Windows to start and stop dictation.',
    settingsAutoPasteDescription: 'Best-effort Ctrl+V into the previously focused application.',
    settingsLaunchAtStartupLabel: 'Launch when Windows starts',
    settingsStartupFailureNotice: 'Windows startup could not be updated.',
    settingsStartMinimizedDescription: 'Open directly in the tray when Sotto launches.',
    widgetMicrophoneBlockedDetail: 'Allow microphone access in Windows Settings.',
    widgetPermissionPromptDetail: 'Approve access in Windows',
    widgetProcessingDetail: 'Audio stays on this PC',
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
      'Sotto could not read the saved OpenRouter key. Nothing was deleted. Allow Keychain access when macOS asks, or enter the key again in Settings → Transcription.',
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
    settingsGlobalShortcutDescription: 'Used anywhere in macOS to start and stop dictation.',
    settingsAutoPasteDescription: 'Best-effort ⌘V into the previously focused application.',
    settingsLaunchAtStartupLabel: 'Launch when your Mac starts',
    settingsStartupFailureNotice: 'The login item could not be updated.',
    settingsStartMinimizedDescription: 'Open directly in the menu bar when Sotto launches.',
    widgetMicrophoneBlockedDetail: 'Allow microphone access in System Settings.',
    widgetPermissionPromptDetail: 'Approve access in macOS',
    widgetProcessingDetail: 'Audio stays on this Mac',
  }),
})

export function platformCopy(platform: SottoPlatform): PlatformCopy {
  return PLATFORM_COPY[platform]
}
