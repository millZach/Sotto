// #1312, fourth part: a delegated check waiting its turn has its own row in Tools › Agents, and the keyboard keeps its
// place when that row goes, to the thread's row once the check's thread is made, or to a row nearby when it is cancelled.
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentThread } from '../../../../src/shared/agents'
import type { CheckQueueEntry, CheckQueuesBridge, CheckQueuesView } from '../../../../src/shared/checkQueue'
import type { DelegationsBridge } from '../../../../src/shared/delegation'
import { E2E_THREADS_NOW } from '../../../../src/shared/e2e'
import { EMPTY_SUBAGENT_SUMMARY, type SubagentsBridge } from '../../../../src/shared/subagents'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { checkQueuesStore } from '../../../../src/renderer/src/watcher/checkQueues'
import { useOptionalApp, type AppContextValue } from '../../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'

vi.mock('../../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))
beforeEach(() => {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { currentVersion: '0.1.40-owl.20261027.1', phase: { phase: 'up-to-date' }, checkedAt: null,
    owlFeatures: { watcher: true, 'thread-delegation': true, 'cross-machine-work': true } } } as unknown as AppContextValue)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); checkQueuesStore.clear() })

const PARENT = 'visual-gate'
const at = (minutes: number): string => new Date(E2E_THREADS_NOW - minutes * 60_000).toISOString()
const check = (id: string, thread: string, title: string): CheckQueueEntry => ({ id, whose: 'thread', by: PARENT, thread, title, work: 'building' })
const queue = (checks: CheckQueueEntry[]): CheckQueuesView => ({ machines: [{ hostId: 'local', thisComputer: true, checks }] })
const RUNNING = check('running', 'capture', 'Omarchy capture check')

function made(state: AgentState, id: string, title: string): AgentState {
  const thread: AgentThread = { id, title, projectId: 'workshop', modelId: 'codex:gpt', providerId: 'codex', status: 'running', delegatedBy: PARENT, requests: [], updatedAt: at(0),
    messages: [{ id: `${id}-brief`, role: 'user', text: `Brief for ${title}`, createdAt: at(0) }] }
  return { ...state, host: { ...state.host, threads: [...state.host.threads, thread] } }
}

function setup(first: CheckQueuesView) {
  const listeners = new Set<(view: CheckQueuesView) => void>()
  const checks: CheckQueuesBridge = { read: async () => first, onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const delegations: DelegationsBridge = { read: vi.fn(async ({ threadId }: { threadId: string }) => ({ threadId, delegations: [], received: [] })),
    brief: vi.fn(async () => null), onChanged: () => () => undefined }
  vi.stubGlobal('sotto', { delegations, checks })
  const subagents: SubagentsBridge = { page: vi.fn(async ({ threadId }) => ({ threadId, revision: 1, rows: [], summary: EMPTY_SUBAGENT_SUMMARY })),
    assignments: vi.fn(async ({ threadId, agentId }) => ({ threadId, agentId, assignments: [] })), onChanged: vi.fn(() => () => undefined) }
  const store = new ToolsPanelStore()
  const base = threadsStateFixture()
  base.host.threads.find(thread => thread.id === PARENT)!.requests = []
  const ui = (state: AgentState) => <div className="thread-workspace__body">
    <section className="thread-pane" data-thread-id={PARENT} />
    <ToolsPanel focusedThreadId={PARENT} state={state} command={vi.fn(async () => state)} subagents={subagents} store={store} />
  </div>
  const view = render(ui(base))
  act(() => { store.setOpen(true); store.setSurface('agents') })
  return { base, show: (state: AgentState) => view.rerender(ui(state)), push: (next: CheckQueuesView) => act(() => { for (const listener of [...listeners]) listener(next) }) }
}
const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Tools' })
const waitingRow = (title: string): HTMLElement => within(panel()).getByRole('button', { name: `${title}, check on this computer, Working` })

describe('A waiting check’s row in Tools › Agents, as its check starts or is cancelled (#1312)', () => {
  it('hands focus and its open details to the thread’s own row once the check’s thread is made', async () => {
    const { base, show, push } = setup(queue([RUNNING, check('journeys', 'journeys', 'Linux journeys')]))
    await waitFor(() => expect(waitingRow('Linux journeys')).toBeInTheDocument())
    const row = waitingRow('Linux journeys')
    row.focus()
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    // Its turn comes: the check runs, and its thread is made, delegated by this thread.
    push(queue([check('journeys', 'journeys', 'Linux journeys')]))
    show(made(base, 'journeys', 'Linux journeys'))
    const head = await waitFor(() => panel().querySelector<HTMLButtonElement>('[data-thread-id="journeys"] .subagent-head')!)
    expect(within(panel()).queryByRole('button', { name: 'Linux journeys, check on this computer, Working' })).toBeNull()
    expect(head).toHaveFocus()
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(panel().querySelector('[data-thread-id="journeys"] .subagent-details')).toHaveTextContent('Checks on this computer, one at a time')
  })

  it('moves focus to the row nearby when the check is cancelled before its thread is made', async () => {
    const { push } = setup(queue([RUNNING, check('first', 'first', 'Unit suite'), check('second', 'second', 'Linux journeys')]))
    await waitFor(() => expect(waitingRow('Unit suite')).toBeInTheDocument())
    waitingRow('Unit suite').focus()
    // Stop takes it out of the queue: no thread is made, and the row goes.
    push(queue([RUNNING, check('second', 'second', 'Linux journeys')]))
    await waitFor(() => expect(within(panel()).queryByRole('button', { name: 'Unit suite, check on this computer, Working' })).toBeNull())
    expect(waitingRow('Linux journeys')).toHaveFocus()
  })
})
