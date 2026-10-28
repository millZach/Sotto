/**
 * The pages that describe every published state, mounted: the Threads page, the sidebar beside other pages and Watcher's
 * room. After the first render, a state that changed one thread describes that thread alone, as the page's own describer
 * does (`threadRowsWorkBudget.perf.test.ts` counts the describer by itself). A page that went back to `describeThreads`,
 * or made its describer again on each render, describes every thread. A change of language, or messages loaded into the
 * language shown, describes every thread again at once, without waiting for the next state or the clock.
 */
import { i18n } from '@lingui/core'
import React, { type ReactElement } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand, AgentState, AgentThread } from '../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { PageSidebar } from '../../../src/renderer/src/agents/PageSidebar'
import { SidebarChromeProvider } from '../../../src/renderer/src/agents/SidebarFrame'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { WatcherView } from '../../../src/renderer/src/watcher/WatcherView'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'
import { openSidebarFolders } from '../../fixtures/renderer/liveAgentState'
import { E2E_THREADS_NOW as NOW } from '../../../src/shared/e2e'

// `describe` resolves each row's model once. Panes and pickers resolve models too, so only the calls made from
// `threadFacts.ts` count: those are the rows described.
const rows = vi.hoisted(() => ({ described: 0 }))
vi.mock('../../../src/shared/modelCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/shared/modelCatalog')>()
  const resolveModel: typeof actual.resolveModel = (models, modelId) => {
    if (new Error().stack?.includes('threadFacts')) rows.described++
    return actual.resolveModel(models, modelId)
  }
  return { ...actual, resolveModel }
})
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn(), useOptionalAgents: vi.fn() }))

const THREADS = 40

/** The Threads design fixture's threads repeated to `THREADS`, with no thread open in a pane. */
function manyThreads(): AgentState {
  const state = threadsStateFixture()
  const designed = state.host.threads
  const threads = Array.from({ length: THREADS }, (_, index): AgentThread => ({ ...structuredClone(designed[index % designed.length]!), id: `thread-${index}`, title: `Thread ${index}` }))
  return { ...state, activeThreadId: null, host: { ...state.host, threads } }
}

/** One page over a published state that a test moves on, as `AgentContext` would publish it. */
function mount(page: () => ReactElement, initial: AgentState) {
  openSidebarFolders(initial)
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => current)
  const threadDrafts = new ThreadDraftStore(command)
  let current = initial
  const publish = (state: AgentState): void => {
    current = state
    threadDrafts.receive(state)
    const connection = agentContextFixture(state, command, { threadDrafts })
    vi.mocked(useAgents).mockReturnValue(connection)
    vi.mocked(useOptionalAgents).mockReturnValue(connection)
  }
  publish(initial)
  const view = render(page())
  return {
    /** Publishes `state` and counts the rows the page described for it. */
    update(state: AgentState): number {
      rows.described = 0
      publish(state)
      view.rerender(page())
      return rows.described
    },
    /** Runs `change` and counts the rows the page described because of it. */
    count(change: () => void): number {
      rows.described = 0
      act(change)
      return rows.described
    },
  }
}

const PAGES: readonly (readonly [string, () => ReactElement])[] = [
  ['the Threads page', () => <ThreadsView now={NOW} />],
  ['the sidebar beside another page', () => <SidebarChromeProvider updateControl={null}><PageSidebar now={NOW} /></SidebarChromeProvider>],
  ["Watcher's room", () => <SidebarChromeProvider updateControl={null}><WatcherView now={NOW} /></SidebarChromeProvider>],
]

beforeEach(() => {
  vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalAgents).mockReset()
  vi.mocked(useOptionalApp).mockReturnValue({
    navigation: 'home', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS, update: { watcherEnabled: true },
    actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() },
  } as unknown as AppContextValue)
})
afterEach(() => {
  cleanup(); localStorage.clear(); sessionStorage.clear()
  if (i18n.locale !== 'en') i18n.loadAndActivate({ locale: 'en', messages: {} })
})

describe.each(PAGES)('%s, for each published state', (_, page) => {
  it('describes only the thread a state changed', () => {
    const state = manyThreads()
    const shown = mount(page, state)
    const renamed = { ...state, host: { ...state.host, threads: state.host.threads.map(thread => thread.id === 'thread-12' ? { ...thread, title: 'Thread 12, renamed' } : thread) } }
    expect(shown.update(renamed)).toBe(1)
    expect(shown.update({ ...renamed, notice: 'Something else changed.' })).toBe(0)
  })

  it('describes every thread again when the language or its messages change, before the next state', () => {
    const shown = mount(page, manyThreads())
    expect(shown.count(() => { i18n.load(i18n.locale, {}) })).toBe(THREADS)
    expect(shown.count(() => { i18n.loadAndActivate({ locale: 'fr', messages: {} }) })).toBe(THREADS)
  })
})
