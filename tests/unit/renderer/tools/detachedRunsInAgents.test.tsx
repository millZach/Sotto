import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBackgroundWork } from '../../../../src/shared/agentMonitoring'
import type { AgentState } from '../../../../src/shared/agents'
import type { DelegationsBridge } from '../../../../src/shared/delegation'
import { E2E_THREADS_NOW } from '../../../../src/shared/e2e'
import { EMPTY_SUBAGENT_SUMMARY, type SubagentRow, type SubagentsBridge } from '../../../../src/shared/subagents'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { useOptionalApp, type AppContextValue } from '../../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'

vi.mock('../../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

/**
 * Detached runs in Tools › Agents (Zach's pick on November 20, 2026: variant 2, Own section, of
 * docs/prototypes/detached-runs-in-agents-prototype.html): a section of the thread's detached runs above its agents and
 * delegated threads, each with Stop, as they show under the thread's last reply (ADR-0204).
 */
function owl(delegation: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { currentVersion: '0.1.44-owl.20261120.1', phase: { phase: 'up-to-date' }, checkedAt: null,
    owlFeatures: { watcher: false, 'thread-delegation': delegation } } } as unknown as AppContextValue)
}

const THREAD = 'visual-gate'
const RUN = '0b5d6a51-8c2e-5f3a-9d41-6e7a8b9c0d1e'
const run: AgentBackgroundWork = {
  id: RUN, label: 'Codex run', type: 'detached-run', startedAt: new Date(E2E_THREADS_NOW - 135 * 60_000).toISOString(),
  run: { client: 'Codex', model: 'gpt-6-astra', effort: 'max', folder: '/home/zach/algo-attack/dopamine-gt3rs', command: 'codex exec --json -m gpt-6-astra …' },
}
const agent: SubagentRow = { id: 'explore', sequence: 1, revision: 1, assignmentId: 'explore-1', assignmentCount: 1, title: 'Check the drop timing', description: 'Find the beat',
  status: 'completed', lastObservedAt: new Date(E2E_THREADS_NOW - 60_000).toISOString(), startedAt: new Date(E2E_THREADS_NOW - 240_000).toISOString() }

function agentsBridge(rows: SubagentRow[]): SubagentsBridge {
  return {
    page: vi.fn(async ({ threadId }) => ({ threadId, revision: 1, rows, summary: { ...EMPTY_SUBAGENT_SUMMARY, total: rows.length, completed: rows.length } })),
    assignments: vi.fn(async ({ threadId, agentId }) => ({ threadId, agentId, assignments: [] })),
    onChanged: vi.fn(() => () => undefined),
  }
}
const delegations: DelegationsBridge = {
  read: vi.fn(async ({ threadId }: { threadId: string }) => ({ threadId, delegations: [], received: [] })),
  brief: vi.fn(async () => null), onChanged: vi.fn(() => () => undefined),
} as unknown as DelegationsBridge

function stateWith(work: AgentBackgroundWork[] | undefined): AgentState {
  const state = threadsStateFixture()
  const thread = state.host.threads.find(item => item.id === THREAD)!
  thread.requests = []
  if (work) thread.backgroundWork = work; else delete thread.backgroundWork
  return state
}

function setup(state: AgentState, rows: SubagentRow[] = [agent], answer: AgentState | null = state, subagents: SubagentsBridge = agentsBridge(rows)) {
  vi.stubGlobal('sotto', { delegations })
  const store = new ToolsPanelStore()
  const command = vi.fn(async () => answer)
  const view = render(<ToolsPanel focusedThreadId={THREAD} state={state} command={command} subagents={subagents} store={store} />)
  act(() => { store.setOpen(true); store.setSurface('agents') })
  return { command, rerender: (next: AgentState) => view.rerender(<ToolsPanel focusedThreadId={THREAD} state={next} command={command} subagents={subagents} store={store} />) }
}
const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Tools' })
const runs = (): HTMLElement => within(panel()).getByRole('region', { name: 'Detached runs' })

beforeEach(() => { vi.mocked(useOptionalApp).mockReset() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('detached runs in Tools › Agents', () => {
  it('lists them in a section of their own above the agents, and counts them', async () => {
    owl(false)
    setup(stateWith([run]))
    await waitFor(() => expect(within(panel()).getByText('Check the drop timing')).toBeInTheDocument())
    const row = within(runs()).getByRole('listitem', { name: 'Detached run: Codex run, Working' })
    expect(within(row).getByText(/gpt-6-astra, max/u)).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Stop the detached run Codex run' })).toBeInTheDocument()
    expect(within(panel()).getByRole('heading', { name: 'Agents and delegated threads' })).toBeInTheDocument()
    // The section comes first, above the agents.
    const section = runs(), agents = within(panel()).getByText('Check the drop timing')
    expect(section.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(panel()).getByText('1 agent · 1 detached run')).toBeInTheDocument()
    expect(within(panel()).getByText('1 working')).toBeInTheDocument()
    expect(within(panel()).queryByText('No agents spawned in this thread yet.')).toBeNull()
  })

  it('shows the runs alone when the thread has no agents, with no empty roster under them', async () => {
    owl(false)
    setup(stateWith([run]), [])
    expect(await within(panel()).findByRole('region', { name: 'Detached runs' })).toBeInTheDocument()
    await waitFor(() => expect(within(panel()).getByText('1 detached run')).toBeInTheDocument())
    expect(within(panel()).queryByText('No agents spawned in this thread yet.')).toBeNull()
    expect(within(panel()).queryByRole('heading', { name: 'Agents and delegated threads' })).toBeNull()
  })

  it('stops a run from its row through the thread\'s own host, and says why when it did not stop', async () => {
    owl(true)
    const state = stateWith([run])
    const { command } = setup(state, [agent], { ...state, error: 'That detached run has already ended. Nothing was stopped.' })
    fireEvent.click(await within(runs()).findByRole('button', { name: 'Stop the detached run Codex run' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'stop-detached-run', threadId: THREAD, runId: RUN }))
    expect(await within(runs()).findByRole('alert')).toHaveTextContent('That detached run has already ended. Nothing was stopped.')
  })

  it('still says the agents are loading while a run is listed above them', async () => {
    owl(false)
    const pending = { ...agentsBridge([agent]), page: vi.fn(() => new Promise<never>(() => undefined)) } as SubagentsBridge
    setup(stateWith([run]), [agent], null, pending)
    expect(await within(panel()).findByRole('region', { name: 'Detached runs' })).toBeInTheDocument()
    expect(within(panel()).getByText('Loading agents…')).toBeInTheDocument()
  })

  it('hands focus on when the run whose Stop has it ends', async () => {
    owl(false)
    const state = stateWith([run])
    const { rerender } = setup(state)
    const stop = await within(runs()).findByRole('button', { name: 'Stop the detached run Codex run' })
    act(() => { stop.focus() })
    expect(stop).toHaveFocus()
    rerender(stateWith(undefined))
    await waitFor(() => expect(within(panel()).queryByRole('region', { name: 'Detached runs' })).toBeNull())
    expect(document.activeElement).not.toBe(document.body)
    expect(panel().contains(document.activeElement)).toBe(true)
    // Never onto a Stop, where one key press would end a run.
    expect(document.activeElement?.classList.contains('delegated-work__stop')).toBe(false)
  })

  it('leaves focus where the user took it when the runs change later (Bug Bot on #2751, L1)', async () => {
    owl(false)
    const other: AgentBackgroundWork = { ...run, id: '1c6e7b62-9d3f-5a4b-8e52-7f8a9b0c1d2e', label: 'Claude Code run' }
    const { rerender } = setup(stateWith([run, other]))
    const stop = await within(runs()).findByRole('button', { name: 'Stop the detached run Codex run' })
    act(() => { stop.focus() })
    act(() => { stop.blur() })
    expect(document.activeElement).toBe(document.body)
    // Minutes later the first run ends: nothing pulls focus back onto the other run's Stop.
    rerender(stateWith([other]))
    await waitFor(() => expect(within(runs()).queryByRole('button', { name: 'Stop the detached run Codex run' })).toBeNull())
    expect(document.activeElement).toBe(document.body)
  })

  it('names the machine a run from elsewhere works on, and stops it by the same Stop (#2749)', async () => {
    owl(false)
    const state = stateWith([{ ...run, run: { ...run.run!, machine: 'forge' } }])
    const { command } = setup(state)
    const row = await within(runs()).findByRole('listitem', { name: 'Detached run: Codex run on forge, Working' })
    expect(within(row).getByText('Started from this thread on forge and left running there. Sotto on forge found it running; its provider does not report it.')).toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: 'Stop the detached run Codex run on forge' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'stop-detached-run', threadId: THREAD, runId: RUN }))
  })

  it('leaves the pane as it was for a thread with no detached run', async () => {
    owl(false)
    setup(stateWith(undefined))
    await waitFor(() => expect(within(panel()).getByText('Check the drop timing')).toBeInTheDocument())
    expect(within(panel()).queryByRole('region', { name: 'Detached runs' })).toBeNull()
    expect(within(panel()).queryByRole('heading', { name: 'Agents and delegated threads' })).toBeNull()
    expect(within(panel()).getByText('1 agent')).toBeInTheDocument()
  })
})
