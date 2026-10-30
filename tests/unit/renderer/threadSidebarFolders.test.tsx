import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'
import type { AgentState, AgentThread } from '../../../src/shared/agents'

// Worker swarms is off, as on stable, unless a test turns it on.
const owl = vi.hoisted(() => ({ swarms: false }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'worker-swarms' && owl.swarms }))
afterEach(() => { cleanup(); owl.swarms = false })

function mount(state: AgentState = threadsStateFixture(), handlers: { readonly onOpen?: (threadId: string) => void; readonly command?: (command: unknown) => Promise<AgentState> } = {}) {
  // Delegated threads have no row of their own while delegation is on, so a swarm's angles show only under their lead.
  const organization = organizeWorkspace(state, describeThreads(state, E2E_THREADS_NOW), '', null, true, E2E_THREADS_NOW, owl.swarms)
  return render(<ThreadSidebar state={state} organization={organization} command={handlers.command ?? vi.fn(async () => state)} query="" onQuery={vi.fn()} onOpen={handlers.onOpen ?? vi.fn()} onNewThread={vi.fn()}
    currentThreadId="visual-gate" openThreadIds={['visual-gate']} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
}
/** A section's folder toggles, named for the project and its count; the Settled shelf's own toggle is not a folder. */
const FOLDER = /^(?!Settled ).* \d+ threads?$/
const folders = (section: string, expanded: boolean): HTMLElement[] => within(screen.getByRole('region', { name: section })).queryAllByRole('button', { expanded, name: FOLDER })

it('starts every project folder closed, the open thread\'s and the settled ones too', () => {
  mount()
  expect(folders('Projects', true)).toEqual([])
  expect(folders('Projects', false).length).toBeGreaterThan(1)
  expect(screen.queryByRole('button', { name: 'Visual gate flake' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^Settled/ }))
  expect(folders('Settled', true)).toEqual([])
  expect(folders('Settled', false).length).toBeGreaterThan(0)
})

it('keeps a folder the user opened open when the sidebar is mounted again in the same window', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: /^workshop \d+ threads?$/ }))
  expect(screen.getByRole('button', { name: /^workshop \d+ threads?$/ })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: 'Visual gate flake' })).toBeVisible()
  cleanup()
  mount()
  expect(screen.getByRole('button', { name: /^workshop \d+ threads?$/ })).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(screen.getByRole('button', { name: /^workshop \d+ threads?$/ }))
  expect(screen.queryByRole('button', { name: 'Visual gate flake' })).not.toBeInTheDocument()
})

it('keeps a folder open for the window when session storage refuses the write', () => {
  const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
  mount()
  fireEvent.click(screen.getByRole('button', { name: /^workshop \d+ threads?$/ }))
  expect(screen.getByRole('button', { name: 'Visual gate flake' })).toBeVisible()
  refuse.mockRestore()
  // The next write that storage accepts is read back again.
  fireEvent.click(screen.getByRole('button', { name: /^workshop \d+ threads?$/ }))
  expect(screen.queryByRole('button', { name: 'Visual gate flake' })).not.toBeInTheDocument()
})

// The column of counts is drawn by CSS and measured in tests/e2e/sidebar-folder-counts.spec.ts; this is the fact it leans on that needs no browser.
it('ends every folder row on its count, after any dots', () => {
  mount()
  const toggles = [...document.querySelectorAll('.thread-folder__toggle')]
  expect(toggles.length).toBeGreaterThan(2)
  for (const toggle of toggles) expect(toggle.lastElementChild).toHaveClass('thread-folder__count')
  expect(document.querySelector('.thread-nav__indicators + .thread-folder__count')).not.toBeNull()
})

/** Visual gate flake leading a swarm of four: one answered, one working, one waiting on the user's answer, one waiting its turn. */
function swarmState(): AgentState {
  const state = threadsStateFixture()
  const lead = state.host.threads.find(thread => thread.id === 'visual-gate')!
  const swarm = { id: '6f0c1c39-0a5e-4f3e-9d1a-2b8f8b0e4a11', leadThreadId: lead.id, count: 4, done: 1, failed: 0, queued: 1 }
  const angle = (id: string, index: number, title: string, patch: Partial<AgentThread>): AgentThread =>
    ({ ...lead, id, title, delegatedBy: lead.id, requests: [], status: 'idle', swarm: { ...swarm, index }, ...patch })
  const threads = state.host.threads.map(thread => thread.id === lead.id ? { ...thread, swarm } : thread)
  threads.push(angle('angle-cost', 0, 'Cost', { swarm: { ...swarm, index: 0, state: 'answered' } }),
    angle('angle-privacy', 1, 'Privacy', { status: 'running', swarm: { ...swarm, index: 1, state: 'working' } }),
    angle('angle-operations', 2, 'Operations', { swarm: { ...swarm, index: 2, state: 'working' },
      requests: [{ id: 'question-1', kind: 'question', text: 'Which region?', options: [], questions: [] }] }))
  return { ...state, host: { ...state.host, threads } }
}

it('lists a swarm lead’s angles under its row only with worker swarms on, never hiding an angle that needs you', () => {
  mount(swarmState())
  fireEvent.click(screen.getByRole('button', { name: /^workshop \d+ threads?$/ }))
  expect(screen.queryByRole('button', { name: 'Angles of Visual gate flake' })).toBeNull()
  cleanup()
  owl.swarms = true
  const onOpen = vi.fn()
  const command = vi.fn<(command: unknown) => Promise<AgentState>>(async () => swarmState())
  mount(swarmState(), { onOpen, command })
  expect(screen.queryByRole('button', { name: 'Privacy' })).toBeNull()
  const toggle = screen.getByRole('button', { name: 'Angles of Visual gate flake' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(toggle).toHaveAccessibleDescription('1 of 4 angles done · 1 needs you · 1 working · 1 waiting')
  // Closed, only the angle that needs you shows, and it opens to answer.
  const angles = () => within(screen.getByRole('group', { name: 'Angles of Visual gate flake' }))
  expect(angles().getAllByRole('listitem')).toHaveLength(1)
  expect(angles().getByRole('button', { name: 'Operations' })).toHaveAccessibleDescription('Needs your answer')
  fireEvent.click(toggle)
  expect(angles().getAllByRole('button', { name: /^(Cost|Privacy|Operations)$/u }).map(button => button.textContent)).toEqual(['CostAnswered', 'PrivacyWorking', 'OperationsNeeds your answer'])
  fireEvent.click(angles().getByRole('button', { name: 'Cost' }))
  expect(onOpen).toHaveBeenCalledWith('angle-cost')
  // Stop is there only while an angle works, and stops that angle alone.
  expect(angles().queryByRole('button', { name: 'Stop Cost' })).toBeNull()
  fireEvent.click(angles().getByRole('button', { name: 'Stop Privacy' }))
  expect(command).toHaveBeenCalledWith({ type: 'interrupt', threadId: 'angle-privacy' })
})

it('lists an angle still open under a settled lead once, on a row of its own', () => {
  owl.swarms = true
  const state = swarmState()
  const settledAt = '2026-10-29T12:00:00.000Z'
  const threads = state.host.threads.map(thread => thread.id === 'visual-gate' || thread.id === 'angle-cost' ? { ...thread, workspaceSettledAt: settledAt } : thread)
  mount({ ...state, host: { ...state.host, threads } })
  fireEvent.click(screen.getByRole('button', { name: /^Settled/ }))
  for (const toggle of screen.getAllByRole('button', { expanded: false, name: /^workshop \d+ threads?$/ })) fireEvent.click(toggle)
  expect(screen.getAllByRole('button', { name: 'Privacy' })).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Privacy' })).toHaveClass('thread-nav__item')
  fireEvent.click(screen.getByRole('button', { name: 'Angles of Visual gate flake' }))
  expect(within(screen.getByRole('group', { name: 'Angles of Visual gate flake' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['CostAnswered'])
})
