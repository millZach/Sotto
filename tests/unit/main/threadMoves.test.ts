// @vitest-environment node
// #1178 part 1: the move record's states, the fence, and the prepare and confirm pair, over stand-ins for the coordinator,
// the branch mover and the machine a thread moves to. tests/integration/threadMoves.test.ts moves one over a real host.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildHandover } from '../../../src/main/agents/handover'
import { firstTurnEnded, holdUnfinishedMoves, ThreadMoveService, type MoveControl, type MoveNews, type MoveRecord, type MoveTargets } from '../../../src/main/agents/threadMoves'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentModel, type AgentState, type AgentThread, type ThreadContinuedIn } from '../../../src/shared/agents'
import { branchMoveRefusal, branchMoveWords, type BranchMoveReceipt } from '../../../src/shared/branchMoves'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { MOVE_HANDOVER_CLOSE, THREAD_MOVE_WORDS, type HostThreadMoveRequest, type HostThreadMoveSource, type HostThreadMoveStart, type ThreadMoveHost, type ThreadMovePrepare, type ThreadMovesView, type ThreadMoveStart } from '../../../src/shared/threadMoves'

const HERE = randomUUID(), FORGE = randomUUID(), LAB = randomUUID(), COMMIT = 'c'.repeat(40)
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
  /** This computer's models: forge has only the first. */
  const localModels: AgentModel[] = [model]
  /** What Watcher heard of each move as it ended. */
  const news: MoveNews[] = []
  const fences = new Map<string, string>(), settled: string[] = [], links: { threadId: string; link: ThreadContinuedIn }[] = [], forgotten: string[] = []
  const control: MoveControl = {
    hostId: () => HERE, watcherSnapshot: () => ({ ...EMPTY_AGENT_HOST, hostId: HERE, models: localModels, threads }),
    configuration: () => ({ newThreadRuntimeMode: 'full-access' }), moveHoldReason: () => null,
    fenceForMove: (threadId, words) => { fences.set(threadId, words) }, liftMoveFence: threadId => { fences.delete(threadId) }, fencedForMove: () => [...fences.keys()], moveFenceOf: threadId => fences.get(threadId),
    commandFromMove: async command => {
      settled.push(command.threadId)
      const thread = threads.find(item => item.id === command.threadId)
      if (thread) thread.workspaceSettledAt = new Date().toISOString()
      return { error: null } as AgentState
    },
  }
  const workspace = { linkFails: 0,
    threadHandover: (threadId: string) => { const thread = threads.find(item => item.id === threadId)!; return buildHandover(thread.messages, { source: { threadId, title: thread.title, provider: 'codex' }, historyKept: true }) },
    addContinuedIn: async (threadId: string, link: ThreadContinuedIn) => {
      if (workspace.linkFails > 0) { workspace.linkFails--; throw new Error('The record could not be saved.') }
      links.push({ threadId, link })
    },
  }
  const delegations = { open: new Set<string>(), hasOpen: (threadId: string) => delegations.open.has(threadId) }
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
  const remote = { connected: true, mayAnswer: true, supports: true, threads: [] as AgentThread[], made: new Map<string, string>(), requests: [] as HostThreadMoveStart[],
    fail: undefined as Error | undefined, answer: undefined as unknown, listeners: new Set<(hostId?: string) => void>(), updates: new Set<() => void>(),
    /** Each push makes a new snapshot, as the router does; between pushes the same one is read. */
    version: 0, snapshot: undefined as { version: number; snapshot: AgentHostSnapshot } | undefined,
    /** How many times anything read one of the machine's threads out of its snapshot. */
    visits: 0, snapshots: 0 }
  const host = {
    get supportsThreadMove() { return remote.supports },
    threadMove: vi.fn(async (asked: HostThreadMoveRequest) => {
      if (asked.action !== 'start') throw new Error('Forge holds none of its own threads here.')
      const request = asked
      remote.requests.push(request)
      if (remote.fail) throw remote.fail
      if (remote.answer !== undefined) return remote.answer
      let threadId = remote.made.get(request.moveId)
      if (!threadId) {
        threadId = randomUUID(); remote.made.set(request.moveId, threadId)
        remote.threads.push({ id: threadId, title: request.title, projectId: request.projectId, modelId: request.modelId, providerId: 'codex', status: 'running', requests: [], messages: [],
          lastUserMessageId: randomUUID(), ...request.runtimeMode ? { runtimeMode: request.runtimeMode } : {} })
      }
      remote.version++
      return { type: 'started', moveId: request.moveId, threadId, ...request.runtimeMode ? { runtimeMode: request.runtimeMode } : {}, sent: true }
    }),
  }
  // A second paired host, lab, whose own threads move (part 3): it holds one for a move, gives its handover, and settles
  // or lets go of it, each answered the same when asked again.
  const lab = { connected: true, supportsSource: true, threads: [source('lab-1')] as AgentThread[], asked: [] as HostThreadMoveSource[], fences: new Set<string>(),
    holdAnswer: undefined as unknown }
  const labHost: ThreadMoveHost = {
    supportsThreadMove: true, get supportsThreadMoveSource() { return lab.supportsSource },
    threadMove: vi.fn(async (asked: HostThreadMoveRequest) => {
      if (asked.action === 'start') throw new Error('Nothing moves to lab here.')
      lab.asked.push(asked)
      switch (asked.action) {
        case 'hold': if (lab.holdAnswer !== undefined) return lab.holdAnswer; lab.fences.add(asked.threadId); return { type: 'held', moveId: asked.moveId }
        case 'handover': return { type: 'handover', moveId: asked.moveId, text: 'The handover of lab-1.', counts: { total: 2, carried: 2, tooLong: 0, notCarried: 0, images: 0, files: 0, visuals: 0, toolRecords: 0, historyKept: true, answered: false } }
        default: lab.fences.clear(); return { type: 'done', moveId: asked.moveId }
      }
    }),
  }
  // This computer as a target: it makes the moved thread among its own, as a host does.
  const local = { requests: [] as HostThreadMoveStart[], made: new Map<string, string>() }
  const here: ThreadMoveHost = { supportsThreadMove: true, threadMove: vi.fn(async (asked: HostThreadMoveRequest) => {
    if (asked.action !== 'start') throw new Error('This computer holds its threads itself.')
    local.requests.push(asked)
    let threadId = local.made.get(asked.moveId)
    if (!threadId) {
      threadId = randomUUID(); local.made.set(asked.moveId, threadId)
      threads.push({ ...source(threadId), title: asked.title, status: 'running', messages: [], lastUserMessageId: randomUUID(), pullRequests: [] })
    }
    return { type: 'started', moveId: asked.moveId, threadId, sent: true }
  }) }
  /** The machine pushed an update: a new snapshot, and every update listener hears it. */
  const changed = (): void => { remote.version++; for (const listener of remote.updates) listener() }
  /** The machine connected or changed what it offers. */
  const connected = (): void => { for (const listener of remote.listeners) listener(FORGE) }
  const counted = (threads: AgentThread[]): AgentThread[] => new Proxy(threads, { get(target, property, receiver) {
    if (typeof property === 'string' && /^\d+$/u.test(property)) remote.visits++
    return Reflect.get(target, property, receiver) as unknown } })
  const targets: MoveTargets = {
    name: hostId => hostId === FORGE ? 'forge' : hostId === LAB ? 'lab' : undefined,
    snapshot: hostId => {
      if (hostId === LAB) return lab.connected ? { ...EMPTY_AGENT_HOST, hostId: LAB, models: [model], threads: lab.threads } : undefined
      if (hostId !== FORGE || !remote.connected) return undefined
      remote.snapshots++
      if (remote.snapshot?.version !== remote.version) remote.snapshot = { version: remote.version, snapshot: { ...EMPTY_AGENT_HOST, hostId: FORGE, models: [model], threads: counted([...remote.threads]) } }
      return remote.snapshot.snapshot
    },
    mayAnswer: () => remote.mayAnswer, host: hostId => hostId === FORGE && remote.connected ? host : hostId === LAB && lab.connected ? labHost : undefined,
    place: async () => ({ projectId: 'forge-project' }),
    subscribe: listener => { remote.listeners.add(listener); return () => { remote.listeners.delete(listener) } },
    subscribeUpdates: listener => { remote.updates.add(listener); return () => { remote.updates.delete(listener) } },
  }
  const watch = { watched: new Set<string>(), moved: [] as string[], refuses: false, tries: 0,
    hasStandingWatch: (target: { hostId: string; threadId: string }) => watch.watched.has(target.threadId),
    moveWatch: async (from: { hostId: string; threadId: string }, to: { hostId: string; threadId: string }) => {
      watch.tries++
      if (watch.refuses) return false
      watch.moved.push(`${from.threadId}->${to.hostId}:${to.threadId}`); return true
    } }
  const service = (retryMs = 20) => new ThreadMoveService(directory, { control, workspace, branches, watch, delegations, retryMs, news: move => { news.push(move) }, here })
  /** The machine's thread for a move ends its first turn, and the machine says so. */
  const endTurn = (moveId: string, status: 'completed' | 'failed' = 'completed', patch: Partial<AgentThread> = {}) => {
    const thread = remote.threads.find(item => item.id === remote.made.get(moveId))!
    Object.assign(thread, { status: 'idle', lastTurn: { id: 'turn', status } }, patch)
    changed()
  }
  /** A machine connected again, by its host ID. */
  const reconnected = (hostId: string): void => { for (const listener of remote.listeners) listener(hostId) }
  return { threads, localModels, news, fences, settled, links, forgotten, control, workspace, delegations, branches, remote, host, targets, watch, service, endTurn, changed, connected,
    lab, local, reconnected }
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
      { threadId: key('a'), outcome: 'asks', words: 'It would start on Ask for approval on forge, not this thread’s Allow edits, since forge doesn’t let This computer answer there.', model: { name: 'GPT' }, startsOn: 'Ask for approval' },
      { threadId: key('busy'), outcome: 'stays', words: THREAD_MOVE_WORDS.running },
      { threadId: key('child'), outcome: 'stays', words: THREAD_MOVE_WORDS.delegated },
      { threadId: key('wide'), outcome: 'asks', words: expect.stringContaining('not this thread’s Full access'), model: { name: 'GPT' }, startsOn: 'Ask for approval' },
      { threadId: hostEntityKey(FORGE, 'x'), outcome: 'stays', words: THREAD_MOVE_WORDS.already('forge') },
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
  it('keeps the source here, unsettled and watched, when the new thread fails its first turn (#1178)', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.watch.watched.add('a')
    const moveId = (await confirmed(w, moves, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    w.endTurn(moveId, 'failed')
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('stayed'))
    const threadId = w.remote.made.get(moveId)!
    // A thread that fails to transfer stays where it is: not settled, its watch not moved, and it takes sends again.
    expect(w.settled).toEqual([]); expect(w.watch.moved).toEqual([]); expect(w.fences.has('a')).toBe(false)
    // The new thread is left there, and the source links to it.
    expect(w.links).toEqual([{ threadId: 'a', link: { threadId, provider: 'codex', at: expect.any(String), host: FORGE } }])
    expect(moves.list().find(record => record.id === moveId)?.givenBack)
      .toBe('The new thread on forge failed in its first turn, so this thread stays on This computer and takes sends again. The new thread is still on forge.')
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
    // Given back, and only then is the fence lifted: wait for both.
    await vi.waitFor(() => { expect(stateOf(moves, moveId)).toBe('given-back'); expect(w.fences.has('a')).toBe(false) })
    expect(moves.list()[0]!.givenBack).toBe(`${branchMoveWords.uncommitted} This thread stays on This computer and takes sends again.`)
    expect(w.remote.requests).toEqual([]); expect(moves.keepsWorktree('a')).toBe(false)
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
    w.remote.connected = true; w.connected()
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
  it('ends once the prompt reached the thread and nothing runs, waits on the user or works in the background', () => {
    const base: AgentThread = { id: 'there', projectId: 'project', title: 'There', modelId: model.id, status: 'idle', requests: [], messages: [] }
    expect(firstTurnEnded(base)).toBeUndefined()
    expect(firstTurnEnded({ ...base, lastUserMessageId: 'u', status: 'running' })).toBeUndefined()
    expect(firstTurnEnded({ ...base, lastUserMessageId: 'u', lastTurn: { id: 't', status: 'completed' }, requests: [{ id: 'r', kind: 'permission', text: 'May I?', options: [] }] })).toBeUndefined()
    expect(firstTurnEnded({ ...base, lastUserMessageId: 'u', lastTurn: { id: 't', status: 'failed' } })).toBe('failed')
    expect(firstTurnEnded({ ...base, lastUserMessageId: 'u', lastTurn: { id: 't', status: 'failed' }, backgroundWork: [{ id: 'b', kind: 'agent', title: 'Tests', status: 'working' }] as never })).toBeUndefined()
    expect(firstTurnEnded({ ...base, lastUserMessageId: 'u', lastTurn: { id: 't', status: 'completed' }, monitoring: [{ id: 'm', title: 'Watch the build' }] as never })).toBeUndefined()
    expect(firstTurnEnded({ ...base, summary: { messageCount: 2, activityCount: 0, lastUser: { id: 'u', text: 'x', createdAt: '2026-10-29T10:00:00.000Z' },
      lastAssistant: { id: 'a', text: 'y', createdAt: '2026-10-29T10:01:00.000Z' } } })).toBe('completed')
  })
})

describe('a record written before it counts (Sol’s review)', () => {
  it('steps nothing until a new move’s first write succeeds, and one that fails answers stays with nothing sent', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    // A folder where the record goes makes its write fail.
    await mkdir(join(directory, 'moves.json'))
    const prepared = moves.prepare({ threadIds: [key('a')], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    const moving = moves.move({ confirmationId: prepared.confirmationId, threadIds: [key('a')], allowNarrower: [] })
    // Fenced while it is written, and nothing a machine says meanwhile steps it.
    expect(w.fences.has('a')).toBe(true)
    w.changed(); w.connected()
    expect(await moving).toEqual({ status: 'ok', moves: [{ threadId: key('a'), outcome: 'stays', words: THREAD_MOVE_WORDS.unsaved }] })
    expect(w.fences.has('a')).toBe(false); expect(w.branches.forStart).not.toHaveBeenCalled(); expect(w.remote.requests).toEqual([])
    expect(moves.list()).toEqual([]); expect(moves.keepsWorktree('a')).toBe(false)
    moves.close()
  })
})

describe('a record that does not read (Sol’s review)', () => {
  it('starts no move, keeps every source it still names fenced and kept, and leaves the file as it is', async () => {
    const w = world(), path = join(directory, 'moves.json')
    const broken = JSON.stringify({ version: 1, moves: [{ id: 'not-a-uuid', sourceThreadId: 'a', machine: 'forge', state: 'branch-sent' }, { sourceThreadId: 'b', state: 'given-back' }], kept: ['old'] })
    await writeFile(path, broken)
    const moves = w.service()
    await moves.load(); moves.useTargets(w.targets)
    expect(w.fences.get('a')).toBe(THREAD_MOVE_WORDS.unreadableFence('forge')); expect(w.fences.has('b')).toBe(false)
    expect(moves.keepsWorktree('a')).toBe(true); expect(moves.keepsWorktree('old')).toBe(true)
    expect(moves.prepare({ threadIds: [key('b')], hostId: FORGE })).toEqual({ status: 'refused', message: THREAD_MOVE_WORDS.unreadableRecord })
    expect(await moves.move({ confirmationId: randomUUID(), threadIds: [key('b')], allowNarrower: [] })).toEqual({ status: 'refused', message: THREAD_MOVE_WORDS.unreadableRecord })
    expect(await readFile(path, 'utf8')).toBe(broken)
    moves.close()
  })
  it('refuses moves on a file that is not JSON at all, and fences nothing it cannot name', async () => {
    const w = world()
    await writeFile(join(directory, 'moves.json'), '{"version": 1, "moves": [')
    const moves = w.service()
    await moves.load()
    expect(w.fences.size).toBe(0)
    expect(moves.prepare({ threadIds: [key('a')], hostId: FORGE })).toEqual({ status: 'refused', message: THREAD_MOVE_WORDS.unreadableRecord })
    moves.close()
  })
})

describe('a run that does not move threads (Sol’s review, ADR-0072)', () => {
  it('reads the record, keeps the sources of unfinished moves fenced and their worktrees kept, and writes nothing', async () => {
    const at = new Date().toISOString(), start = { provider: 'codex' as const, modelId: model.id, title: 'Thread' }
    const file = JSON.stringify({ version: 1, kept: ['settled'], moves: [
      { id: randomUUID(), sourceThreadId: 'moving', targetHostId: FORGE, machine: 'forge', state: 'thread-started', start, watched: false, createdAt: at, updatedAt: at },
      { id: randomUUID(), sourceThreadId: 'settled', targetHostId: FORGE, machine: 'forge', state: 'source-settled', start, watched: false, createdAt: at, updatedAt: at },
      { id: randomUUID(), sourceThreadId: 'back', targetHostId: FORGE, machine: 'forge', state: 'given-back', start, watched: false, createdAt: at, updatedAt: at }] })
    await writeFile(join(directory, 'moves.json'), file)
    const fences = new Map<string, string>()
    const held = await holdUnfinishedMoves(directory, { fenceForMove: (threadId, words) => { fences.set(threadId, words) }, liftMoveFence: threadId => { fences.delete(threadId) },
      fencedForMove: () => [...fences.keys()] })
    expect([...fences]).toEqual([['moving', THREAD_MOVE_WORDS.paused('forge')]])
    expect(['moving', 'settled', 'back'].map(threadId => held.keepsWorktree(threadId))).toEqual([true, true, false])
    expect(await readFile(join(directory, 'moves.json'), 'utf8')).toBe(file)
    // No record is no move.
    await rm(join(directory, 'moves.json'))
    expect((await holdUnfinishedMoves(directory, { fenceForMove: () => { throw new Error('Nothing to fence.') }, liftMoveFence: () => undefined })).keepsWorktree('moving')).toBe(false)
  })
})

describe('the watch goes before the source settles (Sol’s review)', () => {
  it('tries the watch again, and after repeated failures leaves the source fenced, unsettled and still watched, as a stalled move', async () => {
    const w = world(), moves = w.service(5); moves.useTargets(w.targets)
    w.watch.watched.add('a'); w.watch.refuses = true
    const moveId = (await confirmed(w, moves, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    w.endTurn(moveId)
    await vi.waitFor(() => { expect(moves.stalled().map(record => record.id)).toEqual([moveId]); expect(w.watch.tries).toBe(5) })
    expect(moves.list()[0]).toMatchObject({ state: 'first-turn-ended', watchMoved: false })
    expect(w.settled).toEqual([]); expect(w.fences.has('a')).toBe(true); expect(w.watch.watched.has('a')).toBe(true)
    // Nothing tries it again on its own; a restart does, and settles it once the watch goes.
    w.changed(); w.connected()
    expect(w.watch.tries).toBe(5)
    moves.close()
    w.watch.refuses = false
    const again = w.service(5)
    await again.load(); again.useTargets(w.targets)
    await vi.waitFor(() => expect(stateOf(again, moveId)).toBe('source-settled'))
    expect(w.settled).toEqual(['a']); expect(again.list()[0]).toMatchObject({ watchMoved: true })
    again.close()
  })
})

describe('worktrees kept apart from history (Sol’s review)', () => {
  it('keeps a moved source’s worktree when its record is trimmed, and lets go only once the thread is deleted', async () => {
    const at = new Date().toISOString(), start = { provider: 'codex' as const, modelId: model.id, title: 'Thread' }
    const old = Array.from({ length: 505 }, (_, index) => ({ id: randomUUID(), sourceThreadId: `old-${index}`, targetHostId: FORGE, machine: 'forge', state: 'source-settled',
      start, watched: false, createdAt: at, updatedAt: at }))
    await writeFile(join(directory, 'moves.json'), JSON.stringify({ version: 1, moves: old, kept: old.map(record => record.sourceThreadId) }))
    const w = world(), moves = w.service(); await moves.load(); moves.useTargets(w.targets)
    w.branches.receipt = branchMoveRefusal('uncommitted', branchMoveWords.uncommitted)
    const moveId = (await confirmed(w, moves, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('given-back'))
    const file = JSON.parse(await readFile(join(directory, 'moves.json'), 'utf8')) as { moves: MoveRecord[]; kept: string[] }
    expect(file.moves.length).toBeLessThanOrEqual(501)
    expect(file.moves.some(record => record.sourceThreadId === 'old-0')).toBe(false)
    expect(moves.keepsWorktree('old-0')).toBe(true); expect(file.kept).toContain('old-0')
    // A move given back keeps nothing of its source.
    expect(moves.keepsWorktree('a')).toBe(false)
    moves.forgetThreads(new Set(['old-0']))
    expect(moves.keepsWorktree('old-0')).toBe(false)
    await vi.waitFor(async () => expect((JSON.parse(await readFile(join(directory, 'moves.json'), 'utf8')) as { kept: string[] }).kept).not.toContain('old-0'))
    moves.close()
  })
})

describe('the first turn is over only once the thread is quiet there (Sol’s spec review)', () => {
  it('keeps the source fenced while a failed first turn leaves background work or a delegated thread working there', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    const moveId = (await confirmed(w, moves, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    const threadId = w.remote.made.get(moveId)!
    w.remote.threads.push({ id: 'child-there', projectId: 'forge-project', title: 'Child', modelId: model.id, status: 'running', requests: [], messages: [], delegatedBy: threadId })
    w.endTurn(moveId, 'failed', { backgroundWork: [{ id: 'tests' }] as never })
    await new Promise(done => setTimeout(done, 50))
    expect(stateOf(moves, moveId)).toBe('thread-started'); expect(w.fences.has('a')).toBe(true)
    // Its own background work ends; the thread it delegated to still works.
    w.endTurn(moveId, 'failed', { backgroundWork: [] })
    await new Promise(done => setTimeout(done, 50))
    expect(stateOf(moves, moveId)).toBe('thread-started')
    w.remote.threads.find(thread => thread.id === 'child-there')!.status = 'idle'
    w.changed()
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('stayed'))
    expect(w.fences.has('a')).toBe(false); expect(w.settled).toEqual([])
    moves.close()
  })
})

describe('work per update (AGENTS.md: it must not grow faster than the threads)', () => {
  /** `count` moves waiting on their first turn there; then one update that changed the snapshot, and one that changed nothing. */
  async function visitsFor(count: number) {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    for (let index = 0; index < count; index++) w.threads.push(source(`m${index}`))
    const threadIds = Array.from({ length: count }, (_, index) => `m${index}`)
    await confirmed(w, moves, threadIds)
    // Every move saved as waiting on its first turn there, and none of them mid-step.
    const inner = moves as unknown as { waitingTurn: ReadonlySet<string>; advancing: ReadonlySet<string> }
    await vi.waitFor(() => { expect(inner.waitingTurn.size).toBe(count); expect(inner.advancing.size).toBe(0) })
    const read = vi.spyOn(w.control, 'watcherSnapshot')
    w.remote.visits = 0; w.remote.snapshots = 0
    w.changed()
    const changed = { visits: w.remote.visits, snapshots: w.remote.snapshots }
    w.remote.visits = 0
    for (const listener of w.remote.updates) listener()
    const unchanged = w.remote.visits
    const sourceReads = read.mock.calls.length
    moves.close()
    return { changed, unchanged, sourceReads, threads: w.remote.threads.length }
  }
  it('reads each thread there once for an update that changed it, nothing for one that did not, and no thread here', async () => {
    const twenty = await visitsFor(20), forty = await visitsFor(40)
    // One index for the new snapshot: as many visits as threads there, not moves times threads (420 and 1,640 before).
    expect(twenty.changed.visits).toBe(twenty.threads); expect(forty.changed.visits).toBe(forty.threads)
    expect(twenty.unchanged).toBe(0); expect(forty.unchanged).toBe(0)
    expect(twenty.sourceReads).toBe(0); expect(forty.sourceReads).toBe(0)
  })
})

describe('Sol’s second pass', () => {
  it('starts one move when the same thread is confirmed twice before the first is written', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    const first = moves.prepare({ threadIds: [key('a')], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    const second = moves.prepare({ threadIds: [key('a')], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    const [one, two] = await Promise.all([first, second].map(prepared => moves.move({ confirmationId: prepared.confirmationId, threadIds: [key('a')], allowNarrower: [] })))
    expect([one, two]).toEqual([{ status: 'ok', moves: [{ threadId: key('a'), outcome: 'moving', moveId: expect.any(String) }] }, { status: 'refused', message: THREAD_MOVE_WORDS.expired }])
    await vi.waitFor(() => expect(moves.list()[0]?.state).toBe('thread-started'))
    expect(moves.list()).toHaveLength(1); expect(w.branches.forStart).toHaveBeenCalledTimes(1); expect(w.remote.threads).toHaveLength(1)
    moves.close()
  })
  it('keeps the move from ending while a thread the new one delegated to on another machine still works', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    const moveId = (await confirmed(w, moves, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    // Its child runs on This computer, or a third machine, through the desktop: delegation's record holds it open.
    w.delegations.open.add(hostEntityKey(FORGE, w.remote.made.get(moveId)!))
    w.endTurn(moveId)
    await new Promise(done => setTimeout(done, 50))
    expect(stateOf(moves, moveId)).toBe('thread-started'); expect(w.settled).toEqual([])
    // It answers elsewhere, with nothing new on forge itself: the next update reads it again.
    w.delegations.open.clear()
    for (const listener of w.remote.updates) listener()
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('source-settled'))
    moves.close()
  })
  it('does not finish a move whose link back could not be saved, and saves it on the next try', async () => {
    const w = world(), moves = w.service(5); moves.useTargets(w.targets)
    w.workspace.linkFails = 2
    const moveId = (await confirmed(w, moves, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    w.endTurn(moveId)
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('source-settled'))
    expect(w.links).toHaveLength(1); expect(w.workspace.linkFails).toBe(0)
    moves.close()
  })
  it('lifts a fence the coordinator kept only when a record that reads shows no move under way, and keeps it otherwise', async () => {
    const w = world()
    w.fences.set('stale', THREAD_MOVE_WORDS.fence('forge'))
    // A record that does not parse at all: every fence the coordinator kept stays.
    await writeFile(join(directory, 'moves.json'), '{"version": 1, "moves": [')
    const unread = w.service(); await unread.load(); unread.settleFences()
    expect(w.fences.has('stale')).toBe(true)
    unread.close()
    // One that reads and names no move under way for it: the fence was a lift not saved, and goes.
    await writeFile(join(directory, 'moves.json'), JSON.stringify({ version: 1, moves: [] }))
    const read = w.service(); await read.load(); read.settleFences()
    expect(w.fences.has('stale')).toBe(false)
    read.close()
  })
})

describe('Sol’s third pass', () => {
  it('keeps a thread the coordinator still fences from moving again, though no record here names its move', () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.fences.set('a', THREAD_MOVE_WORDS.fence('forge'))
    const prepared = moves.prepare({ threadIds: [key('a')], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    expect(prepared.threads).toEqual([{ threadId: key('a'), outcome: 'stays', words: THREAD_MOVE_WORDS.fenced }])
    moves.close()
  })
  it('plans a thread named twice, by its own ID and by This computer’s key for it, once', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    const prepared = moves.prepare({ threadIds: ['a', key('a')], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    expect(prepared.threads).toEqual([{ threadId: 'a', outcome: 'moves', model: { name: 'GPT' } }, { threadId: key('a'), outcome: 'stays', words: THREAD_MOVE_WORDS.twice }])
    const started = await moves.move({ confirmationId: prepared.confirmationId, threadIds: ['a', key('a')], allowNarrower: [] })
    expect(started).toEqual({ status: 'ok', moves: [{ threadId: 'a', outcome: 'moving', moveId: expect.any(String) }, { threadId: key('a'), outcome: 'stays', words: THREAD_MOVE_WORDS.twice }] })
    await vi.waitFor(() => expect(moves.list()[0]?.state).toBe('thread-started'))
    expect(moves.list()).toHaveLength(1); expect(w.remote.threads).toHaveLength(1)
    moves.close()
  })
})

describe('part 2: the cards in Watcher’s conversation, the press on one that asks, and Watcher’s news', () => {
  it('names the model a thread moves to, and the one forge lacks (Zach, October 29, 2026)', () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.localModels.push({ ...model, id: 'codex:o5', name: 'O5' })
    w.threads.push(source('old', { modelId: 'codex:o5' }))
    const prepared = moves.prepare({ threadIds: [key('a'), key('old')], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    expect(prepared.threads.map(item => item.model)).toEqual([{ name: 'GPT' }, { name: 'GPT', instead: 'O5' }])
    moves.close()
  })
  it('shows each move as a card, and a press on one that asks moves it in that card’s place or keeps it here', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.remote.mayAnswer = false
    const views: ThreadMovesView[] = []
    moves.subscribe(view => { views.push(view) })
    const started = await confirmed(w, moves, ['a', 'b'])
    expect(started.moves.map(item => item.outcome)).toEqual(['asks', 'asks'])
    // Nothing moved, nothing is fenced, and each waits on its own card.
    expect(w.fences.size).toBe(0); expect(moves.list()).toEqual([])
    const asks = moves.view().cards
    expect(asks).toEqual([
      expect.objectContaining({ state: 'asks', source: { hostId: HERE, threadId: 'a' }, hostId: FORGE, machine: 'forge', model: { name: 'GPT' }, startsOn: 'Ask for approval', words: expect.stringContaining('Ask for approval') }),
      expect.objectContaining({ state: 'asks', source: { hostId: HERE, threadId: 'b' } }),
    ])
    expect(views.at(-1)).toEqual({ cards: asks })
    expect(await moves.answer({ cardId: asks[1]!.id, answer: 'keep' })).toEqual({ status: 'ok' })
    expect(moves.view().cards[1]).toMatchObject({ id: asks[1]!.id, state: 'kept' })
    // A press to move it anyway moves it on the permission the card named, where the card was.
    expect(await moves.answer({ cardId: asks[0]!.id, answer: 'move' })).toEqual({ status: 'ok' })
    await vi.waitFor(() => expect(moves.list()[0]?.state).toBe('thread-started'))
    expect(w.remote.requests[0]).toMatchObject({ runtimeMode: 'approval-required' })
    const card = moves.view().cards.find(item => item.source.threadId === 'a')!
    expect(card).toMatchObject({ id: moves.list()[0]!.id, state: 'thread-started', at: asks[0]!.at, moved: { hostId: FORGE, threadId: w.remote.made.get(moves.list()[0]!.id) } })
    expect(moves.view().cards.filter(item => item.state === 'asks')).toEqual([])
    // A card answered once is not answered again.
    expect(await moves.answer({ cardId: asks[0]!.id, answer: 'move' })).toEqual({ status: 'refused', message: THREAD_MOVE_WORDS.noCard })
    expect(await moves.answer({ cardId: asks[1]!.id, answer: 'move' })).toEqual({ status: 'refused', message: THREAD_MOVE_WORDS.noCard })
    moves.close()
  })
  it('says on its card why a pressed thread can no longer move, and moves nothing', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.remote.mayAnswer = false
    await confirmed(w, moves, ['a'])
    const [card] = moves.view().cards
    w.threads.find(thread => thread.id === 'a')!.status = 'running'
    expect(await moves.answer({ cardId: card!.id, answer: 'move' })).toEqual({ status: 'ok' })
    expect(moves.view().cards).toEqual([expect.objectContaining({ id: card!.id, state: 'stays', words: THREAD_MOVE_WORDS.running })])
    expect(moves.list()).toEqual([]); expect(w.fences.size).toBe(0)
    moves.close()
  })
  it('moves a pressed card only on the permission it named: one that would now start wider says so and moves nothing', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.remote.mayAnswer = false
    await confirmed(w, moves, ['a'])
    const [card] = moves.view().cards
    expect(card).toMatchObject({ state: 'asks', startsOn: 'Ask for approval' })
    // The machine now lets This computer answer there, so the thread would start on its own Allow edits, not Ask for approval.
    w.remote.mayAnswer = true
    expect(await moves.answer({ cardId: card!.id, answer: 'move' })).toEqual({ status: 'ok' })
    expect(moves.view().cards).toEqual([expect.objectContaining({ id: card!.id, state: 'stays', words: THREAD_MOVE_WORDS.changed })])
    expect(moves.list()).toEqual([]); expect(w.fences.size).toBe(0); expect(w.remote.requests).toEqual([])
    moves.close()
  })
  it('pushes the cards when a machine change makes a move wait, and not for every update that changes nothing they say', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    const moveId = (await confirmed(w, moves, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    const views: ThreadMovesView[] = []
    moves.subscribe(view => { views.push(view) })
    for (let index = 0; index < 20; index++) { w.connected(); w.changed() }
    expect(views).toEqual([])
    w.remote.connected = false; w.connected()
    await vi.waitFor(() => expect(views.at(-1)?.cards[0]).toMatchObject({ id: moveId, waiting: true }))
    moves.close()
  })
  it('tells Watcher of each move as it ends: moved, stayed or given back', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    const moved = (await confirmed(w, moves, ['a'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moved)).toBe('thread-started'))
    expect(w.news).toEqual([])
    w.endTurn(moved)
    await vi.waitFor(() => expect(stateOf(moves, moved)).toBe('source-settled'))
    expect(w.news).toEqual([{ moveId: moved, source: { hostId: HERE, threadId: 'a' }, movedTo: { hostId: FORGE, threadId: w.remote.made.get(moved) }, machine: 'forge', outcome: 'moved' }])
    const stayed = (await confirmed(w, moves, ['b'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, stayed)).toBe('thread-started'))
    w.endTurn(stayed, 'failed')
    await vi.waitFor(() => expect(stateOf(moves, stayed)).toBe('stayed'))
    expect(w.news[1]).toMatchObject({ source: { threadId: 'b' }, outcome: 'stayed' })
    w.threads.push(source('back'))
    w.branches.receipt = branchMoveRefusal('uncommitted', branchMoveWords.uncommitted)
    const back = (await confirmed(w, moves, ['back'])).moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, back)).toBe('given-back'))
    expect(w.news[2]).toEqual({ moveId: back, source: { hostId: HERE, threadId: 'back' }, machine: 'forge', outcome: 'given-back' })
    expect(w.news).toHaveLength(3)
    // Each card says how its move ended, and Watcher watches the one that moved.
    expect(moves.view().cards.map(card => card.state)).toEqual(['source-settled', 'stayed', 'given-back'])
    moves.close()
  })
})

describe('a host’s thread moves too (#1178 part 3)', () => {
  const labKey = hostEntityKey(LAB, 'lab-1')
  it('moves a host’s thread to another host through this desktop: held there, its handover from there, then settled there', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.watch.watched.add('lab-1')
    const prepared = moves.prepare({ threadIds: [labKey], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    expect(prepared.threads).toEqual([{ threadId: labKey, outcome: 'moves', model: { name: 'GPT' } }])
    const started = await moves.move({ confirmationId: prepared.confirmationId, threadIds: [labKey], allowNarrower: [] }) as Extract<ThreadMoveStart, { status: 'ok' }>
    const moveId = started.moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    // Fenced on lab by lab's own record, never here; its branch goes from lab, through this desktop, to forge.
    expect(w.lab.asked[0]).toEqual({ action: 'hold', moveId, threadId: 'lab-1', machine: 'forge' })
    expect(w.fences.size).toBe(0); expect(w.lab.fences.has('lab-1')).toBe(true)
    expect(w.branches.forStart).toHaveBeenCalledWith(expect.objectContaining({ from: { hostId: LAB, threadId: 'lab-1' }, to: { hostId: FORGE, projectId: 'forge-project' }, moveId }))
    const request = w.remote.requests[0]!
    expect(request.from).toEqual({ threadId: 'lab-1', provider: 'codex', hostId: LAB })
    expect(request.prompt.startsWith('The handover of lab-1.')).toBe(true)
    expect(request.prompt).toContain('which ran on lab until the user moved it here, to forge.')
    expect(request.prompt).toContain('- Watcher watched it on lab, and watches this thread now.')
    expect(request.handover.counts.total).toBe(2)
    w.endTurn(moveId)
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('source-settled'))
    const threadId = w.remote.made.get(moveId)!
    expect(w.lab.asked.at(-1)).toEqual({ action: 'settle', moveId, link: { threadId, provider: 'codex', hostId: FORGE, at: expect.any(String) } })
    expect(w.lab.fences.size).toBe(0); expect(w.settled).toEqual([]); expect(w.links).toEqual([])
    expect(w.watch.moved).toEqual([`lab-1->${FORGE}:${threadId}`])
    expect(w.news).toEqual([{ moveId, source: { hostId: LAB, threadId: 'lab-1' }, movedTo: { hostId: FORGE, threadId }, machine: 'forge', outcome: 'moved' }])
    expect(moves.view().cards).toEqual([expect.objectContaining({ id: moveId, source: { hostId: LAB, threadId: 'lab-1' }, from: 'lab', machine: 'forge', state: 'source-settled' })])
    // This computer keeps no worktree for a thread that ran on lab.
    expect(moves.keepsWorktree('lab-1')).toBe(false)
    moves.close()
  })
  it('moves a host’s thread to This computer, which makes the thread itself and answers for itself', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.lab.threads[0]!.runtimeMode = 'full-access'
    w.remote.mayAnswer = false
    const prepared = moves.prepare({ threadIds: [labKey], hostId: HERE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    expect(prepared).toMatchObject({ status: 'ok', machine: 'This computer' })
    // Full access here still: This computer lets the user answer, so nothing asks first.
    expect(prepared.threads).toEqual([{ threadId: labKey, outcome: 'moves', model: { name: 'GPT' } }])
    const started = await moves.move({ confirmationId: prepared.confirmationId, threadIds: [labKey], allowNarrower: [] }) as Extract<ThreadMoveStart, { status: 'ok' }>
    const moveId = started.moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    expect(w.local.requests[0]).toMatchObject({ action: 'start', moveId, runtimeMode: 'full-access', from: { threadId: 'lab-1', provider: 'codex', hostId: LAB } })
    expect(w.local.requests[0]!.prompt).toContain('which ran on lab until the user moved it here, to This computer.')
    expect(w.remote.requests).toEqual([])
    const threadId = w.local.made.get(moveId)!
    Object.assign(w.threads.find(thread => thread.id === threadId)!, { status: 'idle', lastTurn: { id: 'turn', status: 'completed' } })
    w.changed()
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('source-settled'))
    expect(w.lab.asked.at(-1)).toMatchObject({ action: 'settle', moveId, link: { threadId, hostId: HERE } })
    expect(moves.view().cards).toEqual([expect.objectContaining({ id: moveId, from: 'lab', here: true, machine: 'This computer' })])
    moves.close()
  })
  it('gives a move back in the host’s own words when it will not hold the thread, and asks it to let go of nothing', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.lab.holdAnswer = { type: 'refused', reason: 'not-movable', message: THREAD_MOVE_WORDS.unresolved }
    const prepared = moves.prepare({ threadIds: [labKey], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    const started = await moves.move({ confirmationId: prepared.confirmationId, threadIds: [labKey], allowNarrower: [] }) as Extract<ThreadMoveStart, { status: 'ok' }>
    const moveId = started.moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('given-back'))
    expect(moves.list()[0]!.givenBack).toBe(THREAD_MOVE_WORDS.givenBack(THREAD_MOVE_WORDS.unresolved, 'lab'))
    expect(w.lab.asked.map(item => item.action)).toEqual(['hold'])
    expect(w.branches.forStart).not.toHaveBeenCalled(); expect(w.remote.requests).toEqual([])
    moves.close()
  })
  it('keeps a thread whose new thread failed on its host, linked, once that host lets go of it, and waits while the host is away', async () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    const prepared = moves.prepare({ threadIds: [labKey], hostId: FORGE }) as Extract<ThreadMovePrepare, { status: 'ok' }>
    const started = await moves.move({ confirmationId: prepared.confirmationId, threadIds: [labKey], allowNarrower: [] }) as Extract<ThreadMoveStart, { status: 'ok' }>
    const moveId = started.moves[0]!.moveId!
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('thread-started'))
    w.lab.connected = false
    w.endTurn(moveId, 'failed')
    await vi.waitFor(() => expect(moves.list()[0]).toMatchObject({ state: 'first-turn-ended', ending: 'stayed' }))
    expect(moves.view().cards[0]).toMatchObject({ id: moveId, waiting: true, waitingOn: 'lab', from: 'lab' })
    expect(w.lab.fences.has('lab-1')).toBe(true)
    w.lab.connected = true; w.reconnected(LAB)
    await vi.waitFor(() => expect(stateOf(moves, moveId)).toBe('stayed'))
    const threadId = w.remote.made.get(moveId)!
    expect(w.lab.asked.at(-1)).toEqual({ action: 'release', moveId, link: { threadId, provider: 'codex', hostId: FORGE, at: expect.any(String) } })
    expect(moves.list()[0]!.givenBack).toBe(THREAD_MOVE_WORDS.stayed('forge', true, 'lab'))
    expect(moves.list()[0]!.ending).toBeUndefined()
    expect(w.news.at(-1)).toMatchObject({ moveId, source: { hostId: LAB, threadId: 'lab-1' }, outcome: 'stayed' })
    moves.close()
  })
  it('says why a host’s thread stays: its host away or too old, or the thread already where it would go', () => {
    const w = world(), moves = w.service(); moves.useTargets(w.targets)
    w.remote.threads.push(source('forge-1'))
    const plan = (threadIds: string[], hostId: string) => (moves.prepare({ threadIds, hostId }) as Extract<ThreadMovePrepare, { status: 'ok' }>).threads
    expect(plan([hostEntityKey(FORGE, 'forge-1'), key('a')], FORGE)).toEqual([
      { threadId: hostEntityKey(FORGE, 'forge-1'), outcome: 'stays', words: THREAD_MOVE_WORDS.already('forge') },
      expect.objectContaining({ threadId: key('a'), outcome: 'moves' }),
    ])
    expect(plan([key('a')], HERE)).toEqual([{ threadId: key('a'), outcome: 'stays', words: THREAD_MOVE_WORDS.already('This computer') }])
    w.lab.supportsSource = false
    expect(plan([labKey], FORGE)).toEqual([{ threadId: labKey, outcome: 'stays', words: THREAD_MOVE_WORDS.olderSource('lab') }])
    w.lab.connected = false
    expect(plan([labKey], FORGE)).toEqual([{ threadId: labKey, outcome: 'stays', words: THREAD_MOVE_WORDS.sourceAway('lab') }])
  })
  it('fences and keeps nothing here for a host’s thread across a restart: its host keeps that', async () => {
    const w = world()
    const at = new Date().toISOString()
    const record: MoveRecord = { id: randomUUID(), sourceThreadId: 'lab-1', sourceHostId: LAB, from: 'lab', held: true, targetHostId: FORGE, machine: 'forge', state: 'fenced',
      start: { provider: 'codex', modelId: model.id, title: 'Thread lab-1' }, watched: false, createdAt: at, updatedAt: at }
    await writeFile(join(directory, 'moves.json'), JSON.stringify({ version: 1, moves: [record] }))
    const moves = w.service(); await moves.load()
    expect(w.fences.size).toBe(0); expect(moves.keepsWorktree('lab-1')).toBe(false)
    const held = await holdUnfinishedMoves(directory, w.control)
    expect(w.fences.size).toBe(0); expect(held.keepsWorktree('lab-1')).toBe(false)
    moves.close()
  })
})
