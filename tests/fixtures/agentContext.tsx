import { vi } from 'vitest'
import type { AgentState } from '../../src/shared/agents'
import type { useAgents } from '../../src/renderer/src/agents/AgentContext'
import { ThreadDraftStore } from '../../src/renderer/src/agents/threadDraftStore'

/** A complete renderer context; each test can override the behavior it exercises. */
export function agentContextFixture(state: AgentState | null, command: ReturnType<typeof useAgents>['command'],
  options: { threadDrafts?: ThreadDraftStore } = {}): ReturnType<typeof useAgents> {
  const threadDrafts = options.threadDrafts ?? new ThreadDraftStore(command)
  if (state && !options.threadDrafts) threadDrafts.receive(state)
  return {
    state, command, threadDrafts, error: null,
    voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn(),
    attention: { items: state?.queue ?? [], show: false, dismiss: vi.fn(), reopen: vi.fn(), next: vi.fn(async () => undefined) },
    responseStreaming: 'live', showBrowserPreviews: true,
  }
}
