import { useMemo, useSyncExternalStore } from 'react'
import { isUnsentThread } from '../../../shared/threadActivity'
import { firstMessageTitle, THREAD_TITLE_MAX_CHARACTERS } from '../../../shared/threadTitle'
import type { ThreadRow } from './threadFacts'
import { hasDraftContent, type ComposerDraft, type ThreadDraftStore } from './threadDraftStore'

export { isUnsentThread }

/** Enough of a draft for its title, so a long paste is not reread on every keystroke. */
const TITLE_SOURCE_CHARACTERS = 4 * THREAD_TITLE_MAX_CHARACTERS

/** What the sidebar calls an unsent thread: what its first message would name it, or null while there are no words. */
export function unsentTitle(text: string): string | null {
  return firstMessageTitle(text.slice(0, TITLE_SOURCE_CHARACTERS))
}

/** What an unsent thread holds: its composer's draft, and the text of a prompt sent from it that main has not shown yet. */
export interface UnsentContent {
  readonly draft: ComposerDraft
  readonly submitted: string | undefined
}

/**
 * The rows the sidebar lists: an unsent thread appears only once something is typed or attached in its composer, under
 * the first line typed, and stays from the press of Send on, so opening New thread and walking away leaves nothing
 * behind while a prompt that failed to send can still be found.
 */
export function listedRows(rows: readonly ThreadRow[], content: (threadId: string) => UnsentContent): readonly ThreadRow[] {
  let changed = false
  const listed: ThreadRow[] = []
  for (const row of rows) {
    if (row.settledBy !== null || !isUnsentThread(row.thread)) { listed.push(row); continue }
    changed = true
    const { draft, submitted } = content(row.thread.id)
    if (!hasDraftContent(draft) && submitted === undefined) continue
    const title = unsentTitle(draft.text) ?? unsentTitle(submitted ?? '')
    listed.push(title === null ? row : { ...row, thread: { ...row.thread, title } })
  }
  return changed ? listed : rows
}

const noSubscription = (): (() => void) => () => {}
const NO_CONTENT: UnsentContent = { draft: { draftId: '', text: '', attachments: [], skills: [], files: [], requestId: null }, submitted: undefined }

function unsentContent(store: ThreadDraftStore | undefined, threadId: string): UnsentContent {
  if (store === undefined) return NO_CONTENT
  const submitted = store.submissions().findLast(item => item.threadId === threadId)
  return { draft: store.draft(threadId), submitted: submitted === undefined ? undefined : submitted.text }
}

/** `listedRows` kept current with every thread's draft. Re-lists only when an unsent thread's listing changes. */
export function useListedRows(store: ThreadDraftStore | undefined, rows: readonly ThreadRow[]): readonly ThreadRow[] {
  const key = useSyncExternalStore(store?.subscribe ?? noSubscription, () => listedRows(rows.filter(row => row.settledBy === null && isUnsentThread(row.thread)),
    threadId => unsentContent(store, threadId)).map(row => `${row.thread.id}\u0000${row.thread.title}`).join('\u0001'))
  // `key` stands for every draft the listing reads.
  return useMemo(() => listedRows(rows, threadId => unsentContent(store, threadId)), [rows, store, key])
}
