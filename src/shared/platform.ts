export type SottoPlatform = 'win32' | 'darwin' | 'linux'

export const PLATFORM_ARGUMENT_PREFIX = '--sotto-platform='

// Unsupported hosts resolve to win32 so an unexpected process.platform (or a
// missing launch argument) degrades to the shipped Windows behavior instead of
// leaving the platform undefined.
export function resolvePlatform(raw: string): SottoPlatform {
  return raw === 'darwin' || raw === 'linux' ? raw : 'win32'
}

const DEFAULT_HOTKEYS: Readonly<Record<SottoPlatform, string>> = Object.freeze({
  // CommandOrControl resolves to Command on macOS, which collides with Spotlight,
  // so darwin binds the literal Control key instead.
  win32: 'CommandOrControl+Shift+Space',
  darwin: 'Control+Shift+Space',
  linux: 'CommandOrControl+Shift+Space',
})

export function defaultHotkey(platform: SottoPlatform): string {
  return DEFAULT_HOTKEYS[platform]
}

// Willow's defaults: Fn on macOS; Windows never sees Fn, so Ctrl+Win. Linux holds through compositor bindings.
const DEFAULT_HOLD_SHORTCUTS: Readonly<Record<SottoPlatform, readonly string[]>> = Object.freeze({
  win32: Object.freeze(['CommandOrControl+Super']),
  darwin: Object.freeze(['Fn']),
  linux: Object.freeze([]),
})

export function defaultHoldShortcuts(platform: SottoPlatform): readonly string[] {
  return DEFAULT_HOLD_SHORTCUTS[platform]
}
