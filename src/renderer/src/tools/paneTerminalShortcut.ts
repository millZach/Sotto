import type { SottoPlatform } from '../../../shared/platform'
import { chordClaimed, chordMatches } from '../agents/branchToolbar.logic'
import { threadChordLabel } from '../agents/threadShortcuts'

export interface PaneTerminalShortcut {
  readonly chord: string
  readonly platform: SottoPlatform
  /** The chord in a title's words: "Ctrl+J", or "Cmd+J" on a Mac, at its default. */
  readonly label: string
  /** The chord in `aria-keyshortcuts` spelling: "Control+J", or "Meta+J" on a Mac, at its default. */
  readonly keys: string
}

/** The chord the Terminal drawer answers to: the one chosen on Settings › Keyboard (ADR-0133), or null where removed or the dictation hotkey owns it. */
export function paneTerminalChord(chosen: string | null, hotkey: string | undefined, platform: SottoPlatform): string | null {
  return chosen !== null && chordClaimed(chosen, hotkey, platform) ? chosen : null
}

export function paneTerminalShortcutLabel(chord: string, platform: SottoPlatform): string {
  return threadChordLabel(chord, platform).plain
}

export function paneTerminalShortcutKeys(chord: string, platform: SottoPlatform): string {
  return threadChordLabel(chord, platform).keys
}

/** Whether a keydown is the chord itself, whatever it lands on. A drawer's own terminal passes it to the page. */
export function isPaneTerminalChord(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>, shortcut: PaneTerminalShortcut): boolean {
  return chordMatches(event, shortcut.chord, shortcut.platform)
}

/**
 * The chord drawer terminals pass to the page, kept for the whole window: a terminal's view outlives the drawer
 * that made it (the store keeps it while the drawer is off the page), so it reads this rather than a value captured
 * when it was made. Every mounted drawer writes the current one, so a hotkey changed in Settings reaches a terminal
 * made before the change.
 */
let drawerShortcut: PaneTerminalShortcut | null = null

export function setDrawerShortcut(shortcut: PaneTerminalShortcut | null): void {
  drawerShortcut = shortcut
}

/** Whether a keydown in a drawer's terminal is the drawer's chord, under the hotkey in force now. */
export function isDrawerShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): boolean {
  return drawerShortcut !== null && isPaneTerminalChord(event, drawerShortcut)
}

/**
 * The thread whose drawer a keydown toggles, or null when it is not the drawer's to take: already handled or
 * repeating, a dialog is open, it landed in a terminal that is not a drawer (Tools keeps the key for its
 * shells), or no pane with a drawer is on screen (another page, a pane hidden by narrow focus, a thread on a
 * paired host). The pane holding focus wins; otherwise the selected thread's pane, when it is showing.
 */
export function paneTerminalTarget(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'defaultPrevented' | 'repeat' | 'target'>, shortcut: PaneTerminalShortcut, selectedThreadId: string | null | undefined): string | null {
  if (event.defaultPrevented || event.repeat || !isPaneTerminalChord(event, shortcut)) return null
  if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') !== null) return null
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.xterm') && !target.closest('.pane-terminal')) return null
  // A pane whose header says it has no drawer is not the drawer's: a thread on a paired host. The drawer is a row of the
  // pane's ··· menu (ADR-0163), drawn only while the menu is open, so the header carries the mark.
  const shown = (pane: Element | null | undefined): string | null => pane instanceof HTMLElement && !pane.hasAttribute('data-hidden') && pane.querySelector('[data-terminal-drawer]') !== null ? pane.dataset.threadId ?? null : null
  const focused = shown(target?.closest('.thread-pane'))
  if (focused !== null) return focused
  if (!selectedThreadId) return null
  return shown([...document.querySelectorAll('.thread-pane[data-thread-id]')].find(pane => (pane as HTMLElement).dataset.threadId === selectedThreadId))
}
