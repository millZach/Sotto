import { mergeAgentActivities, type AgentActivity } from '../../shared/agentActivity'

export interface CompactionMark {
  readonly provider: string
  /** The provider's own identity for this compaction, so seeing it twice updates the record instead of adding one. */
  readonly key: string
  readonly turnId: string
  readonly afterMessageId?: string | undefined
  readonly before?: number | undefined
  readonly after?: number | undefined
  readonly at?: number | undefined
}

const sides = (mark: Pick<CompactionMark, 'before' | 'after'>): Pick<AgentActivity, 'context'> => {
  const context = { ...(mark.before !== undefined ? { before: mark.before } : {}), ...(mark.after !== undefined ? { after: mark.after } : {}) }
  return Object.keys(context).length ? { context } : {}
}

/** A compaction is a boundary in the conversation rather than work inside a turn, so it is recorded on its own. */
export function markCompactionActivity(previous: readonly AgentActivity[] | undefined, mark: CompactionMark): AgentActivity[] {
  const at = new Date(mark.at ?? Date.now()).toISOString()
  return mergeAgentActivities(previous ?? [], [{
    id: `${mark.provider}-compaction-${mark.key}`, turnId: mark.turnId, sequence: 0, kind: 'compaction', status: 'completed',
    title: 'Context compacted', startedAt: at, completedAt: at, timingSource: 'observed',
    ...(mark.afterMessageId !== undefined ? { afterMessageId: mark.afterMessageId } : {}), ...sides(mark),
  }])
}

/**
 * Codex reports a compaction with no numbers at all, so the context ledger brackets it: the size last
 * reported before the boundary, then the first size reported after it. A reading that did not shrink is
 * a later turn's growth rather than this compaction's result, and is left out instead of guessed at.
 */
export function bracketCompaction(previous: readonly AgentActivity[] | undefined, side: { before?: number; after?: number }): AgentActivity[] {
  const records = previous ?? []
  const open = [...records].reverse().find(record => record.kind === 'compaction' && (side.before !== undefined
    ? record.context?.before === undefined
    : record.context?.after === undefined && record.context?.before !== undefined))
  if (!open) return [...records]
  const before = side.before ?? open.context?.before
  const after = side.after ?? open.context?.after
  if (before !== undefined && after !== undefined && after >= before) return [...records]
  return mergeAgentActivities(records, [{ ...open, ...sides({ before, after }) }])
}
