import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOptionalAgents } from '../../../../../src/renderer/src/agents/AgentContext'
import { CouncilChamber } from '../../../../../src/renderer/src/features/council/CouncilChamber'
import { CouncilView, liveCouncil } from '../../../../../src/renderer/src/features/council/CouncilView'
import { useOptionalApp, type AppContextValue } from '../../../../../src/renderer/src/state/AppContext'
import type { AgentCommand, AgentState, AgentThread } from '../../../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'
import { agentContextFixture } from '../../../../fixtures/agentContext'
import { threadsStateFixture } from '../../../../fixtures/agentState'
import { councilFixture, row } from './chamberFixtures'

vi.mock('../../../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/agents/AgentContext')>(),
  useOptionalAgents: vi.fn(),
}))

const running = { status: 'running' as const, lastTurn: { id: 'turn', status: 'running' as const } }
function provide(threads: readonly Partial<AgentThread>[] = []) {
  const state = threadsStateFixture({ threads })
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  const navigate = vi.fn(), updateSettings = vi.fn(async () => true)
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'council', platform: 'win32', settings: DEFAULT_SETTINGS, actions: { navigate, updateSettings } } as unknown as AppContextValue)
  return { command, navigate, updateSettings }
}
const noSeats = { panelists: [], chair: undefined }

afterEach(() => { cleanup(); vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset() })

describe('the chamber’s figures', () => {
  it('puts a button over each figure that names its model, what it does and what a press does, and keeps the canvas from assistive technology', () => {
    provide([
      { id: 'thread-a', ...running, activities: [{ id: 'x', turnId: 'turn', sequence: 1, kind: 'command', status: 'running', title: 'Run', command: 'git log -5' }] },
      { id: 'thread-b', ...running, messages: [{ id: 'm', role: 'assistant', text: 'Now.', createdAt: '2026-11-02T10:00:01.000Z' }] },
      { id: 'thread-c', requests: [{ id: 'r', kind: 'question', title: 'Keep them?' } as never] },
      { id: 'thread-chair' },
    ])
    const council = councilFixture({ stage: 'answers', rows: [row('A', 'answer', 'working'), row('B', 'answer', 'working'), row('C', 'answer', 'working')] })
    const { container } = render(<CouncilChamber council={council} askSeats={noSeats} layout="long-table" />)
    expect(container.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'A, Opus 5.5, working: git log -5. Open its thread',
      'B, GPT-6.1 Sol, writing its answer. Open its thread',
      'C, Grok 4.7, needs your answer. Open its thread',
      'Chair, Wonder Full, listening. Open its thread',
    ])
  })

  it('opens a figure’s thread on a press', async () => {
    const { command, navigate } = provide()
    render(<CouncilChamber council={councilFixture({ stage: 'answers', rows: [row('A', 'answer', 'done')] })} askSeats={noSeats} layout="half-circle" />)
    await userEvent.click(screen.getByRole('button', { name: 'A, Opus 5.5, done. Open its thread' }))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'thread-a' })
    expect(navigate).toHaveBeenCalledWith('threads')
  })

  it('asks for the Council’s threads’ histories while it shows them, and lets them go when it goes', () => {
    const { command } = provide()
    const { unmount } = render(<CouncilChamber council={councilFixture({})} askSeats={noSeats} layout="round-table" />)
    expect(command).toHaveBeenCalledWith({ type: 'observe-threads', threadIds: ['thread-a', 'thread-b', 'thread-c', 'thread-chair'] })
    unmount()
    expect(command).toHaveBeenLastCalledWith({ type: 'observe-threads', threadIds: [] })
  })

  it('has no buttons in the Ask view, where no thread has started, and asks for no history', () => {
    const { command } = provide()
    render(<CouncilChamber council={null} askSeats={{ panelists: [undefined, undefined], chair: undefined }} layout="long-table" />)
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(command).not.toHaveBeenCalled()
  })

  it('shows the Council being worked, the newest of them, and the Ask view once none is', () => {
    const older = councilFixture({}, { id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-11-01T10:00:00.000Z', status: 'waiting' })
    const newer = councilFixture({}, { createdAt: '2026-11-02T10:00:00.000Z' })
    expect(liveCouncil([older, newer])).toBe(newer)
    expect(liveCouncil([{ ...newer, status: 'done' }, { ...older, status: 'settled' }])).toBeNull()
    expect(liveCouncil(null)).toBeNull()
  })
})

describe('the Council page’s Layout menu', () => {
  it('names the layout, changes the setting, and closes on Escape with focus back on its button', async () => {
    const user = userEvent.setup()
    const { updateSettings } = provide()
    render(<CouncilView bridge={undefined} />)
    const button = screen.getByRole('button', { name: 'Layout: Long table' })
    await user.click(button)
    const menu = screen.getByRole('listbox', { name: 'Layout' })
    expect(within(menu).getAllByRole('option').map(option => option.textContent)).toEqual(['Long table', 'Half circle', 'Round table'])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(button).toHaveFocus()
    await user.click(button)
    await user.click(screen.getByRole('option', { name: 'Round table' }))
    expect(updateSettings).toHaveBeenCalledWith({ councilLayout: 'round-table' })
    expect(button).toHaveFocus()
  })
})
