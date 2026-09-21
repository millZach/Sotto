// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeUsage } from '../../../src/main/agents/nativeUsage'
import { USAGE_RATE_VERSION } from '../../../src/main/agents/usageRates'

const roots: string[] = []
async function usage(provider: 'codex' | 'claude' | 'grok') {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-')); roots.push(root)
  const store = new NativeUsage(root, provider); await store.load()
  return { store, root }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('native usage observations', () => {
  it('keeps confirmed compacted context when old assistant usage replays, then accepts a new context snapshot', async () => {
    const { store } = await usage('claude')
    const original = { type: 'assistant', message: { id: 'before', model: 'claude-sonnet-4-6', usage: { input_tokens: 120000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
    store.claude('thread', original)
    store.compacted('thread', 30000)
    const after = store.get('thread')!.contextUpdatedAt
    store.claude('thread', original)
    expect(store.get('thread')).toMatchObject({ contextUsed: 30000, contextUpdatedAt: after })
    store.claude('thread', { ...original, message: { ...original.message, id: 'after', usage: { ...original.message.usage, input_tokens: 31000 } } })
    expect(store.get('thread')?.contextUsed).toBe(31000)
    await store.flushed()
  })
  it('adds previously unseen historical charges without replacing newer live Claude counters', async () => {
    const { store } = await usage('claude')
    const frame = (id: string, timestamp: string, output: number) => ({ type: 'assistant', timestamp, message: {
      id, model: 'claude-sonnet-4-6', usage: { input_tokens: 0, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } })
    store.claude('thread', frame('latest', '2026-09-13T10:00:00Z', 10))
    store.claude('thread', frame('history', '2026-09-12T10:00:00Z', 200))
    expect(store.get('thread')?.latest?.output).toBe(10)
    expect(store.get('thread')?.estimatedUsd).toBeCloseTo(0.00315, 8)
    await store.flushed()
  })
  it('reads installed Grok turn usage and its reported cost, without treating the sum of model calls as current context', async () => {
    const { store, root } = await usage('grok')
    const frame = { update: { sessionUpdate: 'turn_completed', prompt_id: 'native-prompt', usage: { inputTokens: 35220, outputTokens: 309,
      cachedReadTokens: 6912, cacheCreationTokens: 0, reasoningTokens: 232, apiDurationMs: 6935, costUsdTicks: 210548400,
      modelUsage: { 'grok-4.6-build': { inputTokens: 35220, outputTokens: 309, cachedReadTokens: 6912, cacheCreationTokens: 0 } } } } }
    store.grok('thread', 'grok-4.6-build', frame)
    expect(store.get('thread')).toMatchObject({ latest: { input: 35220, output: 309, cached: 6912 }, total: { input: 35220, output: 309, cached: 6912 },
      elapsedMs: 6935, elapsedKind: 'api', partial: false, rateVersions: ['grok-reported-cost'] })
    expect(store.get('thread')?.contextUsed).toBeUndefined()
    // 1 USD = 10^10 ticks.
    expect(store.get('thread')?.estimatedUsd).toBeCloseTo(0.02105484, 10)
    await store.flushed()
    const reopened = new NativeUsage(root, 'grok'); await reopened.load(); reopened.grok('thread', 'grok-4.6-build', frame)
    expect(reopened.get('thread')?.latest?.output).toBe(309)
    expect(reopened.get('thread')?.total?.output).toBe(309)
    await reopened.flushed()
  })
  it('matches the installed Astra fixture and keeps reasoning inside reported output rather than charging it twice', async () => {
    const { store } = await usage('codex')
    // Prior owned synthetic session documented in phase-4-usage.md; no network request.
    const native = { inputTokens: 23551, cachedInputTokens: 13056, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 23561 }
    store.codex('thread', 'gpt-6-astra', { turnId: 'native-turn', tokenUsage: { total: native, last: native, modelContextWindow: 258400 } })
    expect(store.get('thread')).toMatchObject({ latest: { input: 23551, output: 10, cached: 13056 }, contextUsed: 23561, contextWindow: 258400, partial: false })
    expect(store.get('thread')?.estimatedUsd).toBeCloseTo(0.118506, 8)
    await store.flushed()
  })
  it('retains prior costs across changed or unknown models, without guessing a cache-write TTL', async () => {
    const { store } = await usage('claude')
    const message = (id: string, model: string, creation: unknown = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }) => ({
      type: 'assistant', message: { id, model, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: creation ? 0 : 500, cache_creation: creation } },
    })
    store.claude('thread', message('first', 'claude-sonnet-4-6'))
    store.claude('thread', message('second', 'claude-haiku-4-5-20251001'))
    expect(store.get('thread')?.estimatedUsd).toBeCloseTo(0.006, 8)
    store.claude('thread', message('third', 'future-native-model'))
    store.claude('thread', message('fourth', 'claude-sonnet-4-6', null))
    expect(store.get('thread')?.estimatedUsd).toBeCloseTo(0.006, 8)
    expect(store.get('thread')).toMatchObject({ partial: true, latest: { input: 1500, cacheWrite: 500 } })
    await store.flushed()
  })
  it('does not apply a replayed stream delta to the latest unrelated Claude message', async () => {
    const { store } = await usage('claude')
    const frame = (id: string, output: number) => ({ type: 'assistant', message: { id, model: 'claude-sonnet-4-6', usage: { input_tokens: 0, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
    store.claude('thread', frame('old', 200))
    store.claude('thread', frame('latest', 10))
    store.claude('thread', { type: 'stream_event', event: { type: 'message_start', message: frame('old', 0).message } })
    store.claude('thread', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 200 } } })
    expect(store.get('thread')?.latest?.output).toBe(10)
    expect(store.get('thread')?.estimatedUsd).toBeCloseTo(0.00315, 8)
    await store.flushed()
  })
  it('prices Claude native cache TTLs once across streaming, completed message and durable log replay', async () => {
    const { store, root } = await usage('claude')
    const message = { id: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 100,
      cache_read_input_tokens: 2000, cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } } }
    store.claude('thread', { type: 'stream_event', event: { type: 'message_start', message } }, 'sonnet')
    store.claude('thread', { type: 'assistant', message }, 'sonnet')
    store.claudeResult('thread', { duration_ms: 1234, modelUsage: { 'claude-sonnet-4-6': { contextWindow: 200000 } } })
    // $0.003 uncached + $0.0006 reads + $0.001575 writes + $0.0015 output.
    expect(store.get('thread')?.estimatedUsd).toBeCloseTo(0.006675, 8)
    expect(store.get('thread')).toMatchObject({ latest: { input: 3300, output: 100 }, contextWindow: 200000, elapsedMs: 1234, modelId: 'sonnet', partial: false })
    await store.flushed()
    const reopened = new NativeUsage(root, 'claude'); await reopened.load()
    reopened.claude('thread', { type: 'assistant', message }, 'sonnet')
    expect(reopened.get('thread')?.estimatedUsd).toBeCloseTo(0.006675, 8)
    expect(reopened.get('thread')?.rateVersions).toEqual([USAGE_RATE_VERSION])
    await reopened.flushed()
  })
  it('does not charge an ambiguous counter reset twice, and keeps replay identities across restart', async () => {
    const { store, root } = await usage('codex')
    const frame = (input: number, output: number) => ({ turnId: 'turn', tokenUsage: {
      total: { inputTokens: input, outputTokens: output, cachedInputTokens: 0 },
      last: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0, totalTokens: 1100 }, modelContextWindow: 200000,
    } })
    store.codex('thread', 'gpt-5.4', frame(1000, 100))
    store.codex('thread', 'gpt-5.4', frame(2000, 200))
    expect(store.get('thread')?.estimatedUsd).toBeCloseTo(0.008, 8)
    store.codex('thread', 'gpt-5.4', frame(500, 50))
    expect(store.get('thread')?.estimatedUsd).toBeCloseTo(0.008, 8)
    expect(store.get('thread')?.partial).toBe(true)
    await store.flushed()
    const reopened = new NativeUsage(root, 'codex'); await reopened.load()
    reopened.codex('thread', 'gpt-5.4', frame(1000, 100))
    expect(reopened.get('thread')?.estimatedUsd).toBeCloseTo(0.008, 8)
    reopened.codex('thread', 'gpt-5.4', frame(1500, 150))
    expect(reopened.get('thread')?.estimatedUsd).toBeCloseTo(0.008, 8)
    reopened.codex('thread', 'gpt-5.4', frame(2500, 250))
    expect(reopened.get('thread')?.estimatedUsd).toBeCloseTo(0.010, 8)
    expect(reopened.get('thread')?.contextWindow).toBe(200000)
    await reopened.flushed()
  })
  it('keeps reported output visible when input and context are unavailable, without pricing missing counters', async () => {
    const { store } = await usage('codex')
    store.codex('thread', 'gpt-5.4', { turnId: 'turn', tokenUsage: { total: { outputTokens: 20 }, last: { outputTokens: 20 } } })
    expect(store.get('thread')?.latest?.output).toBe(20)
    expect(store.get('thread')?.latest?.input).toBeUndefined()
    expect(store.get('thread')?.contextUsed).toBeUndefined()
    expect(store.get('thread')?.estimatedUsd).toBeUndefined()
    await store.flushed()
  })
  it('adds up every request, prices current Claude, Codex and long-context models, and prices older unpriced usage on restart', async () => {
    const { store, root } = await usage('claude')
    const message = (id: string, model: string, output: number) => ({ type: 'assistant', message: { id, model, usage: { input_tokens: 2, output_tokens: output,
      cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 } } } })
    store.claude('thread', message('first', 'claude-opus-5', 300))
    store.claude('thread', message('second', 'claude-opus-5', 100))
    store.claude('thread', { type: 'assistant', message: { id: 'notice', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
    // Each: 2 uncached x $5 + 1000 read x $0.50 + 500 1h writes x $10, plus output at $25.
    expect(store.get('thread')).toMatchObject({ latest: { output: 100 }, total: { input: 3004, output: 400, cached: 2000 }, partial: false })
    expect(store.get('thread')?.estimatedUsd).toBeCloseTo((2 * (10 + 500 + 5000) + 400 * 25) / 1_000_000, 10)
    await store.flushed()

    const { store: codex } = await usage('codex')
    const long = { inputTokens: 300_000, cachedInputTokens: 200_000, outputTokens: 1000, totalTokens: 301_000 }
    codex.codex('thread', 'gpt-6-astra', { turnId: 'long', tokenUsage: { total: long, last: long, modelContextWindow: 1_000_000 } })
    // Long-context rates; Codex reported no cache writes, so the estimate is a lower bound.
    expect(codex.get('thread')?.estimatedUsd).toBeCloseTo((100_000 * 20 + 200_000 * 2 + 1000 * 75) / 1_000_000, 10)
    expect(codex.get('thread')?.partial).toBe(true)
    await codex.flushed()

    // A ledger written before claude-opus-5 had a price, holding a synthetic notice too.
    const { writeFile } = await import('node:fs/promises')
    const tokens = { input: 1502, output: 300, cached: 1000, cacheWrite: 500, cacheWrite5m: 0, cacheWrite1h: 500 }
    await writeFile(join(root, 'claude-usage.json'), JSON.stringify({ old: { view: { rateVersions: [], partial: true, updatedAt: '2026-09-14T00:00:00Z', latest: tokens },
      entries: { a: { tokens, model: 'claude-opus-5', rate: '2026-09-13-standard-v1' }, b: { tokens: { input: 0, output: 0 }, model: '<synthetic>', rate: '2026-09-13-standard-v1' } },
      seen: [], incomplete: false } }))
    const reopened = new NativeUsage(root, 'claude'); await reopened.load()
    expect(reopened.get('old')).toMatchObject({ total: { input: 1502, output: 300 }, partial: false, rateVersions: [USAGE_RATE_VERSION] })
    expect(reopened.get('old')?.estimatedUsd).toBeCloseTo((10 + 500 + 5000 + 300 * 25) / 1_000_000, 10)
    await reopened.flushed()
  })
})
