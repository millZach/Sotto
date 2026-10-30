// @vitest-environment node
// #1178 part 1, the host's side of a move, over a stand-in coordinator: a record that does not read refuses every move,
// the answers grant is read again as the thread is made and as its prompt goes (ADR-0004), and no move is forgotten.
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHandover } from '../../../src/main/agents/handover'
import type { ClientIdentity } from '../../../src/main/agents/hostService'
import { heldMoveWorktrees, HOST_THREAD_MOVES_MAX, HostThreadMoves, HostThreadMoveSources } from '../../../src/main/agents/threadMovesHost'
import { EMPTY_AGENT_HOST, type AgentCommand, type AgentModel, type AgentState, type AgentThread, type ThreadContinuedIn } from '../../../src/shared/agents'
import { HOST_THREAD_MOVE_WORDS, THREAD_MOVE_UNDECIDED, THREAD_MOVE_WORDS, type HostThreadMoveStart } from '../../../src/shared/threadMoves'

const model: AgentModel = { id: 'codex:gpt', provider: 'Codex', providerId: 'codex', name: 'GPT', ready: true, runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] }
const desktop: ClientIdentity = { clientId: 'laptop', user: 'Paired desktop', transport: 'socket' }
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-host-moves-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

/**
 * A host's coordinator: commands dispatch after `gate` opens, asking their guard as they go, as the real one does; a
 * guard that refuses leaves nothing made or sent.
 */
function host() {
  const threads: AgentThread[] = [], sent: string[] = [], stopped: string[] = []
  const state = { mayAnswer: true, gate: Promise.resolve() as Promise<void>, linkFails: 0, interruptFails: false }
  const control = {
    watcherSnapshot: () => ({ ...EMPTY_AGENT_HOST, models: [model], projects: [{ id: 'project', title: 'Sotto', path: '/forge/sotto' }], threads }),
    commandFromMove: async (command: Extract<AgentCommand, { type: 'create-thread' | 'manual-send' | 'interrupt' | 'settle-thread' }>, guard: () => void): Promise<AgentState> => {
      guard()
      await state.gate
      try { guard() } catch (error) { return { error: (error as Error).message } as AgentState }
      // Keep it here (part 4) stops and settles the thread a move made.
      if (command.type === 'interrupt') {
        stopped.push(command.threadId)
        if (state.interruptFails) return { error: 'The turn did not stop.' } as AgentState
        threads.find(item => item.id === command.threadId)!.status = 'idle'
        return { error: null } as AgentState
      }
      if (command.type === 'settle-thread') { threads.find(item => item.id === command.threadId)!.workspaceSettledAt = new Date().toISOString(); return { error: null } as AgentState }
      if (command.type === 'create-thread') {
        threads.push({ id: command.threadId!, projectId: command.projectId, title: command.title, modelId: command.modelId, status: 'idle', requests: [], messages: [],
          ...command.runtimeMode ? { runtimeMode: command.runtimeMode } : {} })
        return { error: null } as AgentState
      }
      sent.push(command.threadId)
      return { error: null, deliveries: [{ threadId: command.threadId, draftId: command.draftId, status: 'accepted' }] } as unknown as AgentState
    },
  }
  const workspace = { setContinuedFrom: async () => { if (state.linkFails > 0) { state.linkFails--; throw new Error('The record could not be saved.') } } }
  const moves = new HostThreadMoves(directory, { control, workspace, mayAnswer: () => state.mayAnswer })
  return { threads, sent, stopped, state, moves }
}
const request = (moveId = randomUUID(), runtimeMode: HostThreadMoveStart['runtimeMode'] = 'full-access'): HostThreadMoveStart => ({ action: 'start', moveId, projectId: 'project',
  title: 'WAV preview stall', modelId: model.id, runtimeMode, from: { threadId: 'source', provider: 'codex', hostId: randomUUID() }, prompt: 'The handover and the facts.',
  handover: { prefixLength: 27, prefixDigest: 'a'.repeat(64), counts: { total: 1, carried: 1, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: false } } })

describe('the host’s record of moves', () => {
  it('answers the same thread to the same move, and makes no second', async () => {
    const h = host(), ask = request()
    const first = await h.moves.handle(ask, desktop)
    expect(first).toMatchObject({ type: 'started', moveId: ask.moveId, runtimeMode: 'full-access', sent: true })
    expect(await h.moves.handle(ask, desktop)).toEqual(first)
    expect(h.threads).toHaveLength(1); expect(h.sent).toHaveLength(1)
  })
  it('refuses every move, without saying it made none, while its record does not read, and writes nothing', async () => {
    const path = join(directory, 'thread-moves.json')
    await writeFile(path, '{"version": 1, "moves": [{"moveId": 3}]}')
    const h = host()
    const answer = await h.moves.handle(request(), desktop)
    expect(answer).toEqual({ type: 'refused', reason: 'unreadable', message: HOST_THREAD_MOVE_WORDS.unreadable })
    // The desktop keeps such a move fenced rather than give it back.
    expect(THREAD_MOVE_UNDECIDED.has('unreadable')).toBe(true)
    expect(h.threads).toEqual([]); expect(await readFile(path, 'utf8')).toBe('{"version": 1, "moves": [{"moveId": 3}]}')
    // Once it reads again, moves start.
    await writeFile(path, JSON.stringify({ version: 1, moves: [] }))
    expect(await h.moves.handle(request(), desktop)).toMatchObject({ type: 'started' })
  })
  it('keeps every move it made a thread for, and refuses a new one past its limit rather than forget any', async () => {
    const at = new Date().toISOString()
    const kept = Array.from({ length: HOST_THREAD_MOVES_MAX }, () => ({ moveId: randomUUID(), clientId: 'laptop', threadId: randomUUID(), draftId: randomUUID(), digest: 'b'.repeat(64),
      sent: true, createdAt: at, updatedAt: at }))
    await writeFile(join(directory, 'thread-moves.json'), JSON.stringify({ version: 1, moves: kept }))
    const h = host()
    expect(await h.moves.handle(request(), desktop)).toEqual({ type: 'refused', reason: 'full', message: HOST_THREAD_MOVE_WORDS.full })
    expect(h.threads).toEqual([])
    const file = JSON.parse(await readFile(join(directory, 'thread-moves.json'), 'utf8')) as { moves: { moveId: string }[] }
    expect(file.moves.map(move => move.moveId)).toEqual(kept.map(move => move.moveId))
  })
})

describe('the new thread’s link back (ADR-0089: links are Sotto’s record)', () => {
  it('sends no first prompt until the link is saved, and fails the step for the desktop to ask again', async () => {
    const h = host(), ask = request()
    h.state.linkFails = 1
    await expect(h.moves.handle(ask, desktop)).rejects.toThrow('The record could not be saved.')
    expect(h.threads).toHaveLength(1); expect(h.sent).toEqual([])
    expect(await h.moves.handle(ask, desktop)).toMatchObject({ type: 'started', threadId: h.threads[0]!.id, sent: true })
    expect(h.threads).toHaveLength(1); expect(h.sent).toHaveLength(1)
  })
})

describe('the answers grant, read as each command dispatches (ADR-0004)', () => {
  it('refuses a start that would act without asking once the grant is taken away while it waits, and makes nothing', async () => {
    const h = host()
    let open!: () => void
    h.state.gate = new Promise(done => { open = done })
    const asked = h.moves.handle(request(), desktop)
    await new Promise(done => setTimeout(done, 10))
    h.state.mayAnswer = false; open()
    expect(await asked).toEqual({ type: 'refused', reason: 'failed', message: HOST_THREAD_MOVE_WORDS.grantGone })
    expect(h.threads).toEqual([]); expect(h.sent).toEqual([])
    // Asked again, the move starts held to Ask for approval, as the grant now allows.
    h.state.gate = Promise.resolve()
    expect(await h.moves.handle(request(), desktop)).toMatchObject({ type: 'started', runtimeMode: 'approval-required', sent: true })
  })
  it('sends no first prompt to a thread made wide once the grant is gone, and says so', async () => {
    const h = host(), ask = request()
    let open!: () => void
    // The thread is made while the grant holds; it is taken away before the prompt dispatches.
    const control = (h.moves as unknown as { options: { control: { commandFromMove: (command: AgentCommand, guard: () => void) => Promise<AgentState> } } }).options.control
    const make = control.commandFromMove
    control.commandFromMove = async (command, guard) => {
      if (command.type === 'manual-send') { h.state.gate = new Promise(done => { open = done }); setTimeout(() => { h.state.mayAnswer = false; open() }, 10) }
      return make(command, guard)
    }
    expect(await h.moves.handle(ask, desktop)).toMatchObject({ type: 'started', sent: false, message: HOST_THREAD_MOVE_WORDS.grantGone })
    expect(h.threads).toHaveLength(1); expect(h.sent).toEqual([])
  })
})

/**
 * #1178 part 3: this host's own thread as a move's source. The host says whether it can move by its own record, fences it
 * under the move's ID, gives its handover, and links and settles it, or lets go of it; each step asked again answers the same.
 */
function sources() {
  const threads: AgentThread[] = [
    { id: 'wav', projectId: 'project', title: 'WAV preview stall', modelId: model.id, providerId: 'codex', status: 'idle', requests: [],
      messages: [{ id: 'm1', role: 'user', text: 'Find out why the preview stalls.', createdAt: '2026-10-29T10:00:00.000Z' },
        { id: 'm2', role: 'assistant', text: 'The length marker was written once.', createdAt: '2026-10-29T10:01:00.000Z' }] },
    { id: 'busy', projectId: 'project', title: 'Busy', modelId: model.id, providerId: 'codex', status: 'running', requests: [], messages: [{ id: 'b1', role: 'user', text: 'Go.', createdAt: '2026-10-29T10:00:00.000Z' }] },
  ]
  const fences = new Map<string, string>(), settled: string[] = [], links: { threadId: string; link: ThreadContinuedIn }[] = []
  const state = { held: null as string | null, fenceFails: false }
  const control = {
    watcherSnapshot: () => ({ ...EMPTY_AGENT_HOST, models: [model], threads }),
    moveHoldReason: (threadId: string) => state.held === threadId ? { kind: 'queued' } as never : null,
    fenceForMove: (threadId: string, words: string) => {
      fences.set(threadId, words)
      return state.fenceFails ? Promise.reject(new Error('The coordinator could not save its record.')) : undefined
    },
    liftMoveFence: (threadId: string) => { fences.delete(threadId) },
    moveFenceOf: (threadId: string) => fences.get(threadId),
    fencedForMove: () => [...fences.keys()],
    commandFromMove: async (command: Extract<AgentCommand, { type: 'settle-thread' }>): Promise<AgentState> => {
      settled.push(command.threadId)
      threads.find(thread => thread.id === command.threadId)!.workspaceSettledAt = new Date().toISOString()
      return { error: null } as AgentState
    },
  }
  const workspace = {
    threadHandover: (threadId: string) => { const thread = threads.find(item => item.id === threadId)!; return buildHandover(thread.messages, { source: { threadId, title: thread.title, provider: 'codex' }, historyKept: true }) },
    addContinuedIn: async (threadId: string, link: ThreadContinuedIn) => { links.push({ threadId, link }) },
  }
  const held = new HostThreadMoveSources(directory, { control, workspace })
  const moves = new HostThreadMoves(directory, { control: { watcherSnapshot: control.watcherSnapshot, commandFromMove: async () => ({ error: null }) as AgentState },
    workspace: { setContinuedFrom: async () => undefined }, mayAnswer: () => true, sources: held })
  return { threads, fences, settled, links, state, moves, held }
}
const link = { threadId: 'new-thread', provider: 'codex' as const, hostId: randomUUID(), at: '2026-10-29T11:00:00.000Z' }

describe('this host’s own thread as a move’s source (#1178 part 3)', () => {
  it('holds and fences a thread that can move, answers the same when asked again, and refuses a second move of it', async () => {
    const s = sources(), moveId = randomUUID()
    expect(s.moves.holdsSources).toBe(true)
    expect(await s.moves.handle({ action: 'hold', moveId, threadId: 'wav', machine: 'This computer' }, desktop)).toEqual({ type: 'held', moveId })
    expect(s.fences.get('wav')).toBe(THREAD_MOVE_WORDS.fence('This computer'))
    expect(await s.moves.handle({ action: 'hold', moveId, threadId: 'wav', machine: 'This computer' }, desktop)).toEqual({ type: 'held', moveId })
    expect(await s.moves.handle({ action: 'hold', moveId: randomUUID(), threadId: 'wav', machine: 'studio' }, desktop))
      .toEqual({ type: 'refused', reason: 'not-movable', message: THREAD_MOVE_WORDS.moving('This computer') })
    // Another desktop cannot step this move.
    expect(await s.moves.handle({ action: 'release', moveId }, { ...desktop, clientId: 'other' })).toMatchObject({ type: 'refused', reason: 'move-differs' })
    expect(JSON.parse(await readFile(join(directory, 'thread-moves-held.json'), 'utf8'))).toMatchObject({ version: 1, held: [{ moveId, clientId: 'laptop', threadId: 'wav', state: 'held' }] })
  })
  it('refuses a thread that cannot move in its own words, and fences nothing', async () => {
    const s = sources()
    expect(await s.moves.handle({ action: 'hold', moveId: randomUUID(), threadId: 'busy', machine: 'forge' }, desktop))
      .toEqual({ type: 'refused', reason: 'not-movable', message: THREAD_MOVE_WORDS.running })
    s.state.held = 'wav'
    expect(await s.moves.handle({ action: 'hold', moveId: randomUUID(), threadId: 'wav', machine: 'forge' }, desktop))
      .toEqual({ type: 'refused', reason: 'not-movable', message: THREAD_MOVE_WORDS.unresolved })
    expect(await s.moves.handle({ action: 'hold', moveId: randomUUID(), threadId: 'gone', machine: 'forge' }, desktop))
      .toEqual({ type: 'refused', reason: 'not-movable', message: THREAD_MOVE_WORDS.gone })
    expect(s.fences.size).toBe(0)
  })
  it('gives the held thread’s handover, then links and settles it once, and lets go of its fence', async () => {
    const s = sources(), moveId = randomUUID()
    expect(await s.moves.handle({ action: 'handover', moveId }, desktop)).toMatchObject({ type: 'refused', reason: 'unknown-move' })
    await s.moves.handle({ action: 'hold', moveId, threadId: 'wav', machine: 'forge' }, desktop)
    const handover = await s.moves.handle({ action: 'handover', moveId }, desktop)
    expect(handover).toMatchObject({ type: 'handover', moveId, counts: { total: 2 } })
    expect((handover as { text: string }).text).toContain('Find out why the preview stalls.')
    expect(await s.moves.handle({ action: 'settle', moveId, link }, desktop)).toEqual({ type: 'done', moveId })
    expect(await s.moves.handle({ action: 'settle', moveId, link }, desktop)).toEqual({ type: 'done', moveId })
    expect(s.links).toEqual([{ threadId: 'wav', link: { threadId: 'new-thread', provider: 'codex', at: link.at, host: link.hostId } }])
    expect(s.settled).toEqual(['wav']); expect(s.fences.size).toBe(0)
  })
  it('lets go of a thread that stays, linking it to the new thread when one was made', async () => {
    const s = sources(), moveId = randomUUID()
    await s.moves.handle({ action: 'hold', moveId, threadId: 'wav', machine: 'forge' }, desktop)
    expect(await s.moves.handle({ action: 'release', moveId, link }, desktop)).toEqual({ type: 'done', moveId })
    expect(await s.moves.handle({ action: 'release', moveId }, desktop)).toEqual({ type: 'done', moveId })
    expect(s.links).toHaveLength(1); expect(s.settled).toEqual([]); expect(s.fences.size).toBe(0)
    // A released move holds nothing: it is not held again under the same ID.
    expect(await s.moves.handle({ action: 'hold', moveId, threadId: 'wav', machine: 'forge' }, desktop)).toMatchObject({ type: 'refused', reason: 'unknown-move' })
  })
  it('keeps the worktree of a thread held or moved away from cleanup, and of every thread until its record reads', async () => {
    const s = sources(), moved = randomUUID(), stays = randomUUID()
    expect(s.held.keepsWorktree('wav')).toBe(true)
    await s.held.start()
    expect(s.held.keepsWorktree('wav')).toBe(false)
    await s.moves.handle({ action: 'hold', moveId: moved, threadId: 'wav', machine: 'forge' }, desktop)
    expect(s.held.keepsWorktree('wav')).toBe(true)
    await s.moves.handle({ action: 'settle', moveId: moved, link }, desktop)
    expect(s.held.keepsWorktree('wav')).toBe(true)
    // One that stays here is no moved thread.
    s.threads.push({ ...s.threads[0]!, id: 'tray', workspaceSettledAt: undefined })
    await s.moves.handle({ action: 'hold', moveId: stays, threadId: 'tray', machine: 'forge' }, desktop)
    await s.moves.handle({ action: 'release', moveId: stays }, desktop)
    expect(s.held.keepsWorktree('tray')).toBe(false)
    // A deleted thread keeps nothing, and that is saved.
    s.held.forgetThreads(['wav'])
    expect(s.held.keepsWorktree('wav')).toBe(false)
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(directory, 'thread-moves-held.json'), 'utf8')).kept).toEqual([]))
  })
  it('makes the fences agree with the held moves at start: a held thread fenced, and a fence no move names lifted', async () => {
    const at = new Date().toISOString()
    await writeFile(join(directory, 'thread-moves-held.json'), JSON.stringify({ version: 1, held: [{ moveId: randomUUID(), clientId: 'laptop', threadId: 'wav', machine: 'forge', state: 'held', createdAt: at, updatedAt: at }] }))
    const s = sources()
    // A stop after the fence was saved and before its move was: the fence names no move.
    s.fences.set('busy', THREAD_MOVE_WORDS.fence('forge'))
    await s.held.start()
    expect([...s.fences.keys()]).toEqual(['wav'])
    expect(s.fences.get('wav')).toBe(THREAD_MOVE_WORDS.fence('forge'))
    expect(s.held.keepsWorktree('wav')).toBe(true)
  })
  it('lets go of a hold whose fence could not be saved, holding nothing and fencing nothing', async () => {
    const s = sources(), moveId = randomUUID()
    await s.held.start()
    s.state.fenceFails = true
    await expect(s.moves.handle({ action: 'hold', moveId, threadId: 'wav', machine: 'forge' }, desktop)).rejects.toThrow('could not save')
    expect(s.fences.size).toBe(0); expect(s.held.keepsWorktree('wav')).toBe(false)
    expect(JSON.parse(await readFile(join(directory, 'thread-moves-held.json'), 'utf8')).held).toEqual([])
  })
  it('keeps the worktrees its record names while it does not move threads, and every one while that record does not read', async () => {
    expect((await heldMoveWorktrees(directory))('wav')).toBe(false)
    const at = new Date().toISOString()
    await writeFile(join(directory, 'thread-moves-held.json'), JSON.stringify({ version: 1, held: [{ moveId: randomUUID(), clientId: 'laptop', threadId: 'wav', machine: 'forge', state: 'held', createdAt: at, updatedAt: at }], kept: ['tray'] }))
    const kept = await heldMoveWorktrees(directory)
    expect([kept('wav'), kept('tray'), kept('other')]).toEqual([true, true, false])
    await writeFile(join(directory, 'thread-moves-held.json'), '{"version": 1, "held": [{"moveId": 3}]}')
    expect((await heldMoveWorktrees(directory))('other')).toBe(true)
  })
  it('refuses every step, fencing and lifting nothing, while its record does not read', async () => {
    await writeFile(join(directory, 'thread-moves-held.json'), '{"version": 1, "held": [{"moveId": 3}]}')
    const s = sources()
    s.fences.set('busy', THREAD_MOVE_WORDS.fence('forge'))
    await s.held.start()
    expect(await s.moves.handle({ action: 'hold', moveId: randomUUID(), threadId: 'wav', machine: 'forge' }, desktop))
      .toEqual({ type: 'refused', reason: 'unreadable', message: HOST_THREAD_MOVE_WORDS.unreadable })
    expect([...s.fences.keys()]).toEqual(['busy'])
    expect(s.held.keepsWorktree('anything')).toBe(true)
  })
})

describe('calling a move off here with Keep it here (#1178 part 4)', () => {
  it('fences a move never started here, so a late start makes nothing', async () => {
    const h = host(), ask = request()
    expect(await h.moves.handle({ action: 'keep', moveId: ask.moveId }, desktop)).toEqual({ type: 'kept', moveId: ask.moveId, made: false })
    expect(await h.moves.handle(ask, desktop)).toEqual({ type: 'refused', reason: 'kept', message: HOST_THREAD_MOVE_WORDS.kept })
    expect(h.threads).toEqual([]); expect(h.sent).toEqual([])
    // Asked again, the same answer; another desktop cannot call it off.
    expect(await h.moves.handle({ action: 'keep', moveId: ask.moveId }, desktop)).toEqual({ type: 'kept', moveId: ask.moveId, made: false })
    expect(await h.moves.handle({ action: 'keep', moveId: ask.moveId }, { ...desktop, clientId: 'other' })).toMatchObject({ type: 'refused', reason: 'move-differs' })
  })
  it('stops and settles the thread a move made, and sends it nothing more', async () => {
    const h = host(), ask = request()
    const started = await h.moves.handle(ask, desktop) as { threadId: string }
    h.threads.find(thread => thread.id === started.threadId)!.status = 'running'
    expect(await h.moves.handle({ action: 'keep', moveId: ask.moveId }, desktop)).toEqual({ type: 'kept', moveId: ask.moveId, made: true })
    expect(h.stopped).toEqual([started.threadId])
    expect(h.threads.find(thread => thread.id === started.threadId)?.workspaceSettledAt).toEqual(expect.any(String))
    expect(await h.moves.handle(ask, desktop)).toMatchObject({ type: 'refused', reason: 'kept' })
    expect(h.sent).toHaveLength(1)
    expect(JSON.parse(await readFile(join(directory, 'thread-moves.json'), 'utf8')).moves[0]).toMatchObject({ moveId: ask.moveId, kept: true })
  })
  it('says nothing is kept while the thread it made is still running, and settles nothing until it stops', async () => {
    const h = host(), ask = request()
    const started = await h.moves.handle(ask, desktop) as { threadId: string }
    h.threads.find(thread => thread.id === started.threadId)!.status = 'running'
    h.state.interruptFails = true
    await expect(h.moves.handle({ action: 'keep', moveId: ask.moveId }, desktop)).rejects.toThrow('has not stopped yet')
    expect(h.threads.find(thread => thread.id === started.threadId)?.workspaceSettledAt).toBeUndefined()
    // Its start is refused already, and once the turn stops, the next ask keeps it.
    expect(await h.moves.handle(ask, desktop)).toMatchObject({ type: 'refused', reason: 'kept' })
    h.state.interruptFails = false
    expect(await h.moves.handle({ action: 'keep', moveId: ask.moveId }, desktop)).toEqual({ type: 'kept', moveId: ask.moveId, made: true })
  })
})
