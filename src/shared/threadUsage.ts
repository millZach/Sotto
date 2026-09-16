import { z } from 'zod'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const usageTokensSchema = z.object({
  input: count.optional(), output: count.optional(), cached: count.optional(),
  cacheWrite: count.optional(), cacheWrite5m: count.optional(), cacheWrite1h: count.optional(),
})
export type UsageTokens = z.infer<typeof usageTokensSchema>
export const threadUsageSchema = z.object({
  latest: usageTokensSchema.optional(),
  /** Sum of every recorded request in the thread. */
  total: usageTokensSchema.optional(), contextUsed: count.optional(), contextWindow: count.positive().optional(),
  elapsedMs: count.optional(), estimatedUsd: z.number().nonnegative().optional(),
  elapsedKind: z.enum(['turn', 'api']).optional(),
  rateVersions: z.array(z.string()), partial: z.boolean(), updatedAt: z.string(),
  contextUpdatedAt: z.string().optional(),
  persistenceError: z.boolean().optional(),
  modelId: z.string().optional(),
})
export type ThreadUsage = z.infer<typeof threadUsageSchema>

/** Token counts for a line with no room for "120,000": 940, 120k, 1.2M. */
export function formatTokenCount(value: number): string {
  const scaled = value >= 1_000_000 ? { amount: value / 1_000_000, unit: 'M' } : value >= 1_000 ? { amount: value / 1_000, unit: 'k' } : undefined
  if (!scaled) return String(Math.round(value))
  const rounded = scaled.amount < 10 ? scaled.amount.toFixed(1).replace(/\.0$/u, '') : String(Math.round(scaled.amount))
  return `${rounded}${scaled.unit}`
}
