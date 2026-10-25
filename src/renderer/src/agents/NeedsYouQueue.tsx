import React, { useId, useRef, useState, type ReactNode } from 'react'
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

/** The next control to take the focus once `from` leaves with the entry it settled: the following queue button, else search. */
function focusAfter(root: HTMLElement | null, from: HTMLElement): void {
  const buttons = root ? [...root.querySelectorAll<HTMLElement>('button')] : []
  const next = buttons[buttons.indexOf(from) + 1]
    ?? root?.closest('.thread-nav')?.querySelector<HTMLInputElement>('.threads-search input')
  if (next) requestAnimationFrame(() => next.focus())
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
  if (queue.entries.length === 0) return null
  const shown = expanded ? queue.entries : queue.shown
  const open = (entry: NeedsYouEntry, beside: boolean): void => {
    if (beside && panes.currentThreadId !== null && panes.currentThreadId !== entry.row.thread.id) panes.onOpenBeside(entry.row.thread.id)
    else onOpen(entry.row.thread.id)
  }
  const dismiss = (named: Failures, from: HTMLElement): void => {
    const ids = named.map(item => item.threadId)
    if (ids.some(id => dismissing.has(id))) return
    setDismissing(new Set([...dismissing, ...ids]))
    void command({ type: 'dismiss-failures', failures: named.slice(0, AGENT_DISMISS_FAILURES_MAX) }).then(result => {
      if (result !== null && !result.error) focusAfter(card.current, from)
    }).finally(() => setDismissing(current => new Set([...current].filter(id => !ids.includes(id)))))
  }
  const overflowKinds = [
    queue.overflow.approval ? `${queue.overflow.approval} approval${queue.overflow.approval === 1 ? '' : 's'}` : '',
    queue.overflow.question ? `${queue.overflow.question} answer${queue.overflow.question === 1 ? '' : 's'}` : '',
    queue.overflow.failed ? `${queue.overflow.failed} failed` : '',
  ].filter(Boolean).join(', ')
  return <section ref={card} className="needs-you" aria-labelledby={headingId} onKeyDown={event => {
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
        onClick={event => dismiss(failures, event.currentTarget)}>Dismiss {failures.length} failed</Button> : null}
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
  readonly onDismiss: (named: Failures, from: HTMLElement) => void
}

function NeedsYouEntryView({ entry, state, command, watcherOn, dismissing, panes, onOpen, onDismiss }: EntryProps): ReactNode {
  const { row } = entry
  const title = row.thread.title
  const besideAvailable = panes.currentThreadId !== null && panes.currentThreadId !== row.thread.id
  const settled = row.settledBy === 'thread' || row.settledBy === 'project'
  const failureId = row.thread.failureId ?? ''
  return <li className="needs-you__entry" data-kind={entry.kind}>
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
            aria-disabled={dismissing || undefined} onClick={event => { if (!dismissing) onDismiss([{ threadId: row.thread.id, failure: failureId }], event.currentTarget) }}>Dismiss</Button> : null}
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
          onClick={() => { void store.submit(entryOwner, request.id, choice.id, () => send(permissionAnswer(choice))) }}>{choice.label}</Button>)
        : <>
          <Button variant="secondary" aria-label={`Deny in ${title}`} aria-pressed={saved.choice === 'deny' || undefined}
            onClick={() => { void store.submit(entryOwner, request.id, 'deny', () => send(legacyPermissionAnswer(false))) }}>Deny</Button>
          <Button aria-label={`Allow in ${title}`} aria-pressed={saved.choice === 'allow' || undefined}
            onClick={() => { void store.submit(entryOwner, request.id, 'allow', () => send(legacyPermissionAnswer(true))) }}>Allow</Button>
        </>}
    </div> : null}
    {inline && request.kind === 'question' && questions[0] ? <div className="needs-you__actions">
      {questions[0].options.map(option => <Button key={option.id} variant="secondary" aria-label={`Answer ${option.label} in ${title}`}
        onClick={() => {
          const selection: QuestionSelection = { optionIds: [option.id], other: false, text: '' }
          store.select(entryOwner, request.id, questions[0]!.id, selection)
          const answer = structuredAnswer(questions, { [questions[0]!.id]: selection })
          if (answer) void store.submit(entryOwner, request.id, null, () => send(answer))
        }}>{option.label}</Button>)}
      {!isRequired(questions[0]) ? <Button variant="ghost" aria-label={`Skip question in ${title}`}
        onClick={() => { const answer = structuredAnswer(questions, {}); if (answer) void store.submit(entryOwner, request.id, null, () => send(answer)) }}>Skip question</Button> : null}
    </div> : null}
    {!inline && !locked ? <div className="needs-you__actions">{openButton}</div> : null}
    {hasNoSendableChoice(request) ? <p className="needs-you__note">Sotto has no choice it can send for this request. Answer it in the provider’s app.</p> : null}
    {status}
    {saved.saveError && !uncertain ? <p className="needs-you__error" role="alert">{saved.saveError}</p> : null}
  </>
}
