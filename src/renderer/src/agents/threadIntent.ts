import type { CarriedDraft } from './EmptyWorkspace'

/**
 * A New thread asked for in the sidebar beside another page, or by a surface outside the Threads page (an activity
 * recording's Attach to a thread, ADR-0097). The press leads to the Threads page, and the page opens the new thread
 * when it arrives, with the draft when one is carried; the intent is taken once and never kept.
 */
export interface NewThreadIntent {
  readonly projectId?: string | undefined
  /** Text the new thread's composer opens with, unsent. */
  readonly carried?: CarriedDraft | undefined
}

let pending: NewThreadIntent | null = null
const listeners = new Set<() => void>()

export function setNewThreadIntent(intent: NewThreadIntent): void {
  pending = intent
  // A Threads page already on screen takes it now; otherwise the page takes it when it mounts.
  for (const listener of listeners) listener()
}

export function takeNewThreadIntent(): NewThreadIntent | null {
  const taken = pending
  pending = null
  return taken
}

/** The Threads page listens while it is mounted, so an intent set while it is already open is not left waiting. */
export function onNewThreadIntent(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
