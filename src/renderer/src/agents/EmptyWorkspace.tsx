import React, { useRef, useState, type ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'
import type { AgentAttachmentHandle, AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import type { AgentConnection } from './AgentContext'
import { isRecoveredDraft } from './ProviderUpgradeNotice'

/**
 * The coordinator's draft as it stood when the user asked for a new thread with it: its words and images. Skill and
 * file references chosen for the old thread do not move: they name that thread's provider catalog and working copy.
 * Their mentions stay in the words, so they can be chosen again in the new thread.
 */
export interface CarriedDraft {
  readonly text: string
  readonly attachments: readonly AgentAttachmentHandle[]
  /** The thread it was written for, which is gone; null when it named none. */
  readonly threadId: string | null
}

/**
 * What the empty Threads page offers for the coordinator's draft. A recovered draft after a provider upgrade has
 * its own notice and is left to it. Disconnected, the draft waits for the connection. Connected, a draft whose
 * thread is still here is opened there, and a leftover draft, whose thread is gone, can start a new thread; one
 * that answered a question in that thread says so, since the question went with it.
 */
type SavedDraftOffer =
  | { readonly kind: 'none' }
  | { readonly kind: 'reconnect' }
  | { readonly kind: 'thread'; readonly threadId: string; readonly title: string }
  | { readonly kind: 'leftover'; readonly draft: CarriedDraft; readonly answer: boolean }

function savedDraftOffer(state: AgentState): SavedDraftOffer {
  const attachments = state.draftAttachments ?? []
  if (!state.draft.trim() && !attachments.length) return { kind: 'none' }
  if (isRecoveredDraft(state)) return { kind: 'none' }
  if (state.connection !== 'connected') return { kind: 'reconnect' }
  const threadId = state.draftThreadId
  const thread = threadId === null ? undefined : state.host.threads.find(item => item.id === threadId)
  if (thread !== undefined) return { kind: 'thread', threadId: thread.id, title: thread.title }
  return { kind: 'leftover', answer: state.draftRequestId !== null, draft: { text: state.draft, attachments, threadId } }
}

/**
 * The Threads page with no pane open. It says what to do next and, when the coordinator holds a draft, keeps it
 * in sight with a way to finish it or let it go. It shows with voice off too (ADR-0012): the draft is text the
 * user typed, which a send from a thread's own composer leaves here, and this page is the only place it shows.
 */
export function EmptyWorkspace({ state, command, voice, onNewThread, onNewThreadWithDraft, onOpenThread, onOpenAgents, error }: {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly voice: boolean
  readonly onNewThread: () => void
  /** Settles once the new thread has opened or failed to; the button waits for it, so one press moves the draft once. */
  readonly onNewThreadWithDraft: (draft: CarriedDraft) => Promise<void>
  readonly onOpenThread: (threadId: string) => void
  readonly onOpenAgents: () => void
  readonly error?: string | null
}): ReactNode {
  const [confirming, setConfirming] = useState(false)
  const [moving, setMoving] = useState(false)
  // A discard removes the button that opened its question, so focus lands on the page's heading instead.
  const headingRef = useRef<HTMLHeadingElement>(null)
  const offer = savedDraftOffer(state)
  const connecting = state.connection === 'connecting'
  const images = state.draftAttachments ?? []
  const connect = <>{error && !connecting ? <p className="agent-error thread-workspace__error" role="alert">{error}</p> : null}<Button disabled={connecting} onClick={() => void command({ type: 'connect' })}>{connecting ? 'Connecting...' : 'Connect providers'}</Button></>
  const moveDraft = (draft: CarriedDraft): void => {
    if (moving) return
    setMoving(true)
    void onNewThreadWithDraft(draft).finally(() => setMoving(false))
  }
  // What the page says, its first action, and whether the draft is shown and can be discarded here.
  const page = ((): { readonly heading: string; readonly detail: string; readonly action: ReactNode; readonly showDraft: boolean; readonly discardable: boolean } => {
    switch (offer.kind) {
      case 'reconnect':
        return { heading: 'Your draft is saved.', detail: 'Reconnect to continue your saved draft.', action: connect, showDraft: true, discardable: false }
      case 'thread':
        return { heading: `Your draft for ${offer.title} is saved.`, detail: 'Open the thread to finish it, or discard it.',
          action: <Button onClick={() => onOpenThread(offer.threadId)}>Open thread</Button>, showDraft: true, discardable: true }
      case 'leftover':
        return { heading: offer.answer ? 'An answer from an earlier thread is saved.' : 'A draft from an earlier thread is saved.',
          detail: offer.answer ? 'Its thread and the question it answered are no longer here. Start a new thread with it, or discard it.'
            : 'Its thread is no longer here. Start a new thread with it, or discard it.',
          action: <Button disabled={moving} onClick={() => moveDraft(offer.draft)}>New thread with this draft</Button>, showDraft: true, discardable: true }
      case 'none':
        return { ...(state.host.threads.length > 0 ? { heading: 'Choose a thread.', detail: 'Select a thread to read its messages and continue working.' }
          : { heading: 'No threads yet.', detail: 'Start a thread to begin working with your agent.' }),
        action: state.connection === 'connected' ? <Button onClick={onNewThread}>New thread</Button> : connect, showDraft: false, discardable: false }
    }
  })()
  const discard = async (): Promise<boolean> => {
    const result = await command({ type: 'cancel-draft' })
    const discarded = result !== null && !result.error
    if (discarded) headingRef.current?.focus()
    return discarded
  }
  return <div className="thread-workspace__empty thread-workspace__empty--page">
    <MessageSquare size={30} strokeWidth={1.3} aria-hidden="true" />
    <h2 ref={headingRef} tabIndex={-1}>{page.heading}</h2>
    <p>{page.detail}</p>
    {page.showDraft ? <div className="thread-prompt thread-prompt--saved">
      <label className="tt-visually-hidden" htmlFor="saved-thread-prompt">Saved draft</label>
      <textarea id="saved-thread-prompt" rows={4} value={state.draft} readOnly />
      {images.length ? <p className="thread-prompt__images">{images.length === 1 ? 'Image' : 'Images'}: {images.map(image => image.name).join(', ')}</p> : null}
    </div> : null}
    <div className="thread-workspace__empty-actions">
      {page.action}
      {page.discardable ? <Button variant="danger" disabled={state.globalLaneBusy || moving} onClick={() => setConfirming(true)}>Discard draft</Button> : null}
      {voice ? <Button variant="ghost" onClick={onOpenAgents}>Open Agents</Button> : null}
    </div>
    {confirming ? <ConfirmationDialog title="Discard this draft?" description="The draft is deleted and cannot be brought back."
      confirmLabel="Discard draft" cancelLabel="Keep draft" onConfirm={discard} onCancel={() => setConfirming(false)} fallbackFocusRef={headingRef}
      failureMessage="The draft could not be discarded. It is still saved. Try again." /> : null}
  </div>
}
