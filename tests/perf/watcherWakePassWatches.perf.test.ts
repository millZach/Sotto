// @vitest-environment node
// SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/watcherWakePassWatches.perf.test.ts --maxWorkers=1 --disable-console-intercept
/**
 * What Watcher's wake-up pass costs for each watched thread that did not change (#1248). One watched thread streams while
 * `idle` other watched threads, each as long as forge's longest (2,000 activity records, 550 messages), stay as they
 * were, beside 200 threads no one watches. Every record is owned, copied and frozen all the way down, as the coordinator's
 * records are, and the pass reads them through Watcher's look-ups into this computer's threads (`WatcherHosts`), following
 * the coordinator's changes, as on the desktop. It times, in rounds of synchronous passes:
 * - `still`: a pass after an update that changed only a thread no one watches;
 * - `streaming`: a pass after the streaming thread's reply grew by a chunk.
 * It reports timings only, so it runs when asked.
 */
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { immutableRecord } from '../../src/main/agents/activitySnapshots'
import type { HostThreadsChange, HostThreadsView } from '../../src/main/agents/control'
import { WatcherHosts } from '../../src/main/agents/watcherHosts'
import { WatcherWakeUp } from '../../src/main/agents/watcherWakeUp'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../src/shared/agents'
import { emptyWatcherRecord, type WatcherRecord } from '../../src/shared/watcher'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'

const LOCAL = '11111111-1111-4111-8111-111111111111'
const AT = '2026-11-01T12:00:00.000Z'
const ACTIVITIES = 2_000, MESSAGES = 550, UNWATCHED = 200, ROUNDS = 7, ITERATIONS = 40
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

const activity = (thread: string, index: number): AgentActivity => ({ id: `${thread}-activity-${index}`, turnId: `${thread}-turn-${Math.floor(index / 20)}`,
  sequence: index, kind: 'command', status: 'completed', title: 'Synthetic step', output: 'synthetic output line\n'.repeat(3), startedAt: AT, completedAt: AT })
/** A long thread, owned as the coordinator's records are. */
const long = (id: string, fields: Partial<AgentThread> = {}): AgentThread => immutableRecord({ id, providerId: 'claude', projectId: 'project', modelId: 'model',
  title: 'Synthetic worker', status: 'idle', lastTurn: { id: `${id}-turn`, status: 'completed' }, requests: [],
  messages: Array.from({ length: MESSAGES }, (_, index) => ({ id: `${id}-message-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
    text: 'Synthetic fixture text '.repeat(1 + index % 4), createdAt: AT })),
  activities: Array.from({ length: ACTIVITIES }, (_, index) => activity(id, index)), ...fields } as AgentThread)

function workload(idle: number) {
  const ids = Array.from({ length: idle }, (_, index) => `idle-${index}`)
  let threads: AgentThread[] = [immutableRecord({ id: 'w', kind: 'watcher', projectId: 'project', title: 'Watcher', modelId: 'model', status: 'idle', messages: [], requests: [] } as AgentThread),
    long('s', { status: 'running', lastTurn: { id: 's-turn', status: 'running' } }), ...ids.map(id => long(id)),
    ...Array.from({ length: UNWATCHED }, (_, index) => immutableRecord({ id: `u-${index}`, projectId: 'project', title: 'Other', modelId: 'model', status: 'idle',
      messages: [], requests: [] } as AgentThread))]
  // The coordinator's index of its thread list, patched in place as an accept of thread changes patches it.
  const byId = new Map(threads.map(item => [item.id, item])), at = new Map(threads.map((item, position) => [item.id, position]))
  const view: HostThreadsView = { thread: id => byId.get(id), position: id => at.get(id), delegatedFrom: () => undefined, watcherKinds: new Set(['w']), foreign: false }
  let snapshot: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), hostId: LOCAL, connected: true, capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true },
    projects: [{ id: 'project', title: 'Project', path: '/project' }], providers: [{ id: 'claude', name: 'Claude', connection: 'connected' }] as unknown as AgentHostSnapshot['providers'], threads }
  const hosts = new WatcherHosts({ local: () => snapshot, localThreads: of => of === snapshot ? view : undefined, remote: () => undefined })
  const record: WatcherRecord = { ...emptyWatcherRecord(), current: { target: { hostId: LOCAL, threadId: 'w' }, projectId: 'project', provider: 'claude',
    creationOperationId: uuid(1), createdAt: AT },
  watches: ['s', ...ids].map((threadId, index) => ({ id: uuid(100 + index), target: { hostId: LOCAL, threadId }, createdAt: AT, generation: 0,
    pausedByUserMessageId: null, lastUserMessageId: null })) }
  let clock = Date.parse(AT)
  const wakes = new WatcherWakeUp({ snapshot: () => hosts.snapshot(), hosts, record: () => record, canDeliver: () => false, deliver: async () => undefined,
    prune: async () => undefined, remember: async () => undefined, now: () => clock, schedule: () => () => undefined })
  /** Replaces one thread's record in place, as an accept of thread changes does, and hands Watcher the change. */
  const replace = (record: AgentThread) => {
    const from = snapshot, previous = new Map([[record.id, byId.get(record.id)!]])
    threads = threads.slice(); threads[at.get(record.id)!] = record; byId.set(record.id, record)
    snapshot = { ...from, threads }
    const change: HostThreadsChange = { from, threads: [record], previous }
    hosts.localChanged(snapshot, change)
    clock += 250
  }
  let chunk = 0
  return {
    wakes,
    /** A thread no one watches changes. */
    other: () => { const before = byId.get('u-0')!; replace(immutableRecord({ ...before, title: `Other ${chunk++}` })) },
    /** The streaming thread's reply grows by a chunk; every other message is shared. */
    stream: () => {
      const before = byId.get('s')!, last = before.messages.at(-1)!
      replace(immutableRecord({ ...before, messages: [...before.messages.slice(0, -1), { ...last, text: `${last.text} word${chunk++}` }] }))
    },
  }
}

/** The median of rounds of passes, each after `change`, which is not timed. */
function time(change: () => void, pass: () => void): number {
  const samples: number[] = []
  for (let roundAt = 0; roundAt < ROUNDS; roundAt++) {
    let spent = 0
    for (let index = 0; index < ITERATIONS; index++) { change(); const start = performance.now(); pass(); spent += performance.now() - start }
    samples.push(spent / ITERATIONS)
  }
  return median(samples)
}

describe.skipIf(!PERF_BENCH)('Watcher wake-up pass with long watched threads that do not change (#1248)', () => {
  it('times a pass after an update to a thread no one watches and after a streamed chunk', () => {
    const results: Record<string, { still: number; streaming: number }> = {}
    for (const idle of [0, 5, 20]) {
      const f = workload(idle)
      f.wakes.start(); f.wakes.observe(); f.wakes.observe()
      // Warm up, then time.
      for (let index = 0; index < 20; index++) { f.other(); f.wakes.observe(); f.stream(); f.wakes.observe() }
      const still = time(f.other, () => f.wakes.observe())
      const streaming = time(f.stream, () => f.wakes.observe())
      results[`${idle} idle`] = { still: round(still, 3), streaming: round(streaming, 3) }
      expect((f.wakes as unknown as { observedChanges: number }).observedChanges).toBeGreaterThan(0)
    }
    console.log(`WATCHER-WAKE-PASS ${JSON.stringify({ activities: ACTIVITIES, messages: MESSAGES, unwatched: UNWATCHED, msPerPass: results })}`)
  })
})
