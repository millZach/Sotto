/**
 * Sotto's order for a model's reasoning effort levels: least to most thorough, so the last level is the
 * highest level (CONTEXT.md). Every control that shows levels reads that order, and none of them sorts
 * for itself, so the adapters put each provider's list into it where the catalog becomes Sotto's.
 * Codex and Claude Code already report lowest first. Grok reports highest first (xhigh, high, medium,
 * low), which read backwards on the slider and put the highest-level styling on low.
 */

/** Lowercased, with hyphens, underscores and spaces removed, so `x-high` and `Extra_High` are recognised. */
export function effortKey(id: string): string {
  return id.toLowerCase().replace(/[-_\s]/gu, '')
}

/** The levels whose place is known. Anything else keeps its place beside the provider's own neighbours. */
const EFFORT_RANK: Readonly<Record<string, number>> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, extrahigh: 5, max: 6 }

/**
 * A provider's reported levels in Sotto's order. Ids come back verbatim, because each one goes back to
 * the provider unchanged when a thread starts, and a repeated id is dropped. The list is reversed as a
 * whole when its known levels run highest first, and otherwise left as it came, rather than sorted: a
 * level Sotto does not know stays beside its neighbours, so Codex's Ultra after Max remains the highest
 * level, and one at the front of a descending list ends up last. Fewer than two known levels give no
 * direction, so the list is left alone.
 */
export function orderReasoningEfforts(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)]
  const ranks = unique.map(id => EFFORT_RANK[effortKey(id)]).filter((rank): rank is number => rank !== undefined)
  return ranks.length > 1 && ranks[0]! > ranks.at(-1)! ? unique.reverse() : unique
}
