import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import { i18n } from '@lingui/core'
import { plural, t as tNow } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { AGENT_DISMISS_FAILURES_MAX, type AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useWatcherEnabled } from '../state/watcherFeature'
import type { AgentConnection } from './AgentContext'
import type { PaneActions } from './ThreadSidebar'
import { unseenFailures, type NeedsYouEntry, type NeedsYouQueue as NeedsYouFact } from './threadFacts'
import { openBesidePressed } from './threadShortcuts'
import { AgentRequestCard } from './requests/AgentRequestCard'
import { messageLinks } from './requests/messageLinks'
import { threadRequestBlocked, threadRequestCheck, threadRequestOwner, threadRequestSubmit } from './requests/threadRequests'
import { shownCount } from '../state/interfaceNumbers'

type Command = AgentConnection['command']
type Failures = ReturnType<typeof unseenFailures>

/** The search field above the queue: where the focus lands when the entry that held it leaves with nowhere next. */
function searchField(root: HTMLElement | null): HTMLInputElement | null | undefined {
  return root?.closest('.thread-nav')?.querySelector<HTMLInputElement>('.threads-search input')
}

/** The failure an entry's row showed, named as `dismiss-failures` takes it. */
export function entryFailure(entry: NeedsYouEntry): Failures[number] {
  return { threadId: entry.row.thread.id, failure: entry.row.thread.failureId ?? '' }
}

/**
 * Needs you (ADR-0135): under the search, one entry per thread that needs the user, blocking first, three standing
 * and the rest counted. An entry says only what its thread needs and offers one press for it: its own request's
 * card, popped open over the sidebar, or its failure's Dismiss; a wait below it opens the thread. At none, nothing.
 */
export function NeedsYouQueue({ queue, state, command, failures, panes, onOpen }: {
  readonly queue: NeedsYouFact
  readonly state: AgentState
  readonly command: Command
  readonly failures: Failures
  readonly panes: PaneActions
  readonly onOpen: (threadId: string) => void
}): ReactNode {
  const { t } = useLingui()
  const [expanded, setExpanded] = useState(false)
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(new Set())
  /** The thread whose card stands popped open over the sidebar, if any. */
  const [popped, setPopped] = useState<string | null>(null)
  const card = useRef<HTMLElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  /** The entry holding the focus and where it stood, so its leaving can hand the focus to the entry after it. */
  const focusedEntry = useRef<{ readonly id: string; readonly index: number } | undefined>(undefined)
  const shown = expanded ? queue.entries : queue.shown
  const shownIds = queue.shown.map(entry => entry.row.thread.id).join('\0') + (expanded ? '\0expanded' : '')
  // An entry leaves with the focus in it — settled here, answered in its card or its pane, answered on another client:
  // the entry that took its place takes the focus, or the foot's toggle, or the search field (ADR-0135). A focus the
  // user has since moved out of the card is left where it is.
  useLayoutEffect(() => {
    const focused = focusedEntry.current
    if (!focused || shown.some(entry => entry.row.thread.id === focused.id)) return
    focusedEntry.current = undefined
    const active = document.activeElement
    if (active !== null && active !== document.body && !(card.current?.contains(active))) return
    const next = shown[Math.min(focused.index, shown.length - 1)]
    const control = next ? [...(card.current?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? [])]
      .find(item => item.dataset.entryId === next.row.thread.id)?.querySelector<HTMLElement>('button') : undefined
    ;(control ?? toggle.current ?? searchField(card.current))?.focus()
    // Entries coming and going are the cue; `shown` itself is re-read on each such change.
  }, [shownIds])
  // A card whose entry has left (answered, settled, folded away) stays closed if the entry comes back.
  useEffect(() => {
    if (popped !== null && !shown.some(entry => entry.row.thread.id === popped && entry.action !== 'open')) setPopped(null)
  })
  if (queue.entries.length === 0) return null
  const open = (entry: NeedsYouEntry, beside: boolean): void => {
    setPopped(null)
    if (beside && panes.currentThreadId !== null && panes.currentThreadId !== entry.row.thread.id) panes.onOpenBeside(entry.row.thread.id)
    else onOpen(entry.row.thread.id)
  }
  const dismiss = (named: Failures, together = false): void => {
    const ids = named.map(item => item.threadId)
    if (ids.some(id => dismissing.has(id))) return
    // The foot's own button goes with the failures it dismisses; the search field is found while it still stands.
    const search = together ? searchField(card.current) : undefined
    setDismissing(new Set([...dismissing, ...ids]))
    void command({ type: 'dismiss-failures', failures: named.slice(0, AGENT_DISMISS_FAILURES_MAX) }).then(result => {
      if (together && result !== null && !result.error) requestAnimationFrame(() => search?.focus())
    }).finally(() => setDismissing(current => new Set([...current].filter(id => !ids.includes(id)))))
  }
  const { approval, question, failed } = queue.overflow
  // Each kind is a whole phrase, joined the interface language's way.
  const overflowKinds = new Intl.ListFormat(i18n.locale, { type: 'unit', style: 'short' }).format([
    approval ? plural(approval, { one: `${{ approvals: shownCount(approval) }} approval`, other: `${{ approvals: shownCount(approval) }} approvals` }) : '',
    question ? plural(question, { one: `${{ answers: shownCount(question) }} answer`, other: `${{ answers: shownCount(question) }} answers` }) : '',
    failed ? t({ message: `${{ failedCount: shownCount(failed) }} failed`, comment: 'How many threads whose last turn failed wait beyond those shown.' }) : '',
  ].filter(Boolean))
  const more = shownCount(queue.overflow.total), oldest = queue.oldestBlockingWait, failedThreads = failures.length, failedCount = shownCount(failedThreads)
  return <section ref={card} className="needs-you" aria-labelledby={headingId} onFocusCapture={event => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-entry-id]')
    if (item?.dataset.entryId) focusedEntry.current = { id: item.dataset.entryId, index: [...item.parentElement!.children].indexOf(item) }
  }} onKeyDown={event => {
    if (expanded && event.key === 'Escape') { event.preventDefault(); setExpanded(false); toggle.current?.focus() }
  }}>
    <div className="needs-you__head">
      <h2 id={headingId} className="needs-you__heading"><Trans comment="The heading over the threads that wait on the user.">Needs you</Trans></h2>
      <span className="needs-you__count">{shownCount(queue.entries.length)}</span>
      {oldest ? <span className="needs-you__oldest">{t({ message: `oldest ${oldest}`, comment: '{oldest} is how long the longest wait has lasted, such as 4 min.' })}</span> : null}
    </div>
    <ul className="needs-you__entries">
      {shown.map(entry => <NeedsYouEntryView key={entry.row.thread.id} entry={entry} state={state} command={command}
        dismissing={dismissing.has(entry.row.thread.id)} popped={popped === entry.row.thread.id}
        onPop={next => setPopped(next ? entry.row.thread.id : null)} onOpen={open} onDismiss={dismiss} panes={panes} />)}
    </ul>
    {queue.overflow.total > 0 || failures.length >= 2 ? <div className="needs-you__foot">
      {queue.overflow.total > 0 && !expanded ? <span className="needs-you__overflow">{t({ message: `+ ${more} more waiting (${overflowKinds})`, comment: '{more} is how many more threads wait; {overflowKinds} says what for, such as 2 approvals, 1 answer.' })}</span> : null}
      {queue.overflow.total > 0 ? <Button ref={toggle} variant="ghost" aria-expanded={expanded}
        aria-label={expanded ? t`Show fewer waiting threads` : t`Show all waiting threads`} onClick={() => setExpanded(value => !value)}>
        {expanded ? t`Show fewer` : t`Show all`}</Button> : null}
      {failures.length >= 2 ? <Button variant="ghost" aria-label={plural(failedThreads, { one: `Dismiss Needs attention on ${{ threads: failedCount }} thread`, other: `Dismiss Needs attention on ${{ threads: failedCount }} threads` })}
        aria-disabled={failures.some(item => dismissing.has(item.threadId)) || undefined}
        onClick={() => dismiss(failures, true)}>{t({ message: `Dismiss ${failedCount} failed`, comment: '{failedCount} is how many threads whose last turn failed.' })}</Button> : null}
    </div> : null}
  </section>
}

type EntryProps = {
  readonly entry: NeedsYouEntry
  readonly state: AgentState
  readonly command: Command
  readonly dismissing: boolean
  readonly popped: boolean
  readonly panes: PaneActions
  readonly onPop: (popped: boolean) => void
  readonly onOpen: (entry: NeedsYouEntry, beside: boolean) => void
  readonly onDismiss: (named: Failures) => void
}

/** What a press on an entry's own button pops open, named for the button: the approval, the question, or why it failed. */
export function popWords(entry: NeedsYouEntry): { readonly label: string; readonly name: string } {
  const title = entry.row.thread.title
  if (entry.kind === 'failed') return { label: tNow({ message: 'Show why', comment: 'Shows why a thread\'s last turn failed.' }), name: tNow`Show why ${title} needs attention` }
  return { label: tNow`Open to answer`, name: entry.kind === 'approval' ? tNow`Open to answer the approval in ${title}` : tNow`Open to answer the question in ${title}` }
}

/**
 * One waiting thread: its title and wait, what it needs in the row's own words, and one press. The ask itself is not
 * drawn here (Zach, October 29, 2026): its own request and its failure pop open in a card over the sidebar, a failure
 * also offers Dismiss, and a wait in a delegated thread opens the thread it is reached from.
 */
function NeedsYouEntryView({ entry, state, command, dismissing, popped, panes, onPop, onOpen, onDismiss }: EntryProps): ReactNode {
  const { t } = useLingui()
  const { row } = entry
  const title = row.thread.title
  const besideAvailable = panes.currentThreadId !== null && panes.currentThreadId !== row.thread.id
  const settled = row.settledBy === 'thread' || row.settledBy === 'project'
  const waitingIn = row.waitingIn
  const item = useRef<HTMLLIElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const cardId = useId()
  const pops = entry.action !== 'open'
  const words = popWords(entry)
  const close = (focusTrigger: boolean): void => { onPop(false); if (focusTrigger) trigger.current?.focus() }
  return <li ref={item} className="needs-you__entry" data-kind={entry.kind} data-entry-id={row.thread.id}>
    <div className="needs-you__top">
      <span className="thread-nav__ring" data-state={row.state} data-waiting={row.waitingFor ?? undefined} data-disconnected={row.connected ? undefined : true} aria-hidden="true" />
      <button type="button" className="needs-you__title tt-focusable" aria-label={t`Open ${title}`} title={title}
        aria-keyshortcuts={besideAvailable ? panes.openBesideChord?.label.keys : undefined}
        onClick={event => onOpen(entry, event.ctrlKey || event.metaKey)}
        onKeyDown={event => { if (besideAvailable && panes.openBesideChord && openBesidePressed(event, panes.openBesideChord.chord, panes.openBesideChord.platform)) { event.preventDefault(); onOpen(entry, true) } }}>
        {title}
      </button>
      {entry.wait ? <span className="needs-you__wait">{entry.wait}</span> : null}
    </div>
    <div className="needs-you__need">
      <span className="needs-you__status">{row.stateLabel}</span>
      {waitingIn ? <span><Trans comment="{waitingIn} is where the thread waits, such as the name of the thread it delegated to.">Waiting in {waitingIn}</Trans></span> : null}
      {settled ? <span className="needs-you__tag">{t({ message: 'Settled', comment: 'A thread row\'s state: the thread or its project was put away.' })}</span> : null}
      <span className="needs-you__actions">
        {entry.action === 'dismiss' ? <Button variant="secondary" aria-label={t`Dismiss Needs attention on ${title}`}
          aria-disabled={dismissing || undefined} onClick={() => { if (!dismissing) onDismiss([entryFailure(entry)]) }}><Trans>Dismiss</Trans></Button> : null}
        {pops
          ? <Button ref={trigger} variant="secondary" aria-label={words.name} aria-haspopup="dialog" aria-expanded={popped} aria-controls={popped ? cardId : undefined}
            onClick={() => onPop(!popped)}>{words.label}</Button>
          : <Button variant="secondary" aria-label={entry.kind === 'failed' ? t`Open ${title}` : t`Open ${title} to answer`} onClick={() => onOpen(entry, false)}>
            {entry.kind === 'failed' ? t({ message: 'Open', comment: 'Opens the thread.' }) : t`Open to answer`}</Button>}
      </span>
    </div>
    {popped && pops ? <NeedsYouCard id={cardId} entry={entry} state={state} command={command} anchor={item} trigger={trigger} placement="below"
      dismissing={dismissing} onClose={close} onOpen={() => onOpen(entry, false)} onDismiss={() => onDismiss([entryFailure(entry)])} /> : null}
  </li>
}

/** Where a popped card stands: under its entry in the sidebar, or beside its tile on the collapsed rail. */
export type NeedsYouCardPlacement = 'below' | 'beside'

/**
 * A waiting thread's card, popped open over the sidebar without leaving the thread on screen: its own request through
 * the same request card, store and send as its pane (ADR-0135), or why its last turn failed with Dismiss. It answers
 * Escape and a press outside it; Open thread opens the thread where it waits.
 */
export function NeedsYouCard({ id, entry, state, command, anchor, trigger, placement, dismissing, onClose, onOpen, onDismiss }: {
  readonly id: string
  readonly entry: NeedsYouEntry
  readonly state: AgentState
  readonly command: Command
  /** What the card stands beside: the entry, or the rail's tile. */
  readonly anchor: RefObject<HTMLElement | null>
  /** The press that popped it, which a press on toggles it rather than counting as a press outside. */
  readonly trigger: RefObject<HTMLElement | null>
  readonly placement: NeedsYouCardPlacement
  readonly dismissing: boolean
  /** Closes the card; `focusTrigger` when the focus goes back to the press that opened it (Escape, Close). */
  readonly onClose: (focusTrigger: boolean) => void
  readonly onOpen: () => void
  readonly onDismiss: () => void
}): ReactNode {
  const { t } = useLingui()
  const watcherOn = useWatcherEnabled()
  const surface = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const { row, request } = entry
  const thread = row.thread
  const title = thread.title
  const settled = row.settledBy === 'thread' || row.settledBy === 'project'
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useLayoutEffect(() => {
    const card = surface.current
    if (!card) return
    card.showPopover?.()
    const place = (): void => {
      const box = anchor.current?.getBoundingClientRect()
      if (!box) return
      const width = card.offsetWidth, height = card.offsetHeight
      const left = placement === 'beside' ? box.right + 8 : box.left
      const below = box.bottom + 4, above = box.top - height - 4
      const top = placement === 'beside' ? box.top : below + height <= innerHeight - 12 ? below : above >= 12 ? above : below
      card.style.left = `${Math.max(12, Math.min(left, innerWidth - width - 12))}px`
      card.style.top = `${Math.max(12, Math.min(top, innerHeight - height - 12))}px`
    }
    // The card follows what it stands beside every frame it is open, as the effort card follows its chip: the sidebar
    // scrolls, entries above it come and go, and the card itself grows as an answer sends, none of which resizes the anchor.
    let frame = 0
    let placed = ''
    const follow = (): void => {
      frame = requestAnimationFrame(follow)
      const box = anchor.current?.getBoundingClientRect()
      if (!box) return
      const now = `${box.top} ${box.left} ${box.right} ${box.bottom} ${card.offsetHeight} ${card.offsetWidth} ${innerHeight} ${innerWidth}`
      if (now === placed) return
      placed = now
      place()
    }
    follow()
    card.focus()
    return () => { cancelAnimationFrame(frame); card.hidePopover?.() }
  }, [anchor, placement])
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!surface.current?.contains(target) && !trigger.current?.contains(target)) closeRef.current(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [trigger])
  const kind = [row.stateLabel, entry.wait, settled ? t({ message: 'Settled', comment: 'A thread row\'s state: the thread or its project was put away.' }) : ''].filter(Boolean).join(' · ')
  return <div ref={surface} id={id} className="needs-you-card" role="dialog" aria-labelledby={titleId} tabIndex={-1}
    popover={typeof HTMLElement.prototype.showPopover === 'function' ? 'manual' : undefined}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true) } }}
    onBlur={event => {
      const next = event.relatedTarget as Node | null
      if (next !== null && !event.currentTarget.contains(next) && !trigger.current?.contains(next)) onClose(false)
    }}>
    <div className="needs-you-card__head">
      <h3 id={titleId} className="needs-you-card__title">{title}</h3>
      <button type="button" className="needs-you-card__close tt-focusable" aria-label={t`Close`} title={t`Close`} onClick={() => onClose(true)}><X size={14} aria-hidden="true" /></button>
    </div>
    <p className="needs-you-card__kind">{kind}</p>
    {request !== undefined
      ? <AgentRequestCard ownerId={thread.id} ownerTitle={title} request={request} blocked={threadRequestBlocked(row, state)} draftOwner={threadRequestOwner(row, state)}
        messageLinks={request.kind === 'question' ? messageLinks(thread.messages) : []}
        onWriteAnswer={onOpen}
        onSubmit={threadRequestSubmit(command, thread, request, watcherOn)}
        onCheck={() => threadRequestCheck(command, thread.id)} />
      : <p className="needs-you-card__reason tt-paragraph">{thread.failureReason ?? t`The last turn failed.`}</p>}
    <div className="needs-you-card__foot">
      <Button variant="ghost" aria-label={t`Open ${title}`} onClick={onOpen}>{t({ message: 'Open thread', comment: 'Opens the thread a popped Needs you card belongs to.' })}</Button>
      {entry.action === 'dismiss' ? <Button variant="secondary" aria-label={t`Dismiss Needs attention on ${title}`}
        aria-disabled={dismissing || undefined} onClick={() => { if (!dismissing) onDismiss() }}><Trans>Dismiss</Trans></Button> : null}
    </div>
  </div>
}
