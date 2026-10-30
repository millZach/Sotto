import { defaultHoldShortcuts, defaultHotkey, type SottoPlatform } from '../shared/platform'
import type { ReleaseTrack } from '../shared/releaseTrack'

/**
 * Sotto's menu bar item on macOS, for every build of the app. Never change it: a new value is a new
 * item to AppKit, which forgets the item's saved position and visibility.
 */
export const MAC_TRAY_GUID = 'b51ae4d7-15a7-440a-89e1-f227a7cad4c0'

export type MainWindowChrome = 'frameless' | 'hidden-inset'

/** A Mac shows its application menu; Windows and Linux carry one only for its keys, and the tray is their one menu (#1825). */
export type ApplicationMenuTemplate = 'hidden' | 'macos'

export type WidgetAlwaysOnTopLevel = 'normal' | 'floating' | 'screen-saver'

/**
 * The material Glass draws behind a see-through main window (ADR-0150). Windows draws Acrylic from Windows 11 22H2
 * (build 22621); earlier builds have none, and Glass paints its own backdrop there. Every macOS Sotto runs on has
 * window vibrancy. Linux has no blur behind a window Sotto can rely on.
 */
export function glassMaterialFor(platform: SottoPlatform, release: string): 'acrylic' | 'vibrancy' | null {
  if (platform === 'darwin') return 'vibrancy'
  if (platform !== 'win32') return null
  const build = Number(release.split('.')[2])
  return Number.isInteger(build) && build >= 22_621 ? 'acrylic' : null
}

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
   * The tray's fixed identity, or null to let the system pick. On macOS Electron makes it the status
   * item's autosave name, the key AppKit saves the item's position and visibility under; without it
   * the item has only AppKit's positional default ("Item-0").
   * Windows binds a tray GUID to the executable's path or signature, so it stays unset there.
   */
  readonly trayGuid: string | null
  /**
   * The release tracks whose installed app updates itself here (ADR-0093). macOS's updater takes only an update
   * signed by the same developer as the running app, and only Owl is signed with Sotto's Developer ID; stable on a
   * Mac is ad-hoc signed and has no update feed. Linux has no in-app updater on either track (ADR-0062).
   */
  readonly inAppUpdateTracks: readonly ReleaseTrack[]
  readonly pasteRequiresAccessibilityTrust: boolean
  readonly pasteUsesWarmHelper: boolean
  readonly requiresMediaAccessGate: boolean
  /**
   * Whether the desktop shows a system notification when a thread needs the user or has finished everything (ADR-0117).
   * macOS only, so far: Windows and Linux stay as they are until the feature is checked there.
   */
  readonly desktopNotifications: boolean
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
      applicationMenu: 'hidden',
      // 'floating' silently fails to apply WS_EX_TOPMOST on current Windows 11
      // builds; 'normal' sticks and survives hide/show.
      widgetAlwaysOnTopLevel: 'normal',
      widgetFocusable: false,
      widgetVisibleOnAllWorkspaces: false,
      widgetIsPanel: false,
      trayIcon: { kind: 'executable' },
      trayGuid: null,
      inAppUpdateTracks: ['stable', 'owl'],
      pasteRequiresAccessibilityTrust: false,
      pasteUsesWarmHelper: true,
      requiresMediaAccessGate: false,
      desktopNotifications: false,
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
      trayGuid: MAC_TRAY_GUID,
      inAppUpdateTracks: ['owl'],
      pasteRequiresAccessibilityTrust: true,
      pasteUsesWarmHelper: false,
      requiresMediaAccessGate: true,
      desktopNotifications: true,
      defaultHotkey: defaultHotkey('darwin'),
      defaultHoldShortcuts: defaultHoldShortcuts('darwin'),
    }),
    linux: immutableProfile({
      platform: 'linux',
      mainWindowChrome: 'frameless',
      trafficLightPosition: null,
      applicationMenu: 'hidden',
      widgetAlwaysOnTopLevel: 'normal',
      widgetFocusable: false,
      widgetVisibleOnAllWorkspaces: false,
      widgetIsPanel: false,
      trayIcon: { kind: 'image', relativePath: 'icon.png' },
      trayGuid: null,
      inAppUpdateTracks: [],
      pasteRequiresAccessibilityTrust: false,
      pasteUsesWarmHelper: false,
      requiresMediaAccessGate: false,
      desktopNotifications: false,
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
