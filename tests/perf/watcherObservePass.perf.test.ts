// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/watcherObservePass.perf.test.ts --maxWorkers=1 --disable-console-intercept
/**
 * What Watcher's own observation pass and room state cost with a paired host whose threads have finished turns (#1023).
 * `watcherRoomRemote.perf.test.ts` times room reads over the same real socket cache, but its threads have no finished
 * turn and its record has no operations, so it never reaches the work a finished turn or a delegation adds. Here every
 * remote Claude thread has finished a turn, and the Watcher record holds six accepted starts on the paired host, as after
 * Watcher started work there.
 *
 * Two reads are timed, each in rounds of synchronous calls with nothing else on the event loop:
 * - `observe`: one pass of Watcher's wake-up observation (`WatcherWakeUp.observe`), which main runs on every publish
 *   while Watcher is on, including every streamed chunk on this computer.
 * - `state`: one room state read (`WatcherService.state`), which every room publication and Get builds.
 * - `prune`: one prune of queued Watcher wake-ups (`AgentControl.pruneWatcherWakeUps`), which main runs after every pass
 *   while news waits in the queue (#1070). It is awaited, so it includes the queue write and the publish after it.
 *
 * For each it reports wall time and process CPU per call, how often the paired host's whole cached shell was read
 * (`shell()`) and cloned, how often the remote host list was asked for, and how often the whole Watcher record was cloned.
 * The counts do not depend on how busy the machine is, so they are the comparison to trust on a noisy machine.
 *
 * Two switches take a part of the workload away, to see what each part costs: `SOTTO_PERF_NO_FINISHED=1` leaves the
 * paired host's threads without a finished turn, and `SOTTO_PERF_NO_OPS=1` leaves the record without the six starts.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance, PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { WatcherService } from '../../src/main/agents/watcher'
import { WatcherWakeUp } from '../../src/main/agents/watcherWakeUp'
import type { FollowupStore, QueuedFollowup, WordWakeUp } from '../../src/main/agents/followups'
import type { HiddenWakeUpOutcome } from '../../src/main/agents/hiddenWakeUp'
import { isWatcherNews, queuedWakeUpText } from '../../src/main/agents/wakeUp'
import { watcherRecordSchema } from '../../src/shared/watcher'
import type { WatcherEvent } from '../../src/shared/watcherNews'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { PERF_BENCH, median } from '../fixtures/perfBench'
import { stack } from '../fixtures/windowThreadShellPipeline'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const ROUNDS = 3
const ITERATIONS = { observe: 3, state: 10, prune: 30 } as const
/** Queued Watcher wake-ups the prune reads, one per thread, as a queue holds one waiting wake-up per thread. */
const WAKE_UPS = 8
const STARTS = 6
const PRUNE_PHASES = process.env.SOTTO_PERF_PRUNE_PHASES === '1'
const PHASES = ['due', 'settlement', 'persist', 'remove', 'returned', 'publish', 'broadcast', 'wakeObserve'] as const
type PrunePhase = typeof PHASES[number]
type Interval = { start: number; end: number }
type PruneWindow = Interval & { round: number; intervals: (Interval & { phase: PrunePhase })[] }
// Deepest work wins a segment. GC is an overlay on these wall intervals, so it is assigned first, never added twice.
const EXCLUSIVE_PHASES = ['gc', 'wakeObserve', 'returned', 'broadcast', 'publish', 'persist', 'remove', 'settlement', 'due', 'unattributed'] as const

/** Analyze bounded timing intervals after all measured work and GC-observer delivery have finished. */
function prunePhaseRows(windows: readonly PruneWindow[], gcs: readonly Interval[]) {
  const empty = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map(key => [key, 0])) as Record<K, number>
  const covered = (intervals: readonly Interval[]): number => {
    let end = -Infinity, duration = 0
    for (const interval of [...intervals].sort((left, right) => left.start - right.start)) {
      duration += Math.max(0, interval.end - Math.max(interval.start, end)); end = Math.max(end, interval.end)
    }
    return duration
  }
  return Array.from({ length: ROUNDS }, (_, round) => {
    const samples = windows.filter(window => window.round === round), inclusive = empty(PHASES), calls = empty(PHASES), exclusive = empty(EXCLUSIVE_PHASES)
    let wall = 0, gcEntries = 0
    expect(samples).toHaveLength(ITERATIONS.prune)
    for (const window of samples) {
      wall += window.end - window.start
      const clip = (interval: Interval): Interval => ({ start: Math.max(window.start, interval.start), end: Math.min(window.end, interval.end) })
      const overlaps = (interval: Interval) => interval.end > interval.start
      const phases = window.intervals.map(interval => ({ ...clip(interval), phase: interval.phase })).filter(overlaps)
      const gc = gcs.map(clip).filter(overlaps)
      gcEntries += gc.length
      for (const phase of PHASES) {
        inclusive[phase] += covered(phases.filter(interval => interval.phase === phase))
        calls[phase] += phases.filter(interval => interval.phase === phase).length
      }
      const boundaries = [...new Set([window.start, window.end, ...[...phases, ...gc].flatMap(interval => [interval.start, interval.end])])].sort((left, right) => left - right)
      for (let index = 1; index < boundaries.length; index++) {
        const start = boundaries[index - 1]!, end = boundaries[index]!, midpoint = (start + end) / 2
        const contains = (interval: Interval) => interval.start <= midpoint && interval.end >= midpoint
        const phase = gc.some(contains) ? 'gc' : EXCLUSIVE_PHASES.find(name => phases.some(interval => interval.phase === name && contains(interval))) ?? 'unattributed'
        exclusive[phase] += end - start
      }
    }
    // The partition is a single accounting of the outer prune wall time, including unwrapped work and awaited gaps.
    expect(Object.values(exclusive).reduce((total, value) => total + value, 0)).toBeCloseTo(wall, 6)
    const per = (value: number) => Math.round(value / samples.length * 1_000) / 1_000
    return { round: round + 1, iterations: samples.length, wallMsPerCall: per(wall), gcEntriesPerCall: per(gcEntries),
      inclusiveMsPerCall: Object.fromEntries(PHASES.map(phase => [phase, per(inclusive[phase])])),
      exclusiveMsPerCall: Object.fromEntries(EXCLUSIVE_PHASES.map(phase => [phase, per(exclusive[phase])])),
      callsPerCall: Object.fromEntries(PHASES.map(phase => [phase, per(calls[phase])])) }
  })
}

describe.skipIf(!PERF_BENCH)('Watcher observation pass and room state with a paired host (#1023)', () => {
  it('reports CPU, wall time, whole-shell clones and Watcher record clones per observation pass and per room state read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-watcher-observe-pass-'))
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-watcher-observe-pass-')) throw new Error('Unexpected owned fixture path')
    const cleanups: (() => Promise<unknown>)[] = []
    const nativeClone = globalThis.structuredClone
    let measuring = false
    const counts = { shellCalls: 0, shellClones: 0, hostLists: 0, recordClones: 0, schemaParses: 0, wakeObservations: 0 }
    const pruneWindows: PruneWindow[] = [], gcs: Interval[] = []
    let activePrune: PruneWindow | undefined
    const failures: unknown[] = []
    try {
      const nativeParseRecord = watcherRecordSchema.parse, parseRecord = nativeParseRecord.bind(watcherRecordSchema)
      watcherRecordSchema.parse = (data, params) => {
        if (measuring) counts.schemaParses++
        return parseRecord(data, params)
      }
      cleanups.push(async () => { watcherRecordSchema.parse = nativeParseRecord })
      const observeWake = WatcherWakeUp.prototype.observe
      WatcherWakeUp.prototype.observe = function (this: WatcherWakeUp) {
        if (measuring) counts.wakeObservations++
        const window = activePrune
        if (!window) return observeWake.call(this)
        const start = performance.now()
        try { return observeWake.call(this) } finally { window.intervals.push({ phase: 'wakeObserve', start, end: performance.now() }) }
      }
      cleanups.push(async () => { WatcherWakeUp.prototype.observe = observeWake })
      const remoteRoot = join(root, 'remote')
      for (const provider of ['claude', 'codex']) await mkdir(join(remoteRoot, provider), { recursive: true })
      const remote = await stack(remoteRoot, false, STARTS, true)
      cleanups.push(remote.stop)
      // Every Claude thread on the paired host has finished a turn, as threads with any history have.
      if (process.env.SOTTO_PERF_NO_FINISHED !== '1') for (const [index, thread] of remote.adapters.claude.state.threads.entries()) thread.lastTurn = { id: `generated-turn-${index}`, status: 'completed' }
      remote.adapters.claude.emit()
      const finishedOnHost = () => remote.control.shell().host.threads.filter(thread => thread.lastTurn?.status === 'completed').length
      for (let wait = 0; wait < 200 && process.env.SOTTO_PERF_NO_FINISHED !== '1' && finishedOnHost() < remote.adapters.claude.state.threads.length; wait++) await new Promise(done => setTimeout(done, 25))
      const pairing = new PairedClients(remoteRoot); await pairing.load()
      const server = await startSocketServer({ service: new LocalHostService({ control: remote.control, events: remote.workspace }), pairing })
      cleanups.push(() => server.close())
      const url = `http://127.0.0.1:${server.descriptor.port}`
      const paired = await SocketHostService.pair(url, pairing.issuePairingCode().code, 'Generated observe benchmark')
      const socket = new SocketHostService({ url, token: paired.token, watcherEnabled: true, ...{ streamingPublishCost: true } })
      cleanups.push(() => socket.close())
      await socket.connect()
      const cache = socket.shell()
      expect(cache.host.threads).toHaveLength(204)
      const finished = cache.host.threads.filter(thread => thread.lastTurn?.status === 'completed').length
      if (process.env.SOTTO_PERF_NO_FINISHED !== '1') expect(finished).toBeGreaterThan(150)
      const ids = Array.from({ length: STARTS }, (_, i) => remote.registry.bySession('claude', `stream-${i}`)!.threadId)
      const local = await workspaceFixture(undefined, { history: false, watcherEnabled: true })
      cleanups.push(local.remove, local.stop)
      const f = await agentControlFixture({ directory: local.root, host: local.host,
        credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => false, watcherEnabled: true, streamingPublishCost: true } })
      cleanups.push(() => f.dispose())
      await f.control.start()
      const at = '2026-10-15T00:00:00.000Z', requestId = randomUUID()
      const digest = (n: number) => n.toString(16).padStart(64, '0')
      await f.control.updateWatcher(record => {
        record.current = { target: { hostId: f.control.hostId()!, threadId: 'generated-master' },
          projectId: 'generated-project', provider: 'claude', creationOperationId: randomUUID(), createdAt: at }
        record.requests.push({ id: requestId, watcher: record.current.target, rootUserMessageId: 'generated-prompt',
          state: 'active', createdAt: at, closedAt: null, participants: ids.map(threadId => ({ target: { hostId: paired.hostId, threadId },
            requestId, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, promptCount: 1 })) })
        // Watcher's accepted starts on the paired host, one per thread it started there.
        if (process.env.SOTTO_PERF_NO_OPS !== '1') record.operations.push(...ids.map((threadId, index) => ({ id: randomUUID(), requestId, retryKey: randomUUID(), digest: digest(index + 1),
          action: 'start' as const, target: { hostId: paired.hostId, threadId }, generation: 0, deliveryState: 'accepted' as const,
          createdAt: at, updatedAt: at, receiptId: `generated-receipt-${index}`, cardId: `generated-card-${index}`, messageId: `generated-message-${index}` })))
      })
      const watcher = new WatcherService({ directory: local.root, control: f.control, host: local.host,
        historyEnabled: () => false, ...{ streamingPublishCost: true } })
      cleanups.push(async () => { watcher.close() })
      const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true, ...{ streamingPublishCost: true } })
      cleanups.push(async () => { router.dispose() })
      router.add({ hostId: paired.hostId, name: 'Generated remote', kind: 'remote', service: socket,
        detail: id => socket.readThreadDetail(id), preview: () => null })
      const remoteHosts = router.watcherHosts(), listHosts = remoteHosts.hosts.bind(remoteHosts)
      remoteHosts.hosts = () => { if (measuring) counts.hostLists++; return listHosts() }
      watcher.useRemoteHosts(remoteHosts)
      const wakes = (watcher as unknown as { wakes: { start(): void; observe(): void } }).wakes
      wakes.start()
      // Let the first remote reconciliation settle before anything is timed.
      await new Promise(done => setTimeout(done, 500))
      const readShell = socket.shell.bind(socket)
      socket.shell = () => { if (measuring) counts.shellCalls++; return readShell() }
      globalThis.structuredClone = function <Value>(value: Value, options?: unknown): Value {
        if (measuring && value !== null && typeof value === 'object') {
          if ('host' in value && 'configuration' in value) counts.shellClones++
          else if ('version' in value && 'requests' in value && 'operations' in value) counts.recordClones++
        }
        return Reflect.apply(nativeClone, globalThis, [value, options]) as Value
      }
      /** One round's figures per call: its time and the reads counted while it was measured. */
      const row = (iterations: number, wallMs: number, cpuMs: number): Record<string, number> => {
        const per = (value: number) => Math.round(value / iterations * 100) / 100
        return { wallMsPerCall: per(wallMs), cpuMsPerCall: per(cpuMs), shellCallsPerCall: per(counts.shellCalls), shellClonesPerCall: per(counts.shellClones),
          hostListsPerCall: per(counts.hostLists), recordClonesPerCall: per(counts.recordClones),
          schemaParsesPerCall: per(counts.schemaParses), wakeObservationsPerCall: per(counts.wakeObservations) }
      }
      const medians = (rows: Record<string, number>[]) => Object.fromEntries(Object.keys(rows[0]!).map(key => [key, median(rows.map(item => item[key]!))]))
      const accepted = () => watcher.state().receipts.filter(item => item.action === 'start' && item.deliveryState === 'accepted').length
      const startsBefore = accepted()
      const results: Record<string, unknown> = {}
      for (const method of ['observe', 'state'] as const) {
        const rows: Record<string, number>[] = []
        for (let round = 0; round < ROUNDS; round++) {
          for (const name of Object.keys(counts) as (keyof typeof counts)[]) counts[name] = 0
          measuring = true
          const cpu = process.cpuUsage(), started = performance.now()
          try {
            for (let index = 0; index < ITERATIONS[method]; index++) {
              if (method === 'observe') wakes.observe()
              else expect(watcher.state().watchedThreads).toHaveLength(STARTS)
            }
          } finally { measuring = false }
          const used = process.cpuUsage(cpu)
          rows.push(row(ITERATIONS[method], performance.now() - started, (used.user + used.system) / 1000))
        }
        results[method] = { iterations: ITERATIONS[method], rounds: ROUNDS, rows, medians: medians(rows) }
      }
      // Queued wake-ups (#1070): news waits in a busy Watcher thread's queue, and main prunes the queue after every pass.
      // Each wake-up holds all the news still due and one outdated event. Hidden wake-ups are immutable, so each
      // prune withdraws the whole wake-up; the news still due waits for a fresh one (ADR-0073).
      const due = (wakes as unknown as { news(): WatcherEvent[] }).news(), outdated: WatcherEvent = { ...due[0]!, id: 'generated-outdated', requestId: randomUUID() }
      expect(due.length).toBeGreaterThan(0)
      const store = (f.control as unknown as { followupStore: FollowupStore }).followupStore
      const word: WordWakeUp = news => queuedWakeUpText(news, { tool: false })
      const queue = async () => {
        for (let index = 0; index < WAKE_UPS; index++) await store.queueWakeUp(`generated-watcher-${index}`,
          { source: 'watcher', watcher: { hostId: f.control.hostId()!, threadId: `generated-watcher-${index}` }, events: [...due, outdated], omitted: 0 }, word)
        const queued = store.peek().items.filter(item => item.wakeUp)
        expect(queued).toHaveLength(WAKE_UPS)
        for (const item of queued) {
          const news = item.news?.filter(isWatcherNews)
          expect(news).toHaveLength(1)
          expect(news![0]!.events.map(event => event.id)).toEqual([...due, outdated].map(event => event.id))
        }
      }
      let gcObserver: PerformanceObserver | undefined
      if (PRUNE_PHASES) {
        const timedSync = <Args extends unknown[], Result>(phase: PrunePhase, method: (...args: Args) => Result) => (...args: Args): Result => {
          const window = activePrune
          if (!window) return method(...args)
          const start = performance.now()
          try { return method(...args) } finally { window.intervals.push({ phase, start, end: performance.now() }) }
        }
        const timedAsync = <Args extends unknown[]>(phase: PrunePhase, method: (...args: Args) => Promise<void>) => async (...args: Args): Promise<void> => {
          const window = activePrune
          if (!window) return method(...args)
          const start = performance.now()
          try { await method(...args) } finally { window.intervals.push({ phase, start, end: performance.now() }) }
        }
        type Queued = Pick<QueuedFollowup, 'id' | 'news'>
        const phasesControl = f.control as unknown as {
          watcherDue(items: readonly Pick<QueuedFollowup, 'news'>[]): (event: WatcherEvent) => boolean
          wakeUpOutdated(threadId: string, item: Pick<QueuedFollowup, 'wakeUp' | 'news'>, due?: (event: WatcherEvent) => boolean): boolean
          settleWatcherWakeUp(items: Queued | readonly Queued[], outcome: HiddenWakeUpOutcome): Promise<void>
          persist(closing?: boolean): Promise<void>
          publish(): void
          broadcast(): void
        }
        const original = { due: phasesControl.watcherDue, outdated: phasesControl.wakeUpOutdated, settle: phasesControl.settleWatcherWakeUp,
          persist: phasesControl.persist, publish: phasesControl.publish, broadcast: phasesControl.broadcast, remove: store.removeWakeUp }
        phasesControl.watcherDue = timedSync('due', original.due.bind(phasesControl))
        phasesControl.wakeUpOutdated = timedSync('due', original.outdated.bind(phasesControl))
        // Time the complete awaited settlement, including its join lane, durable save, queue removal and returned news.
        phasesControl.settleWatcherWakeUp = timedAsync('settlement', original.settle.bind(phasesControl))
        phasesControl.persist = timedAsync('persist', original.persist.bind(phasesControl))
        store.removeWakeUp = timedAsync('remove', original.remove.bind(store))
        phasesControl.publish = timedSync('publish', original.publish.bind(phasesControl))
        phasesControl.broadcast = timedSync('broadcast', original.broadcast.bind(phasesControl))
        const phasesWakes = wakes as unknown as { returned(events: readonly WatcherEvent[]): void }
        const returned = phasesWakes.returned
        phasesWakes.returned = timedSync('returned', returned.bind(phasesWakes))
        cleanups.push(async () => {
          phasesControl.watcherDue = original.due; phasesControl.wakeUpOutdated = original.outdated
          phasesControl.settleWatcherWakeUp = original.settle; phasesControl.persist = original.persist
          phasesControl.publish = original.publish; phasesControl.broadcast = original.broadcast
          store.removeWakeUp = original.remove; phasesWakes.returned = returned
        })
        const capture = (entries: readonly PerformanceEntry[]) => {
          for (const entry of entries) if (entry.entryType === 'gc') gcs.push({ start: entry.startTime, end: entry.startTime + entry.duration })
        }
        expect(PerformanceObserver.supportedEntryTypes).toContain('gc')
        gcObserver = new PerformanceObserver(list => capture(list.getEntries()))
        gcObserver.observe({ entryTypes: ['gc'] })
        cleanups.push(async () => { gcObserver!.disconnect() })
      }
      // Warm the same complete queue/prune workload once before the measured rounds.
      await queue()
      await f.control.pruneWatcherWakeUps()
      expect(store.peek().items.filter(item => item.wakeUp)).toEqual([])
      const rows: Record<string, number>[] = []
      for (let round = 0; round < ROUNDS; round++) {
        for (const name of Object.keys(counts) as (keyof typeof counts)[]) counts[name] = 0
        let wallMs = 0, cpuMs = 0
        for (let index = 0; index < ITERATIONS.prune; index++) {
          await queue()
          expect(store.peek().items.filter(item => item.wakeUp)).toHaveLength(WAKE_UPS)
          const window: PruneWindow | undefined = PRUNE_PHASES ? { round, start: 0, end: 0, intervals: [] } : undefined
          measuring = true
          const cpu = process.cpuUsage(), started = performance.now()
          if (window) { window.start = started; activePrune = window }
          try { await f.control.pruneWatcherWakeUps() } finally { measuring = false; activePrune = undefined }
          const used = process.cpuUsage(cpu)
          const finished = performance.now()
          wallMs += finished - started; cpuMs += (used.user + used.system) / 1000
          if (window) { window.end = finished; pruneWindows.push(window) }
          expect(store.peek().items.filter(item => item.wakeUp)).toEqual([])
        }
        rows.push(row(ITERATIONS.prune, wallMs, cpuMs))
      }
      const queued = store.peek().items.filter(item => item.wakeUp)
      expect(queued).toEqual([])
      const prune = { iterations: ITERATIONS.prune, rounds: ROUNDS, warmups: 1, wakeUps: WAKE_UPS, eventsPerWakeUp: due.length + 1, rows, medians: medians(rows) }
      results.prune = prune
      if (gcObserver) {
        // Native GC entries arrive asynchronously. Flush only after every measured round, with no sleep in a prune.
        await new Promise<void>(done => setImmediate(done))
        await new Promise<void>(done => setImmediate(done))
        for (const entry of gcObserver.takeRecords()) if (entry.entryType === 'gc') gcs.push({ start: entry.startTime, end: entry.startTime + entry.duration })
        gcObserver.disconnect()
        Object.assign(prune, { phases: {
          clock: 'perf_hooks performance.now and GC entry startTime',
          inclusive: 'Awaited wall intervals. Settlement includes persist, remove and returned; broadcast and wakeObserve may nest in publish. These columns overlap and are never summed.',
          exclusive: 'Each outer-prune wall segment belongs to its first matching phase in exclusivePriority. GC is clipped to measured windows and assigned once. Unattributed includes work and awaited gaps outside wrapped phases.',
          gc: 'Native GC-event wall intervals, not a CPU or stop-the-world pause claim. Warmup, queue construction and observer flush are outside measured prune windows.',
          exclusivePriority: EXCLUSIVE_PHASES, rows: prunePhaseRows(pruneWindows, gcs),
        } })
      }
      console.log(`Watcher observe pass: ${JSON.stringify({ shape: { remoteThreads: cache.host.threads.length, remoteFinished: finished,
        remoteAcceptedStarts: startsBefore, remoteAcceptedStartsAfter: accepted() }, ...results })}`)
    } catch (error) { failures.push(error) }
    finally {
      globalThis.structuredClone = nativeClone
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup() } catch (error) { failures.push(error) }
      }
      try { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) }
      catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Watcher observe benchmark or cleanup failed')
  }, 600_000)
})
