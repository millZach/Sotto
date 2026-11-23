import type { AgentThread } from '../../shared/agents'

/**
 * Marks a thread as `running` immediately after a card answer is confirmed delivered and no other request cards remain
 * open, preventing transient at-rest reads before the provider streams its next turn event.
 */
export function markThreadRunningAfterAnswer(thread: AgentThread | undefined, activeTurnId: string | undefined): boolean {
  if (!thread || !activeTurnId || thread.requests.length > 0 || thread.status !== 'idle') return false
  if (thread.lastTurn && thread.lastTurn.id === activeTurnId && thread.lastTurn.status !== 'running') return false
  thread.status = 'running'
  thread.lastTurn = { ...thread.lastTurn, id: activeTurnId, status: 'running' }
  return true
}
