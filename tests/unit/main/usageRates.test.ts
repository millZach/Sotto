// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { estimateUsage } from '../../../src/main/agents/usageRates'

describe('standard text-token prices', () => {
  it('prices a Grok 4.7 turn at the standard tier', () => {
    expect(estimateUsage('grok', 'grok-4.7', { input: 100_000, cached: 20_000, output: 1_000 }))
      .toEqual({ usd: 0.176, lowerBound: false })
  })
  it('prices a Grok 4.7 turn above 200,000 input tokens at the long-context tier', () => {
    expect(estimateUsage('grok', 'grok-4.7', { input: 250_000, cached: 50_000, output: 1_000 }))
      .toEqual({ usd: 0.862, lowerBound: false })
  })
  it('prices GPT-6-Sol at the standard tier, cache writes included, and above 272,000 input tokens at the long tier', () => {
    const short = estimateUsage('codex', 'gpt-6-sol', { input: 100_000, cached: 20_000, cacheWrite: 10_000, output: 1_000 })!
    expect(short.usd).toBeCloseTo(0.179, 10)
    expect(short.lowerBound).toBe(false)
    expect(estimateUsage('codex', 'gpt-6-sol', { input: 300_000, cached: 50_000, cacheWrite: 0, output: 1_000 })!.usd).toBeCloseTo(1.035, 10)
  })
  it('prices GPT-6-Luna, and says so when Codex left its cache writes out', () => {
    const turn = estimateUsage('codex', 'gpt-6-luna', { input: 100_000, cached: 20_000, output: 1_000 })!
    expect(turn.usd).toBeCloseTo(0.0087, 10)
    expect(turn.lowerBound).toBe(true)
  })
  it('prices Claude Opus 5.5 with its own cache-read rate, under the ID the session reports', () => {
    const tokens = { input: 100_000, cached: 20_000, cacheWrite: 10_000, cacheWrite5m: 4_000, cacheWrite1h: 6_000, output: 1_000 }
    // $4 input, $0.20 cache read (0.05x), $5 and $8 cache writes, $20 output, per million tokens.
    expect(estimateUsage('claude', 'claude-opus-5-5', tokens)!.usd).toBeCloseTo(0.372, 10)
    expect(estimateUsage('claude', 'claude-opus-5-5[1m]', tokens)!.usd).toBeCloseTo(0.372, 10)
  })
  it('leaves the Grok Build variants unpriced, because x.ai publishes no list price for them', () => {
    expect(estimateUsage('grok', 'grok-4.7-build-fast', { input: 1_000, cached: 0, output: 100 })).toBeUndefined()
    expect(estimateUsage('grok', 'grok-4.7-build', { input: 1_000, cached: 0, output: 100 })).toBeUndefined()
  })
})
