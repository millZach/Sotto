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
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/windowThreadShellMain.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * `SOTTO_PERF_PROFILE=<file.cpuprofile>` also writes a CPU profile of the first measured round.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Session } from 'node:inspector/promises'
import { serialize } from 'node:v8'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance, PerformanceObserver } from 'node:perf_hooks'
import { afterAll, describe, expect, it } from 'vitest'
import { records, stack } from '../fixtures/windowThreadShellPipeline'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../../src/main/agents/control'
import { LocalHostService } from '../../src/main/agents/hostService'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

const CHUNKS = 180
const CHUNK_GAP_MS = 2
const ROUNDS = 3


const sleep = (ms: number) => new Promise<void>(done => { setTimeout(done, ms) })
const roots: string[] = []
afterAll(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-window-streaming-cost-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
})

describe.skipIf(!PERF_BENCH)('desktop window main pipeline (#991)', () => {
  it.each(process.env.SOTTO_STEP4_CAPTURE_ONLY ? [[1, false] as const] : [1,3,6].flatMap(count=>[false,true,true,false].map(enabled=>[count,enabled] as const)))('reports main cost with %i streaming threads and desktop optimization %s', async (streamCount, enabled) => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-window-streaming-cost-')); roots.push(root)
    for (const provider of ['claude', 'codex']) await mkdir(join(root, provider), { recursive: true })
    // The first run stores every archive's activity through the workspace, as earlier sessions did.
    const seeding = await stack(root, true, streamCount)
    for (const adapter of Object.values(seeding.adapters)) adapter.publish(false)
    await sleep(600)
    await seeding.stop()

    const { registry, adapters, workspace, control, stop } = await stack(root, false, streamCount)
    const streamIds = Array.from({length:streamCount},(_,i)=>registry.bySession('claude', `stream-${i}`)!.threadId)
    const hostService = new LocalHostService({ control, events: workspace })
    const router = new DesktopHostRouter(() => emptyDesktopState(control.hostId()))
    router.add({ hostId: control.hostId()!, name: 'This computer', kind: 'local', service: hostService,
      detail: id => control.threadDetail(id), preview: request => control.attachmentPreview(request),
      subscribeDetail: listener => control.subscribeThreadDetail(listener) })
    const broadcaster = new AgentStateBroadcaster({streamingPublishCost:enabled})
    const counts = { stateSends: 0, detailSends: 0, controlShells: 0, routerShells: 0, wireBytes: 0, senderCpuUs: 0 }
    const statePublisher = coalesceAgentStatePublishes(state => {
      const cpu = process.cpuUsage()
      broadcaster.send(state, payload => { const wire=serialize(payload); counts.wireBytes+=wire.length; counts.stateSends += 1; return true })
      const used = process.cpuUsage(cpu)
      counts.senderCpuUs += used.user + used.system
    })
    const detailPublisher = coalesceAgentThreadDetailPublishes(() => { counts.detailSends += 1 }, { beforeOpening: () => statePublisher.flush() })
    const offState = router.subscribe(state => statePublisher.publish(state))
    const offDetail = router.subscribeThreadDetail(detail => detailPublisher.publish(detail))
    const controlShell = control.shell.bind(control), routerShell = router.shell.bind(router)
    control.shell = () => { counts.controlShells += 1; return controlShell() }
    router.shell = () => { counts.routerShells += 1; return routerShell() }
    try {
    await control.command({ type: 'observe-threads', threadIds: streamIds })
    for(const id of streamIds) control.threadDetail(id)
    expect(router.shell().host.threads).toHaveLength(204)
    expect(router.shell().host.projects).toHaveLength(43)
    const fixture = router.shell()
    console.log(`desktop streaming fixture (${streamCount}, ${enabled}): ${JSON.stringify({
      threads: fixture.host.threads.length, projects: fixture.host.projects.length, models: fixture.host.models.length,
      threadsJsonBytes: Buffer.byteLength(JSON.stringify(fixture.host.threads)),
      worktreeJsonBytes: Buffer.byteLength(JSON.stringify(fixture.host.threads.map(thread => thread.worktree))),
      usageJsonBytes: Buffer.byteLength(JSON.stringify(fixture.host.threads.map(thread => thread.usage))),
    })}`)
    if (process.env.SOTTO_STEP4_CAPTURE_ONLY) {
      await writeFile(process.env.SOTTO_STEP4_CAPTURE_ONLY, JSON.stringify(fixture))
      return
    }
    const gcs: { kind: number; duration: number }[] = []
    const gcObserver = new PerformanceObserver(list => { for (const entry of list.getEntries()) gcs.push({ kind: (entry as unknown as { detail?: { kind?: number } }).detail?.kind ?? 0, duration: entry.duration }) })
    gcObserver.observe({ entryTypes: ['gc'] })

    const unread = workspace.workspaceSnapshot().threads.filter(item => registry.byThread(item.id)?.sessionId.startsWith('unread-'))
    const rounds: Record<string, number>[] = []
    const adapter = adapters.claude
    const streaming = adapter.state.threads.filter(item => item.id.startsWith('stream-'))
    for (let round = 0; round < ROUNDS; round++) {
      await sleep(400)
      const at = new Date().toISOString()
      for(const item of streaming) {adapter.log.add(item.id, { id: `prompt-${round}`, role: 'user', text: `Prompt ${round}`, createdAt: at });item.status = 'running'}
      adapter.publish(false)
      const reply = `reply-${round}`
      for(const item of streaming) adapter.log.add(item.id, { id: reply, role: 'assistant', text: 'First', createdAt: at })
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
        for(const item of streaming) adapter.log.appendText(item.id, reply, ` word${chunk}`)
        // A command every 25 chunks, as a reply that runs tools has.
        if (chunk % 25 === 0) for(const item of streaming) item.activities = [...(item.activities ?? []), ...records(`${item.id}-${round}-${chunk}`, 1, 400)]
        adapter.publish(true)
        heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed)
        await sleep(CHUNK_GAP_MS)
      }
      await sleep(150)
      const wall = performance.now() - started
      const used = performance.eventLoopUtilization(elu)
      const cpuUsed = process.cpuUsage(cpu)
      if (profile) { const { profile: taken } = await profile.post('Profiler.stop'); await writeFile(process.env.SOTTO_PERF_PROFILE!, JSON.stringify(taken)); profile.disconnect() }
      rounds.push({ wallMs: wall, eventLoopUtilisation: used.utilization, activeMsPerChunk: used.active / (CHUNKS*streamCount),
        cpuMsPerChunk: (cpuUsed.user + cpuUsed.system) / 1000 / (CHUNKS*streamCount), gcMs: gcs.reduce((total, gc) => total + gc.duration, 0),
        majorGcs: gcs.filter(gc => gc.kind === 4).length, heapGrowthMb: (heapPeak - heapAtStart) / 1048576,
        heapAtEndMb: process.memoryUsage().heapUsed / 1048576,
        cpuMsPerPublishWindow: (cpuUsed.user + cpuUsed.system) / 1000 / Math.max(1, counts.stateSends),
        senderCpuMsPerPublishWindow: counts.senderCpuUs / 1000 / Math.max(1, counts.stateSends),
        streamedChunks: CHUNKS * streamCount, stateSendsPerSecond: counts.stateSends / wall * 1000, ...counts })
      for(const item of streaming) item.status = 'idle'
      adapter.publish(false)
    }
    gcObserver.disconnect()
    const summary = Object.fromEntries(Object.keys(rounds[0]!).map(key => [key, round(median(rounds.map(item => item[key]!)), key === 'eventLoopUtilisation' ? 3 : 2)]))
    console.log(`desktop streaming main cost (${streamCount} threads, flag ${enabled}, ${CHUNKS} chunks each, ${ROUNDS} rounds, medians): ${JSON.stringify({ ...summary,
      routerShellsPerStateSend: round(median(rounds.map(item => item.routerShells! / Math.max(1, item.stateSends!))), 2),
      controlShellsPerStateSend: round(median(rounds.map(item => item.controlShells! / Math.max(1, item.stateSends!))), 2),
      unreadArchiveThreads: unread.length, unreadRecordsHeld: unread.reduce((total, item) => total + (item.activities?.length ?? 0), 0) })}`)
    expect(rounds).toHaveLength(ROUNDS)
    } finally {
      offState(); offDetail(); statePublisher.dispose(); detailPublisher.dispose(); router.dispose()
      await stop()
    }
  }, 300_000)
})
