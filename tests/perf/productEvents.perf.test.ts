// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProductEvents, type ProductEventsOptions } from '../../src/main/productEvents/productEvents'
import { ThreadProductEvents, type ProductEventRecorder } from '../../src/main/productEvents/threadEvents'
import type { AgentThread } from '../../src/shared/agents'
import { copyBudgetPipeline } from '../fixtures/copyBudgetPipeline'

/**
 * What product events cost the process that sends them (ADR-0179). The turn event below is the largest one. A timing
 * benchmark, so it runs only under SOTTO_PERF_BENCH=1 on an idle machine, and its budgets assert only under
 * SOTTO_PERF_ASSERT=1. docs/perf/2026-11-02-product-events.md has the numbers.
 */
const ASSERT = process.env.SOTTO_PERF_ASSERT === '1'
const TURN = { provider: 'codex', model: 'gpt-6-sol', effort: 'high', speed: 'standard', permissionMode: 'approval-required', startedBy: 'user', result: 'completed', durationMs: 48_211,
  inputTokens: 18_204, cachedInputTokens: 15_360, outputTokens: 912, reasoningTokens: 240, childInputTokens: 0, childOutputTokens: 0 } as const
const INSTALL = { appVersion: '0.1.43', channel: 'stable', surface: 'desktop', platform: 'linux', arch: 'x64' } as const
const report = (name: string, value: number, unit: string): void => { console.log(`product-events ${name}: ${value.toFixed(2)} ${unit}`) }

function microsPerRecord(events: ProductEvents, times: number): number {
  const started = process.hrtime.bigint()
  for (let index = 0; index < times; index += 1) events.record('turn.completed', TURN)
  return Number(process.hrtime.bigint() - started) / 1_000 / times
}

describe.skipIf(process.env.SOTTO_PERF_BENCH !== '1')('product events cost', () => {
  let directory: string
  let server: Server
  let endpoint: string
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sotto-product-events-perf-'))
    server = createServer((request, response) => { request.resume(); request.on('end', () => { response.statusCode = 200; response.end('ok') }) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })
  afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  const make = (over: Partial<ProductEventsOptions> = {}): ProductEvents => new ProductEvents({ endpoint, install: INSTALL, dataDirectory: directory, environment: {}, holdWhileWaiting: true,
    homes: { claudeFile: join(directory, 'none'), codexHome: join(directory, 'none') }, readOwners: async () => [], ...over })

  it('costs next to nothing to record, and nothing with no endpoint or switched off', () => {
    const dark = make({ endpoint: null })
    const off = make(); off.setPermission('off')
    const on = make()
    // Warm the schema so the number is a turn's, not the first call's.
    microsPerRecord(on, 2_000)
    const results = { dark: microsPerRecord(dark, 200_000), off: microsPerRecord(off, 200_000), on: microsPerRecord(on, 2_000) }
    report('record with no endpoint', results.dark, 'us per event')
    report('record switched off', results.off, 'us per event')
    report('record switched on', results.on, 'us per event')
    if (ASSERT) { expect(results.dark).toBeLessThan(1); expect(results.off).toBeLessThan(1); expect(results.on).toBeLessThan(100) }
  })

  it('holds the event loop for no measurable time while a full queue goes out', async () => {
    // Main has fetched long before its first batch, so its first fetch's load is not this path's cost.
    await (await fetch(endpoint, { method: 'POST', body: '{}' })).text()
    const measure = async (count: number): Promise<number> => {
      const events = make()
      for (let index = 0; index < count; index += 1) events.record('turn.completed', TURN)
      events.setPermission('on')
      const delay = monitorEventLoopDelay({ resolution: 1 })
      delay.enable()
      while (events.waitingCount > 0) await events.flush()
      delay.disable()
      return delay.max / 1e6
    }
    await measure(20)
    report('one batch of 20, longest event loop delay', await measure(20), 'ms')
    const events = make()
    for (let index = 0; index < 1_000; index += 1) events.record('turn.completed', TURN)
    events.setPermission('on')
    // The same wait with nothing to send, so the delay below is read against this process's own.
    const before = monitorEventLoopDelay({ resolution: 1 })
    before.enable()
    await new Promise(resolve => setTimeout(resolve, 100))
    before.disable()
    report('nothing to send, longest event loop delay', before.max / 1e6, 'ms')
    const delay = monitorEventLoopDelay({ resolution: 1 })
    delay.enable()
    const started = performance.now()
    while (events.waitingCount > 0) await events.flush()
    const elapsed = performance.now() - started
    delay.disable()
    report('1,000 events in 50 batches, elapsed', elapsed, 'ms')
    report('1,000 events in 50 batches, longest event loop delay', delay.max / 1e6, 'ms')
    expect(events.waitingCount).toBe(0)
    if (ASSERT) expect(delay.max / 1e6).toBeLessThan(50)
  })

  it('costs one failed connection per retry when offline, and no throw', async () => {
    let tries = 0
    let clock = 1_000_000
    const offline = (async () => { tries += 1; throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const events = make({ fetch: offline, now: () => clock, random: () => 0 })
    events.setPermission('on')
    for (let index = 0; index < 1_000; index += 1) events.record('turn.completed', TURN)
    const started = performance.now()
    // An hour offline, at one timer every 30 seconds.
    for (let tick = 0; tick < 120; tick += 1) { await events.flush(); clock += 30_000 }
    report('an hour offline, batches tried', tries, 'tries')
    report('an hour offline, work', performance.now() - started, 'ms')
    if (ASSERT) expect(tries).toBeLessThan(120)
  })

  it('adds a few look-ups to an update, on the tracker alone', () => {
    const recorder: ProductEventRecorder = { record: () => undefined, featureUsed: () => undefined }
    const tracker = new ThreadProductEvents({ recorder, startedBy: () => 'user' })
    tracker.trackAll([])
    const running = { id: 'one', providerId: 'codex', modelId: 'gpt-5.5', status: 'running', lastTurn: { id: 'turn', status: 'running' }, messages: [], requests: [] } as unknown as AgentThread
    const times = 2_000_000, named = [running], gone: string[] = []
    const measure = (): number => {
      const started = process.hrtime.bigint()
      for (let index = 0; index < times; index += 1) tracker.track(named, gone)
      return Number(process.hrtime.bigint() - started) / times
    }
    measure()
    const nanoseconds = measure()
    report('tracker, one thread named by an update', nanoseconds, 'ns per update')
    if (ASSERT) expect(nanoseconds).toBeLessThan(2_000)
  })

  /**
   * Before and after on main's real update path: the adapter, the provider switch, the workspace, the coordinator and the
   * window's publisher at 200 threads. "After" has the real sender switched on, sending to a local server, as a release will.
   * The runs take turns and the first of each is thrown away, so a machine's drift falls on both sides.
   */
  it.each([[false, 'stable'], [true, 'owl']] as const)('costs a turn nothing measurable on the update path, %s', async (owl, name) => {
    const TURNS = 5, CHUNKS = 100, ROUNDS = 6
    const round = async (withEvents: boolean): Promise<{ cpu: number; updates: number }> => {
      const root = await mkdtemp(join(tmpdir(), 'sotto-product-events-turn-'))
      const events = make()
      events.setPermission('on')
      const pipeline = await copyBudgetPipeline(root, 200, owl, withEvents ? events : null)
      try {
        const stream = pipeline.adapter.state.threads.find(thread => thread.id === 'stream-0')!
        pipeline.adapter.log.add(stream.id, { id: 'reply', role: 'assistant', text: 'First', createdAt: new Date().toISOString() })
        const before = process.cpuUsage()
        for (let turn = 0; turn < TURNS; turn += 1) {
          stream.status = 'running'; stream.lastTurn = { id: `turn-${turn}`, status: 'running' }
          pipeline.adapter.mark(stream.id); pipeline.adapter.publish(false)
          await new Promise(resolve => setTimeout(resolve, 50))
          for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
            pipeline.adapter.log.appendText(stream.id, 'reply', ` word${chunk}`)
            pipeline.adapter.publish(true)
            await new Promise(resolve => setTimeout(resolve, 1))
          }
          stream.status = 'idle'; stream.lastTurn = { id: `turn-${turn}`, status: 'completed' }
          pipeline.adapter.mark(stream.id); pipeline.adapter.publish(false)
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        const used = process.cpuUsage(before)
        if (withEvents && events.waitingCount !== TURNS) throw new Error(`${events.waitingCount} events of ${TURNS} were recorded, so this measured something else.`)
        return { cpu: (used.user + used.system) / 1_000, updates: TURNS * CHUNKS }
      } finally { events.stop(); await pipeline.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
    }
    await round(false); await round(true)
    const without: number[] = [], withIt: number[] = []
    for (let index = 0; index < ROUNDS; index += 1) {
      for (const on of index % 2 === 0 ? [false, true] : [true, false]) (on ? withIt : without).push((await round(on)).cpu / (TURNS * CHUNKS))
    }
    const median = (values: number[]): number => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!
    const spread = (values: number[]): string => `${Math.min(...values).toFixed(3)} to ${Math.max(...values).toFixed(3)}`
    report(`${name} update, before`, median(without), `ms CPU per update (${spread(without)})`)
    report(`${name} update, after`, median(withIt), `ms CPU per update (${spread(withIt)})`)
    if (ASSERT) expect(median(withIt)).toBeLessThan(median(without) * 1.25)
  }, 300_000)
})
