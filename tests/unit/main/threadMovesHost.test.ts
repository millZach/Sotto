// @vitest-environment node
// #1178 part 1, the host's side of a move, over a stand-in coordinator: a record that does not read refuses every move,
// the answers grant is read again as the thread is made and as its prompt goes (ADR-0004), and no move is forgotten.
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientIdentity } from '../../../src/main/agents/hostService'
import { HOST_THREAD_MOVES_MAX, HostThreadMoves } from '../../../src/main/agents/threadMovesHost'
import { EMPTY_AGENT_HOST, type AgentCommand, type AgentModel, type AgentState, type AgentThread } from '../../../src/shared/agents'
import { HOST_THREAD_MOVE_WORDS, THREAD_MOVE_UNDECIDED, type HostThreadMoveRequest } from '../../../src/shared/threadMoves'

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
  const threads: AgentThread[] = [], sent: string[] = []
  const state = { mayAnswer: true, gate: Promise.resolve() as Promise<void> }
  const control = {
    watcherSnapshot: () => ({ ...EMPTY_AGENT_HOST, models: [model], projects: [{ id: 'project', title: 'Sotto', path: '/forge/sotto' }], threads }),
    commandFromMove: async (command: Extract<AgentCommand, { type: 'create-thread' | 'manual-send' }>, guard: () => void): Promise<AgentState> => {
      guard()
      await state.gate
      try { guard() } catch (error) { return { error: (error as Error).message } as AgentState }
      if (command.type === 'create-thread') {
        threads.push({ id: command.threadId!, projectId: command.projectId, title: command.title, modelId: command.modelId, status: 'idle', requests: [], messages: [],
          ...command.runtimeMode ? { runtimeMode: command.runtimeMode } : {} })
        return { error: null } as AgentState
      }
      sent.push(command.threadId)
      return { error: null, deliveries: [{ threadId: command.threadId, draftId: command.draftId, status: 'accepted' }] } as unknown as AgentState
    },
  }
  const moves = new HostThreadMoves(directory, { control, workspace: { setContinuedFrom: async () => undefined }, mayAnswer: () => state.mayAnswer })
  return { threads, sent, state, moves }
}
const request = (moveId = randomUUID(), runtimeMode: HostThreadMoveRequest['runtimeMode'] = 'full-access'): HostThreadMoveRequest => ({ action: 'start', moveId, projectId: 'project',
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
