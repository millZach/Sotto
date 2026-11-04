import { z } from 'zod'
import { providerIdSchema, type AgentThread, type ProviderId } from './agents'

/**
 * Dynamic threads (CONTEXT.md, **Dynamic thread**; ADR-0191): a thread whose model oversees and chooses a model for each
 * piece of work, inside the limits saved here. An Owl feature, `dynamic-threads`. This is the one reader every part asks.
 */

/** The providers an overseer runs on for now, whose standing instructions are checked (ADR-0191 decision 13). */
export const DYNAMIC_OVERSEERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['claude', 'codex'])
export const DYNAMIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const dynamicEffortSchema = z.enum(DYNAMIC_EFFORTS)
export type DynamicEffort = z.infer<typeof dynamicEffortSchema>
export const DEFAULT_HIGHEST_EFFORT: DynamicEffort = 'xhigh'
export const DEFAULT_WORKERS_AT_ONCE = 4
export const WORKERS_AT_ONCE_MAX = 100
export const workersAtOnceSchema = z.number().int().min(1).max(WORKERS_AT_ONCE_MAX)

/**
 * What Settings → Threads holds for every Dynamic thread on this computer. `providers` is the allowed list, absent until
 * the user has seen it: the first time they turn Dynamic on is when it is made, so a provider connected later never joins
 * a list they already agreed to.
 */
export const dynamicThreadSettingsSchema = z.object({
  providers: z.array(providerIdSchema).max(providerIdSchema.options.length).optional(),
  highestEffort: dynamicEffortSchema,
  workersAtOnce: workersAtOnceSchema,
}).strict()
export type DynamicThreadSettings = z.infer<typeof dynamicThreadSettingsSchema>
export const DEFAULT_DYNAMIC_THREADS: DynamicThreadSettings = { highestEffort: DEFAULT_HIGHEST_EFFORT, workersAtOnce: DEFAULT_WORKERS_AT_ONCE }

/** Read one field at a time, so a damaged value costs only itself. A damaged list is no list, so it is asked for again. */
export function parseDynamicThreadSettings(input: unknown): DynamicThreadSettings {
  const saved = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
  const providers = z.array(providerIdSchema).max(providerIdSchema.options.length).safeParse(saved.providers)
  const highestEffort = dynamicEffortSchema.safeParse(saved.highestEffort)
  const workersAtOnce = workersAtOnceSchema.safeParse(saved.workersAtOnce)
  return { ...providers.success ? { providers: [...new Set(providers.data)] } : {},
    highestEffort: highestEffort.success ? highestEffort.data : DEFAULT_HIGHEST_EFFORT,
    workersAtOnce: workersAtOnce.success ? workersAtOnce.data : DEFAULT_WORKERS_AT_ONCE }
}

/** What can hold the mark: a project's thread of this computer, on an overseer's provider, that no thread delegated to. */
type DynamicThreadFacts = Pick<AgentThread, 'providerId' | 'kind' | 'delegatedBy' | 'remoteHost' | 'archivedAt'>

/** Why a thread cannot be turned Dynamic, in plain words, or undefined where it can. */
export function whyNotDynamic(thread: DynamicThreadFacts): string | undefined {
  if (thread.archivedAt) return 'An archived thread cannot change. Nothing changed.'
  if ((thread.kind ?? 'project') !== 'project') return 'Only a thread in a project can be Dynamic. Nothing changed.'
  if (thread.remoteHost) return 'A thread on another machine cannot be Dynamic yet. Nothing changed.'
  if (thread.delegatedBy !== undefined) return 'A thread another thread started cannot be Dynamic. Nothing changed.'
  if (!thread.providerId || !DYNAMIC_OVERSEERS.has(thread.providerId)) return 'Only a Claude Code or Codex thread can be Dynamic for now. Nothing changed.'
  return undefined
}

/**
 * Whether a thread runs as a Dynamic thread now: the mark, on a thread that can hold it, while the Owl feature is on. A
 * mark left on a thread that moved to another provider before its first send, or read where the feature is off, stays
 * whole and does nothing.
 */
export function isDynamicThread(thread: DynamicThreadFacts & Pick<AgentThread, 'dynamic'>, enabled: boolean): boolean {
  return enabled && thread.dynamic === true && whyNotDynamic(thread) === undefined
}
