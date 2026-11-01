// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NativeUsage } from '../../../src/main/agents/nativeUsage'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

/** A seeded generator (mulberry32), so a failing sequence can be run again. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

// Claude counts input only with the cache's reads and writes beside it; a request without a cache write is priced from
// an input of none, and one missing it stays unpriced, which leaves the thread partial.
const assistant = (id: string, model: string, input: number, output: number, cached: number, write?: number) => ({
  type: 'assistant', message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cached,
    cache_creation_input_tokens: write ?? 0, ...(write === undefined ? {} : { cache_creation: { ephemeral_5m_input_tokens: write } }) } },
})

interface Entry { readonly tokens: Record<string, number | undefined>; readonly usd?: number; readonly lowerBound?: boolean; readonly rate: string }

/**
 * What the walk of every request `summarize` made before #555 makes of a thread's requests, written out here so the
 * running totals are checked against it rather than against themselves: each request read from the thread's ledger file.
 */
async function walked(root: string) {
  const [name] = await readdir(join(root, 'claude-usage'))
  const { ledger } = JSON.parse(await readFile(join(root, 'claude-usage', name!), 'utf8')) as { ledger: { entries: Record<string, Entry>; incomplete: boolean } }
  const entries = Object.values(ledger.entries)
  const priced = entries.filter(entry => entry.usd !== undefined)
  const total: Record<string, number> = {}
  for (const field of ['input', 'output', 'cached', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h']) {
    const reported = entries.filter(entry => entry.tokens[field] !== undefined)
    if (reported.length) total[field] = reported.reduce((sum, entry) => sum + entry.tokens[field]!, 0)
  }
  return { total: Object.keys(total).length ? total : undefined,
    estimatedUsd: priced.length ? priced.reduce((sum, entry) => sum + entry.usd!, 0) : undefined,
    rateVersions: [...new Set(priced.map(entry => entry.rate))],
    partial: ledger.incomplete || entries.some(entry => entry.usd === undefined || entry.lowerBound === true) }
}

const totals = (view: ReturnType<NativeUsage['get']>) => view && { total: view.total, estimatedUsd: view.estimatedUsd, rateVersions: view.rateVersions, partial: view.partial }

it('keeps a thread\'s totals exactly what a walk of every request makes of them, through new, growing and replayed requests (#555)', async () => {
  for (const seed of [1, 2, 3, 555]) {
    const root = await mkdtemp(join(tmpdir(), 'sotto-usage-running-')); roots.push(root)
    const usage = new NativeUsage(root, 'claude'); await usage.load()
    const next = random(seed)
    const ids: string[] = []
    for (let step = 0; step < 400; step++) {
      const roll = next()
      // Priced and unpriced models, so the money adds up in floating point and some requests stay partial.
      const model = next() < 0.8 ? 'claude-opus-5-5' : 'a-model-with-no-price'
      const input = Math.floor(next() * 5_000), output = Math.floor(next() * 900), cached = Math.floor(next() * 20_000)
      const write = next() < 0.3 ? Math.floor(next() * 3_000) : undefined
      if (roll < 0.5 || ids.length === 0) {
        // A new request; one in twenty has a key JavaScript orders ahead of the others.
        const id = next() < 0.05 ? String(1_000 + step) : `msg_${seed}_${step}`
        ids.push(id); usage.claude('thread', assistant(id, model, input, output, cached, write))
      } else if (roll < 0.85) {
        // A request growing as its reply streams: mostly the newest, sometimes one a replay has added requests after.
        const id = next() < 0.7 ? ids.at(-1)! : ids[Math.max(0, ids.length - 1 - Math.floor(next() * 40))]!
        usage.claude('thread', { type: 'stream_event', event: { type: 'message_start', message: assistant(id, model, input, output, cached, write).message } })
        usage.claude('thread', { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: output + Math.floor(next() * 500) } } })
      } else {
        // A replay of an older request carrying a later snapshot of it.
        const id = ids[Math.floor(next() * ids.length)]!
        usage.claude('thread', assistant(id, model, input + 10_000, output + 1_000, cached + 10_000, write))
      }
      if (step % 50 === 49) {
        await usage.flushed()
        expect(totals(usage.get('thread'))).toEqual(await walked(root))
      }
    }
    await usage.flushed()
    const kept = usage.get('thread')!, read = await walked(root)
    expect(totals(kept)).toEqual(read)
    // To the last bit: the same additions, in the same order, over priced requests and unpriced ones.
    expect(kept.estimatedUsd).toBeGreaterThan(0)
    expect(kept.partial).toBe(true)
    expect(Object.is(kept.estimatedUsd, read.estimatedUsd)).toBe(true)
  }
})

it('counts a Codex or Grok report it already saw once, without scanning every key the thread saw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-seen-')); roots.push(root)
  const usage = new NativeUsage(root, 'codex'); await usage.load()
  for (let turn = 1; turn <= 3; turn++) {
    const report = { turnId: `turn-${turn}`, tokenUsage: { total: { inputTokens: turn * 100, outputTokens: turn * 10, cachedInputTokens: 0 }, last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 } } }
    usage.codex('thread', 'gpt-5.4', report)
    usage.codex('thread', 'gpt-5.4', report)
  }
  expect(usage.get('thread')?.total).toMatchObject({ input: 300, output: 30 })
  await usage.flushed()
})
