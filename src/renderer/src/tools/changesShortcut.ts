import type { SottoPlatform } from '../../../shared/platform'
import { chordClaimed } from '../agents/branchToolbar.logic'

/**
 * The chords that toggle Changes, in order: T3's `mod+d`, then `mod+shift+d` when the dictation hotkey already
 * means `mod+d` (ADR-0027 bend 9). None when the hotkey somehow holds both.
 */
export const CHANGES_SHORTCUTS = ['mod+d', 'mod+shift+d'] as const

/** The chord Changes answers to under this dictation hotkey, or null when every candidate is taken. */
export function changesChord(hotkey: string | undefined, platform: SottoPlatform): string | null {
  return CHANGES_SHORTCUTS.find(chord => chordClaimed(chord, hotkey, platform)) ?? null
}

/** A key pressed where the chord means something else: a terminal's own Ctrl+D ends its input, so it keeps it. */
export function chordBelongsElsewhere(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.xterm, .terminal-view, .terminal-pane') !== null
}
