import React, { useId, type ReactNode } from 'react'
import { openAtRequestLabel, threadPress, waitKind, type OpenThread, type OverviewEntry, type WaitKind } from './WatcherOverview'

/** How many names the line holds before the rest are counted: more than this and it would stop being one quiet line. */
const NAMES = 5
const WHY: Record<WaitKind, string> = { question: 'question', permission: 'permission', failed: 'last turn failed' }

/**
 * One quiet line under Watcher's header naming each thread that needs the user and why: a question, a permission or a
 * failed turn (Zach's pick on October 11, 2026). Each name opens that thread beside Watcher at what it waits on, or with
 * Shift in the Threads room. Past five names the rest are counted, and the count opens All threads. Gone when nothing
 * waits. Narrow windows drop the reasons and keep the names.
 */
export function WatcherGlance({ entries, onOpen, onShowAll }: {
  readonly entries: readonly OverviewEntry[]
  readonly onOpen: OpenThread
  readonly onShowAll: () => void
}): ReactNode {
  const heading = useId()
  if (entries.length === 0) return null
  const named = entries.slice(0, NAMES)
  const more = entries.length - named.length
  return <section className="watcher-glance" aria-labelledby={heading}>
    <h2 className="watcher-glance__lead" id={heading}>{entries.length} need{entries.length === 1 ? 's' : ''} you</h2>
    <ul className="watcher-glance__names">
      {named.map(entry => {
        const thread = entry.overview.thread
        const kind = waitKind(entry)
        return <li key={thread.id}>
          <span className="watcher-row__ring" data-tone={kind === 'failed' ? 'failed' : 'needs'} aria-hidden="true" />
          <button type="button" className="watcher-glance__name tt-focusable" aria-label={openAtRequestLabel(thread.title, kind)} title={thread.title}
            {...threadPress(onOpen, thread.id, true)}><span>{thread.title}</span></button>
          <span className="watcher-glance__why" aria-hidden="true">{WHY[kind]}</span>
        </li>
      })}
      {more > 0 ? <li><button type="button" className="watcher-glance__name tt-focusable" aria-label={`${more} more need you. Show all threads`} onClick={onShowAll}>{more} more</button></li> : null}
    </ul>
  </section>
}
