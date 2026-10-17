// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WatcherService } from '../../../src/main/agents/watcher'
import type { AgentControl } from '../../../src/main/agents/control'
import type { AgentHostCommand } from '../../../src/main/agents/host'
import type { WorkspaceHost } from '../../../src/main/agents/workspace'
import { markThreadsRead, READ_DISPATCH_MAX_MS, recordDispatch, trackDispatches } from '../../../src/main/agents/watcherReadMarks'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { AgentHostSnapshot, AgentThread } from '../../../src/shared/agents'
import { emptyWatcherRecord, watcherRecordSchema, type WatcherRecord } from '../../../src/shared/watcher'
import { watcherDispatchBefore, type WatcherDispatchBefore, type WatcherRemoteHosts } from '../../../src/shared/watcherHost'
import { agentControlFixture } from '../../fixtures/agentControlFixture'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const HOST = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const AT = '2026-10-17T10:00:00.000Z'
const target = (threadId: string, hostId = HOST) => ({ hostId, threadId })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

type Request = AgentThread['requests'][number]
function thread(id: string, patch: Partial<AgentThread> = {}): AgentThread {
  return { id, projectId: 'project', title: id, modelId: 'codex:gpt', providerId: 'codex', status: 'idle', messages: [], requests: [], ...patch }
}
const turn = (id: string, status: NonNullable<AgentThread['lastTurn']>['status'], extra: Partial<AgentThread> = {}) =>
  ({ ...extra, ...status === 'running' ? { status: 'running' as const } : status === 'failed' ? { status: 'error' as const } : {}, lastTurn: { id, status, ...extra.lastTurn } })
const card = (id: string, kind: Request['kind'] = 'question'): Request => ({ id, kind, text: kind === 'question' ? 'Which port?' : 'Run the suite?' } as Request)

/**
 * Watcher's service over a stand-in coordinator whose record and threads live here, as main's own keep them. `send` is a
 * dispatch through the coordinator's own hooks, as every send this computer makes goes; `pass` is one observation.
 */
function service(options: { record?: WatcherRecord; remote?: AgentThread[] } = {}) {
  let record = options.record ?? emptyWatcherRecord()
  let threads: AgentThread[] = []
  let remoteThreads = options.remote ?? []
  let notify: ((target: { hostId: string; threadId: string }, before: WatcherDispatchBefore) => void) | undefined
  const providers = (['codex', 'claude', 'grok'] as const).map(id => ({ id, connection: 'connected' }))
  const local = (): AgentHostSnapshot => ({ ...emptyDesktopState(HOST).host, connected: true, providers, threads } as AgentHostSnapshot)
  let writes = 0
  const update = (change: (next: WatcherRecord) => void): void => { const next = structuredClone(record); change(next); record = watcherRecordSchema.parse(next) }
  const control = {
    watcherRecord: () => structuredClone(record), watcherRecordView: () => record, watcherSnapshot: local, hostId: () => HOST,
    useWatcher: () => () => undefined, subscribe: () => () => undefined, refreshWatcherObservation: () => undefined,
    updateWatcher: async (change: (next: WatcherRecord) => void) => { writes++; update(change) }, mutateWatcher: update,
    restoredWatcherEvents: () => [], watcherWakeUpQueued: () => false, canDeliverWatcherNews: () => false, pruneWatcherWakeUps: async () => undefined,
    deliverWakeUp: async () => undefined, watcherSendRecords: () => ({ deliveries: [], followups: [] }), hasPendingThreadWork: () => false,
    configuration: () => ({}), cancelWatcherQueue: async () => undefined,
  } as unknown as AgentControl
  const watcher = new WatcherService({ directory: '', control, host: {} as WorkspaceHost, limit: () => 4, historyEnabled: () => false })
  cleanups.push(async () => watcher.close())
  if (options.remote) {
    const remote = { hosts: () => [{ hostId: REMOTE, control: false, reads: false, connected: true, permissionCeiling: 'approval-required' as const }],
      snapshot: (id: string) => id === REMOTE ? { ...emptyDesktopState(REMOTE).host, hostId: REMOTE, connected: true, providers: [{ id: 'codex', connection: 'connected' }],
        threads: remoteThreads.map(item => ({ ...item, hostId: REMOTE })) } as AgentHostSnapshot : undefined,
      subscribe: () => () => undefined, subscribeDispatches: (listener: typeof notify) => { notify = listener; return () => { notify = undefined } },
      read: async () => { throw new Error('No reads here.') }, control: async () => { throw new Error('No control here.') } } as unknown as WatcherRemoteHosts
    watcher.useRemoteHosts(remote)
  }
  watcher.wakes.start()
  return {
    watcher, record: () => record, writes: () => writes,
    pass(...next: AgentThread[]): void { threads = next; watcher.wakes.observe() },
    remotePass(...next: AgentThread[]): void { remoteThreads = next; watcher.wakes.observe() },
    /** A send through the coordinator: read before it goes, then dispatched once the provider took it. */
    send(threadId: string, messageId = randomUUID(), wakeUp = false): string {
      const command = { type: 'send', commandId: randomUUID(), threadId, messageId, text: 'Synthetic instruction', ...wakeUp ? { wakeUp: true } : {} } as AgentHostCommand
      watcher.beforeDispatch(command, undefined)
      watcher.dispatched(command)
      return messageId
    },
    /** A steer into the thread's running turn, through the same hooks. */
    steer(threadId: string, messageId = randomUUID()): string {
      const command = { type: 'steer', commandId: randomUUID(), threadId, messageId, text: 'Synthetic steer' } as AgentHostCommand
      watcher.beforeDispatch(command, undefined)
      watcher.dispatched(command)
      return messageId
    },
    /** This desktop routing a send to a paired host's thread, told of it once the host took it, with the thread as it was before. */
    routed(threadId: string, before = remoteThreads.find(item => item.id === threadId)): void { notify?.({ hostId: REMOTE, threadId }, watcherDispatchBefore(before)) },
    marks: () => (watcher.state().readMarks ?? []).map(mark => [mark.target.threadId, mark.kind]),
  }
}

describe('read marks come from Sotto’s own dispatches', () => {
  it('give no mark for news no dispatch brought: Sol’s four sequences', () => {
    const room = service()
    // A fork whose provenance arrives after its empty row, then its copied conversation with a finished turn.
    room.pass(thread('fork'))
    room.pass(thread('fork', { startedFrom: { threadId: 'source', from: 'turn', route: 'fork', at: AT } }))
    room.pass(thread('fork', { startedFrom: { threadId: 'source', from: 'turn', route: 'fork', at: AT }, ...turn('copied', 'completed') }))
    // Codex loading an unwatched thread's old turns late, after an owl press.
    room.pass(thread('fork', { startedFrom: { threadId: 'source', from: 'turn', route: 'fork', at: AT }, ...turn('copied', 'completed') }), thread('old'))
    room.pass(thread('fork', { startedFrom: { threadId: 'source', from: 'turn', route: 'fork', at: AT }, ...turn('copied', 'completed') }), thread('old', turn('old-turn', 'completed')))
    // A Grok permission reload: briefly an error, then idle on the same turn.
    room.pass(thread('grok', { providerId: 'grok', ...turn('t0', 'completed') }))
    room.pass(thread('grok', { providerId: 'grok', status: 'error', lastTurn: { id: 't0', status: 'failed' } }))
    room.pass(thread('grok', { providerId: 'grok', ...turn('t0', 'completed') }))
    expect(room.marks()).toEqual([])
  })

  it('marks a Claude import’s real first turn that fails, since Sotto dispatched it', () => {
    const room = service()
    // Claude imports a whole conversation without a turn record: no news yet, and nothing marks.
    room.pass(thread('claude', { providerId: 'claude' }))
    room.pass(thread('claude', { providerId: 'claude', messages: [{ id: 'old', role: 'assistant', text: 'Imported.', createdAt: AT }] }))
    const sent = room.send('claude')
    // The real first turn fails between two batched observations.
    room.pass(thread('claude', { providerId: 'claude', status: 'error', lastTurn: { id: 'uuid-1', status: 'failed', messageId: sent } }))
    expect(room.marks()).toEqual([['claude', 'failed']])
  })

  it('marks a question or permission during a dispatched turn, an immediate failure and a turn hidden between batched updates', () => {
    const room = service()
    room.pass(thread('asks', turn('t0', 'completed')), thread('allows', turn('t0', 'completed')), thread('fails', turn('t0', 'completed')), thread('batched', turn('t0', 'completed')))
    for (const id of ['asks', 'allows', 'fails', 'batched']) room.send(id)
    // The card arrives while the thread still reads idle; the failure and the whole hidden turn show only as their ends.
    room.pass(thread('asks', { ...turn('t0', 'completed'), requests: [card('q1')] }), thread('allows', { ...turn('t0', 'completed'), requests: [card('p1', 'permission')] }),
      thread('fails', turn('t1', 'failed')), thread('batched', turn('t1', 'completed')))
    expect(room.marks()).toEqual([['asks', 'question'], ['allows', 'permission'], ['fails', 'failed'], ['batched', 'finished']])
  })

  it('gives no mark for a fork’s copied history, and one when a turn sent to the fork ends', () => {
    const room = service()
    const fork = (extra: Partial<AgentThread> = {}) => thread('fork', { startedFrom: { threadId: 'source', from: 'turn', route: 'fork', at: AT }, ...extra })
    room.pass(fork())
    room.pass(fork(turn('copied', 'completed')))
    expect(room.marks()).toEqual([])
    room.send('fork')
    room.pass(fork(turn('own', 'running')))
    room.pass(fork(turn('own', 'completed')))
    expect(room.marks()).toEqual([['fork', 'finished']])
  })

  it('marks a dispatched turn that ends after a restart', () => {
    const before = service()
    before.pass(thread('worker', turn('t0', 'completed')))
    before.send('worker')
    before.pass(thread('worker', turn('t1', 'running')))
    // Sotto restarts mid-turn: only the saved record goes on, and the history comes back before the turn ends.
    const after = service({ record: watcherRecordSchema.parse(JSON.parse(JSON.stringify(before.record()))) })
    after.pass(thread('worker', turn('t1', 'running')))
    after.pass(thread('worker', turn('t1', 'completed')))
    expect(after.marks()).toEqual([['worker', 'finished']])
  })

  it('marks a turn routed to a paired host when it ends after a reconnect, and none for one that host started itself', () => {
    const room = service({ remote: [thread('far', turn('t0', 'completed')), thread('phone', turn('t0', 'completed'))] })
    room.routed('far')
    room.remotePass(thread('far', turn('t1', 'running')), thread('phone', turn('t0', 'completed')))
    // The host drops off and comes back; meanwhile the phone talked straight to it and started a turn of its own there.
    room.remotePass()
    room.remotePass(thread('far', turn('t1', 'completed')), thread('phone', turn('p1', 'completed')))
    expect(room.marks()).toEqual([['far', 'finished']])
  })

  it('gives no mark for a turn started outside Sotto, a stopped turn, or Watcher’s own conversation', () => {
    const room = service()
    room.pass(thread('cli', turn('t0', 'completed')), thread('stopped', turn('t0', 'completed')), thread('watcher', { kind: 'watcher', ...turn('w0', 'completed') }))
    // The provider's own command line runs a turn; Sotto stops the turn it sent; a wake-up goes to Watcher itself.
    room.send('stopped'); room.send('watcher', randomUUID(), true)
    room.pass(thread('cli', turn('native', 'completed')), thread('stopped', turn('t1', 'interrupted')), thread('watcher', { kind: 'watcher', ...turn('w1', 'completed') }))
    expect(room.marks()).toEqual([])
    expect(room.record().readDispatches ?? []).toEqual([])
  })
})

describe('a dispatched turn’s own end', () => {
  it('marks when the turn finishes, though work it started keeps running in the background', () => {
    const room = service()
    room.pass(thread('worker', turn('t0', 'completed')))
    room.send('worker')
    room.pass(thread('worker', { ...turn('t1', 'completed'), backgroundWork: [{ id: 'build' }] as AgentThread['backgroundWork'] }))
    expect(room.marks()).toEqual([['worker', 'finished']])
  })

  it('reads each dispatch’s own turn when two end between passes, so a stopped second turn leaves the first’s finish', () => {
    const room = service()
    room.pass(thread('pair', turn('t0', 'completed')))
    const first = room.send('pair'), second = room.send('pair')
    // Codex finishes the first turn and the second is stopped before the next observation; only their turn records tell them apart.
    const activity = (turnId: string, status: 'completed' | 'interrupted', afterMessageId: string) =>
      ({ id: `codex-turn-${turnId}`, turnId, sequence: 0, kind: 'turn' as const, title: 'Turn', status, afterMessageId })
    room.pass(thread('pair', { ...turn('t2', 'interrupted'), activities: [activity('t1', 'completed', first), activity('t2', 'interrupted', second)] }))
    expect(room.marks()).toEqual([['pair', 'finished']])
    expect(room.record().readMarks?.[0]?.newsId).toBe('finished:t1')
  })
})

describe('a send routed to a paired host', () => {
  it('is told apart from the thread as it was before the send, though the host ended the turn before it answered', () => {
    const room = service({ remote: [thread('fast', turn('t0', 'completed'))] })
    const before = thread('fast', turn('t0', 'completed'))
    // The host's push lands first: its shell already shows the routed turn finished when the router hears the answer.
    room.remotePass(thread('fast', turn('t1', 'completed')))
    room.routed('fast', before)
    room.remotePass(thread('fast', turn('t1', 'completed')))
    expect(room.marks()).toEqual([['fast', 'finished']])
  })
})

describe('a steer', () => {
  it('carries its dispatch into the turn the steer runs as, and is a dispatch of its own into a turn Sotto did not send', () => {
    const room = service()
    const claude = (lastTurn: NonNullable<AgentThread['lastTurn']>, activities: AgentThread['activities'] = []) =>
      thread('claude', { providerId: 'claude', status: lastTurn.status === 'running' ? 'running' : 'idle', lastTurn, activities })
    const cut = (turnId: string) => ({ id: `claude-turn-${turnId}`, turnId, sequence: 0, kind: 'turn' as const, title: 'Turn steered', status: 'interrupted' as const, afterMessageId: turnId, steered: true })
    room.pass(claude({ id: 'u0', status: 'completed', messageId: 'm0' }), thread('cli', turn('t1', 'running')))
    const first = room.send('claude')
    room.pass(claude({ id: 'u1', status: 'running', messageId: first }), thread('cli', turn('t1', 'running')))
    // Claude Code cuts the first turn for the steer and runs the steer as a turn of its own.
    const second = room.steer('claude')
    // A turn started at Codex's own command line, which the user steers from Sotto.
    room.steer('cli')
    room.pass(claude({ id: 'u1', status: 'interrupted', messageId: first }, [cut(first)]), thread('cli', turn('t1', 'running')))
    expect(room.marks()).toEqual([])
    room.pass(claude({ id: 'u2', status: 'completed', messageId: second }, [cut(first)]), thread('cli', turn('t1', 'completed')))
    expect(room.marks()).toEqual([['claude', 'finished'], ['cli', 'finished']])
  })
})

describe('the requests a dispatch knows', () => {
  it('write nothing on a pass that changes nothing, with sixty cards, and stay read once read', async () => {
    const room = service()
    const cards = Array.from({ length: 60 }, (_, index) => card(`q${String(index).padStart(2, '0')}`))
    room.pass(thread('busy', turn('t0', 'completed')))
    room.send('busy')
    room.pass(thread('busy', { ...turn('t1', 'running'), requests: cards }))
    expect(room.marks()).toEqual([['busy', 'question']])
    await room.watcher.markRead({ targets: [target('busy')] })
    const writes = room.writes()
    room.pass(thread('busy', { ...turn('t1', 'running'), requests: cards }))
    room.pass(thread('busy', { ...turn('t1', 'running'), requests: cards }))
    expect(room.writes()).toBe(writes)
    expect(room.marks()).toEqual([])
  })
})

describe('the dispatches read marks wait on', () => {
  it('let a turn that never ends go after a day, unmarked, and keep one whose thread is out of reach', () => {
    const record = emptyWatcherRecord()
    recordDispatch(record, target('silent'), thread('silent'), AT, 'm1')
    recordDispatch(record, target('away'), thread('away'), new Date(Date.parse(AT) + READ_DISPATCH_MAX_MS).toISOString(), 'm2')
    const later = Date.parse(AT) + READ_DISPATCH_MAX_MS + 1
    const next = trackDispatches(record.readDispatches!, [], item => item.threadId === 'silent' ? { target: item, thread: thread('silent', turn('x', 'running')), connected: true } : undefined, later, AT)
    expect(next?.marks).toEqual([])
    expect(next?.dispatches.map(entry => entry.target.threadId)).toEqual(['away'])
  })

  it('drop one whose send a paired host refused, so a turn the host runs later earns nothing', () => {
    const record = emptyWatcherRecord(), refusedId = randomUUID(), acceptedId = randomUUID()
    recordDispatch(record, target('refused', REMOTE), thread('refused', turn('t0', 'completed')), AT, undefined, refusedId)
    recordDispatch(record, target('accepted', REMOTE), thread('accepted', turn('t0', 'completed')), AT, undefined, acceptedId)
    const threads = { refused: thread('refused', turn('t0', 'completed')), accepted: thread('accepted', turn('t1', 'running')) }
    const read = (item: { hostId: string; threadId: string }) => ({ target: item, thread: threads[item.threadId as keyof typeof threads], connected: true })
    const first = trackDispatches(record.readDispatches!, [], read, Date.parse(AT), AT, id => id === refusedId)
    expect(first?.dispatches.map(entry => entry.target.threadId)).toEqual(['accepted'])
    // The phone starts a turn of its own on the refused thread: nothing of this desktop's waits on it.
    threads.refused = thread('refused', turn('p1', 'completed'))
    expect(trackDispatches(first!.dispatches, first!.marks, read, Date.parse(AT), AT, id => id === refusedId)).toBeNull()
  })

  it('are kept in the Watcher record with the marks, which a restart and a move to stable read back whole', async () => {
    const record = emptyWatcherRecord()
    record.readMarks = [{ target: target('a'), kind: 'finished', newsId: 'finished:t1', at: AT }]
    record.userReads = [{ target: target('b'), readAt: AT }]
    recordDispatch(record, target('c'), thread('c', turn('t0', 'completed')), AT, 'm1')
    expect(watcherRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record)
    const host = new FakeProviderHost()
    const fixture = await agentControlFixture({ host, credentialOptions: { mode: 'unavailable' }, control: { watcherEnabled: true } })
    cleanups.push(fixture.dispose)
    await fixture.control.start()
    await fixture.control.updateWatcher(next => { next.readMarks = record.readMarks; next.userReads = record.userReads; next.readDispatches = record.readDispatches })
    fixture.control.dispose()
    await fixture.control.closed()
    const stable = fixture.create({ watcherEnabled: false })
    await stable.start()
    expect(stable.watcherRecordView()).toMatchObject({ readMarks: record.readMarks, userReads: record.userReads, readDispatches: record.readDispatches })
    await stable.privacyChanged()
    stable.dispose()
    await stable.closed()
    const owl = fixture.create({ watcherEnabled: true })
    await owl.start()
    expect(owl.watcherRecordView()).toMatchObject({ readMarks: record.readMarks, userReads: record.userReads, readDispatches: record.readDispatches })
    owl.dispose()
    await owl.closed()
  })
})

describe('reading a thread', () => {
  it('takes its mark away, records when, and leaves the next dispatched turn to earn a new one', async () => {
    const room = service()
    room.pass(thread('worker', turn('t0', 'completed')))
    room.send('worker')
    room.pass(thread('worker', turn('t1', 'completed')))
    const result = await room.watcher.markRead({ targets: [target('worker')] })
    expect(result.status === 'ok' && result.state.readMarks).toEqual([])
    expect(room.record().userReads?.map(entry => entry.target)).toEqual([target('worker')])
    expect(await room.watcher.markRead({ targets: [] })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
    const record = emptyWatcherRecord()
    record.readMarks = [{ target: target('a'), kind: 'finished', newsId: 'finished:t1', at: AT }]
    expect(markThreadsRead(record, [target('a')], '2026-10-17T10:05:00.000Z')).toBe(true)
    expect(markThreadsRead(record, [target('a')], '2026-10-17T10:06:00.000Z')).toBe(false)
    expect(record.userReads).toEqual([{ target: target('a'), readAt: '2026-10-17T10:06:00.000Z' }])
  })
})
