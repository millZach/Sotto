import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pencil, X } from 'lucide-react'
import type { AgentFollowup, AgentState } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { composerEnterIntent, readComposerKey } from './composerKeys'
import { retainSkillReferences } from './composerSkills'
import { queueAdmissionOpen, submissionStatus, UNCONFIRMED_SUBMISSION, useSubmissions, useThreadComposer, type Submission, type ThreadDraftStore } from './threadDraftStore'
import type { ThreadRow } from './threadFacts'

type Command = AgentConnection['command']

/** This thread's durable follow-ups, in dispatch order. */
export function followupsFor(state: AgentState, threadId: string): AgentFollowup[] {
  return state.followups?.filter(item => item.threadId === threadId) ?? []
}

/** Only an item Sotto has not started sending may change; a dispatching or unconfirmed one might already be with the provider. */
export function followupEditable(item: AgentFollowup): boolean {
  return item.status === 'queued' || item.status === 'paused' || item.status === 'failed'
}

const STATUS_LABELS: Record<AgentFollowup['status'], string> = {
  queued: 'Queued', dispatching: 'Sending', uncertain: 'Unconfirmed', failed: 'Not sent', paused: 'Paused',
}

/** Short windows and large display scaling, where the composer and transcript need the height first. */
const SHORT_WINDOW = '(max-height: 760px)'
function subscribeShortWindow(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia(SHORT_WINDOW)
  query.addEventListener?.('change', listener)
  return () => query.removeEventListener?.('change', listener)
}
function useShortWindow(): boolean {
  return useSyncExternalStore(subscribeShortWindow, () => typeof window.matchMedia === 'function' && window.matchMedia(SHORT_WINDOW).matches)
}

type Busy = { readonly itemId: string; readonly error: string | null } | null

/** A queue change is confirmed by the returned state showing it, not by the absence of an error. */
function confirmation(result: AgentState | null, shows: (state: AgentState) => boolean, fallback: string): string | null {
  if (result !== null && shows(result)) return null
  return result?.error ?? fallback
}

/**
 * One queued message in a focused editor. It opens over the workspace, so its actions are never
 * clipped by the queue, and it closes back to the Edit button that opened it.
 */
function FollowupEditor({ item, current, saving, error, onSave, onClose }: {
  readonly item: AgentFollowup
  /** The same item as the queue shows it now; gone or on its way means the edit can no longer be saved. */
  readonly current: AgentFollowup | undefined
  readonly saving: boolean
  readonly error: string | null
  readonly onSave: (text: string) => void
  readonly onClose: () => void
}): ReactNode {
  const [text, setText] = useState(item.text)
  const dialog = useRef<HTMLDialogElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const titleId = useId()
  const hintId = useId()
  useEffect(() => {
    const element = dialog.current
    if (element?.showModal) element.showModal()
    else element?.setAttribute('open', '')
    const input = field.current
    input?.focus()
    input?.setSelectionRange(input.value.length, input.value.length)
    return () => { element?.close?.() }
  }, [])
  const locked = current === undefined ? 'This message has left the queue.' : followupEditable(current) ? null : 'Sotto has started sending this message, so it can’t be changed.'
  const empty = text.trim() === '' && item.attachments.length === 0
  const canSave = locked === null && !saving && !empty
  const save = (): void => { if (canSave) onSave(text) }
  return <dialog ref={dialog} className="followup-editor" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!saving) onClose() }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
      event.preventDefault(); event.stopPropagation()
      if (!saving) onClose()
    }}>
    <h2 id={titleId}>Edit queued message</h2>
    <textarea ref={field} aria-label="Edit queued message" aria-describedby={hintId} value={text} rows={4} spellCheck disabled={saving}
      onChange={event => setText(event.target.value)}
      onKeyDown={event => {
        if (composerEnterIntent(readComposerKey(event, false)) !== 'send') return
        event.preventDefault()
        save()
      }} />
    <div className="followup-editor__foot">
      {error ? <p className="followup-editor__note" data-tone="warning" id={hintId} role="alert">{error}</p>
        : locked ? <p className="followup-editor__note" data-tone="warning" id={hintId} role="status">{locked}</p>
          : <p className="followup-editor__note" id={hintId}>{saving ? 'Saving…' : 'Enter to save · Shift+Enter for a new line'}</p>}
      <div className="followup-editor__actions">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={save} disabled={!canSave}>Save</Button>
      </div>
    </div>
  </dialog>
}

function AdmissionRow({ submission, state, holdsRevision, onRetry, onDismiss }: {
  readonly submission: Submission; readonly state: AgentState; readonly holdsRevision: boolean
  readonly onRetry: () => void; readonly onDismiss: () => void
}): ReactNode {
  const failed = submissionStatus(submission, state).status === 'failed'
  // No answer from main is not a refusal: the queue may own it, and asking again cannot add it twice.
  const unconfirmed = submission.error === UNCONFIRMED_SUBMISSION.queue
  return <li className="thread-followup" data-status={failed ? (unconfirmed ? 'uncertain' : 'failed') : 'admitting'}>
    <p className="thread-followup__text">{submission.text || submission.attachments.map(item => item.name).join(', ')}</p>
    <span className="thread-followup__state" data-status={failed ? (unconfirmed ? 'uncertain' : 'failed') : undefined} role="status">{failed ? (unconfirmed ? 'Unconfirmed' : 'Not queued') : 'Queuing…'}</span>
    {failed ? <div className="thread-followup__detail">
      <span>{submission.error ?? UNCONFIRMED_SUBMISSION.queue}{holdsRevision ? '' : ' Your newer draft is in the composer.'}</span>
      <span className="thread-followup__actions">
        {holdsRevision ? <Button variant="secondary" onClick={onRetry}>Try again</Button> : null}
        <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </span>
    </div> : null}
  </li>
}

/**
 * The thread's follow-up queue, above its composer. It lists what Sotto will send after the current
 * turn, in order; the transcript shows a message only once the provider has it. In a short window it
 * rests as one line (the count and the next message) until the user opens it; anything that needs
 * the user stays listed either way.
 */
export function ThreadFollowups({ row, state, command, store, onRetryAdmission }: {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly command: Command
  readonly store: ThreadDraftStore
  /** Queue the composer's revision again; the queue ignores a revision it already owns. */
  readonly onRetryAdmission: () => void
}): ReactNode {
  const threadId = row.thread.id
  const items = followupsFor(state, threadId)
  const { draft } = useThreadComposer(store, threadId)
  const admissions = useSubmissions(store).filter(item => item.threadId === threadId && queueAdmissionOpen(item, state))
  const short = useShortWindow()
  const [opened, setOpened] = useState<boolean | null>(null)
  const [editing, setEditing] = useState<AgentFollowup | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [queueError, setQueueError] = useState<string | null>(null)
  const listId = useId()
  const section = useRef<HTMLElement>(null)
  const host = useRef<HTMLElement | null>(null)
  /** The head and its notes never scroll away: the queue gives up height only from its rows, so its minimum is their height. */
  const measureTop = useCallback((element: HTMLDivElement | null) => {
    const owner = element?.parentElement
    if (!element || !owner || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => owner.style.setProperty('--followups-top', `${Math.ceil(element.getBoundingClientRect().height)}px`))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  /** Where keyboard focus goes once the queue re-renders after a change that removed the focused control. */
  const refocus = useRef<(() => HTMLElement | null | undefined) | null>(null)
  /** Items already shown once; only a newly queued one plays the arrival, not rows revealed by opening the list. */
  const shown = useRef<Set<string> | null>(null)
  /** The message the user just queued, named for a moment so a new row is never confirmed by a count alone. */
  const [arrival, setArrival] = useState<{ readonly id: string; readonly text: string } | null>(null)
  useLayoutEffect(() => {
    const current = followupsFor(state, threadId)
    if (shown.current === null) { shown.current = new Set(current.map(item => item.id)); return }
    const fresh = current.filter(item => !shown.current!.has(item.id))
    if (!fresh.length) return
    for (const item of fresh) shown.current.add(item.id)
    const newest = fresh.at(-1)!
    setArrival({ id: newest.id, text: newest.text || newest.attachments.map(image => image.name).join(', ') })
    section.current?.querySelector<HTMLElement>(`[data-followup="${CSS.escape(newest.id)}"]`)?.scrollIntoView?.({ block: 'nearest' })
  })
  useEffect(() => {
    if (arrival === null) return
    const timer = window.setTimeout(() => setArrival(current => current === arrival ? null : current), 4000)
    return () => window.clearTimeout(timer)
  }, [arrival])
  useLayoutEffect(() => {
    if (section.current?.parentElement) host.current = section.current.parentElement
    const target = refocus.current
    if (target === null) return
    refocus.current = null
    const element = target() ?? host.current?.querySelector<HTMLElement>('textarea:not(:disabled)')
    element?.focus()
  })
  // A dispatched follow-up already in the history is told by the transcript.
  const visible = items.filter(item => !(item.status === 'dispatching' && item.messageId !== undefined && row.thread.messages.some(message => message.id === item.messageId)))
  if (visible.length === 0 && admissions.length === 0) return null

  const expanded = opened ?? !short
  const pendingDelivery = items.some(item => item.status === 'dispatching' || item.status === 'uncertain')
  const movable = items.filter(followupEditable)
  const resumable = items.some(item => item.status === 'paused' || item.status === 'failed')
  const provider = state.host.providers && row.providerId ? { provider: row.providerId } : {}
  // A pause stops the whole queue: it is said once, beside Resume queue, not on every item.
  const paused = visible.filter(item => item.status === 'paused')
  const queuePaused = paused.length > 0 && !visible.some(item => item.status === 'queued')
  const pauseNote = queuePaused && paused.every(item => item.error === paused[0]!.error) ? paused[0]!.error : undefined
  const managed = row.assignment?.mode === 'managed' && !isThreadClosed(row.thread)
  const tool = (itemId: string, name: string): HTMLElement | null | undefined =>
    section.current?.querySelector<HTMLElement>(`[data-followup="${itemId}"] [data-tool="${name}"]`)
  const toggle = (): HTMLElement | null | undefined => section.current?.querySelector<HTMLElement>('.thread-followups__toggle')

  const run = (itemId: string, request: Parameters<Command>[0], shows: (state: AgentState) => boolean, fallback: string, after?: () => void): void => {
    setBusy({ itemId, error: null })
    void command(request).then(result => {
      const error = confirmation(result, shows, fallback)
      setBusy(error === null ? null : { itemId, error })
      if (error === null) after?.()
    }, () => setBusy({ itemId, error: fallback }))
  }
  const move = (item: AgentFollowup, offset: -1 | 1): void => {
    const order = items.map(candidate => candidate.id)
    const from = order.indexOf(item.id)
    const to = from + offset
    if (to < 0 || to >= order.length || busy?.itemId === item.id && busy.error === null) return
    ;[order[from], order[to]] = [order[to]!, order[from]!]
    run(item.id, { type: 'reorder-followups', threadId, itemIds: order },
      next => followupsFor(next, threadId).map(candidate => candidate.id).join(' ') === order.join(' '), 'Sotto could not confirm the new order. Check the queue before changing it again.',
      // At the end of the list the pressed arrow has nowhere to go; the other one keeps the item in hand.
      () => { refocus.current = () => to === 0 || to === order.length - 1 ? tool(item.id, offset < 0 ? 'down' : 'up') : tool(item.id, offset < 0 ? 'up' : 'down') })
  }
  const remove = (item: AgentFollowup): void => {
    const index = visible.indexOf(item)
    run(item.id, { type: 'remove-followup', threadId, itemId: item.id },
      next => !followupsFor(next, threadId).some(candidate => candidate.id === item.id), 'Sotto could not confirm this was removed. Check the queue before trying again.',
      () => {
        const rest = visible.filter(candidate => candidate.id !== item.id && followupEditable(candidate))
        const neighbour = rest.find(candidate => visible.indexOf(candidate) > index) ?? rest.at(-1)
        refocus.current = () => (neighbour ? tool(neighbour.id, 'remove') : null) ?? toggle()
      })
  }
  const closeEditor = (): void => {
    const itemId = editing?.id
    setEditing(null); setBusy(null)
    refocus.current = () => (itemId ? tool(itemId, 'edit') : null) ?? toggle()
  }

  // Collapsed, the queue still lists what needs the user: an unconfirmed or refused item, or an admission that did not go through.
  const needsUser = (item: AgentFollowup): boolean => item.status === 'uncertain' || item.status === 'failed' || busy?.itemId === item.id && busy.error !== null
  const listed = expanded ? visible : visible.filter(needsUser)
  const listedAdmissions = expanded ? admissions : admissions.filter(item => submissionStatus(item, state).status === 'failed')
  const next = visible[0]?.text ?? admissions[0]?.text
  const added = arrival !== null && visible.some(item => item.id === arrival.id) ? arrival : null
  // Collapsed without a pause to explain, the managed hold is the head's state instead of a line of its own.
  const heldChip = managed && !expanded && !queuePaused
  const notes = [pauseNote, managed && !heldChip ? 'Waits while Sotto manages this thread.' : undefined].filter(Boolean).join(' ')

  return <section ref={section} className="thread-followups" aria-label="Queued messages" data-expanded={expanded || undefined}>
    <div ref={measureTop} className="thread-followups__top">
    <header className="thread-followups__head">
      <button type="button" className="thread-followups__toggle tt-focusable" aria-expanded={expanded} aria-controls={listId} onClick={() => setOpened(!expanded)}>
        {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
        {/* Only what the queue owns is counted; a submission it has not taken yet is not queued. */}
        <span className="thread-followups__label">{visible.length > 0 ? <>Queued <span className="thread-followups__count">{visible.length}</span></> : 'Queue'}</span>
        {!expanded && added ? <span className="thread-followups__next" data-added><span className="thread-followups__next-label">Added</span>{added.text}</span>
          : !expanded && next ? <span className="thread-followups__next"><span className="thread-followups__next-label">Next</span>{next}</span> : null}
      </button>
      {queuePaused ? <span className="thread-followup__state" data-status="paused"><i aria-hidden="true" />Paused</span>
        : heldChip ? <span className="thread-followup__state" data-status="held">Waiting for Sotto</span>
        : !expanded && admissions.some(item => !item.resolved) ? <span className="thread-followup__state" role="status">Queuing…</span>
          : !expanded && visible.some(item => item.status === 'dispatching') ? <span className="thread-followup__state" data-status="dispatching"><i aria-hidden="true" />Sending</span> : null}
      {resumable ? <Button variant="secondary" disabled={!row.connected} onClick={() => {
        setQueueError(null)
        const failed = 'Sotto could not confirm the queue resumed.'
        void command({ type: 'resume-followups', threadId }).then(result => {
          const error = confirmation(result, next => !followupsFor(next, threadId).some(candidate => candidate.status === 'paused' || candidate.status === 'failed'), failed)
          setQueueError(error)
          if (error === null) refocus.current = toggle
        }, () => setQueueError(failed))
      }}>Resume queue</Button> : null}
    </header>
    <span className="tt-visually-hidden" role="status">{added ? `Queued: ${added.text}` : ''}</span>
    {notes ? <p className="thread-followups__note">{notes}</p> : null}
    {queueError ? <p className="thread-followups__error" role="alert">{queueError}</p> : null}
    </div>
    {listed.length > 0 || listedAdmissions.length > 0 ? <ol id={listId} className="thread-followups__list">
      {listed.map(item => {
        const index = items.indexOf(item)
        const editable = followupEditable(item)
        const itemBusy = busy?.itemId === item.id && busy.error === null
        const itemError = busy?.itemId === item.id && editing?.id !== item.id ? busy.error : null
        const unconfirmed = item.status === 'uncertain'
        const note = unconfirmed ? `Sotto will not send it twice.${row.connected ? '' : ' Reconnect to check it.'}` : item.error === pauseNote && item.status === 'paused' ? undefined : item.error
        // A busy or end-of-list control stays focusable (aria-disabled): disabling the focused button would drop focus to the page.
        const off = (blocked: boolean): { readonly 'aria-disabled'?: true } => blocked ? { 'aria-disabled': true } : {}
        return <li key={item.id} className="thread-followup" data-status={item.status} data-followup={item.id} data-arriving={arrival?.id === item.id || undefined}>
          <p className="thread-followup__text" title={item.text}>{item.text}{item.attachments.length ? <span className="thread-followup__extra"> · {item.attachments.length === 1 ? '1 image' : `${item.attachments.length} images`}</span> : null}</p>
          {item.status === 'queued' || item.status === 'paused' && queuePaused ? null : <span className="thread-followup__state" data-status={item.status}><i aria-hidden="true" />{STATUS_LABELS[item.status]}</span>}
          {editable ? <span className="thread-followup__tools">
            {movable.length > 1 && !pendingDelivery ? <>
              <Button variant="ghost" iconOnly data-tool="up" aria-label={`Move queued message ${index + 1} up`} {...off(itemBusy || index === 0)} onClick={() => { if (index > 0) move(item, -1) }}><ArrowUp size={15} /></Button>
              <Button variant="ghost" iconOnly data-tool="down" aria-label={`Move queued message ${index + 1} down`} {...off(itemBusy || index === items.length - 1)} onClick={() => { if (index < items.length - 1) move(item, 1) }}><ArrowDown size={15} /></Button>
            </> : null}
            <Button variant="ghost" iconOnly data-tool="edit" aria-label={`Edit queued message ${index + 1}`} {...off(itemBusy)} onClick={() => { if (itemBusy) return; setBusy(null); setEditing(item) }}><Pencil size={15} /></Button>
            <Button variant="ghost" iconOnly data-tool="remove" aria-label={`Remove queued message ${index + 1}`} {...off(itemBusy)} onClick={() => { if (!itemBusy) remove(item) }}><X size={15} /></Button>
          </span> : null}
          {note || itemError || unconfirmed ? <div className="thread-followup__detail">
            <span>{itemError ?? note}</span>
            {unconfirmed && row.connected ? <span className="thread-followup__actions"><Button variant="secondary" onClick={() => void command({ type: 'refresh', ...provider })}>Check again</Button></span> : null}
          </div> : null}
        </li>
      })}
      {listedAdmissions.map(submission => <AdmissionRow key={submission.draftId} submission={submission} state={state} holdsRevision={draft.draftId === submission.draftId}
        onRetry={onRetryAdmission} onDismiss={() => { store.dismiss(threadId, submission.draftId); refocus.current = toggle }} />)}
    </ol> : null}
    {editing ? <FollowupEditor key={editing.id} item={editing} current={items.find(item => item.id === editing.id)}
      saving={busy?.itemId === editing.id && busy.error === null} error={busy?.itemId === editing.id ? busy.error : null} onClose={closeEditor}
      onSave={text => run(editing.id, { type: 'edit-followup', threadId, itemId: editing.id, text, attachments: [...editing.attachments], skills: retainSkillReferences(text, editing.skills ?? []) },
        next => followupsFor(next, threadId).some(candidate => candidate.id === editing.id && candidate.text === text), 'Sotto could not confirm this edit. Check the queue before editing again.', closeEditor)} />
      : null}
  </section>
}
