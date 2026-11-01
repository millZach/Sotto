// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeUsage, tokenCount } from '../../../src/main/agents/nativeUsage'
import { UsageStore } from '../../../src/main/agents/usageStore'
import type { UsageTokenObservation } from '../../../src/shared/usageDashboard'
import { usageTokenObservationSchema } from '../../../src/shared/usageDashboard'
import { CodexAppServerHost } from '../../../src/main/agents/codex'
import { ClaudeStreamJsonHost } from '../../../src/main/agents/claude'
import { GrokAcpHost } from '../../../src/main/agents/grok'
import { ConfiguredProviderHost, providerEntityId } from '../../../src/main/agents/providerSwitch'
import { SottoThreadHost, ThreadRegistry } from '../../../src/main/agents/threads'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import type { ClaudeFrame } from '../../../src/main/agents/claudeProtocol'

const roots: string[] = []
const drains: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const drain of drains.splice(0)) await drain()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture(provider: 'claude' | 'codex' | 'grok', enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-dashboard-native-')); roots.push(root)
  const usage = new NativeUsage(root, provider, enabled); await usage.load(); drains.push(() => usage.flushed())
  const rows: UsageTokenObservation[] = []
  usage.subscribeUsage(row => { usageTokenObservationSchema.parse(row); rows.push(row) })
  return { root, usage, rows }
}
const claudeFrame = (id: string, output = 3) => ({ type: 'assistant', message: { id, model: 'claude-sonnet-4-6',
  usage: { input_tokens: 5, output_tokens: output, cache_read_input_tokens: 10, cache_creation_input_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 12 } } } })
const grokFrame = (ticks: number | null = 100) => ({ _meta: { agentTimestampMs: Date.parse('2026-10-12T10:01:00Z') },
  update: { sessionUpdate: 'turn_completed', prompt_id: 'native-prompt-secret', usage: { inputTokens: 50, outputTokens: 8,
    cachedReadTokens: 5, cacheCreationTokens: 2, ...(ticks !== null ? { costUsdTicks: ticks } : {}),
    modelUsage: { 'grok-a': { inputTokens: 30, outputTokens: 5, cachedReadTokens: 5, cacheCreationTokens: 0 },
      'grok-b': { inputTokens: 20, outputTokens: 3, cachedReadTokens: 0, cacheCreationTokens: 2 } } } } })

describe('Owl native numeric projection', () => {
  it('reads a provider figure as a non-negative safe integer, the one check Muse, OpenCode and the native ledgers share', () => {
    expect([0, 1, 1_200_000, Number.MAX_SAFE_INTEGER].map(tokenCount)).toEqual([0, 1, 1_200_000, Number.MAX_SAFE_INTEGER])
    expect([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity, '12', null, undefined].map(tokenCount)).toEqual(new Array(8).fill(undefined))
  })

  it('collects nothing when off and repairs cache-write totals without extending the stable ledger format', async () => {
    const { usage, rows, root } = await fixture('claude', false)
    usage.claude('thread', claudeFrame('native-message-secret'))
    expect(rows).toEqual([])
    const visited: UsageTokenObservation[] = []; usage.visitUsage('thread', row => visited.push(row)); expect(visited).toEqual([])
    expect(usage.get('thread')?.total).toMatchObject({ input: 35, output: 3, cached: 10, cacheWrite: 20, cacheWrite5m: 8, cacheWrite1h: 12 })
    await usage.flushed()
    // The thread's ledger file, of the one thread here (#555).
    const directory = join(root, 'claude-usage')
    const ledger = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), 'utf8')).ledger
    expect(Object.keys(ledger.entries['native-message-secret']).sort()).toEqual(['model', 'rate', 'tokens', 'usd'])
  })
  it('uses whole Claude replacements and hashes parent groups, preserving genuine dates through replay', async () => {
    const { usage, rows } = await fixture('claude')
    const context = { phase: 'live' as const, groupId: 'native-user-secret', groupStartedAt: '2026-10-12T10:00:00Z' }
    usage.claude('thread', { type: 'stream_event', event: { type: 'message_start', message: claudeFrame('native-message-secret').message } }, undefined, context)
    usage.claude('thread', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 12 } } }, undefined, context)
    usage.claude('thread', claudeFrame('native-message-secret', 1), undefined, { ...context, phase: 'replay' })
    expect(new Set(rows.map(row => row.recordKey)).size).toBe(1)
    expect(new Set(rows.map(row => row.groupKey)).size).toBe(1)
    expect(rows.at(-1)).toMatchObject({ tokens: { input: 35, output: 12 }, groupStartedAt: new Date(context.groupStartedAt).toISOString(), phase: 'replay' })
    expect(JSON.stringify(rows)).not.toContain('native-message-secret')
    expect(JSON.stringify(rows)).not.toContain('native-user-secret')
    const seed: UsageTokenObservation[] = []; usage.visitUsage('thread', row => seed.push(row))
    expect(seed).toHaveLength(1); expect(seed[0]).toMatchObject({ phase: 'replay', tokens: { output: 12 } })
    expect(seed[0]?.liveNewGroup).toBeUndefined()
  })
  it('visits undated legacy rows without assigning the latest context date', async () => {
    const { usage, root } = await fixture('claude')
    usage.claude('thread', { ...claudeFrame('old'), timestamp: '2026-10-01T10:00:00Z' }); await usage.flushed()
    const restarted = new NativeUsage(root, 'claude', true); await restarted.load(); drains.push(() => restarted.flushed())
    const seed: UsageTokenObservation[] = []; restarted.visitUsage('thread', row => seed.push(row))
    expect(seed[0]).toMatchObject({ phase: 'seed' }); expect(seed[0]?.at).toBeUndefined(); expect(seed[0]?.groupStartedAt).toBeUndefined()
  })
  it('keeps a cleared Claude parent turn suppressed across streams and later assistant requests', async () => {
    const { usage, root } = await fixture('claude')
    let now = '2026-10-12T10:00:00.000Z'
    const store = new UsageStore(join(root, 'usage.sqlite'), () => now); store.open(); drains.push(async () => store.close())
    usage.subscribeUsage(row => store.observeTokens(row))
    const context = { phase: 'live' as const, groupId: 'parent-turn', groupStartedAt: '2026-10-12T09:59:00Z' }
    usage.claude('thread', { type: 'stream_event', event: { type: 'message_start', message: claudeFrame('first').message } }, undefined, context)
    now = '2026-10-12T10:01:00.000Z'; store.clear(store.metadata().revision)
    usage.claude('thread', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20 } } }, undefined, context)
    usage.claude('thread', claudeFrame('second', 4), undefined, context)
    expect(store.query({}).totals.tokenRecords).toBe(0)
    usage.claude('thread', claudeFrame('third', 5), undefined, { phase: 'live', groupId: 'next-parent', groupStartedAt: '2026-10-12T10:02:00Z' })
    expect(store.query({}).totals.tokens.total.value).toBe(40)
    usage.claude('thread', claudeFrame('first'), undefined, { ...context, phase: 'replay' })
    expect(store.query({}).totals.tokens.total.value).toBe(40)
  })
  it('does not let a numeric observer failure change existing native accounting', async () => {
    const { usage } = await fixture('claude')
    usage.subscribeUsage(() => { throw new Error('numeric persistence failed') })
    expect(() => usage.claude('thread', claudeFrame('message'))).not.toThrow()
    expect(usage.get('thread')?.total).toMatchObject({ input: 35, output: 3 })
  })
  it('keeps Codex delta rows under one group so Clear suppresses all later snapshots of an active turn', async () => {
    const { usage, root, rows } = await fixture('codex')
    let now = new Date('2026-10-12T10:00:00Z')
    const store = new UsageStore(join(root, 'usage.sqlite'), () => now.toISOString()); store.open(); drains.push(async () => store.close())
    const off = usage.subscribeUsage(row => store.observeTokens(row))
    const frame = (turnId: string, input: number, output: number) => ({ turnId, tokenUsage: { total: { inputTokens: input, outputTokens: output }, last: { inputTokens: 10, outputTokens: 2 } } })
    const started = '2026-10-12T09:59:00Z'
    usage.codex('thread', 'gpt-5', frame('native-turn-secret', 10, 2), { phase: 'live', groupStartedAt: started })
    const initial = rows.at(-1)!
    now = new Date('2026-10-12T10:01:00Z'); store.clear(store.metadata().revision)
    usage.codex('thread', 'gpt-5', frame('native-turn-secret', 20, 4), { phase: 'live', groupStartedAt: started })
    expect(rows.at(-1)?.recordKey).not.toBe(initial.recordKey); expect(rows.at(-1)?.groupKey).toBe(initial.groupKey)
    expect(store.query({}).totals.tokenRecords).toBe(0)
    usage.codex('thread', 'gpt-5', frame('next-native-turn-secret', 30, 6), { phase: 'live', groupStartedAt: '2026-10-12T10:02:00Z' })
    expect(store.query({}).totals.tokens.total.value).toBe(12)
    usage.codex('thread', 'gpt-5', frame('next-native-turn-secret', 30, 6), { phase: 'replay', groupStartedAt: '2026-10-12T10:02:00Z' })
    expect(store.query({}).totals.tokens.total.value).toBe(12); off()
  })
  it('replaces a partial Grok aggregate seed with exact mixed models without changing reported cost', async () => {
    const { usage, root } = await fixture('grok')
    usage.grok('thread', 'selected-model', grokFrame()); await usage.flushed()
    const restarted = new NativeUsage(root, 'grok', true); await restarted.load(); drains.push(() => restarted.flushed())
    const store = new UsageStore(join(root, 'usage.sqlite')); store.open(); drains.push(async () => store.close())
    restarted.visitUsage('thread', row => store.observeTokens(row))
    expect(store.query({}).models).toHaveLength(1)
    expect(store.query({}).models[0]).toMatchObject({ modelId: 'unknown', partialTokenRecords: 1 })
    restarted.subscribeUsage(row => store.observeTokens(row))
    restarted.grok('thread', 'selected-model', grokFrame(), { phase: 'replay' })
    const read = store.query({}); expect(read.totals.tokens.total.value).toBe(58); expect(read.totals.tokenRecords).toBe(2)
    expect(read.models.map(model => [model.modelId, model.tokens.total.value])).toEqual([['grok-a', 35], ['grok-b', 23]])
    restarted.grok('thread', 'selected-model', grokFrame(null), { phase: 'replay' })
    expect(store.query({}).totals.tokens.total.value).toBe(58)
    expect(restarted.get('thread')?.estimatedUsd).toBe(100 / 10_000_000_000)
    expect(restarted.get('thread')?.rateVersions).toEqual(['grok-reported-cost'])
    store.clear(store.metadata().revision)
    restarted.grok('thread', 'selected-model', grokFrame(), { phase: 'replay' })
    expect(store.query({}).totals.tokenRecords).toBe(0)
  })
  it('does not revive a retired Grok aggregate over exact model rows on the next restart', async () => {
    const { usage, root } = await fixture('grok')
    const store = new UsageStore(join(root, 'usage.sqlite')); store.open(); drains.push(async () => store.close())
    usage.subscribeUsage(row => store.observeTokens(row))
    usage.grok('thread', 'selected-model', grokFrame(), { phase: 'live', groupStartedAt: '2026-10-12T10:00:00Z' })
    await usage.flushed()
    const before = store.query({}); expect(before.totals.tokens.total.value).toBe(58)
    const revision = before.metadata.revision
    const restarted = new NativeUsage(root, 'grok', true); await restarted.load(); drains.push(() => restarted.flushed())
    restarted.visitUsage('thread', row => { expect(row.phase).toBe('seed'); expect(store.observeTokens(row).status).toBe('suppressed') })
    expect(store.query({}).totals.tokens.total.value).toBe(58); expect(store.metadata().revision).toBe(revision)
    expect(store.query({}).models).toEqual(before.models)
    restarted.subscribeUsage(row => store.observeTokens(row))
    restarted.grok('thread', 'selected-model', grokFrame(), { phase: 'replay' })
    expect(store.query({}).totals.tokens.total.value).toBe(58)
    const withoutModels = grokFrame()
    delete (withoutModels.update.usage as { modelUsage?: unknown }).modelUsage
    const third = new NativeUsage(root, 'grok', true); await third.load(); drains.push(() => third.flushed())
    third.subscribeUsage(row => store.observeTokens(row))
    // The thread's saved requests are read before its first report after the restart applies (#1937).
    third.grok('thread', 'selected-model', withoutModels, { phase: 'replay' }); await third.flushed()
    expect(store.query({}).totals.tokens.total.value).toBe(58)
    expect(store.query({}).totals.tokens.total.partial).toBe(true)
    third.grok('thread', 'selected-model', grokFrame(), { phase: 'replay' })
    expect(store.query({}).totals.tokens.total.value).toBe(58)
    expect(store.query({}).totals.tokens.total.partial).toBe(false)
  })
  it('recovers an early unbound genuine live replacement through the visitor without treating it as a legacy seed', async () => {
    const { usage, root } = await fixture('claude')
    const store = new UsageStore(join(root, 'usage.sqlite')); store.open(); drains.push(async () => store.close())
    const context = { phase: 'live' as const, groupId: 'current-parent', groupStartedAt: '2026-10-12T10:00:00Z' }
    usage.claude('thread', claudeFrame('current', 3), undefined, context)
    usage.visitUsage('thread', row => store.observeTokens(row))
    // The replacement arrives before Sotto can bind its native observer. Only a later visitor recovers it.
    usage.claude('thread', claudeFrame('current', 20), undefined, context)
    usage.visitUsage('thread', row => { expect(row.phase).toBe('live'); store.observeTokens(row) })
    expect(store.query({}).totals.tokens.output.value).toBe(20)
    expect(store.query({}).totals.tokenRecords).toBe(1)
  })
  it('makes a conflicting Grok model-set shrink unknown until complete native evidence repairs every model', async () => {
    const { usage, root } = await fixture('grok')
    const store = new UsageStore(join(root, 'usage.sqlite')); store.open(); drains.push(async () => store.close())
    usage.subscribeUsage(row => store.observeTokens(row))
    usage.grok('thread', 'selected-model', grokFrame(), { phase: 'live' })
    const shrinking = grokFrame()
    shrinking.update.usage.modelUsage = { 'grok-b': shrinking.update.usage.modelUsage['grok-b'] } as typeof shrinking.update.usage.modelUsage
    Object.assign(shrinking.update.usage, { inputTokens: 20, outputTokens: 3, cachedReadTokens: 0, cacheCreationTokens: 2 })
    usage.grok('thread', 'selected-model', shrinking, { phase: 'replay' })
    let read = store.query({})
    expect(read.totals.tokens.total.value).toBeUndefined(); expect(read.totals.tokens.total.knownRows).toBe(0)
    expect(read.models.every(model => model.tokens.input.value === undefined && model.tokens.output.value === undefined)).toBe(true)
    const changed = structuredClone(shrinking)
    const modelC = { inputTokens: 7, outputTokens: 2, cachedReadTokens: 0, cacheCreationTokens: 0 }
    Object.assign(changed.update.usage.modelUsage, { 'grok-c': modelC })
    Object.assign(changed.update.usage, { inputTokens: 27, outputTokens: 5 })
    usage.grok('thread', 'selected-model', changed, { phase: 'replay' })
    read = store.query({}); expect(read.totals.tokens.total.value).toBeUndefined(); expect(read.totals.tokenRecords).toBe(3)
    const repaired = grokFrame()
    Object.assign(repaired.update.usage.modelUsage, { 'grok-c': modelC })
    Object.assign(repaired.update.usage, { inputTokens: 57, outputTokens: 10 })
    usage.grok('thread', 'selected-model', repaired, { phase: 'replay' })
    read = store.query({}); expect(read.totals.tokens.total.value).toBe(67); expect(read.totals.tokens.total.partial).toBe(false)
    expect(usage.get('thread')?.estimatedUsd).toBe(100 / 10_000_000_000)
    expect(usage.get('thread')?.total).toMatchObject({ input: 50, output: 8 })
  })
  it('keeps exact Grok model identities independent of reported cost and retires only the separate aggregate', async () => {
    const { usage, rows } = await fixture('grok')
    usage.grok('thread', 'selected-model', grokFrame(null), { phase: 'live' })
    const keys = rows.filter(row => !row.removed).map(row => row.recordKey).sort()
    expect(rows[0]?.removed).toBe(true)
    expect(rows[0]?.groupRecordsHash).toBe(createHash('sha256').update(JSON.stringify(keys)).digest('hex'))
    usage.grok('thread', 'selected-model', grokFrame(), { phase: 'replay' })
    expect(rows.slice(-2).map(row => row.recordKey).sort()).toEqual(keys)
    const seed: UsageTokenObservation[] = []; usage.visitUsage('thread', row => seed.push(row))
    expect(seed.filter(row => !row.removed).map(row => row.recordKey).sort()).toEqual(keys)
    expect(seed.reduce((sum, row) => sum + (row.tokens.input ?? 0) + (row.tokens.output ?? 0), 0)).toBe(58)
  })
  it('keeps Grok b-only then a+b model identities stable through repeated cost-bearing restarts', async () => {
    const { usage, root } = await fixture('grok')
    const store = new UsageStore(join(root, 'usage.sqlite')); store.open(); drains.push(async () => store.close())
    usage.subscribeUsage(row => store.observeTokens(row))
    const onlyB = grokFrame()
    onlyB.update.usage.modelUsage = { 'grok-b': onlyB.update.usage.modelUsage['grok-b'] } as typeof onlyB.update.usage.modelUsage
    Object.assign(onlyB.update.usage, { inputTokens: 20, outputTokens: 3, cachedReadTokens: 0, cacheCreationTokens: 2 })
    usage.grok('thread', 'selected-model', onlyB, { phase: 'live' })
    expect(store.query({}).totals.tokens.total.value).toBe(23)
    usage.grok('thread', 'selected-model', grokFrame(), { phase: 'replay' })
    expect(store.query({}).totals.tokens.total.value).toBe(58)
    await usage.flushed()
    for (let restart = 0; restart < 2; restart++) {
      const native = new NativeUsage(root, 'grok', true); await native.load(); drains.push(() => native.flushed())
      native.visitUsage('thread', row => store.observeTokens(row))
      expect(store.query({}).totals.tokens.total.value).toBe(58)
      native.subscribeUsage(row => store.observeTokens(row)); native.grok('thread', 'selected-model', grokFrame(), { phase: 'replay' })
      const read = store.query({})
      expect(read.totals.tokens.total.value).toBe(58); expect(read.totals.tokenRecords).toBe(2)
      expect(read.models.map(model => [model.modelId, model.tokens.total.value])).toEqual([['grok-a', 35], ['grok-b', 23]])
      expect(native.get('thread')?.total).toMatchObject({ input: 20, output: 3 })
      expect(native.get('thread')?.estimatedUsd).toBe(100 / 10_000_000_000)
    }
  })
  it('makes a cost-bearing restart shrink unknown and repairs it only with the complete native group', async () => {
    const { usage, root } = await fixture('grok')
    const store = new UsageStore(join(root, 'usage.sqlite')); store.open(); drains.push(async () => store.close())
    usage.subscribeUsage(row => store.observeTokens(row))
    usage.grok('thread', 'selected-model', grokFrame(), { phase: 'live' }); await usage.flushed()
    expect(store.query({}).totals.tokens.total.value).toBe(58)
    const native = new NativeUsage(root, 'grok', true); await native.load(); drains.push(() => native.flushed())
    native.visitUsage('thread', row => store.observeTokens(row))
    const before = store.query({}); expect(before.totals.tokens.total.value).toBe(58); expect(before.totals.tokens.total.partial).toBe(false)
    native.subscribeUsage(row => store.observeTokens(row))
    const onlyB = grokFrame()
    onlyB.update.usage.modelUsage = { 'grok-b': onlyB.update.usage.modelUsage['grok-b'] } as typeof onlyB.update.usage.modelUsage
    Object.assign(onlyB.update.usage, { inputTokens: 20, outputTokens: 3, cachedReadTokens: 0, cacheCreationTokens: 2 })
    native.grok('thread', 'selected-model', onlyB, { phase: 'replay' })
    let read = store.query({})
    expect(read.totals.tokens.total.value).toBeUndefined(); expect(read.totals.tokens.total.partial).toBe(true)
    expect(read.models).toHaveLength(2)
    expect(read.models.every(model => model.tokens.input.value === undefined && model.tokens.output.value === undefined)).toBe(true)
    native.grok('thread', 'selected-model', grokFrame(), { phase: 'replay' })
    read = store.query({}); expect(read.totals.tokens.total.value).toBe(58); expect(read.totals.tokens.total.partial).toBe(false)
    expect(read.totals.tokenRecords).toBe(2)
    expect(native.get('thread')?.estimatedUsd).toBe(100 / 10_000_000_000)
    expect(native.get('thread')?.total).toMatchObject({ input: 50, output: 8 })
  })
  it('reconciles an equal-total model-set replacement after a cost-bearing restart without adding old models', async () => {
    const { usage, root } = await fixture('grok')
    const store = new UsageStore(join(root, 'usage.sqlite')); store.open(); drains.push(async () => store.close())
    usage.subscribeUsage(row => store.observeTokens(row))
    usage.grok('thread', 'selected-model', grokFrame(), { phase: 'live' }); await usage.flushed()
    const native = new NativeUsage(root, 'grok', true); await native.load(); drains.push(() => native.flushed())
    native.visitUsage('thread', row => store.observeTokens(row)); native.subscribeUsage(row => store.observeTokens(row))
    const changed = grokFrame()
    const modelC = { inputTokens: 50, outputTokens: 8, cachedReadTokens: 5, cacheCreationTokens: 2 }
    Object.assign(changed.update.usage, { modelUsage: { 'grok-c': modelC } })
    native.grok('thread', 'selected-model', changed, { phase: 'replay' })
    let read = store.query({})
    expect(read.totals.tokens.total.value).toBe(58); expect(read.totals.tokens.total.partial).toBe(true)
    expect(read.models.find(model => model.modelId === 'grok-a')!.tokens.total.value).toBeUndefined()
    expect(read.models.find(model => model.modelId === 'grok-b')!.tokens.total.value).toBeUndefined()
    expect(read.models.find(model => model.modelId === 'grok-c')!.tokens.total.value).toBe(58)
    const complete = grokFrame()
    Object.assign(complete.update.usage.modelUsage, { 'grok-c': modelC })
    Object.assign(complete.update.usage, { inputTokens: 100, outputTokens: 16, cachedReadTokens: 10, cacheCreationTokens: 4 })
    native.grok('thread', 'selected-model', complete, { phase: 'replay' })
    read = store.query({}); expect(read.totals.tokens.total.value).toBe(116); expect(read.totals.tokens.total.partial).toBe(false)
    expect(read.totals.tokenRecords).toBe(3)
    expect(native.get('thread')?.total).toMatchObject({ input: 50, output: 8 })
  })
  it('makes the same-model downward evidence unknown after a cost-bearing restart and restores complete higher evidence', async () => {
    const { usage, root } = await fixture('grok')
    const store = new UsageStore(join(root, 'usage.sqlite')); store.open(); drains.push(async () => store.close())
    usage.subscribeUsage(row => store.observeTokens(row))
    const frame = (input: number) => {
      const value = grokFrame()
      Object.assign(value.update.usage, { inputTokens: input, outputTokens: 5, cachedReadTokens: 5, cacheCreationTokens: 0,
        modelUsage: { 'grok-a': { inputTokens: input, outputTokens: 5, cachedReadTokens: 5, cacheCreationTokens: 0 } } })
      return value
    }
    usage.grok('thread', 'selected-model', frame(30), { phase: 'live' }); await usage.flushed()
    const native = new NativeUsage(root, 'grok', true); await native.load(); drains.push(() => native.flushed())
    native.visitUsage('thread', row => store.observeTokens(row)); native.subscribeUsage(row => store.observeTokens(row))
    native.grok('thread', 'selected-model', frame(10), { phase: 'replay' })
    expect(store.query({}).totals.tokens.total.value).toBeUndefined()
    expect(store.query({}).totals.partialTokenRecords).toBe(1)
    native.grok('thread', 'selected-model', frame(31), { phase: 'replay' })
    expect(store.query({}).totals.tokens.total.value).toBe(36)
    expect(store.query({}).totals.tokens.total.partial).toBe(false)
    expect(native.get('thread')?.total).toMatchObject({ input: 30, output: 5 })
  })
  it('keeps repeated lower same-membership evidence incomplete across adapter and SQLite restarts until full evidence repairs it', async () => {
    const { usage, root } = await fixture('grok')
    const path = join(root, 'usage.sqlite')
    let store = new UsageStore(path); store.open(); drains.push(async () => store.close())
    usage.subscribeUsage(row => store.observeTokens(row))
    const onlyB = grokFrame()
    onlyB.update.usage.modelUsage = { 'grok-b': onlyB.update.usage.modelUsage['grok-b'] } as typeof onlyB.update.usage.modelUsage
    Object.assign(onlyB.update.usage, { inputTokens: 20, outputTokens: 3, cachedReadTokens: 0, cacheCreationTokens: 2 })
    usage.grok('thread', 'selected-model', onlyB, { phase: 'live' })
    usage.grok('thread', 'selected-model', grokFrame(), { phase: 'replay' }); await usage.flushed()
    expect(store.query({}).totals.tokens.total.value).toBe(58)
    const native = new NativeUsage(root, 'grok', true); await native.load(); drains.push(() => native.flushed())
    native.visitUsage('thread', row => store.observeTokens(row)); native.subscribeUsage(row => store.observeTokens(row))
    const lowered = grokFrame()
    lowered.update.usage.modelUsage['grok-a'].inputTokens = 10; lowered.update.usage.inputTokens = 30
    for (let replay = 0; replay < 3; replay++) {
      native.grok('thread', 'selected-model', lowered, { phase: 'replay' })
      const read = store.query({})
      expect(read.totals.tokens.total.partial).toBe(true)
      expect(read.models.find(model => model.modelId === 'grok-a')!.tokens.total.value).toBeUndefined()
      expect(read.models.find(model => model.modelId === 'grok-b')!.tokens.total.value).toBe(23)
      expect(read.totals.tokens.total.value).toBe(23)
    }
    // Neither the persisted legacy aggregate nor the fresh adapter remembers A's prior 30.
    // SQLite's numeric confidence must survive reopening the actual database as well.
    store.close(); store = new UsageStore(path); store.open()
    const afterRestart = new NativeUsage(root, 'grok', true); await afterRestart.load(); drains.push(() => afterRestart.flushed())
    afterRestart.visitUsage('thread', row => store.observeTokens(row)); afterRestart.subscribeUsage(row => store.observeTokens(row))
    for (let replay = 0; replay < 2; replay++) {
      afterRestart.grok('thread', 'selected-model', lowered, { phase: 'replay' })
      const read = store.query({})
      expect(read.totals.tokens.total.value).toBe(23); expect(read.totals.tokens.total.partial).toBe(true)
      expect(read.models.find(model => model.modelId === 'grok-a')!.tokens.total.value).toBeUndefined()
    }
    afterRestart.grok('thread', 'selected-model', grokFrame(), { phase: 'replay' })
    expect(store.query({}).totals.tokens.total.value).toBe(58)
    expect(store.query({}).totals.tokens.total.partial).toBe(false)
    const higher = grokFrame()
    higher.update.usage.modelUsage['grok-a'].inputTokens = 40; higher.update.usage.inputTokens = 60
    afterRestart.grok('thread', 'selected-model', higher, { phase: 'replay' })
    expect(store.query({}).totals.tokens.total.value).toBe(68)
    expect(store.query({}).totals.tokens.total.partial).toBe(false)
    expect(afterRestart.get('thread')?.total).toMatchObject({ input: 20, output: 3 })
  })
  it('seeds legacy Grok per-model identities once and makes a later model-free report unknown without restoring an aggregate', async () => {
    const { usage, root } = await fixture('grok')
    usage.grok('thread', 'selected-model', grokFrame(null), { phase: 'live' }); await usage.flushed()
    const native = new NativeUsage(root, 'grok', true); await native.load(); drains.push(() => native.flushed())
    const store = new UsageStore(join(root, 'usage.sqlite')); store.open(); drains.push(async () => store.close())
    const seed: UsageTokenObservation[] = []
    native.visitUsage('thread', row => { seed.push(row); store.observeTokens(row) })
    expect(seed[0]?.removed).toBe(true)
    expect(seed.filter(row => !row.removed)).toHaveLength(2)
    expect(store.query({}).totals.tokens.total.value).toBe(58)
    const initialKeys = seed.filter(row => !row.removed).map(row => row.recordKey).sort()
    native.subscribeUsage(row => store.observeTokens(row))
    const withoutModels = grokFrame(null); delete (withoutModels.update.usage as { modelUsage?: unknown }).modelUsage
    native.grok('thread', 'selected-model', withoutModels, { phase: 'replay' })
    expect(store.query({}).totals.tokens.total.value).toBeUndefined()
    expect(store.query({}).totals.tokenRecords).toBe(2)
    native.grok('thread', 'selected-model', grokFrame(null), { phase: 'replay' })
    expect(store.query({}).totals.tokens.total.value).toBe(58)
    const restored: UsageTokenObservation[] = []; native.visitUsage('thread', row => restored.push(row))
    expect(restored.filter(row => !row.removed).map(row => row.recordKey).sort()).toEqual(initialKeys)
    expect(restored.filter(row => !row.removed).every(row => row.phase === 'replay')).toBe(true)
    store.clear(store.metadata().revision)
    native.visitUsage('thread', row => store.observeTokens(row))
    expect(store.query({}).totals.tokenRecords).toBe(0)
  })
  it('makes a same-model downward Grok report unknown instead of publishing an old high-water vector as complete', async () => {
    const { usage, root } = await fixture('grok')
    const store = new UsageStore(join(root, 'usage.sqlite')); store.open(); drains.push(async () => store.close())
    usage.subscribeUsage(row => store.observeTokens(row))
    const frame = (input: number) => {
      const value = grokFrame()
      const model = { ...value.update.usage.modelUsage['grok-a'], inputTokens: input }
      Object.assign(value.update.usage, { inputTokens: input, outputTokens: 5, cachedReadTokens: 5, cacheCreationTokens: 0,
        modelUsage: { 'grok-a': model } })
      return value
    }
    usage.grok('thread', 'selected-model', frame(30), { phase: 'live' })
    expect(store.query({}).totals.tokens.total.value).toBe(35)
    usage.grok('thread', 'selected-model', frame(10), { phase: 'replay' })
    let read = store.query({})
    expect(read.totals.tokens.input.value).toBeUndefined(); expect(read.totals.tokens.total.value).toBeUndefined()
    expect(read.totals.partialTokenRecords).toBe(1)
    usage.grok('thread', 'selected-model', frame(31), { phase: 'replay' })
    read = store.query({}); expect(read.totals.tokens.total.value).toBe(36); expect(read.totals.tokens.total.partial).toBe(false)
    expect(usage.get('thread')?.total).toMatchObject({ input: 30, output: 5 })
  })
  it('keeps native prompt and model boundaries unambiguous inside the hashed Grok row identity', async () => {
    const { usage, rows } = await fixture('grok')
    const frame = (prompt: string, model: string) => {
      const value = grokFrame()
      value.update.prompt_id = prompt
      Object.assign(value.update.usage, { inputTokens: 10, outputTokens: 1, cachedReadTokens: 0, cacheCreationTokens: 0,
        modelUsage: { [model]: { inputTokens: 10, outputTokens: 1, cachedReadTokens: 0, cacheCreationTokens: 0 } } })
      return value
    }
    usage.grok('thread', 'selected', frame('a:model:b', 'c'), { phase: 'live' })
    usage.grok('thread', 'selected', frame('a', 'b:model:c'), { phase: 'live' })
    const exact = rows.filter(row => !row.removed)
    expect(exact).toHaveLength(2)
    expect(exact[0]!.recordKey).not.toBe(exact[1]!.recordKey)
    expect(exact[0]!.groupKey).not.toBe(exact[1]!.groupKey)
    expect(JSON.stringify(exact)).not.toContain('a:model:b')
  })
})

describe('native subscription metadata seam', () => {
  it.each(['codex', 'claude', 'grok'] as const)('answers other providers quota reads in the %s adapter without starting native work', async provider => {
    const { root } = await fixture(provider)
    const host = provider === 'codex' ? new CodexAppServerHost({ userDataPath: root, usageEnabled: true })
      : provider === 'claude' ? new ClaudeStreamJsonHost({ userDataPath: root, usageEnabled: true })
        : new GrokAcpHost(root, { usageEnabled: true })
    const connect = vi.spyOn(host, 'connect')
    const execute = vi.spyOn(host, 'execute')
    const read = provider === 'claude'
      ? vi.spyOn((host as unknown as { client: { findExecutable(): Promise<string | null> } }).client, 'findExecutable')
      : vi.spyOn(host as unknown as { readQuota(): Promise<unknown> }, 'readQuota')
    for (const refresh of [false, true]) {
      // OpenCode reports no account limits, so nothing may build a quota result for it; Muse's are its own adapter's to read.
      await expect(host.readProviderQuota!('opencode', refresh)).rejects.toThrow('Usage reads no limits for this provider.')
      await expect(host.readProviderQuota!('muse', refresh)).resolves.toMatchObject({ providerId: 'muse', status: 'unavailable', reason: 'unsupported' })
    }
    expect(read).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
  it('leaves every adapter seam absent on stable and keeps the startup answer immutable', async () => {
    const { root } = await fixture('claude', false)
    const options = { userDataPath: root, usageEnabled: false }
    const hosts = [new CodexAppServerHost(options), new ClaudeStreamJsonHost(options), new GrokAcpHost(root)]
    options.usageEnabled = true
    for (const host of hosts) {
      expect(host.subscribeUsage).toBeUndefined(); expect(host.visitUsage).toBeUndefined(); expect(host.readProviderQuota).toBeUndefined()
    }
  })
  it('reads Codex metadata on the existing provider process and reads no native session or model', async () => {
    const { root } = await fixture('codex')
    const host = new CodexAppServerHost({ userDataPath: root, usageEnabled: true })
    const methods: string[] = []
    const native = host as unknown as { state: AgentHostSnapshot; provider: unknown }
    native.state.connected = true
    native.provider = { alive: true, rpc: async (method: string, _params: unknown, apply: (value: unknown) => void) => {
      methods.push(method); apply({ rateLimits: { limitId: 'codex', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_900_000_000 } } })
    } }
    expect(await host.readProviderQuota!('codex', false)).toMatchObject({ reason: 'not-read', windows: [] }); expect(methods).toEqual([])
    expect(await host.readProviderQuota!('codex', true)).toMatchObject({ status: 'available', windows: [{ usedPercent: 0, durationMinutes: 300 }] })
    await host.readProviderQuota!('codex', false); expect(methods).toEqual(['account/rateLimits/read'])
  })
  it('merges Codex bucket notifications but lets a complete native read replace all buckets', async () => {
    const { root } = await fixture('codex')
    const host = new CodexAppServerHost({ userDataPath: root, usageEnabled: true })
    const methods: string[] = []
    const native = host as unknown as { state: AgentHostSnapshot; provider: unknown;
      frame(server: unknown, frame: { method: string; params: unknown }): Promise<void> }
    let response: unknown = { rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 20, resetsAt: 1_900_000_000 } },
      codex_other: { limitId: 'codex_other', primary: { usedPercent: 30, resetsAt: 1_900_500_000 } },
    } }
    native.state.connected = true
    native.provider = { alive: true, rpc: async (method: string, _params: unknown, apply: (value: unknown) => void) => {
      methods.push(method); apply(response)
    } }
    const before = await host.readProviderQuota!('codex', true)
    await native.frame(native.provider, { method: 'account/rateLimits/updated', params: {
      rateLimits: { primary: { usedPercent: 0, resetsAt: 1_900_000_000 }, secondary: null },
    } })
    const merged = await host.readProviderQuota!('codex', false)
    expect(merged.windows).toHaveLength(2)
    expect(merged.windows.find(window => window.id === before.windows[0]?.id)?.usedPercent).toBe(0)
    expect(merged.windows.find(window => window.id === before.windows[1]?.id)).toEqual(before.windows[1])
    expect(methods).toEqual(['account/rateLimits/read'])
    response = { rateLimits: { primary: { usedPercent: 0 } } }
    expect((await host.readProviderQuota!('codex', true)).windows).toHaveLength(1)
    expect(methods).toEqual(['account/rateLimits/read', 'account/rateLimits/read'])
  })
  it('merges passive Claude windows and still offers an on-demand read', async () => {
    const { root } = await fixture('claude')
    const host = new ClaudeStreamJsonHost({ userDataPath: root, usageEnabled: true })
    const native = host as unknown as { state: AgentHostSnapshot; aliases: Record<string, unknown>; threads: Map<string, unknown>; runtimes: Map<string, unknown>; frameAfterProfileCheck(id: string, frame: ClaudeFrame): void }
    native.state.connected = true; native.aliases.thread = { sessionId: 'native-session' }; native.threads.set('thread', new FakeProviderHost().state.threads[0]); native.runtimes.set('thread', {})
    native.frameAfterProfileCheck('thread', { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.4, status: 'allowed', resetsAt: 1_900_000_000 } })
    native.frameAfterProfileCheck('thread', { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.2, status: 'allowed', resetsAt: 1_900_500_000 } })
    const before = await host.readProviderQuota!('claude', false)
    native.frameAfterProfileCheck('thread', { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed_warning' } })
    const quota = await host.readProviderQuota!('claude', true)
    // No executable is set, so get_usage cannot run: the passive windows stay as evidence and a read is still offered.
    expect(quota.refreshable).toBe(true); expect(quota.windows.map(window => window.usedPercent)).toEqual([40, 20])
    expect(quota.windows[0]).toMatchObject({ status: 'warning', observedAt: before.windows[0]?.observedAt,
      resetsAt: '2030-03-17T17:46:40.000Z' })
    native.frameAfterProfileCheck('thread', { type: 'rate_limit_event', rate_limit_info: {
      rateLimitType: 'five_hour', status: 'allowed', resetsAt: 1_900_000_300,
    } })
    expect((await host.readProviderQuota!('claude', false)).windows[0]).not.toHaveProperty('usedPercent')
  })
  it('asks Grok for the exact billing extension with no session operations, preserving unknown percent', async () => {
    const { root } = await fixture('grok')
    const host = new GrokAcpHost(root, { usageEnabled: true })
    const methods: string[] = []
    const native = host as unknown as { state: AgentHostSnapshot; executable: string; spawn(): unknown; identify(probe: unknown): Promise<unknown>; authenticate(probe: unknown): Promise<void> }
    native.state.connected = true; native.executable = 'native'
    const close = vi.fn()
    vi.spyOn(native, 'spawn').mockReturnValue({ close, request: async (method: string, _params: unknown, apply: (value: unknown) => void) => {
      methods.push(method); apply({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-12T00:00:00Z', end: '2026-10-19T00:00:00Z' } } })
    } })
    vi.spyOn(native, 'identify').mockResolvedValue({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'cached_token' }], _meta: { agentVersion: '1.0.50' } })
    vi.spyOn(native, 'authenticate').mockResolvedValue()
    expect(await host.readProviderQuota!('grok', false)).toMatchObject({ reason: 'not-read' }); expect(methods).toEqual([])
    const quota = await host.readProviderQuota!('grok', true)
    expect(methods).toEqual(['_x.ai/billing']); expect(close).toHaveBeenCalledOnce()
    expect(quota.windows[0]).toMatchObject({ durationMinutes: 10080, resetsAt: '2026-10-19T00:00:00.000Z' })
    expect(quota.windows[0]?.usedPercent).toBeUndefined()
  })
  it('keeps a failed Grok quota refresh showing as failed on the plain read that follows, until a read succeeds (#1462)', async () => {
    const { root } = await fixture('grok')
    const host = new GrokAcpHost(root, { usageEnabled: true })
    const native = host as unknown as { state: AgentHostSnapshot; executable: string; spawn(): unknown; identify(probe: unknown): Promise<unknown>; authenticate(probe: unknown): Promise<void> }
    native.state.connected = true; native.executable = 'native'
    let refuse = false
    vi.spyOn(native, 'spawn').mockReturnValue({ close: vi.fn(), request: async (method: string, _params: unknown, apply: (value: unknown) => void) => {
      if (refuse) throw new Error('billing refused')
      apply({ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-12T00:00:00Z', end: '2026-10-19T00:00:00Z' } } })
    } })
    vi.spyOn(native, 'identify').mockResolvedValue({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'cached_token' }], _meta: { agentVersion: '1.0.50' } })
    vi.spyOn(native, 'authenticate').mockResolvedValue()
    const good = await host.readProviderQuota!('grok', true)
    refuse = true
    expect(await host.readProviderQuota!('grok', true)).toMatchObject({ status: 'error', reason: 'read-failed' })
    expect(await host.readProviderQuota!('grok', false)).toMatchObject({ status: 'error', reason: 'read-failed', windows: good.windows })
    refuse = false
    const readAgain = await host.readProviderQuota!('grok', true)
    expect(await host.readProviderQuota!('grok', false)).toMatchObject({ windows: readAgain.windows })
    expect((await host.readProviderQuota!('grok', false)).status).not.toBe('error')
  })
})

it('maps native thread IDs before observing or visiting usage and qualifies model IDs once', async () => {
  const { root } = await fixture('codex')
  const registry = new ThreadRegistry(root)
  const native = new FakeProviderHost() as FakeProviderHost & { subscribeUsage: (listener: (record: UsageTokenObservation) => void) => () => void; visitUsage: (id: string, visitor: (record: UsageTokenObservation) => void) => void }
  let listener: ((record: UsageTokenObservation) => void) | undefined
  native.subscribeUsage = value => { listener = value; return () => { listener = undefined } }
  const row: UsageTokenObservation = { providerId: 'codex', threadId: 'session-workshop', recordKey: 'a'.repeat(64), modelId: 'gpt-5', tokens: { input: 10, output: 1 }, phase: 'live', partial: false }
  native.visitUsage = (id, visitor) => { expect(id).toBe('session-workshop'); visitor(row) }
  const wrapped = new SottoThreadHost('codex', native, registry)
  const host = new ConfiguredProviderHost({ hosts: { codex: wrapped, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost(), opencode: new FakeProviderHost(), cursor: new FakeProviderHost(), deepseek: new FakeProviderHost() }, provider: () => 'codex', threadProvider: id => registry.byThread(id)?.provider })
  const seen: UsageTokenObservation[] = []; const off = host.subscribeUsage!(value => seen.push(value))
  const before = wrapped.subscribeUsage!(value => seen.push(value))
  expect(listener).toBeUndefined(); await registry.load()
  listener!(row); expect(seen).toEqual([]); before()
  await host.connect('codex')
  const id = registry.bySession('codex', 'session-workshop')!.threadId
  listener!(row); host.visitUsage!(id, value => seen.push(value))
  expect(seen).toHaveLength(2)
  for (const value of seen) expect(value).toMatchObject({ threadId: id, modelId: providerEntityId('codex', 'model', 'gpt-5') })
  expect(JSON.stringify(seen)).not.toContain('session-workshop')
  off(); host.disconnect(); await registry.flush()
})

it('drops numeric callbacks retained from a previous provider connection', async () => {
  const native = new FakeProviderHost() as FakeProviderHost & { subscribeUsage: (listener: (record: UsageTokenObservation) => void) => () => void }
  const callbacks: Array<(record: UsageTokenObservation) => void> = []
  native.subscribeUsage = listener => { callbacks.push(listener); return () => undefined }
  const host = new ConfiguredProviderHost({ hosts: { codex: native, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost(), muse: new FakeProviderHost(), opencode: new FakeProviderHost(), cursor: new FakeProviderHost(), deepseek: new FakeProviderHost() }, provider: () => 'codex' })
  const seen: UsageTokenObservation[] = []; const off = host.subscribeUsage!(row => seen.push(row))
  const row: UsageTokenObservation = { providerId: 'codex', threadId: 'thread', recordKey: 'b'.repeat(64), modelId: 'gpt-5', tokens: { input: 1, output: 2 }, phase: 'live', partial: false }
  await host.connect('codex'); const old = callbacks[0]!
  host.disconnect('codex'); await host.connect('codex')
  old(row); expect(seen).toEqual([])
  callbacks[1]!(row); expect(seen).toHaveLength(1)
  off(); host.disconnect()
})
