import { defaultHotkey, type SottoPlatform } from '../shared/platform'

export type MainWindowChrome = 'frameless' | 'hidden-inset'

export type ApplicationMenuTemplate = 'none' | 'macos'

export type WidgetAlwaysOnTopLevel = 'normal' | 'floating' | 'screen-saver'

/** The system material a frosted main window draws behind the room (ADR-0048). */
export type WindowFrost = 'acrylic' | 'vibrancy'

/**
 * Windows draws acrylic behind a window from Windows 11 22H2 (build 22621); earlier builds have nothing to draw,
 * so the setting is not offered there. Every macOS Sotto runs on has window vibrancy.
 */
export function windowFrostFor(platform: SottoPlatform, release: string): WindowFrost | null {
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
      trayIcon: { kind: 'template', relativePath: 'tray/sottoTemplate.png' },
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
