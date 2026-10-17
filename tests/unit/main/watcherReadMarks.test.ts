// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WatcherService } from '../../../src/main/agents/watcher'
import type { AgentControl } from '../../../src/main/agents/control'
import type { WorkspaceHost } from '../../../src/main/agents/workspace'
import { markThreadsRead, threadNews, WatcherReadMarks, type ReadMarkThread } from '../../../src/main/agents/watcherReadMarks'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import type { AgentThread } from '../../../src/shared/agents'
import { emptyWatcherRecord, watcherRecordSchema, type WatcherRecord } from '../../../src/shared/watcher'
import { agentControlFixture } from '../../fixtures/agentControlFixture'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

const HOST = '11111111-1111-4111-8111-111111111111'
const AT = '2026-10-16T10:00:00.000Z'
const target = (threadId: string) => ({ hostId: HOST, threadId })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function thread(id: string, patch: Partial<AgentThread> = {}): AgentThread {
  return { id, projectId: 'project', title: id, modelId: 'codex:gpt', providerId: 'codex', status: 'idle', messages: [], requests: [], ...patch }
}
const finished = (id: string, turn: string) => thread(id, { lastTurn: { id: turn, status: 'completed' } })
const running = (id: string, turn: string) => thread(id, { status: 'running', lastTurn: { id: turn, status: 'running' } })
const asking = (id: string, request: string) => thread(id, { requests: [{ id: request, kind: 'question', text: 'Which port?' } as AgentThread['requests'][number]] })
const failing = (id: string, turn: string) => thread(id, { status: 'error', lastTurn: { id: turn, status: 'failed' } })
const pass = (...threads: AgentThread[]): ReadMarkThread[] => threads.map(item => ({ target: target(item.id), thread: item, connected: true }))

describe('what a thread has for the user', () => {
  it('is its questions, a failed turn or a finished one, and nothing while it works or after a stop', () => {
    expect(threadNews(asking('a', 'q1'))).toMatchObject({ kind: 'question' })
    expect(threadNews(thread('a', { requests: [{ id: 'p1', kind: 'permission', text: 'Run the suite?' } as AgentThread['requests'][number]] }))).toMatchObject({ kind: 'permission' })
    expect(threadNews(failing('a', 't1'))).toEqual({ kind: 'failed', newsId: 'failed:t1' })
    expect(threadNews(finished('a', 't1'))).toEqual({ kind: 'finished', newsId: 'finished:t1' })
    expect(threadNews(running('a', 't1'))).toBeNull()
    expect(threadNews(thread('a', { lastTurn: { id: 't1', status: 'completed' }, backgroundWork: [{ id: 'w' }] as AgentThread['backgroundWork'] }))).toBeNull()
    expect(threadNews(thread('a', { lastTurn: { id: 't1', status: 'interrupted' } }))).toBeNull()
  })
})

describe('read marks', () => {
  it('marks a thread whose turn finishes, asks or fails while Sotto watches, and never one it first sees', () => {
    const marks = new WatcherReadMarks()
    // First sight, after a restart or a host connecting: what it already had is not news.
    expect(marks.track([], pass(finished('done', 't0'), asking('asks', 'q0'), running('works', 't1'), running('breaks', 't2')), AT)).toBeNull()
    const next = marks.track([], pass(finished('done', 't0'), asking('asks', 'q0'), finished('works', 't1'), failing('breaks', 't2')), AT)
    expect(next?.map(mark => [mark.target.threadId, mark.kind])).toEqual([['works', 'finished'], ['breaks', 'failed']])
    // A question arriving on a thread already marked is still new, and says so.
    const asked = marks.track(next!, pass(finished('done', 't0'), asking('asks', 'q0'), asking('works', 'q1'), failing('breaks', 't2')), AT)
    expect(asked?.map(mark => [mark.target.threadId, mark.kind])).toEqual([['works', 'question'], ['breaks', 'failed']])
    // Nothing changed, nothing to save.
    expect(marks.track(asked!, pass(finished('done', 't0'), asking('asks', 'q0'), asking('works', 'q1'), failing('breaks', 't2')), AT)).toBeNull()
  })

  it('keeps a mark when Watcher sends the thread more before the user opens it, and a disconnected thread keeps one too', () => {
    const marks = new WatcherReadMarks()
    marks.track([], pass(running('a', 't1'), running('b', 't2')), AT)
    const marked = marks.track([], pass(finished('a', 't1'), finished('b', 't2')), AT)!
    expect(marked).toHaveLength(2)
    // An automatic continuation: the thread works again with no news of its own, and its unseen finish stays marked.
    expect(marks.track(marked, [...pass(running('a', 't3')), { target: target('b'), thread: running('b', 't4'), connected: false }], AT)).toBeNull()
    // Its next news replaces what the mark says, still unread.
    const asked = marks.track(marked, pass(asking('a', 'q1')), AT)
    expect(asked?.map(mark => [mark.target.threadId, mark.kind])).toEqual([['a', 'question'], ['b', 'finished']])
  })

  it('marks nothing a thread already had when it connects again, even news that came while it was out of reach', () => {
    const marks = new WatcherReadMarks()
    const offline = (item: AgentThread): ReadMarkThread[] => [{ target: target(item.id), thread: item, connected: false }]
    marks.track([], pass(running('a', 't1')), AT)
    expect(marks.track([], offline(running('a', 't1')), AT)).toBeNull()
    expect(marks.track([], offline(finished('a', 't1')), AT)).toBeNull()
    expect(marks.track([], pass(finished('a', 't1')), AT)).toBeNull()
    // News seen to arrive after it connected again still marks it.
    marks.track([], pass(running('a', 't2')), AT)
    expect(marks.track([], pass(finished('a', 't2')), AT)).toHaveLength(1)
  })

  it('marks nothing a thread already had when its host is put away and listed again, and keeps a mark it had', () => {
    const marks = new WatcherReadMarks()
    // Settings, Disconnect takes the host away before its connection closes: its rows vanish rather than go offline.
    marks.track([], pass(running('a', 't1'), running('b', 't2')), AT)
    const marked = marks.track([], pass(running('a', 't1'), finished('b', 't2')), AT)!
    expect(marked.map(mark => mark.target.threadId)).toEqual(['b'])
    expect(marks.track(marked, [], AT)).toBeNull()
    expect(marks.track(marked, pass(finished('a', 't1'), finished('b', 't2')), AT)).toBeNull()
  })

  it('goes when the user reads the thread, records when, and the same news never marks it again', () => {
    const marks = new WatcherReadMarks()
    marks.track([], pass(running('a', 't1')), AT)
    const record = emptyWatcherRecord()
    record.readMarks = marks.track([], pass(finished('a', 't1')), AT)!
    expect(markThreadsRead(record, [target('a')], '2026-10-16T10:05:00.000Z')).toBe(true)
    expect(record.readMarks).toEqual([])
    expect(record.userReads).toEqual([{ target: target('a'), readAt: '2026-10-16T10:05:00.000Z' }])
    expect(marks.track(record.readMarks, pass(finished('a', 't1')), AT)).toBeNull()
    // Reading a thread with no mark records the time and takes nothing.
    expect(markThreadsRead(record, [target('a')], '2026-10-16T10:06:00.000Z')).toBe(false)
    expect(record.userReads).toEqual([{ target: target('a'), readAt: '2026-10-16T10:06:00.000Z' }])
  })

  it('is kept in the Watcher record, which a restart and a move to stable read back whole', async () => {
    const record = emptyWatcherRecord()
    record.readMarks = [{ target: target('a'), kind: 'finished', newsId: 'finished:t1', at: AT }]
    record.userReads = [{ target: target('b'), readAt: AT }]
    expect(watcherRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record)
    const host = new FakeProviderHost()
    const fixture = await agentControlFixture({ host, credentialOptions: { mode: 'unavailable' }, control: { watcherEnabled: true } })
    cleanups.push(fixture.dispose)
    await fixture.control.start()
    await fixture.control.updateWatcher(next => { next.readMarks = record.readMarks; next.userReads = record.userReads })
    fixture.control.dispose()
    await fixture.control.closed()
    // Stable reads it and saves it as it was; Owl reads the same marks back.
    const stable = fixture.create({ watcherEnabled: false })
    await stable.start()
    expect(stable.watcherRecordView()).toMatchObject({ readMarks: record.readMarks, userReads: record.userReads })
    await stable.privacyChanged()
    stable.dispose()
    await stable.closed()
    const owl = fixture.create({ watcherEnabled: true })
    await owl.start()
    expect(owl.watcherRecordView()).toMatchObject({ readMarks: record.readMarks, userReads: record.userReads })
    owl.dispose()
    await owl.closed()
  })
})

/** A Watcher service over a stand-in coordinator whose record lives here, as main's own keeps it. */
function service(threads: () => AgentThread[]) {
  let record: WatcherRecord = emptyWatcherRecord()
  const snapshot = () => ({ ...emptyDesktopState(HOST).host, connected: true, providers: [{ id: 'codex', connection: 'connected' }], threads: threads() })
  const control = {
    watcherRecord: () => structuredClone(record), watcherRecordView: () => record, watcherSnapshot: snapshot, hostId: () => HOST,
    useWatcher: () => () => undefined, subscribe: () => () => undefined, refreshWatcherObservation: () => undefined,
    updateWatcher: async (update: (next: WatcherRecord) => void) => { const next = structuredClone(record); update(next); record = watcherRecordSchema.parse(next) },
    mutateWatcher: (update: (next: WatcherRecord) => void) => { const next = structuredClone(record); update(next); record = watcherRecordSchema.parse(next) },
    restoredWatcherEvents: () => [], watcherWakeUpQueued: () => false, canDeliverWatcherNews: () => false, pruneWatcherWakeUps: async () => undefined,
    deliverWakeUp: async () => undefined, watcherSendRecords: () => ({ deliveries: [], followups: [] }), hasPendingThreadWork: () => false,
    configuration: () => ({}),
  } as unknown as AgentControl
  const watcher = new WatcherService({ directory: '', control, host: {} as WorkspaceHost, limit: () => 4, historyEnabled: () => false })
  cleanups.push(async () => watcher.close())
  return { watcher, record: () => record }
}

describe('Watcher’s read marks', () => {
  it('come from each observation pass, show in the room, and go when the room says the thread was read', async () => {
    let worker = running('worker', 't1')
    const { watcher, record } = service(() => [worker])
    watcher.wakes.start()
    watcher.wakes.observe()
    expect(watcher.state().readMarks).toEqual([])
    worker = finished('worker', 't1')
    watcher.wakes.observe()
    await Promise.resolve()
    expect(watcher.state().readMarks).toEqual([{ target: target('worker'), kind: 'finished', at: expect.any(String) }])
    const result = await watcher.markRead({ targets: [target('worker')] })
    expect(result.status === 'ok' && result.state.readMarks).toEqual([])
    expect(record().userReads?.map(entry => entry.target)).toEqual([target('worker')])
    expect(await watcher.markRead({ targets: [] })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  })

  it('never marks Watcher’s own thread', () => {
    let own = running(randomUUID(), 't1')
    const { watcher } = service(() => [own])
    own = { ...own, kind: 'watcher' }
    watcher.wakes.start()
    watcher.wakes.observe()
    own = { ...finished(own.id, 't1'), kind: 'watcher' }
    watcher.wakes.observe()
    expect(watcher.state().readMarks).toEqual([])
  })
})
