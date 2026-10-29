import { z } from 'zod'
import { watcherThreadTargetSchema } from './watcher'

/** How long news that needs an answer at once waits for more: a question, a permission request or a failure. */
export const WATCHER_BATCH_MS = 2_000
export const WATCHER_BATCH_MAX_MS = 5_000
/**
 * How long ordinary news waits for more (#1190): a turn's end, work settled, a pull request's change and quiet. It goes
 * this long after the last of it, and never later than WATCHER_ORDINARY_BATCH_MAX_MS after the first, so news that comes
 * close together reaches Watcher as one wake-up.
 */
export const WATCHER_ORDINARY_BATCH_MS = 20_000
export const WATCHER_ORDINARY_BATCH_MAX_MS = 60_000
/** The kinds that keep the short batch: the user's answer, a failure or a send that may not have gone. */
export const WATCHER_URGENT_KINDS: ReadonlySet<string> = new Set(['needs-user', 'turn-failed', 'taken-over', 'delivery-changed'])
/** How much of a finished turn's reply its news carries (#1190), so Watcher need not read the thread for it. */
export const WATCHER_NEWS_REPLY_CHARS = 500
export const WATCHER_NEWS_BYTES_MAX = 16 * 1_024
export const WATCHER_NEWS_TARGETS_MAX = 50

/**
 * Text-free observed identities. A request reference is the thread's own request: the user answers it on that thread's
 * card, which Watcher's pane shows under the wake-up's reply as well (ADR-0073), and never through Watcher.
 * `work-settled` comes once per turn that finished with background work or monitoring still running, when that reaches zero.
 * `delegatedThreadId` names the thread a watched thread delegated to whose request card this is: Watcher watches the
 * delegating thread, and hears of the card as that thread's news (#1190). `prototype-ready` comes once for each prototype
 * waiting for the user's review (ADR-0108), named by its question (`requestCardId`) or by the reply that named its page
 * (`messageId`); like all news it answers and approves nothing. `request-closed` and `prototype-closed` come once when a card or
 * prototype Watcher was told of no longer waits on the user (October 24, 2026), with `answeredByUser` when Sotto saw the
 * user answer that card. They carry none of the answer, and approve nothing. `threads-restarted` comes once for each thread
 * Sotto restarted when the usage limit that stopped it reset (ADR-0144), `restartedBy` naming that provider, watched or not:
 * a thread no request watches carries `WATCHER_UNWATCHED_REQUEST_ID`, which no request has. It approves nothing either.
 * `thread-moved` comes once for each move the user made of a thread to another machine (#1178) as it ends, watched or not:
 * `moveOutcome` says whether it moved (`movedTo` continues it on `machine` and this one is settled), stayed here after the
 * new thread's first turn did not finish, or was given back before any thread was made there. Sotto runs moves, not Watcher.
 */
export const watcherEventSchema = z.object({
  id: z.string().max(512), kind: z.enum(['turn-finished', 'needs-user', 'turn-failed', 'quiet', 'taken-over', 'delivery-changed', 'evidence-changed', 'work-settled', 'prototype-ready',
    'request-closed', 'prototype-closed', 'threads-restarted', 'thread-moved']),
  requestId: z.uuid(), target: watcherThreadTargetSchema, generation: z.number().int().nonnegative(),
  observedAt: z.iso.datetime(), turnId: z.string().max(512).optional(), messageId: z.string().max(512).optional(),
  requestCardId: z.string().max(512).optional(), requestCardKind: z.enum(['question', 'permission']).optional(),
  revision: z.string().max(512).optional(), operationId: z.uuid().optional(),
  backgroundWorkCount: z.number().int().nonnegative().optional(), evidenceIds: z.array(z.string().max(512)).max(100).optional(),
  delegatedThreadId: z.string().max(512).optional(), answeredByUser: z.literal(true).optional(),
  restartedBy: z.string().min(1).max(64).optional(),
  moveId: z.uuid().optional(), movedTo: watcherThreadTargetSchema.optional(), moveOutcome: z.enum(['moved', 'stayed', 'given-back']).optional(), machine: z.string().min(1).max(200).optional(),
}).strict()
/** The request a `threads-restarted` event names for a thread no request watches: the nil UUID, which no request has. */
export const WATCHER_UNWATCHED_REQUEST_ID = '00000000-0000-0000-0000-000000000000'
export const watcherNewsSchema = z.object({ source: z.literal('watcher'), watcher: watcherThreadTargetSchema,
  events: z.array(watcherEventSchema).max(400), omitted: z.number().int().nonnegative().default(0) }).strict()
export type WatcherEvent = z.infer<typeof watcherEventSchema>
export type WatcherNews = z.infer<typeof watcherNewsSchema>
