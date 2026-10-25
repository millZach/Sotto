import { baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOptionalAgents } from '../../../../../src/renderer/src/agents/AgentContext'
import { quietAgo } from '../../../../../src/renderer/src/features/settings/ClearThreadsSettings'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import type { AgentCommand, AgentState } from '../../../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'
import type { ThreadClearPreview, ThreadClearResult } from '../../../../../src/shared/threadClear'
import { agentContextFixture } from '../../../../fixtures/agentContext'
import { threadsStateFixture } from '../../../../fixtures/agentState'

// Clearing threads is an Owl feature (ADR-0140): only `clear-threads` is turned on here, and the stable test turns it off.
const owl = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'clear-threads' && owl.on,
}))

afterEach(() => { owl.on = true })

const DAY = 86_400_000
const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString()
const PREVIEW: Record<number, ThreadClearPreview> = {
  30: { olderThanDays: 30, go: [
    { threadId: 'a', title: 'Move the cleanup rules', projectTitle: 'Sotto', quietSince: ago(41), removesWorktree: true },
    { threadId: 'b', title: 'Ship a Mac host archive', projectTitle: 'Sotto', quietSince: ago(63), removesWorktree: false },
  ], kept: [{ threadId: 'c', title: 'Speech model quota copy', projectTitle: 'Sotto', reason: 'pull-request' }] },
  7: { olderThanDays: 7, go: [{ threadId: 'd', title: 'Review the fixture deadline', projectTitle: 'Sotto', quietSince: ago(12), removesWorktree: false }], kept: [] },
  90: { olderThanDays: 90, go: [], kept: [] },
}

function withAgents(result: ThreadClearResult = { cleared: 2, kept: [] }, error: string | null = null) {
  const state = threadsStateFixture({ cloneOverrides: false })
  const command = vi.fn(async (request: AgentCommand): Promise<AgentState | null> => {
    if (request.type === 'preview-clear-threads') return { ...state, error: null, threadClearPreview: PREVIEW[request.olderThanDays]! }
    if (request.type === 'clear-threads') return error ? { ...state, error } : { ...state, error: null, threadClearResult: result }
    return state
  })
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  return command
}
const sent = <T extends AgentCommand['type']>(command: ReturnType<typeof withAgents>, type: T) =>
  command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: T }> => request.type === type)

describe('Settings → Threads, Clearing threads', () => {
  it('shows nothing of clearing on stable', async () => {
    owl.on = false
    withAgents()
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Threads')
    expect(screen.queryByRole('heading', { name: 'Clearing threads' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Clear settled threads after' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear now…' })).toBeNull()
  })

  it('saves Clear settled threads after, 30 days by default and Never still a choice', async () => {
    withAgents()
    const update = vi.fn(async () => true)
    const user = userEvent.setup()
    const rendered = render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Threads')
    const after = screen.getByRole('combobox', { name: 'Clear settled threads after' })
    expect(after).toHaveValue('30')
    expect(within(after).getAllByRole('option').map(option => option.textContent)).toEqual(['Never', '30 days', '90 days', '180 days'])
    expect(after).toHaveAccessibleDescription(/Never clears one with uncommitted work or an open pull request. Checked every hour./u)
    await user.selectOptions(after, '90')
    expect(update).toHaveBeenCalledWith({ clearSettledThreadsAfterDays: 90 })
    rendered.rerender(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, clearSettledThreadsAfterDays: 90 } })} />)
    expect(after).toHaveValue('90')
    await user.selectOptions(after, 'never')
    expect(update).toHaveBeenLastCalledWith({ clearSettledThreadsAfterDays: null })
  })

  it('lists what goes and what is kept, and clears exactly the threads it listed', async () => {
    const command = withAgents({ cleared: 1, kept: [{ threadId: 'b', title: 'Ship a Mac host archive', projectTitle: 'Sotto', reason: 'working' }] })
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Threads')
    expect(screen.getByRole('combobox', { name: 'Settled threads on this computer quiet longer than' })).toHaveValue('30')
    const opener = screen.getByRole('button', { name: 'Clear now…' })
    opener.focus()
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Clear settled threads' })
    expect(sent(command, 'preview-clear-threads')).toEqual([{ type: 'preview-clear-threads', olderThanDays: 30 }])
    const go = await within(dialog).findByRole('list', { name: 'Threads that go' })
    expect(within(dialog).getByRole('heading', { name: '2 threads go' })).toBeInTheDocument()
    expect(within(go).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Move the cleanup rules41 days ago', 'Ship a Mac host archive2 months ago'])
    expect(within(within(dialog).getByRole('list', { name: 'Threads kept' })).getByRole('listitem')).toHaveTextContent('Speech model quota copypull request still open')
    expect(dialog).toHaveTextContent('Their messages and activity leave Sotto and can’t be brought back.')
    expect(dialog).toHaveTextContent('Removes the one worktree folder these threads made. Branches and their commits stay.')
    expect(dialog).toHaveTextContent('Usage keeps its numbers. Providers keep their own copies of the sessions.')
    expect(within(dialog).getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear 2 threads' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sent(command, 'clear-threads')).toEqual([{ type: 'clear-threads', olderThanDays: 30, threadIds: ['a', 'b'] }])
    // One changed between the list and the press, so it was kept; the notice says so.
    expect(screen.getByRole('status')).toHaveTextContent('Cleared 1 thread. 1 thread changed since the list was made and was kept.')
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('asks again for another age, says nothing of folders when none go, and cannot clear an empty list', async () => {
    const command = withAgents()
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Threads')
    fireEvent.click(screen.getByRole('button', { name: 'Clear now…' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('list', { name: 'Threads that go' })
    fireEvent.click(within(dialog).getByRole('radio', { name: '7 days' }))
    await waitFor(() => expect(within(dialog).getByRole('heading', { name: '1 thread goes' })).toBeInTheDocument())
    expect(dialog).toHaveTextContent('Its messages and activity leave Sotto and can’t be brought back.')
    expect(dialog).not.toHaveTextContent('worktree')
    expect(within(dialog).getByRole('button', { name: 'Clear 1 thread' })).toBeEnabled()
    // The row's age follows the dialog's.
    expect(screen.getByRole('combobox', { name: 'Settled threads on this computer quiet longer than', hidden: true })).toHaveValue('7')
    fireEvent.click(within(dialog).getByRole('radio', { name: '90 days' }))
    await waitFor(() => expect(dialog).toHaveTextContent('No settled thread on this computer has been quiet that long.'))
    expect(within(dialog).getByRole('button', { name: 'Clear threads' })).toBeDisabled()
    expect(sent(command, 'preview-clear-threads').map(request => request.olderThanDays)).toEqual([30, 7, 90])
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sent(command, 'clear-threads')).toEqual([])
  })

  it('keeps the dialog open with main’s own words when the clear is refused', async () => {
    withAgents(undefined, 'This computer runs no threads of its own here, so there is nothing to clear. Nothing was deleted.')
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Threads')
    fireEvent.click(screen.getByRole('button', { name: 'Clear now…' }))
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('list', { name: 'Threads that go' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear 2 threads' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('This computer runs no threads of its own here, so there is nothing to clear. Nothing was deleted.')
  })
})

describe('quietAgo', () => {
  it('says how long ago in days, then months, then years', () => {
    const now = Date.parse('2026-10-23T12:00:00Z')
    const at = (days: number): string => new Date(now - days * DAY).toISOString()
    expect([0, 1, 41, 59, 63, 400, 900].map(days => quietAgo(at(days), now, 'en'))).toEqual(['today', 'yesterday', '41 days ago', '59 days ago', '2 months ago', '13 months ago', '2 years ago'])
  })
})
