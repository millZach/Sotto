// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentThread } from '../../../src/shared/agents'
import { WATCHER_QUIET_MS } from '../../../src/shared/watcherOverview'
import type { WatcherNews } from '../../../src/shared/watcherNews'
import { WatcherWakeUp } from '../../../src/main/agents/watcherWakeUp'
import { foldWatcherNews, watcherNewsText } from '../../../src/main/agents/watcherNews'
import { queuedWakeUpText, wakeUpText } from '../../../src/main/agents/wakeUp'
import type { BabysitNews } from '../../../src/main/agents/babysitNews'
import { centerTarget, watcherRecordFixture } from '../../fixtures/watcher'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()) })
function fixture() {
  let clock = Date.parse('2026-10-11T10:00:00Z')
  const timers = new Set<{ at: number; callback: () => void }>()
  const record = watcherRecordFixture()
  const thread: AgentThread = { id: centerTarget.threadId, providerId: 'codex', projectId: 'project', modelId: 'model', title: 'Worker',
    status: 'running', lastTurn: { id: 'turn-1', status: 'running' }, messages: [], requests: [] }
  const snapshot = { ...structuredClone(EMPTY_AGENT_HOST), connected: true, hostId: centerTarget.hostId,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true }, threads: [thread], projects: [{ id: 'project', title: 'Project', path: 'synthetic' }] }
  const delivered: WatcherNews[] = [], prune = vi.fn(async () => undefined)
  const wakes = new WatcherWakeUp({ now: () => clock, snapshot: () => snapshot, record: () => record, prune,
    schedule: (callback, delay) => { const timer = { at: clock + delay, callback }; timers.add(timer); return () => { timers.delete(timer) } },
    deliver: async news => { delivered.push(structuredClone(news)) }, remember: async ids => { record.wakeEventIds = [...record.wakeEventIds ?? [], ...ids] } })
  cleanups.push(() => wakes.close())
  wakes.start()
  const advance = async (ms: number) => {
    const end = clock + ms
    while (true) {
      const timer = [...timers].sort((a, b) => a.at - b.at).find(timer => timer.at <= end)
      if (!timer) break
      clock = timer.at; timers.delete(timer); timer.callback(); await wakes.drained()
    }
    clock = end; await wakes.drained()
  }
  return { wakes, record, snapshot, thread, timers, delivered, advance, now: () => clock }
}

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
  const recovered = new WatcherWakeUp({ snapshot: () => f.snapshot, record: () => f.record, deliver: delivered,
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
  expect(mixed).toContain('Sotto saw changes')
  expect(mixed).toContain('Pull request #1')
})
