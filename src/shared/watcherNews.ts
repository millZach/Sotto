import { z } from 'zod'
import { watcherThreadTargetSchema } from './watcher'

export const WATCHER_BATCH_MS = 2_000
export const WATCHER_BATCH_MAX_MS = 5_000
export const WATCHER_NEWS_BYTES_MAX = 16 * 1_024
export const WATCHER_NEWS_TARGETS_MAX = 50

/**
 * Text-free observed identities. A request reference opens its owning thread, never an answer card here.
 * `work-settled` comes once per turn that finished with background work or monitoring still running, when that reaches zero.
 */
export const watcherEventSchema = z.object({
  id: z.string().max(512), kind: z.enum(['turn-finished', 'needs-user', 'turn-failed', 'quiet', 'taken-over', 'delivery-changed', 'evidence-changed', 'work-settled']),
  requestId: z.uuid(), target: watcherThreadTargetSchema, generation: z.number().int().nonnegative(),
  observedAt: z.iso.datetime(), turnId: z.string().max(512).optional(), messageId: z.string().max(512).optional(),
  requestCardId: z.string().max(512).optional(), requestCardKind: z.enum(['question', 'permission']).optional(),
  revision: z.string().max(512).optional(), operationId: z.uuid().optional(),
  backgroundWorkCount: z.number().int().nonnegative().optional(), evidenceIds: z.array(z.string().max(512)).max(100).optional(),
}).strict()
export const watcherNewsSchema = z.object({ source: z.literal('watcher'), watcher: watcherThreadTargetSchema,
  events: z.array(watcherEventSchema).max(400), omitted: z.number().int().nonnegative().default(0) }).strict()
export type WatcherEvent = z.infer<typeof watcherEventSchema>
export type WatcherNews = z.infer<typeof watcherNewsSchema>
