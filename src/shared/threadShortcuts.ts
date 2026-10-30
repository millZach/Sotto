import { z } from 'zod'

import type { SottoPlatform } from './platform'

/**
 * The keyboard shortcuts for working in threads and switching pages (Settings › Keyboard, ADR-0133, ADR-0158), in T3's chord spelling
 * (`mod+shift+n`: mod is Command on macOS and Control elsewhere). They are read from keydown events while
 * Sotto's window holds the keys — never registered with the system, unlike dictation's (`dictationShortcuts.ts`).
 * This module owns the ids, their defaults and the shape a saved chord must have; the renderer owns the words.
 */

/** The page shortcuts (ADR-0158): one for each page the room switch and page links reach, in their order. */
export const PAGE_SHORTCUT_IDS = ['page-dictate', 'page-watcher', 'page-threads', 'page-usage', 'page-settings'] as const
export type PageShortcutId = (typeof PAGE_SHORTCUT_IDS)[number]

/** Whether a shortcut opens a page rather than acting in threads. */
export function isPageShortcut(id: string): id is PageShortcutId {
  return (PAGE_SHORTCUT_IDS as readonly string[]).includes(id)
}

export const THREAD_SHORTCUT_IDS = [
  ...PAGE_SHORTCUT_IDS,
  'new-thread',
  'settle',
  'restore',
  'open-beside',
  'next-thread',
  'previous-thread',
  'next-waiting',
  'zoom-pane',
  'close-pane',
  'focus-prompt',
  'stop-turn',
  'add-selection',
  'changes',
  'terminal-drawer',
  'branch',
  'working-copy',
  'previous-working-copy',
] as const

export type ThreadShortcutId = (typeof THREAD_SHORTCUT_IDS)[number]

/**
 * The chord each shortcut answers to until the user picks another. Every chord Sotto already shipped is
 * its own default, so an upgraded install keeps its keys — Zoom pane alone moves, from `ctrl+shift+m` on
 * every platform to the mod pattern the rest follow (on Windows and Linux mod is Ctrl, so nothing moves there).
 * The page shortcuts are new, and number the pages 1 to 5 in the order the switch and links draw them.
 */
export const DEFAULT_THREAD_SHORTCUTS: Readonly<Record<ThreadShortcutId, string>> = Object.freeze({
  'page-dictate': 'mod+1',
  'page-watcher': 'mod+2',
  'page-threads': 'mod+3',
  'page-usage': 'mod+4',
  'page-settings': 'mod+5',
  'new-thread': 'mod+shift+n',
  'settle': 'mod+shift+e',
  'restore': 'mod+alt+r',
  'open-beside': 'ctrl+enter',
  'next-thread': 'mod+alt+arrowdown',
  'previous-thread': 'mod+alt+arrowup',
  'next-waiting': 'mod+shift+u',
  'zoom-pane': 'mod+shift+m',
  'close-pane': 'mod+shift+w',
  'focus-prompt': 'mod+l',
  'stop-turn': 'mod+shift+s',
  'add-selection': 'mod+shift+a',
  'changes': 'mod+d',
  'terminal-drawer': 'mod+j',
  'branch': 'mod+shift+g',
  'working-copy': 'mod+shift+x',
  'previous-working-copy': 'mod+shift+l',
})

/**
 * The chords the application menu answers before the renderer sees the keys, so no thread shortcut may
 * claim them however they are spelled. Every platform has Sotto's own menu (`applicationMenu.ts`), and
 * Close and Actual Size are the recordable keys it owns in a shipped build. Its other zoom keys
 * (Ctrl+=/-), Settings (Ctrl+, or Cmd+,) and a Mac's full screen cannot end a thread chord, so they need
 * no entry; reload and developer tools come only with an unpackaged run (#1825).
 */
export function menuOwnedChords(platform: SottoPlatform): readonly string[] {
  return platform === 'darwin' ? ['mod+w', 'mod+0'] : ['ctrl+w', 'ctrl+0']
}

/** The modifier spellings `parseChord` (renderer) understands, so a hand-written chord classifies the same way here. */
const MODIFIER_TOKENS: ReadonlySet<string> = new Set(['mod', 'ctrl', 'control', 'alt', 'option', 'shift', 'meta', 'cmd', 'command'])
/** A primary modifier: without one (Alt or Shift alone), a chord could be plain typing on some layout. */
const PRIMARY_TOKENS: ReadonlySet<string> = new Set(['mod', 'ctrl', 'control', 'meta', 'cmd', 'command'])
/** The keys a thread shortcut may end on: what the Settings recorder can hear, minus keys that already mean something everywhere (Tab, Escape, Backspace). */
const KEY_PATTERN = /^(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|space|enter|arrowup|arrowdown|arrowleft|arrowright)$/u

/**
 * Whether a string is a chord a thread shortcut may use: modifiers from T3's spelling, a primary modifier
 * among them, and exactly one allowed key. The same rule refuses a recording in Settings and repairs a
 * damaged settings file, so the two can never disagree.
 */
export function isThreadChord(chord: string): boolean {
  const tokens = chord.toLowerCase().split('+').map(token => token.trim()).filter(Boolean)
  if (tokens.length < 2) return false
  const key = tokens.at(-1)!
  const modifiers = tokens.slice(0, -1)
  if (!KEY_PATTERN.test(key) || modifiers.some(token => !MODIFIER_TOKENS.has(token))) return false
  if (new Set(modifiers).size !== modifiers.length) return false
  return modifiers.some(token => PRIMARY_TOKENS.has(token))
}

const threadChordSchema = z.string().min(1).max(64).refine(isThreadChord)
const threadShortcutIdSchema = z.enum(THREAD_SHORTCUT_IDS)
const threadChordChoiceSchema = threadChordSchema.nullable()
export const threadShortcutChoicesSchema = z.partialRecord(z.enum(THREAD_SHORTCUT_IDS), threadChordSchema.nullable())
/**
 * The rows the user chose under Settings › Keyboard, by shortcut. A row left out follows its default in
 * `DEFAULT_THREAD_SHORTCUTS`; a row set to null has no shortcut (its button still works). Nothing here
 * changes when a shortcut is added or retired: a new row simply starts on its default.
 */
export type ThreadShortcutChoices = z.infer<typeof threadShortcutChoicesSchema>

/** Read leniently, one row at a time, so a damaged or retired row costs the user only that row. */
export function parseThreadShortcutChoices(input: unknown): ThreadShortcutChoices {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const choices: ThreadShortcutChoices = {}
  for (const [key, value] of Object.entries(input)) {
    const id = threadShortcutIdSchema.safeParse(key)
    const chord = threadChordChoiceSchema.safeParse(value)
    if (id.success && chord.success) choices[id.data] = chord.data
  }
  return choices
}

/** The chord a shortcut answers to under these choices: the chosen one, none where the user removed it, else the default. */
export function resolveThreadShortcut(choices: ThreadShortcutChoices, id: ThreadShortcutId): string | null {
  return Object.hasOwn(choices, id) ? choices[id] ?? null : DEFAULT_THREAD_SHORTCUTS[id]
}
