import React, { useId, type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { openAtRequestLabel, threadPress, waitKind, type OpenThread, type OverviewEntry, type WaitKind } from './WatcherOverview'

/** How many names the line holds before the rest are counted: more than this and it would stop being one quiet line. */
const NAMES = 5
const WHY = {
  question: msg({ message: 'question', comment: 'Why a thread needs the user, after its name' }),
  permission: msg({ message: 'permission', comment: 'Why a thread needs the user, after its name' }),
  failed: msg`last turn failed`,
  prototype: msg`prototype to review`,
} as const satisfies Record<WaitKind, unknown>

/** What a press on a name does when the thread's request has its card in Watcher's conversation. */
export const goToAskLabel = (title: string, kind: 'question' | 'permission'): string => kind === 'question'
  ? i18n._(msg`Go to the question from ${title} in this conversation`)
  : i18n._(msg`Go to the permission from ${title} in this conversation`)

/**
 * One quiet line under Watcher's header naming each thread that needs the user and why: a question, a permission or a
 * failed turn (Zach's pick on October 11, 2026). Each name opens that thread beside Watcher at what it waits on, or with
 * Shift in the Threads room. A name whose request has its card in Watcher's conversation goes to that card instead and
 * focuses it (Zach's pick on October 19, 2026), and opens the thread as before when the card is no longer there. Past
 * five names the rest are counted, and the count opens All threads. Gone when nothing waits. Narrow windows drop the
 * reasons and keep the names.
 */
export function WatcherGlance({ entries, onOpen, onShowAll, inline, onJump }: {
  readonly entries: readonly OverviewEntry[]
  readonly onOpen: OpenThread
  /** Opens All threads; `from` is the count that was pressed, for focus to come back to. */
  readonly onShowAll: (from: HTMLElement) => void
  /** The threads whose waiting request has its card in Watcher's conversation now. */
  readonly inline?: ReadonlySet<string> | undefined
  /** Brings a thread's card in the conversation into view and focuses it; false when it is not there. */
  readonly onJump?: ((threadId: string, requestId: string | undefined) => boolean) | undefined
}): ReactNode {
  const heading = useId()
  const { t } = useLingui()
  if (entries.length === 0) return null
  const named = entries.slice(0, NAMES)
  const more = entries.length - named.length
  const waiting = entries.length
  return <section className="watcher-glance" aria-labelledby={heading}>
    <h2 className="watcher-glance__lead" id={heading}><Plural value={waiting} one="# needs you" other="# need you" /></h2>
    <ul className="watcher-glance__names">
      {named.map(entry => {
        const thread = entry.overview.thread
        const kind = waitKind(entry)
        const press = threadPress(onOpen, thread.id, true)
        const here = (kind === 'question' || kind === 'permission') && onJump !== undefined && inline?.has(thread.id) === true
        const requestId = entry.facts.request?.requestId ?? thread.requests[0]?.id
        return <li key={thread.id}>
          <span className="watcher-row__ring" data-tone={kind === 'failed' ? 'failed' : kind === 'prototype' ? 'prototype' : 'needs'} aria-hidden="true" />
          <button type="button" className="watcher-glance__name tt-focusable" aria-label={here ? goToAskLabel(thread.title, kind) : openAtRequestLabel(thread.title, kind)} title={thread.title}
            onClick={event => { if (here && !event.shiftKey && onJump?.(thread.id, requestId) === true) return; press.onClick(event) }} onKeyDown={press.onKeyDown}><span>{thread.title}</span></button>
          <span className="watcher-glance__why" aria-hidden="true">{i18n._(WHY[kind])}</span>
        </li>
      })}
      {more > 0 ? <li><button type="button" className="watcher-glance__name tt-focusable" aria-label={t`${more} more need you. Show all threads`} onClick={event => onShowAll(event.currentTarget)}><Trans>{more} more</Trans></button></li> : null}
    </ul>
  </section>
}
