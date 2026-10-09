import { threadsStateFixture as stateFixture } from '../agentState'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { type AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { openSidebarFolders } from './liveAgentState'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { requestAnswerStore } from '../../../src/renderer/src/agents/requests/requestAnswers'
import { agentContextFixture } from '../agentContext'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

// The coordinator is hidden for the beta (ADR-0012), and ThreadsView is rendered here without an
// AppProvider, so the flag is stated per test: off is the beta, on is what a managed thread needs.
const voice = vi.hoisted(() => ({ enabled: false }))

vi.mock('../../../src/renderer/src/state/voiceCoordinator', () => ({ useVoiceCoordinatorEnabled: () => voice.enabled }))

const NOW = E2E_THREADS_NOW


let connectionStores = new WeakMap<ReturnType<typeof useAgents>['command'], ThreadDraftStore>()

function connection(state: AgentState | null, command = vi.fn(async () => state)): ReturnType<typeof useAgents> {
  let threadDrafts = connectionStores.get(command)
  if (!threadDrafts) { threadDrafts = new ThreadDraftStore(command); connectionStores.set(command, threadDrafts) }
  if (state) { threadDrafts.receive(state); openSidebarFolders(state) }
  return { ...agentContextFixture(state, command, { threadDrafts }), threadDrafts }
}

function renderThreads(state: AgentState | null, command = vi.fn(async () => state)) {
  const onOpenAgents = vi.fn()
  vi.mocked(useAgents).mockReturnValue(connection(state, command))
  const view = render(<ThreadsView onOpenAgents={onOpenAgents} now={NOW} />)
  return { ...view, command, onOpenAgents }
}

beforeEach(() => {
  vi.mocked(useAgents).mockReset(); connectionStores = new WeakMap(); voice.enabled = false
  for (const thread of stateFixture().host.threads) requestAnswerStore.prune(thread.id, [])
})

afterEach(cleanup)

export { voice, NOW, connectionStores, connection, renderThreads }

export { threadsStateFixture as stateFixture } from '../agentState'
