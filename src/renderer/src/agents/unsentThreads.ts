import { useMemo, useSyncExternalStore } from 'react'
import type { AgentThread } from '../../../shared/agents'
import type { ThreadRow } from './threadFacts'
import type { ThreadDraftStore } from './threadDraftStore'

const TITLE_LENGTH = 80

/** A thread opened and never sent to: on its default title, at rest, with nothing in its transcript. */
export function isUnsentThread(thread: AgentThread): boolean {
  return thread.titleSource === 'default' && thread.status === 'idle' && (thread.summary?.messageCount ?? thread.messages.length) === 0
}

/** What the sidebar calls an unsent thread: the first line of its draft, or null while the composer is empty. */
export function unsentTitle(text: string): string | null {
  const line = text.split('\n').map(item => item.trim()).find(item => item !== '')
  if (line === undefined) return null
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line
}

/**
 * The rows the sidebar lists: an unsent thread appears only once something is typed in its composer, under what was
 * typed, so opening New thread and walking away leaves nothing behind.
 */
export function listedRows(rows: readonly ThreadRow[], draftText: (threadId: string) => string): readonly ThreadRow[] {
  let changed = false
  const listed: ThreadRow[] = []
  for (const row of rows) {
    if (!isUnsentThread(row.thread)) { listed.push(row); continue }
    changed = true
    const title = unsentTitle(draftText(row.thread.id))
    if (title !== null) listed.push({ ...row, thread: { ...row.thread, title } })
  }
  return changed ? listed : rows
}

const noSubscription = (): (() => void) => () => {}

/** `listedRows` kept current with every thread's draft. Re-lists only when an unsent thread's title changes. */
export function useListedRows(store: ThreadDraftStore | undefined, rows: readonly ThreadRow[]): readonly ThreadRow[] {
  const key = useSyncExternalStore(store?.subscribe ?? noSubscription, () => store === undefined ? '' : rows.filter(row => isUnsentThread(row.thread))
    .map(row => `${row.thread.id}\u0000${unsentTitle(store.draft(row.thread.id).text) ?? ''}`).join('\u0001'))
  // `key` stands for every draft the listing reads.
  return useMemo(() => listedRows(rows, threadId => store?.draft(threadId).text ?? ''), [rows, store, key])
}
