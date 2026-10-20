import { z } from 'zod'

/** How many asks one wake-up keeps: one per watched thread's request, and Watcher's news names at most fifty threads. */
export const WATCHER_ASKS_MAX = 50

/**
 * One request a Watcher wake-up told Watcher was waiting on the user (ADR-0073, answering in Watcher's conversation):
 * which thread, by its owning host's address, which of its requests, and whether that is a question or a permission.
 * Text-free: no words of the request, the thread or the answer. Its own file, apart from `watcher.ts`, because messages
 * carry it and `agents.ts` cannot import Watcher's record.
 */
export const watcherAskSchema = z.object({
  target: z.object({ hostId: z.uuid(), threadId: z.string().min(1).max(512) }).strict(),
  requestCardId: z.string().min(1).max(512),
  kind: z.enum(['question', 'permission']),
}).strict()
export const watcherAsksSchema = z.array(watcherAskSchema).max(WATCHER_ASKS_MAX)
export type WatcherAsk = z.infer<typeof watcherAskSchema>

/** The same request of the same thread, whichever wake-up named it. */
export const watcherAskKey = (ask: Pick<WatcherAsk, 'target' | 'requestCardId'>): string =>
  JSON.stringify([ask.target.hostId, ask.target.threadId, ask.requestCardId])

/**
 * The asks in a list of Watcher's events: each needs-user event's thread and request, once each, in the order the news
 * named them, at most WATCHER_ASKS_MAX. Events that name no request are not asks.
 */
export function watcherAsksOf(events: readonly { readonly kind: string; readonly target: WatcherAsk['target']; readonly requestCardId?: string | undefined
  readonly requestCardKind?: WatcherAsk['kind'] | undefined }[]): WatcherAsk[] {
  const asks = new Map<string, WatcherAsk>()
  for (const event of events) {
    if (event.kind !== 'needs-user' || !event.requestCardId || !event.requestCardKind || asks.size >= WATCHER_ASKS_MAX) continue
    const ask = watcherAskSchema.safeParse({ target: { hostId: event.target.hostId, threadId: event.target.threadId }, requestCardId: event.requestCardId, kind: event.requestCardKind })
    if (ask.success && !asks.has(watcherAskKey(ask.data))) asks.set(watcherAskKey(ask.data), ask.data)
  }
  return [...asks.values()]
}
