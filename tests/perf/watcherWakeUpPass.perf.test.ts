// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/watcherWakeUpPass.perf.test.ts --maxWorkers=1 --disable-console-intercept
/**
 * What Watcher's wake-up pass costs over watched threads with long histories (#1331). On the owner's installed build
 * the pass worked out every watched thread's progress fingerprint from its whole history on every pass, built the same
 * target keys again and again, and the room's news read asked every recent event afresh on every publish.
 *
 * Five standing-watched threads each hold 2,000 certified activity records and 300 messages, as a long Codex thread
 * does. Three stream: between passes one of them replaces its newest record, as an adapter does with each chunk. Two
 * have finished turns, so news waits, and so do sixty short watched threads that finished in a Git working copy. It times, in rounds of synchronous calls with nothing else on the event loop:
 * - `still`: an observe pass in which nothing changed;
 * - `streaming`: an observe pass after one thread's newest record grew;
 * - `news`: one read of the news that is due, as `WatcherService.state()` asks on every room publish;
 * - `soon`: `observeSoon` for an update inside the wait, as every coordinator broadcast asks.
 * It reports timings only, so it runs when asked.
 */
import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { immutableActivities } from '../../src/main/agents/activitySnapshots'
import { WatcherWakeUp } from '../../src/main/agents/watcherWakeUp'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentMessage, type AgentThread } from '../../src/shared/agents'
import { centerHostId, centerTime, watcherRecordFixture } from '../fixtures/watcher'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'

const THREADS = 5, ACTIVITIES = 2_000, MESSAGES = 300, ROUNDS = 5
/** Short watched threads whose turns finished in a Git working copy, so the news read has a few hundred events to ask. */
const FINISHED = 60
const ITERATIONS = { still: 40, streaming: 40, news: 400, soon: 400 } as const

const record = (thread: number, index: number, output: string): AgentActivity => ({ id: `activity-${thread}-${index}`, turnId: `turn-${thread}-${Math.floor(index / 20)}`,
  sequence: index, kind: index % 5 === 0 ? 'plan' : 'command', status: 'completed', title: 'Synthetic step', output, startedAt: centerTime, completedAt: centerTime,
  ...index % 5 === 0 ? { steps: [{ text: 'Synthetic plan step', status: 'completed' as const }, { text: 'Another step', status: 'pending' as const }] } : {} })

function workload() {
  let clock = Date.parse('2026-10-22T10:00:00Z')
  const watcherRecord = watcherRecordFixture()
  watcherRecord.operations[0]!.deliveryState = 'accepted'
  watcherRecord.requests[0]!.participants = []
  watcherRecord.watches = []
  const threads: AgentThread[] = []
  for (let index = 0; index < THREADS; index++) {
    const running = index < 3, threadId = `worker-${index}`
    const messages: AgentMessage[] = Array.from({ length: MESSAGES }, (_, position) => ({ id: `message-${index}-${position}`, role: position % 2 ? 'assistant' : 'user',
      text: 'Synthetic fixture text '.repeat(1 + position % 4), createdAt: centerTime }))
    threads.push({ id: threadId, providerId: 'codex', projectId: 'project', modelId: 'model', title: 'Synthetic worker', status: running ? 'running' : 'idle',
      clientConnected: true, lastTurn: { id: `turn-${index}`, status: running ? 'running' : 'completed' }, requests: [], messages,
      activities: immutableActivities(Array.from({ length: ACTIVITIES }, (_, position) => record(index, position, 'synthetic output line\n'.repeat(3)))) })
    watcherRecord.watches.push({ id: `00000000-0000-4000-8000-${(200 + index).toString(16).padStart(12, '0')}`, target: { hostId: centerHostId, threadId },
      createdAt: centerTime, generation: 0, pausedByUserMessageId: null })
  }
  for (let index = 0; index < FINISHED; index++) {
    const threadId = `finished-${index}`
    threads.push({ id: threadId, providerId: 'codex', projectId: 'project', modelId: 'model', title: 'Synthetic worker', status: 'idle', clientConnected: true,
      lastTurn: { id: `finished-turn-${index}`, status: 'completed' }, requests: [], messages: [{ id: `finished-message-${index}`, role: 'assistant', text: 'Done', createdAt: centerTime }],
      worktree: { mode: 'shared', status: 'ready', branch: 'feature', baseBranch: 'main', git: { isRepository: true, branch: 'feature', upstream: null,
        hasRemote: true, defaultBranch: 'main', isDefaultBranch: false, dirty: true, changedFiles: 1 + index % 7, insertions: index, deletions: 0, ahead: 1, behind: 0,
        aheadOfDefault: null, pullRequest: null, readAt: centerTime, fetchedAt: null } } })
    watcherRecord.watches.push({ id: `00000000-0000-4000-8000-${(1_000 + index).toString(16).padStart(12, '0')}`, target: { hostId: centerHostId, threadId },
      createdAt: centerTime, generation: 0, pausedByUserMessageId: null })
  }
  const snapshot: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), connected: true, hostId: centerHostId,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, observe: true }, projects: [{ id: 'project', title: 'Synthetic project', path: 'synthetic' }], threads }
  const wakes = new WatcherWakeUp({ now: () => clock, snapshot: () => snapshot, record: () => watcherRecord, prune: async () => undefined,
    schedule: () => () => undefined, deliver: async () => undefined, remember: async () => undefined, canDeliver: () => false })
  wakes.start()
  let grown = 0
  /** One streamed chunk: a running thread's newest record grows and the adapter replaces it and the array. */
  const stream = () => {
    const thread = threads[grown % 3]!, activities = thread.activities!, last = activities.at(-1)!
    grown++
    thread.activities = immutableActivities([...activities.slice(0, -1), { ...last, status: 'running', output: `${last.output ?? ''}more\n` }])
  }
  return { wakes, stream, advance: (ms: number) => { clock += ms } }
}

function time(rounds: number, iterations: number, run: () => void): number {
  const samples: number[] = []
  for (let round = 0; round < rounds; round++) {
    const start = performance.now()
    for (let index = 0; index < iterations; index++) run()
    samples.push((performance.now() - start) / iterations)
  }
  return median(samples)
}

describe.skipIf(!PERF_BENCH)('Watcher wake-up pass over long watched threads (#1331)', () => {
  it('times an observe pass, a news read and an update inside the wait', () => {
    const f = workload()
    f.wakes.observe()
    const due = f.wakes.news().length
    expect(due).toBeGreaterThan(FINISHED)
    const still = time(ROUNDS, ITERATIONS.still, () => f.wakes.observe())
    const streaming = time(ROUNDS, ITERATIONS.streaming, () => { f.stream(); f.wakes.observe() })
    const news = time(ROUNDS, ITERATIONS.news, () => f.wakes.news())
    f.wakes.observe()
    const soon = time(ROUNDS, ITERATIONS.soon, () => f.wakes.observeSoon(() => undefined))
    console.log(JSON.stringify({ threads: THREADS, finished: FINISHED, due, activities: ACTIVITIES, messages: MESSAGES, msPerCall: {
      still: round(still, 3), streaming: round(streaming, 3), news: round(news, 4), soon: round(soon, 4) } }))
  })
})
