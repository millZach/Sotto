import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { connection, NOW, stateFixture } from '../../fixtures/renderer/threadsViewHarness'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { PageSidebar } from '../../../src/renderer/src/agents/PageSidebar'
import { SINGLE_VIEW, SplitLayoutStore } from '../../../src/renderer/src/agents/splitLayout'

const gate = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../../src/renderer/src/state/watcherFeature', () => ({ useWatcherEnabled: () => gate.enabled }))
beforeEach(() => { gate.enabled = false; localStorage.clear() })

function seed() {
  const state = stateFixture()
  const current = state.host.threads.find(thread => thread.id === 'grok-previews')!
  const history = state.host.threads.find(thread => thread.id === 'visual-gate')!
  current.kind = 'watcher'; current.title = 'Saved Watcher'; current.status = 'idle'
  history.kind = 'watcher-history'; history.title = 'Saved Watcher history'
  state.activeThreadId = current.id
  state.draft = 'Saved Watcher prompt'; state.draftThreadId = current.id
  state.threadDrafts = [{ threadId: current.id, draftId: '147b9fb5-6fae-4c90-93cd-969558a82932', text: 'Saved Watcher prompt', attachments: [], skills: [], files: [], requestId: null, updatedAt: '2026-10-10T17:00:00Z' }]
  const command = vi.fn(async () => state)
  vi.mocked(useAgents).mockReturnValue(connection(state, command))
  return { state, command, current, history }
}

describe('Watcher kinds in existing thread surfaces', () => {
  it('omits Watcher from panes, selection and search like a missing thread', async () => {
    const { state, command, current, history } = seed()
    const ordinary = state.host.threads.filter(thread => thread.id !== current.id && thread.id !== history.id).slice(0, 2)
    const store = new SplitLayoutStore(localStorage)
    store.set({ ...SINGLE_VIEW, panes: [current.id, ordinary[0]!.id, history.id, ordinary[1]!.id], focused: current.id })
    render(<ThreadsView now={NOW} layoutStore={store} paneAreaWidth={1400} paneAreaHeight={800} />)
    expect(screen.queryByRole('region', { name: current.title })).toBeNull()
    expect(screen.queryByRole('region', { name: history.title })).toBeNull()
    expect(screen.queryByDisplayValue('Saved Watcher prompt')).toBeNull()
    const sidebar = within(screen.getByRole('complementary', { name: 'Thread sidebar' }))
    fireEvent.change(sidebar.getByRole('searchbox'), { target: { value: 'Saved Watcher' } })
    expect(sidebar.queryByRole('button', { name: /Saved Watcher/ })).toBeNull()
    fireEvent.change(sidebar.getByRole('searchbox'), { target: { value: '' } })
    await act(async () => { fireEvent.click(sidebar.getByRole('button', { name: ordinary[0]!.title })) })
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: ordinary[0]!.id })
    for (const thread of [current, history]) expect(command).not.toHaveBeenCalledWith({ type: 'select-thread', threadId: thread.id })
  })

  it.each([false, true])('uses the same visibility gate in the page sidebar (enabled: %s)', enabled => {
    gate.enabled = enabled
    const { current, history } = seed()
    render(<PageSidebar now={NOW} />)
    // With the gate on, the current Watcher lives in Watcher's room; its history stays where ordinary threads are.
    expect(screen.queryByRole('button', { name: current.title })).toBeNull()
    expect(screen.queryByRole('button', { name: history.title }) !== null).toBe(enabled)
  })

  it('leaves the current Watcher to its room when the gate is on, and keeps Watcher history on the Threads page', async () => {
    gate.enabled = true
    const { command, current, history } = seed()
    render(<ThreadsView now={NOW} />)
    expect(screen.queryByRole('region', { name: current.title })).toBeNull()
    expect(screen.queryByDisplayValue('Saved Watcher prompt')).toBeNull()
    const sidebar = within(screen.getByRole('complementary', { name: 'Thread sidebar' }))
    expect(sidebar.queryByRole('button', { name: current.title })).toBeNull()
    await act(async () => { fireEvent.click(sidebar.getByRole('button', { name: history.title })) })
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: history.id })
    expect(command).not.toHaveBeenCalledWith({ type: 'select-thread', threadId: current.id })
  })
})
