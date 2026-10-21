import { defaultHotkey, type SottoPlatform } from '../shared/platform'

/**
 * Sotto's menu bar item on macOS, for every build of the app. Never change it: a new value is a new
 * item to AppKit, which forgets the item's saved position and visibility.
 */
export const MAC_TRAY_GUID = 'b51ae4d7-15a7-440a-89e1-f227a7cad4c0'

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
   * The tray's fixed identity, or null to let the system pick. On macOS Electron makes it the status
   * item's autosave name, the key AppKit saves the item's position and visibility under; without it
   * the item has only AppKit's positional default ("Item-0").
   * Windows binds a tray GUID to the executable's path or signature, so it stays unset there.
   */
  readonly trayGuid: string | null
  readonly inAppUpdates: boolean
  readonly pasteRequiresAccessibilityTrust: boolean
  readonly pasteUsesWarmHelper: boolean
  readonly requiresMediaAccessGate: boolean
  readonly defaultHotkey: string
}

function immutableProfile(profile: PlatformProfile): PlatformProfile {
  return Object.freeze({
    ...profile,
    trafficLightPosition:
      profile.trafficLightPosition === null
        ? null
        : Object.freeze(profile.trafficLightPosition),
    trayIcon: Object.freeze(profile.trayIcon),
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
      trayGuid: null,
      inAppUpdates: true,
      pasteRequiresAccessibilityTrust: false,
      pasteUsesWarmHelper: true,
      requiresMediaAccessGate: false,
      defaultHotkey: defaultHotkey('win32'),
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
      inAppUpdates: false,
      pasteRequiresAccessibilityTrust: true,
      pasteUsesWarmHelper: false,
      requiresMediaAccessGate: true,
      defaultHotkey: defaultHotkey('darwin'),
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
      trayGuid: null,
      inAppUpdates: false,
      pasteRequiresAccessibilityTrust: false,
      pasteUsesWarmHelper: false,
      requiresMediaAccessGate: false,
      defaultHotkey: defaultHotkey('linux'),
    }),
  })

export function platformProfile(platform: SottoPlatform): PlatformProfile {
  return PLATFORM_PROFILES[platform]
}
