import type { SottoPlatform } from './platform'

export type AcceleratorStyle = 'display' | 'editing'

const win32ModifierAliases = new Map<string, string>([
  ['commandorcontrol', 'CommandOrControl'],
  ['cmdorctrl', 'CommandOrControl'],
  ['control', 'CommandOrControl'],
  ['ctrl', 'CommandOrControl'],
  ['shift', 'Shift'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['super', 'Super'],
  ['meta', 'Super'],
  ['win', 'Super'],
  ['windows', 'Super'],
])

// Control is its own canonical token on macOS because the default hotkey binds
// the literal Control key; Super/Meta collapse into CommandOrControl so the same
// physical chord always canonicalizes to the same string.
const darwinModifierAliases = new Map<string, string>([
  ['commandorcontrol', 'CommandOrControl'],
  ['cmdorctrl', 'CommandOrControl'],
  ['command', 'CommandOrControl'],
  ['cmd', 'CommandOrControl'],
  ['super', 'CommandOrControl'],
  ['meta', 'CommandOrControl'],
  ['⌘', 'CommandOrControl'],
  ['control', 'Control'],
  ['ctrl', 'Control'],
  ['⌃', 'Control'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['⌥', 'Alt'],
  ['shift', 'Shift'],
  ['⇧', 'Shift'],
  ['fn', 'Fn'],
])

const modifierAliases: Readonly<Record<SottoPlatform, ReadonlyMap<string, string>>> =
  Object.freeze({ win32: win32ModifierAliases, darwin: darwinModifierAliases, linux: win32ModifierAliases })

const darwinModifierGlyphs = new Map<string, string>([
  ['CommandOrControl', '⌘'],
  ['Control', '⌃'],
  ['Alt', '⌥'],
  ['Shift', '⇧'],
  ['Fn', 'Fn'],
])

const darwinModifierWords = new Map<string, string>([
  ['CommandOrControl', 'Command'],
  ['Control', 'Control'],
  ['Alt', 'Option'],
  ['Shift', 'Shift'],
  ['Fn', 'Fn'],
])

const namedKeys = new Map<string, string>([
  ['space', 'Space'], ['enter', 'Enter'], ['return', 'Enter'], ['tab', 'Tab'],
  ['backspace', 'Backspace'], ['delete', 'Delete'], ['insert', 'Insert'],
  ['home', 'Home'], ['end', 'End'], ['pageup', 'PageUp'], ['pagedown', 'PageDown'],
  ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
  ['escape', 'Escape'], ['esc', 'Escape'],
])

function formatWin32Token(key: string, platform: SottoPlatform): string {
  if (key === 'Super' && platform === 'win32') return 'Win'
  return key === 'CommandOrControl' || key === 'CmdOrCtrl' || key === 'Control' ? 'Ctrl' : key
}

function formatDarwinToken(key: string, style: AcceleratorStyle): string {
  const canonical = darwinModifierAliases.get(key.toLowerCase())
  if (canonical === undefined) return key
  const labels = style === 'display' ? darwinModifierGlyphs : darwinModifierWords
  return labels.get(canonical) ?? key
}

// Both styles stay '+'-joined, including the glyph form, so every formatted
// string feeds straight back into parseAccelerator.
export function formatAccelerator(
  accelerator: string,
  platform: SottoPlatform,
  style: AcceleratorStyle,
): string {
  return accelerator
    .split('+')
    .map((key) => {
      const token = key.trim()
      return platform === 'darwin' ? formatDarwinToken(token, style) : formatWin32Token(token, platform)
    })
    .filter(Boolean)
    .join('+')
}

export function acceleratorModifier(token: string, platform: SottoPlatform): string | undefined {
  return modifierAliases[platform].get(token.trim().toLowerCase())
}

export function acceleratorKey(token: string): string {
  const named = namedKeys.get(token.toLowerCase())
  return named ?? (/^f(?:[1-9]|1[0-9]|2[0-4])$/iu.test(token) ? token.toUpperCase() : token.length === 1 ? token.toUpperCase() : token)
}

export function parseAccelerator(value: string, platform: SottoPlatform): string | null {
  const tokens = value.split('+').map((token) => token.trim()).filter(Boolean)
  if (tokens.length < 2 || tokens.some((token) => /\s/u.test(token))) return null
  const modifiers: string[] = []
  const keys: string[] = []
  for (const token of tokens) {
    const modifier = acceleratorModifier(token, platform)
    if (modifier !== undefined) modifiers.push(modifier)
    else keys.push(acceleratorKey(token))
  }
  if (keys.length !== 1 || modifiers.length === 0 || new Set(modifiers).size !== modifiers.length) return null
  return [...modifiers, keys[0]!].join('+')
}
