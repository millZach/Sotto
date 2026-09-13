import React, { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Pencil, X } from 'lucide-react'
import type { AgentFollowup, AgentState } from '../../../shared/agents'
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

type Busy = { readonly itemId: string; readonly error: string | null } | null

/** A queue change is confirmed by the returned state showing it, not by the absence of an error. */
function confirmation(result: AgentState | null, shows: (state: AgentState) => boolean, fallback: string): string | null {
  if (result !== null && shows(result)) return null
  return result?.error ?? fallback
}

function FollowupEditor({ item, onSave, onCancel, saving }: {
  readonly item: AgentFollowup; readonly saving: boolean
  readonly onSave: (text: string) => void; readonly onCancel: () => void
}): ReactNode {
  const [text, setText] = useState(item.text)
  const empty = text.trim() === '' && item.attachments.length === 0
  return <div className="thread-followup__editor">
    <label className="tt-visually-hidden" htmlFor={`followup-edit-${item.id}`}>Edit queued message</label>
    <textarea id={`followup-edit-${item.id}`} value={text} rows={2} autoFocus spellCheck disabled={saving}
      onChange={event => setText(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onCancel(); return }
        if (composerEnterIntent(readComposerKey(event, false)) !== 'send') return
        event.preventDefault()
        if (!empty) onSave(text)
      }} />
    <div className="thread-followup__editor-actions">
      <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      <Button variant="secondary" onClick={() => onSave(text)} disabled={saving || empty}>Save</Button>
    </div>
  </div>
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
 * turn, in order; the transcript shows a message only once the provider has it.
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
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [queueError, setQueueError] = useState<string | null>(null)
  // A dispatched follow-up already in the history is told by the transcript.
  const visible = items.filter(item => !(item.status === 'dispatching' && item.messageId !== undefined && row.thread.messages.some(message => message.id === item.messageId)))
  if (visible.length === 0 && admissions.length === 0) return null

  const pendingDelivery = items.some(item => item.status === 'dispatching' || item.status === 'uncertain')
  const movable = items.filter(followupEditable)
  const resumable = items.some(item => item.status === 'paused' || item.status === 'failed')
  const provider = state.host.providers && row.providerId ? { provider: row.providerId } : {}

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
    if (to < 0 || to >= order.length) return
    ;[order[from], order[to]] = [order[to]!, order[from]!]
    run(item.id, { type: 'reorder-followups', threadId, itemIds: order },
      next => followupsFor(next, threadId).map(candidate => candidate.id).join(' ') === order.join(' '), 'Sotto could not confirm the new order. Check the queue before changing it again.')
  }

  return <section className="thread-followups" aria-label="Queued messages">
    <header className="thread-followups__head">
      {/* Only what the queue owns is counted; a submission it has not taken yet is not queued. */}
      <span>{visible.length > 0 ? <>Queued <span className="thread-followups__count">{visible.length}</span></> : 'Queue'}</span>
      {resumable ? <Button variant="secondary" disabled={!row.connected} onClick={() => {
        setQueueError(null)
        void command({ type: 'resume-followups', threadId }).then(result => setQueueError(confirmation(result,
          next => !followupsFor(next, threadId).some(candidate => candidate.status === 'paused' || candidate.status === 'failed'), 'Sotto could not confirm the queue resumed.')),
          () => setQueueError('Sotto could not confirm the queue resumed.'))
      }}>Resume queue</Button> : null}
    </header>
    {queueError ? <p className="thread-followups__error" role="alert">{queueError}</p> : null}
    <ol className="thread-followups__list">
      {visible.map(item => {
        const index = items.indexOf(item)
        const editable = followupEditable(item)
        const itemBusy = busy?.itemId === item.id && busy.error === null
        const itemError = busy?.itemId === item.id ? busy.error : null
        if (editing === item.id) {
          return <li key={item.id} className="thread-followup" data-status={item.status} data-editing>
            <FollowupEditor item={item} saving={itemBusy} onCancel={() => { setEditing(null); setBusy(null) }}
              onSave={text => run(item.id, { type: 'edit-followup', threadId, itemId: item.id, text, attachments: [...item.attachments], skills: retainSkillReferences(text, item.skills ?? []) },
                next => followupsFor(next, threadId).some(candidate => candidate.id === item.id && candidate.text === text), 'Sotto could not confirm this edit. Check the queue before editing again.', () => setEditing(null))} />
            {itemError ? <p className="thread-followups__error" role="alert">{itemError}</p> : null}
          </li>
        }
        const unconfirmed = item.status === 'uncertain'
        const note = unconfirmed ? `Sotto will not send it twice.${row.connected ? '' : ' Reconnect to check it.'}` : item.error
        return <li key={item.id} className="thread-followup" data-status={item.status}>
          <p className="thread-followup__text">{item.text}{item.attachments.length ? <span className="thread-followup__extra"> · {item.attachments.length === 1 ? '1 image' : `${item.attachments.length} images`}</span> : null}</p>
          {item.status === 'queued' ? null : <span className="thread-followup__state" data-status={item.status}><i aria-hidden="true" />{STATUS_LABELS[item.status]}</span>}
          {editable ? <span className="thread-followup__tools">
            {movable.length > 1 && !pendingDelivery ? <>
              <Button variant="ghost" iconOnly aria-label={`Move queued message ${index + 1} up`} disabled={itemBusy || index === 0} onClick={() => move(item, -1)}><ArrowUp size={15} /></Button>
              <Button variant="ghost" iconOnly aria-label={`Move queued message ${index + 1} down`} disabled={itemBusy || index === items.length - 1} onClick={() => move(item, 1)}><ArrowDown size={15} /></Button>
            </> : null}
            <Button variant="ghost" iconOnly aria-label={`Edit queued message ${index + 1}`} disabled={itemBusy} onClick={() => { setBusy(null); setEditing(item.id) }}><Pencil size={15} /></Button>
            <Button variant="ghost" iconOnly aria-label={`Remove queued message ${index + 1}`} disabled={itemBusy} onClick={() => run(item.id, { type: 'remove-followup', threadId, itemId: item.id },
              next => !followupsFor(next, threadId).some(candidate => candidate.id === item.id), 'Sotto could not confirm this was removed. Check the queue before trying again.')}><X size={15} /></Button>
          </span> : null}
          {note || itemError || unconfirmed ? <div className="thread-followup__detail">
            <span>{itemError ?? note}</span>
            {unconfirmed && row.connected ? <span className="thread-followup__actions"><Button variant="secondary" onClick={() => void command({ type: 'refresh', ...provider })}>Check again</Button></span> : null}
          </div> : null}
        </li>
      })}
      {admissions.map(submission => <AdmissionRow key={submission.draftId} submission={submission} state={state} holdsRevision={draft.draftId === submission.draftId}
        onRetry={onRetryAdmission} onDismiss={() => store.dismiss(threadId, submission.draftId)} />)}
    </ol>
  </section>
}
