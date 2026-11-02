// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProductEvents, type ProductEventsOptions } from '../../src/main/productEvents/productEvents'

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
})
