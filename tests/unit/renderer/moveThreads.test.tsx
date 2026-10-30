// #1178 part 2 (Zach's pick B, October 29, 2026): Move threads beside Stop all, its sheet, Continue on another machine…
// from a thread's More menu, and each move's card in Watcher's conversation with its press.
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import type { HostsBridge } from '../../../src/shared/hosts'
import type { ThreadMoveCard, ThreadMovePrepare, ThreadMoveProposal, ThreadMovesBridge, ThreadMovesView } from '../../../src/shared/threadMoves'
import { machinesConnected, moveCardsStore, moveSheetStore, MoveThreadsSheetHost, WatcherMoveCards, WatcherMoveProposals, WatcherMoveThreads, type MoveCardThreads } from '../../../src/renderer/src/watcher/MoveThreads'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { useWatcherRoom } from '../../../src/renderer/src/watcher/watcherRoom'
import { hostsBridgeFixture, hostsState, hostStatus } from '../../fixtures/renderer/hostBridges'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))
vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/watcher/watcherRoom', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/watcher/watcherRoom')>(), useWatcherRoom: vi.fn() }))

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
  vi.mocked(useWatcherRoom).mockReturnValue({ state: { current: { createdAt: AT } } } as unknown as ReturnType<typeof useWatcherRoom>)
})
afterEach(() => {
  cleanup(); vi.clearAllMocks(); machinesConnected.clear(); moveCardsStore.clear(); moveSheetStore.close()
  delete (window as unknown as { sotto?: unknown }).sotto
})

describe('Move threads and its sheet', () => {
  it('is hidden while no other machine is connected, before Watcher starts, and in stable', async () => {
    bridges({ machines: [{ hostId: FORGE, name: 'forge', phase: 'disconnected' }] })
    render(<WatcherMoveThreads />)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('button', { name: 'Move threads to another machine' })).toBeNull()
    cleanup(); machinesConnected.clear()
    bridges()
    vi.mocked(useWatcherRoom).mockReturnValueOnce({ state: { current: null } } as unknown as ReturnType<typeof useWatcherRoom>)
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
    // One machine to choose, since no other machine has a thread to bring here: the sheet asks it at once, for every
    // open thread on another machine, with nothing ticked (Zach's pick, October 29).
    const sheet = await screen.findByRole('dialog', { name: 'Choose threads to move to forge' })
    expect(moves.prepare).toHaveBeenCalledWith({ threadIds: ['tray', 'menu', 'wav'], hostId: FORGE })
    const body = within(within(sheet).getByRole('region', { name: 'What moves and what stays' }))
    expect(body.getByRole('heading', { name: 'Moves now 1' })).toBeTruthy()
    expect(body.getByRole('heading', { name: 'Asks you first 1' })).toBeTruthy()
    expect(body.getByRole('heading', { name: 'Stays where it is 2' })).toBeTruthy()
    expect(body.getAllByText('This computer').length).toBeGreaterThan(0)
    expect(within(sheet).getByRole('button', { name: 'Move threads' })).toHaveProperty('disabled', true)
    fireEvent.click(body.getByRole('checkbox', { name: 'Tray icon at night' }))
    fireEvent.click(body.getByRole('checkbox', { name: 'Linux tray menu spacing' }))
    expect(within(sheet).getByRole('heading', { name: 'Move 2 threads to forge?' })).toBeTruthy()
    // The model each runs on there, and the one forge lacks (Zach, October 29, 2026).
    expect(body.getAllByText('GPT-5.5 on forge')).toHaveLength(2)
    expect(body.getByText('forge doesn’t have O5')).toBeTruthy()
    expect(body.getByText(/It waits on its card in Watcher’s conversation for your press before it moves\./u)).toBeTruthy()
    expect(body.getByText('A turn is running. Move it once the turn ends, or stop it.')).toBeTruthy()
    expect(body.getByText(/Watcher stays on This computer\./u)).toBeTruthy()
    // Cancel takes focus, as every confirmation's secondary action does; the move sends what moves and what asks, with
    // nothing pressed for narrower.
    expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: 'Cancel' }))
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

  it('leaves a sheet opened again alone when an earlier one’s moves finish starting', async () => {
    const { moves } = bridges()
    let finish: (() => void) | undefined
    vi.mocked(moves.start).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ status: 'ok', moves: [] }) }))
    render(<MoveThreadsSheetHost />)
    act(() => { moveSheetStore.open({ kind: 'all' }) })
    const first = await screen.findByRole('dialog', { name: 'Choose threads to move to forge' })
    fireEvent.click(within(first).getByRole('checkbox', { name: 'Tray icon at night' }))
    fireEvent.click(within(first).getByRole('button', { name: 'Move 1 thread' }))
    // Put away while its moves start, then opened again for one thread.
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    act(() => { moveSheetStore.open({ kind: 'one', threadId: 'tray', title: 'Tray icon at night' }) })
    await screen.findByRole('dialog', { name: 'Move Tray icon at night to forge?' })
    await act(async () => { finish!(); await Promise.resolve() })
    expect(screen.getByRole('dialog', { name: 'Move Tray icon at night to forge?' })).toBeTruthy()
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

describe('Moving threads from every machine (#1178 part 3)', () => {
  const LAB = '3f2a9c71-6e4b-4d18-9a52-7b1c0e8d6f24'
  const withLab = { ...state, connections: [{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }], host: { ...state.host,
    threads: [...THREADS, thread(`host:${LAB}:shader`, 'Shader cache warmup', { remoteHost: true, hostId: LAB, hostLabel: 'lab' } as Partial<AgentThread>)] } } as unknown as AgentState
  it('offers This computer while another machine has a thread to bring here, and gathers every other machine’s threads', async () => {
    vi.mocked(useOptionalAgents).mockReturnValue({ state: withLab } as unknown as ReturnType<typeof useOptionalAgents>)
    const { moves } = bridges({ machines: [{ hostId: FORGE, name: 'forge', phase: 'connected' }, { hostId: LAB, name: 'lab', phase: 'connected' }],
      preview: { status: 'ok', confirmationId: CONFIRMATION, expiresAt: AT, machine: 'This computer', threads: [{ threadId: `host:${LAB}:shader`, outcome: 'moves', model: { name: 'GPT-5.5' } }] } })
    render(<MoveThreadsSheetHost />)
    act(() => { moveSheetStore.open({ kind: 'all' }) })
    const sheet = await screen.findByRole('dialog', { name: 'Move threads to which machine?' })
    await waitFor(() => expect(within(sheet).getAllByRole('button').map(button => button.textContent)).toEqual(['This computer', 'forge', 'lab', 'Cancel']))
    fireEvent.click(within(sheet).getByRole('button', { name: 'This computer' }))
    await waitFor(() => expect(moves.prepare).toHaveBeenCalledWith({ threadIds: [`host:${LAB}:shader`], hostId: LOCAL }))
    const confirm = await screen.findByRole('dialog', { name: 'Choose threads to move to This computer' })
    expect(within(confirm).getByText('lab')).toBeTruthy()
    // Watcher stays where it is already: nothing to say of it for a move here.
    expect(within(confirm).queryByText(/Watcher stays on This computer/u)).toBeNull()
    fireEvent.click(within(confirm).getByRole('checkbox', { name: 'Shader cache warmup' }))
    fireEvent.click(within(confirm).getByRole('button', { name: 'Move 1 thread' }))
    await waitFor(() => expect(moves.start).toHaveBeenCalledWith({ confirmationId: CONFIRMATION, threadIds: [`host:${LAB}:shader`], allowNarrower: [] }))
  })
  it('opens for a host’s thread from its More menu without its own machine, ticked as the thread it was opened for', async () => {
    vi.mocked(useOptionalAgents).mockReturnValue({ state: withLab } as unknown as ReturnType<typeof useOptionalAgents>)
    const { moves } = bridges({ machines: [{ hostId: LAB, name: 'lab', phase: 'connected' }],
      preview: { status: 'ok', confirmationId: CONFIRMATION, expiresAt: AT, machine: 'This computer', threads: [{ threadId: `host:${LAB}:shader`, outcome: 'moves', model: { name: 'GPT-5.5' } }] } })
    render(<MoveThreadsSheetHost />)
    act(() => { moveSheetStore.open({ kind: 'one', threadId: `host:${LAB}:shader`, title: 'Shader cache warmup', hostId: LAB }) })
    // Lab is where it is, so This computer is the only machine, and the sheet goes straight to it.
    const sheet = await screen.findByRole('dialog', { name: 'Move Shader cache warmup to This computer?' })
    expect(moves.prepare).toHaveBeenCalledWith({ threadIds: [`host:${LAB}:shader`], hostId: LOCAL })
    // Its box is ticked, as the thread the user pointed at; unticked, Move waits.
    const box = within(sheet).getByRole('checkbox', { name: 'Shader cache warmup' })
    expect(box).toHaveProperty('checked', true)
    fireEvent.click(box)
    expect(within(sheet).getByRole('button', { name: 'Move it to This computer' })).toHaveProperty('disabled', true)
    fireEvent.click(box)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move it to This computer' }))
    await waitFor(() => expect(moves.start).toHaveBeenCalledWith({ confirmationId: CONFIRMATION, threadIds: [`host:${LAB}:shader`], allowNarrower: [] }))
  })
})

describe('Watcher’s proposal from the user’s words (#1178 part 3)', () => {
  const PROPOSAL = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
  const threads: MoveCardThreads = {
    describe: target => ({ threadId: target.threadId, title: target.threadId === 'tray' ? 'Tray icon at night' : 'Linux tray menu spacing', providerId: 'codex', provider: 'Codex', project: 'Sotto' }),
    press: () => ({}),
  }
  const proposal = (over: Partial<ThreadMoveProposal> = {}): ThreadMoveProposal => ({ id: PROPOSAL, state: 'open', hostId: FORGE, machine: 'forge', threads: [
    { threadId: 'tray', outcome: 'moves', model: { name: 'GPT-5.5' }, source: { hostId: LOCAL, threadId: 'tray' }, ticked: true },
    { threadId: 'menu', outcome: 'asks', startsOn: 'Allow edits', words: 'It would start on Allow edits on forge.', source: { hostId: LOCAL, threadId: 'menu' }, ticked: true }], at: AT, updatedAt: AT, ...over })
  it('shows the preview with each thread Watcher named ticked, and moves only the threads still ticked on Move', async () => {
    const { moves } = bridges()
    render(<WatcherMoveProposals proposals={[proposal()]} threads={threads} />)
    expect(screen.getByText('Watcher proposes moving 2 threads to forge. Nothing moves until you press Move.')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Tray icon at night' })).toHaveProperty('checked', true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Linux tray menu spacing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move 1 thread' }))
    await waitFor(() => expect(moves.answer).toHaveBeenCalledWith({ proposalId: PROPOSAL, answer: 'move', threadIds: ['tray'] }))
  })
  it('keeps focus where it was when main shows the proposal again as it is now, its boxes as main sent them', () => {
    bridges()
    const { rerender } = render(<WatcherMoveProposals proposals={[proposal()]} threads={threads} />)
    const box = screen.getByRole('checkbox', { name: 'Linux tray menu spacing' })
    box.focus()
    rerender(<WatcherMoveProposals proposals={[proposal({ updatedAt: '2026-10-29T14:41:00.000Z', words: 'What these threads would do has changed.',
      threads: proposal().threads.map(item => ({ ...item, ticked: item.threadId === 'tray' })) })]} threads={threads} />)
    expect(document.activeElement).toBe(box)
    expect(box).toHaveProperty('checked', false)
    expect(screen.getByText('What these threads would do has changed.')).toBeTruthy()
  })
  it('ends on Not now, and says why when a press moved nothing', async () => {
    const { moves } = bridges()
    vi.mocked(moves.answer).mockResolvedValueOnce({ status: 'refused', message: 'What these threads would do has changed since this card showed it, so nothing was moved.' })
    const { rerender } = render(<WatcherMoveProposals proposals={[proposal()]} threads={threads} />)
    fireEvent.click(screen.getByRole('button', { name: 'Move 2 threads' }))
    expect((await screen.findByRole('alert')).textContent).toContain('nothing was moved')
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() => expect(moves.answer).toHaveBeenLastCalledWith({ proposalId: PROPOSAL, answer: 'dismiss' }))
    rerender(<WatcherMoveProposals proposals={[proposal({ state: 'dismissed', updatedAt: '2026-10-29T14:41:00.000Z' })]} threads={threads} />)
    expect(screen.getByText('You chose not to move these threads to forge. Nothing was moved.')).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
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

  it('names the host a thread moved from, and where it stays, for a move from another machine (part 3)', () => {
    bridges()
    const { rerender } = render(<WatcherMoveCards cards={[card({ state: 'asks', from: 'lab', startsOn: 'Allow edits', words: 'It would start on Allow edits on forge.' })]} threads={threads} />)
    const item = screen.getByRole('listitem')
    expect(item.textContent).toContain('lab→toforge')
    expect(screen.getByRole('button', { name: 'Keep it on lab' })).toBeTruthy()
    rerender(<WatcherMoveCards cards={[card({ state: 'source-settled', from: 'lab', here: true, machine: 'This computer', moved: { hostId: LOCAL, threadId: 'tray' } })]} threads={threads} />)
    expect(screen.getByRole('listitem').textContent).toContain('Settled on lab, and its worktree is kept there.')
    rerender(<WatcherMoveCards cards={[card({ state: 'given-back', from: 'lab', words: 'A turn is running. This thread stays on lab and takes sends again.' })]} threads={threads} />)
    expect(within(screen.getByRole('listitem')).getByText('Stays on lab')).toBeTruthy()
    // A move that waits on the host its thread is on names that host.
    rerender(<WatcherMoveCards cards={[card({ state: 'fenced', from: 'lab', waiting: true, waitingOn: 'lab' })]} threads={threads} />)
    expect(screen.getByText('Waiting for lab')).toBeTruthy()
  })

  it('offers Keep it here only while a move waits, asking first on the card when the new thread exists there (part 4)', async () => {
    const { moves } = bridges()
    const { rerender } = render(<WatcherMoveCards cards={[card({ state: 'thread-started' })]} threads={threads} />)
    expect(screen.queryByRole('button', { name: 'Keep it here' })).toBeNull()
    rerender(<WatcherMoveCards cards={[card({ state: 'thread-started', waiting: true, waitingOn: 'forge', moved: { hostId: FORGE, threadId: 'tray-there' } })]} threads={threads} />)
    const keep = screen.getByRole('button', { name: 'Keep it here' })
    fireEvent.click(keep)
    // The question takes focus on Cancel, and Cancel gives it back to Keep it here, with nothing sent.
    const question = screen.getByRole('group', { name: /Stop the new thread on forge and keep this one here\?/u })
    expect(question.textContent).toContain('Sotto stops it and settles it on forge, and this thread takes sends again once forge says so.')
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep it here' }))
    expect(moves.answer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep it here' }))
    // Escape anywhere in the question puts it away.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Stop it there and keep this one' }), { key: 'Escape' })
    expect(screen.queryByRole('group')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Keep it here' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop it there and keep this one' }))
    await waitFor(() => expect(moves.answer).toHaveBeenCalledWith({ moveId: CARD, answer: 'keep-here' }))
  })
  it('keeps a move with no thread there at one press, then says it waits to call the move off', async () => {
    const { moves } = bridges()
    const { rerender } = render(<WatcherMoveCards cards={[card({ state: 'branch-sent', waiting: true, waitingOn: 'forge' })]} threads={threads} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep it here' }))
    await waitFor(() => expect(moves.answer).toHaveBeenCalledWith({ moveId: CARD, answer: 'keep-here' }))
    rerender(<WatcherMoveCards cards={[card({ state: 'branch-sent', waiting: true, waitingOn: 'forge', keeping: true })]} threads={threads} />)
    expect(within(screen.getByRole('listitem')).getByText('Keeping it here')).toBeTruthy()
    expect(screen.getByRole('listitem').textContent).toContain('You chose to keep this thread here. Sotto asks forge to call the move off')
    expect(screen.queryByRole('button', { name: 'Keep it here' })).toBeNull()
    rerender(<WatcherMoveCards cards={[card({ state: 'kept', words: 'You kept this thread on This computer. Nothing was made on forge, and this thread takes sends again.' })]} threads={threads} />)
    expect(screen.getByRole('listitem').textContent).toContain('Nothing was made on forge')
  })
  it('says a move that waits on its machine lost nothing', () => {
    bridges()
    render(<WatcherMoveCards cards={[card({ state: 'branch-sent', waiting: true })]} threads={threads} />)
    expect(screen.getByText('Waiting for forge')).toBeTruthy()
    expect(screen.getByText('This thread is waiting for forge to answer about its move. Nothing was lost.')).toBeTruthy()
  })
})
