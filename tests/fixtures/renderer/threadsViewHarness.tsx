import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'
import { designThreadsFixture, E2E_THREADS_NOW } from '../../../src/shared/e2e'
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

/** The design fixture as the coordinator would publish it: the permission request already sits in the attention queue. */
function stateFixture(): AgentState {
  const fixture = designThreadsFixture()
  return {
    configuration: { ...defaultAgentConfiguration(), enabled: true, defaultModelId: 'claude:sonnet' },
    connection: 'connected',
    host: {
      connected: true, name: 'Codex', version: 'test',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      models: [...fixture.models], projects: [...fixture.projects], threads: structuredClone(fixture.threads) as AgentState['host']['threads'],
    },
    assignments: fixture.assignments.map(assignment => ({ ...assignment, contextUpdatedAt: NOW })),
    queue: [{ id: 'visual-gate:visual-gate-permission:permission', threadId: 'visual-gate', kind: 'permission', text: 'Run a command in workshop\nnpm test -- --run tests/unit/agents', requestId: 'visual-gate-permission', createdAt: new Date(NOW).toISOString(), deferred: false }],
    activeThreadId: 'visual-gate', activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null,
    speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true },
    reasoningAccounts: [],
  }
}

let connectionStores = new WeakMap<ReturnType<typeof useAgents>['command'], ThreadDraftStore>()

function connection(state: AgentState | null, command = vi.fn(async () => state)): ReturnType<typeof useAgents> {
  let threadDrafts = connectionStores.get(command)
  if (!threadDrafts) { threadDrafts = new ThreadDraftStore(command); connectionStores.set(command, threadDrafts) }
  if (state) { threadDrafts.receive(state); openSidebarFolders(state) }
  return { ...agentContextFixture(state, command), threadDrafts }
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

export { voice, NOW, stateFixture, connectionStores, connection, renderThreads }
