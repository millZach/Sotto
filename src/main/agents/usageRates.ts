import type { UsageTokens } from '../../shared/threadUsage'

/** Immutable standard text-token price inputs, USD/million. New pricing needs a new version. */
export const USAGE_RATE_VERSION = '2026-09-13-standard-v1'
const rates: Record<string, { input: number; cached: number; output: number; write?: number; write5m?: number; write1h?: number; maxInput?: number }> = {
  'codex:gpt-6-astra': { input: 10, cached: 1, output: 50, write: 12.5, maxInput: 272000 },
  'codex:gpt-5.4': { input: 2.5, cached: 0.25, output: 15, maxInput: 272000 },
  'claude:claude-sonnet-4-6': { input: 3, cached: 0.3, output: 15, write5m: 3.75, write1h: 6 },
  'claude:claude-haiku-4-5-20251001': { input: 1, cached: 0.1, output: 5, write5m: 1.25, write1h: 2 },
  'claude:claude-haiku-4-5': { input: 1, cached: 0.1, output: 5, write5m: 1.25, write1h: 2 },
}
/** input always includes cached input and cache creation. Unknown cache TTL is deliberately unpriced. */
export function estimateUsage(provider: string, model: string, tokens: UsageTokens): number | undefined {
  const rate = rates[`${provider}:${model}`]
  if (!rate || tokens.input === undefined || tokens.output === undefined || tokens.cached === undefined) return undefined
  if (rate.maxInput !== undefined && tokens.input > rate.maxInput) return undefined
  if (rate.write !== undefined && tokens.cacheWrite === undefined) return undefined
  const write = tokens.cacheWrite ?? 0
  const uncached = tokens.input - tokens.cached - write
  if (uncached < 0) return undefined
  if (rate.write === undefined && write > 0 && (tokens.cacheWrite5m === undefined || tokens.cacheWrite1h === undefined
    || tokens.cacheWrite5m + tokens.cacheWrite1h !== write || rate.write5m === undefined || rate.write1h === undefined)) return undefined
  return (uncached * rate.input + tokens.cached * rate.cached + tokens.output * rate.output
    + write * (rate.write ?? 0) + (tokens.cacheWrite5m ?? 0) * (rate.write5m ?? 0) + (tokens.cacheWrite1h ?? 0) * (rate.write1h ?? 0)) / 1_000_000
}
