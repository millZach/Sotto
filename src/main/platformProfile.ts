import { defaultHotkey, type SottoPlatform } from '../shared/platform'

export type MainWindowChrome = 'frameless' | 'hidden-inset'

export type ApplicationMenuTemplate = 'none' | 'macos'

export type DockPresence = 'regular' | 'hidden'

export type WidgetAlwaysOnTopLevel = 'normal' | 'floating' | 'screen-saver'

export interface TrafficLightPosition {
  readonly x: number
  readonly y: number
}

export type TrayIconSource =
  | { readonly kind: 'executable' }
  | { readonly kind: 'template'; readonly relativePath: string }

export interface PlatformProfile {
  readonly platform: SottoPlatform
  readonly mainWindowChrome: MainWindowChrome
  readonly trafficLightPosition: TrafficLightPosition | null
  readonly applicationMenu: ApplicationMenuTemplate
  readonly dockPresence: DockPresence
  readonly widgetAlwaysOnTopLevel: WidgetAlwaysOnTopLevel
  readonly widgetFocusable: boolean
  readonly widgetVisibleOnAllWorkspaces: boolean
  /** A macOS panel can float over another app's full-screen desktop while the app keeps its Dock icon. */
  readonly widgetIsPanel: boolean
  readonly trayIcon: TrayIconSource
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
      dockPresence: 'regular',
      // 'floating' silently fails to apply WS_EX_TOPMOST on current Windows 11
      // builds; 'normal' sticks and survives hide/show.
      widgetAlwaysOnTopLevel: 'normal',
      widgetFocusable: false,
      widgetVisibleOnAllWorkspaces: false,
      widgetIsPanel: false,
      trayIcon: { kind: 'executable' },
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
      // Never hide the Dock, even for a moment. Once macOS has treated the app
      // as an accessory, every Sotto window can sit on another app's
      // full-screen desktop for the rest of the run, not only the pill.
      dockPresence: 'regular',
      widgetAlwaysOnTopLevel: 'floating',
      widgetFocusable: false,
      widgetVisibleOnAllWorkspaces: true,
      widgetIsPanel: true,
      trayIcon: { kind: 'template', relativePath: 'tray/sottoTemplate.png' },
      pasteRequiresAccessibilityTrust: true,
      pasteUsesWarmHelper: false,
      requiresMediaAccessGate: true,
      defaultHotkey: defaultHotkey('darwin'),
    }),
  })

export function platformProfile(platform: SottoPlatform): PlatformProfile {
  return PLATFORM_PROFILES[platform]
}
