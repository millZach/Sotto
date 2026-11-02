import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { snoozeChoices } from '../../../src/renderer/src/agents/threadSnooze'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

function mount(state: AgentState = threadsStateFixture()) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={E2E_THREADS_NOW} />)
  return live
}
const row = (title: string): HTMLElement => screen.getByRole('button', { name: title }).closest('li')!

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(cleanup)

describe('naming a thread from its sidebar row', () => {
  it('renames on a double-click of the name, with no rename or regenerate buttons on the row', () => {
    const live = mount()
    expect(within(row('Weekly note')).queryByRole('button', { name: /^(Rename|Regenerate title)/ })).toBeNull()
    fireEvent.doubleClick(within(row('Weekly note')).getByText('Weekly note'))
    const field = screen.getByRole('textbox', { name: 'Rename Weekly note' })
    fireEvent.change(field, { target: { value: 'Monday note' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(live.command).toHaveBeenCalledWith({ type: 'rename-thread', threadId: 'weekly-note', title: 'Monday note' })
  })

  it('leaves an archived thread’s name alone on a double-click', () => {
    const state = threadsStateFixture()
    state.host.threads.find(thread => thread.id === 'weekly-note')!.archivedAt = new Date(E2E_THREADS_NOW).toISOString()
    mount(state)
    fireEvent.click(screen.getByRole('button', { name: /^Settled/ }))
    fireEvent.doubleClick(within(row('Weekly note')).getByText('Weekly note'))
    expect(screen.queryByRole('textbox', { name: 'Rename Weekly note' })).toBeNull()
  })
})

describe('snoozing a thread (ADR-0175)', () => {
  it('puts a snoozed thread on its own shelf until it wakes, and wakes one that needs you', () => {
    const state = threadsStateFixture()
    const rows = describeThreads(state, E2E_THREADS_NOW)
    const waiting = rows.find(item => item.state === 'needs')!
    const resting = rows.find(item => item.state !== 'needs' && item.settledBy === null)!
    const snoozes = new Map([[resting.thread.id, E2E_THREADS_NOW + 60_000], [waiting.thread.id, E2E_THREADS_NOW + 60_000]])
    const ids = (folders: readonly { readonly rows: readonly { readonly thread: { readonly id: string } }[] }[] | undefined): string[] => (folders ?? []).flatMap(folder => folder.rows.map(item => item.thread.id))
    const asleep = organizeWorkspace(state, rows, '', null, false, E2E_THREADS_NOW, false, snoozes)
    expect(ids(asleep.snoozed)).toEqual([resting.thread.id])
    expect(ids(asleep.open)).toContain(waiting.thread.id)
    const awake = organizeWorkspace(state, rows, '', null, false, E2E_THREADS_NOW + 60_000, false, snoozes)
    expect(ids(awake.snoozed)).toEqual([])
    expect(ids(awake.open)).toContain(resting.thread.id)
  })

  it('offers This evening only before five and Next Monday only when it is not tomorrow', () => {
    // Sunday November 1, 2026, at 10 am and at 6 pm.
    expect(snoozeChoices(new Date(2026, 10, 1, 10)).map(choice => choice.id)).toEqual(['hour', 'evening', 'tomorrow'])
    const friday = snoozeChoices(new Date(2026, 10, 6, 18))
    expect(friday.map(choice => choice.id)).toEqual(['hour', 'tomorrow', 'monday'])
    expect(new Date(friday.at(-1)!.until)).toEqual(new Date(2026, 10, 9, 9))
  })
})
