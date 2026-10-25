import type { SottoPlatform } from '../../../shared/platform'
import { DEFAULT_THREAD_SHORTCUTS } from '../../../shared/threadShortcuts'
import { chordClaimed } from '../agents/branchToolbar.logic'

/** The chord Changes falls back to at its default when the dictation hotkey already means `mod+d` (ADR-0027 bend 9). */
const CHANGES_FALLBACK = 'mod+shift+d'

/**
 * The chord Changes answers to: the one chosen on Settings › Keyboard (ADR-0133), or null where the user
 * removed it or the dictation hotkey owns it. At its default (`mod+d`) the bend-9 fallback still answers
 * instead, so an install that never opens Keyboard keeps a working chord; a chord the user picked has no
 * understudy — theirs is the one that stands down, and Settings shows what it is set to either way.
 */
export function changesChord(chosen: string | null, hotkey: string | undefined, platform: SottoPlatform): string | null {
  if (chosen === null) return null
  if (chordClaimed(chosen, hotkey, platform)) return chosen
  return chosen === DEFAULT_THREAD_SHORTCUTS.changes && chordClaimed(CHANGES_FALLBACK, hotkey, platform) ? CHANGES_FALLBACK : null
}

/** A key pressed where the chord means something else: a terminal's own Ctrl+D ends its input, so it keeps it. */
export function chordBelongsElsewhere(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.xterm, .terminal-view') !== null
}
