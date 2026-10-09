import type { AgentState } from '../../src/shared/agents'
import type { useAgents } from '../../src/renderer/src/agents/AgentContext'
import { ThreadDraftStore } from '../../src/renderer/src/agents/threadDraftStore'

/** A complete renderer context; each test can override the behavior it exercises. */
export function agentContextFixture(state: AgentState | null, command: ReturnType<typeof useAgents>['command']): ReturnType<typeof useAgents> {
  const threadDrafts = new ThreadDraftStore(command)
  if (state) threadDrafts.receive(state)
  return {
    state, command, threadDrafts, error: null,
    responseStreaming: 'live', showBrowserPreviews: true,
  }
}
