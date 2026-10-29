// @vitest-environment node
// #1178 part 1: the move record's states, the fence, and the prepare and confirm pair, over stand-ins for the coordinator,
// the branch mover and the machine a thread moves to. tests/integration/threadMoves.test.ts moves one over a real host.
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHandover } from '../../../src/main/agents/handover'
import { firstTurnEnded, ThreadMoveService, type MoveControl, type MoveRecord, type MoveTargets } from '../../../src/main/agents/threadMoves'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentModel, type AgentState, type AgentThread, type ThreadContinuedIn } from '../../../src/shared/agents'
import { branchMoveRefusal, branchMoveWords, type BranchMoveReceipt } from '../../../src/shared/branchMoves'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { MOVE_HANDOVER_CLOSE, THREAD_MOVE_WORDS, type HostThreadMoveRequest, type ThreadMovePrepare, type ThreadMoveStart } from '../../../src/shared/threadMoves'

const HERE = randomUUID(), FORGE = randomUUID(), COMMIT = 'c'.repeat(40)
const model: AgentModel = { id: 'codex:gpt', provider: 'Codex', providerId: 'codex', name: 'GPT', ready: true, reasoningEfforts: ['low', 'high'],
  runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] }
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-moves-')) })
afterEach(async () => { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }) })

function source(id: string, patch: Partial<AgentThread> = {}): AgentThread {
  return { id, title: `Thread ${id}`, titleSource: 'user', projectId: 'project', modelId: model.id, providerId: 'codex', status: 'idle', requests: [], runtimeMode: 'auto-accept-edits',
    reasoningEffort: 'high', messages: [{ id: `${id}-1`, role: 'user', text: 'Find out why the preview stalls.', createdAt: '2026-10-29T10:00:00.000Z' },
      { id: `${id}-2`, role: 'assistant', text: 'The length marker was written once.', createdAt: '2026-10-29T10:01:00.000Z' }],
    pullRequests: [{ number: 12, url: 'https://github.com/millZach/Sotto/pull/12', title: 'Fix the stall', state: 'open', draft: false, source: 'created', linkedAt: '2026-10-29T10:02:00.000Z' }],
    ...patch }
}

/** This computer, the machine the threads move to, and the move service between them, over one data folder. */
function world() {
  const threads: AgentThread[] = [source('a'), source('b'), source('busy', { status: 'running' }), source('child', { delegatedBy: 'a' })]
  const fences = new Map<string, string>(), settled: string[] = [], links: { threadId: string; link: ThreadContinuedIn }[] = [], forgotten: string[] = []
  const control: MoveControl = {
    hostId: () => HERE, watcherSnapshot: () => ({ ...EMPTY_AGENT_HOST, hostId: HERE, models: [model], threads }),
    configuration: () => ({ newThreadRuntimeMode: 'full-access' }), moveHoldReason: () => null,
    fenceForMove: (threadId, words) => { fences.set(threadId, words) }, liftMoveFence: threadId => { fences.delete(threadId) },
    commandFromMove: async command => {
      settled.push(command.threadId)
      const thread = threads.find(item => item.id === command.threadId)
      if (thread) thread.workspaceSettledAt = new Date().toISOString()
      return { error: null } as AgentState
    },
  }
  const workspace = {
    threadHandover: (threadId: string) => { const thread = threads.find(item => item.id === threadId)!; return buildHandover(thread.messages, { source: { threadId, title: thread.title, provider: 'codex' }, historyKept: true }) },
    addContinuedIn: async (threadId: string, link: ThreadContinuedIn) => { links.push({ threadId, link }) },
  }
  const branches = {
    receipt: undefined as BranchMoveReceipt | undefined,
    calls: [] as string[],
    forStart: vi.fn(async (input: { readonly moveId: string }): Promise<BranchMoveReceipt> => {
      branches.calls.push(input.moveId)
      return branches.receipt ?? { type: 'moved', moveId: input.moveId, branch: 'feat/wav', commit: COMMIT, ref: `refs/sotto/incoming/${input.moveId}/feat/wav` }
    }),
    forget: vi.fn(async (input: { readonly moveId: string }) => { forgotten.push(input.moveId) }),
  }
  // The machine: it makes one thread per move, and answers the same one when asked again.
  const remote = { connected: true, mayAnswer: true, supports: true, threads: [] as AgentThread[], made: new Map<string, string>(), requests: [] as HostThreadMoveRequest[],
    fail: undefined as Error | undefined, answer: undefined as unknown, listeners: new Set<(hostId?: string) => void>() }
  const host = {
    get supportsThreadMove() { return remote.supports },
    threadMove: vi.fn(async (request: HostThreadMoveRequest) => {
      remote.requests.push(request)
      if (remote.fail) throw remote.fail
      if (remote.answer !== undefined) return remote.answer
      let threadId = remote.made.get(request.moveId)
      if (!threadId) {
        threadId = randomUUID(); remote.made.set(request.moveId, threadId)
        remote.threads.push({ id: threadId, title: request.title, projectId: request.projectId, modelId: request.modelId, providerId: 'codex', status: 'running', requests: [], messages: [],
          lastUserMessageId: randomUUID(), ...request.runtimeMode ? { runtimeMode: request.runtimeMode } : {} })
      }
      return { type: 'started', moveId: request.moveId, threadId, ...request.runtimeMode ? { runtimeMode: request.runtimeMode } : {}, sent: true }
    }),
  }
  const changed = (): void => { for (const listener of remote.listeners) listener(FORGE) }
  const targets: MoveTargets = {
    name: hostId => hostId === FORGE ? 'forge' : undefined,
    snapshot: hostId => hostId === FORGE && remote.connected ? { ...EMPTY_AGENT_HOST, hostId: FORGE, models: [model], threads: remote.threads } as AgentHostSnapshot : undefined,
    mayAnswer: () => remote.mayAnswer, host: hostId => hostId === FORGE && remote.connected ? host : undefined,
    place: async () => ({ projectId: 'forge-project' }),
    subscribe: listener => { remote.listeners.add(listener); return () => { remote.listeners.delete(listener) } },
  }
  const watch = { watched: new Set<string>(), moved: [] as string[],
    hasStandingWatch: (target: { hostId: string; threadId: string }) => watch.watched.has(target.threadId),
    moveWatch: async (from: { hostId: string; threadId: string }, to: { hostId: string; threadId: string }) => { watch.moved.push(`${from.threadId}->${to.hostId}:${to.threadId}`); return true } }
  const service = (retryMs = 20) => new ThreadMoveService(directory, { control, workspace, branches, watch, retryMs })
  /** The machine's thread for a move ends its first turn, and the machine says so. */
  const endTurn = (moveId: string, status: 'completed' | 'failed' = 'completed') => {
    const thread = remote.threads.find(item => item.id === remote.made.get(moveId))!
    thread.status = 'idle'; thread.lastTurn = { id: 'turn', status }
    changed()
  }
  return { threads, fences, settled, links, forgotten, control, branches, remote, host, targets, watch, service, endTurn, changed }
}
type World = ReturnType<typeof world>
const key = (threadId: string): string => hostEntityKey(HERE, threadId)
async function confirmed(w: World, moves: ThreadMoveService, threadIds: readonly string[], allowNarrower: readonly string[] = []): Promise<Extract<ThreadMoveStart, { status: 'ok' }>> {
  const prepared = moves.prepare({ threadIds: threadIds.map(key), hostId: FORGE })
  if (prepared.status !== 'ok') throw new Error(prepared.message)
  const started = await moves.move({ confirmationId: prepared.confirmationId, threadIds: threadIds.map(key), allowNarrower: allowNarrower.map(key) })
  if (started.status !== 'ok') throw new Error(started.message)
  return started
}
const stateOf = (moves: ThreadMoveService, moveId: string): MoveRecord['state'] | undefined => moves.list().find(record => record.id === moveId)?.state
const saved = async (): Promise<MoveRecord[]> => (JSON.parse(await readFile(join(directory, 'moves.json'), 'utf8')) as { moves: MoveRecord[] }).moves

describe('prepare: what moves now, what asks first, and what stays and why', () => {
  it('names each thread’s outcome under one confirmation, and moves nothing', () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.threads.push(source('wide', { runtimeMode: 'full-access' }))
    w.remote.mayAnswer = false
    const prepared = moves.prepare({ threadIds: [key('a'), key('busy'), key('child'), key('wide'), hostEntityKey(FORGE, 'x')], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    expect(prepared).toMatchObject({ status: 'ok', machine: 'forge' })
    expect(prepared.threads).toEqual([
      { threadId: key('a'), outcome: 'asks', words: 'It would start on Ask for approval on forge, not this thread’s Allow edits, since forge doesn’t let This computer answer there.' },
      { threadId: key('busy'), outcome: 'stays', words: THREAD_MOVE_WORDS.running },
      { threadId: key('child'), outcome: 'stays', words: THREAD_MOVE_WORDS.delegated },
      { threadId: key('wide'), outcome: 'asks', words: expect.stringContaining('not this thread’s Full access') },
      { threadId: hostEntityKey(FORGE, 'x'), outcome: 'stays', words: THREAD_MOVE_WORDS.remote },
    ])
    expect(w.fences.size).toBe(0); expect(w.branches.forStart).not.toHaveBeenCalled()
  })
  it('says a delegating thread stays while a thread it delegated to works', () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.threads.find(thread => thread.id === 'child')!.status = 'running'
    const prepared = moves.prepare({ threadIds: [key('a')], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    expect(prepared.threads[0]).toEqual({ threadId: key('a'), outcome: 'stays', words: THREAD_MOVE_WORDS.delegating })
  })
  it('refuses a machine that is not connected, one it does not know, and one too old to take moves', () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    expect(moves.prepare({ threadIds: [key('a')], hostId: randomUUID() })).toEqual({ status: 'refused', message: THREAD_MOVE_WORDS.unknownMachine })
    w.remote.supports = false
    expect(moves.prepare({ threadIds: [key('a')], hostId: FORGE })).toEqual({ status: 'refused', message: THREAD_MOVE_WORDS.olderHost('forge') })
    w.remote.connected = false
    expect(moves.prepare({ threadIds: [key('a')], hostId: FORGE })).toEqual({ status: 'refused', message: THREAD_MOVE_WORDS.notConnected('forge') })
  })
})

describe('confirm, then the move record’s states', () => {
  it('fences, sends the branch, starts the thread, waits for its first turn, then moves the watch, links and settles the source', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.watch.watched.add('a')
    const started = await confirmed(w, moves, ['a'])
    expect(started.moves).toEqual([{ threadId: key('a'), outcome: 'moving', moveId: expect.any(String) }])
    const moveId = started.moves[0]!.moveId!
    // Fenced at once, in Zach's words, and the record written before anything was sent.
    expect(w.fences.get('a')).toBe('This thread is moving to forge. It takes no sends here while it moves.')
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    const request = w.remote.requests[0]!
    expect(request).toMatchObject({ action: 'start', moveId, projectId: 'forge-project', modelId: model.id, reasoningEffort: 'high', runtimeMode: 'auto-accept-edits',
      title: 'Thread a', titleSource: 'user', from: { threadId: 'a', provider: 'codex', hostId: HERE } })
    // The handover, the line that closes it and the facts, as one prompt, its whole length Sotto's.
    expect(request.prompt).toContain(`\n\n${MOVE_HANDOVER_CLOSE}\n\n`)
    expect(request.prompt).toContain(`- Branch: feat/wav, at commit ${COMMIT}.`)
    expect(request.prompt).toContain('- Open pull request: #12 “Fix the stall”.')
    expect(request.prompt).toContain('- Watcher watched it on This computer, and watches this thread now.')
    expect(request.handover.prefixLength).toBe(request.prompt.length)
    // Still fenced and unsettled while the first turn runs there.
    expect(w.settled).toEqual([]); expect(w.fences.has('a')).toBe(true)
    w.endTurn(moveId)
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('source-settled'))
    const threadId = w.remote.made.get(moveId)!
    expect(w.watch.moved).toEqual([`a->${FORGE}:${threadId}`])
    expect(w.links).toEqual([{ threadId: 'a', link: { threadId, provider: 'codex', at: expect.any(String), host: FORGE } }])
    expect(w.settled).toEqual(['a']); expect(w.fences.has('a')).toBe(false)
    expect(moves.keepsWorktree('a')).toBe(true)
    expect((await saved()).find(record => record.id === moveId)).toMatchObject({ state: 'source-settled', threadId, firstTurn: 'completed', watched: true, watchMoved: true,
      branch: { name: 'feat/wav', commit: COMMIT } })
    // No prompt is kept on disk.
    expect(await readFile(join(directory, 'moves.json'), 'utf8')).not.toContain('Find out why')
    moves.close()
  })
  it('holds a thread that asks first until the user presses for it, and moves it narrower when they do', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.remote.mayAnswer = false
    expect((await confirmed(w, moves, ['a'])).moves).toEqual([{ threadId: key('a'), outcome: 'asks', words: expect.stringContaining('Ask for approval') }])
    expect(w.fences.size).toBe(0)
    const pressed = await confirmed(w, moves, ['a'], ['a'])
    expect(pressed.moves[0]).toMatchObject({ outcome: 'moving' })
    await vi.waitFor(() => expect(w.remote.requests[0]?.runtimeMode).toBe('approval-required'))
    moves.close()
  })
  it('refuses a confirmation that expired, or whose threads changed since', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    const prepared = moves.prepare({ threadIds: [key('a')], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    w.threads.find(thread => thread.id === 'a')!.status = 'running'
    expect(await moves.move({ confirmationId: prepared.confirmationId, threadIds: [key('a')], allowNarrower: [] })).toEqual({ status: 'refused', message: THREAD_MOVE_WORDS.expired })
    // Spent: the same confirmation does nothing a second time.
    w.threads.find(thread => thread.id === 'a')!.status = 'idle'
    expect(await moves.move({ confirmationId: prepared.confirmationId, threadIds: [key('a')], allowNarrower: [] })).toEqual({ status: 'refused', message: THREAD_MOVE_WORDS.expired })
    vi.useFakeTimers({ toFake: ['Date'] })
    const later = moves.prepare({ threadIds: [key('a')], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    vi.setSystemTime(Date.now() + 61_000)
    expect(await moves.move({ confirmationId: later.confirmationId, threadIds: [key('a')], allowNarrower: [] })).toEqual({ status: 'refused', message: THREAD_MOVE_WORDS.expired })
    expect(w.fences.size).toBe(0)
    moves.close()
  })
  it('gives a move back when the branch is refused, lifts the fence, and lets go of nothing that never landed', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.branches.receipt = branchMoveRefusal('uncommitted', branchMoveWords.uncommitted)
    const moveId = (await confirmed(w, moves, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('given-back'))
    expect(moves.list()[0]!.givenBack).toBe(`${branchMoveWords.uncommitted} This thread stays on This computer and takes sends again.`)
    expect(w.fences.has('a')).toBe(false); expect(w.remote.requests).toEqual([]); expect(moves.keepsWorktree('a')).toBe(false)
    moves.close()
  })
  it('gives a move back when the machine refuses the start, and lets go of the branch it landed there', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.remote.answer = { type: 'refused', reason: 'model-unavailable', message: 'That model isn’t ready on this machine. Nothing was made.' }
    const moveId = (await confirmed(w, moves, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('given-back'))
    expect(w.forgotten).toEqual([moveId]); expect(w.fences.has('a')).toBe(false)
    moves.close()
  })
})

describe('every step is idempotent by the move’s ID', () => {
  it('asks again after a lost answer, and the machine answers the thread its first start made', async () => {
    const w = world(), moves = w.service(10); moves.useTargets(w.targets)
    w.remote.fail = new Error('The host did not answer.')
    const moveId = (await confirmed(w, moves, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(w.remote.requests.length).toBeGreaterThan(0))
    // The start may have landed before its answer was lost: the machine made the thread.
    w.remote.made.set(moveId, 'made-first'); w.remote.threads.push({ id: 'made-first', title: 'Thread a', projectId: 'forge-project', modelId: model.id, status: 'running', requests: [], messages: [], lastUserMessageId: 'u' })
    expect(stateOf(moves, moveId)).toBe('branch-sent')
    expect(w.fences.has('a')).toBe(true)
    w.remote.fail = undefined
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    expect(moves.list()[0]!.threadId).toBe('made-first')
    expect(w.remote.threads).toHaveLength(1)
    // Every ask named the same move.
    expect(new Set(w.remote.requests.map(request => request.moveId))).toEqual(new Set([moveId]))
    moves.close()
  })
  it('goes on after a restart in the middle: fenced again as the record is read, the branch not sent twice, and one thread made', async () => {
    const w = world(), first = w.service(); first.useTargets(w.targets)
    const moveId = (await confirmed(w, first, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(first, moveId)).toBe('thread-started'))
    first.close(); w.fences.clear()
    // Sotto stops and starts again, with the machine away for now.
    w.remote.connected = false
    const second = w.service()
    await second.load()
    expect(w.fences.get('a')).toBe(THREAD_MOVE_WORDS.fence('forge'))
    second.useTargets(w.targets)
    await vi.waitFor(() => expect(second.stalled().map(record => record.id)).toEqual([moveId]))
    w.remote.connected = true
    w.endTurn(moveId)
    await vi.waitFor(() => expect(stateOf(second, moveId)).toBe('source-settled'))
    expect(w.branches.calls).toEqual([moveId]); expect(w.remote.threads).toHaveLength(1); expect(w.settled).toEqual(['a'])
    second.close()
  })
  it('restarts a move written as fenced from its branch, which the mover lands once under the same ID', async () => {
    const w = world(), at = new Date().toISOString(), moveId = randomUUID()
    const record: MoveRecord = { id: moveId, sourceThreadId: 'a', targetHostId: FORGE, machine: 'forge', state: 'fenced', watched: false,
      start: { provider: 'codex', modelId: model.id, title: 'Thread a' }, createdAt: at, updatedAt: at }
    await writeFile(join(directory, 'moves.json'), JSON.stringify({ version: 1, moves: [record] }))
    const moves = w.service()
    await moves.load(); moves.useTargets(w.targets)
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    expect(w.branches.calls).toEqual([moveId])
    moves.close()
  })
})

describe('the first turn there', () => {
  it('ends once the prompt reached the thread and nothing runs or waits on the user', () => {
    const base = { status: 'idle' as const, requests: [], messages: [] }
    expect(firstTurnEnded(base)).toBeUndefined()
    expect(firstTurnEnded({ ...base, lastUserMessageId: 'u', status: 'running' })).toBeUndefined()
    expect(firstTurnEnded({ ...base, lastUserMessageId: 'u', lastTurn: { id: 't', status: 'completed' }, requests: [{ id: 'r', kind: 'permission', text: 'May I?', options: [] }] })).toBeUndefined()
    expect(firstTurnEnded({ ...base, lastUserMessageId: 'u', lastTurn: { id: 't', status: 'failed' } })).toBe('failed')
    expect(firstTurnEnded({ ...base, summary: { messageCount: 2, activityCount: 0, lastUser: { id: 'u', text: 'x', createdAt: '2026-10-29T10:00:00.000Z' },
      lastAssistant: { id: 'a', text: 'y', createdAt: '2026-10-29T10:01:00.000Z' } } })).toBe('completed')
  })
})
