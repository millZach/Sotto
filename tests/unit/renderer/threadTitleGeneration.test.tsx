import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from './liveAgentState'
import { openPaneMenu, paneMenuItems } from './paneMenu'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

function mount(state: AgentState = threadsStateFixture()) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView onOpenAgents={vi.fn()} now={E2E_THREADS_NOW} />)
  return live
}
const regenerations = (live: ReturnType<typeof liveAgentState>): Extract<AgentCommand, { type: 'regenerate-thread-title' }>[] =>
  live.command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: 'regenerate-thread-title' }> => request.type === 'regenerate-thread-title')
const row = (title: string): HTMLElement => screen.getByRole('button', { name: title }).closest('li')!
const header = (): HTMLElement => document.querySelector('.thread-workspace__head')!

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(cleanup)

describe('asking Sotto to name a thread again', () => {
  it('offers the action on the sidebar row and sends the thread it belongs to', () => {
    const live = mount()
    fireEvent.click(within(row('Weekly note')).getByRole('button', { name: 'Regenerate title for Weekly note' }))
    expect(regenerations(live)).toEqual([{ type: 'regenerate-thread-title', threadId: 'weekly-note' }])
  })

  it('offers the action in the pane header’s menu beside Rename', () => {
    const live = mount()
    const menu = openPaneMenu(header())
    expect(paneMenuItems(menu).slice(0, 2)).toEqual(['Rename', 'Regenerate title'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Regenerate title' }))
    expect(regenerations(live)).toEqual([{ type: 'regenerate-thread-title', threadId: 'visual-gate' }])
  })

  it('offers nothing for a name the user set by hand: a written name never replaces one typed', () => {
    const state = threadsStateFixture()
    state.host.threads.find(thread => thread.id === 'weekly-note')!.titleSource = 'user'
    state.host.threads.find(thread => thread.id === 'visual-gate')!.titleSource = 'user'
    mount(state)
    expect(within(row('Weekly note')).queryByRole('button', { name: 'Regenerate title for Weekly note' })).toBeNull()
    const menu = openPaneMenu(header())
    expect(within(menu).queryByRole('menuitem', { name: 'Regenerate title' })).toBeNull()
    // Renaming by hand is still offered, so the name is never stuck.
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument()
  })

  it('offers nothing for an archived thread', () => {
    const state = threadsStateFixture()
    state.host.threads.find(thread => thread.id === 'weekly-note')!.archivedAt = new Date(E2E_THREADS_NOW).toISOString()
    mount(state)
    fireEvent.click(screen.getByRole('button', { name: /^Settled/ }))
    expect(within(row('Weekly note')).queryByRole('button', { name: 'Regenerate title for Weekly note' })).toBeNull()
  })
})
