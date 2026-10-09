import { defaultAgentConfiguration, type AgentHostSnapshot, type AgentState } from '../../../src/shared/agents'
import { threadsStateFixture } from '../../fixtures/agentState'

export function stateAround(host: AgentHostSnapshot, activeThreadId: string): AgentState {
  return threadsStateFixture({
    cloneOverrides: false,
    configuration: defaultAgentConfiguration(),
    host,
    topLevel: {
      connection: 'connected', assignments: [], queue: [], activeThreadId, activeProjectId: host.threads.find(thread => thread.id === activeThreadId)?.projectId ?? host.projects[0]?.id ?? null,
      draft: '', draftThreadId: null, composing: false, draftRequestId: null, draftAttachments: [], deliveredDrafts: [],
      threadDrafts: [], deliveries: [], pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
      voice: { status: 'off', error: null, action: 'none', revision: 0 }, credentials: { reasoning: false, grokSpeech: false, secure: true },
      reasoningAccounts: [],
    },
  })
}

/** A whole state off the wire, with one streaming chunk on the open thread's newest message. */
export function withChunk(state: AgentState, threadId: string, chunk: string): AgentState {
  const next = structuredClone(state)
  const thread = next.host.threads.find(item => item.id === threadId)
  const message = thread?.messages.findLast(item => item.role === 'assistant') ?? thread?.messages.at(-1)
  if (message) message.text += chunk
  return next
}
