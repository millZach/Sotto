import type { UsageTokens } from '../../shared/threadUsage'

/** Immutable standard text-token price inputs, USD/million. New pricing needs a new version. */
export const USAGE_RATE_VERSION = '2026-09-21-standard-v3'

interface Tier { readonly input: number; readonly cached?: number; readonly output: number; readonly write?: number }
interface Rate extends Tier {
  readonly cached: number
  /** Anthropic prices cache writes by TTL, on top of the input they are part of. */
  readonly write5m?: number; readonly write1h?: number
  /** OpenAI bills a cache-write token once, at this rate instead of the input rate. */
  readonly write?: number
  /** Requests with at least this many input tokens use the long-context tier. */
  readonly long?: Tier & { readonly from: number }
  /** Above this many input tokens the price is not published, so the request stays unpriced. */
  readonly maxInput?: number
}
const openAiLong = 272_001
// 2026-09-15: developers.openai.com/api/docs/pricing, platform.claude.com/docs/en/about-claude/pricing. 2026-09-21: docs.x.ai/docs/models.
const rates: Record<string, Rate> = {
  'codex:gpt-6-astra': { input: 10, cached: 1, output: 50, write: 12.5, long: { from: openAiLong, input: 20, cached: 2, output: 75, write: 25 } },
  'codex:gpt-5.6-sol': { input: 4, cached: 0.4, output: 20, write: 5, long: { from: openAiLong, input: 8, cached: 0.8, output: 30, write: 10 } },
  'codex:gpt-5.6-terra': { input: 2, cached: 0.2, output: 12, write: 2.5, long: { from: openAiLong, input: 4, cached: 0.4, output: 18, write: 5 } },
  'codex:gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2, write: 0.25, long: { from: openAiLong, input: 0.4, cached: 0.04, output: 1.8, write: 0.5 } },
  // Long-context cached input is not published for these two, so long requests stay unpriced.
  'codex:gpt-5.5': { input: 5, cached: 0.5, output: 30, maxInput: 272_000 },
  'codex:gpt-5.4': { input: 2.5, cached: 0.25, output: 15, maxInput: 272_000 },
  'grok:grok-4.7': { input: 2, cached: 0.5, output: 6, long: { from: 200_000, input: 4, cached: 1, output: 12 } },
  'grok:grok-4.6': { input: 2, cached: 0.5, output: 6, long: { from: 200_000, input: 4, cached: 1, output: 12 } },
  'grok:grok-4.5': { input: 2, cached: 0.3, output: 6, long: { from: 200_000, input: 4, cached: 0.6, output: 12 } },
  'claude:claude-opus-5': { input: 5, cached: 0.5, output: 25, write5m: 6.25, write1h: 10 },
  'claude:claude-fable-5-1': { input: 10, cached: 0.25, output: 50, write5m: 12.5, write1h: 20 },
  'claude:claude-sonnet-5': { input: 2, cached: 0.2, output: 10, write5m: 2.5, write1h: 4 },
  'claude:claude-sonnet-4-6': { input: 3, cached: 0.3, output: 15, write5m: 3.75, write1h: 6 },
  'claude:claude-haiku-4-5': { input: 1, cached: 0.1, output: 5, write5m: 1.25, write1h: 2 },
}

/** Native clients report dated or context-suffixed IDs for the same priced model. */
function rateFor(provider: string, model: string): Rate | undefined {
  return rates[`${provider}:${model}`] ?? rates[`${provider}:${model.replace(/\[1m\]$/u, '').replace(/-\d{8}$/u, '')}`]
}

export interface UsageEstimate {
  readonly usd: number
  /** Some reported work was priced at a lower rate than it may have cost. */
  readonly lowerBound: boolean
}
/** input always includes cached input and cache creation. Unknown cache TTL is deliberately unpriced. */
export function estimateUsage(provider: string, model: string, tokens: UsageTokens): UsageEstimate | undefined {
  const base = rateFor(provider, model)
  if (!base || tokens.input === undefined || tokens.output === undefined || tokens.cached === undefined) return undefined
  if (base.maxInput !== undefined && tokens.input > base.maxInput) return undefined
  const tier: Tier = base.long && tokens.input >= base.long.from ? base.long : base
  const cachedRate = tier.cached ?? base.cached
  const output = tokens.output * tier.output
  if (base.write5m !== undefined || base.write1h !== undefined) {
    const write = tokens.cacheWrite ?? 0
    if (write > 0 && (tokens.cacheWrite5m === undefined || tokens.cacheWrite1h === undefined || tokens.cacheWrite5m + tokens.cacheWrite1h !== write)) return undefined
    const uncached = tokens.input - tokens.cached - write
    if (uncached < 0) return undefined
    return { usd: (uncached * tier.input + tokens.cached * cachedRate + output + (tokens.cacheWrite5m ?? 0) * base.write5m! + (tokens.cacheWrite1h ?? 0) * base.write1h!) / 1_000_000, lowerBound: false }
  }
  if (tier.write !== undefined) {
    // Codex may omit cache writes; pricing them as plain input can only undercount.
    const write = tokens.cacheWrite ?? 0
    const uncached = tokens.input - tokens.cached - write
    if (uncached < 0) return undefined
    return { usd: (uncached * tier.input + tokens.cached * cachedRate + write * tier.write + output) / 1_000_000, lowerBound: tokens.cacheWrite === undefined }
  }
  // No separate cache-write price: every token that was not a cache read is plain input.
  const uncached = tokens.input - tokens.cached
  if (uncached < 0) return undefined
  return { usd: (uncached * tier.input + tokens.cached * cachedRate + output) / 1_000_000, lowerBound: false }
}
