import React, { useRef, useState, type ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'
import type { AgentAttachmentHandle, AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import type { AgentConnection } from './AgentContext'

/** The coordinator's draft as it stood when the user asked for a new thread with it. */
export interface CarriedDraft {
  readonly text: string
  readonly attachments: readonly AgentAttachmentHandle[]
  /** The thread it was written for, which is gone; null when it named none. */
  readonly threadId: string | null
}

/**
 * What the empty Threads page offers for the coordinator's draft. A recovered draft after a provider upgrade has
 * its own notice and is left to it. Disconnected, the draft waits for the connection. Connected, a draft whose
 * thread is still here is opened there, and a leftover draft, whose thread is gone, can start a new thread.
 */
export type SavedDraftOffer =
  | { readonly kind: 'none' }
  | { readonly kind: 'reconnect' }
  | { readonly kind: 'thread'; readonly threadId: string; readonly title: string }
  | { readonly kind: 'leftover'; readonly draft: CarriedDraft }

export function savedDraftOffer(state: AgentState, threadTitle: (threadId: string) => string | undefined): SavedDraftOffer {
  const attachments = state.draftAttachments ?? []
  if (!state.draft.trim() && !attachments.length) return { kind: 'none' }
  if (state.providerUpgrade && state.draftThreadId === null) return { kind: 'none' }
  if (state.connection !== 'connected') return { kind: 'reconnect' }
  const title = state.draftThreadId === null ? undefined : threadTitle(state.draftThreadId)
  if (state.draftThreadId !== null && title !== undefined) return { kind: 'thread', threadId: state.draftThreadId, title }
  return { kind: 'leftover', draft: { text: state.draft, attachments, threadId: state.draftThreadId } }
}

/**
 * The Threads page with no pane open. It says what to do next and, when the coordinator holds a draft, keeps it
 * in sight with a way to finish it or let it go. It shows with voice off too (ADR-0012): the draft is text the
 * user typed, which a send from a thread's own composer leaves here, and this page is the only place it shows.
 */
export function EmptyWorkspace({ state, command, hasThreads, voice, threadTitle, onNewThread, onNewThreadWithDraft, onOpenThread, onOpenAgents }: {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly hasThreads: boolean
  readonly voice: boolean
  readonly threadTitle: (threadId: string) => string | undefined
  readonly onNewThread: () => void
  readonly onNewThreadWithDraft: (draft: CarriedDraft) => void
  readonly onOpenThread: (threadId: string) => void
  readonly onOpenAgents: () => void
}): ReactNode {
  const [confirming, setConfirming] = useState(false)
  const discardRef = useRef<HTMLButtonElement>(null)
  const offer = savedDraftOffer(state, threadTitle)
  const connecting = state.connection === 'connecting'
  const images = state.draftAttachments ?? []
  const connect = <Button disabled={connecting} onClick={() => void command({ type: 'connect' })}>{connecting ? 'Connecting...' : 'Connect providers'}</Button>
  // What the page says and its first action, by what it offers; only a connected draft can be discarded here.
  const page: { readonly heading: string; readonly detail: string; readonly action: ReactNode; readonly discardable: boolean } =
    offer.kind === 'reconnect' ? { heading: 'Your draft is saved.', detail: 'Reconnect to continue your saved draft.', action: connect, discardable: false }
      : offer.kind === 'thread' ? { heading: `Your draft for ${offer.title} is saved.`, detail: 'Open the thread to finish it, or discard it.',
        action: <Button onClick={() => onOpenThread(offer.threadId)}>Open thread</Button>, discardable: true }
        : offer.kind === 'leftover' ? { heading: 'A draft from an earlier thread is saved.', detail: 'Its thread is no longer here. Start a new thread with it, or discard it.',
          action: <Button onClick={() => onNewThreadWithDraft(offer.draft)}>New thread with this draft</Button>, discardable: true }
          : { ...(hasThreads ? { heading: 'Choose a thread.', detail: 'Select a thread to read its messages and continue working.' }
            : { heading: 'No threads yet.', detail: 'Start a thread to begin working with your agent.' }),
          action: state.connection === 'connected' ? <Button onClick={onNewThread}>New thread</Button> : connect, discardable: false }
  const discard = async (): Promise<boolean> => {
    const result = await command({ type: 'cancel-draft' })
    return result !== null && !result.error
  }
  return <div className="thread-workspace__empty">
    <MessageSquare size={30} strokeWidth={1.3} aria-hidden="true" />
    <h2>{page.heading}</h2>
    <p>{page.detail}</p>
    {offer.kind !== 'none' ? <div className="thread-prompt thread-prompt--saved">
      <label className="tt-visually-hidden" htmlFor="saved-thread-prompt">Saved draft</label>
      <textarea id="saved-thread-prompt" rows={4} value={state.draft} readOnly />
      {images.length ? <p className="thread-prompt__images">{images.length === 1 ? 'Image' : 'Images'}: {images.map(image => image.name).join(', ')}</p> : null}
    </div> : null}
    <div className="thread-workspace__empty-actions">
      {page.action}
      {page.discardable ? <Button ref={discardRef} variant="danger" disabled={state.globalLaneBusy} onClick={() => setConfirming(true)}>Discard draft</Button> : null}
      {voice ? <Button variant="ghost" onClick={onOpenAgents}>Open Agents</Button> : null}
    </div>
    {confirming ? <ConfirmationDialog title="Discard this draft?" description="The draft is deleted and cannot be brought back."
      confirmLabel="Discard draft" cancelLabel="Keep draft" onConfirm={discard} onCancel={() => setConfirming(false)} fallbackFocusRef={discardRef}
      failureMessage="The draft could not be discarded. It is still saved. Try again." /> : null}
  </div>
}
