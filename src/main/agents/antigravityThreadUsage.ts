import { z } from 'zod'
import type { AgentThread } from '../../shared/agents'
import type { UsageTokens } from '../../shared/threadUsage'

/**
 * An Antigravity thread's token count, read from what `agy` 1.5 sends with each turn: `usage_update` says how full the
 * context is and how large it is, and each `session/prompt` answer carries the turn's tokens. Usage's own counts come
 * from `agy`'s conversation files (`antigravityHistory.ts`), so these are the thread's view only and are never added to
 * Usage, which would count them twice.
 */

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const answerSchema = z.object({ usage: z.object({
  inputTokens: count.optional(), outputTokens: count.optional(), cachedReadTokens: count.optional(), cachedWriteTokens: count.optional(),
}).passthrough() }).passthrough()
const fullnessSchema = z.object({ used: count.optional(), size: count.positive().optional() }).passthrough()

/**
 * One answer's tokens in Sotto's terms. `agy`'s `inputTokens` leaves out what was read from or written to its cache,
 * while Sotto's input counts the whole prompt, as Claude's does; its output already holds the thinking.
 */
export function antigravityAnswerTokens(answer: unknown): UsageTokens | undefined {
  const parsed = answerSchema.safeParse(answer)
  if (!parsed.success) return undefined
  const { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens } = parsed.data.usage
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  const input = inputTokens === undefined ? undefined : inputTokens + (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0)
  return { ...(input !== undefined ? { input } : {}), ...(outputTokens !== undefined ? { output: outputTokens } : {}),
    ...(cachedReadTokens !== undefined ? { cached: cachedReadTokens } : {}), ...(cachedWriteTokens !== undefined ? { cacheWrite: cachedWriteTokens } : {}) }
}

const addToTotal = (before: UsageTokens | undefined, tokens: UsageTokens): UsageTokens => {
  const sum: UsageTokens = { ...before }
  for (const field of ['input', 'output', 'cached', 'cacheWrite'] as const) {
    if (tokens[field] !== undefined) sum[field] = (before?.[field] ?? 0) + tokens[field]
  }
  return sum
}

/**
 * A prompt's answer: its tokens are added to the thread's total, and become its latest unless a steer has since sent a
 * newer prompt, whose answer may already have come. Whether anything changed.
 */
export function countAntigravityAnswer(thread: AgentThread, answer: unknown, newest: boolean): boolean {
  const tokens = antigravityAnswerTokens(answer)
  if (!tokens) return false
  const now = new Date().toISOString()
  thread.usage = { rateVersions: [], partial: true, ...thread.usage, ...(newest ? { latest: tokens } : {}), total: addToTotal(thread.usage?.total, tokens), updatedAt: now }
  return true
}

/** A `usage_update`: how full the thread's context is, on the model it runs. Whether anything changed. */
export function countAntigravityFullness(thread: AgentThread, update: unknown): boolean {
  const parsed = fullnessSchema.safeParse(update)
  if (!parsed.success || parsed.data.used === undefined && parsed.data.size === undefined) return false
  const { used, size } = parsed.data
  const now = new Date().toISOString()
  thread.usage = { rateVersions: [], partial: true, ...thread.usage,
    ...(used !== undefined ? { contextUsed: used } : {}), ...(size !== undefined ? { contextWindow: size } : {}),
    ...(thread.modelId ? { modelId: thread.modelId } : {}), contextUpdatedAt: now, updatedAt: now }
  return true
}
