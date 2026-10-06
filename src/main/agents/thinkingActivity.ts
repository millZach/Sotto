import { THINKING_TITLE, isTerminalActivity, thinkingText, type AgentActivity } from '../../shared/agentActivity'
import { object } from './claudeProtocol'

/**
 * How a provider that streams ACP thought chunks (`agent_thought_chunk`) turns them into Thinking rows. Grok Build and
 * Devin share this; Claude's thinking comes in blocks instead (`claudeThinking.ts`).
 */
export interface AcpThinking {
  /** Namespaces this provider's Thinking rows, `<provider>-thinking-`. */
  readonly idPrefix: string
  /**
   * What an update that is not a thought says about the thought still running: the status it settles as, or nothing
   * when the thought may go on. The model moving on to its reply, a tool or a plan settles it as completed.
   */
  readonly settles: (update: Record<string, unknown>) => AgentActivity['status'] | undefined
}

/** Where a thought chunk goes. `key` is what the provider's stream names the thought by, when it names one. */
interface ThoughtPlace {
  readonly turnId: string
  readonly afterMessageId?: string | undefined
  readonly key?: string | undefined
}

/**
 * What a Thinking row still running settles as when its turn ends. A turn that finished normally finished the thought;
 * one that failed or was stopped cut it off, and so did a provider's process ending. The same rule for every provider.
 */
export const thinkingSettledAs = (turn: AgentActivity['status']): AgentActivity['status'] => turn === 'completed' ? 'completed' : 'interrupted'

/**
 * One ACP update as activity. A thought chunk streams into its Thinking row; without a `key`, chunks that run on in
 * order belong to the turn's running thought, and a chunk after anything else starts the turn's next. Any other
 * update is the provider's own `work`, and settles a running thought when `thinking.settles` says it does.
 */
export function acpThinkingActivities(thinking: AcpThinking, update: Record<string, unknown>, place: ThoughtPlace, previous: readonly AgentActivity[], live: boolean, work: () => AgentActivity[]): AgentActivity[] {
  if (update.sessionUpdate === 'agent_thought_chunk') return thoughtChunk(thinking.idPrefix, update, place, previous, live)
  const rows = work()
  const status = thinking.settles(update)
  return status ? [...settledThinking(thinking.idPrefix, previous, status, live), ...rows] : rows
}

/** A provider's Thinking rows still running, settled: the model moved on, or nothing more will come for them. */
export function settledThinking(idPrefix: string, previous: readonly AgentActivity[], status: AgentActivity['status'], live: boolean, except?: string): AgentActivity[] {
  const now = live ? new Date().toISOString() : undefined
  return previous.filter(row => row.status === 'running' && row.kind === 'reasoning' && row.id.startsWith(idPrefix) && row.id !== except)
    .map(row => ({ ...row, status, ...(now ? { completedAt: now } : {}) }))
}

function thoughtChunk(idPrefix: string, update: Record<string, unknown>, place: ThoughtPlace, previous: readonly AgentActivity[], live: boolean): AgentActivity[] {
  const content = object(update.content)
  const words = content?.type === 'text' && typeof content.text === 'string' ? content.text : ''
  const ours = (row: AgentActivity): boolean => row.turnId === place.turnId && row.id.startsWith(idPrefix)
  const running = place.key === undefined ? previous.findLast(row => row.status === 'running' && row.kind === 'reasoning' && ours(row)) : undefined
  const id = place.key !== undefined ? `${idPrefix}${place.key}` : running?.id ?? `${idPrefix}${place.turnId}-${previous.filter(ours).length}`
  const old = previous.find(row => row.id === id)
  if (old && isTerminalActivity(old.status)) return []
  // A live chunk is timed from when Sotto received it; one read back from history is given no clock it never had.
  const startedAt = live && !old?.startedAt ? new Date().toISOString() : undefined
  return [...settledThinking(idPrefix, previous, 'completed', live, id), { turnId: place.turnId, ...(place.afterMessageId ? { afterMessageId: place.afterMessageId } : {}), ...old,
    id, sequence: old?.sequence ?? 0, kind: 'reasoning', title: THINKING_TITLE, status: 'running',
    ...thinkingText((old?.text ?? '') + words), ...(startedAt ? { startedAt, timingSource: 'observed' as const } : {}) }]
}
