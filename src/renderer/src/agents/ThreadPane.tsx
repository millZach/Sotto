import React, { useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { capabilitiesForThread, supportsAgentSupervision, type AgentState } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { AgentComposer } from './AgentView'
import { ProviderMark } from './ProviderMark'
import { ThreadComposer, sendThreadRevision } from './ThreadComposer'
import { ThreadFollowups } from './ThreadFollowups'
import { ThreadOptions } from './ThreadOptions'
import { submissionStatus, useSubmissions, type ThreadDraftStore } from './threadDraftStore'
import type { ThreadRow } from './threadFacts'
import { ThreadTranscript } from './ThreadTranscript'

type Command = AgentConnection['command']

/** The inline request: Allow and Deny answer it; nothing else on the page ever does. */
function ThreadRequest({ row, command, busy, onAnswer, voiceAvailable }: {
  readonly row: ThreadRow; readonly command: Command; readonly busy: boolean; readonly onAnswer: () => void; readonly voiceAvailable: boolean
}): ReactNode {
  const request = row.request
  if (request?.requestId === undefined) return null
  const [title, ...detail] = request.text.split('\n')
  const answer = (value: string, approved: boolean): void => {
    void command({ type: 'answer', threadId: row.thread.id, requestId: request.requestId!, answer: value, approved })
  }
  const permission = request.kind === 'permission'
  return <div className="thread-row__ask" data-kind={request.kind} aria-label={permission ? `Permission request for ${row.thread.title}` : `Question from ${row.thread.title}`}>
    <div className="thread-row__ask-text">
      <strong>{permission ? (title || 'Permission request') : 'Question'}</strong>
      {permission
        ? detail.length > 0 ? <code>{detail.join('\n').trim()}</code> : null
        : <p>{request.text}</p>}
    </div>
    <div className="thread-row__ask-actions">
      {permission
        ? <><Button variant="secondary" disabled={busy} onClick={() => answer('Denied', false)}>Deny</Button>
          <Button disabled={busy} onClick={() => answer('Approved', true)}>Allow</Button></>
        : <Button variant="secondary" onClick={onAnswer}>Write an answer</Button>}
    </div>
    {voiceAvailable ? <span className="thread-row__say">{permission ? 'Say “allow” or “deny”, or choose here.' : 'Say your answer, then “send it”, or write it below.'}</span> : null}
  </div>
}

export interface ThreadPaneProps {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly command: Command
  readonly store: ThreadDraftStore
  /** This pane holds the selection: it owns the managed composer and shows the last command's error. */
  readonly focused: boolean
  /** The composer's element ID; unique per pane. */
  readonly promptId: string
  /** The latest command error, passed only to the focused pane. */
  readonly error: string | null
  readonly onOpenThread: (threadId: string) => void
  /** Present in a split: closes this view only. */
  readonly onClose?: (() => void) | undefined
  /** An unfocused managed pane asks to take the selection before writing. */
  readonly onFocusPane?: (() => void) | undefined
  /** Placed after the project title in the header. */
  readonly crumb?: ReactNode
  /** Placed at the end of the header actions. */
  readonly actions?: ReactNode
  /** Placed directly above the composer. */
  readonly notice?: ReactNode
}

/**
 * One thread's view: header and controls, its own transcript position and its own composer.
 * Everything here acts on `row.thread.id`; a split workspace mounts one per open thread.
 */
export function ThreadPane({ row, state, command, store, focused, promptId, error, onOpenThread, onClose, onFocusPane, crumb, actions, notice }: ThreadPaneProps): ReactNode {
  const [followSignal, setFollowSignal] = useState(0)
  const submissions = useSubmissions(store)
  const thread = row.thread
  const closed = isThreadClosed(thread)
  const connected = state.connection === 'connected'
  const pending = thread.requests[0]
  const workspaceRow = !closed && pending && !row.request ? { ...row, request: {
    id: `${thread.id}:${pending.id}`, threadId: thread.id, requestId: pending.id,
    kind: pending.kind, text: pending.text, createdAt: '', deferred: false,
  } } : row
  const assigned = row.assignment
  const managed = assigned?.mode === 'managed' && !closed
  const rowConnected = row.connected
  const capabilities = capabilitiesForThread(state.host, thread)
  const canManage = rowConnected && !state.busy && supportsAgentSupervision(capabilities) && !closed
  const reconnect = row.providerId && state.host.providers ? { provider: row.providerId } : {}
  const foreignDraft = focused && (state.draft.trim() || state.draftAttachments?.length) && state.draftThreadId && state.draftThreadId !== thread.id ? state.host.threads.find(item => item.id === state.draftThreadId) : undefined
  // A send that failed or went unconfirmed is already told by its pending message in this thread; other errors still show.
  const deliveryExplains = error !== null && submissions.some(item => item.threadId === thread.id && item.error === error
    && ['failed', 'uncertain'].includes(submissionStatus(item, state).status))
  const options = <ThreadOptions key={thread.id} thread={thread} state={state} command={command} />
  return <>
    <header className="thread-workspace__head">
      <div className="thread-workspace__title">
        <span className="thread-workspace__crumb"><ProviderMark provider={row.providerId} name={row.provider} size={16} /><span>{row.project?.title ?? row.provider}</span>{crumb}
          {row.settledBy === 'thread' || row.settledBy === 'project' ? <span className="thread-workspace__tag">Settled</span> : null}
          {!rowConnected ? <span className="thread-workspace__tag" data-tone="warning">{row.provider} disconnected</span> : null}
        </span>
        <h2>{thread.title}</h2>
      </div>
      <div className="thread-workspace__actions">
        {assigned && !closed ? <Button variant="ghost" disabled={!canManage} onClick={() => void command({ type: assigned.paused || assigned.mode === 'manual' ? 'resume' : 'pause', threadId: thread.id })}>{assigned.paused || assigned.mode === 'manual' ? 'Resume managing' : 'Pause managing'}</Button>
          : !assigned && !closed ? <Button variant="ghost" disabled={!canManage} onClick={() => void command({ type: 'assign', threadId: thread.id })}>Manage</Button> : null}
        {assigned ? <Button variant="ghost" disabled={state.busy || !connected} onClick={() => void command({ type: 'unassign', threadId: thread.id })}>Stop managing</Button> : null}
        {row.settledBy === null ? <Button variant="ghost" disabled={state.busy} onClick={() => void command({ type: 'settle-thread', threadId: thread.id })}>Settle</Button>
          : row.settledBy === 'thread' ? <Button variant="ghost" disabled={state.busy} onClick={() => void command({ type: 'restore-thread', threadId: thread.id })}>Restore</Button> : null}
        {!rowConnected ? <Button variant="secondary" disabled={state.connection === 'connecting'} onClick={() => void command({ type: 'connect', ...reconnect })}>Reconnect</Button> : null}
        {thread.status === 'running' && !closed ? <Button variant="secondary" disabled={state.busy || !rowConnected || !capabilities.interrupt} onClick={() => void command({ type: 'interrupt', threadId: thread.id })}>Stop agent</Button> : null}
        {actions}
      </div>
      {onClose ? <button type="button" className="thread-pane__close tt-focusable" data-pane-close aria-label={`Close ${thread.title} pane`} title="Close pane" onClick={onClose}><X size={16} aria-hidden="true" /></button> : null}
    </header>
    {error && !deliveryExplains ? <p className="agent-error thread-workspace__error" role="alert">{error}</p> : null}
    <ThreadTranscript row={row} state={state} command={command} store={store} followSignal={followSignal}>
      <ThreadRequest row={workspaceRow} voiceAvailable={state.queue.some(item => item.threadId === thread.id && item.requestId === workspaceRow.request?.requestId)} command={command} busy={state.busy || !rowConnected}
        onAnswer={() => {
          const target = (): void => document.getElementById(managed ? 'agent-prompt' : promptId)?.focus()
          // A managed pane's composer appears only once the pane holds the selection.
          if (managed && !focused) { onFocusPane?.(); window.setTimeout(target, 0) } else target()
        }} />
    </ThreadTranscript>
    <div className="thread-workspace__compose">
      {notice}
      {managed ? <ThreadFollowups row={workspaceRow} state={state} command={command} store={store}
        onRetryAdmission={() => { void sendThreadRevision(store, workspaceRow, command, performance.now(), 'queue') }} /> : null}
      {managed && !focused ? <div className="thread-draft-notice"><p>Sotto is managing this thread.</p><Button variant="secondary" onClick={() => { onFocusPane?.(); window.setTimeout(() => document.getElementById('agent-prompt')?.focus(), 0) }}>Write here</Button></div>
        : foreignDraft && managed ? <div className="thread-draft-notice"><p>Your saved draft belongs to <strong>{foreignDraft.title}</strong>.</p><Button variant="secondary" onClick={() => onOpenThread(foreignDraft.id)}>Open draft thread</Button>{options}</div>
          : managed ? <AgentComposer state={state} command={command} enterToSend footerControls={capabilities.configureThread || thread.nativeSessionStarted === false ? options : undefined} />
            : <ThreadComposer key={thread.id} row={workspaceRow} state={state} command={command} store={store} composerId={promptId} onSend={() => setFollowSignal(signal => signal + 1)} />}
    </div>
  </>
}
