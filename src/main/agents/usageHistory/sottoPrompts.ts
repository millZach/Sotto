import type { DatabaseSync } from 'node:sqlite'

/** One stored user message as Usage may read it: identities, its instant and whether babysitting sent it. No words. */
export interface StoredUserMessageInstant {
  readonly threadId: string
  readonly messageId: string
  readonly at: string
  readonly wakeUp: boolean
}

/** The thread store's text-free view of its user messages, for prompts sent before Usage began counting. */
export interface UserMessageInstantSource {
  visitUserMessageInstants(visitor: (message: StoredUserMessageInstant) => void, before?: string): void
}

/**
 * Reads the thread store's user messages created before `before` (ADR-0083). The query names only identity columns,
 * the instant and the wake-up mark, so no message text is read out of the database.
 */
export function visitUserMessageInstants(db: DatabaseSync, visitor: (message: StoredUserMessageInstant) => void, before?: string): void {
  const limit = before === undefined ? Number.POSITIVE_INFINITY : Date.parse(before)
  if (Number.isNaN(limit)) return
  const rows = db.prepare(`SELECT m.thread_id AS thread_id, m.message_id AS message_id, m.created_at AS created_at,
      EXISTS (SELECT 1 FROM wake_ups w WHERE w.thread_id = m.thread_id AND w.message_id = m.message_id) AS wake_up
    FROM messages m WHERE m.role = 'user' ORDER BY m.thread_id, m.position`).all()
  for (const row of rows) {
    const at = typeof row.created_at === 'string' ? Date.parse(row.created_at) : Number.NaN
    if (!Number.isFinite(at) || at >= limit) continue
    visitor({ threadId: String(row.thread_id), messageId: String(row.message_id), at: new Date(at).toISOString(), wakeUp: Number(row.wake_up) === 1 })
  }
}
