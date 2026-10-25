import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AGENT_DISMISS_FAILURES_MAX, type AgentState } from '../../../shared/agents'
import { requestDraftQuestions } from '../../../shared/requestDrafts'
import { Button } from '../components/Button'
import { useWatcherEnabled } from '../state/watcherFeature'
import type { AgentConnection } from './AgentContext'
import type { PaneActions } from './ThreadSidebar'
import { unseenFailures, type NeedsYouEntry, type NeedsYouQueue as NeedsYouFact } from './threadFacts'
import { openBesidePressed } from './threadShortcuts'
import {
  answerProgress, hasNoSendableChoice, isRequired, legacyPermissionAnswer, permissionAnswer, permissionSummary,
  requestAnswerOwnerKey, requestAnswerStore, structuredAnswer, useRequestEntry, type QuestionSelection,
} from './requests/requestAnswers'
import { threadRequestBlocked, threadRequestCheck, threadRequestOwner, threadRequestSubmit } from './requests/threadRequests'

type Command = AgentConnection['command']
type Failures = ReturnType<typeof unseenFailures>

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** The search field above the queue: where the focus lands when the entry that held it leaves with nowhere next. */
function searchField(root: HTMLElement | null): HTMLInputElement | null | undefined {
  return root?.closest('.thread-nav')?.querySelector<HTMLInputElement>('.threads-search input')
}

/**
 * Needs you (ADR-0135): under the search, one entry per thread that needs the user, blocking first, three standing
 * and the rest counted. An entry answers only an ask that fits here whole, through the same store and send as its
 * thread's card; everything else opens the thread. A failure dismisses by the name its row showed. At none, nothing.
 */
export function NeedsYouQueue({ queue, state, command, failures, panes, onOpen }: {
  readonly queue: NeedsYouFact
  readonly state: AgentState
  readonly command: Command
  readonly failures: Failures
  readonly panes: PaneActions
  readonly onOpen: (threadId: string) => void
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(new Set())
  const card = useRef<HTMLElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const headingId = useId()
  const watcherOn = useWatcherEnabled()
  /** The entry holding the focus and where it stood, so its leaving can hand the focus to the entry after it. */
  const focusedEntry = useRef<{ readonly id: string; readonly index: number } | undefined>(undefined)
  const shown = expanded ? queue.entries : queue.shown
  const shownIds = queue.shown.map(entry => entry.row.thread.id).join('\0') + (expanded ? '\0expanded' : '')
  // An entry leaves with the focus in it — settled here, answered in its pane, answered on another client: the
  // entry that took its place takes the focus, or the foot's toggle, or the search field (ADR-0135). A focus the
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
  if (queue.entries.length === 0) return null
  const open = (entry: NeedsYouEntry, beside: boolean): void => {
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
  const overflowKinds = [
    queue.overflow.approval ? `${queue.overflow.approval} approval${queue.overflow.approval === 1 ? '' : 's'}` : '',
    queue.overflow.question ? `${queue.overflow.question} answer${queue.overflow.question === 1 ? '' : 's'}` : '',
    queue.overflow.failed ? `${queue.overflow.failed} failed` : '',
  ].filter(Boolean).join(', ')
  return <section ref={card} className="needs-you" aria-labelledby={headingId} onFocusCapture={event => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-entry-id]')
    if (item?.dataset.entryId) focusedEntry.current = { id: item.dataset.entryId, index: [...item.parentElement!.children].indexOf(item) }
  }} onKeyDown={event => {
    if (expanded && event.key === 'Escape') { event.preventDefault(); setExpanded(false); toggle.current?.focus() }
  }}>
    <div className="needs-you__head">
      <h2 id={headingId} className="needs-you__heading">Needs you</h2>
      <span className="needs-you__count">{queue.entries.length}</span>
      {queue.oldestBlockingWait ? <span className="needs-you__oldest">oldest {queue.oldestBlockingWait}</span> : null}
    </div>
    <ul className="needs-you__entries">
      {shown.map(entry => <NeedsYouEntryView key={entry.row.thread.id} entry={entry} state={state} command={command}
        watcherOn={watcherOn} dismissing={dismissing.has(entry.row.thread.id)} onOpen={open} onDismiss={dismiss} panes={panes} />)}
    </ul>
    {queue.overflow.total > 0 || failures.length >= 2 ? <div className="needs-you__foot">
      {queue.overflow.total > 0 && !expanded ? <span className="needs-you__overflow">+ {queue.overflow.total} more waiting ({overflowKinds})</span> : null}
      {queue.overflow.total > 0 ? <Button ref={toggle} variant="ghost" aria-expanded={expanded}
        aria-label={expanded ? 'Show fewer waiting threads' : 'Show all waiting threads'} onClick={() => setExpanded(value => !value)}>
        {expanded ? 'Show fewer' : 'Show all'}</Button> : null}
      {failures.length >= 2 ? <Button variant="ghost" aria-label={`Dismiss Needs attention on ${plural(failures.length, 'thread')}`}
        aria-disabled={failures.some(item => dismissing.has(item.threadId)) || undefined}
        onClick={() => dismiss(failures, true)}>Dismiss {failures.length} failed</Button> : null}
    </div> : null}
  </section>
}

type EntryProps = {
  readonly entry: NeedsYouEntry
  readonly state: AgentState
  readonly command: Command
  readonly watcherOn: boolean
  readonly dismissing: boolean
  readonly panes: PaneActions
  readonly onOpen: (entry: NeedsYouEntry, beside: boolean) => void
  readonly onDismiss: (named: Failures) => void
}

function NeedsYouEntryView({ entry, state, command, watcherOn, dismissing, panes, onOpen, onDismiss }: EntryProps): ReactNode {
  const { row } = entry
  const title = row.thread.title
  const besideAvailable = panes.currentThreadId !== null && panes.currentThreadId !== row.thread.id
  const settled = row.settledBy === 'thread' || row.settledBy === 'project'
  const failureId = row.thread.failureId ?? ''
  return <li className="needs-you__entry" data-kind={entry.kind} data-entry-id={row.thread.id}>
    <div className="needs-you__top">
      <span className="thread-nav__ring" data-state={row.state} data-waiting={row.waitingFor ?? undefined} data-disconnected={row.connected ? undefined : true} aria-hidden="true" />
      <button type="button" className="needs-you__title tt-focusable" aria-label={`Open ${title}`} title={title}
        aria-keyshortcuts={besideAvailable ? panes.openBesideChord?.label.keys : undefined}
        onClick={event => onOpen(entry, event.ctrlKey || event.metaKey)}
        onKeyDown={event => { if (besideAvailable && panes.openBesideChord && openBesidePressed(event, panes.openBesideChord.chord, panes.openBesideChord.platform)) { event.preventDefault(); onOpen(entry, true) } }}>
        {title}
      </button>
      {entry.wait ? <span className="needs-you__wait">{entry.wait}</span> : null}
    </div>
    <p className="needs-you__meta">
      <span className="needs-you__status">{row.stateLabel}</span>
      {row.waitingIn ? <span>Waiting in {row.waitingIn}</span> : null}
      {row.project ? <span>{row.project.title}</span> : null}
      {row.thread.hostLabel ? <span>{row.thread.hostLabel}</span> : null}
      {settled ? <span className="needs-you__tag">Settled</span> : null}
    </p>
    {entry.request !== undefined
      ? <RequestActions entry={entry} state={state} command={command} watcherOn={watcherOn} onOpen={() => onOpen(entry, false)} />
      : <>
        {entry.kind === 'failed' && entry.action === 'dismiss' ? <p className="needs-you__ask">{row.thread.failureReason ?? 'The last turn failed.'}</p> : null}
        <div className="needs-you__actions">
          {entry.action === 'dismiss' ? <Button variant="secondary" aria-label={`Dismiss Needs attention on ${title}`}
            aria-disabled={dismissing || undefined} onClick={() => { if (!dismissing) onDismiss([{ threadId: row.thread.id, failure: failureId }]) }}>Dismiss</Button> : null}
          <Button variant="secondary" aria-label={entry.action === 'dismiss' ? `Open ${title}` : `Open ${title} to answer`} onClick={() => onOpen(entry, false)}>
            {entry.action === 'dismiss' ? 'Open' : 'Open to answer'}</Button>
        </div>
      </>}
  </li>
}

/**
 * The actions of an entry whose thread waits on a request: the request card's own choices and states, on the same
 * store entry the card reads, so either surface sending closes the other (ADR-0135). What the facts left to opening,
 * what is blocked, held or half-drafted, and what no choice can be sent for, opens the thread instead.
 */
function RequestActions({ entry, state, command, watcherOn, onOpen }: {
  readonly entry: NeedsYouEntry; readonly state: AgentState; readonly command: Command
  readonly watcherOn: boolean; readonly onOpen: () => void
}): ReactNode {
  const { row, request } = entry
  const thread = row.thread
  const title = thread.title
  const [checking, setChecking] = useState(false)
  const draftOwner = threadRequestOwner(row, state)
  const draftQuestions = requestDraftQuestions(request!)
  const entryOwner = requestAnswerOwnerKey(thread.id, request!, draftOwner)
  const store = requestAnswerStore
  const saved = useRequestEntry(entryOwner, request!.id, store, draftQuestions.length > 0
    ? { ...draftOwner, requestId: request!.id, questions: draftQuestions } : undefined,
    request!.delivery === 'uncertain' ? 'uncertain' : request!.answerRetryReady === true ? 'retry-ready' : undefined)
  if (request === undefined) return null
  const blocked = threadRequestBlocked(row, state)
  const nativeUncertain = request.delivery === 'uncertain'
  const uncertain = nativeUncertain || saved.phase === 'unconfirmed'
  const locked = uncertain || saved.phase === 'sending' || saved.phase === 'sent'
  const questions = request.questions ?? []
  const drafting = questions.some(question => answerProgress(question, saved.selections[question.id]) !== 'empty')
  const inline = entry.action === 'answer' && blocked === null && !locked && saved.save !== 'loading' && saved.save !== 'unsaved'
    && (saved.phase === 'idle' || saved.phase === 'failed') && !drafting
  const send = threadRequestSubmit(command, thread, request, watcherOn)
  // Pressing a choice unmounts it as the answer sends; the status that replaces it takes the focus (ADR-0135),
  // and the queue hands it on again when this entry itself leaves.
  const pressed = useRef(false)
  const statusBox = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (pressed.current && (saved.phase !== 'idle' || uncertain)) statusBox.current?.focus()
  }, [saved.phase, uncertain])
  const submit = (choice: string | null, answer: Parameters<typeof send>[0]): void => {
    pressed.current = true
    void store.submit(entryOwner, request.id, choice, () => send(answer))
  }
  const check = (): void => {
    if (checking) return
    setChecking(true)
    void store.release(entryOwner, request.id, () => threadRequestCheck(command, thread.id)).finally(() => setChecking(false))
  }
  const ask = request.kind === 'permission'
    ? permissionSummary(request).command ?? permissionSummary(request).title
    : questions[0]?.question ?? request.text
  const status = nativeUncertain
    ? <div className="needs-you__hold" role="status"><p>Your answer was sent, but its arrival could not be confirmed. Sotto won’t send it again.</p>
      <Button variant="secondary" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check again'}</Button></div>
    : saved.phase === 'unconfirmed'
      ? <div className="needs-you__hold" role="status"><p>{saved.save === 'unsaved' && saved.error ? saved.error
        : 'Sotto could not confirm this answer. It may have arrived, so it won’t be sent again until you check.'}</p>
        <Button variant="secondary" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check again'}</Button></div>
      : saved.phase === 'failed' ? <p className="needs-you__error" role="alert">{saved.error}</p>
        : saved.phase === 'sending' ? <p className="needs-you__note" role="status">Sending…</p>
          : saved.phase === 'sent' ? <p className="needs-you__note" role="status">Answer sent.</p>
            : blocked !== null ? <p className="needs-you__note">{blocked}</p> : null
  const openButton = <Button variant="secondary" aria-label={`Open ${title} to answer`} onClick={onOpen}>Open to answer</Button>
  return <>
    <p className="needs-you__ask">{ask}{request.kind === 'permission' && permissionSummary(request).cwd ? <> in <code>{permissionSummary(request).cwd}</code></> : null}</p>
    {inline && request.kind === 'permission' ? <div className="needs-you__actions">
      {request.permissionChoices
        ? request.permissionChoices.map(choice => <Button key={choice.id} variant={choice.kind === 'allow-once' ? 'primary' : 'secondary'}
          aria-label={`${choice.label} in ${title}`} aria-pressed={saved.choice === choice.id || undefined}
          onClick={() => submit(choice.id, permissionAnswer(choice))}>{choice.label}</Button>)
        : <>
          <Button variant="secondary" aria-label={`Deny in ${title}`} aria-pressed={saved.choice === 'deny' || undefined}
            onClick={() => submit('deny', legacyPermissionAnswer(false))}>Deny</Button>
          <Button aria-label={`Allow in ${title}`} aria-pressed={saved.choice === 'allow' || undefined}
            onClick={() => submit('allow', legacyPermissionAnswer(true))}>Allow</Button>
        </>}
    </div> : null}
    {inline && request.kind === 'question' && questions[0] ? <div className="needs-you__actions">
      {questions[0].options.map(option => <Button key={option.id} variant="secondary" aria-label={`Answer ${option.label} in ${title}`}
        onClick={() => {
          const selection: QuestionSelection = { optionIds: [option.id], other: false, text: '' }
          store.select(entryOwner, request.id, questions[0]!.id, selection)
          const answer = structuredAnswer(questions, { [questions[0]!.id]: selection })
          if (answer) submit(null, answer)
        }}>{option.label}</Button>)}
      {!isRequired(questions[0]) ? <Button variant="ghost" aria-label={`Skip question in ${title}`}
        onClick={() => { const answer = structuredAnswer(questions, {}); if (answer) submit(null, answer) }}>Skip question</Button> : null}
    </div> : null}
    {!inline && !locked ? <div className="needs-you__actions">{openButton}</div> : null}
    {hasNoSendableChoice(request) ? <p className="needs-you__note">Sotto has no choice it can send for this request. Answer it in the provider’s app.</p> : null}
    {status || (saved.saveError && !uncertain) ? <div ref={statusBox} tabIndex={-1} className="needs-you__statusbox">{status}
      {saved.saveError && !uncertain ? <p className="needs-you__error" role="alert">{saved.saveError}</p> : null}</div> : null}
  </>
}
