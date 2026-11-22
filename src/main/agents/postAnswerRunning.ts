import type { AgentThread } from '../../shared/agents'

/**
 * Marks a thread as `running` immediately after a card answer is confirmed delivered and no other request cards remain
 * open, preventing transient at-rest reads before the provider streams its next turn event.
 */
export function markThreadRunningAfterAnswer(thread: AgentThread | undefined, activeTurnId?: string): boolean {
  if (!thread || thread.requests.length > 0 || thread.status === 'running') return false
  thread.status = 'running'
  if (activeTurnId) thread.lastTurn = { ...thread.lastTurn, id: activeTurnId, status: 'running' }
  else if (thread.lastTurn) thread.lastTurn = { ...thread.lastTurn, status: 'running' }
  return true
}
