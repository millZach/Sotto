import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from './liveAgentState'
import { openPaneMenu } from './paneMenu'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

function mount(state: AgentState = threadsStateFixture()) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView onOpenAgents={vi.fn()} now={E2E_THREADS_NOW} />)
  return live
}
const renames = (live: ReturnType<typeof liveAgentState>): Extract<AgentCommand, { type: 'rename-thread' }>[] =>
  live.command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: 'rename-thread' }> => request.type === 'rename-thread')
/** The sidebar row for one thread, away from the pane header that names the same thread. */
const row = (title: string): HTMLElement => screen.getByRole('button', { name: title }).closest('li')!
const header = (): HTMLElement => document.querySelector('.thread-workspace__head')!

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(cleanup)

describe('renaming a thread from the sidebar row', () => {
  it('confirms with Enter, sending the trimmed name as a command', () => {
    const live = mount()
    fireEvent.click(within(row('Weekly note')).getByRole('button', { name: 'Rename Weekly note' }))
    const field = screen.getByRole('textbox', { name: 'Rename Weekly note' })
    expect(field).toHaveValue('Weekly note')
    fireEvent.change(field, { target: { value: '  Friday wrap  ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(renames(live)).toEqual([{ type: 'rename-thread', threadId: 'weekly-note', title: 'Friday wrap' }])
    expect(screen.queryByRole('textbox', { name: 'Rename Weekly note' })).toBeNull()
  })

  it('cancels with Escape, leaving the thread and its name alone', () => {
    const live = mount()
    fireEvent.click(within(row('Weekly note')).getByRole('button', { name: 'Rename Weekly note' }))
    const field = screen.getByRole('textbox', { name: 'Rename Weekly note' })
    fireEvent.change(field, { target: { value: 'Friday wrap' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(renames(live)).toEqual([])
    expect(screen.queryByRole('textbox', { name: 'Rename Weekly note' })).toBeNull()
    expect(within(row('Weekly note')).getByRole('button', { name: 'Weekly note' })).toBeInTheDocument()
  })

  it('refuses an empty or whitespace-only name and keeps the editor open', () => {
    const live = mount()
    fireEvent.click(within(row('Weekly note')).getByRole('button', { name: 'Rename Weekly note' }))
    const field = screen.getByRole('textbox', { name: 'Rename Weekly note' })
    fireEvent.change(field, { target: { value: '   ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(renames(live)).toEqual([])
    expect(field).toHaveAttribute('aria-invalid', 'true')
    // The name is still there to fix, and confirming a real one still works.
    fireEvent.change(field, { target: { value: 'Friday wrap' } })
    expect(field).not.toHaveAttribute('aria-invalid')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(renames(live)).toEqual([{ type: 'rename-thread', threadId: 'weekly-note', title: 'Friday wrap' }])
  })

  it('offers no rename for an archived thread', () => {
    const state = threadsStateFixture()
    state.host.threads.find(thread => thread.id === 'weekly-note')!.archivedAt = new Date(E2E_THREADS_NOW).toISOString()
    mount(state)
    // An archived thread sits on the Settled shelf; its row offers no rename even when opened.
    fireEvent.click(screen.getByRole('button', { name: /^Settled/ }))
    expect(within(row('Weekly note')).queryByRole('button', { name: 'Rename Weekly note' })).toBeNull()
  })
})

describe('renaming a thread from the pane header', () => {
  it('edits the title in place and confirms with Enter', () => {
    const live = mount()
    const title = within(header()).getByRole('heading', { level: 2 })
    expect(title).toHaveTextContent('Visual gate flake')
    fireEvent.click(within(openPaneMenu(header())).getByRole('menuitem', { name: 'Rename' }))
    const field = within(header()).getByRole('textbox', { name: 'Rename Visual gate flake' })
    fireEvent.change(field, { target: { value: 'Flaky visual gate' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(renames(live)).toEqual([{ type: 'rename-thread', threadId: 'visual-gate', title: 'Flaky visual gate' }])
  })

  it('cancels with Escape and refuses a blank name', () => {
    const live = mount()
    fireEvent.click(within(openPaneMenu(header())).getByRole('menuitem', { name: 'Rename' }))
    fireEvent.keyDown(within(header()).getByRole('textbox', { name: 'Rename Visual gate flake' }), { key: 'Escape' })
    expect(within(header()).queryByRole('textbox')).toBeNull()
    fireEvent.click(within(openPaneMenu(header())).getByRole('menuitem', { name: 'Rename' }))
    const field = within(header()).getByRole('textbox', { name: 'Rename Visual gate flake' })
    fireEvent.change(field, { target: { value: ' ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(renames(live)).toEqual([])
    expect(field).toHaveAttribute('aria-invalid', 'true')
  })
})
