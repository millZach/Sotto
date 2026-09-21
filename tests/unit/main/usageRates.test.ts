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
  it('leaves the Grok Build variants unpriced, because x.ai publishes no list price for them', () => {
    expect(estimateUsage('grok', 'grok-4.7-build-fast', { input: 1_000, cached: 0, output: 100 })).toBeUndefined()
    expect(estimateUsage('grok', 'grok-4.7-build', { input: 1_000, cached: 0, output: 100 })).toBeUndefined()
  })
})
