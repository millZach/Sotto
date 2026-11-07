import { z } from 'zod'

/**
 * Watcher's hold (ADR-0144, November 5, 2026 amendment, #2234): while Watcher's own provider is limited or failing, Sotto
 * holds the news it would wake Watcher with, so no wake runs a turn that fails, and Watcher's room shows one band instead
 * of one failed reply per wake. Held news goes to Watcher in one wake when the hold ends: at the limit's reset, at the
 * next try while failing, or when the user presses Try now. A message the user sends Watcher meanwhile waits in its
 * queue and goes first. Only while the Owl feature Restart stopped threads is on.
 */

/** How long a failing Watcher waits before Sotto tries it again with what it holds: "every few minutes". */
export const WATCHER_FAILING_RETRY_MS = 5 * 60_000

/** The longest error a band carries under Details, as a failure's reason is published (`failuresSeen.ts`). */
export const WATCHER_HOLD_DETAIL_MAX = 600

/**
 * The hold as the room shows it. `limited`: Watcher's last turn stopped at its provider's usage limit, which resets at
 * `resetsAt`, or said no time. `failing`: Watcher's last turn failed for any other reason. `since` is when Sotto first saw
 * it; `nextTryAt` is when a failing hold, or a limited one with no reset time, lets what it holds go. `held` counts the
 * news held, `pullRequests` how many of those are pull request news. `detail` is the failed turn's error as its provider
 * reported it, for Details only.
 */
export const watcherHoldSchema = z.object({
  kind: z.enum(['limited', 'failing']),
  provider: z.string().min(1).max(64),
  since: z.iso.datetime(),
  resetsAt: z.iso.datetime().optional(),
  nextTryAt: z.iso.datetime().optional(),
  lastTryAt: z.iso.datetime().optional(),
  tries: z.number().int().min(0).max(1_000_000),
  held: z.number().int().min(0).max(1_000_000),
  pullRequests: z.number().int().min(0).max(1_000_000),
  detail: z.string().max(WATCHER_HOLD_DETAIL_MAX).optional(),
}).strict()
export type WatcherHold = z.infer<typeof watcherHoldSchema>
