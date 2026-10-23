import type { AppSettings, SettingsPatch } from '../../../shared/settings'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import type { SottoPlatform } from '../../../shared/platform'
import { chordClaimed, chordMatches } from '../agents/branchToolbar.logic'

type Preferences = Pick<AppSettings, 'hotkey' | 'terminalFontSize'>
let confirmed: Preferences = DEFAULT_SETTINGS
let fontSize = DEFAULT_SETTINGS.terminalFontSize
let save: ((patch: SettingsPatch) => Promise<boolean>) | undefined
let pending = 0
const listeners = new Set<() => void>()
const zoomDiag = (label: string): void => { (window as { __zoomDiag?: [string, number][] }).__zoomDiag?.push([label, Date.now()]) }
const notify = (): void => { for (const listener of listeners) listener() }

/** App owns settings and serializes saves. Views outlive their panes, so they read the current preferences here. */
export function setTerminalPreferences(settings: Preferences, update: (patch: SettingsPatch) => Promise<boolean>): void {
  confirmed = settings
  save = update
  if (!pending) fontSize = settings.terminalFontSize
  notify()
}

export const terminalFontSize = (): number => fontSize
export function followTerminalFontSize(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Save every press in order, without an older acknowledgement undoing the next press's size. */
export async function zoomTerminal(action: 'larger' | 'smaller' | 'reset'): Promise<boolean> {
  if (!save) return false
  const next = action === 'reset' ? DEFAULT_SETTINGS.terminalFontSize : Math.max(8, Math.min(32, fontSize + (action === 'larger' ? 1 : -1)))
  zoomDiag(`zoom ${action} ${fontSize}->${next} pending${pending}`)
  if (next === fontSize) return true
  fontSize = next
  pending++
  notify()
  try {
    const saved = await save({ terminalFontSize: next })
    zoomDiag(`saved ${next} ${saved}`)
    if (saved) confirmed = { ...confirmed, terminalFontSize: next }
    return saved
  }
  catch { return false }
  finally {
    pending--
    if (!pending) { fontSize = confirmed.terminalFontSize; notify() }
  }
}

/** Only the focused terminal takes these chords, and a configured dictation chord always wins. */
export function terminalShortcut(event: KeyboardEvent, platform: SottoPlatform): 'search' | 'larger' | 'smaller' | 'reset' | null {
  if (event.isComposing || event.defaultPrevented) return null
  const configuredHotkey = platform === 'darwin' ? confirmed.hotkey : confirmed.hotkey.replace(/\+\s*plus\s*$/iu, '+=')
  // Plus is Shift+Equals on most keyboards; keypad Plus has no Shift.
  if (platform !== 'darwin' && (event.key === '+' || event.key === '=' && event.shiftKey && event.code === 'Equal')) {
    const chord = event.shiftKey ? 'mod+shift+=' : 'mod+='
    const hotkey = event.code === 'NumpadAdd' ? configuredHotkey.replace(/\+\s*numadd\s*$/iu, '+=') : configuredHotkey
    if (chordClaimed(chord, hotkey, platform) && chordMatches({ key: '=', ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey }, chord, platform)) return 'larger'
    return null
  }
  // Electron names keypad accelerators differently from the DOM key; compare the actual keypad press.
  const hotkey = event.code === 'NumpadSubtract' ? configuredHotkey.replace(/\+\s*numsub\s*$/iu, '+-')
    : event.code === 'Numpad0' ? configuredHotkey.replace(/\+\s*num0\s*$/iu, '+0') : configuredHotkey
  for (const [chord, action] of [['mod+f', 'search'], ['mod+=', 'larger'], ['mod+-', 'smaller'], ['mod+0', 'reset']] as const) {
    if (chordClaimed(chord, hotkey, platform) && chordMatches(event, chord, platform)) return action
  }
  return null
}
