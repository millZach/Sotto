// @vitest-environment node
// SOTTO_PERF_BENCH=1 npx vitest run tests/perf/watcherRoomRemote.perf.test.ts --maxWorkers=1 --disable-console-intercept
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { serialize } from 'node:v8'
import { describe, expect, it } from 'vitest'
import { startSocketServer } from '../../src/host/socketServer'
import { LocalHostService } from '../../src/main/agents/hostService'
import { PairedClients } from '../../src/main/agents/pairing'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { WatcherService } from '../../src/main/agents/watcher'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { WatcherRoomState } from '../../src/shared/watcherRoom'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { PERF_BENCH, median } from '../fixtures/perfBench'
import { stack } from '../fixtures/windowThreadShellPipeline'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const ITERATIONS = 10
const ROUNDS = 3

/** Scope synchronous room reads separately from cache ingestion, observers and transport. */
describe.skipIf(!PERF_BENCH)('Watcher room reads from a real socket cache (#991)', () => {
  it('reports whole-shell clone calls, estimated copied bytes and aggregate CPU for remote room reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-watcher-remote-room-'))
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-watcher-remote-room-')) throw new Error('Unexpected owned fixture path')
    const cleanups: (() => Promise<unknown>)[] = []
    const nativeClone = globalThis.structuredClone
    let measuring = false
    let shellCalls = 0, shellClones = 0
    let copied = new Map<object, number>()
    const failures: unknown[] = []
    try {
      const remoteRoot = join(root, 'remote')
      for (const provider of ['claude', 'codex']) await mkdir(join(remoteRoot, provider), { recursive: true })
      const remote = await stack(remoteRoot, false, 6, true)
      cleanups.push(remote.stop)
      const pairing = new PairedClients(remoteRoot); await pairing.load()
      const server = await startSocketServer({ service: new LocalHostService({ control: remote.control, events: remote.workspace }), pairing })
      cleanups.push(() => server.close())
      const url = `http://127.0.0.1:${server.descriptor.port}`
      const paired = await SocketHostService.pair(url, pairing.issuePairingCode().code, 'Generated room benchmark')
      // These existing-feature answers are inert on the pre-change owners, then consumed by the fix.
      const socket = new SocketHostService({ url, token: paired.token, watcherEnabled: true, ...{ streamingPublishCost: true } })
      cleanups.push(() => socket.close())
      await socket.connect()
      const cache = socket.shell()
      expect(cache.host.threads).toHaveLength(204)
      expect(cache.host.projects).toHaveLength(43)
      expect(cache.host.models).toHaveLength(875)
      const ids = Array.from({ length: 6 }, (_, i) => remote.registry.bySession('claude', `stream-${i}`)!.threadId)
      expect(ids.every(id => cache.host.threads.some(thread => thread.id === id))).toBe(true)
      const local = await workspaceFixture(undefined, { history: false, watcherEnabled: true })
      cleanups.push(local.remove, local.stop)
      const f = await agentControlFixture({ directory: local.root, host: local.host,
        credentialOptions: { mode: 'unavailable' }, control: { historyEnabled: () => false, watcherEnabled: true, streamingPublishCost: true } })
      cleanups.push(() => f.dispose())
      await f.control.start()
      const at = '2026-10-14T00:00:00.000Z', requestId = randomUUID()
      await f.control.updateWatcher(record => {
        record.current = { target: { hostId: f.control.hostId()!, threadId: 'generated-master' },
          projectId: 'generated-project', provider: 'claude', creationOperationId: randomUUID(), createdAt: at }
        record.requests.push({ id: requestId, watcher: record.current.target, rootUserMessageId: 'generated-prompt',
          state: 'active', createdAt: at, closedAt: null, participants: [] })
      })
      const watcher = new WatcherService({ directory: local.root, control: f.control, host: local.host,
        historyEnabled: () => false, ...{ streamingPublishCost: true } })
      cleanups.push(async () => { watcher.close() })
      const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true, ...{ streamingPublishCost: true } })
      cleanups.push(async () => { router.dispose() })
      router.add({ hostId: paired.hostId, name: 'Generated remote', kind: 'remote', service: socket,
        detail: id => socket.readThreadDetail(id), preview: () => null })
      watcher.useRemoteHosts(router.watcherHosts())
      const readShell = socket.shell.bind(socket)
      socket.shell = () => { if (measuring) shellCalls++; return readShell() }
      globalThis.structuredClone = function <Value>(value: Value, options?: unknown): Value {
        if (measuring && value !== null && typeof value === 'object' && 'host' in value && 'configuration' in value) {
          shellClones++
          const state = value
          copied.set(state, (copied.get(state) ?? 0) + 1)
        }
        return Reflect.apply(nativeClone, globalThis, [value, options]) as Value
      }
      for (const targets of [1, 3, 6]) {
        await f.control.updateWatcher(record => {
          record.requests[0]!.participants = ids.slice(0, targets).map(threadId => ({ target: { hostId: paired.hostId, threadId },
            requestId, startedBy: 'watcher', generation: 0, state: 'participating', promptCount: 1 }))
        })
        expect(watcher.state().watchedThreads).toHaveLength(targets)
        for (const method of ['state', 'get'] as const) {
          const rows: Record<string, number>[] = []
          for (let round = 0; round < ROUNDS; round++) {
            shellCalls = 0; shellClones = 0; copied = new Map()
            measuring = true
            const cpu = process.cpuUsage(), started = performance.now()
            let final: WatcherRoomState | undefined
            try {
              for (let index = 0; index < ITERATIONS; index++) {
                const result = method === 'get' ? watcher.get() : { status: 'ok' as const, state: watcher.state() }
                if (result.status !== 'ok') throw new Error('Generated room Get was refused')
                final = result.state
              }
            } finally { measuring = false }
            const used = process.cpuUsage(cpu), wallMs = performance.now() - started
            const cpuMs = (used.user + used.system) / 1000
            // Untimed accounting; size is estimated from the actual cached inputs, not wire traffic.
            const copiedBytes = [...copied].reduce((total, [state, count]) => total + serialize(state).length * count, 0)
            expect(final?.watchedThreads).toHaveLength(targets)
            expect(final?.watchedThreads.map(thread => thread.target)).toEqual(ids.slice(0, targets).map(threadId => ({ hostId: paired.hostId, threadId })))
            expect(final?.watchedThreads.every(thread => thread.title.startsWith('Streaming thread') && thread.connected)).toBe(true)
            rows.push({ shellCalls, shellClones, copiedBytes, wallMs, cpuMs, cpuMsPerRead: cpuMs / ITERATIONS })
          }
          const medians = Object.fromEntries(Object.keys(rows[0]!).map(key => [key, median(rows.map(row => row[key]!))]))
          console.log(`Remote Watcher room reads: ${JSON.stringify({ targets, method, iterations: ITERATIONS, rounds: ROUNDS,
            shape: { threads: cache.host.threads.length, projects: cache.host.projects.length, models: cache.host.models.length,
              estimatedCacheBytes: serialize(cache).length }, rows, medians })}`)
        }
      }
    } catch (error) { failures.push(error) }
    finally {
      globalThis.structuredClone = nativeClone
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup() } catch (error) { failures.push(error) }
      }
      try { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) }
      catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Remote room benchmark or cleanup failed')
  }, 180_000)
})
