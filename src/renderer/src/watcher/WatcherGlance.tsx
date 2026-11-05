import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { openAtRequestLabel, threadPress, waitKind, type OpenThread, type OverviewEntry, type WaitKind } from './WatcherOverview'

/** How many requests the open list names before the rest are counted. */
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
 * The needs-you count opens a list of requests (Drake's pick B, November 5, 2026). Each row keeps its reason visible,
 * including in narrow rooms. Each name opens that thread beside Watcher at what it waits on, or with
 * Shift in the Threads room. A name whose request has its card in Watcher's conversation goes to that card instead and
 * focuses it (Zach's pick on October 19, 2026), and opens the thread as before when the card is no longer there. Past
 * five names the rest are counted, and the count opens All threads. Gone when nothing waits.
 */
export function WatcherGlance({ entries, onOpen, onShowAll, inline, onJump, allThreadsOpen }: {
  readonly entries: readonly OverviewEntry[]
  readonly onOpen: OpenThread
  /** Opens All threads; `from` is the count that was pressed, for focus to come back to. */
  readonly onShowAll: (from: HTMLElement) => void
  /** Keep the remaining count available for return focus while All threads is over its list. */
  readonly allThreadsOpen: boolean
  /** The threads whose waiting request has its card in Watcher's conversation now. */
  readonly inline?: ReadonlySet<string> | undefined
  /** Brings a thread's card in the conversation into view and focuses it; false when it is not there. */
  readonly onJump?: ((threadId: string, requestId: string | undefined) => boolean) | undefined
}): ReactNode {
  const heading = useId()
  const list = useId()
  const { t } = useLingui()
  const [open, setOpen] = useState(false)
  const section = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { if (open) panel.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [open])
  useEffect(() => {
    if (!open || allThreadsOpen) return
    const outside = (event: Event): void => {
      if (event.target instanceof Node && !section.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside) }
  }, [open, allThreadsOpen])
  if (entries.length === 0) return null
  const named = entries.slice(0, NAMES)
  const more = entries.length - named.length
  const waiting = entries.length
  return <section ref={section} className="watcher-glance" aria-labelledby={heading} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus()
    }
  }}>
    <button ref={trigger} type="button" className="watcher-glance__lead tt-focusable" id={heading} aria-expanded={open} aria-controls={open ? list : undefined} aria-haspopup="dialog"
      aria-label={open ? t`Hide threads that need you` : plural(waiting, { one: 'Show # thread that needs you', other: 'Show # threads that need you' })}
      onClick={() => setOpen(value => !value)}><Plural value={waiting} one="# needs you" other="# need you" /><span className="watcher-glance__chevron" aria-hidden="true" /></button>
    {open ? <div ref={panel} className="watcher-glance__panel" id={list} role="dialog" aria-label={t`Threads that need you`}>
    <ul className="watcher-glance__names">
      {named.map(entry => {
        const thread = entry.overview.thread
        const kind = waitKind(entry)
        const press = threadPress((id, how) => {
          onOpen(id, { ...how, from: trigger.current })
          setOpen(false)
        }, thread.id, true)
        const here = (kind === 'question' || kind === 'permission') && onJump !== undefined && inline?.has(thread.id) === true
        const requestId = entry.facts.request?.requestId ?? thread.requests[0]?.id
        return <li key={thread.id}>
          <button type="button" className="watcher-glance__name tt-focusable" aria-label={here ? goToAskLabel(thread.title, kind) : openAtRequestLabel(thread.title, kind)} title={thread.title}
            onClick={event => { if (!(here && !event.shiftKey && onJump?.(thread.id, requestId) === true)) press.onClick(event); setOpen(false) }} onKeyDown={press.onKeyDown}>
            <span className="watcher-row__ring" data-tone={kind === 'failed' ? 'failed' : kind === 'prototype' ? 'prototype' : 'needs'} aria-hidden="true" />
            <span className="watcher-glance__title">{thread.title}</span>
            <span className="watcher-glance__why" aria-hidden="true">{i18n._(WHY[kind])}</span>
          </button>
        </li>
      })}
      {more > 0 ? <li><button type="button" className="watcher-glance__more tt-focusable" aria-label={t`${more} more need you. Show all threads`} onClick={event => onShowAll(event.currentTarget)}><Trans>{more} more</Trans></button></li> : null}
    </ul>
    </div> : null}
  </section>
}
