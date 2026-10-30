/**
 * How much thought a draft seems to ask for, read from its own words in the window (ADR-0161). It only ever suggests:
 * the split chip marks the levels above the one set in its list, and nothing changes until the user chooses one (ADR-0004).
 * Nothing leaves the computer for it.
 */
const HARD_WORDS = /\b(?:refactor|debug|why|investigate|redesign|architecture|migrate)\b/giu

/** 0 for an ordinary draft, up to 4 for a long, several-line draft that names hard work. */
export function draftEffortScore(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length < 14) return 0
  return (trimmed.length > 90 ? 1 : 0) + (trimmed.includes('\n') ? 1 : 0) + Math.min(2, trimmed.match(HARD_WORDS)?.length ?? 0)
}

/**
 * The level a score suggests among `count` levels, or null when it suggests nothing more than `current` (an index, -1
 * when none is set). It suggests up only: a short draft never asks for less than the user chose.
 */
export function suggestedEffortIndex(score: number, count: number, current: number): number | null {
  if (score <= 0 || count < 2) return null
  const index = Math.min(count - 1, Math.max(0, Math.round(score / 4 * (count - 1))))
  return index > current ? index : null
}
