// #1178 part 2 (Zach's pick B, October 29, 2026): Move threads beside Stop all, its sheet, Continue on another machine…
// from a thread's More menu, and each move's card in Watcher's conversation with its press.
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import type { HostsBridge } from '../../../src/shared/hosts'
import type { ThreadMoveCard, ThreadMovePrepare, ThreadMovesBridge, ThreadMovesView } from '../../../src/shared/threadMoves'
import { machinesConnected, moveCardsStore, moveSheetStore, MoveThreadsSheetHost, WatcherMoveCards, WatcherMoveThreads, type MoveCardThreads } from '../../../src/renderer/src/watcher/MoveThreads'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { hostsBridgeFixture, hostsState, hostStatus } from '../../fixtures/renderer/hostBridges'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))
vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))

const LOCAL = '7d1c8a52-5f0a-4d55-9a38-1f9b7a2a0c11', FORGE = '0b7f4c1e-2a9d-4f61-8c3e-5d2b9a7e4f10', STUDIO = 'c5e2a1f8-9b3d-4e72-a6c1-3f8d2b5e9a07'
const CONFIRMATION = '07b51f0b-ed75-4abb-aea3-a014fceef088', CARD = '5b3c9e1a-7d24-4f6b-8a90-2c1e4d7f6a35'
const AT = '2026-10-29T14:40:00.000Z'

function thread(id: string, title: string, over: Partial<AgentThread> = {}): AgentThread {
  return { id, title, providerId: 'codex', projectId: 'sotto', status: 'idle', requests: [], messages: [], ...over } as AgentThread
}
const THREADS = [thread('tray', 'Tray icon at night'), thread('menu', 'Linux tray menu spacing'), thread('wav', 'Streaming WAV stall', { status: 'running' }),
  thread('watcher', 'Watcher', { kind: 'watcher' }), thread('old', 'Settled work', { workspaceSettledAt: AT } as Partial<AgentThread>)]
const state = { hostId: LOCAL, host: { hostId: LOCAL, threads: THREADS, projects: [{ id: 'sotto', title: 'Sotto', path: '/sotto' }] } } as unknown as AgentState

function bridges(options: { machines?: { hostId: string; name: string; phase: 'connected' | 'disconnected' }[]; preview?: ThreadMovePrepare } = {}) {
  const hosts: HostsBridge = hostsBridgeFixture({ initial: hostsState({ localHostId: LOCAL, hosts: (options.machines ?? [{ hostId: FORGE, name: 'forge', phase: 'connected' }])
    .map(machine => hostStatus({ id: machine.hostId, hostId: machine.hostId, name: machine.name, phase: machine.phase })) } as never) }).bridge
  let push: ((view: ThreadMovesView) => void) | undefined
  const moves: ThreadMovesBridge = {
    prepare: vi.fn(async () => options.preview ?? { status: 'ok' as const, confirmationId: CONFIRMATION, expiresAt: AT, machine: 'forge', threads: [
      { threadId: 'tray', outcome: 'moves' as const, model: { name: 'GPT-5.5' } },
      { threadId: 'menu', outcome: 'asks' as const, model: { name: 'GPT-5.5', instead: 'O5' }, startsOn: 'Allow edits',
        words: 'It would start on Allow edits on forge, not this thread’s Full access, since your new-thread default allows no more.' },
      { threadId: 'wav', outcome: 'stays' as const, words: 'A turn is running. Move it once the turn ends, or stop it.' }] }),
    start: vi.fn(async () => ({ status: 'ok' as const, moves: [] })),
    read: vi.fn(async () => ({ cards: [] })),
    answer: vi.fn(async () => ({ status: 'ok' as const })),
    onChanged: vi.fn(listener => { push = listener; return () => { push = undefined } }),
  }
  ;(window as unknown as { sotto: unknown }).sotto = { hosts, threadMoves: moves }
  return { hosts, moves, push: (view: ThreadMovesView) => act(() => push?.(view)) }
}

beforeEach(() => {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { 'cross-machine-work': true, watcher: true } } } as unknown as ReturnType<typeof useOptionalApp>)
  vi.mocked(useOptionalAgents).mockReturnValue({ state } as unknown as ReturnType<typeof useOptionalAgents>)
})
afterEach(() => {
  cleanup(); vi.clearAllMocks(); machinesConnected.clear(); moveCardsStore.clear(); moveSheetStore.close()
  delete (window as unknown as { sotto?: unknown }).sotto
})

describe('Move threads and its sheet', () => {
  it('is hidden while no other machine is connected, and in stable', async () => {
    bridges({ machines: [{ hostId: FORGE, name: 'forge', phase: 'disconnected' }] })
    render(<WatcherMoveThreads />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button', { name: 'Move threads to another machine' })).toBeNull()
    cleanup(); machinesConnected.clear()
    bridges()
    vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { watcher: true } } } as unknown as ReturnType<typeof useOptionalApp>)
    render(<WatcherMoveThreads />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button', { name: 'Move threads to another machine' })).toBeNull()
  })

  it('asks once for every open thread here: what moves now, what asks first and what stays and why', async () => {
    const { moves } = bridges()
    render(<><WatcherMoveThreads /><MoveThreadsSheetHost /></>)
    fireEvent.click(await screen.findByRole('button', { name: 'Move threads to another machine' }))
    // One machine connected: nothing to choose, so the sheet asks it at once, for This computer's open threads only.
    const sheet = await screen.findByRole('dialog', { name: 'Move 2 threads to forge?' })
    expect(moves.prepare).toHaveBeenCalledWith({ threadIds: ['tray', 'menu', 'wav'], hostId: FORGE })
    const body = within(within(sheet).getByRole('region', { name: 'What moves and what stays' }))
    expect(body.getByRole('heading', { name: 'Moves now 1' })).toBeTruthy()
    expect(body.getByRole('heading', { name: 'Asks you first 1' })).toBeTruthy()
    expect(body.getByRole('heading', { name: 'Stays here 2' })).toBeTruthy()
    // The model each runs on there, and the one forge lacks (Zach, October 29, 2026).
    expect(body.getAllByText('GPT-5.5 on forge')).toHaveLength(2)
    expect(body.getByText('forge doesn’t have O5')).toBeTruthy()
    expect(body.getByText(/It waits on its card in Watcher’s conversation for your press before it moves\./u)).toBeTruthy()
    expect(body.getByText('A turn is running. Move it once the turn ends, or stop it.')).toBeTruthy()
    expect(body.getByText(/Watcher stays on This computer\./u)).toBeTruthy()
    // The move is the focused press, and it sends what moves and what asks, with nothing pressed for narrower.
    expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: 'Move 2 threads' }))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move 2 threads' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(moves.start).toHaveBeenCalledWith({ confirmationId: CONFIRMATION, threadIds: ['tray', 'menu'], allowNarrower: [] })
  })

  it('lets the user pick the machine when more than one is paired, naming the one not connected', async () => {
    const { moves } = bridges({ machines: [{ hostId: FORGE, name: 'forge', phase: 'connected' }, { hostId: STUDIO, name: 'studio', phase: 'connected' },
      { hostId: '11111111-1111-4111-8111-111111111111', name: 'mini', phase: 'disconnected' }] })
    render(<MoveThreadsSheetHost />)
    act(() => { moveSheetStore.open({ kind: 'one', threadId: 'tray', title: 'Tray icon at night' }) })
    const sheet = await screen.findByRole('dialog', { name: 'Move Tray icon at night to which machine?' })
    await waitFor(() => expect(within(sheet).getByRole('button', { name: /mini/u })).toHaveProperty('disabled', true))
    expect(within(sheet).getByText('Not connected')).toBeTruthy()
    fireEvent.click(within(sheet).getByRole('button', { name: 'studio' }))
    await waitFor(() => expect(moves.prepare).toHaveBeenCalledWith({ threadIds: ['tray'], hostId: STUDIO }))
    // Escape puts it away, and nothing moves.
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(moves.start).not.toHaveBeenCalled()
  })

  it('says why nothing moved when main refuses, and has only Close', async () => {
    bridges({ preview: { status: 'refused', message: 'Forge needs a newer Sotto before threads can move there. Update it from the Threads page, then try again. Nothing was moved.' } })
    render(<MoveThreadsSheetHost />)
    act(() => { moveSheetStore.open({ kind: 'all' }) })
    const sheet = await screen.findByRole('dialog', { name: 'Nothing was moved' })
    expect(within(sheet).getByRole('alert').textContent).toContain('needs a newer Sotto')
    expect(within(sheet).getAllByRole('button').map(button => button.textContent)).toEqual(['Close'])
  })
})

describe('Each move’s card in Watcher’s conversation', () => {
  const threads: MoveCardThreads = {
    describe: target => {
      const found = THREADS.find(item => item.id === target.threadId)
      return target.threadId === 'tray-there' ? { threadId: `host:${FORGE}:tray-there`, title: 'Tray icon at night', providerId: 'codex', provider: 'Codex', project: 'Sotto' }
        : { threadId: found?.id ?? null, title: found?.title ?? null, providerId: 'codex', provider: 'Codex', project: 'Sotto' }
    },
    press: threadId => ({ onClick: () => { pressed.push(threadId) } }),
  }
  let pressed: string[] = []
  beforeEach(() => { pressed = [] })
  const card = (over: Partial<ThreadMoveCard>): ThreadMoveCard => ({ id: CARD, state: 'thread-started', source: { hostId: LOCAL, threadId: 'tray' }, hostId: FORGE, machine: 'forge',
    model: { name: 'GPT-5.5' }, at: AT, updatedAt: AT, ...over })

  it('says how a move goes, then that it continued there, with a link to the new thread', () => {
    bridges()
    const { rerender } = render(<WatcherMoveCards cards={[card({})]} threads={threads} />)
    expect(screen.getByText('You asked to move 1 thread to forge. Sotto reports its move here.')).toBeTruthy()
    const item = screen.getByRole('listitem')
    expect(within(item).getByText('Moving')).toBeTruthy()
    expect(within(item).getByText('Started on forge')).toBeTruthy()
    expect(item.textContent).toContain('GPT-5.5 there')
    rerender(<WatcherMoveCards cards={[card({ state: 'source-settled', moved: { hostId: FORGE, threadId: 'tray-there' }, watched: true })]} threads={threads} />)
    expect(within(screen.getByRole('listitem')).getByText('Continued on forge')).toBeTruthy()
    expect(screen.getByRole('listitem').textContent).toContain('Settled here, and its worktree is kept. Watcher watches it there now.')
    fireEvent.click(screen.getByRole('button', { name: 'Open Tray icon at night on forge beside Watcher' }))
    expect(pressed).toEqual([`host:${FORGE}:tray-there`])
  })

  it('waits for the press on one that asks first, and says why when the press could not move it', async () => {
    const { moves } = bridges()
    render(<WatcherMoveCards cards={[card({ state: 'asks', source: { hostId: LOCAL, threadId: 'menu' }, startsOn: 'Allow edits',
      words: 'It would start on Allow edits on forge, not this thread’s Full access, since your new-thread default allows no more.' })]} threads={threads} />)
    expect(screen.getByText('Waits for you')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move it on Allow edits' }))
    await waitFor(() => expect(moves.answer).toHaveBeenCalledWith({ cardId: CARD, answer: 'move' }))
    vi.mocked(moves.answer).mockResolvedValueOnce({ status: 'refused', message: 'That move isn’t waiting for an answer any more. Nothing was moved.' })
    fireEvent.click(screen.getByRole('button', { name: 'Keep it here' }))
    expect((await screen.findByRole('alert')).textContent).toContain('isn’t waiting for an answer')
    expect(moves.answer).toHaveBeenLastCalledWith({ cardId: CARD, answer: 'keep' })
  })

  it('says a move that waits on its machine lost nothing', () => {
    bridges()
    render(<WatcherMoveCards cards={[card({ state: 'branch-sent', waiting: true })]} threads={threads} />)
    expect(screen.getByText('Waiting for forge')).toBeTruthy()
    expect(screen.getByText('This thread is waiting for forge to answer about its move. Nothing was lost.')).toBeTruthy()
  })
})
