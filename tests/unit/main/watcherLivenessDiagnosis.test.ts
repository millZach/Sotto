// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../../src/shared/agents'
import { WATCHER_QUIET_MS, watcherOverview } from '../../../src/shared/watcherOverview'
import { WATCHER_BATCH_MS, type WatcherNews } from '../../../src/shared/watcherNews'
import { WatcherWakeUp } from '../../../src/main/agents/watcherWakeUp'
import { centerTarget, watcherRecordFixture } from '../../fixtures/watcher'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(close => close()))

/** The retained Codex roster projection, independent of an evictable activity window. */
function roster(thread: AgentThread, working: number, unknown = 0): void {
  thread.subagentSummary = { total: 4, working, unknown, completed: 4 - working - unknown, failed: 0, interrupted: 0 }
}
function claudeWork(thread: AgentThread, working: number): void {
  thread.providerId = 'claude'
  thread.backgroundWork = Array.from({ length: working }, (_, n) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, label: 'Synthetic background agent', type: 'subagent' as const,
  }))
}
function ciMonitor(thread: AgentThread, working: number): void {
  thread.monitoring = working ? [{ id: '00000000-0000-4000-8000-000000000099', label: 'Synthetic CI monitoring' }] : []
}

/** No provider, network or wall-clock waits: observe -> actual deadline -> due recheck -> delivery. */
function fixture(work: (thread: AgentThread) => void) {
  let clock = Date.parse('2026-10-17T10:00:00Z')
  const timers = new Set<{ at: number; callback: () => void }>()
  const record = watcherRecordFixture()
  // Delivery receipts are independent of the liveness episode under test.
  record.operations = []; record.reservations = []
  const thread: AgentThread = { id: centerTarget.threadId, providerId: 'codex', projectId: 'project', modelId: 'model', title: 'Worker',
    status: 'idle', lastTurn: { id: 'turn-1', status: 'completed' }, messages: [], requests: [] }
  work(thread)
  const snapshot: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), connected: true, hostId: centerTarget.hostId,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true }, threads: [thread], projects: [{ id: 'project', title: 'Project', path: 'synthetic' }] }
  const delivered: WatcherNews[] = []
  const create = () => {
    const wakes = new WatcherWakeUp({ snapshot: () => snapshot, record: () => record, now: () => clock,
      schedule: (callback, delay) => { const timer = { at: clock + delay, callback }; timers.add(timer); return () => { timers.delete(timer) } },
      canDeliver: () => true, deliver: async news => { delivered.push(structuredClone(news)) }, prune: async () => undefined,
      remember: async ids => { record.wakeEventIds = [...record.wakeEventIds ?? [], ...ids] } })
    cleanups.push(() => wakes.close())
    return wakes
  }
  let wakes = create()
  wakes.start()
  const advance = async (ms: number) => {
    const end = clock + ms
    while (true) {
      const timer = [...timers].sort((a, b) => a.at - b.at).find(item => item.at <= end)
      if (!timer) break
      clock = timer.at; timers.delete(timer); timer.callback(); await wakes.drained()
    }
    clock = end; await wakes.drained()
  }
  return { thread, snapshot, delivered, advance, observe: () => wakes.observe(),
    // The grouping list_threads shows, read from the same observations at the fixture's clock.
    group: () => watcherOverview({ host: snapshot }, clock, wakes.observations)[0]!.group,
    restart: () => { wakes.close(); wakes = create(); wakes.start() },
    events: () => delivered.flatMap(news => news.events),
    quiet: () => delivered.flatMap(news => news.events).filter(event => event.kind === 'quiet') }
}

it.each([
  ['Claude confirmed background work', (thread: AgentThread) => claudeWork(thread, 4), 4],
  ['Codex working subagent roster', (thread: AgentThread) => roster(thread, 4), 4],
  ['provider-confirmed CI monitoring', (thread: AgentThread) => ciMonitor(thread, 1), 1],
  ['Codex roster and stable CI monitoring', (thread: AgentThread) => { roster(thread, 4); ciMonitor(thread, 1) }, 5],
] as const)('wakes once after twenty quiet minutes when the parent is idle with %s', async (_, work, count) => {
  const f = fixture(work)
  await f.advance(WATCHER_BATCH_MS)
  expect(f.events().find(event => event.kind === 'turn-finished')?.backgroundWorkCount).toBe(count)
  expect(f.events().some(event => event.kind === 'work-settled')).toBe(false)
  await f.advance(WATCHER_QUIET_MS - WATCHER_BATCH_MS - 1)
  expect(f.quiet()).toHaveLength(0)
  await f.advance(1 + WATCHER_BATCH_MS)
  expect(f.quiet()).toEqual([expect.objectContaining({ target: centerTarget, turnId: 'turn-1' })])
  // An unchanged shell does not restart the episode or keep prompting forever.
  f.observe(); await f.advance(44 * 60_000)
  expect(f.quiet()).toHaveLength(1)
})

it('resets the idle parent quiet deadline when its retained Codex roster makes progress', async () => {
  const f = fixture(thread => roster(thread, 4))
  await f.advance(19 * 60_000)
  // The activity window need not contain this assignment: the retained roster is authoritative.
  roster(f.thread, 3); f.observe()
  await f.advance(60_000 + WATCHER_BATCH_MS)
  expect(f.quiet()).toHaveLength(0)
  await f.advance(WATCHER_QUIET_MS - 60_000)
  expect(f.quiet()).toHaveLength(1)
})

it('cancels liveness when the idle parent agents complete and settles their finished turn once', async () => {
  const f = fixture(thread => roster(thread, 4))
  await f.advance(19 * 60_000)
  roster(f.thread, 0); f.observe()
  await f.advance(44 * 60_000)
  expect(f.quiet()).toHaveLength(0)
  expect(f.events().filter(event => event.kind === 'work-settled')).toHaveLength(1)
  f.observe(); await f.advance(WATCHER_QUIET_MS)
  expect(f.events().filter(event => event.kind === 'work-settled')).toHaveLength(1)
})

it('keeps CI monitoring active after the parent agents complete', async () => {
  const f = fixture(thread => { roster(thread, 4); ciMonitor(thread, 1) })
  await f.advance(19 * 60_000)
  roster(f.thread, 0); f.observe()
  await f.advance(60_000 + WATCHER_BATCH_MS)
  expect(f.events().some(event => event.kind === 'work-settled')).toBe(false)
  expect(f.quiet()).toHaveLength(0)
  await f.advance(WATCHER_QUIET_MS - 60_000)
  expect(f.quiet()).toHaveLength(1)
  ciMonitor(f.thread, 0); f.observe(); await f.advance(WATCHER_BATCH_MS)
  expect(f.events().filter(event => event.kind === 'work-settled')).toHaveLength(1)
})

it('preserves owed completion across restart without calling unknown agents active or settled', async () => {
  const f = fixture(thread => roster(thread, 4))
  await f.advance(WATCHER_BATCH_MS)
  roster(f.thread, 0, 4); f.restart()
  await f.advance(44 * 60_000)
  expect(f.quiet()).toHaveLength(0)
  expect(f.events().filter(event => event.kind === 'turn-finished')).toHaveLength(1)
  expect(f.events().some(event => event.kind === 'work-settled')).toBe(false)
  roster(f.thread, 0); f.observe(); await f.advance(WATCHER_BATCH_MS)
  expect(f.events().filter(event => event.kind === 'work-settled')).toHaveLength(1)
})

it('starts a fresh quiet episode when the provider confirms restart-unknown agents working again', async () => {
  const f = fixture(thread => roster(thread, 0, 4))
  await f.advance(44 * 60_000)
  expect(f.quiet()).toHaveLength(0)
  roster(f.thread, 4); f.observe()
  await f.advance(WATCHER_QUIET_MS - 1)
  expect(f.quiet()).toHaveLength(0)
  await f.advance(1 + WATCHER_BATCH_MS)
  expect(f.quiet()).toHaveLength(1)
})

it('requires a fresh connected episode after reconnecting to an idle parent with working agents', async () => {
  const f = fixture(thread => roster(thread, 4))
  await f.advance(19 * 60_000)
  f.snapshot.connected = false; f.observe()
  await f.advance(44 * 60_000)
  expect(f.quiet()).toHaveLength(0)
  f.snapshot.connected = true; f.observe()
  await f.advance(WATCHER_QUIET_MS - 1)
  expect(f.quiet()).toHaveLength(0)
  await f.advance(1 + WATCHER_BATCH_MS)
  expect(f.quiet()).toHaveLength(1)
})

it.each([
  ['Codex working subagent roster', (thread: AgentThread) => roster(thread, 4)],
  ['Claude confirmed background work', (thread: AgentThread) => claudeWork(thread, 4)],
] as const)('groups an idle parent with %s as Working, then Quiet when its quiet news is due', async (_, work) => {
  // Bug Bot finding 4 on #1157: the wake called the parent active while list_threads still grouped it Idle.
  const f = fixture(work)
  await f.advance(WATCHER_BATCH_MS)
  expect(f.group()).toBe('Working')
  await f.advance(WATCHER_QUIET_MS - WATCHER_BATCH_MS + 1 + WATCHER_BATCH_MS)
  expect(f.quiet()).toHaveLength(1)
  expect(f.group()).toBe('Quiet')
})

it('keeps an idle parent whose agents are only unknown out of Working and Quiet', async () => {
  const f = fixture(thread => roster(thread, 0, 4))
  await f.advance(44 * 60_000)
  expect(f.quiet()).toHaveLength(0)
  expect(f.group()).toBe('Idle')
})
