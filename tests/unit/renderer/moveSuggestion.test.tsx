// #1309 (Zach's picks of October 30, 2026): a move suggestion under the machines line, from the readings the line already
// takes, naming one thread at a clean point, with Move, Choose threads… and Not now until the machine reads fine again.
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import type { MachineEntry, MachineProblem } from '../../../src/shared/machineLine'
import type { ThreadMovePrepare, ThreadMovesBridge } from '../../../src/shared/threadMoves'
import { moveSheetStore } from '../../../src/renderer/src/watcher/MoveThreads'
import { WatcherMoveSuggestion } from '../../../src/renderer/src/watcher/MoveSuggestion'
import { moveSuggestionNotNow, moveSuggestionPlan } from '../../../src/renderer/src/watcher/moveSuggestionPlan'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { useWatcherRoom } from '../../../src/renderer/src/watcher/watcherRoom'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))
vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/watcher/watcherRoom', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/watcher/watcherRoom')>(), useWatcherRoom: vi.fn() }))

const LOCAL = '7d1c8a52-5f0a-4d55-9a38-1f9b7a2a0c11', FORGE = '0b7f4c1e-2a9d-4f61-8c3e-5d2b9a7e4f10', STUDIO = 'c5e2a1f8-9b3d-4e72-a6c1-3f8d2b5e9a07'
const CONFIRMATION = '07b51f0b-ed75-4abb-aea3-a014fceef088'
const NOW = Date.parse('2026-10-30T20:00:00.000Z')
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()

function thread(id: string, title: string, over: Partial<AgentThread> = {}): AgentThread {
  return { id, title, providerId: 'codex', projectId: 'sotto', status: 'idle', requests: [], messages: [], remoteHost: true, hostId: FORGE, ...over } as AgentThread
}
function entry(hostId: string, name: string, options: { problems?: MachineProblem[]; headroom?: number | null; observedAt?: string; thisComputer?: boolean; connected?: boolean } = {}): MachineEntry {
  const connected = options.connected ?? true
  return { hostId, name, thisComputer: options.thisComputer ?? false, connected, working: 0, starting: 0, problems: options.problems ?? [], isDefault: false,
    machine: { hostId, name, thisComputer: options.thisComputer ?? false, connected, headroom: options.headroom === undefined ? 4 : options.headroom,
      load: { observedAt: options.observedAt ?? ago(0) } } as unknown as MachineEntry['machine'] }
}
const here = (options: Parameters<typeof entry>[2] = {}) => entry(LOCAL, 'This computer', { thisComputer: true, ...options })
const forgeShort = (observedAt = ago(0)) => entry(FORGE, 'forge', { problems: ['short'], headroom: 0, observedAt })
const THREADS = [thread('tray', 'Tray icon at night', { updatedAt: ago(4) }), thread('menu', 'Linux tray menu spacing', { updatedAt: ago(1) }),
  thread('wav', 'Streaming WAV stall', { status: 'running', updatedAt: ago(0) }), thread('local', 'Here already', { remoteHost: false, hostId: LOCAL, updatedAt: ago(0) }),
  thread('kid', 'Delegated', { delegatedBy: 'tray' }), thread('watcher', 'Watcher', { kind: 'watcher' })]

function bridge(preview?: (ids: readonly string[]) => ThreadMovePrepare) {
  const outcome = (id: string) => id === 'menu' ? 'stays' as const : 'moves' as const
  const moves: ThreadMovesBridge = {
    prepare: vi.fn(async ({ threadIds }) => preview?.(threadIds) ?? { status: 'ok' as const, confirmationId: CONFIRMATION, expiresAt: ago(-1), machine: 'This computer',
      threads: threadIds.map((threadId: string) => ({ threadId, outcome: outcome(threadId), ...outcome(threadId) === 'stays' ? { words: 'It has uncommitted work. Commit or stash it, then move it.' } : {} })) }),
    start: vi.fn(async () => ({ status: 'ok' as const, moves: [] })),
    read: vi.fn(async () => ({ cards: [] })),
    answer: vi.fn(async () => ({ status: 'ok' as const })),
    onChanged: vi.fn(() => () => undefined),
  }
  ;(window as unknown as { sotto: unknown }).sotto = { threadMoves: moves }
  return moves
}

beforeEach(() => {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { 'cross-machine-work': true, watcher: true } } } as unknown as ReturnType<typeof useOptionalApp>)
  vi.mocked(useOptionalAgents).mockReturnValue({ state: { hostId: LOCAL, host: { hostId: LOCAL, threads: THREADS, projects: [] } } as unknown as AgentState } as ReturnType<typeof useOptionalAgents>)
  vi.mocked(useWatcherRoom).mockReturnValue({ state: { current: { createdAt: ago(60) } } } as unknown as ReturnType<typeof useWatcherRoom>)
})
afterEach(() => {
  cleanup(); vi.clearAllMocks(); moveSuggestionNotNow.clear(); moveSheetStore.close()
  delete (window as unknown as { sotto?: unknown }).sotto
})

describe('which machine, which machine with room and which threads', () => {
  it('asks about the short or busy machine’s threads at a clean point, most recently worked first, for the machine with the most headroom', () => {
    const plan = moveSuggestionPlan([here({ headroom: 2 }), forgeShort(), entry(STUDIO, 'studio', { headroom: 5 })], THREADS, new Set())
    expect(plan).toMatchObject({ from: { hostId: FORGE }, problems: ['short'], to: { hostId: STUDIO } })
    // Running, delegated, Watcher's own and This computer's threads are not asked about.
    expect(plan!.candidates).toEqual(['menu', 'tray'])
    // This computer first among equals.
    expect(moveSuggestionPlan([entry(STUDIO, 'studio', { headroom: 2 }), here({ headroom: 2 }), forgeShort()], THREADS, new Set())!.to.hostId).toBe(LOCAL)
  })

  it('suggests nothing without a machine with known headroom, while nothing is short or busy, or for a machine passed over', () => {
    expect(moveSuggestionPlan([here({ headroom: null }), forgeShort()], THREADS, new Set())).toBeNull()
    expect(moveSuggestionPlan([here({ headroom: 0 }), forgeShort()], THREADS, new Set())).toBeNull()
    expect(moveSuggestionPlan([here({ problems: ['busy'] }), forgeShort()], THREADS, new Set())).toBeNull()
    expect(moveSuggestionPlan([here(), entry(FORGE, 'forge', { problems: ['over', 'unknown'] })], THREADS, new Set())).toBeNull()
    expect(moveSuggestionPlan([here(), forgeShort()], THREADS, new Set([FORGE]))).toBeNull()
    expect(moveSuggestionPlan([here(), forgeShort()], THREADS.filter(item => item.id === 'wav'), new Set())).toBeNull()
  })

  it('forgets Not now only once the machine reads fine, not while its load reads unknown', () => {
    moveSuggestionNotNow.add(FORGE)
    moveSuggestionNotNow.settle([here(), entry(FORGE, 'forge', { problems: ['unknown'] })])
    expect(moveSuggestionNotNow.get().has(FORGE)).toBe(true)
    moveSuggestionNotNow.settle([here(), forgeShort()])
    expect(moveSuggestionNotNow.get().has(FORGE)).toBe(true)
    moveSuggestionNotNow.settle([here(), entry(FORGE, 'forge')])
    expect(moveSuggestionNotNow.get().has(FORGE)).toBe(false)
  })
})

describe('the line under the machines line', () => {
  it('names the thread main says moves now, once a reading, and moves it with one press', async () => {
    const moves = bridge()
    const entries = [here(), forgeShort()]
    const { rerender } = render(<WatcherMoveSuggestion entries={entries} threads={THREADS} now={NOW} />)
    // menu worked last but stays, so tray is named.
    const line = await screen.findByRole('group', { name: /forge is short on memory, and This computer has room\. Move Tray icon at night there\?/u })
    expect(line.textContent).toContain('It last worked 4 min. ago and is between turns.')
    expect(moves.prepare).toHaveBeenCalledTimes(1)
    expect(moves.prepare).toHaveBeenCalledWith({ threadIds: ['menu', 'tray'], hostId: LOCAL })
    // A thread's update under the same reading never asks again.
    rerender(<WatcherMoveSuggestion entries={entries} threads={THREADS.map(item => item.id === 'menu' ? { ...item, updatedAt: ago(0) } : item)} now={NOW} />)
    await act(async () => { await Promise.resolve() })
    expect(moves.prepare).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Move to This computer' }))
    await waitFor(() => expect(moves.start).toHaveBeenCalledWith({ confirmationId: CONFIRMATION, threadIds: ['tray'], allowNarrower: [] }))
    // A fresh preview for that thread alone, then the line is gone until the next reading.
    expect(moves.prepare).toHaveBeenLastCalledWith({ threadIds: ['tray'], hostId: LOCAL })
    await waitFor(() => expect(screen.queryByRole('group')).toBeNull())
    rerender(<WatcherMoveSuggestion entries={[here(), forgeShort(ago(-1))]} threads={THREADS} now={NOW} />)
    expect(await screen.findByRole('group')).toBeTruthy()
    expect(moves.prepare).toHaveBeenCalledTimes(3)
  })

  it('says nothing when no thread there would move now, or once the named one starts a turn', async () => {
    bridge(ids => ({ status: 'ok', confirmationId: CONFIRMATION, expiresAt: ago(-1), machine: 'This computer', threads: ids.map(threadId => ({ threadId, outcome: 'stays' as const, words: 'A turn is running.' })) }))
    render(<WatcherMoveSuggestion entries={[here(), forgeShort()]} threads={THREADS} now={NOW} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByRole('group')).toBeNull()
    cleanup()
    bridge()
    const { rerender } = render(<WatcherMoveSuggestion entries={[here(), forgeShort()]} threads={THREADS} now={NOW} />)
    await screen.findByRole('group')
    rerender(<WatcherMoveSuggestion entries={[here(), forgeShort()]} threads={THREADS.map(item => item.id === 'tray' ? { ...item, status: 'running' } as AgentThread : item)} now={NOW} />)
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('opens the sheet for a thread that would start narrower, and the sheet at the machine with room for Choose threads…', async () => {
    const moves = bridge()
    render(<WatcherMoveSuggestion entries={[here(), forgeShort()]} threads={THREADS} now={NOW} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Choose threads to move to This computer' }))
    expect(moveSheetStore.get()).toEqual({ kind: 'all', hostId: LOCAL })
    moveSheetStore.close()
    vi.mocked(moves.prepare).mockResolvedValueOnce({ status: 'ok', confirmationId: CONFIRMATION, expiresAt: ago(-1), machine: 'This computer',
      threads: [{ threadId: 'tray', outcome: 'asks', words: 'It would start on Allow edits here.' }] })
    fireEvent.click(screen.getByRole('button', { name: 'Move to This computer' }))
    await waitFor(() => expect(moveSheetStore.get()).toEqual({ kind: 'one', threadId: 'tray', title: 'Tray icon at night', hostId: FORGE }))
    expect(moves.start).not.toHaveBeenCalled()
  })

  it('says why a press moved nothing, and Not now passes the machine over until it reads fine', async () => {
    const moves = bridge()
    const { rerender } = render(<WatcherMoveSuggestion entries={[here(), forgeShort()]} threads={THREADS} now={NOW} />)
    vi.mocked(moves.start).mockResolvedValueOnce({ status: 'refused', message: 'This thread is moving already. Nothing more was moved.' })
    fireEvent.click(await screen.findByRole('button', { name: 'Move to This computer' }))
    expect((await screen.findByRole('alert')).textContent).toBe('This thread is moving already. Nothing more was moved.')
    fireEvent.click(screen.getByRole('button', { name: 'Not now, until forge reads fine again' }))
    expect(screen.queryByRole('group')).toBeNull()
    rerender(<WatcherMoveSuggestion entries={[here(), forgeShort(ago(-1))]} threads={THREADS} now={NOW} />)
    expect(screen.queryByRole('group')).toBeNull()
    rerender(<WatcherMoveSuggestion entries={[here(), entry(FORGE, 'forge', { observedAt: ago(-2) })]} threads={THREADS} now={NOW} />)
    rerender(<WatcherMoveSuggestion entries={[here(), forgeShort(ago(-3))]} threads={THREADS} now={NOW} />)
    expect(await screen.findByRole('group')).toBeTruthy()
  })
})
