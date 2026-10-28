// @vitest-environment node
// #1316 part 2, second piece (Owl `cross-machine-work`): a delegated start on another machine may begin from the delegating
// thread's branch, or be a check. The desktop moves the branch, or a check's snapshot, over its own connections first; the
// target machine's own delegation makes the worktree from it, and a check waits in that machine's queue.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DelegationService, RELAY_NO_BRANCH, type DelegationCoordinator, type DelegationServiceOptions, type RelayedCaller } from '../../../src/main/agents/delegation'
import { CheckQueue } from '../../../src/main/agents/checkQueue'
import { HostRemoteCallers, remoteCallerKey } from '../../../src/main/agents/delegationRemoteHost'
import { RelayUnanswered } from '../../../src/main/agents/delegationRelayHost'
import { DesktopRemoteDelegations, type RemoteDelegationConnection } from '../../../src/main/agents/delegationRemoteDesktop'
import type { DelegationNews } from '../../../src/shared/delegation'
import type { DelegationRemoteAsk, RelayedReply } from '../../../src/shared/delegationRelay'
import { relayAwayWords, delegationRelayAskSchema, delegationRemoteAskSchema } from '../../../src/shared/delegationRelay'
import { bringBackTarget } from '../../../src/shared/bringChangesBack'
import { HOST_DESKTOP_FEATURES, HOST_FEATURES } from '../../../src/shared/hostProtocol'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentModel, type AgentThread } from '../../../src/shared/agents'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-branch-elsewhere-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
const folder = async () => { const root = await mkdtemp(join(tmpdir(), 'sotto-branch-elsewhere-')); roots.push(root); return root }
const FORGE = '11111111-1111-4111-8111-111111111111', DESKTOP = '22222222-2222-4222-8222-222222222222', MAC = '33333333-3333-4333-8333-333333333333'
const THERE = '44444444-4444-4444-8444-444444444444'
const MOVE = '66666666-6666-4666-8666-666666666666', PIN = '88888888-8888-4888-8888-888888888888', RESERVED = '99999999-9999-4999-8999-999999999999'
const model = { id: 'model', name: 'Model', providerId: 'codex', ready: true, reasoningEfforts: [], runtimeModes: ['approval-required', 'auto', 'full-access'] } as unknown as AgentModel
const macPlacement = { hostId: MAC, projectId: 'mac-project', receipt: { hostId: MAC, name: 'the Mac', awayFromDefault: false } }
const start = { work: 'code-review', brief: 'Run the tests.', provider: 'codex', model: 'model', permission: 'auto', wait_seconds: 0 }
const snapshot3 = { untracked: ['a.txt', 'b.txt', 'c.txt'], untrackedCount: 3 }

/** A fake of the desktop's branch moves: records each move and each let-go, and lands every branch as feat/x. */
function moves(refuse?: string) {
  const asked: unknown[] = [], forgotten: unknown[] = [], pinned: string[] = []
  return { asked, forgotten, moves: {
    forStart: async (input: { readonly snapshot: boolean; readonly moveId: string }) => {
      asked.push(input)
      return refuse ? { type: 'refused' as const, reason: 'uncommitted' as const, message: refuse }
        : { type: 'moved' as const, moveId: input.moveId, branch: 'feat/x', commit: 'a'.repeat(40), ref: `refs/sotto/incoming/${input.moveId}/feat/x`, ...input.snapshot ? { snapshot: snapshot3 } : {} }
    },
    forgetHere: async (input: unknown) => { forgotten.push({ here: input }) },
    forget: async (input: unknown) => { forgotten.push(input) },
    pin: async (threadId: string) => {
      pinned.push(threadId)
      return refuse ? { type: 'refused' as const, reason: 'uncommitted' as const, message: refuse } : { pinned: PIN, branch: 'feat/x', snapshot: snapshot3 }
    },
  } as unknown as NonNullable<DelegationServiceOptions['branchMoves']>, pinned }
}
/** A fake of the desktop's delegations on its paired hosts, answering each start as `answer` says. */
function remoteOf(answer: () => Promise<Record<string, unknown>>, takes = true, events: string[] = []) {
  const calls: { callerId: string; ask: Record<string, unknown> }[] = [], released: string[] = []
  const remote = { start: async (callerId: string, _work: string, _placement: unknown, ask: Record<string, unknown>) => { events.push('start'); calls.push({ callerId, ask }); return await answer() },
    reservePlace: async () => { events.push('reserve'); return RESERVED }, releasePlace: async (_callerId: string, _hostId: string, reservation: string) => { released.push(reservation) },
    send: async () => ({}), holds: () => false, holdsThread: () => false, read: async () => ({}), cancel: async () => ({}), list: () => [], useDelivery: () => undefined,
    detail: () => undefined, retried: () => undefined, isOpen: () => false, hasOpen: () => false, takesBranches: () => takes } as unknown as NonNullable<DelegationServiceOptions['remote']>
  return { remote, calls, released }
}

/** The desktop's delegation, with one thread of its own on feat/x, and This computer's check queue. */
async function desktop(options: Partial<DelegationServiceOptions>) {
  const root = await folder()
  const thread = { id: 'parent', projectId: 'project', providerId: 'codex', title: 'p', modelId: 'model', status: 'idle', runtimeMode: 'full-access',
    worktree: { mode: 'shared', branch: 'feat/x' }, messages: [{ id: 'parent-ask', role: 'user', text: 'Do it.' }], requests: [] } as unknown as AgentThread
  const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, models: [model], projects: [{ id: 'project', title: 'Project', path: join(root, 'project') }] as never, threads: [thread] }
  const created: Record<string, unknown>[] = []
  const control: DelegationCoordinator = { hostId: () => DESKTOP, watcherSnapshot: () => snapshot, configuration: () => ({ newThreadRuntimeMode: 'auto' }),
    useDelegation: () => () => undefined, commandFromDelegation: async (command, guard) => { guard(); created.push(command as never); if (command.type === 'create-thread') snapshot.threads = [...snapshot.threads, { id: command.threadId, projectId: command.projectId, status: 'idle', messages: [], requests: [] } as never]; return { host: snapshot } as never },
    hasPendingThreadWork: () => false, hasUserDraft: () => false, refreshDelegationObservation: () => undefined, deliverWakeUp: async () => undefined }
  const checks = new CheckQueue('This computer')
  const delegation = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage: () => undefined }, historyEnabled: () => true,
    checks, clockTime: () => '14:02',
    machines: { list: async () => ({}), name: () => 'the Mac', setting: () => 'this-computer', place: async ask => ask.machine === MAC ? macPlacement
      : { status: 'refused', code: 'HOST_DISCONNECTED', message: 'The Mac is not connected.', retryable: true } }, ...options })
  await delegation.recover()
  return { delegation, created, checks, snapshot }
}

describe('a desktop thread\'s start on a paired host from its branch, or as a check', () => {
  it('moves the branch with a snapshot taken now, sends the landed move and test_run, and keeps this desktop as the one that brings it back', async () => {
    const m = moves(), r = remoteOf(async () => ({ status: 'ok', delegation: { id: THERE, outcome: 'working' }, check: { ahead: 1, note: 'Waiting for the Mac\'s check to finish. 1 ahead.' } }))
    const f = await desktop({ branchMoves: m.moves, remote: r.remote })
    // This computer's queue never holds a check placed on the Mac, not even while it is placed.
    const seen: number[] = []
    f.checks.subscribe(() => { seen.push(f.checks.view().length) })
    expect(await f.delegation.delegate('parent', { ...start, machine: MAC, from_my_branch: true, test_run: true })).toMatchObject({ status: 'ok', check: { ahead: 1 } })
    expect(m.asked).toEqual([expect.objectContaining({ from: { hostId: DESKTOP, threadId: 'parent' }, to: { hostId: MAC, projectId: 'mac-project' }, here: DESKTOP, snapshot: true })])
    const moveId = (m.asked[0] as { moveId: string }).moveId
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]!.ask).toMatchObject({ input: { test_run: true }, branch: { moveId, branch: 'feat/x', snapshot: snapshot3, takenAt: '14:02',
      madeFrom: { thread: 'parent', host: DESKTOP, by: DESKTOP } } })
    expect(r.calls[0]!.ask.input).not.toHaveProperty('from_my_branch')
    // What crosses the socket is what the host's schema takes.
    expect(delegationRemoteAskSchema.safeParse({ type: 'delegate', caller: 'parent', levels: 0, rootUserMessageId: 'parent-ask', runtimeMode: 'auto', projectId: 'mac-project',
      input: r.calls[0]!.ask.input, waitMs: 0, branch: r.calls[0]!.ask.branch }).success).toBe(true)
    expect(f.checks.view()).toEqual([])
    expect(seen.every(count => count === 0)).toBe(true)
    expect(m.forgotten).toEqual([])
  })

  it('lets go of the branch on the host when the host refuses the start, or was away so nothing was asked', async () => {
    let answer: () => Promise<Record<string, unknown>> = async () => ({ status: 'refused', code: 'PERMISSION_TOO_WIDE', message: 'Too wide.' })
    const m = moves(), r = remoteOf(() => answer())
    const f = await desktop({ branchMoves: m.moves, remote: r.remote })
    expect(await f.delegation.delegate('parent', { ...start, machine: MAC, from_my_branch: true })).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
    const first = (m.asked[0] as { moveId: string }).moveId
    expect(m.forgotten).toEqual([{ hostId: MAC, projectId: 'mac-project', moveId: first, here: DESKTOP }])
    answer = async () => { throw new RelayUnanswered('away') }
    expect(await f.delegation.delegate('parent', { ...start, machine: MAC, from_my_branch: true })).toMatchObject({ status: 'refused', code: 'MACHINE_UNAVAILABLE' })
    expect(m.forgotten).toHaveLength(2)
    // A lost answer may have started it there: the branch stays.
    answer = async () => ({ status: 'ok', delegation: { id: THERE, outcome: 'unknown' } })
    await f.delegation.delegate('parent', { ...start, machine: MAC, from_my_branch: true })
    expect(m.forgotten).toHaveLength(2)
  })

  it('refuses a branch that cannot move, and asks the host nothing', async () => {
    const m = moves('A submodule in this thread has uncommitted changes, and a check can\'t carry them. Commit them inside the submodule first, then start again. Nothing was started.')
    const r = remoteOf(async () => ({ status: 'ok' }))
    const f = await desktop({ branchMoves: m.moves, remote: r.remote })
    expect(await f.delegation.delegate('parent', { ...start, machine: MAC, from_my_branch: true, test_run: true }))
      .toMatchObject({ status: 'refused', code: 'BRANCH_UNAVAILABLE', message: expect.stringContaining('A submodule in this thread') })
    expect(r.calls).toEqual([])
  })

  it('sends a check without a branch to the host\'s own queue, moving nothing', async () => {
    const m = moves(), r = remoteOf(async () => ({ status: 'ok', delegation: { id: THERE, outcome: 'working' } }))
    const f = await desktop({ branchMoves: m.moves, remote: r.remote })
    await f.delegation.delegate('parent', { ...start, machine: MAC, test_run: true })
    expect(m.asked).toEqual([])
    expect(r.calls[0]!.ask).toMatchObject({ input: { test_run: true } })
    expect(r.calls[0]!.ask).not.toHaveProperty('branch')
  })
})

describe('one check queue per machine, in the order asked (Sol review)', () => {
  it('holds the check\'s place in the host\'s queue before its snapshot moves there, and gives it up when the move is refused', async () => {
    const events: string[] = []
    const m = moves(), r = remoteOf(async () => ({ status: 'ok', delegation: { id: THERE, outcome: 'working' } }), true, events)
    const forStart = m.moves.forStart.bind(m.moves)
    m.moves.forStart = async input => { events.push('move'); return await forStart(input) }
    const f = await desktop({ branchMoves: m.moves, remote: r.remote })
    await f.delegation.delegate('parent', { ...start, machine: MAC, from_my_branch: true, test_run: true })
    expect(events).toEqual(['reserve', 'move', 'start'])
    expect(r.calls[0]!.ask).toMatchObject({ reservation: RESERVED })
    expect(r.released).toEqual([])
    const refusing = moves('A submodule in this thread has uncommitted changes, and a check can\'t carry them. Commit them inside the submodule first, then start again. Nothing was started.')
    const g = await desktop({ branchMoves: refusing.moves, remote: r.remote })
    expect(await g.delegation.delegate('parent', { ...start, machine: MAC, from_my_branch: true, test_run: true })).toMatchObject({ status: 'refused', code: 'BRANCH_UNAVAILABLE' })
    expect(r.released).toEqual([RESERVED])
  })

  it('puts a check whose place was reserved before its branch moved ahead of one asked on the host while it moved', async () => {
    const root = await folder()
    const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, models: [model], projects: [{ id: 'mac-project', title: 'Project', path: join(root, 'project') }] as never, threads: [] }
    const created: Record<string, unknown>[] = []
    const control: DelegationCoordinator = { hostId: () => MAC, watcherSnapshot: () => snapshot, configuration: () => ({}),
      useDelegation: () => () => undefined, commandFromDelegation: async (command, guard) => { guard(); created.push(command as never); if (command.type === 'create-thread') snapshot.threads = [...snapshot.threads, { id: command.threadId, projectId: command.projectId, status: 'idle', messages: [], requests: [] } as never]; return { host: snapshot } as never },
      hasPendingThreadWork: () => false, hasUserDraft: () => false, refreshDelegationObservation: () => undefined, deliverWakeUp: async () => undefined }
    const callers = new HostRemoteCallers(root), checks = new CheckQueue('the Mac')
    const delegation = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage: () => undefined }, historyEnabled: () => true,
      newThreadCeiling: () => ({ mode: 'full-access' }), relayedCallers: callers, hereName: () => 'the Mac', checks, branchMoves: moves().moves, clockTime: () => '9:15 AM' })
    await delegation.recover()
    callers.useDelegation(delegation)
    const ask = (caller: string, extra: Record<string, unknown> = {}) => delegationRemoteAskSchema.parse({ type: 'delegate', caller, projectId: 'mac-project',
      levels: 0, rootUserMessageId: 'root', runtimeMode: 'auto', input: { ...start, test_run: true }, waitMs: 0, ...extra })
    // The desktop reserves the first check's place, then moves its snapshot; meanwhile a second check is asked here.
    expect(await callers.answer('desktop-a', { type: 'reserve', caller: 'parent', reservation: RESERVED, work: 'code-review' })).toEqual({ status: 'ok' })
    expect(await callers.answer('desktop-a', ask('other'))).toMatchObject({ status: 'ok', delegation: { check: { ahead: 1 } } })
    // The first arrives once its snapshot landed, takes its reserved place, and starts at once.
    const first = await callers.answer('desktop-a', ask('parent', { reservation: RESERVED, branch: { moveId: MOVE, branch: 'feat/x', madeFrom: { thread: 'parent', host: DESKTOP, by: DESKTOP } } }))
    expect(first).toMatchObject({ status: 'ok' })
    expect((first as { delegation: object }).delegation).not.toHaveProperty('check')
    expect(created[0]).toMatchObject({ type: 'create-thread', startFromMove: MOVE, check: true })
    // A place reserved by a desktop whose socket then closes is let go.
    const desktopA = { clientId: 'desktop-a', push: () => true }
    callers.desktopConnected(desktopA)
    const before = checks.ids().length
    await callers.answer('desktop-a', { type: 'reserve', caller: 'parent', reservation: PIN, work: 'code-review' })
    expect(checks.ids()).toHaveLength(before + 1)
    callers.desktopGone(desktopA)
    expect(checks.ids()).toHaveLength(before)
    delegation.close()
  })

  it('holds a check that names this machine in place from when it is asked, while it is placed', async () => {
    let placed: (() => void) | undefined
    const here = { hostId: DESKTOP, projectId: 'project', receipt: { hostId: DESKTOP, name: 'This computer', awayFromDefault: false } }
    const f = await desktop({ machines: { list: async () => ({}), name: () => 'This computer', setting: () => 'this-computer',
      place: ask => ask.machine === DESKTOP ? new Promise(resolve => { placed = () => resolve(here) }) : Promise.resolve(here) } })
    const named = f.delegation.delegate('parent', { ...start, machine: DESKTOP, test_run: true, title: 'Named' })
    await expect.poll(() => placed).toBeDefined()
    // Not shown while it may still go elsewhere.
    expect(f.checks.view()).toEqual([])
    const later = await f.delegation.delegate('parent', { ...start, test_run: true, title: 'Later' })
    expect(later).toMatchObject({ status: 'ok', delegation: { check: { ahead: 1 } } })
    placed!()
    const first = await named
    expect(first).toMatchObject({ status: 'ok' })
    expect((first as { delegation: object }).delegation).not.toHaveProperty('check')
    expect(f.checks.view().map(entry => entry.title)).toEqual(['Named', 'Later'])
  })
})

describe('a host\'s start from a branch the desktop landed there', () => {
  async function host() {
    const root = await folder()
    const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, models: [model], projects: [{ id: 'mac-project', title: 'Project', path: join(root, 'project') }] as never, threads: [] }
    const created: Record<string, unknown>[] = []
    const control: DelegationCoordinator = { hostId: () => MAC, watcherSnapshot: () => snapshot, configuration: () => ({}),
      useDelegation: () => () => undefined, commandFromDelegation: async (command, guard) => { guard(); created.push(command as never); if (command.type === 'create-thread') snapshot.threads = [...snapshot.threads, { id: command.threadId, projectId: command.projectId, status: 'idle', messages: [], requests: [] } as never]; return { host: snapshot } as never },
      hasPendingThreadWork: () => false, hasUserDraft: () => false, refreshDelegationObservation: () => undefined, deliverWakeUp: async () => undefined }
    const m = moves()
    const callers = new HostRemoteCallers(root)
    const checks = new CheckQueue('the Mac')
    const delegation = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage: () => undefined }, historyEnabled: () => true,
      newThreadCeiling: () => ({ mode: 'full-access' }), relayedCallers: callers, hereName: () => 'the Mac', checks, branchMoves: m.moves, clockTime: () => '9:15 AM' })
    await delegation.recover()
    callers.useDelegation(delegation)
    return { callers, created, checks, m }
  }
  const ask = (input: Record<string, unknown>, branch?: Record<string, unknown>) => delegationRemoteAskSchema.parse({ type: 'delegate', caller: 'parent', projectId: 'mac-project',
    levels: 0, rootUserMessageId: 'parent-ask', runtimeMode: 'auto', input: { ...start, wait_seconds: 0, ...input }, waitMs: 0, ...branch ? { branch } : {} })
  const landed = { moveId: MOVE, branch: 'feat/x', snapshot: snapshot3, takenAt: '14:02', madeFrom: { thread: 'parent', host: DESKTOP, by: DESKTOP } }

  it('makes the worktree from the landed move as a check in its own queue, keeping the desktop that moved it, and says so in its own name', async () => {
    const f = await host()
    const answer = await f.callers.answer('desktop-a', ask({ test_run: true }, landed))
    expect(answer).toMatchObject({ status: 'ok', startedFrom: { hostId: MAC, name: 'the Mac', branch: 'feat/x',
      note: 'Started on the Mac from feat/x with your uncommitted changes as they were at 14:02 (3 untracked files).' } })
    expect(f.created[0]).toEqual(expect.objectContaining({ type: 'create-thread', projectId: 'mac-project', workingCopy: 'independent', startFromMove: MOVE, check: true,
      madeFrom: { thread: 'parent', host: DESKTOP, by: DESKTOP } }))
    // Its own move was made on the desktop: nothing is moved here.
    expect(f.m.asked).toEqual([])
    expect(f.checks.view()).toHaveLength(1)
  })

  it('lets go of the landed move here when the start is refused', async () => {
    const f = await host()
    expect(await f.callers.answer('desktop-a', ask({ model: 'missing' }, landed))).toMatchObject({ status: 'refused' })
    expect(f.created).toEqual([])
    expect(f.m.forgotten).toEqual([{ here: { projectId: 'mac-project', moveId: MOVE } }])
  })

  it('refuses a landed move for a caller it does not hold, and makes nothing', async () => {
    const f = await host()
    const service = (f.callers as unknown as { delegation: DelegationService }).delegation
    expect(await service.delegate(remoteCallerKey('desktop-a', 'nobody'), { ...start }, { landed })).toMatchObject({ status: 'refused', code: 'NOT_ADMITTED' })
    expect(f.created).toEqual([])
  })
})

describe('a thread on a host starting elsewhere from its branch, through the desktop', () => {
  let clock = '9:15 AM'
  const relayOf = (carries: boolean, reachable = true) => {
    const asked: Record<string, unknown>[] = []
    const relay = { start: async (_callerId: string, _work: string, ask: Record<string, unknown>) => { asked.push(ask); return { status: 'ok', delegation: { id: THERE, outcome: 'working' } } },
      holds: () => false, holdsThread: () => false, read: async () => ({}), cancel: async () => ({}), list: () => [], useDelivery: () => undefined, awayWords: () => relayAwayWords('forge'),
      detail: () => undefined, send: async () => ({}), reachable: () => reachable, carriesBranches: () => carries } as unknown as NonNullable<DelegationServiceOptions['relay']>
    return { relay, asked }
  }
  async function forge(relay: NonNullable<DelegationServiceOptions['relay']>, branchMoves?: NonNullable<DelegationServiceOptions['branchMoves']>) {
    const root = await folder()
    const thread = { id: 'parent', projectId: 'project', providerId: 'codex', title: 'p', modelId: 'model', status: 'idle', runtimeMode: 'full-access',
      messages: [{ id: 'parent-ask', role: 'user', text: 'Do it.' }], requests: [] } as unknown as AgentThread
    const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, models: [model], projects: [{ id: 'project', title: 'Project', path: join(root, 'project') }] as never, threads: [thread] }
    const control: DelegationCoordinator = { hostId: () => FORGE, watcherSnapshot: () => snapshot, configuration: () => ({}), useDelegation: () => () => undefined,
      commandFromDelegation: async () => ({ host: snapshot }) as never, hasPendingThreadWork: () => false, hasUserDraft: () => false, refreshDelegationObservation: () => undefined, deliverWakeUp: async () => undefined }
    const checks = new CheckQueue('forge')
    const delegation = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage: () => undefined }, historyEnabled: () => true,
      newThreadCeiling: () => ({ mode: 'full-access' }), checks, clockTime: () => clock, relay, ...branchMoves ? { branchMoves } : {},
      machines: { list: async () => ({}), name: () => 'This computer', setting: () => 'this-computer',
        place: async () => ({ hostId: DESKTOP, projectId: 'desktop-project', receipt: { hostId: DESKTOP, name: 'This computer', awayFromDefault: false } }) } })
    await delegation.recover()
    return { delegation, checks }
  }

  it('takes and pins the check snapshot on forge as its thread asks, then asks the desktop with it, and holds no place in forge\'s queue', async () => {
    const r = relayOf(true), m = moves()
    // The pin takes a moment; the time said is when it was taken, in forge's format.
    const pin = m.moves.pin.bind(m.moves)
    m.moves.pin = async threadId => { const pinned = await pin(threadId); clock = '9:16 AM'; return pinned }
    const f = await forge(r.relay, m.moves)
    clock = '9:15 AM'
    await f.delegation.delegate('parent', { ...start, machine: DESKTOP, from_my_branch: true, test_run: true })
    expect(m.pinned).toEqual(['parent'])
    expect(m.asked).toEqual([])
    expect(r.asked).toEqual([expect.objectContaining({ pinned: PIN, takenAt: '9:16 AM', input: expect.objectContaining({ from_my_branch: true, test_run: true }) })])
    expect(f.checks.view()).toEqual([])
    expect(delegationRelayAskSchema.safeParse({ type: 'start', relayId: THERE, threadId: 'parent', ...r.asked[0] }).success).toBe(true)
  })

  it('refuses a check whose snapshot cannot be taken on forge as it asks, and asks the desktop nothing', async () => {
    const r = relayOf(true), m = moves('A submodule in this thread has uncommitted changes, and a check can\'t carry them. Commit them inside the submodule first, then start again. Nothing was started.')
    const f = await forge(r.relay, m.moves)
    expect(await f.delegation.delegate('parent', { ...start, machine: DESKTOP, from_my_branch: true, test_run: true }))
      .toMatchObject({ status: 'refused', code: 'BRANCH_UNAVAILABLE', message: expect.stringContaining('A submodule in this thread') })
    expect(r.asked).toEqual([])
  })

  it('refuses before asking a desktop from before it, and says the desktop is away when none is connected', async () => {
    const old = relayOf(false)
    const f = await forge(old.relay)
    expect(await f.delegation.delegate('parent', { ...start, machine: DESKTOP, from_my_branch: true })).toMatchObject({ status: 'refused', code: 'BRANCH_UNAVAILABLE', message: RELAY_NO_BRANCH })
    expect(old.asked).toEqual([])
  })
})

describe('the desktop starting a relayed thread\'s branch', () => {
  const caller: RelayedCaller = { id: `host:${FORGE}:forge-parent`, projectId: 'project', runtimeMode: 'full-access', levels: 0, rootUserMessageId: 'forge-ask' }
  const relayedCallers = { caller: (threadId: string) => threadId === caller.id ? caller : undefined, tell: async () => undefined }

  it('moves it from forge to This computer, with forge\'s time, and keeps forge\'s thread and this desktop on the new worktree', async () => {
    const m = moves()
    const f = await desktop({ branchMoves: m.moves, relayedCallers })
    const answer = await f.delegation.delegate(caller.id, { ...start, from_my_branch: true, test_run: true }, { takenAt: '9:15 AM', pinned: PIN })
    expect(answer).toMatchObject({ status: 'ok', startedFrom: { note: 'Started on This computer from feat/x with your uncommitted changes as they were at 9:15 AM (3 untracked files).' } })
    expect(m.asked).toEqual([expect.objectContaining({ from: { hostId: FORGE, threadId: 'forge-parent' }, to: { hostId: DESKTOP, projectId: 'project' }, snapshot: true, pinned: PIN })])
    expect(f.created[0]).toEqual(expect.objectContaining({ startFromMove: (m.asked[0] as { moveId: string }).moveId, check: true, madeFrom: { thread: 'forge-parent', host: FORGE, by: DESKTOP } }))
  })

  it('moves the snapshot forge pinned to a third machine, never a new one', async () => {
    const m = moves(), r = remoteOf(async () => ({ status: 'ok', delegation: { id: THERE, outcome: 'working' } }))
    const f = await desktop({ branchMoves: m.moves, relayedCallers, remote: r.remote })
    await f.delegation.delegate(caller.id, { ...start, from_my_branch: true, test_run: true }, { pinned: PIN, takenAt: '9:15 AM', placement: macPlacement })
    expect(m.asked).toEqual([expect.objectContaining({ to: { hostId: MAC, projectId: 'mac-project' }, snapshot: true, pinned: PIN })])
  })

  it('moves it from forge to a third machine, and sends that host the landed move', async () => {
    const m = moves(), r = remoteOf(async () => ({ status: 'ok', delegation: { id: THERE, outcome: 'working' } }))
    const f = await desktop({ branchMoves: m.moves, relayedCallers, remote: r.remote })
    await f.delegation.delegate(caller.id, { ...start, from_my_branch: true }, { placement: macPlacement, takenAt: '9:15 AM' })
    expect(m.asked).toEqual([expect.objectContaining({ from: { hostId: FORGE, threadId: 'forge-parent' }, to: { hostId: MAC, projectId: 'mac-project' }, snapshot: false })])
    expect(r.calls[0]!.ask).toMatchObject({ branch: { branch: 'feat/x', madeFrom: { thread: 'forge-parent', host: FORGE, by: DESKTOP } } })
    expect(f.created).toEqual([])
  })
})

/** A paired host as the desktop's router holds it, answering each ask as `answer` says and pushing news when told. */
function pairedHost(answer: (ask: DelegationRemoteAsk) => unknown | Promise<unknown>) {
  const asked: DelegationRemoteAsk[] = []
  let listener: ((caller: string, news: DelegationNews, replies: readonly RelayedReply[]) => void) | undefined
  const connection: RemoteDelegationConnection = { hostId: MAC, kind: 'remote', service: { supportsDelegationRemote: true, supportsDelegationBranchStarts: true,
    delegationRemoteAsk: async ask => { asked.push(ask); return await answer(ask) },
    subscribeDelegationRemoteNews: given => { listener = given; return () => undefined } } }
  const connected = [connection]
  let connects: ((given: RemoteDelegationConnection) => void) | undefined
  const source = { subscribeConnected: (given: (item: RemoteDelegationConnection) => void) => { connects = given; return () => undefined }, remoteConnections: () => connected }
  return { connection, asked, source, push: (caller: string, news: DelegationNews) => listener!(caller, news, []),
    reconnect: () => { connected.length = 0; connected.push(connection); connects!(connection) } }
}
const remoteAsk = { levels: 0, rootUserMessageId: 'root-1', runtimeMode: 'auto' as const, input: { work: 'code-review', brief: 'Review it.' }, waitMs: 0 }
const landedOnMac = { moveId: MOVE, branch: 'feat/x', snapshot: snapshot3, takenAt: '14:02', madeFrom: { thread: 'parent', host: DESKTOP, by: DESKTOP } }

describe('the desktop\'s record of a start from a branch on a paired host', () => {
  it('keeps where the start began when its call waits and the child finishes in the wait (Sol review)', async () => {
    const startedFrom = { hostId: MAC, name: 'the Mac', branch: 'feat/x', snapshot: snapshot3, note: 'Started on the Mac from feat/x with your uncommitted changes as they were at 14:02 (3 untracked files).' }
    let outcome = 'working'
    const mac = pairedHost(ask => ask.type === 'read' ? { status: 'ok', delegation: { id: THERE, thread: 'child-mac', outcome } }
      : { status: 'ok', delegation: { id: THERE, thread: 'child-mac', outcome: 'working' }, startedFrom })
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac' })
    remote.useDelivery(async () => undefined)
    remote.useHosts(mac.source)
    const waiting = remote.start('parent', 'code-review', macPlacement, { ...remoteAsk, waitMs: 60_000, branch: landedOnMac })
    await expect.poll(() => mac.asked.length).toBe(1)
    outcome = 'answered'
    mac.push('parent', { source: 'delegation', items: [{ delegationId: THERE, threadId: 'child-mac', outcome: 'answered' }] })
    expect(await waiting).toMatchObject({ status: 'ok', delegation: { outcome: 'answered' }, startedFrom })
    expect(mac.asked.map(ask => ask.type)).toEqual(['delegate', 'read'])
  })
  it('lets go of the branch landed for a start whose answer was lost only once an exact read proves no thread owns it (Sol review)', async () => {
    let read: () => unknown = () => { throw new Error('The socket closed.') }
    const mac = pairedHost(ask => { if (ask.type === 'delegate') throw new Error('The socket closed.'); return read() })
    const letGo: unknown[] = []
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac', letGo: async landed => { letGo.push(landed) } })
    remote.useDelivery(async () => undefined)
    remote.useHosts(mac.source)
    expect(await remote.start('parent', 'code-review', macPlacement, { ...remoteAsk, branch: landedOnMac })).toMatchObject({ delegation: { outcome: 'unknown' } })
    // Still being admitted there: it may yet own the branch, so the branch stays.
    read = () => ({ status: 'refused', code: 'UNKNOWN_DELEGATION', message: 'Still admitting.', admitting: true })
    mac.reconnect()
    await expect.poll(() => mac.asked.length).toBe(2)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(letGo).toEqual([])
    // Proved never made: nothing owns the branch landed for it, so it is let go of there, once.
    read = () => ({ status: 'refused', code: 'UNKNOWN_DELEGATION', message: 'None.', absent: true })
    mac.reconnect()
    await expect.poll(() => letGo).toEqual([{ hostId: MAC, projectId: 'mac-project', moveId: MOVE }])
    mac.reconnect()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(letGo).toHaveLength(1)
    remote.close()
  })

  it('lets go of the queue place held for a start whose answer was lost once an exact read proves it was never made (Sol re-check)', async () => {
    let read: () => unknown = () => { throw new Error('The socket closed.') }
    const mac = pairedHost(ask => {
      if (ask.type === 'delegate') throw new Error('The socket closed.')
      return ask.type === 'release' ? { status: 'ok' } : read()
    })
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac', letGo: async () => undefined })
    remote.useDelivery(async () => undefined)
    remote.useHosts(mac.source)
    await remote.start('parent', 'code-review', macPlacement, { ...remoteAsk, input: { ...remoteAsk.input, test_run: true }, branch: landedOnMac, reservation: RESERVED })
    // Still being admitted there: the place stays.
    read = () => ({ status: 'refused', code: 'UNKNOWN_DELEGATION', message: 'Still admitting.', admitting: true })
    mac.reconnect()
    await expect.poll(() => mac.asked.length).toBe(2)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mac.asked.filter(ask => ask.type === 'release')).toEqual([])
    read = () => ({ status: 'refused', code: 'UNKNOWN_DELEGATION', message: 'None.', absent: true })
    mac.reconnect()
    await expect.poll(() => mac.asked.filter(ask => ask.type === 'release')).toEqual([{ type: 'release', caller: 'parent', reservation: RESERVED }])
    remote.close()
  })

  it('leaves the branch to the host once the host names the delegation that owns it', async () => {
    const mac = pairedHost(ask => ask.type === 'delegate' ? { status: 'ok', delegation: { id: THERE, thread: 'child-mac', outcome: 'working' } }
      : { status: 'refused', code: 'UNKNOWN_DELEGATION', message: 'None.' })
    const letGo: unknown[] = []
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac', letGo: async landed => { letGo.push(landed) } })
    remote.useDelivery(async () => undefined)
    remote.useHosts(mac.source)
    await remote.start('parent', 'code-review', macPlacement, { ...remoteAsk, branch: landedOnMac })
    mac.reconnect()
    await expect.poll(() => mac.asked.length).toBe(2)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(letGo).toEqual([])
    remote.close()
  })
})

describe('two calls racing with one retry key for a start from a branch on a paired host', () => {
  it('lets go of the branch the second call landed, which no thread uses, and makes one delegation (Sol review)', async () => {
    const m = moves()
    const mac = pairedHost(() => ({ status: 'ok', delegation: { id: THERE, thread: 'child-mac', outcome: 'working' } }))
    const remote = new DesktopRemoteDelegations(await folder(), { machineName: () => 'the Mac',
      letGo: landed => m.moves.forget({ ...landed, here: DESKTOP }) })
    remote.useDelivery(async () => undefined)
    remote.useHosts(mac.source)
    const f = await desktop({ branchMoves: m.moves, remote })
    const call = { ...start, machine: MAC, from_my_branch: true, retry_key: '77777777-7777-4777-8777-777777777777' }
    const [first, second] = await Promise.all([f.delegation.delegate('parent', call), f.delegation.delegate('parent', call)])
    expect((first as { delegation: { id: string } }).delegation.id).toBe((second as { delegation: { id: string } }).delegation.id)
    expect(m.asked).toHaveLength(2)
    const delegates = mac.asked.filter(ask => ask.type === 'delegate')
    expect(delegates).toHaveLength(1)
    const used = (delegates[0] as { branch: { moveId: string } }).branch.moveId
    const unused = (m.asked as { moveId: string }[]).map(item => item.moveId).find(moveId => moveId !== used)
    expect(m.forgotten).toEqual([{ hostId: MAC, projectId: 'mac-project', moveId: unused, here: DESKTOP }])
    remote.close()
  })
})

describe('who brings a remote child\'s changes back (#1030)', () => {
  it('offers it only on the desktop that started the worker', () => {
    const parent = { id: `host:${FORGE}:forge-parent`, hostId: FORGE, worktree: { mode: 'independent', status: 'ready', path: '/p', branch: 'feat/x' } }
    const child = { id: `host:${MAC}:child`, hostId: MAC, worktree: { mode: 'independent', status: 'ready', path: '/c', branch: 'sotto/abc',
      incomingRef: `refs/sotto/incoming/${MOVE}/feat/x`, madeFrom: { thread: 'forge-parent', host: FORGE, by: DESKTOP } } }
    const threads = [parent, child] as never
    expect(bringBackTarget(child as never, threads, DESKTOP)).toMatchObject({ parentId: parent.id, target: 'feat/x', away: true })
    expect(bringBackTarget(child as never, threads, '77777777-7777-4777-8777-777777777777')).toBeNull()
  })
})

describe('the feature', () => {
  it('is a host feature a desktop accepts', () => {
    expect(HOST_FEATURES).toContain('delegation-branch-starts')
    expect(HOST_DESKTOP_FEATURES).toContain('delegation-branch-starts')
  })
})
