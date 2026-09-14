import React, { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { capabilitiesForThread, supportsAgentSupervision, type AgentState } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'
import { Button } from '../components/Button'
import type { AgentConnection } from './AgentContext'
import { AgentComposer } from './AgentView'
import { ProviderMark } from './ProviderMark'
import { AgentRequestCard } from './requests/AgentRequestCard'
import { RequestDraftRecovery } from './requests/RequestDraftRecovery'
import { requestAnswerOwnerKey, requestAnswerStore, requestMode } from './requests/requestAnswers'
import { ThreadComposer, sendThreadRevision } from './ThreadComposer'
import { ThreadFollowups } from './ThreadFollowups'
import { ThreadOptions } from './ThreadOptions'
import { submissionStatus, useSubmissions, type ThreadDraftStore } from './threadDraftStore'
import type { ThreadRow } from './threadFacts'
import { ThreadTranscript } from './ThreadTranscript'
import { ThreadWebLinks } from '../tools/webLinks'
import { ThreadUsage } from './ThreadUsage'
import { ThreadCompaction } from './ThreadCompaction'

type Command = AgentConnection['command']

/**
 * The thread's pending requests, each answered by its own ID in this pane and nowhere else on the page.
 * A plain question points at the composer; everything the provider structured is answered in place.
 */
function ThreadRequests({ row, state, command, blocked, onAnswer }: {
  readonly row: ThreadRow; readonly state: AgentState; readonly command: Command; readonly blocked: string | null; readonly onAnswer: () => void
}): ReactNode {
  const thread = row.thread
  const requests = thread.requests
  if (isThreadClosed(thread) || requests.length === 0) return null
  return <>{requests.map(request => {
    const voice = state.queue.some(item => item.threadId === thread.id && item.requestId === request.id)
    const mode = requestMode(request)
    return <AgentRequestCard key={request.id} ownerId={thread.id} ownerTitle={thread.title} request={request} blocked={blocked}
      draftOwner={{ kind: 'thread', ownerId: thread.id, providerId: row.providerId ?? state.configuration.provider }}
      hint={voice && (mode === 'permission' && request.permissionChoices === undefined || mode === 'legacy-text')
        ? mode === 'permission' ? 'Say “allow” or “deny”, or choose here.' : 'Say your answer, then “send it”, or write it below.' : undefined}
      onWriteAnswer={onAnswer}
      onSubmit={answer => command({ type: 'answer', threadId: thread.id, requestId: request.id, ...answer }).then(result => result === null ? null : { error: result.error })}
      onCheck={() => command({ type: 'observe-threads', threadIds: [thread.id] }).then(result => result !== null && result.error === null)} />
  })}</>
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
  const [handingOff, setHandingOff] = useState(false)
  const [holdingWriteHere, setHoldingWriteHere] = useState(false)
  const compose = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLElement>(null)
  /** Keyboard focus waiting for the composer that a handoff (Manage, Stop managing, Write here) mounts. */
  const handoff = useRef<{ readonly managed: boolean; readonly focused?: true; readonly until: number } | null>(null)
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
  // A refused answer is told in its request card, where it can be answered again; the banner would say it twice.
  const answerExplains = useSyncExternalStore(requestAnswerStore.subscribe,
    () => error !== null && thread.requests.some(request => requestAnswerStore.get(requestAnswerOwnerKey(thread.id, request,
      { kind: 'thread', ownerId: thread.id, providerId: row.providerId ?? state.configuration.provider }), request.id).error === error))
  const options = <ThreadOptions key={thread.id} thread={thread} state={state} command={command} />
  useLayoutEffect(() => {
    const pending = handoff.current
    if (pending === null) return
    if (performance.now() > pending.until) { handoff.current = null; return }
    // The managed composer follows main's selection; until main confirms this thread, it may belong to another.
    if (pending.managed !== managed || pending.focused && !focused || managed && state.activeThreadId !== thread.id) return
    const fallback = compose.current?.querySelector<HTMLElement>('textarea:not(:disabled), button:not(:disabled)')
    const target = (managed ? focused ? document.getElementById('agent-prompt') : null : document.getElementById(promptId)) ?? fallback
    if (!target || target.matches(':disabled')) return
    handoff.current = null
    target.focus()
  })
  const writeHere = (): void => { handoff.current = { managed: true, focused: true, until: performance.now() + 5000 } }
  /** Focus the composer once management is `managed`; a refused command leaves focus where it was. */
  const handOff = (managedNext: boolean, request: () => Promise<AgentState | null>): void => {
    const pending = { managed: managedNext, until: performance.now() + 5000 }
    handoff.current = pending
    // The activated button disables while this waits. Focus moves to this thread's composer now, so it stays there if the
    // handoff is refused; a user who has moved elsewhere by then keeps their place.
    if (head.current?.contains(document.activeElement)) compose.current?.querySelector<HTMLElement>('textarea:not(:disabled)')?.focus()
    setHandingOff(true)
    void request().then(result => { if ((result === null || result.error !== null) && handoff.current === pending) handoff.current = null },
      () => { if (handoff.current === pending) handoff.current = null }).finally(() => setHandingOff(false))
  }
  return <>
    <header className="thread-workspace__head" ref={head}>
      <div className="thread-workspace__title">
        <span className="thread-workspace__crumb"><ProviderMark provider={row.providerId} name={row.provider} size={16} /><span>{row.project?.title ?? row.provider}</span>{crumb}
          {row.settledBy === 'thread' || row.settledBy === 'project' ? <span className="thread-workspace__tag">Settled</span> : null}
          {!rowConnected ? <span className="thread-workspace__tag" data-tone="warning">{row.provider} disconnected</span> : null}
        </span>
        <h2>{thread.title}</h2>
      </div>
      <div className="thread-workspace__actions">
        {/* The saved draft is what Sotto's composer shows, so the latest manual typing is saved before a handoff. */}
        {assigned && !closed ? <Button variant="ghost" disabled={!canManage || handingOff} onClick={() => assigned.mode === 'manual' ? handOff(true, () => store.handoffToManagement(thread.id, 'resume'))
          : void command({ type: assigned.paused ? 'resume' : 'pause', threadId: thread.id })}>{assigned.paused || assigned.mode === 'manual' ? 'Resume managing' : 'Pause managing'}</Button>
          : !assigned && !closed ? <Button variant="ghost" disabled={!canManage || handingOff} onClick={() => handOff(true, () => store.handoffToManagement(thread.id, 'assign'))}>Manage</Button> : null}
        {assigned ? <Button variant="ghost" disabled={state.busy || !connected || handingOff} onClick={() => handOff(false, () => command({ type: 'unassign', threadId: thread.id }))}>Stop managing</Button> : null}
        {/* While a handoff waits for its save, nothing else may act on this thread; other panes stay usable. */}
        {row.settledBy === null ? <Button variant="ghost" disabled={state.busy || handingOff} onClick={() => void command({ type: 'settle-thread', threadId: thread.id })}>Settle</Button>
          : row.settledBy === 'thread' ? <Button variant="ghost" disabled={state.busy || handingOff} onClick={() => void command({ type: 'restore-thread', threadId: thread.id })}>Restore</Button> : null}
        {!rowConnected ? <Button variant="secondary" disabled={state.connection === 'connecting'} onClick={() => void command({ type: 'connect', ...reconnect })}>Reconnect</Button> : null}
        {thread.status === 'running' && !closed ? <Button variant="secondary" disabled={state.busy || !rowConnected || !capabilities.interrupt} onClick={() => void command({ type: 'interrupt', threadId: thread.id })}>Stop agent</Button> : null}
        {actions}
      </div>
      {onClose ? <button type="button" className="thread-pane__close tt-focusable" data-pane-close aria-label={`Close ${thread.title} pane`} title="Close pane" onClick={onClose}><X size={16} aria-hidden="true" /></button> : null}
    </header>
    {error && !deliveryExplains && !answerExplains ? <p className="agent-error thread-workspace__error" role="alert">{error}</p> : null}
    <ThreadWebLinks threadId={thread.id} threadTitle={thread.title}><ThreadTranscript row={row} state={state} command={command} store={store} followSignal={followSignal}>
      <ThreadRequests row={row} state={state} command={command} blocked={state.busy ? 'Waiting for Sotto…' : !rowConnected ? `Reconnect ${row.provider} to answer.` : null}
        onAnswer={() => {
          const target = (): void => document.getElementById(managed ? 'agent-prompt' : promptId)?.focus()
          // A managed pane's composer appears only once the pane holds the selection.
          if (managed && !focused) { onFocusPane?.(); window.setTimeout(target, 0) } else target()
        }} />
      {/* Answers saved for questions no live card shows, such as ones the provider closed while Sotto was shut. */}
      <RequestDraftRecovery owner={{ kind: 'thread', ownerId: thread.id, providerId: row.providerId ?? state.configuration.provider }}
        live={closed ? [] : thread.requests} provider={row.provider}
        observation={state.connection === 'connecting' ? 'loading' : !rowConnected ? 'disconnected' : thread.historyStatus === 'loading' ? 'loading' : thread.historyStatus === 'error' ? 'unavailable' : 'ready'}
        observed={JSON.stringify([rowConnected, state.connection, thread.historyStatus, thread.status, closed, thread.requests.map(request => [request.id, request.delivery, request.questions])])} />
    </ThreadTranscript></ThreadWebLinks>
    <div className="thread-workspace__compose" ref={compose}>
      {notice}
      {managed ? <ThreadFollowups row={workspaceRow} state={state} command={command} store={store}
        onRetryAdmission={() => { void sendThreadRevision(store, workspaceRow, command, performance.now(), 'queue') }} /> : null}
      {managed && (!focused || holdingWriteHere) ? <div className="thread-draft-notice"><p>Sotto is managing this thread.</p><Button variant="secondary"
        // The pane takes the selection in the capture pass of pointerdown or focus, and that update lands before the event
        // reaches this button, which it would replace. So both are handled in the same capture pass: a pointer arms the
        // handoff, and keyboard focus (Tab or Shift+Tab) holds the button until Enter or Space uses it.
        onPointerDownCapture={writeHere} onFocusCapture={() => setHoldingWriteHere(true)} onBlur={() => setHoldingWriteHere(false)}
        onClick={() => { writeHere(); setHoldingWriteHere(false); onFocusPane?.() }}>Write here</Button></div>
        : foreignDraft && managed ? <div className="thread-draft-notice"><p>Your saved draft belongs to <strong>{foreignDraft.title}</strong>.</p><Button variant="secondary" onClick={() => onOpenThread(foreignDraft.id)}>Open draft thread</Button>{options}</div>
          : managed ? <AgentComposer state={state} command={command} enterToSend footerControls={capabilities.configureThread || thread.nativeSessionStarted === false ? options : undefined} />
            : <ThreadComposer key={thread.id} row={workspaceRow} state={state} command={command} store={store} composerId={promptId} handingOff={handingOff} onSend={() => setFollowSignal(signal => signal + 1)} />}
      <ThreadUsage usage={thread.usage} modelId={thread.modelId} />
      <ThreadCompaction thread={thread} supported={capabilities.compact === true && thread.manualCompactionSupported === true && thread.nativeSessionStarted !== false}
        connected={rowConnected && !closed} blocked={state.busy || handingOff} command={command} />
    </div>
  </>
}
