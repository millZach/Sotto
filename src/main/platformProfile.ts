import { defaultHoldShortcuts, defaultHotkey, type SottoPlatform } from '../shared/platform'
import type { ReleaseTrack } from '../shared/releaseTrack'

export type MainWindowChrome = 'frameless' | 'hidden-inset'

export type ApplicationMenuTemplate = 'none' | 'macos'

export type WidgetAlwaysOnTopLevel = 'normal' | 'floating' | 'screen-saver'

export interface TrafficLightPosition {
  readonly x: number
  readonly y: number
}

export type TrayIconSource =
  | { readonly kind: 'executable' }
  | { readonly kind: 'template'; readonly relativePath: string }
  | { readonly kind: 'image'; readonly relativePath: string }

export interface PlatformProfile {
  readonly platform: SottoPlatform
  readonly mainWindowChrome: MainWindowChrome
  readonly trafficLightPosition: TrafficLightPosition | null
  readonly applicationMenu: ApplicationMenuTemplate
  readonly widgetAlwaysOnTopLevel: WidgetAlwaysOnTopLevel
  readonly widgetFocusable: boolean
  readonly widgetVisibleOnAllWorkspaces: boolean
  /**
   * A macOS panel can float over another app's full-screen desktop while the app keeps its Dock icon.
   * Never hide the Dock instead: once macOS has treated Sotto as an accessory app, every Sotto window can
   * sit on other apps' full-screen desktops for the rest of the run (ADR-0052).
   */
  readonly widgetIsPanel: boolean
  readonly trayIcon: TrayIconSource
  /**
   * The release tracks whose installed app updates itself here (ADR-0093). macOS's updater takes only an update
   * signed by the same developer as the running app, and only Owl is signed with Sotto's Developer ID; stable on a
   * Mac is ad-hoc signed and has no update feed. Linux has no in-app updater on either track (ADR-0062).
   */
  readonly inAppUpdateTracks: readonly ReleaseTrack[]
  readonly pasteRequiresAccessibilityTrust: boolean
  readonly pasteUsesWarmHelper: boolean
  readonly requiresMediaAccessGate: boolean
  readonly defaultHotkey: string
  readonly defaultHoldShortcuts: readonly string[]
}

function immutableProfile(profile: PlatformProfile): PlatformProfile {
  return Object.freeze({
    ...profile,
    trafficLightPosition:
      profile.trafficLightPosition === null
        ? null
        : Object.freeze(profile.trafficLightPosition),
    trayIcon: Object.freeze(profile.trayIcon),
    inAppUpdateTracks: Object.freeze([...profile.inAppUpdateTracks]),
  })
}

// The win32 row reproduces today's shipped behavior field for field; changing a
// value here changes Windows runtime behavior.
const PLATFORM_PROFILES: Readonly<Record<SottoPlatform, PlatformProfile>> =
  Object.freeze({
    win32: immutableProfile({
      platform: 'win32',
      mainWindowChrome: 'frameless',
      trafficLightPosition: null,
      applicationMenu: 'none',
      // 'floating' silently fails to apply WS_EX_TOPMOST on current Windows 11
      // builds; 'normal' sticks and survives hide/show.
      widgetAlwaysOnTopLevel: 'normal',
      widgetFocusable: false,
      widgetVisibleOnAllWorkspaces: false,
      widgetIsPanel: false,
      trayIcon: { kind: 'executable' },
      inAppUpdateTracks: ['stable', 'owl'],
      pasteRequiresAccessibilityTrust: false,
      pasteUsesWarmHelper: true,
      requiresMediaAccessGate: false,
      defaultHotkey: defaultHotkey('win32'),
      defaultHoldShortcuts: defaultHoldShortcuts('win32'),
    }),
    darwin: immutableProfile({
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
      defaultHotkey: defaultHotkey('darwin'),
      defaultHoldShortcuts: defaultHoldShortcuts('darwin'),
    }),
    linux: immutableProfile({
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
      defaultHotkey: defaultHotkey('linux'),
      defaultHoldShortcuts: defaultHoldShortcuts('linux'),
    }),
  })

export function platformProfile(platform: SottoPlatform): PlatformProfile {
  return PLATFORM_PROFILES[platform]
}

/** Whether the installed app on this platform and track updates itself: Windows on both tracks, a Mac on Owl only. */
export function updatesInApp(profile: PlatformProfile, track: ReleaseTrack): boolean {
  return profile.inAppUpdateTracks.includes(track)
}
