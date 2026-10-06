import { THINKING_TITLE, isTerminalActivity, thinkingText, type AgentActivity } from '../../shared/agentActivity'
import { object } from './claudeProtocol'

/**
 * Where an ACP thought chunk (`agent_thought_chunk`) goes. `prefix` namespaces one provider's Thinking rows. `key` is
 * what the provider's stream names the thought by, when it names one; without it, chunks that run on in order belong
 * to the turn's running thought, and a chunk after anything else starts the turn's next.
 */
export interface ThoughtTarget {
  readonly prefix: string
  readonly turnId: string
  readonly afterMessageId?: string | undefined
  readonly key?: string | undefined
}

/** A provider's Thinking rows still running, settled: the model moved on, or the turn ended with nothing more to come. */
export function settledThoughts(prefix: string, previous: readonly AgentActivity[], status: AgentActivity['status'], live: boolean, except?: string): AgentActivity[] {
  const now = live ? new Date().toISOString() : undefined
  return previous.filter(row => row.status === 'running' && row.kind === 'reasoning' && row.id.startsWith(prefix) && row.id !== except)
    .map(row => ({ ...row, status, ...(now ? { completedAt: now } : {}) }))
}

/** One thought chunk, streamed into its Thinking row. Any other thought of the provider's still running is settled. */
export function thoughtChunk(update: Record<string, unknown>, target: ThoughtTarget, previous: readonly AgentActivity[], live: boolean): AgentActivity[] {
  const content = object(update.content)
  const words = content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
  const ours = (row: AgentActivity): boolean => row.turnId === target.turnId && row.id.startsWith(target.prefix)
  const running = target.key === undefined ? previous.findLast(row => row.status === 'running' && row.kind === 'reasoning' && ours(row)) : undefined
  const id = target.key !== undefined ? `${target.prefix}${target.key}` : running?.id ?? `${target.prefix}${target.turnId}-${previous.filter(ours).length}`
  const old = previous.find(row => row.id === id)
  if (old && isTerminalActivity(old.status)) return []
  // A live chunk is timed from when Sotto received it; one read back from history is given no clock it never had.
  const startedAt = live && !old?.startedAt ? new Date().toISOString() : undefined
  return [...settledThoughts(target.prefix, previous, 'completed', live, id), { turnId: target.turnId, ...(target.afterMessageId ? { afterMessageId: target.afterMessageId } : {}), ...old,
    id, sequence: old?.sequence ?? 0, kind: 'reasoning', title: THINKING_TITLE, status: 'running',
    ...thinkingText((old?.text ?? '') + words), ...(startedAt ? { startedAt, timingSource: 'observed' as const } : {}) }]
}
