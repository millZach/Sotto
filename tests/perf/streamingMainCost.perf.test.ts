// @vitest-environment node
/**
 * What main spends while one thread streams beside a large archive (#917). The chain is the app's own: two
 * event-sourced adapters built like Claude's and Codex's (their message log, snapshot publisher and certified
 * activity view), `SottoThreadHost`, the provider switch, the workspace host, the coordinator, the local host
 * service and the desktop host router, and the window's state and detail publishers wired as `src/main/index.ts`
 * wires them. Every payload is generated here; no user profile is opened.
 *
 * The archive is shaped like the development machine's: threads whose adapter publishes its activity (Claude
 * keeps every saved thread's records), a few whose adapter has not read them this run and publishes none
 * (Codex before a thread is opened), many with no activity, and the 608-model catalog. A first run stores the
 * activity through the workspace; the measured run reopens the folder and streams one Claude thread.
 *
 * It reports main's event-loop utilisation and CPU per streamed chunk, garbage collection time, how far the heap grew
 * during a round and where it ended, and how often the coordinator's and the router's shells were built for each state
 * the window received.
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/streamingMainCost.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * `SOTTO_PERF_PROFILE=<file.cpuprofile>` also writes a CPU profile of the first measured round.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Session } from 'node:inspector/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance, PerformanceObserver } from 'node:perf_hooks'
import { afterAll, describe, expect, it } from 'vitest'
import * as activitySnapshots from '../../src/main/agents/activitySnapshots'
import { ActivitySubscribers, immutableActivities, isImmutableActivities } from '../../src/main/agents/activitySnapshots'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { AgentControl, coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../../src/main/agents/control'
import type { ActivitySubscriptionOptions, ThreadHostEvent } from '../../src/main/agents/host'
import { LocalHostService } from '../../src/main/agents/hostService'
import { ConfiguredProviderHost } from '../../src/main/agents/providerSwitch'
import { adapterItemCount, ProviderSnapshotPublisher } from '../../src/main/agents/providerSnapshotPublisher'
import { ThreadMessageLog } from '../../src/main/agents/threadMessageLog'
import { SottoThreadHost, ThreadRegistry } from '../../src/main/agents/threads'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import { e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../src/shared/agents'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { syntheticModelCatalog } from '../fixtures/modelCatalog'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { testCredentials } from '../fixtures/testCredentials'

const PUBLISHED_ARCHIVE = { threads: 50, records: 400, outputBytes: 1_000 }
const UNREAD_ARCHIVE = { threads: 4, records: 1_100, outputBytes: 2_600 }
const EMPTY_THREADS = 140
const CHUNKS = 300
const CHUNK_GAP_MS = 2
const ROUNDS = 5

/** An event-sourced adapter that records through the adapters' log and publishes their certified activity view. */
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
    // As the adapters do. A revision from before #917 certified activity only.
    if ('certifyActivityView' in activitySnapshots) (activitySnapshots as { certifyActivityView: (state: AgentHostSnapshot, threads: AgentThread[]) => void }).certifyActivityView(this.state, this.state.threads)
    else for (const thread of this.state.threads) if (thread.activities && !isImmutableActivities(thread.activities)) thread.activities = immutableActivities(thread.activities)
    return { ...this.state, threads: this.state.threads.map(thread => this.log.activityThread(thread, historyFromEvents)) }
  }
}

function records(prefix: string, count: number, outputBytes: number): AgentActivity[] {
  return Array.from({ length: count }, (_, position): AgentActivity => ({
    id: `${prefix}-a${position}`, turnId: `${prefix}-t${Math.floor(position / 4)}`, sequence: position, kind: 'command', status: 'completed',
    title: `Synthetic command ${position}`, output: `${prefix}:${position}:`.padEnd(outputBytes, 'o'),
  }))
}

function thread(sessionId: string, title: string, activities?: AgentActivity[]): AgentThread {
  return { id: sessionId, projectId: 'project', title, modelId: 'fake:model', status: 'idle', messages: [], requests: [], ...(activities ? { activities } : {}) }
}

/** `withActivity` is false for the measured run, where the unread archive's adapter has not read its records yet. */
function adapterStates(root: string, withActivity: boolean): { claude: AgentHostSnapshot; codex: AgentHostSnapshot } {
  const base = (provider: string): AgentHostSnapshot => ({
    ...structuredClone(EMPTY_AGENT_HOST), name: provider, version: '1', connected: true,
    capabilities: { ...structuredClone(EMPTY_AGENT_HOST.capabilities), projects: true, threads: true, submit: true, observe: true },
    projects: [{ id: 'project', title: 'Synthetic project', path: join(root, provider) }],
    models: [{ id: 'fake:model', provider: 'Fake', name: 'Synthetic model', ready: true }], threads: [],
  })
  const claude = base('claude'), codex = base('codex')
  claude.models = [...claude.models, ...syntheticModelCatalog()]
  claude.threads.push(thread('stream', 'Streaming thread'))
  for (let index = 0; index < PUBLISHED_ARCHIVE.threads; index++) {
    claude.threads.push(thread(`published-${index}`, `Published ${index}`, records(`published-${index}`, PUBLISHED_ARCHIVE.records, PUBLISHED_ARCHIVE.outputBytes)))
  }
  for (let index = 0; index < EMPTY_THREADS; index++) claude.threads.push(thread(`empty-${index}`, `Empty ${index}`))
  for (let index = 0; index < UNREAD_ARCHIVE.threads; index++) {
    codex.threads.push(thread(`unread-${index}`, `Unread ${index}`, withActivity ? records(`unread-${index}`, UNREAD_ARCHIVE.records, UNREAD_ARCHIVE.outputBytes) : undefined))
  }
  return { claude, codex }
}

async function stack(root: string, withActivity: boolean) {
  const registry = new ThreadRegistry(root)
  await registry.load()
  const states = adapterStates(root, withActivity)
  const adapters = { claude: new StreamingAdapter(states.claude), codex: new StreamingAdapter(states.codex) }
  const native = new ConfiguredProviderHost({ directory: root, provider: () => 'claude', enabledProviders: () => ['claude', 'codex'],
    threadProvider: id => registry.byThread(id)?.provider,
    hosts: { claude: new SottoThreadHost('claude', adapters.claude, registry), codex: new SottoThreadHost('codex', adapters.codex, registry),
      grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost() } })
  const workspace = new WorkspaceHost(native, root, () => true)
  await workspace.initialize()
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = new AgentControl({ directory: root, host: workspace, credentials, reasoner: e2eAgentReasoner })
  await control.start()
  await control.command({ type: 'connect' })
  const stop = async () => { control.dispose(); workspace.disconnect(); await workspace.privacyChanged(); await registry.flush(); workspace.dispose() }
  return { registry, adapters, workspace, control, stop }
}

const sleep = (ms: number) => new Promise<void>(done => { setTimeout(done, ms) })
const roots: string[] = []
afterAll(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-streaming-cost-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})

describe.skipIf(!PERF_BENCH)('main while one thread streams beside a large archive (timing benchmark; requires SOTTO_PERF_BENCH=1)', () => {
  it('reports event-loop use, CPU, collection time and shells built per state the window received', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-streaming-cost-')); roots.push(root)
    for (const provider of ['claude', 'codex']) await mkdir(join(root, provider), { recursive: true })
    // The first run stores every archive's activity through the workspace, as earlier sessions did.
    const seeding = await stack(root, true)
    for (const adapter of Object.values(seeding.adapters)) adapter.publish(false)
    await sleep(600)
    await seeding.stop()

    const { registry, adapters, workspace, control, stop } = await stack(root, false)
    const streamId = registry.bySession('claude', 'stream')!.threadId
    const hostService = new LocalHostService({ control, events: workspace })
    const router = new DesktopHostRouter(() => emptyDesktopState(control.hostId()))
    router.add({ hostId: control.hostId()!, name: 'This computer', kind: 'local', service: hostService,
      detail: id => control.threadDetail(id), preview: request => control.attachmentPreview(request),
      subscribeDetail: listener => control.subscribeThreadDetail(listener) })
    const broadcaster = new AgentStateBroadcaster()
    const counts = { stateSends: 0, detailSends: 0, controlShells: 0, routerShells: 0 }
    const statePublisher = coalesceAgentStatePublishes(state => { broadcaster.send(state, () => { counts.stateSends += 1; return true }) })
    const detailPublisher = coalesceAgentThreadDetailPublishes(() => { counts.detailSends += 1 }, { beforeOpening: () => statePublisher.flush() })
    const offState = router.subscribe(state => statePublisher.publish(state))
    const offDetail = router.subscribeThreadDetail(detail => detailPublisher.publish(detail))
    const controlShell = control.shell.bind(control), routerShell = router.shell.bind(router)
    control.shell = () => { counts.controlShells += 1; return controlShell() }
    router.shell = () => { counts.routerShells += 1; return routerShell() }
    await control.command({ type: 'observe-threads', threadIds: [streamId] })
    control.threadDetail(streamId)
    const gcs: { kind: number; duration: number }[] = []
    const gcObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) gcs.push({ kind: (entry as unknown as { detail?: { kind?: number } }).detail?.kind ?? 0, duration: entry.duration }) })
    gcObserver.observe({ entryTypes: ['gc'] })

    const unread = workspace.workspaceSnapshot().threads.filter(item => registry.byThread(item.id)?.sessionId.startsWith('unread-'))
    const rounds: Record<string, number>[] = []
    const adapter = adapters.claude
    const streaming = adapter.state.threads.find(item => item.id === 'stream')!
    for (let round = 0; round < ROUNDS; round++) {
      await sleep(400)
      const at = new Date().toISOString()
      adapter.log.add('stream', { id: `prompt-${round}`, role: 'user', text: `Prompt ${round}`, createdAt: at })
      streaming.status = 'running'
      adapter.publish(false)
      const reply = `reply-${round}`
      adapter.log.add('stream', { id: reply, role: 'assistant', text: 'First', createdAt: at })
      adapter.publish(true)
      await sleep(200)
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0
      gcs.length = 0
      const profile = round === 0 && process.env.SOTTO_PERF_PROFILE ? new Session() : undefined
      if (profile) { profile.connect(); await profile.post('Profiler.enable'); await profile.post('Profiler.setSamplingInterval', { interval: 200 }); await profile.post('Profiler.start') }
      const heapAtStart = process.memoryUsage().heapUsed
      let heapPeak = heapAtStart
      const elu = performance.eventLoopUtilization(), cpu = process.cpuUsage(), started = performance.now()
      for (let chunk = 0; chunk < CHUNKS; chunk++) {
        adapter.log.appendText('stream', reply, ` word${chunk}`)
        // A command every 25 chunks, as a reply that runs tools has.
        if (chunk % 25 === 0) streaming.activities = [...(streaming.activities ?? []), ...records(`stream-${round}-${chunk}`, 1, 400)]
        adapter.publish(true)
        heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed)
        await sleep(CHUNK_GAP_MS)
      }
      await sleep(150)
      const wall = performance.now() - started
      const used = performance.eventLoopUtilization(elu)
      const cpuUsed = process.cpuUsage(cpu)
      if (profile) { const { profile: taken } = await profile.post('Profiler.stop'); await writeFile(process.env.SOTTO_PERF_PROFILE!, JSON.stringify(taken)); profile.disconnect() }
      rounds.push({ wallMs: wall, eventLoopUtilisation: used.utilization, activeMsPerChunk: used.active / CHUNKS,
        cpuMsPerChunk: (cpuUsed.user + cpuUsed.system) / 1000 / CHUNKS, gcMs: gcs.reduce((total, gc) => total + gc.duration, 0),
        majorGcs: gcs.filter(gc => gc.kind === 4).length, heapGrowthMb: (heapPeak - heapAtStart) / 1048576,
        heapAtEndMb: process.memoryUsage().heapUsed / 1048576, ...counts })
      streaming.status = 'idle'
      adapter.publish(false)
    }
    gcObserver.disconnect()
    const summary = Object.fromEntries(Object.keys(rounds[0]!).map(key => [key, round(median(rounds.map(item => item[key]!)), key === 'eventLoopUtilisation' ? 3 : 2)]))
    console.log(`streaming main cost (${CHUNKS} chunks, ${ROUNDS} rounds, medians): ${JSON.stringify({ ...summary,
      routerShellsPerStateSend: round(median(rounds.map(item => item.routerShells! / Math.max(1, item.stateSends!))), 2),
      controlShellsPerStateSend: round(median(rounds.map(item => item.controlShells! / Math.max(1, item.stateSends!))), 2),
      unreadArchiveThreads: unread.length, unreadRecordsHeld: unread.reduce((total, item) => total + (item.activities?.length ?? 0), 0) })}`)
    expect(rounds).toHaveLength(ROUNDS)
    offState(); offDetail(); statePublisher.dispose(); detailPublisher.dispose(); router.dispose()
    await stop()
  }, 300_000)
})
