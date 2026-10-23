import { useCallback, useSyncExternalStore } from 'react'
import type { WatchActions } from './watcherRoom'
import type { SubmissionMode } from '../agents/threadDraftStore'

/**
 * Watch on a new thread's composer: the threads, by this window's ID, whose first send the user asked to put under a
 * standing watch. Nothing reaches main until that send does; then the watch is the same Watch the pane header gives.
 */
const wanted = new Set<string>()
const listeners = new Set<() => void>()
const changed = (): void => { for (const listener of listeners) listener() }

export const watchOnSend = {
  has: (threadId: string): boolean => wanted.has(threadId),
  set(threadId: string, on: boolean): void {
    if (wanted.has(threadId) === on) return
    if (on) wanted.add(threadId); else wanted.delete(threadId)
    changed()
  },
  /** Whether the thread was asked for, forgetting it. */
  take(threadId: string): boolean {
    if (!wanted.delete(threadId)) return false
    changed(); return true
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  /** For tests. */
  clear(): void { if (wanted.size === 0) return; wanted.clear(); changed() },
}

/** Whether the user pressed Watch on this thread's composer and its first send has not gone yet. */
export function useWatchOnSend(threadId: string): boolean {
  const read = useCallback(() => wanted.has(threadId), [threadId])
  return useSyncExternalStore(watchOnSend.subscribe, read)
}

/**
 * After a send: once main accepted it, the standing watch the user asked for on the composer, through the same Watch as
 * the pane header, whose toast says it happened. A refused send keeps the request for the next one. An unconfirmed send
 * (`null`) may have started the thread and taken the chip away, so the request is dropped rather than left to fire,
 * unseen, on some later send; the pane header's Watch is still there. Only the thread's first send counts (`first`, read
 * before it went), never a queue or a steer; a later send, or one made while Watch is unavailable, drops the request too.
 */
export function watchAfterSend(threadId: string, sent: boolean | null, mode: SubmissionMode, first: boolean, actions: WatchActions | null): void {
  if (mode !== 'send' || sent === false || !watchOnSend.take(threadId)) return
  if (sent && first && actions !== null) void actions.setThread(threadId, true)
}
