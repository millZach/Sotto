// @vitest-environment node
/**
 * What committing streamed history costs main as more threads stream at once (#991). One event-sourced
 * adapter built like the native ones (their message log and snapshot publisher) streams into 1, 3 and 6
 * watched threads through the workspace host, over a real `threads.sqlite` on disk. It reports main's CPU
 * and event-loop time per streamed chunk, the time the thread store spent committing per 16 ms window and
 * how many commits that took, and how many `message-text-appended` rows a round of streaming wrote.
 * Every payload is generated here; no user profile is opened and nothing a thread "said" is printed.
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/streamingCommits.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, describe, expect, it } from 'vitest'
import { ActivitySubscribers } from '../../src/main/agents/activitySnapshots'
import type { ActivitySubscriptionOptions, ThreadHostEvent } from '../../src/main/agents/host'
import { adapterItemCount, ProviderSnapshotPublisher } from '../../src/main/agents/providerSnapshotPublisher'
import { ThreadMessageLog } from '../../src/main/agents/threadMessageLog'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../src/shared/agents'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const WINDOWS = 100
const ROUNDS = 3
const CHUNK = ' streamed words arrive in small pieces'

/** An event-sourced adapter that records through the adapters' log, as the native ones do. */
class StreamingAdapter extends FakeProviderHost {
  readonly log = new ThreadMessageLog()
  private readonly activityListeners = new ActivitySubscribers()
  private readonly publisher = new ProviderSnapshotPublisher(() => {
    super.emit()
    this.activityListeners.publish(historyFromEvents => this.activityView(historyFromEvents))
  }, () => adapterItemCount(this.log, this.state.threads))
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void {
    return this.activityListeners.add(listener, options)
  }
  observeThreads(threadIds: readonly string[]): void { super.observeThreads(threadIds); this.log.observe([...threadIds]) }
  publish(streaming: boolean): void { this.publisher.publish(streaming) }
  emit(): void { this.publish(false) }
  private activityView(historyFromEvents: boolean): AgentHostSnapshot {
    return { ...this.state, threads: this.state.threads.map(thread => this.log.activityThread(thread, historyFromEvents)) }
  }
}

/** Time the store spends in its commit calls, however the workspace batches them. */
const commit = { calls: 0, ms: 0, measuring: false }
const restores: Array<() => void> = []
function timeCommits(): void {
  const proto = ThreadStore.prototype as unknown as Record<string, (...args: never[]) => unknown>
  for (const name of ['appendMany', 'appendBatches', 'append']) {
    const original = proto[name]
    if (typeof original !== 'function') continue
    proto[name] = function (this: unknown, ...args: never[]) {
      if (!commit.measuring) return original.apply(this, args)
      const started = performance.now()
      try { return original.apply(this, args) } finally { commit.calls += 1; commit.ms += performance.now() - started }
    }
    restores.push(() => { proto[name] = original })
  }
}

const sleep = (ms: number) => new Promise<void>(done => { setTimeout(done, ms) })
const roots: string[] = []
afterAll(async () => {
  for (const restore of restores.splice(0)) restore()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-streaming-commits-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})

async function measure(threads: number): Promise<Record<string, number>> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-streaming-commits-')); roots.push(root)
  const ids = Array.from({ length: threads }, (_, index) => `stream-${index}`)
  const state: AgentHostSnapshot = {
    ...structuredClone(EMPTY_AGENT_HOST), name: 'fake', version: '1', connected: true,
    capabilities: { ...structuredClone(EMPTY_AGENT_HOST.capabilities), projects: true, threads: true, submit: true, observe: true },
    projects: [{ id: 'project', title: 'Synthetic project', path: root }],
    models: [{ id: 'fake:model', provider: 'Fake', name: 'Synthetic model', ready: true }],
    threads: ids.map((id): AgentThread => ({ id, projectId: 'project', title: id, modelId: 'fake:model', status: 'running', messages: [], requests: [] })),
  }
  const adapter = new StreamingAdapter(state)
  const workspace = new WorkspaceHost(adapter, root, () => true, undefined, false, false, true)
  await workspace.initialize()
  await workspace.connect()
  // The coordinator's subscription is what makes a publish apply events and read windows back.
  const unsubscribe = workspace.subscribeActivitySnapshots(() => undefined)
  workspace.observeThreads(ids)
  const at = new Date().toISOString()
  for (const id of ids) {
    adapter.log.add(id, { id: `${id}-prompt`, role: 'user', text: 'Synthetic prompt', createdAt: at })
    adapter.log.add(id, { id: `${id}-reply`, role: 'assistant', text: 'First', createdAt: at })
  }
  adapter.publish(false)
  await sleep(400)
  await workspace.flush()

  const rounds: Record<string, number>[] = []
  for (let index = 0; index < ROUNDS; index++) {
    const before = workspace.eventsAfter(0)
    const appendedBefore = before.filter(row => row.event.kind === 'message-text-appended').length
    commit.calls = 0; commit.ms = 0; commit.measuring = true
    const elu = performance.eventLoopUtilization(), cpu = process.cpuUsage(), started = performance.now()
    for (let window = 0; window < WINDOWS; window++) {
      for (const id of ids) adapter.log.appendText(id, `${id}-reply`, CHUNK)
      adapter.publish(true)
      await sleep(16)
    }
    const wall = performance.now() - started
    const used = performance.eventLoopUtilization(elu)
    const cpuUsed = process.cpuUsage(cpu)
    commit.measuring = false
    await sleep(400)
    await workspace.flush()
    const after = workspace.eventsAfter(0)
    const appended = after.filter(row => row.event.kind === 'message-text-appended').length - appendedBefore
    const chunks = WINDOWS * threads
    rounds.push({ wallMs: wall, cpuMsPerChunk: (cpuUsed.user + cpuUsed.system) / 1000 / chunks,
      activeMsPerWindow: used.active / WINDOWS, commitMsPerWindow: commit.ms / WINDOWS,
      commitsPerWindow: commit.calls / WINDOWS, appendRowsPerChunk: appended / chunks })
    // Everything streamed is in the store, whole, whatever the commit cadence was.
    for (const id of ids) {
      const reply = workspace.threadMessages(id).find(message => message.id === `${id}-reply`)
      expect(reply?.text).toBe('First' + CHUNK.repeat(WINDOWS * (index + 1)))
    }
  }
  unsubscribe(); workspace.disconnect(); await workspace.privacyChanged(); workspace.dispose()
  return Object.fromEntries(Object.keys(rounds[0]!).map(key => [key, round(median(rounds.map(item => item[key]!)), 3)]))
}

describe.skipIf(!PERF_BENCH)('committing streamed history with 1, 3 and 6 streaming threads (timing benchmark; requires SOTTO_PERF_BENCH=1)', () => {
  it('reports CPU per chunk, commit time per window and append rows written', async () => {
    timeCommits()
    for (const threads of [1, 3, 6]) {
      const summary = await measure(threads)
      console.log(`streaming commits (${threads} thread${threads === 1 ? '' : 's'}, ${WINDOWS} windows, ${ROUNDS} rounds, medians): ${JSON.stringify(summary)}`)
    }
  }, 300_000)
})
