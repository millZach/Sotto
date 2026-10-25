import { isTerminalActivity, mergeAgentActivities, type AgentActivity, type OwnServerTurn } from '../../shared/agentActivity'

/**
 * A turn's lifecycle as Sotto observed it. Codex reports its own; Claude and Grok report only the
 * thread status, so without this a running turn has no elapsed time, its work never opens live, and
 * its fold can only guess how long the turn took from message timestamps.
 */

export interface TurnMark {
  /** Namespaces the record so two providers on one thread cannot collide. */
  readonly provider: string
  /** The identity the provider's activity records already share: the turn's user message. */
  readonly turnId: string
  readonly status: AgentActivity['status']
  readonly afterMessageId?: string | undefined
  readonly error?: string | undefined
  /** An interrupted turn ended by a steer rather than by Stop. */
  readonly steered?: boolean | undefined
  /** A turn on one of the user's own model servers (ADR-0124): what its words need, replacing what the record said. */
  readonly ownServer?: OwnServerTurn | undefined
  /** Milliseconds since the epoch; defaults to now. */
  readonly at?: number | undefined
}

const TITLES: Record<AgentActivity['status'], string> = {
  running: 'Working', completed: 'Turn completed', failed: 'Turn failed', interrupted: 'Turn interrupted', unknown: 'Turn outcome unknown',
}

/** Sotto only times what it watched, so the record is always `observed`. A settled turn is never reopened. */
export function markTurnActivity(previous: readonly AgentActivity[] | undefined, mark: TurnMark): AgentActivity[] {
  const records = previous ?? []
  const id = `${mark.provider}-turn-${mark.turnId}`
  const old = records.find(record => record.id === id)
  if (old && isTerminalActivity(old.status)) return [...records]
  const now = new Date(mark.at ?? Date.now()).toISOString()
  const steered = mark.steered === true && mark.status === 'interrupted'
  return mergeAgentActivities(records, [{
    id, turnId: mark.turnId, sequence: 0, kind: 'turn', status: mark.status, title: steered ? 'Turn steered' : TITLES[mark.status],
    startedAt: old?.startedAt ?? now, timingSource: 'observed',
    ...(mark.afterMessageId !== undefined ? { afterMessageId: mark.afterMessageId } : {}),
    ...(isTerminalActivity(mark.status) ? { completedAt: now } : {}),
    ...(mark.error !== undefined ? { error: mark.error } : {}),
    ...(steered ? { steered: true } : {}),
    ...(mark.ownServer !== undefined ? { ownServer: mark.ownServer } : {}),
  }])
}
