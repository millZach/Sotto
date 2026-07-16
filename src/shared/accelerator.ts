const modifierAliases = new Map<string, string>([
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

const namedKeys = new Map<string, string>([
  ['space', 'Space'], ['enter', 'Enter'], ['return', 'Enter'], ['tab', 'Tab'],
  ['backspace', 'Backspace'], ['delete', 'Delete'], ['insert', 'Insert'],
  ['home', 'Home'], ['end', 'End'], ['pageup', 'PageUp'], ['pagedown', 'PageDown'],
  ['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'],
])

function friendlyKey(key: string): string {
  return key === 'CommandOrControl' || key === 'CmdOrCtrl' || key === 'Control' ? 'Ctrl' : key
}

export function formatWindowsAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((key) => friendlyKey(key.trim()))
    .filter(Boolean)
    .join('+')
}

export function parseWindowsAccelerator(value: string): string | null {
  const tokens = value.split('+').map((token) => token.trim()).filter(Boolean)
  if (tokens.length < 2 || tokens.some((token) => /\s/u.test(token))) return null
  const modifiers: string[] = []
  const keys: string[] = []
  for (const token of tokens) {
    const modifier = modifierAliases.get(token.toLowerCase())
    if (modifier !== undefined) modifiers.push(modifier)
    else {
      const lower = token.toLowerCase()
      const named = namedKeys.get(lower)
      keys.push(named ?? (/^f(?:[1-9]|1[0-9]|2[0-4])$/iu.test(token) ? token.toUpperCase() : token.length === 1 ? token.toUpperCase() : token))
    }
  }
  if (keys.length !== 1 || modifiers.length === 0 || new Set(modifiers).size !== modifiers.length) return null
  return [...modifiers, keys[0]!].join('+')
}
