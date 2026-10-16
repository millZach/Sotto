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
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { WatcherService } from '../../src/main/agents/watcher'
import type { FollowupStore, WordWakeUp } from '../../src/main/agents/followups'
import { isWatcherNews, queuedWakeUpText } from '../../src/main/agents/wakeUp'
import type { WatcherEvent } from '../../src/shared/watcherNews'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { PERF_BENCH, median } from '../fixtures/perfBench'
import { stack } from '../fixtures/windowThreadShellPipeline'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const ROUNDS = 3
const ITERATIONS = { observe: 3, state: 10, prune: 3 } as const
/** Queued Watcher wake-ups the prune reads, one per thread, as a queue holds one waiting wake-up per thread. */
const WAKE_UPS = 8
const STARTS = 6

describe.skipIf(!PERF_BENCH)('Watcher observation pass and room state with a paired host (#1023)', () => {
  it('reports CPU, wall time, whole-shell clones and Watcher record clones per observation pass and per room state read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-watcher-observe-pass-'))
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-watcher-observe-pass-')) throw new Error('Unexpected owned fixture path')
    const cleanups: (() => Promise<unknown>)[] = []
    const nativeClone = globalThis.structuredClone
    let measuring = false
    const counts = { shellCalls: 0, shellClones: 0, hostLists: 0, recordClones: 0 }
    const failures: unknown[] = []
    try {
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
        historyEnabled: () => false, limit: () => 8, ...{ streamingPublishCost: true } })
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
          hostListsPerCall: per(counts.hostLists), recordClonesPerCall: per(counts.recordClones) }
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
      // Each wake-up holds all the news still due and one event for a request Watcher does not have, which each prune drops.
      const due = (wakes as unknown as { news(): WatcherEvent[] }).news(), outdated: WatcherEvent = { ...due[0]!, id: 'generated-outdated', requestId: randomUUID() }
      const store = (f.control as unknown as { followupStore: FollowupStore }).followupStore
      const word: WordWakeUp = news => queuedWakeUpText(news, { tool: false })
      const queue = async () => {
        for (let index = 0; index < WAKE_UPS; index++) await store.queueWakeUp(`generated-watcher-${index}`,
          { source: 'watcher', watcher: { hostId: f.control.hostId()!, threadId: `generated-watcher-${index}` }, events: [...due, outdated], omitted: 0 }, word)
      }
      const rows: Record<string, number>[] = []
      for (let round = 0; round < ROUNDS; round++) {
        for (const name of Object.keys(counts) as (keyof typeof counts)[]) counts[name] = 0
        let wallMs = 0, cpuMs = 0
        for (let index = 0; index < ITERATIONS.prune; index++) {
          await queue()
          measuring = true
          const cpu = process.cpuUsage(), started = performance.now()
          try { await f.control.pruneWatcherWakeUps() } finally { measuring = false }
          const used = process.cpuUsage(cpu)
          wallMs += performance.now() - started; cpuMs += (used.user + used.system) / 1000
        }
        rows.push(row(ITERATIONS.prune, wallMs, cpuMs))
      }
      const queued = store.peek().items.filter(item => item.wakeUp)
      expect(queued).toHaveLength(WAKE_UPS)
      for (const item of queued) expect(item.news?.flatMap(news => isWatcherNews(news) ? news.events.map(event => event.id) : [])).toEqual(due.map(event => event.id))
      results.prune = { iterations: ITERATIONS.prune, rounds: ROUNDS, wakeUps: WAKE_UPS, eventsPerWakeUp: due.length + 1, rows, medians: medians(rows) }
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
