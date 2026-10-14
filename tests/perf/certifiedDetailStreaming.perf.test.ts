// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/certifiedDetailStreaming.perf.test.ts --maxWorkers=1 --disable-console-intercept
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { ActivitySubscribers, immutableActivities } from '../../src/main/agents/activitySnapshots'
import { AgentControl, coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../../src/main/agents/control'
import type { ActivitySubscriptionOptions, ThreadHostEvent } from '../../src/main/agents/host'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { ThreadMessageLog } from '../../src/main/agents/threadMessageLog'
import { ProviderSnapshotPublisher, adapterItemCount } from '../../src/main/agents/providerSnapshotPublisher'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../src/shared/agents'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { testCredentials } from '../fixtures/testCredentials'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'

/** Native-shaped event and certified activity publisher; no user profile or live provider is used. */
class StreamingAdapter extends FakeProviderHost {
  readonly log = new ThreadMessageLog()
  private readonly activities = new ActivitySubscribers()
  private readonly publisher = new ProviderSnapshotPublisher(() => this.activities.publish(historyFromEvents => ({
    ...this.state, threads: this.state.threads.map(thread => this.log.activityThread(thread, historyFromEvents)),
  })), () => adapterItemCount(this.log, this.state.threads))
  subscribeEvents(listener: (event: ThreadHostEvent) => void): () => void { return this.log.subscribeEvents(listener) }
  subscribeActivitySnapshots(listener: (snapshot: AgentHostSnapshot) => void, options?: ActivitySubscriptionOptions): () => void { return this.activities.add(listener, options) }
  observeThreads(ids: readonly string[]): void { this.log.observe([...ids]) }
  publish(streaming: boolean): void { this.publisher.publish(streaming) }
}
const sleep = (ms: number) => new Promise<void>(done => { setTimeout(done, ms) })
const WINDOWS = 60

async function measure(threads: number, enabled: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-certified-detail-'))
  const ids = Array.from({ length: threads }, (_, i) => `stream-${i}`)
  const adapter = new StreamingAdapter({ ...structuredClone(EMPTY_AGENT_HOST), name: 'Synthetic', connected: true,
    capabilities: { ...EMPTY_AGENT_HOST.capabilities, projects: true, threads: true, submit: true, observe: true },
    projects: [{ id: 'project', title: 'Synthetic', path: root }], models: [{ id: 'fake:model', name: 'Synthetic', provider: 'Fake', ready: true }],
    threads: ids.map((id): AgentThread => ({ id, projectId: 'project', title: 'Synthetic', modelId: 'fake:model', status: 'running', messages: [], requests: [] })) })
  const workspace = new WorkspaceHost(adapter, root, () => true, undefined, false, true)
  await workspace.initialize()
  const control = new AgentControl({ directory: root, host: workspace, credentials: await testCredentials(root, { mode: 'unavailable' }), reasoner: {}, streamingPublishCost: enabled })
  const statePublisher = coalesceAgentStatePublishes(() => undefined)
  let detailSends = 0
  const detailPublisher = coalesceAgentThreadDetailPublishes(() => { detailSends++ }, { beforeOpening: () => statePublisher.flush() })
  const offState = control.subscribe(value => statePublisher.publish(value))
  const offDetail = control.subscribeThreadDetail(value => detailPublisher.publish(value))
  try {
    await control.start(); await control.command({ type: 'connect' }); await control.command({ type: 'observe-threads', threadIds: ids })
    for (const id of ids) {
      const thread = adapter.state.threads.find(item => item.id === id)!
      thread.activities = immutableActivities(Array.from({ length: 2000 }, (_, i): AgentActivity => ({ id: `${id}-${i}`, turnId: `${id}-prompt`, sequence: i, kind: 'command', status: 'running', title: 'Synthetic command', output: 'x'.repeat(2048), steps: [{ text: 'Synthetic step', status: 'running' }] })))
      adapter.log.add(id, { id: `${id}-prompt`, role: 'user', text: 'Synthetic prompt', createdAt: '2026-10-13' })
      adapter.log.add(id, { id: `${id}-reply`, role: 'assistant', text: 'First', createdAt: '2026-10-13' })
    }
    adapter.publish(false); await sleep(400); await workspace.flush()
    for (const id of ids) expect(control.threadDetail(id)?.activities).toHaveLength(2000)
    const samples: Record<string, number>[] = []
    for (let run = 0; run < 3; run++) {
      const cpu = process.cpuUsage(), elu = performance.eventLoopUtilization(), started = performance.now()
      detailSends = 0
      for (let window = 0; window < WINDOWS; window++) {
        for (const thread of adapter.state.threads) {
          adapter.log.appendText(thread.id, `${thread.id}-reply`, ' words')
          thread.activities = immutableActivities([...thread.activities!.slice(0, -1), { ...thread.activities!.at(-1)!, output: thread.activities!.at(-1)!.output + ' output' }])
        }
        adapter.publish(true); await sleep(16)
      }
      const used = process.cpuUsage(cpu), active = performance.eventLoopUtilization(elu)
      samples.push({ wallMs: performance.now() - started, cpuMsPerChunk: (used.user + used.system) / 1000 / (WINDOWS * threads), activeMsPerWindow: active.active / WINDOWS, detailSends })
      await workspace.flush()
      for (const id of ids) expect(workspace.threadMessages(id).at(-1)?.text).toBe('First' + ' words'.repeat(WINDOWS * (run + 1)))
    }
    return Object.fromEntries(Object.keys(samples[0]!).map(key => [key, round(median(samples.map(value => value[key]!)), 3)]))
  } finally {
    offState(); offDetail(); statePublisher.dispose(); detailPublisher.dispose(); control.dispose(); workspace.disconnect(); await workspace.privacyChanged(); workspace.dispose()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-certified-detail-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
}

describe.skipIf(!PERF_BENCH)('certified details through the streaming workspace and window publishers (#991)', () => {
  it('reports main CPU per chunk and active time with 1, 3 and 6 viewed streams', async () => {
    // Steps 1/2 stay enabled in both cases; the paired control switch isolates step 3.
    for (const threads of [1, 3, 6]) for (const enabled of [false, true]) console.log(`certified streaming (${threads} threads, detail gate ${enabled}): ${JSON.stringify(await measure(threads, enabled))}`)
  }, 300_000)
})
