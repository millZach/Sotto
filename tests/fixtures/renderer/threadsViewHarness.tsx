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

/**
 * The state as main would publish it after a test changed it in place: a new state and new thread records, as the window
 * receives every update. Panes are memoised on what they read (#993), so a record changed in place would not reach them.
 */
function published(state: AgentState): AgentState {
  return { ...state, host: { ...state.host, threads: state.host.threads.map(thread => ({ ...thread })) } }
}

function renderThreads(state: AgentState | null, command = vi.fn(async () => state)) {
  vi.mocked(useAgents).mockReturnValue(connection(state, command))
  const view = render(<ThreadsView now={NOW} />)
  const shown = new WeakSet<AgentState>(state ? [state] : [])
  // A test that changes `state` in place and draws again is publishing it: the page is handed it as main would send it.
  // One that has handed the page another connection meanwhile keeps it.
  const rerender: typeof view.rerender = ui => {
    const current = vi.mocked(useAgents).getMockImplementation() === undefined ? null : vi.mocked(useAgents)().state
    if (state !== null && current !== null && shown.has(current)) {
      const next = published(state); shown.add(next)
      vi.mocked(useAgents).mockReturnValue(connection(next, command))
    }
    view.rerender(ui)
  }
  return { ...view, rerender, command }
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
