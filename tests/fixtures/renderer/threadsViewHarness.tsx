import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { requestAnswerStore } from '../../../src/renderer/src/agents/requests/requestAnswers'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'
import { designThreadsFixture, E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { agentContextFixture } from '../agentContext'
import { openSidebarFolders } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW

/** The design fixture as the coordinator publishes it, with its native permission request. */
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
    activeThreadId: 'visual-gate', activeProjectId: 'workshop',
    draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    globalLaneBusy: false, notice: '', error: null,

    credentials: { reasoning: false, secure: true },
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
  vi.mocked(useAgents).mockReturnValue(connection(state, command))
  const view = render(<ThreadsView now={NOW} />)
  return { ...view, command }
}

beforeEach(() => {
  vi.mocked(useAgents).mockReset(); connectionStores = new WeakMap()
  for (const thread of stateFixture().host.threads) requestAnswerStore.prune(thread.id, [])
})
afterEach(cleanup)

export { connection, connectionStores, NOW, renderThreads, stateFixture }
