import type { AgentState } from '../../../src/shared/agents'
import { share } from '../../../src/renderer/src/agents/stateSharing'

/** A whole state off the wire, with one streaming chunk on the open thread's newest message. */
export function withChunk(state: AgentState, threadId: string, chunk: string): AgentState {
  const next = structuredClone(state)
  const thread = next.host.threads.find(item => item.id === threadId)
  const message = thread?.messages.findLast(item => item.role === 'assistant') ?? thread?.messages.at(-1)
  if (message) message.text += chunk
  return next
}

/** Keep structure sharing inside the benchmark's measured receive path. */
export function receive(previous: AgentState, next: AgentState): AgentState {
  return share(previous, next)
}
