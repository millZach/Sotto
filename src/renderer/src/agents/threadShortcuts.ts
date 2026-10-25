import type { SottoPlatform } from '../../../shared/platform'
import type { AppSettings } from '../../../shared/settings'
import { DEFAULT_THREAD_SHORTCUTS, isThreadChord, menuOwnedChords, resolveThreadShortcut, type ThreadShortcutId } from '../../../shared/threadShortcuts'
import { chordBelongsElsewhere } from '../tools/changesShortcut'
import { chordClaimed, chordMatches, parseAccelerator, parseChord } from './branchToolbar.logic'

/** The settings a thread chord is read from: its own row, and dictation's shortcuts, which always win a tie. */
export type ThreadShortcutSettings = Pick<AppSettings, 'threadShortcuts' | 'hotkey' | 'pressShortcuts' | 'holdShortcuts'>

/** The chord a shortcut is set to (ADR-0133): the user's choice, its default, or null where the user removed it. No settings yet reads as defaults. */
export function chosenThreadChord(settings: Pick<AppSettings, 'threadShortcuts'> | null | undefined, id: ThreadShortcutId): string | null {
  return resolveThreadShortcut(settings?.threadShortcuts ?? {}, id)
}

/**
 * The chord a shortcut answers to: its chosen chord, unless there is none or one of dictation's shortcuts
 * already means the same keys — the hotkey itself or an extra press or hold one. Every thread chord has
 * always stood down for dictation, and still does, defaults included: they were never recorded past the
 * Keyboard page's own refusal.
 */
export function claimedThreadChord(settings: ThreadShortcutSettings | null | undefined, id: ThreadShortcutId, platform: SottoPlatform): string | null {
  const chosen = chosenThreadChord(settings, id)
  if (chosen === null) return null
  const dictation = [settings?.hotkey, ...(settings?.pressShortcuts ?? []), ...(settings?.holdShortcuts ?? [])]
  return dictation.every(accelerator => chordClaimed(chosen, accelerator, platform)) ? chosen : null
}

/**
 * The menu-owned chord these keys already are on this platform (`menuOwnedChords`), or null when the
 * application menu does not take them first. Settings refuses the match, so a shortcut can never be
 * recorded onto keys its press would never reach.
 */
export function menuOwnedChord(chord: string, platform: SottoPlatform): string | null {
  return menuOwnedChords(platform).find(owned => sameThreadKeys(chord, owned, platform)) ?? null
}

/**
 * Whether a keydown is a thread chord's to take: the chord itself, not handled or repeating, not typed into
 * a terminal, and no dialog open to answer the keys instead — the guards every thread chord has kept.
 */
export function threadChordPressed(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'defaultPrevented' | 'repeat' | 'target'>, chord: string, platform: SottoPlatform): boolean {
  if (event.defaultPrevented || event.repeat || !chordMatches(event, chord, platform) || chordBelongsElsewhere(event.target)) return false
  return document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') === null
}

/**
 * Whether a sidebar row's keydown opens it beside. At its default the row has always answered to either
 * primary modifier with Enter — Ctrl+click's keyboard twin — so the default keeps both until the user
 * chooses other keys on Settings › Keyboard, when only the chosen chord answers.
 */
export function openBesidePressed(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>, chord: string, platform: SottoPlatform): boolean {
  if (chordMatches(event, chord, platform)) return true
  return chord === DEFAULT_THREAD_SHORTCUTS['open-beside'] && event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
}

/** A chord's key in words: the short form a title shows, and the `aria-keyshortcuts` spelling. */
function keyWords(key: string): { readonly plain: string; readonly keys: string } {
  switch (key) {
    case ' ': return { plain: 'Space', keys: 'Space' }
    case 'enter': return { plain: 'Enter', keys: 'Enter' }
    case 'arrowup': return { plain: 'Up', keys: 'ArrowUp' }
    case 'arrowdown': return { plain: 'Down', keys: 'ArrowDown' }
    case 'arrowleft': return { plain: 'Left', keys: 'ArrowLeft' }
    case 'arrowright': return { plain: 'Right', keys: 'ArrowRight' }
    default: return { plain: key.toUpperCase(), keys: key.toUpperCase() }
  }
}

export interface ThreadChordLabel {
  /** Appended to whatever a button's own label says the press does: "New thread (Ctrl+Shift+N)". */
  readonly suffix: string
  /** The chord in a title's words, unadorned: "Ctrl+Shift+N", or "Cmd+Shift+N" on a Mac. */
  readonly plain: string
  /** The chord in `aria-keyshortcuts` spelling: "Control+Shift+N", or "Meta+Shift+N" on a Mac. */
  readonly keys: string
}

/** The words a chord is shown in, derived from the chord itself so a title can never advertise stale keys. */
export function threadChordLabel(chord: string, platform: SottoPlatform): ThreadChordLabel {
  const parsed = parseChord(chord, platform)
  const darwin = platform === 'darwin'
  const plain: string[] = [], keys: string[] = []
  const add = (short: string, aria: string): void => { plain.push(short); keys.push(aria) }
  if (darwin) {
    if (parsed.meta) add('Cmd', 'Meta')
    if (parsed.ctrl) add('Ctrl', 'Control')
  } else {
    if (parsed.ctrl) add('Ctrl', 'Control')
    if (parsed.meta) add('Win', 'Meta')
  }
  if (parsed.alt) add('Alt', 'Alt')
  if (parsed.shift) add('Shift', 'Shift')
  const key = keyWords(parsed.key)
  plain.push(key.plain); keys.push(key.keys)
  const plainJoined = plain.join('+')
  return { suffix: `(${plainJoined})`, plain: plainJoined, keys: keys.join('+') }
}

/** A T3 chord as the canonical accelerator `ShortcutKey` and dictation's chord words read, for showing it in Settings. */
export function acceleratorForChord(chord: string, platform: SottoPlatform): string {
  const parsed = parseChord(chord, platform)
  const key = parsed.key === ' ' ? 'Space'
    : parsed.key === 'enter' ? 'Enter'
      : parsed.key === 'arrowup' ? 'Up'
        : parsed.key === 'arrowdown' ? 'Down'
          : parsed.key === 'arrowleft' ? 'Left'
            : parsed.key === 'arrowright' ? 'Right'
              : parsed.key.toUpperCase()
  const tokens: string[] = []
  if (platform === 'linux' && parsed.meta) tokens.push('Super')
  if (platform === 'darwin' && parsed.ctrl) tokens.push('Control')
  if (parsed.ctrl && platform !== 'darwin' || parsed.meta && platform === 'darwin') tokens.push('CommandOrControl')
  if (platform !== 'linux' && platform !== 'darwin' && parsed.meta) tokens.push('Super')
  if (parsed.alt) tokens.push('Alt')
  if (parsed.shift) tokens.push('Shift')
  tokens.push(key)
  return tokens.join('+')
}

/** A recorded accelerator (the dictation recorder's canonical spelling) as a T3 chord, or null when no thread shortcut may use those keys. */
export function chordFromAccelerator(accelerator: string, platform: SottoPlatform): string | null {
  const parsed = parseAccelerator(accelerator, platform)
  if (parsed === null) return null
  const key = parsed.key === ' ' ? 'space'
    : parsed.key === 'up' ? 'arrowup'
      : parsed.key === 'down' ? 'arrowdown'
        : parsed.key === 'left' ? 'arrowleft'
          : parsed.key === 'right' ? 'arrowright'
            : parsed.key
  const tokens: string[] = []
  if (platform === 'darwin' ? parsed.meta : parsed.ctrl) tokens.push('mod')
  if (platform === 'darwin' && parsed.ctrl) tokens.push('ctrl')
  if (platform !== 'darwin' && parsed.meta) tokens.push('meta')
  if (parsed.alt) tokens.push('alt')
  if (parsed.shift) tokens.push('shift')
  const chord = [...tokens, key].join('+')
  return isThreadChord(chord) ? chord : null
}

/** Whether two T3 chords mean the same keys on this platform, whatever their spelling or order. */
export function sameThreadKeys(left: string, right: string, platform: SottoPlatform): boolean {
  const a = parseChord(left, platform), b = parseChord(right, platform)
  return a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt && a.meta === b.meta
}
