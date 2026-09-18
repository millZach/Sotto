import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadPane } from '../../../src/renderer/src/agents/ThreadPane'
import { liveAgentState, threadsStateFixture } from './liveAgentState'
import { openPaneMenu, paneMenuItems } from './paneMenu'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
// The voice coordinator is hidden for the beta, so Manage and its companions are listed only when it is on.
const voice = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../../src/renderer/src/state/voiceCoordinator', () => ({ useVoiceCoordinatorEnabled: () => voice.enabled }))

const THREAD = 'grok-previews'

/** One idle thread of the fixture, on its own, with a provider that can compact and a place to open beside. */
function mount({ beside = true }: { readonly beside?: boolean } = {}) {
  const state: AgentState = threadsStateFixture()
  state.assignments = []
  state.queue = []
  state.activeThreadId = THREAD
  state.host.capabilities = { ...state.host.capabilities, compact: true }
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  const command = live.command
  const row = describeThreads(state, E2E_THREADS_NOW).find(item => item.thread.id === THREAD)!
  const onOpenBeside = vi.fn()
  render(<ThreadPane row={row} state={state} command={command} store={new ThreadDraftStore(command)} focused promptId="prompt" error={null}
    onOpenThread={vi.fn()} onOpenBeside={beside ? onOpenBeside : undefined} />)
  const head = (): HTMLElement => document.querySelector('.thread-workspace__head')!
  return { command, onOpenBeside, head, requests: (): AgentCommand[] => command.mock.calls.map(([request]) => request) }
}

beforeEach(() => { voice.enabled = false; vi.mocked(useAgents).mockReset() })
afterEach(cleanup)

describe('the pane header’s More menu', () => {
  it('lists what the beta offers, in groups, with nothing about the hidden voice coordinator', () => {
    const view = mount()
    const menu = openPaneMenu(view.head())
    expect(paneMenuItems(menu)).toEqual(['Rename', 'Regenerate title', 'Open beside', 'Compact context', 'Settle'])
    // Three groups: naming the thread, its context, and where it rests.
    expect(menu.querySelectorAll('hr')).toHaveLength(2)
  })

  it('adds management once the voice coordinator is on', () => {
    voice.enabled = true
    const view = mount()
    expect(paneMenuItems(openPaneMenu(view.head()))).toEqual(['Rename', 'Regenerate title', 'Open beside', 'Compact context', 'Settle', 'Manage'])
  })

  it('leaves Open beside out where the caller has nowhere to put a second pane', () => {
    const view = mount({ beside: false })
    expect(paneMenuItems(openPaneMenu(view.head()))).toEqual(['Rename', 'Regenerate title', 'Compact context', 'Settle'])
  })

  it('runs the item chosen and closes, and closes on Escape or a pointer outside without running anything', () => {
    const view = mount()
    fireEvent.click(within(openPaneMenu(view.head())).getByRole('menuitem', { name: 'Compact context' }))
    expect(view.requests()).toContainEqual({ type: 'compact-thread', threadId: THREAD })
    expect(within(view.head()).queryByRole('menu')).toBeNull()
    // Escape returns focus to the button the menu came from, so the keyboard never lands on the page.
    const more = within(view.head()).getByRole('button', { name: 'More actions' })
    fireEvent.keyDown(openPaneMenu(view.head()), { key: 'Escape' })
    expect(within(view.head()).queryByRole('menu')).toBeNull()
    expect(more).toHaveFocus()
    expect(more).toHaveAttribute('aria-expanded', 'false')
    openPaneMenu(view.head())
    expect(more).toHaveAttribute('aria-expanded', 'true')
    fireEvent.pointerDown(document.body)
    expect(within(view.head()).queryByRole('menu')).toBeNull()
    expect(view.requests().filter(request => request.type === 'compact-thread')).toHaveLength(1)
  })

  it('renames in place from the menu, which is where the header keeps its name', () => {
    const view = mount()
    fireEvent.click(within(openPaneMenu(view.head())).getByRole('menuitem', { name: 'Rename' }))
    const field = within(view.head()).getByRole('textbox', { name: 'Rename Grok voice previews' })
    fireEvent.change(field, { target: { value: 'Voice previews' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(view.requests()).toContainEqual({ type: 'rename-thread', threadId: THREAD, title: 'Voice previews' })
  })

  it('opens the thread beside this one through the caller’s own handler', () => {
    const view = mount()
    fireEvent.click(within(openPaneMenu(view.head())).getByRole('menuitem', { name: 'Open beside' }))
    expect(view.onOpenBeside).toHaveBeenCalledOnce()
  })
})

describe('the composer while the voice coordinator is hidden', () => {
  it('writes by hand even in a thread the saved state says Sotto manages', () => {
    voice.enabled = false
    const state = threadsStateFixture()
    state.activeThreadId = 'visual-gate'
    const live = liveAgentState(state)
    vi.mocked(useAgents).mockImplementation(live.useLive)
    const row = describeThreads(live.state, E2E_THREADS_NOW).find(item => item.thread.id === 'visual-gate')!
    // The fixture has this thread assigned to the coordinator; with it hidden, the pane offers the manual prompt.
    expect(row.assignment?.mode).toBe('managed')
    render(<ThreadPane row={row} state={live.state} command={live.command} store={new ThreadDraftStore(live.command)} focused promptId="manual" error={null} onOpenThread={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveAttribute('id', 'manual')
    expect(screen.queryByRole('button', { name: 'Write here' })).toBeNull()
  })
})
