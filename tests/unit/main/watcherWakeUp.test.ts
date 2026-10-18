// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EMPTY_AGENT_HOST, type AgentThread, type AgentHostSnapshot } from '../../../src/shared/agents'
import { WATCHER_QUIET_MS, watcherOverview } from '../../../src/shared/watcherOverview'
import type { WatcherNews } from '../../../src/shared/watcherNews'
import type { WatcherRecord } from '../../../src/shared/watcher'
import { WatcherWakeUp, WAKE_UP_TRIES, WATCHER_OBSERVE_MS, type WatcherWakeOptions } from '../../../src/main/agents/watcherWakeUp'
import { WatcherEvidenceStore, observationDigest } from '../../../src/main/agents/watcherEvidence'
import { foldWatcherNews, watcherNewsText, watcherWakeUpsAsShown, WATCHER_WAKE_UP_PROMPT } from '../../../src/main/agents/watcherNews'
import { RESUME_NOTE } from '../../../src/shared/restartResume'
import { queuedWakeUpText, wakeUpText, watcherWakeUpNote } from '../../../src/main/agents/wakeUp'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import { centerTarget, centerTime, watcherRecordFixture } from '../../fixtures/watcher'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
function fixture(start = true, progress?: WatcherWakeOptions['progress'], options: Partial<WatcherWakeOptions> = {}) {
  let clock = Date.parse('2026-10-11T10:00:00Z')
  const timers = new Set<{ at: number; callback: () => void }>()
  const record = watcherRecordFixture()
  // An ordinary delivered receipt for Watcher's own send, which is no news to it.
  record.operations[0]!.deliveryState = 'accepted'
  const thread: AgentThread = { id: centerTarget.threadId, providerId: 'codex', projectId: 'project', modelId: 'model', title: 'Worker',
    status: 'running', lastTurn: { id: 'turn-1', status: 'running' }, messages: [], requests: [] }
  const snapshot: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), connected: true, hostId: centerTarget.hostId,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true }, threads: [thread], projects: [{ id: 'project', title: 'Project', path: 'synthetic' }] }
  const canDeliver = vi.fn(() => true)
  const delivered: WatcherNews[] = [], prune = vi.fn(async () => undefined), failed = vi.fn()
  const deliver = vi.fn(async (news: WatcherNews) => { delivered.push(structuredClone(news)) })
  const remember = vi.fn(async (ids: string[]) => { record.wakeEventIds = [...record.wakeEventIds ?? [], ...ids] })
  const wakes = new WatcherWakeUp({ now: () => clock, snapshot: () => snapshot, record: () => record, prune,
    schedule: (callback, delay) => { const timer = { at: clock + delay, callback }; timers.add(timer); return () => { timers.delete(timer) } },
    deliver, remember, failed, canDeliver, ...progress ? { progress } : {}, ...options })
  cleanups.push(() => wakes.close())
  if (start) wakes.start()
  const advance = async (ms: number) => {
    const end = clock + ms
    while (true) {
      const timer = [...timers].sort((a, b) => a.at - b.at).find(timer => timer.at <= end)
      if (!timer) break
      clock = timer.at; timers.delete(timer); timer.callback(); await wakes.drained()
    }
    clock = end; await wakes.drained()
  }
  /** News that wakes Watcher on its own: GitHub's read of the thread's linked pull request's checks. */
  const checks = (state: 'passed' | 'failed' | 'pending' = 'failed') => {
    thread.pullRequests ??= [{ url: prUrl, number: 9, title: 'Synthetic pull request', state: 'open', draft: false, source: 'linked', linkedAt: centerTime }]
    wakes.pullRequest({ url: prUrl, head: 'head', observedAt: new Date(clock).toISOString(), availability: 'available', checks: state, checkCount: 1 })
  }
  return { canDeliver, wakes, record, snapshot, thread, timers, delivered, deliver, remember, failed, advance, checks, now: () => clock }
}
const prUrl = 'https://github.com/synthetic/project/pull/9'
/** The same checks read as a paired host reports it, which needs no link in the roster and so survives a restart's first observation. */
function pairedChecks(wakes: WatcherWakeUp, state: 'passed' | 'failed', at: number): void {
  wakes.pairedEvidence(centerTarget.hostId, [{ id: 'paired-checks', target: centerTarget, source: 'github', url: prUrl, headId: 'head',
    observedAt: new Date(at).toISOString(), freshness: 'fresh', availability: 'available', fact: state === 'failed' ? 'checks-failed' : 'checks-passed',
    checksState: state, checkCount: 1 }])
}

it('looks over the threads at most every WATCHER_OBSERVE_MS while one streams, and once more after the last update', async () => {
  let streamed = 0
  const looked = vi.fn(() => String(streamed)), after = vi.fn()
  const f = fixture(true, looked)
  await f.advance(WATCHER_OBSERVE_MS); looked.mockClear()
  f.wakes.observeSoon(after)
  expect(looked).toHaveBeenCalledTimes(1)
  // A streaming burst: every 16 ms the thread moves on, but no turn, request card, background work or connection does.
  for (let update = 0; update < 10; update++) { streamed++; f.wakes.observeSoon(after); await f.advance(16) }
  expect(looked).toHaveBeenCalledTimes(1)
  expect(after).not.toHaveBeenCalled()
  await f.advance(WATCHER_OBSERVE_MS)
  expect(looked).toHaveBeenCalledTimes(2)
  expect(after).toHaveBeenCalledTimes(1)
  // Nothing owed once the burst is over: no pass looks again by itself.
  await f.advance(WATCHER_OBSERVE_MS * 4)
  expect(looked).toHaveBeenCalledTimes(2)
})

it('looks at once when a turn finishes or a request card arrives between two looks', async () => {
  const f = fixture(), after = vi.fn()
  await f.advance(WATCHER_OBSERVE_MS)
  f.wakes.observeSoon(after)
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-1', status: 'completed' }
  f.wakes.observeSoon(after)
  expect(f.wakes.news().map(event => event.kind)).toContain('turn-finished')
  f.thread.requests.push({ id: 'question', kind: 'question', text: 'private question', options: [] })
  f.wakes.observeSoon(after)
  expect(f.wakes.news().map(event => event.kind)).toContain('needs-user')
  expect(after).not.toHaveBeenCalled()
})

it('looks at once when the Watcher record is replaced, and owes nothing once closed', async () => {
  let record = watcherRecordFixture()
  record.operations[0]!.deliveryState = 'accepted'
  const looked = vi.fn(() => 'same'), after = vi.fn()
  const f = fixture(true, looked, { record: () => record })
  await f.advance(WATCHER_OBSERVE_MS); f.wakes.observeSoon(after); looked.mockClear()
  // A receipt that needs Watcher arrives as a new record: the pass runs now, not when the window is up.
  record = structuredClone(record); record.operations[0]!.deliveryState = 'failed'
  f.wakes.observeSoon(after)
  expect(looked).toHaveBeenCalledTimes(1)
  expect(f.wakes.news().map(event => event.kind)).toContain('delivery-changed')
  // A streaming update owes a pass; closing cancels it.
  f.wakes.observeSoon(after)
  f.wakes.close()
  await f.advance(WATCHER_OBSERVE_MS * 2)
  expect(looked).toHaveBeenCalledTimes(1)
  expect(after).not.toHaveBeenCalled()
})

it('looks at a thread Watcher does not watch only when Watcher reads', async () => {
  const looked: string[] = []
  const f = fixture(false, target => { looked.push(target.threadId); return 'same' })
  f.snapshot.threads.push({ ...f.thread, id: 'unwatched', lastTurn: { id: 'other-turn', status: 'running' } })
  f.wakes.start()
  for (let pass = 0; pass < 3; pass++) { await f.advance(WATCHER_OBSERVE_MS * 40); f.wakes.observe() }
  expect(looked).toEqual(Array(4).fill(centerTarget.threadId))
  // Its turn ending is no news to anyone, so no pass looks at it.
  looked.length = 0
  f.snapshot.threads[1]!.status = 'idle'; f.snapshot.threads[1]!.lastTurn = { id: 'other-turn', status: 'completed' }
  f.wakes.observeSoon(() => undefined)
  expect(looked).not.toContain('unwatched')
  f.wakes.observeAll()
  expect(looked).toEqual([centerTarget.threadId, 'unwatched'])
})

it('starts a thread that has just become watched from its facts as they are, and tells what changes after', async () => {
  const f = fixture(), url = 'https://github.com/synthetic/project/pull/41', later = { hostId: centerTarget.hostId, threadId: 'later' }
  const thread: AgentThread = { ...f.thread, id: 'later', lastTurn: { id: 'later-turn', status: 'running' },
    pullRequests: [{ url, number: 41, title: 'Synthetic pull request', state: 'open', draft: false, source: 'linked', linkedAt: centerTime }] }
  f.snapshot.threads.push(thread)
  const checks = (state: 'failed' | 'passed') => f.wakes.pullRequest({ url, head: 'head', observedAt: new Date(f.now()).toISOString(), availability: 'available', checks: state, checkCount: 1 })
  // GitHub's read of its pull request, and a new link, while no one watches it.
  checks('failed'); f.wakes.observe()
  thread.pullRequests = [...thread.pullRequests!, { url: url.replace('/41', '/42'), number: 42, title: 'Second synthetic pull request', state: 'open', draft: false, source: 'linked', linkedAt: centerTime }]
  f.wakes.observe()
  f.record.requests[0]!.participants.push({ target: later, requestId: f.record.requests[0]!.id, startedBy: 'user', generation: 0, state: 'participating', promptCount: 0 })
  f.wakes.observe(); await f.advance(5_000)
  const told = () => f.delivered.flatMap(news => news.events).filter(event => event.kind === 'evidence-changed' && event.target.threadId === 'later')
  expect(told()).toEqual([])
  checks('passed'); f.wakes.observe(); await f.advance(5_000)
  expect(told()).toHaveLength(1)
})

it('batches for two seconds and never delays a sustained burst past five seconds', async () => {
  const f = fixture()
  for (let n = 0; n < 5; n++) {
    f.thread.requests.push({ id: `question-${n}`, kind: 'question', text: 'private question', options: [] })
    f.wakes.observe(); await f.advance(1_000)
    expect(f.delivered).toHaveLength(n === 4 ? 1 : 0)
  }
  expect(f.delivered[0]!.events.filter(event => event.kind === 'needs-user')).toHaveLength(5)
  expect(JSON.stringify(f.delivered)).not.toContain('private question')
  f.wakes.observe(); await f.advance(10_000)
  expect(f.delivered).toHaveLength(1)
})

it('folds the newest truth, drops answered questions and lets failure replace finish', async () => {
  const f = fixture()
  f.thread.status = 'idle'; f.thread.lastTurn!.status = 'completed'; f.wakes.observe()
  f.thread.requests = [{ id: 'permission', kind: 'permission', text: 'private token', options: [] }]; f.wakes.observe()
  await f.advance(1_000)
  f.thread.requests = []; f.thread.lastTurn!.status = 'failed'; f.thread.status = 'error'; f.wakes.observe()
  await f.advance(2_000)
  expect(f.delivered).toHaveLength(1)
  expect(f.delivered[0]!.events.map(event => event.kind)).toContain('turn-failed')
  expect(f.delivered[0]!.events.map(event => event.kind)).not.toContain('turn-finished')
  expect(f.delivered[0]!.events.map(event => event.kind)).not.toContain('needs-user')
})

it('has one cancellable quiet deadline per episode, ignores republished shells and resets on real progress', async () => {
  const f = fixture()
  expect(f.timers.size).toBe(1)
  await f.advance(WATCHER_QUIET_MS - 1)
  f.wakes.observe()
  await f.advance(1 + 2_000)
  expect(f.delivered.flatMap(news => news.events).filter(event => event.kind === 'quiet')).toHaveLength(1)
  expect(f.timers.size).toBe(0)
  f.wakes.observe(); await f.advance(WATCHER_QUIET_MS * 2)
  expect(f.delivered).toHaveLength(1)
  f.thread.messages.push({ id: 'message-2', role: 'assistant', text: 'private worker output', createdAt: new Date(f.now()).toISOString() })
  f.wakes.observe(); expect(f.timers.size).toBe(1)
  await f.advance(WATCHER_QUIET_MS + 2_000)
  expect(f.delivered.flatMap(news => news.events).filter(event => event.kind === 'quiet')).toHaveLength(2)
})

it('starts a fresh twenty-minute episode on reconnect and never infers quiet or failure from disconnection', async () => {
  const f = fixture()
  await f.advance(WATCHER_QUIET_MS - 1)
  f.snapshot.connected = false; f.wakes.observe()
  expect(f.timers.size).toBe(0)
  await f.advance(WATCHER_QUIET_MS * 2)
  f.snapshot.connected = true; f.wakes.observe()
  await f.advance(WATCHER_QUIET_MS - 1)
  expect(f.delivered).toHaveLength(0)
  await f.advance(2_001)
  expect(f.delivered[0]!.events.map(event => event.kind)).toEqual(['quiet'])
})

it.each(['stop', 'retire', 'takeover', 'settle', 'answer'] as const)('prunes stale %s news at batching and dispatch validation', async change => {
  const f = fixture()
  f.thread.requests = [{ id: 'card', kind: 'permission', text: 'private command arguments', options: [] }]; f.wakes.observe()
  await f.advance(2_000)
  const event = f.delivered[0]!.events.find(event => event.kind === 'needs-user')!
  expect(f.wakes.due(event)).toBe(true)
  if (change === 'stop') { f.record.requests[0]!.state = 'stopped'; f.record.requests[0]!.closedAt = new Date(f.now()).toISOString() }
  if (change === 'retire') f.record.current = null
  if (change === 'takeover') { f.record.requests[0]!.participants[0]!.generation++; f.record.requests[0]!.participants[0]!.state = 'taken-over' }
  if (change === 'settle') f.thread.workspaceSettledAt = new Date(f.now()).toISOString()
  if (change === 'answer') f.thread.requests = []
  expect(f.wakes.due(event)).toBe(false)
  f.wakes.observe(); await f.advance(2_000)
  expect(f.delivered.flatMap(news => news.events).filter(item => item.kind === 'needs-user')).toHaveLength(1)
})

it('withdraws an unqueued question answered during batching and stops all owned deadlines on close', async () => {
  const f = fixture()
  f.thread.requests = [{ id: 'card', kind: 'question', text: 'secret', options: [] }]; f.wakes.observe()
  f.thread.requests = []; f.wakes.observe()
  await f.advance(2_000); expect(f.delivered).toHaveLength(0)
  f.wakes.close(); expect(f.timers.size).toBe(0)
})

it('reconciles durable event IDs without replaying a terminal observation after restart', async () => {
  const f = fixture(); f.thread.status = 'idle'; f.thread.lastTurn!.status = 'completed'; f.wakes.observe()
  await f.advance(2_000); f.wakes.close()
  const delivered = vi.fn(async () => undefined)
  const recovered = new WatcherWakeUp({ snapshot: () => f.snapshot, record: () => f.record, canDeliver: () => true, deliver: delivered,
    now: f.now, prune: async () => undefined, remember: async () => undefined, schedule: callback => { callback(); return () => undefined } })
  recovered.start(); await recovered.drained(); recovered.close()
  expect(delivered).not.toHaveBeenCalled()
})

it('bounds targets, UTF-8 news and omitted counts without copying worker prose', () => {
  const f = fixture(); f.thread.requests = [{ id: 'card', kind: 'question', text: 'secret', options: [] }]; f.wakes.observe()
  const event = f.wakes.news()[0]!
  const events = Array.from({ length: 100 }, (_, n) => ({ ...event, id: String(n), target: { ...centerTarget, threadId: `${n}-${'界'.repeat(160)}` } }))
  const news = foldWatcherNews(undefined, { source: 'watcher', watcher: f.record.current!.target, events, omitted: 0 })
  expect(new Set(news.events.map(event => event.target.threadId)).size).toBe(50)
  expect(news.omitted).toBe(50)
  expect(Buffer.byteLength(watcherNewsText(news))).toBeLessThanOrEqual(16 * 1_024)
  expect(watcherNewsText(news)).toContain('omitted')
})

it('puts each owning thread\'s request identity in the actual bounded provider news', () => {
  const f = fixture(); f.thread.requests = [{ id: 'card', kind: 'question', text: 'private worker question', options: [] }]; f.wakes.observe()
  const event = f.wakes.news()[0]!
  const text = watcherNewsText({ source: 'watcher', watcher: f.record.current!.target, events: [event], omitted: 0 })
  expect(text).toContain(`Use requestId ${event.requestId} for this thread`)
  expect(text).toContain(JSON.stringify(event.target))
  expect(text).not.toContain('private worker question')
})

it('fits combined sources within the provider message limit and preserves babysitting-only wording', () => {
  const f = fixture(); f.thread.requests = [{ id: 'card', kind: 'question', text: 'secret', options: [] }]; f.wakes.observe()
  const news: WatcherNews = { source: 'watcher', watcher: f.record.current!.target, omitted: 0,
    events: Array.from({ length: 100 }, (_, n) => ({ ...f.wakes.news()[0]!, id: String(n) })) }
  const prs: BabysitNews[] = Array.from({ length: 50 }, (_, n) => ({ pullRequest: { number: n + 1, title: 't'.repeat(500),
    url: `https://github.com/o/r/pull/${n + 1}/${'x'.repeat(1_800)}` }, startedBy: 'user', head: null, ended: null,
    changes: [{ kind: 'checks-failed', checks: Array.from({ length: 25 }, () => ({ name: 'n'.repeat(500), status: 'failure', url: `https://github.com/${'x'.repeat(1_800)}` })) }] }))
  expect(queuedWakeUpText(prs, { tool: true })).toBe(wakeUpText(prs, { tool: true }))
  const mixed = queuedWakeUpText([...prs, news], { tool: true })
  expect(mixed.length).toBeLessThanOrEqual(100_000)
  expect(mixed).toContain('Pull request #1')
  // Watcher's news goes beside the message, never in it; a wake-up of nothing else sends Sotto's short message.
  expect(mixed).not.toContain('Sotto saw changes')
  expect(watcherWakeUpNote([...prs, news])).toBe(watcherNewsText(news))
  expect(queuedWakeUpText([news], { tool: true })).toBe(WATCHER_WAKE_UP_PROMPT)
  expect(watcherWakeUpNote(prs)).toBeUndefined()
})


it('reschedules quiet from a completed plan step at minute nineteen without copying the plan text', async () => {
  const f = fixture()
  f.thread.activities = [{ id: 'plan', turnId: 'turn-1', sequence: 0, kind: 'plan', status: 'running', title: 'Private plan',
    steps: [{ text: 'private step contents', status: 'running' }] }]
  f.wakes.observe()
  await f.advance(19 * 60_000)
  f.thread.activities[0]!.steps![0]!.status = 'completed'
  f.wakes.observe()
  await f.advance(60_000 + 2_000)
  expect(f.delivered.flatMap(news => news.events).filter(event => event.kind === 'quiet')).toHaveLength(0)
  await f.advance(WATCHER_QUIET_MS - 60_000)
  expect(f.delivered.flatMap(news => news.events).filter(event => event.kind === 'quiet')).toHaveLength(1)
  expect(JSON.stringify(f.delivered)).not.toContain('private step contents')
})


it('wakes for failed, passed and failed evidence on one head, while repeated reads remain quiet', async () => {
  const f = fixture(), url = 'https://github.com/o/r/pull/1'
  f.thread.pullRequests = [{ url, number: 1, title: 'Synthetic pull request', state: 'open', draft: false, source: 'linked', linkedAt: new Date(f.now()).toISOString() }]
  for (const checks of ['failed', 'passed', 'failed'] as const) {
    f.wakes.pullRequest({ url, head: 'same-head', observedAt: new Date(f.now()).toISOString(), availability: 'available', checks, checkCount: 1 })
    await f.advance(2_000)
  }
  const events = f.delivered.flatMap(news => news.events).filter(event => event.kind === 'evidence-changed')
  expect(events).toHaveLength(3)
  expect(new Set(events.map(event => event.id)).size).toBe(3)
  expect(f.wakes.due(events[0]!)).toBe(false)
  f.wakes.pullRequest({ url, head: 'same-head', observedAt: new Date(f.now()).toISOString(), availability: 'available', checks: 'failed', checkCount: 1 })
  await f.advance(2_000)
  expect(f.delivered.flatMap(news => news.events).filter(event => event.kind === 'evidence-changed')).toHaveLength(3)
})

it.each(['workspace', 'thread', 'project'] as const)('keeps standing PR news after %s settlement until unwatch, while request-only news stays withdrawn', async settlement => {
  for (const standing of [false, true]) {
    const f = fixture(false), url = 'https://github.com/synthetic/project/pull/87', watchId = randomUUID(), stamp = new Date(f.now()).toISOString()
    f.thread.status = 'idle'; f.thread.lastTurn = { id: 'completed-before-settlement', status: 'completed' }
    f.thread.pullRequests = [{ url, number: 87, title: 'Synthetic standing pull request', state: 'open', draft: false, source: 'linked', linkedAt: stamp }]
    if (settlement === 'workspace') f.thread.workspaceSettledAt = stamp
    if (settlement === 'thread') f.thread.settledAt = stamp
    if (settlement === 'project') f.snapshot.projects[0]!.workspaceSettledAt = stamp
    if (standing) f.record.watches = [{ id: watchId, target: centerTarget, createdAt: stamp, generation: 0 }]
    f.wakes.start()
    f.wakes.pullRequest({ url, head: 'standing-head', observedAt: stamp, availability: 'available', checks: 'failed', checkCount: 1 })
    await f.advance(2_000)
    const event = f.delivered.flatMap(news => news.events).find(item => item.kind === 'evidence-changed')
    if (!standing) { expect(event).toBeUndefined(); continue }
    expect(event).toMatchObject({ requestId: watchId, target: centerTarget })
    expect(f.wakes.due(event!)).toBe(true)
    f.record.watches = []; f.wakes.observe()
    expect(f.wakes.due(event!)).toBe(false)
  }
})

it('restores the latest evidence occurrence without replaying it or suppressing a later return to an old state', async () => {
  const f = fixture()
  for (const state of ['failed', 'passed', 'failed'] as const) { pairedChecks(f.wakes, state, f.now()); await f.advance(2_000) }
  expect(f.delivered).toHaveLength(3)
  f.wakes.close()
  f.thread.status = 'idle'; f.thread.lastTurn = undefined
  const deliver = vi.fn<(news: WatcherNews) => Promise<void>>(async () => undefined)
  const recovered = new WatcherWakeUp({ snapshot: () => f.snapshot, record: () => f.record, canDeliver: () => true, deliver, now: f.now,
    prune: async () => undefined, remember: async () => undefined, schedule: callback => { callback(); return () => undefined } })
  cleanups.push(() => recovered.close())
  recovered.start(); pairedChecks(recovered, 'failed', f.now()); await recovered.drained()
  expect(deliver).not.toHaveBeenCalled()
  pairedChecks(recovered, 'passed', f.now()); await recovered.drained()
  pairedChecks(recovered, 'failed', f.now()); await recovered.drained()
  expect(deliver).toHaveBeenCalledTimes(2)
})


it('keeps the same evidence due when unchanged native facts move around a checkpoint fact', async () => {
  const f = fixture()
  f.thread.status = 'idle'; f.thread.lastTurn!.status = 'completed'; f.wakes.observe()
  f.wakes.checkpoint({ threadId: f.thread.id, checkpointId: 'checkpoint', observedAt: new Date(f.now()).toISOString(), availability: 'available', changedFiles: 1 })
  await f.advance(2_000)
  const event = f.delivered[0]!.events.find(event => event.kind === 'evidence-changed')!
  expect(f.wakes.due(event)).toBe(true)
  f.wakes.observe()
  expect(f.wakes.due(event)).toBe(true)
  await f.advance(2_000)
  expect(f.delivered).toHaveLength(1)
})

it('keeps a legacy evidence ID valid only for its reconciled occurrence', async () => {
  const f = fixture()
  pairedChecks(f.wakes, 'failed', f.now()); await f.advance(2_000)
  const current = f.delivered[0]!.events.find(event => event.kind === 'evidence-changed')!
  const legacyId = observationDigest([current.kind, current.requestId, current.target, current.generation, current.evidenceIds])
  const legacy = { ...current, id: legacyId }
  f.record.wakeEventIds = [legacyId]; f.wakes.close()
  f.thread.status = 'idle'; f.thread.lastTurn = undefined
  const deliver = vi.fn<(news: WatcherNews) => Promise<void>>(async () => undefined)
  const recovered = new WatcherWakeUp({ snapshot: () => f.snapshot, record: () => f.record, canDeliver: () => true, deliver, now: f.now,
    prune: async () => undefined, remember: async () => undefined, schedule: callback => { callback(); return () => undefined } })
  cleanups.push(() => recovered.close())
  recovered.start(); pairedChecks(recovered, 'failed', f.now()); await recovered.drained()
  expect(deliver).not.toHaveBeenCalled()
  expect(recovered.due(legacy)).toBe(true)
  pairedChecks(recovered, 'passed', f.now()); await recovered.drained()
  pairedChecks(recovered, 'failed', f.now()); await recovered.drained()
  expect(recovered.due(legacy)).toBe(false)
  expect(deliver).toHaveBeenCalledTimes(2)
})


it('keeps undelivered pull request news pending through save failures without needing another observation', async () => {
  const f = fixture()
  f.deliver.mockRejectedValueOnce(new Error('synthetic save failure')).mockRejectedValueOnce(new Error('synthetic save failure'))
  f.checks()
  await f.advance(2_000)
  expect(f.delivered).toHaveLength(0)
  await f.advance(6_000)
  expect(f.delivered).toHaveLength(1)
  expect(f.deliver).toHaveBeenCalledTimes(3)
  expect(f.record.wakeEventIds).toEqual(f.delivered[0]!.events.map(event => event.id))
  await f.advance(10_000)
  expect(f.deliver).toHaveBeenCalledTimes(3)
})

it('retries event-ID persistence after a saved wake-up without queueing the news twice', async () => {
  const f = fixture()
  f.remember.mockRejectedValueOnce(new Error('synthetic metadata save failure'))
  f.checks()
  await f.advance(4_000)
  expect(f.deliver).toHaveBeenCalledTimes(1)
  expect(f.remember).toHaveBeenCalledTimes(2)
  expect(f.record.wakeEventIds).toEqual(f.delivered[0]!.events.map(event => event.id))
})

it.each(['stopped', 'answered'] as const)('withdraws %s news before retrying a failed queue save', async change => {
  const f = fixture()
  f.deliver.mockRejectedValueOnce(new Error('synthetic save failure'))
  if (change === 'answered') {
    f.thread.requests = [{ id: 'card', kind: 'question', text: 'private question', options: [] }]; f.wakes.observe()
  } else f.checks()
  await f.advance(2_000)
  if (change === 'answered') f.thread.requests = []
  else f.record.requests[0]!.participants[0]!.automationStopped = true
  f.wakes.observe()
  await f.advance(2_000)
  expect(f.delivered).toHaveLength(0)
  expect(f.deliver).toHaveBeenCalledTimes(1)
})

it('folds newer evidence into a failed save retry instead of retaining its older truth', async () => {
  const f = fixture()
  f.deliver.mockImplementationOnce(async () => { f.checks('passed'); throw new Error('synthetic save failure') })
  f.checks('failed')
  await f.advance(4_000)
  expect(f.delivered).toHaveLength(1)
  expect(f.delivered[0]!.events[0]!.revision).toBe(observationDigest(f.wakes.evidence.read(centerTarget).map(fact => fact.id).sort()))
  expect(f.record.wakeEventIds).toEqual(f.delivered[0]!.events.map(event => event.id))
})

it.each([0, 20])('retains the bounded pending batch after a failed save and %s stopped participants', async stopped => {
  const f = fixture(), request = f.record.requests[0]!, participant = request.participants[0]!
  f.thread.status = 'idle'; f.thread.lastTurn = undefined
  f.thread.pullRequests = [{ url: prUrl, number: 9, title: 'Synthetic pull request', state: 'open', draft: false, source: 'linked', linkedAt: centerTime }]
  const targets = [centerTarget]
  for (let n = 1; n < 60; n++) {
    const target = { ...centerTarget, threadId: 'overflow-' + n }
    targets.push(target)
    f.snapshot.threads.push({ ...f.thread, id: target.threadId })
    request.participants.push({ ...participant, target })
  }
  f.deliver.mockRejectedValueOnce(new Error('synthetic save failure'))
  // One read of the pull request every thread links: news for each of them.
  f.checks()
  await f.advance(2_000)
  expect(f.deliver.mock.calls[0]![0].events).toHaveLength(50)
  expect(f.deliver.mock.calls[0]![0].omitted).toBe(10)
  for (const item of request.participants.slice(0, stopped)) item.automationStopped = true
  if (stopped) f.wakes.observe()
  await f.advance(2_000)
  expect(f.delivered).toHaveLength(1)
  expect(f.delivered[0]!.omitted).toBe(Math.max(0, targets.length - stopped - 50))
  expect(f.delivered[0]!.events.map(event => event.target)).toEqual(targets.slice(stopped, stopped + 50))
  expect(f.record.wakeEventIds).toEqual(f.delivered[0]!.events.map(event => event.id))
})


it('keeps owning-host checkpoint causes without starting a master or a wake-up deadline', async () => {
  const f = fixture(false)
  f.wakes.checkpoint({ threadId: f.thread.id, checkpointId: 'synthetic-checkpoint', observedAt: new Date(f.now()).toISOString(),
    availability: 'unavailable', reason: 'capture-unavailable' })
  expect(f.wakes.evidence.read(centerTarget)).toEqual([expect.objectContaining({ target: centerTarget, source: 'checkpoint', reason: 'capture-unavailable' })])
  expect(f.wakes.ready()).toBe(false)
  expect(f.timers.size).toBe(0)
  await f.advance(30_000)
  expect(f.delivered).toHaveLength(0)
  expect(f.wakes.news()).toHaveLength(0)
})


it('resets the quiet deadline from paired progress while an unchanged digest stays quiet', async () => {
  let fingerprint = 'a'.repeat(64)
  const f = fixture(true, () => fingerprint)
  await f.advance(19 * 60_000)
  fingerprint = 'b'.repeat(64); f.wakes.observe()
  await f.advance(60_000 + 2_000)
  expect(f.delivered.flatMap(news => news.events).filter(event => event.kind === 'quiet')).toHaveLength(0)
  f.wakes.observe()
  await f.advance(WATCHER_QUIET_MS - 60_000)
  expect(f.delivered.flatMap(news => news.events).filter(event => event.kind === 'quiet')).toHaveLength(1)
})

it.each(['thread', 'project'] as const)('keeps remote quiet news on its host when %s IDs collide', async collision => {
  const f = fixture(false), remoteHost = '55555555-5555-4555-8555-555555555555'
  f.thread.hostId = remoteHost
  f.record.requests[0]!.participants[0]!.target = { hostId: remoteHost, threadId: f.thread.id }
  const localProjectId = collision === 'project' ? f.thread.projectId : 'local-project'
  f.snapshot.projects = [
    { id: localProjectId, hostId: centerTarget.hostId, title: 'Local settled project', path: 'local', workspaceSettledAt: new Date(f.now()).toISOString() },
    { id: f.thread.projectId, hostId: remoteHost, title: 'Remote project', path: 'remote' }
  ]
  f.snapshot.threads.unshift({ ...f.thread, id: collision === 'thread' ? f.thread.id : 'local-worker', hostId: centerTarget.hostId,
    projectId: localProjectId, status: 'idle', lastTurn: { id: 'local-turn', status: 'completed' } })
  f.wakes.start()
  await f.advance(WATCHER_QUIET_MS + 2_000)
  const quiet = f.delivered.flatMap(news => news.events).filter(event => event.kind === 'quiet')
  expect(quiet.map(event => event.target)).toEqual([{ hostId: remoteHost, threadId: f.thread.id }])
})

function gitFixture(f: ReturnType<typeof fixture>) {
  const git = { isRepository: true, branch: 'main', upstream: null, hasRemote: false,
    defaultBranch: 'main', isDefaultBranch: true, dirty: true, changedFiles: 2, insertions: 4, deletions: 1,
    ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, readAt: centerTime, fetchedAt: null as string | null }
  f.thread.worktree = { mode: 'shared', status: 'ready', branch: 'main', baseBranch: 'main', git }
  const move = (change: Partial<typeof git>) => { Object.assign(git, change, { readAt: new Date(f.now()).toISOString() }); f.wakes.observe() }
  return { git, move }
}
const kinds = (news: WatcherNews | undefined) => news?.events.map(event => event.kind)

it('holds Git, working-copy and checkpoint changes through a running turn and tells them once, with its end', async () => {
  const f = fixture(), { move } = gitFixture(f)
  f.wakes.observe(); await f.advance(2_000)
  // Each tool call moves the working copy while the turn runs. None of it wakes Watcher.
  for (const [n, change] of [{ changedFiles: 3 }, { insertions: 5 }, { deletions: 2 }, { branch: 'topic' }, { ahead: 1 }, { behind: 1 }].entries()) {
    move(change)
    f.wakes.checkpoint({ threadId: f.thread.id, checkpointId: `capture-${n}`, observedAt: new Date(f.now()).toISOString(), availability: 'available', changedFiles: n })
    await f.advance(30_000)
  }
  expect(f.delivered).toHaveLength(0)
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-1', status: 'completed' }; f.wakes.observe()
  await f.advance(5_000)
  expect(f.delivered).toHaveLength(1)
  expect(kinds(f.delivered[0])).toEqual(['turn-finished', 'evidence-changed'])
  const told = f.delivered[0]!.events.find(event => event.kind === 'evidence-changed')!
  expect(told.revision).toBe(observationDigest(f.wakes.evidence.read(centerTarget).map(fact => fact.id).sort()))
  expect(f.wakes.due(told)).toBe(true)
  // A checkpoint that lands while its turn's end is still waiting rides with it.
  f.thread.status = 'running'; f.thread.lastTurn = { id: 'turn-2', status: 'running' }; f.wakes.observe()
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-2', status: 'completed' }; f.wakes.observe()
  f.wakes.checkpoint({ threadId: f.thread.id, checkpointId: 'capture-end', observedAt: new Date(f.now()).toISOString(), availability: 'available', changedFiles: 9 })
  await f.advance(5_000)
  expect(f.delivered).toHaveLength(2)
  expect(kinds(f.delivered[1])).toEqual(['turn-finished', 'evidence-changed'])
})

it('drops held working-copy changes that come back to what Watcher was told, and never wakes for them while a thread rests', async () => {
  const f = fixture(), { git, move } = gitFixture(f)
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-1', status: 'completed' }; f.wakes.observe()
  await f.advance(5_000)
  expect(kinds(f.delivered[0])).toEqual(['turn-finished', 'evidence-changed'])
  // Resting: a background fetch, then a change of its own. Neither is news on its own.
  git.fetchedAt = new Date(f.now()).toISOString(); move({})
  move({ changedFiles: 4 }); await f.advance(60_000)
  move({ changedFiles: 2 }); await f.advance(60_000)
  expect(f.delivered).toHaveLength(1)
  // The next turn moves files and puts them back: its end is told alone, since nothing differs from what Watcher knows.
  f.thread.status = 'running'; f.thread.lastTurn = { id: 'turn-2', status: 'running' }; f.wakes.observe()
  move({ changedFiles: 7 }); await f.advance(30_000)
  move({ changedFiles: 2 }); await f.advance(30_000)
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-2', status: 'completed' }; f.wakes.observe()
  await f.advance(5_000)
  expect(f.delivered).toHaveLength(2)
  expect(kinds(f.delivered[1])).toEqual(['turn-finished'])
  // A change made while resting is told with the next turn's end.
  move({ changedFiles: 5 }); await f.advance(60_000)
  f.thread.status = 'running'; f.thread.lastTurn = { id: 'turn-3', status: 'running' }; f.wakes.observe()
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-3', status: 'completed' }; f.wakes.observe()
  await f.advance(5_000)
  expect(kinds(f.delivered[2])).toEqual(['turn-finished', 'evidence-changed'])
})

it('holds a Git-backed turn end for the read its finish starts, and tells what that read found in the same wake-up', async () => {
  const f = fixture(), { move } = gitFixture(f)
  f.wakes.observe(); await f.advance(2_000)
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-1', status: 'completed' }; f.wakes.observe()
  // The workspace reads the working copy after the turn's work settles, which lands after the two-second batch.
  await f.advance(2_500)
  expect(f.delivered).toHaveLength(0)
  move({ changedFiles: 9, insertions: 40 })
  await f.advance(5_000)
  expect(f.delivered.map(kinds)).toEqual([['turn-finished', 'evidence-changed']])
  const told = f.delivered[0]!.events.find(event => event.kind === 'evidence-changed')!
  expect(told.revision).toBe(observationDigest(f.wakes.evidence.read(centerTarget).map(fact => fact.id).sort()))
  // A change after that is the thread at rest, told with its next turn's end, never alone.
  move({ changedFiles: 11 }); await f.advance(20 * 60_000)
  expect(f.delivered).toHaveLength(1)
  // A thread with no Git working copy has no read to wait for: its turn end goes after the usual batch.
  delete f.thread.worktree
  f.thread.status = 'running'; f.thread.lastTurn = { id: 'turn-2', status: 'running' }; f.wakes.observe()
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-2', status: 'completed' }; f.wakes.observe()
  await f.advance(2_000)
  expect(f.delivered).toHaveLength(2)
})

it('wakes at once for a pull request change during a running turn, and tells it again as it stands if it was withdrawn as the working copy moved', async () => {
  let waking = false
  const f = fixture(true, undefined, { wakeUpQueued: () => waking }), { move } = gitFixture(f)
  f.wakes.observe(); await f.advance(2_000)
  f.checks('failed'); await f.advance(2_000)
  expect(kinds(f.delivered[0])).toEqual(['evidence-changed'])
  // Watcher is busy, so that news waits in its hidden wake-up, which never changes. The working copy moving saves nothing.
  waking = true
  move({ changedFiles: 6 }); await f.advance(30_000)
  expect(f.delivered).toHaveLength(1)
  expect(f.wakes.due(f.delivered[0]!.events[0]!)).toBe(false)
  // The wake-up is withdrawn, its news no longer true as it stood: the pull request's news is told again, as it stands now.
  waking = false; f.wakes.settled(f.delivered[0]!.events, 'withdrawn'); await f.advance(2_000)
  expect(f.delivered.map(kinds)).toEqual([['evidence-changed'], ['evidence-changed']])
  expect(f.wakes.due(f.delivered[1]!.events[0]!)).toBe(true)
  expect(f.wakes.needsAttention(f.delivered[1]!.events)).toBe(true)
  // Once it has gone, the working copy moving is held again.
  f.wakes.settled(f.delivered[1]!.events, 'told')
  move({ changedFiles: 8 }); await f.advance(30_000)
  expect(f.delivered).toHaveLength(2)
})

it.each([
  ['an ordinary delivered receipt', { deliveryState: 'accepted' }, false],
  ['a failed receipt', { deliveryState: 'failed' }, true],
  ['a refused receipt', { deliveryState: 'failed', refusalCode: 'THREAD_TAKEN_OVER' }, true],
  ['an uncertain receipt', { deliveryState: 'uncertain' }, true],
  ['a receipt whose thread creation is uncertain', { deliveryState: 'accepted', creationUncertain: true }, true],
] as const)('lets %s wake Watcher only when the send did not plainly go', async (_name, receipt, wakes) => {
  const f = fixture(false)
  Object.assign(f.record.operations[0]!, receipt)
  f.wakes.start(); await f.advance(2_000)
  expect(f.delivered.flatMap(news => news.events).filter(event => event.kind === 'delivery-changed')).toHaveLength(wakes ? 1 : 0)
})

it('holds unavailable-recipient news without deadlines and resumes the unchanged news when available', async () => {
  const f = fixture()
  f.thread.status = 'idle'; f.thread.lastTurn = undefined; f.wakes.observe()
  f.canDeliver.mockReturnValue(false)
  f.checks()
  await f.advance(10 * 60_000)
  expect(f.deliver).not.toHaveBeenCalled()
  expect(f.failed).not.toHaveBeenCalled()
  expect(f.timers.size).toBe(0)
  f.canDeliver.mockReturnValue(true); f.wakes.observe(); await f.advance(2_000)
  expect(f.delivered).toHaveLength(1)
  expect(f.record.wakeEventIds).toEqual(f.delivered[0]!.events.map(event => event.id))
})

it.each(['deliver', 'remember'] as const)('backs off %s failures, caps automatic attempts and retains news for event-driven recovery', async failing => {
  const f = fixture()
  f.thread.status = 'idle'; f.thread.lastTurn = undefined; f.wakes.observe()
  const calls: number[] = []
  f[failing].mockImplementation(async () => { calls.push(f.now()); throw new Error('synthetic save failure') })
  f.checks()
  const began = f.now()
  await f.advance(30 * 60_000)
  expect(calls.map(at => at - began)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 124_000, 184_000])
  expect(f.timers.size).toBe(0)
  f.wakes.observe(); await f.advance(10 * 60_000)
  expect(calls).toHaveLength(8)
  f.deliver.mockImplementation(async news => { f.delivered.push(structuredClone(news)) })
  f.remember.mockImplementation(async ids => { f.record.wakeEventIds = ids })
  f.canDeliver.mockReturnValue(false); f.wakes.observe()
  f.canDeliver.mockReturnValue(true); f.wakes.observe(); await f.advance(2_000)
  expect(f.delivered).toHaveLength(1)
  expect(f.record.wakeEventIds).toEqual(f.delivered[0]!.events.map(event => event.id))
})

it('holds news if the recipient becomes unavailable during queue admission', async () => {
  const f = fixture()
  f.thread.status = 'idle'; f.thread.lastTurn = undefined; f.wakes.observe()
  f.deliver.mockImplementationOnce(async () => { f.canDeliver.mockReturnValue(false); throw new Error('Watcher is unavailable.') })
  f.checks()
  await f.advance(60_000)
  expect(f.deliver).toHaveBeenCalledTimes(1)
  expect(f.failed).not.toHaveBeenCalled()
  expect(f.timers.size).toBe(0)
  f.canDeliver.mockReturnValue(true); f.wakes.observe(); await f.advance(2_000)
  expect(f.delivered).toHaveLength(1)
})

it('does not shorten persistence backoff when fresh evidence or shell observations arrive', async () => {
  const f = fixture(), attempts: number[] = [], began = f.now()
  f.thread.status = 'idle'; f.thread.lastTurn = undefined; f.wakes.observe()
  f.deliver.mockImplementation(async () => { attempts.push(f.now() - began); throw new Error('synthetic save failure') })
  f.checks('failed'); await f.advance(5_000)
  f.checks('passed'); f.wakes.observe(); await f.advance(2_999)
  expect(attempts).toEqual([2_000, 4_000])
  await f.advance(1)
  expect(attempts).toEqual([2_000, 4_000, 8_000])
  expect(f.deliver.mock.calls[2]![0].events[0]!.revision).toBe(observationDigest(f.wakes.evidence.read(centerTarget).map(fact => fact.id).sort()))
})

it('owns no quiet deadline for an unwatched same-ID thread on another host', () => {
  const f = fixture()
  f.snapshot.threads.unshift({ ...f.thread, hostId: '55555555-5555-4555-8555-555555555555' })
  f.wakes.observe()
  expect(f.timers.size).toBe(1)
})

it.each(['idle', 'question', 'disconnected'] as const)('uses the watched host at quiet expiry even when another same-ID thread is %s', async state => {
  const f = fixture()
  const other = { ...f.thread, hostId: '55555555-5555-4555-8555-555555555555' }
  if (state === 'idle') { other.status = 'idle'; other.lastTurn = undefined }
  if (state === 'question') other.requests = [{ id: 'other-card', kind: 'question', text: 'private other-host question', options: [] }]
  if (state === 'disconnected') other.clientConnected = false
  f.snapshot.threads.unshift(other); f.wakes.observe()
  await f.advance(WATCHER_QUIET_MS + 2_000)
  const quiet = f.delivered.flatMap(news => news.events).filter(event => event.kind === 'quiet')
  expect(quiet.map(event => event.target)).toEqual([centerTarget])
})

it('keeps remote same-ID participants out of this host provider residency and quiet deadlines', () => {
  const f = fixture()
  f.record.requests[0]!.participants[0]!.target = { ...centerTarget, hostId: '55555555-5555-4555-8555-555555555555' }
  f.wakes.observe()
  expect(f.wakes.watchedThreadIds(centerTarget.hostId)).toEqual([])
  expect(f.timers.size).toBe(0)
})

it('does not wake for alternating surface and babysitting reads of unchanged GitHub facts', async () => {
  const f = fixture(), url = 'https://github.com/o/r/pull/1'
  f.thread.pullRequests = [{ url, number: 1, title: 'Synthetic pull request', state: 'open', draft: false, source: 'linked', linkedAt: new Date(f.now()).toISOString() }]
  for (let n = 0; n < 6; n++) {
    f.wakes.pullRequest({ url, head: 'same-head', observedAt: new Date(f.now()).toISOString(), availability: 'available', state: 'open',
      checks: 'passed', checkCount: 1, ...(n % 2 ? {} : { reviewApproved: true, autoMerge: true }) })
    await f.advance(2_000)
  }
  expect(f.delivered).toHaveLength(1)
  expect(f.wakes.evidence.read(centerTarget).some(item => item.githubReviewApproved === true)).toBe(true)
  expect(f.wakes.evidence.read(centerTarget).some(item => item.fact === 'auto-merge-observed')).toBe(true)
})

it.each([true, false])('retains waiting checkpoint news during incomplete restart observations with saved metadata %s', async savedMetadata => {
  const f = fixture()
  f.thread.status = 'idle'; f.thread.lastTurn!.status = 'completed'; f.wakes.observe()
  const checkpoint = (changedFiles: number) => ({ threadId: f.thread.id, checkpointId: 'saved-capture',
    observedAt: new Date(f.now()).toISOString(), availability: 'available' as const, changedFiles })
  f.wakes.checkpoint(checkpoint(1)); await f.advance(2_000)
  const saved = f.delivered[0]!.events.find(event => event.kind === 'evidence-changed')!
  if (!savedMetadata) f.record.wakeEventIds = []
  f.wakes.close()
  const retained: boolean[] = [], deliver = vi.fn<(news: WatcherNews) => Promise<void>>(async () => undefined)
  const recovered = new WatcherWakeUp({ snapshot: () => f.snapshot, record: () => f.record, canDeliver: () => true, now: f.now,
    restoredEvents: () => f.delivered.flatMap(news => news.events), deliver, remember: async () => undefined,
    prune: async () => { retained.push(recovered.due(saved)) }, schedule: callback => { callback(); return () => undefined } })
  cleanups.push(() => recovered.close())
  recovered.start(); await recovered.drained()
  expect(retained).toEqual([true])
  expect(deliver).not.toHaveBeenCalled()
  recovered.checkpoint(checkpoint(1)); await recovered.drained()
  expect(recovered.due(saved)).toBe(true)
  expect(deliver).not.toHaveBeenCalled()
  recovered.checkpoint(checkpoint(2)); await recovered.drained()
  expect(recovered.due(saved)).toBe(false)
  // A thread's own facts keep no queued news current by themselves. Withdrawn, the turn end goes again with them as they stand.
  expect(deliver).not.toHaveBeenCalled()
  recovered.settled(f.delivered.flatMap(news => news.events), 'withdrawn'); await recovered.drained()
  expect(deliver).toHaveBeenCalledTimes(1)
  expect(deliver.mock.calls[0]![0].events.map(event => event.kind)).toEqual(['turn-finished', 'evidence-changed'])
  expect(recovered.due(deliver.mock.calls[0]![0].events[1]!)).toBe(true)
})

it('invalidates an explicitly unlinked PR during incomplete evidence recovery', async () => {
  const f = fixture(), url = 'https://github.com/o/r/pull/1'
  f.thread.status = 'idle'; f.thread.lastTurn!.status = 'completed'
  f.thread.pullRequests = [{ url, number: 1, title: 'Synthetic pull request', state: 'open', draft: false, source: 'linked', linkedAt: new Date(f.now()).toISOString() }]
  f.wakes.observe()
  f.wakes.checkpoint({ threadId: f.thread.id, checkpointId: 'capture', observedAt: new Date(f.now()).toISOString(), availability: 'available' })
  await f.advance(2_000); f.wakes.close()
  const saved = f.delivered[0]!.events.find(event => event.kind === 'evidence-changed')!
  const recovered = new WatcherWakeUp({ snapshot: () => f.snapshot, record: () => f.record, canDeliver: () => true, now: f.now,
    restoredEvents: () => f.delivered.flatMap(news => news.events), deliver: async () => undefined, remember: async () => undefined,
    prune: async () => undefined, schedule: () => () => undefined })
  cleanups.push(() => recovered.close())
  recovered.start()
  expect(recovered.due(saved)).toBe(true)
  f.thread.pullRequests = []; recovered.observe()
  expect(recovered.due(saved)).toBe(false)
})

it('keeps waiting checkpoint news through recovery of a full evidence projection', async () => {
  const f = fixture()
  f.thread.status = 'idle'; f.thread.lastTurn!.status = 'completed'
  f.thread.pullRequests = Array.from({ length: 50 }, (_, n) => ({ url: 'https://github.com/o/r/pull/' + (n + 1), number: n + 1,
    title: 'Synthetic pull request', state: 'open' as const, draft: false, source: 'linked' as const, linkedAt: new Date(f.now()).toISOString() }))
  f.wakes.observe()
  for (const pr of f.thread.pullRequests) f.wakes.pullRequest({ url: pr.url, head: 'head', observedAt: new Date(f.now()).toISOString(),
    availability: 'available', state: 'open', checks: 'passed', reviewApproved: true, autoMerge: true })
  const checkpoint = (changedFiles: number) => ({ threadId: f.thread.id, checkpointId: 'capture',
    observedAt: new Date(f.now()).toISOString(), availability: 'available' as const, changedFiles })
  f.wakes.checkpoint(checkpoint(1)); await f.advance(2_000); f.wakes.close()
  const saved = f.delivered[0]!.events.find(event => event.kind === 'evidence-changed')!
  expect(saved.evidenceIds).toHaveLength(100)
  const recovered = new WatcherWakeUp({ snapshot: () => f.snapshot, record: () => f.record, canDeliver: () => true, now: f.now,
    restoredEvents: () => f.delivered.flatMap(news => news.events), deliver: async () => undefined, remember: async () => undefined,
    prune: async () => undefined, schedule: () => () => undefined })
  cleanups.push(() => recovered.close())
  recovered.start()
  expect(recovered.due(saved)).toBe(true)
  recovered.checkpoint(checkpoint(1))
  for (const pr of f.thread.pullRequests) recovered.pullRequest({ url: pr.url, head: 'head', observedAt: new Date(f.now()).toISOString(),
    availability: 'available', state: 'open', checks: 'passed', reviewApproved: true, autoMerge: true })
  expect(recovered.due(saved)).toBe(true)
  recovered.checkpoint(checkpoint(2))
  expect(recovered.due(saved)).toBe(false)
})

it('invalidates newly linked PR news during incomplete recovery', async () => {
  const f = fixture()
  f.thread.status = 'idle'; f.thread.lastTurn!.status = 'completed'; f.wakes.observe()
  f.wakes.checkpoint({ threadId: f.thread.id, checkpointId: 'capture', observedAt: new Date(f.now()).toISOString(), availability: 'available' })
  await f.advance(2_000); f.wakes.close()
  const saved = f.delivered[0]!.events.find(event => event.kind === 'evidence-changed')!
  const recovered = new WatcherWakeUp({ snapshot: () => f.snapshot, record: () => f.record, canDeliver: () => true, now: f.now,
    restoredEvents: () => f.delivered.flatMap(news => news.events), deliver: async () => undefined, remember: async () => undefined,
    prune: async () => undefined, schedule: () => () => undefined })
  cleanups.push(() => recovered.close())
  recovered.start(); expect(recovered.due(saved)).toBe(true)
  f.thread.pullRequests = [{ url: 'https://github.com/o/r/pull/1', number: 1, title: 'Synthetic pull request',
    state: 'open', draft: false, source: 'linked', linkedAt: new Date(f.now()).toISOString() }]
  recovered.observe()
  expect(recovered.due(saved)).toBe(false)
})

it('supersedes waiting news when a newer saved checkpoint loads after its referenced capture', async () => {
  const f = fixture()
  f.thread.status = 'idle'; f.thread.lastTurn!.status = 'completed'; f.wakes.observe()
  const read = { threadId: f.thread.id, checkpointId: 'saved-capture', observedAt: new Date(f.now()).toISOString(), availability: 'available' as const, changedFiles: 1 }
  f.wakes.checkpoint(read); await f.advance(2_000); f.wakes.close()
  const saved = f.delivered[0]!.events.find(event => event.kind === 'evidence-changed')!
  const recovered = new WatcherWakeUp({ snapshot: () => f.snapshot, record: () => f.record, canDeliver: () => true, now: f.now,
    restoredEvents: () => f.delivered.flatMap(news => news.events), deliver: async () => undefined, remember: async () => undefined,
    prune: async () => undefined, schedule: () => () => undefined })
  cleanups.push(() => recovered.close())
  recovered.start(); expect(recovered.due(saved)).toBe(true)
  recovered.restoreCheckpoint({ ...read, checkpointId: 'unreferenced-older-capture' })
  expect(recovered.evidence.read(centerTarget).some(item => item.source === 'checkpoint')).toBe(false)
  recovered.restoreCheckpoint(read)
  expect(recovered.due(saved)).toBe(true)
  recovered.checkpoint({ ...read, checkpointId: 'newest-capture', changedFiles: 2 })
  expect(recovered.due(saved)).toBe(false)
})

it('keeps independent paired GitHub facts on their host and replaces only the changed fact', async () => {
  const f = fixture(false), remoteHost = '55555555-5555-4555-8555-555555555555'
  const target = { hostId: remoteHost, threadId: f.thread.id }, owner = new WatcherEvidenceStore()
  f.thread.hostId = remoteHost
  f.record.requests[0]!.participants[0]!.target = target
  f.snapshot.threads.unshift({ ...f.thread, hostId: centerTarget.hostId })
  const read = { url: 'https://github.com/o/r/pull/1', head: 'head', observedAt: new Date(f.now()).toISOString(), availability: 'available' as const }
  owner.pullRequest(target, { ...read, state: 'open', checks: 'passed', checkCount: 1, reviewApproved: true, autoMerge: true })
  f.wakes.start()
  f.wakes.pairedEvidence(remoteHost, owner.read(target, true, f.now()))
  await f.advance(2_000)
  const facts = () => f.wakes.evidence.read(target, true, f.now())
  expect(facts()).toEqual(expect.arrayContaining([
    expect.objectContaining({ target, checksState: 'passed' }),
    expect.objectContaining({ target, githubReviewApproved: true }),
    expect.objectContaining({ target, githubAutoMergeEnabled: true }),
    expect.objectContaining({ target, pullRequestState: 'open' })
  ]))
  expect(f.wakes.evidence.read(centerTarget)).toEqual([])
  const newsCount = f.delivered.length
  f.wakes.pairedEvidence(remoteHost, owner.read(target, true, f.now())); await f.advance(2_000)
  expect(f.delivered).toHaveLength(newsCount)
  owner.pullRequest(target, { ...read, observedAt: new Date(f.now()).toISOString(), checks: 'failed' })
  f.wakes.pairedEvidence(remoteHost, owner.read(target, true, f.now())); await f.advance(2_000)
  expect(facts().filter(fact => fact.checksState !== undefined)).toEqual([expect.objectContaining({ checksState: 'failed' })])
  expect(facts().some(fact => fact.githubReviewApproved === true)).toBe(true)
  expect(facts().some(fact => fact.githubAutoMergeEnabled === true)).toBe(true)
  expect(f.delivered.flatMap(news => news.events).every(event => event.target.hostId === remoteHost)).toBe(true)
})

it('supersedes partially restored paired news only when a known owning-host fact changes', async () => {
  const f = fixture(false), remoteHost = '55555555-5555-4555-8555-555555555555'
  const target = { hostId: remoteHost, threadId: f.thread.id }, owner = new WatcherEvidenceStore()
  f.thread.status = 'idle'; f.thread.lastTurn = undefined
  f.thread.hostId = remoteHost
  f.record.requests[0]!.participants[0]!.target = target
  f.snapshot.threads.unshift({ ...f.thread, hostId: centerTarget.hostId })
  const capture = { threadId: f.thread.id, checkpointId: 'retained-capture', observedAt: new Date(f.now()).toISOString(), availability: 'available' as const, changedFiles: 1 }
  owner.checkpoint(target, capture)
  owner.pullRequest(target, { url: 'https://github.com/o/r/pull/1', head: 'head', observedAt: capture.observedAt, availability: 'available', checks: 'passed' })
  f.wakes.start(); f.wakes.pairedEvidence(remoteHost, owner.read(target, true, f.now())); await f.advance(2_000)
  const saved = f.delivered[0]!.events.find(event => event.kind === 'evidence-changed')!
  f.wakes.close()
  const deliver = vi.fn<(news: WatcherNews) => Promise<void>>(async () => undefined)
  const recovered = new WatcherWakeUp({ snapshot: () => f.snapshot, record: () => f.record, canDeliver: () => true, now: f.now,
    restoredEvents: () => f.delivered.flatMap(news => news.events), deliver, remember: async () => undefined,
    prune: async () => undefined, schedule: callback => { callback(); return () => undefined } })
  cleanups.push(() => recovered.close())
  recovered.start()
  recovered.restoreCheckpoint(capture)
  expect(recovered.evidence.read(centerTarget)).toEqual([])
  expect(recovered.due(saved)).toBe(true)
  recovered.pairedEvidence(remoteHost, owner.read(target, true, f.now()).filter(fact => fact.source === 'checkpoint'))
  await recovered.drained()
  expect(recovered.due(saved)).toBe(true)
  expect(deliver).not.toHaveBeenCalled()
  owner.checkpoint(target, { ...capture, checkpointId: 'new-capture', changedFiles: 2 })
  recovered.pairedEvidence(remoteHost, owner.read(target, true, f.now()).filter(fact => fact.source === 'checkpoint'))
  await recovered.drained()
  expect(recovered.due(saved)).toBe(false)
  // Its wake-up never changes: withdrawn, the pull request's news is told again as it stands, still needing Watcher.
  expect(deliver).not.toHaveBeenCalled()
  recovered.settled(f.delivered.flatMap(news => news.events), 'withdrawn'); await recovered.drained()
  expect(deliver).toHaveBeenCalledTimes(1)
  expect(deliver.mock.calls[0]![0].events.every(event => event.target.hostId === remoteHost)).toBe(true)
  expect(recovered.needsAttention(deliver.mock.calls[0]![0].events)).toBe(true)
})

it('removes paired PR facts and Landing only after the connected owning roster explicitly unlinks it', async () => {
  const f = fixture(false), remoteHost = '55555555-5555-4555-8555-555555555555'
  const target = { hostId: remoteHost, threadId: f.thread.id }, owner = new WatcherEvidenceStore()
  const url = 'https://github.com/o/r/pull/1', linkedAt = new Date(f.now()).toISOString()
  f.thread.hostId = remoteHost; f.thread.status = 'idle'; f.thread.lastTurn = undefined
  f.thread.pullRequests = [{ url, number: 1, title: 'Synthetic PR', state: 'open', draft: false, source: 'linked', linkedAt }]
  f.record.requests[0]!.participants[0]!.target = target
  const localTwin = { ...structuredClone(f.thread), hostId: centerTarget.hostId }
  f.snapshot.threads.unshift(localTwin)
  owner.pullRequest(target, { url, head: 'head', observedAt: linkedAt, availability: 'available', state: 'open', checks: 'passed', reviewApproved: true, autoMerge: true })
  f.wakes.start(); f.wakes.pairedEvidence(remoteHost, owner.read(target, true, f.now())); f.wakes.observe()
  f.wakes.pullRequest({ url, head: 'head', observedAt: linkedAt, availability: 'available', checks: 'passed', reviewApproved: true, autoMerge: true })
  await f.advance(2_000)
  const saved = f.delivered.flatMap(news => news.events).findLast(event => event.kind === 'evidence-changed')!
  const facts = () => f.wakes.evidence.read(target, true, f.now())
  const group = () => watcherOverview({ host: f.snapshot }, f.now(), f.wakes.observations).find(row => row.thread === f.thread)!.group
  expect(group()).toBe('Landing')
  f.wakes.pairedEvidence(remoteHost, []); f.wakes.observe()
  expect(facts().some(fact => fact.githubReviewApproved)).toBe(true)
  expect(facts().some(fact => fact.githubAutoMergeEnabled)).toBe(true)
  expect(f.wakes.due(saved)).toBe(true)
  // A disconnected shell is not confirmation of removal, even if its links are absent.
  f.thread.clientConnected = false; f.thread.pullRequests = []
  f.wakes.pairedEvidence(remoteHost, []); f.wakes.observe()
  expect(facts().some(fact => fact.githubAutoMergeEnabled)).toBe(true)
  f.thread.clientConnected = true; f.wakes.observe()
  expect(facts().filter(fact => fact.source === 'github')).toEqual([])
  expect(group()).toBe('Idle')
  expect(f.wakes.due(saved)).toBe(false)
  expect(f.wakes.evidence.read(centerTarget, true, f.now()).some(fact => fact.githubAutoMergeEnabled)).toBe(true)
  await f.advance(2_000)
  expect(f.delivered.at(-1)!.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'evidence-changed', target })]))
})

it('shows Watcher’s conversation without Sotto’s news for it, by the host’s record of its wake-ups and never by text alone', () => {
  const f = fixture(); f.thread.requests = [{ id: 'card', kind: 'question', text: 'secret', options: [] }]; f.wakes.observe()
  const news = watcherNewsText({ source: 'watcher', watcher: f.record.current!.target, events: f.wakes.news(), omitted: 0 })
  const message = (id: string, text: string, wakeUp = true) => ({ id, role: 'user' as const, text, createdAt: centerTime, ...wakeUp ? { wakeUp: true as const } : {} })
  const reply = { id: 'reply', role: 'assistant' as const, text: news, createdAt: centerTime }
  const babysitting = message('babysitting', 'Sotto is babysitting a pull request for this thread, and it needs you.')
  const messages = [
    message('now', WATCHER_WAKE_UP_PROMPT), // This build's wake-up for Watcher.
    message('grok', `${WATCHER_WAKE_UP_PROMPT}\n\n[${news}]`), // Grok Build's, with the news on its one line.
    message('earlier', news), // An earlier build's, with the news in the message.
    message('resumed', `${RESUME_NOTE}\n\n${news}`), // An earlier build's resume note with news after it.
    babysitting, reply,
    message('typed', news, false), message('typed-prompt', WATCHER_WAKE_UP_PROMPT, false), // The user's own words, whatever they say.
  ]
  const shown = watcherWakeUpsAsShown(messages)
  expect(shown.map(item => [item.id, item.text])).toEqual([['resumed', RESUME_NOTE], ['babysitting', babysitting.text], ['reply', news],
    ['typed', news], ['typed-prompt', WATCHER_WAKE_UP_PROMPT]])
  expect(watcherWakeUpsAsShown([babysitting, reply])).toEqual([babysitting, reply])
  const plain = [reply]
  expect(watcherWakeUpsAsShown(plain)).toBe(plain)
})

const backgroundTask = (n: number) => ({ id: randomUUID(), label: `Background task ${n}`, type: 'subagent' as const })
const monitor = (n: number) => ({ id: randomUUID(), label: `Watch ${n}` })
/** The projection a Codex `subAgentActivity` roster gives the thread: its running agents and the roster's working count. */
function codexSubAgents(thread: AgentThread, working: number): void {
  thread.subagentSummary = { total: 2, working, completed: 2 - working, failed: 0, interrupted: 0, unknown: 0 }
  thread.activities = [{ id: 'assignment', turnId: 'turn-1', sequence: 0, kind: 'subagent', title: 'explorer', status: working ? 'running' : 'completed',
    agents: Array.from({ length: 2 }, (_, n) => ({ id: `agent-${n}`, title: `agent-${n}`, status: n < working ? 'running' : 'completed' })) }]
}
// Turn evidence rides beside these and is not what they prove.
const turnKinds = (delivered: readonly WatcherNews[]) => delivered.flatMap(news => news.events).map(event => event.kind).filter(kind => kind !== 'evidence-changed')
const finish = (thread: AgentThread) => { thread.status = 'idle'; thread.lastTurn = { id: 'turn-1', status: 'completed' } }

it.each([
  ['Claude background tasks', (thread: AgentThread, count: number) => { thread.providerId = 'claude'; thread.backgroundWork = Array.from({ length: count }, (_, n) => backgroundTask(n)) }],
  ['Codex subAgentActivity', (thread: AgentThread, count: number) => codexSubAgents(thread, count)],
  ['monitoring', (thread: AgentThread, count: number) => { thread.monitoring = Array.from({ length: count }, (_, n) => monitor(n)) }],
] as const)('says once when a finished turn\'s %s reach zero', async (_, work) => {
  const f = fixture()
  work(f.thread, 2); finish(f.thread); f.wakes.observe()
  await f.advance(2_000)
  const finished = f.delivered[0]!.events.find(event => event.kind === 'turn-finished')!
  expect(finished.backgroundWorkCount).toBe(2)
  expect(watcherNewsText(f.delivered[0]!)).toContain('the turn is not done until Sotto sends work-settled news for it')
  work(f.thread, 1); f.wakes.observe(); await f.advance(2_000)
  expect(turnKinds(f.delivered)).not.toContain('work-settled')
  work(f.thread, 0); f.wakes.observe(); await f.advance(2_000)
  const settled = f.delivered.flatMap(news => news.events).filter(event => event.kind === 'work-settled')
  expect(settled).toEqual([expect.objectContaining({ target: centerTarget, turnId: 'turn-1', backgroundWorkCount: 0, requestId: finished.requestId })])
  expect(watcherNewsText(f.delivered.at(-1)!)).toContain('so the turn is done')
  // Once per turn: work that starts and ends again in the same finished turn says nothing more.
  work(f.thread, 2); f.wakes.observe(); work(f.thread, 0); f.wakes.observe(); await f.advance(10_000)
  expect(turnKinds(f.delivered).filter(kind => kind === 'work-settled')).toHaveLength(1)
  expect(JSON.stringify(f.delivered)).not.toMatch(/Background task|Watch \d|explorer/u)
})

it('says nothing more for a finished turn that had no background work', async () => {
  const f = fixture()
  finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  f.wakes.observe(); await f.advance(10_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-finished'])
  expect(f.delivered[0]!.events.find(event => event.kind === 'turn-finished')!.backgroundWorkCount).toBe(0)
  expect(watcherNewsText(f.delivered[0]!)).not.toContain('work-settled')
})

it('waits for the background work of a turn that failed too', async () => {
  const f = fixture()
  f.thread.backgroundWork = [backgroundTask(1)]; f.thread.status = 'error'; f.thread.lastTurn = { id: 'turn-1', status: 'failed' }; f.wakes.observe()
  await f.advance(2_000)
  f.thread.backgroundWork = []; f.wakes.observe(); await f.advance(2_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-failed', 'work-settled'])
})

it('counts background work and the roster\'s working sub-agents once where they overlap', async () => {
  const f = fixture()
  f.thread.backgroundWork = [backgroundTask(1), backgroundTask(2)]; codexSubAgents(f.thread, 2); f.thread.monitoring = [monitor(1)]
  finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  expect(f.delivered[0]!.events.find(event => event.kind === 'turn-finished')!.backgroundWorkCount).toBe(3)
})

it('owes nothing for a turn that a new turn replaced', async () => {
  const f = fixture()
  f.thread.backgroundWork = [backgroundTask(1)]; finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  f.thread.status = 'running'; f.thread.lastTurn = { id: 'turn-2', status: 'running' }; f.thread.backgroundWork = []; f.wakes.observe()
  await f.advance(2_000)
  expect(turnKinds(f.delivered)).not.toContain('work-settled')
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-2', status: 'completed' }; f.wakes.observe(); await f.advance(2_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-finished', 'turn-finished'])
})

function restarted(f: ReturnType<typeof fixture>, restoredEvents?: WatcherWakeOptions['restoredEvents']) {
  f.wakes.close()
  const delivered: WatcherNews[] = []
  const recovered = new WatcherWakeUp({ snapshot: () => f.snapshot, record: () => f.record, canDeliver: () => true, now: f.now,
    deliver: async news => { delivered.push(structuredClone(news)) }, prune: async () => undefined, ...restoredEvents ? { restoredEvents } : {},
    remember: async ids => { f.record.wakeEventIds = [...f.record.wakeEventIds ?? [], ...ids] }, schedule: callback => { callback(); return () => undefined } })
  cleanups.push(() => recovered.close())
  return { recovered, delivered }
}

it('does not repeat work-settled news after a restart', async () => {
  const f = fixture()
  codexSubAgents(f.thread, 2); finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  codexSubAgents(f.thread, 0); f.wakes.observe(); await f.advance(2_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-finished', 'work-settled'])
  const { recovered, delivered } = restarted(f)
  recovered.start(); await recovered.drained()
  codexSubAgents(f.thread, 2); recovered.observe(); codexSubAgents(f.thread, 0); recovered.observe(); await recovered.drained()
  expect(delivered).toEqual([])
})

it('keeps a busy finish owed its work-settled news across a restart', async () => {
  const f = fixture()
  f.thread.providerId = 'claude'; f.thread.backgroundWork = [backgroundTask(1), backgroundTask(2)]; finish(f.thread); f.wakes.observe()
  await f.advance(2_000)
  const { recovered, delivered } = restarted(f)
  f.thread.backgroundWork = []
  recovered.start(); await recovered.drained()
  expect(turnKinds(delivered)).toEqual(['work-settled'])
  recovered.observe(); await recovered.drained()
  expect(turnKinds(delivered)).toEqual(['work-settled'])
})

it('gives no work-settled news after a restart for a turn that finished with none', async () => {
  const f = fixture()
  finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  const { recovered, delivered } = restarted(f)
  recovered.start(); recovered.observe(); await recovered.drained()
  expect(delivered).toEqual([])
})

it('reads a queued busy finish after a restart as owed its work-settled news', async () => {
  const f = fixture()
  f.thread.monitoring = [monitor(1)]; finish(f.thread); f.wakes.observe()
  const queued = f.wakes.news()
  expect(queued.map(event => event.kind)).toContain('turn-finished')
  f.thread.monitoring = []
  const { recovered, delivered } = restarted(f, () => queued)
  recovered.start(); await recovered.drained()
  expect(turnKinds(delivered)).toEqual(['work-settled'])
})

it('keeps a turn unsettled while a restart has left its sub-agents unknown', async () => {
  const f = fixture()
  codexSubAgents(f.thread, 2); finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  const { recovered, delivered } = restarted(f)
  // A restart cannot see how running sub-agents ended, so the roster holds them as unknown, not finished.
  f.thread.subagentSummary = { total: 2, working: 0, completed: 0, failed: 0, interrupted: 0, unknown: 2 }
  recovered.start(); recovered.observe(); await recovered.drained()
  expect(turnKinds(delivered)).toEqual([])
  f.thread.subagentSummary = { total: 2, working: 0, completed: 2, failed: 0, interrupted: 0, unknown: 0 }
  recovered.observe(); recovered.observe(); await recovered.drained()
  expect(turnKinds(delivered)).toEqual(['work-settled'])
})

it('reads a turn that finishes while a restart has left sub-agents unknown as not done, and settles it once they end', async () => {
  const f = fixture()
  // A restart cannot see how running sub-agents ended; a turn finishing beside them is not done until they resolve.
  f.thread.subagentSummary = { total: 2, working: 0, completed: 0, failed: 0, interrupted: 0, unknown: 2 }
  finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  const finished = f.delivered[0]!.events.find(event => event.kind === 'turn-finished')!
  expect(finished.backgroundWorkCount).toBe(2)
  expect(watcherNewsText(f.delivered[0]!)).toContain('the turn is not done until Sotto sends work-settled news for it')
  f.wakes.observe(); await f.advance(10_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-finished'])
  f.thread.subagentSummary = { total: 2, working: 0, completed: 2, failed: 0, interrupted: 0, unknown: 0 }
  f.wakes.observe(); f.wakes.observe(); await f.advance(10_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-finished', 'work-settled'])
})

it('owes nothing for work that starts after a finish was delivered as done', async () => {
  const f = fixture()
  finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  expect(f.delivered[0]!.events.find(event => event.kind === 'turn-finished')!.backgroundWorkCount).toBe(0)
  // Work seen on the same finished turn after Watcher heard it was done does not reopen it.
  f.thread.monitoring = [monitor(1)]; f.wakes.observe(); await f.advance(2_000)
  f.thread.monitoring = []; f.wakes.observe(); await f.advance(10_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-finished'])
})

it('holds work-settled news when work starts again before delivery and sends it once after the final zero', async () => {
  const f = fixture()
  f.thread.providerId = 'claude'; f.thread.backgroundWork = [backgroundTask(1), backgroundTask(2)]; finish(f.thread); f.wakes.observe()
  await f.advance(2_000)
  f.thread.backgroundWork = []; f.wakes.observe(); await f.advance(500)
  // Inside the batch window the turn's work starts again, so "the turn is done" would be false.
  f.thread.backgroundWork = [backgroundTask(3), backgroundTask(4)]; f.wakes.observe(); await f.advance(10_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-finished'])
  f.thread.backgroundWork = []; f.wakes.observe(); await f.advance(2_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-finished', 'work-settled'])
  f.wakes.observe(); await f.advance(10_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-finished', 'work-settled'])
})

it('gives no work-settled news for a paired host that does not report its work counts', async () => {
  const f = fixture(true, undefined, { reportsWork: () => hostId => hostId !== centerTarget.hostId })
  f.thread.providerId = 'claude'; f.thread.backgroundWork = [backgroundTask(1), backgroundTask(2)]; finish(f.thread); f.wakes.observe()
  await f.advance(2_000)
  // Missing counts are unknown, not none running: the finish carries no count and claims nothing about the work.
  const finished = f.delivered[0]!.events.find(event => event.kind === 'turn-finished')!
  expect(finished).not.toHaveProperty('backgroundWorkCount')
  delete f.thread.backgroundWork; f.wakes.observe(); await f.advance(10_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-finished'])
  expect(watcherNewsText(f.delivered[0]!)).not.toContain('work-settled')
})

it('holds what a finished turn’s background work changes for its work-settled news, and wakes Watcher once for it', async () => {
  const f = fixture(), { move } = gitFixture(f)
  f.thread.providerId = 'claude'; f.thread.backgroundWork = [backgroundTask(1)]; finish(f.thread); f.wakes.observe()
  await f.advance(5_000)
  expect(f.delivered.map(kinds)).toEqual([['turn-finished', 'evidence-changed']])
  // The turn's background work edits files after Watcher heard the turn finished busy. None of it wakes Watcher.
  for (const change of [{ changedFiles: 3 }, { insertions: 9 }, { deletions: 4 }, { ahead: 1 }]) { move(change); await f.advance(30_000) }
  expect(f.delivered).toHaveLength(1)
  // The work ends: one wake-up says the turn is done and carries what the work changed.
  f.thread.backgroundWork = []; f.wakes.observe(); await f.advance(5_000)
  expect(f.delivered.map(kinds)).toEqual([['turn-finished', 'evidence-changed'], ['work-settled', 'evidence-changed']])
  const told = f.delivered[1]!.events.find(event => event.kind === 'evidence-changed')!
  expect(told.revision).toBe(observationDigest(f.wakes.evidence.read(centerTarget).map(fact => fact.id).sort()))
  f.wakes.observe(); await f.advance(10_000)
  expect(f.delivered).toHaveLength(2)
  // Both wake-ups' words, the busy finish's included, travel beside Sotto's short message and never in it.
  for (const [news, words] of [[f.delivered[0]!, 'the turn is not done until Sotto sends work-settled news'], [f.delivered[1]!, 'so the turn is done']] as const) {
    expect(queuedWakeUpText([news], { tool: false })).toBe(WATCHER_WAKE_UP_PROMPT)
    expect(watcherWakeUpNote([news])).toContain(words)
  }
})

it('sends work-settled news alone when the background work changed nothing Watcher was told', async () => {
  const f = fixture(); gitFixture(f)
  f.thread.monitoring = [monitor(1)]; finish(f.thread); f.wakes.observe(); await f.advance(5_000)
  f.thread.monitoring = []; f.wakes.observe(); await f.advance(5_000)
  expect(f.delivered.map(kinds)).toEqual([['turn-finished', 'evidence-changed'], ['work-settled']])
})

it('names the operation a finished turn answers on its finish and work-settled news, as an identity only', async () => {
  const operationId = randomUUID()
  const answers = vi.fn((target: { threadId: string }, thread: AgentThread) => target.threadId === thread.id ? operationId : undefined)
  const f = fixture(true, undefined, { answers })
  f.thread.backgroundWork = [backgroundTask(1)]; finish(f.thread); f.wakes.observe()
  await f.advance(2_000)
  f.thread.backgroundWork = []; f.wakes.observe(); await f.advance(2_000)
  const events = f.delivered.flatMap(news => news.events).filter(event => event.kind === 'turn-finished' || event.kind === 'work-settled')
  expect(events.map(event => [event.kind, event.operationId])).toEqual([['turn-finished', operationId], ['work-settled', operationId]])
  expect(watcherNewsText(f.delivered[0]!)).toContain(`This turn answers operation ${operationId}; read_operation gives its outcome and reply.`)
  expect(answers).toHaveBeenCalledWith(centerTarget, expect.objectContaining({ id: f.thread.id }), expect.objectContaining({ operations: expect.any(Array) }))
})

it('names no operation for a turn no brief of Watcher\'s began', async () => {
  const f = fixture(true, undefined, { answers: () => undefined })
  finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  const finished = f.delivered[0]!.events.find(event => event.kind === 'turn-finished')!
  expect(finished.operationId).toBeUndefined()
  expect(watcherNewsText(f.delivered[0]!)).not.toContain('answers operation')
})

it('tells news afresh once its wake-up is let go with its send unknown, and only what is still true', async () => {
  const f = fixture()
  finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  expect(turnKinds(f.delivered)).toEqual(['turn-finished'])
  f.wakes.observe(); await f.advance(10_000)
  expect(f.delivered).toHaveLength(1)
  // The queue let that wake-up go without knowing whether it was sent; it is never sent twice, so its news is told anew.
  f.wakes.settled(f.delivered[0]!.events, 'unknown'); await f.advance(2_000)
  expect(f.delivered).toHaveLength(2)
  expect(f.delivered[1]!.events.map(event => [event.kind, event.turnId])).toEqual([['turn-finished', 'turn-1']])
  // News that is no longer true stays untold: the thread has started its next turn.
  f.thread.status = 'running'; f.thread.lastTurn = { id: 'turn-2', status: 'running' }
  f.wakes.settled(f.delivered[1]!.events, 'unknown'); await f.advance(10_000)
  expect(f.delivered).toHaveLength(2)
})

it('tries news observed afresh after unknown sends a bounded number of times, then only with news that needs Watcher', async () => {
  const f = fixture()
  finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  for (let miss = 1; miss < WAKE_UP_TRIES; miss++) { f.wakes.settled(f.delivered.at(-1)!.events, 'unknown'); await f.advance(2_000) }
  expect(f.delivered).toHaveLength(WAKE_UP_TRIES)
  // The last try missed too: what it held is observed afresh, and waits.
  f.wakes.settled(f.delivered.at(-1)!.events, 'unknown'); await f.advance(60_000)
  expect(f.delivered).toHaveLength(WAKE_UP_TRIES)
  f.thread.requests = [{ id: 'card', kind: 'question', text: 'secret', options: [] }]; f.wakes.observe(); await f.advance(2_000)
  expect(f.delivered.map(kinds).at(-1)!.sort()).toEqual(['needs-user', 'turn-finished'])
  // One that reaches Watcher starts the count again.
  f.wakes.settled(f.delivered.at(-1)!.events, 'told')
  f.thread.status = 'running'; f.thread.lastTurn = { id: 'turn-2', status: 'running' }; f.wakes.observe()
  finish(f.thread); f.thread.lastTurn = { id: 'turn-2', status: 'completed' }; f.wakes.observe(); await f.advance(2_000)
  f.wakes.settled(f.delivered.at(-1)!.events, 'unknown'); await f.advance(2_000)
  expect(turnKinds(f.delivered.slice(-2))).toEqual(['turn-finished', 'turn-finished'])
})

it('keeps news that comes while Watcher’s hidden wake-up exists for the next one, and holds a failed one’s news for news that needs Watcher or its rest', async () => {
  let waking = false
  const f = fixture(true, undefined, { wakeUpQueued: () => waking })
  const watcher: AgentThread = { ...structuredClone(f.thread), id: f.record.current!.target.threadId, kind: 'watcher', title: 'Watcher', status: 'idle', lastTurn: { id: 'w-1', status: 'completed' } }
  f.snapshot.threads.push(watcher)
  finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  expect(f.delivered).toHaveLength(1)
  // It is being sent when a question comes: the question waits, saving nothing, and folds into nothing.
  waking = true
  f.thread.requests = [{ id: 'card', kind: 'question', text: 'secret', options: [] }]; f.wakes.observe(); await f.advance(10_000)
  expect(f.delivered).toHaveLength(1)
  // The send surely did not go. The question is news it did not carry, so the next goes with both.
  waking = false; f.wakes.settled(f.delivered[0]!.events, 'failed'); await f.advance(2_000)
  expect(f.delivered).toHaveLength(2)
  expect(f.delivered[1]!.events.map(event => event.kind).sort()).toEqual(['needs-user', 'turn-finished'])
  // That one fails with nothing new beside it: its news waits for Watcher to come to rest.
  f.wakes.settled(f.delivered[1]!.events, 'failed'); await f.advance(60_000)
  expect(f.delivered).toHaveLength(2)
  watcher.status = 'running'; watcher.lastTurn = { id: 'w-2', status: 'running' }; f.wakes.observe(); await f.advance(10_000)
  watcher.status = 'idle'; watcher.lastTurn = { id: 'w-2', status: 'completed' }; f.wakes.observe(); await f.advance(2_000)
  expect(f.delivered).toHaveLength(3)
  // That made the third miss in a row: past the bound, Watcher's rest makes no more, and only news that needs it does.
  expect(WAKE_UP_TRIES).toBe(3)
  f.wakes.settled(f.delivered.at(-1)!.events, 'failed')
  watcher.status = 'running'; f.wakes.observe(); watcher.status = 'idle'; f.wakes.observe(); await f.advance(60_000)
  expect(f.delivered).toHaveLength(3)
  f.thread.requests.push({ id: 'card-2', kind: 'question', text: 'secret', options: [] }); f.wakes.observe(); await f.advance(2_000)
  expect(f.delivered).toHaveLength(4)
  // A thread's own facts are no such news: they never make one by themselves.
  f.wakes.settled(f.delivered.at(-1)!.events, 'failed')
  f.wakes.checkpoint({ threadId: f.thread.id, checkpointId: 'capture', observedAt: new Date(f.now()).toISOString(), availability: 'available', changedFiles: 4 })
  await f.advance(60_000)
  expect(f.delivered).toHaveLength(4)
})

it('lets a Git read hold only its own thread’s turn end, never a question beside it', async () => {
  const f = fixture(), { move } = gitFixture(f)
  f.wakes.observe(); await f.advance(2_000)
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-1', status: 'completed' }; f.wakes.observe()
  await f.advance(500)
  f.thread.requests = [{ id: 'card', kind: 'question', text: 'secret', options: [] }]; f.wakes.observe()
  // The question goes with the usual batch; the finish waits for its Git read.
  await f.advance(2_000)
  expect(f.delivered.map(kinds)).toEqual([['needs-user']])
  await f.advance(3_000)
  expect(f.delivered.map(kinds)).toEqual([['needs-user'], ['turn-finished', 'evidence-changed']])
  // Finishes four seconds apart each wait for their own read, and a question among them still goes within the batch.
  f.thread.requests = []; f.wakes.observe()
  for (const [n, turn] of ['turn-2', 'turn-3', 'turn-4'].entries()) {
    f.thread.status = 'running'; f.thread.lastTurn = { id: turn, status: 'running' }; f.wakes.observe()
    f.thread.status = 'idle'; f.thread.lastTurn = { id: turn, status: 'completed' }; move({ changedFiles: n + 3 })
    if (n === 1) f.thread.requests = [{ id: 'card-2', kind: 'question', text: 'secret', options: [] }]
    f.wakes.observe()
    if (n === 1) { await f.advance(2_000); expect(f.delivered.at(-1)!.events.map(event => event.requestCardId)).toContain('card-2'); await f.advance(2_000) }
    else await f.advance(4_000)
  }
})

it('never wakes Watcher mid-turn when a Git read only sees a pull request’s link again', async () => {
  const f = fixture(), { move } = gitFixture(f)
  f.wakes.observe(); await f.advance(2_000)
  // GitHub's read of the linked pull request's checks wakes Watcher, once.
  f.checks('failed'); await f.advance(2_000)
  f.wakes.observe(); await f.advance(5_000)
  const told = f.delivered.length
  expect(told).toBeGreaterThan(0)
  // The worker's tool calls move the working copy; each Git read sees the same link, which is no news.
  for (const change of [{ changedFiles: 3 }, { insertions: 9 }, { deletions: 1 }, { ahead: 1 }]) { move(change); await f.advance(30_000) }
  expect(f.delivered).toHaveLength(told)
  expect(f.wakes.evidence.read(centerTarget).find(fact => fact.source === 'github' && fact.fact === 'pull-request-observed')).toMatchObject({ availability: 'available' })
})
it('counts a pull request’s change as needing Watcher, and a thread’s own facts as not', async () => {
  const f = fixture(), { move } = gitFixture(f)
  f.wakes.observe(); await f.advance(2_000)
  f.checks('failed'); await f.advance(2_000)
  const checks = f.delivered.at(-1)!.events
  expect(checks.map(event => event.kind)).toEqual(['evidence-changed'])
  expect(f.wakes.needsAttention(checks)).toBe(true)
  // The thread's own record of the link is read on its next observation, as part of that same pull request's news.
  f.wakes.observe(); await f.advance(5_000)
  const count = f.delivered.length
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-1', status: 'completed' }; move({ changedFiles: 7 }); f.wakes.observe()
  await f.advance(5_000)
  expect(f.delivered).toHaveLength(count + 1)
  const own = f.delivered.at(-1)!.events.filter(event => event.kind === 'evidence-changed')
  expect(own).toHaveLength(1)
  expect(f.wakes.needsAttention(own)).toBe(false)
  expect(f.wakes.needsAttention(f.delivered.at(-1)!.events)).toBe(true)
})

it('tells quiet and pull request news afresh once their wake-up is let go with its send unknown, as a restart does', async () => {
  const f = fixture()
  await f.advance(WATCHER_QUIET_MS + 2_000)
  const quiet = f.delivered.flatMap(news => news.events).filter(event => event.kind === 'quiet')
  expect(quiet).toHaveLength(1)
  f.checks('failed'); await f.advance(2_000)
  const checks = f.delivered.at(-1)!.events.filter(event => event.kind === 'evidence-changed')
  expect(checks).toHaveLength(1)
  const told = f.delivered.length
  // Nothing about the thread changes; only the wake-up that carried this news was let go.
  f.wakes.settled([...quiet, ...checks], 'unknown'); await f.advance(2_000)
  const again = f.delivered.slice(told).flatMap(news => news.events)
  expect(again.filter(event => event.kind === 'quiet')).toHaveLength(1)
  expect(again.filter(event => event.kind === 'evidence-changed')).toHaveLength(1)
  expect(f.wakes.needsAttention(again)).toBe(true)
})

it('keeps a retry that news needing Watcher earns while a wake-up is being saved, for the next wake-up (review P2)', async () => {
  let waking = false
  const f = fixture(true, undefined, { wakeUpQueued: () => waking })
  finish(f.thread); f.wakes.observe(); await f.advance(2_000)
  // That one missed, with nothing new beside it: the next needs news that needs Watcher.
  waking = true; f.wakes.settled(f.delivered[0]!.events, 'failed'); waking = false
  f.thread.requests = [{ id: 'card-1', kind: 'question', text: 'secret', options: [] }]; f.wakes.observe()
  // While that question's wake-up is being saved, a second question comes.
  const saving = deferredPromise()
  f.deliver.mockImplementationOnce(async news => { f.delivered.push(structuredClone(news)); await saving.promise })
  const flushed = f.advance(2_000)
  await vi.waitFor(() => expect(f.delivered).toHaveLength(2))
  f.thread.requests.push({ id: 'card-2', kind: 'question', text: 'secret', options: [] }); f.wakes.observe()
  saving.resolve(); await flushed
  waking = true
  await f.advance(10_000)
  expect(f.delivered).toHaveLength(2)
  // The first question's wake-up misses too. The second question is news it did not carry, so it makes the next.
  waking = false; f.wakes.settled(f.delivered[1]!.events, 'failed'); await f.advance(2_000)
  expect(f.delivered).toHaveLength(3)
  expect(f.delivered[2]!.events.map(event => event.requestCardId).filter(Boolean).sort()).toEqual(['card-1', 'card-2'])
})
function deferredPromise() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

it('never sends a thread’s own facts alone when the news beside them went stale while their batch waited its turn (review P2)', async () => {
  const f = fixture()
  // A question's wake-up is being saved, so the next batch waits behind it.
  const saving = deferredPromise()
  f.deliver.mockImplementationOnce(async news => { f.delivered.push(structuredClone(news)); await saving.promise })
  f.thread.requests = [{ id: 'card', kind: 'question', text: 'secret', options: [] }]; f.wakes.observe()
  const first = f.advance(2_000)
  await vi.waitFor(() => expect(f.delivered).toHaveLength(1))
  // Meanwhile the turn ends with its working copy changed, and that batch is taken and waits its turn.
  finish(f.thread); f.wakes.observe()
  f.wakes.checkpoint({ threadId: f.thread.id, checkpointId: 'capture', observedAt: new Date(f.now()).toISOString(), availability: 'available', changedFiles: 3 })
  const second = f.advance(2_000)
  // Before it goes, the thread starts its next turn: the finish is no longer true, and the facts beside it wake no one.
  f.thread.status = 'running'; f.thread.lastTurn = { id: 'turn-2', status: 'running' }; f.wakes.observe()
  saving.resolve(); await first; await second; await f.advance(10_000)
  expect(f.delivered.slice(1).map(news => news.events.map(event => event.kind))).toEqual([])
  // They ride with the turn's next end, the question having been told already.
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-2', status: 'completed' }; f.wakes.observe()
  await f.advance(2_000)
  expect(f.delivered.at(-1)!.events.map(event => event.kind).sort()).toEqual(['evidence-changed', 'turn-finished'])
})

it('never wakes Watcher with a thread’s own facts alone, while its hidden wake-up is on its way or after it was told', async () => {
  let waking = false
  const f = fixture(true, undefined, { wakeUpQueued: () => waking }), { move } = gitFixture(f)
  f.wakes.observe(); await f.advance(2_000)
  f.checks('failed'); await f.advance(2_000)
  // The thread's own record of the link is read on its next observation, as part of that same pull request's news.
  f.wakes.observe(); await f.advance(5_000)
  f.delivered.splice(0, f.delivered.length - 1)
  expect(f.delivered.map(kinds)).toEqual([['evidence-changed']])
  // The worker's tool calls move the working copy while that wake-up is sent, and after it is told. None of it wakes Watcher.
  waking = true
  for (const change of [{ changedFiles: 3 }, { insertions: 9 }]) { move(change); await f.advance(30_000) }
  waking = false; f.wakes.settled(f.delivered[0]!.events, 'told')
  for (const change of [{ deletions: 1 }, { ahead: 1 }]) { move(change); await f.advance(30_000) }
  expect(f.delivered).toHaveLength(1)
  // They ride with the turn's end.
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-1', status: 'completed' }; f.wakes.observe(); await f.advance(5_000)
  expect(f.delivered.map(kinds)).toEqual([['evidence-changed'], ['turn-finished', 'evidence-changed']])
  expect(f.wakes.needsAttention(f.delivered[1]!.events.filter(event => event.kind === 'evidence-changed'))).toBe(false)
})

it('works out news only for watched threads', async () => {
  const f = fixture(), { move } = gitFixture(f)
  // A thread no request or watch names: its facts stay current, and no news is worked out for it.
  const other: AgentThread = { ...structuredClone(f.thread), id: 'unwatched', title: 'Unwatched' }
  f.snapshot.threads.push(other)
  const digest = vi.spyOn(f.wakes.evidence, 'digest')
  for (let n = 0; n < 5; n++) { other.messages = [{ id: `m-${n}`, role: 'assistant', text: 'x', createdAt: centerTime }]; f.wakes.observe() }
  expect(digest.mock.calls.filter(([target]) => target.threadId === 'unwatched')).toEqual([])
  void move
})

it('keeps a failed pull request’s news needing Watcher where a thread’s own facts replaced it, though it is no news that came since', async () => {
  let waking = false
  const f = fixture(true, undefined, { wakeUpQueued: () => waking }), { move } = gitFixture(f)
  f.wakes.observe(); await f.advance(2_000)
  f.checks('failed'); await f.advance(2_000)
  f.wakes.observe(); await f.advance(5_000)
  f.delivered.splice(0, f.delivered.length - 1)
  const pullRequest = f.delivered[0]!.events
  // While its wake-up is sent, the worker's turn ends and its working copy moves: the turn end carries the thread's facts.
  waking = true
  f.thread.status = 'idle'; f.thread.lastTurn = { id: 'turn-1', status: 'completed' }; f.wakes.observe()
  move({ changedFiles: 6 }); await f.advance(5_000)
  expect(f.delivered).toHaveLength(1)
  // The send failed: the pull request's news goes back, and the facts that replaced it carry it.
  waking = false; f.wakes.settled(pullRequest, 'failed'); await f.advance(5_000)
  expect(f.delivered.map(news => kinds(news)!.sort())).toEqual([['evidence-changed'], ['evidence-changed', 'turn-finished']])
  const replaced = f.delivered[1]!.events.find(event => event.kind === 'evidence-changed')!
  expect(replaced.id).not.toBe(pullRequest[0]!.id)
  expect(f.wakes.needsAttention([replaced])).toBe(true)
  // The turn's end was the news that came since; with it told, the same facts failing again wait for Watcher.
  f.wakes.settled(f.delivered[1]!.events, 'failed'); await f.advance(60_000)
  expect(f.delivered).toHaveLength(2)
})
it('rechecks a batch of news with a fixed number of snapshot and record reads, whatever its size (#1023)', async () => {
  const reads = async (size: number) => {
    const count = { snapshots: 0, records: 0 }
    const own: { snapshot?: AgentHostSnapshot; record?: WatcherRecord } = {}
    let counting = false
    const f = fixture(false, undefined, { snapshot: () => { if (counting) count.snapshots++; return own.snapshot! },
      record: () => { if (counting) count.records++; return own.record! } })
    own.snapshot = f.snapshot; own.record = f.record; f.wakes.start()
    for (let n = 0; n < size; n++) f.thread.requests.push({ id: `question-${n}`, kind: 'question', text: 'Synthetic question', options: [] })
    f.wakes.observe()
    counting = true; await f.advance(2_000); counting = false
    expect(f.delivered.flatMap(news => news.events).filter(event => event.kind === 'needs-user')).toHaveLength(size)
    return count
  }
  expect(await reads(24)).toEqual(await reads(2))
})
