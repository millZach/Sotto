import { threadsStateFixture as stateFixture } from '../agentState'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { type AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { requestAnswerStore } from '../../../src/renderer/src/agents/requests/requestAnswers'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { agentContextFixture } from '../agentContext'
import { openSidebarFolders } from './liveAgentState'
import type { PromptEditorElement } from '../../../src/renderer/src/agents/promptSelection'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW

let connectionStores = new WeakMap<ReturnType<typeof useAgents>['command'], ThreadDraftStore>()
function connection(state: AgentState | null, command = vi.fn(async () => state)): ReturnType<typeof useAgents> {
  let threadDrafts = connectionStores.get(command)
  if (!threadDrafts) { threadDrafts = new ThreadDraftStore(command); connectionStores.set(command, threadDrafts) }
  if (state) { threadDrafts.receive(state); openSidebarFolders(state) }
  return { ...agentContextFixture(state, command, { threadDrafts }), threadDrafts }
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
afterEach(async () => {
  // Tiptap defers destruction until after React unmounts. Keep this test's document
  // alive until the editors have released it, rather than leaving timers to the next file.
  const destroyed = [...document.querySelectorAll<PromptEditorElement>('.prompt-editor')].map(({ editor }) =>
    editor.isDestroyed ? Promise.resolve() : new Promise<void>(resolve => { editor.once('destroy', () => resolve()) }))
  cleanup()
  await Promise.all(destroyed)
})

export { NOW, connectionStores, connection, renderThreads }

export { threadsStateFixture as stateFixture } from '../agentState'
