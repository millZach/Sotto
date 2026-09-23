import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Archive, ArchiveRestore, Columns2, Pencil, Plug, Shrink, Sparkles, Square, X } from 'lucide-react'
import { capabilitiesForThread, isThreadBusy, providerWritesShortText, supportsAgentSupervision, type AgentState } from '../../../shared/agents'
import { isThreadArchived, isThreadClosed } from '../../../shared/threadActivity'
import { ThreadNameField } from './ThreadName'
import { Button } from '../components/Button'
import { useVoiceCoordinatorEnabled } from '../state/voiceCoordinator'
import type { AgentConnection } from './AgentContext'
import { AgentComposer } from './AgentView'
import { PaneMenu, type PaneMenuItem } from './PaneMenu'
import { ProviderMark } from './ProviderMark'
import { AgentRequestCard } from './requests/AgentRequestCard'
import { RequestDraftRecovery } from './requests/RequestDraftRecovery'
import { requestAnswerOwnerKey, requestAnswerStore, requestMode } from './requests/requestAnswers'
import { ThreadComposer, sendThreadRevision } from './ThreadComposer'
import { ThreadFollowups } from './ThreadFollowups'
import { ThreadOptions } from './ThreadOptions'
import { hasDraftContent, submissionStatus, useSubmissions, useThreadComposer, type ThreadDraftStore } from './threadDraftStore'
import { ThreadBranchNotice, useSettleThread } from './ThreadWorkingCopy'
import type { ThreadRow } from './threadFacts'
import { ThreadTranscript } from './ThreadTranscript'
import { ThreadWebLinks } from '../tools/webLinks'
import { ThreadUsage } from './ThreadUsage'
import { ThreadMonitor, ThreadHeld, ThreadWorking, useHeldAction } from './ThreadMonitor'
import { compactionBusy, compactionOffered, ThreadCompaction } from './ThreadCompaction'

type Command = AgentConnection['command']

/**
 * The thread's pending requests, each answered by its own ID in this pane and nowhere else on the page.
 * A plain question points at the composer; everything the provider structured is answered in place.
 */
function ThreadRequests({ row, state, command, blocked, onAnswer, kind }: {
  readonly row: ThreadRow; readonly state: AgentState; readonly command: Command; readonly blocked: string | null; readonly onAnswer: () => void; readonly kind: 'question' | 'permission'
}): ReactNode {
  // Without the voice coordinator nothing is listening, so a request never says an answer can be spoken.
  const spoken = useVoiceCoordinatorEnabled()
  const thread = row.thread
  const requests = thread.requests.filter(request => request.kind === kind)
  if (isThreadClosed(thread) || requests.length === 0) return null
  return <div className={kind === 'question' ? 'thread-questions' : undefined}>{requests.map(request => {
    const voice = spoken && state.queue.some(item => item.threadId === thread.id && item.requestId === request.id)
    const mode = requestMode(request)
    return <AgentRequestCard placement={kind === 'question' ? 'composer' : undefined} key={request.id} ownerId={thread.id} ownerTitle={thread.title} request={request} blocked={blocked}
      draftOwner={{ kind: 'thread', ownerId: thread.id, providerId: row.providerId ?? state.configuration.provider }}
      hint={voice && (mode === 'permission' && request.permissionChoices === undefined || mode === 'legacy-text')
        ? mode === 'permission' ? 'Say “allow” or “deny”, or choose here.' : 'Say your answer, then “send it”, or write it below.' : undefined}
      onWriteAnswer={onAnswer}
      onSubmit={answer => command({ type: 'answer', threadId: thread.id, requestId: request.id, ...answer }).then(result => result === null ? null : { error: result.error })}
      onCheck={() => command({ type: 'observe-threads', threadIds: [thread.id] }).then(result => result !== null && result.error === null)} />
  })}</div>
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
  /** Opens this thread in a second pane. The More menu leaves the item out where the page cannot split. */
  readonly onOpenBeside?: (() => void) | undefined
  /** A fixed clock where the page holds one still (a capture run); the held ornament reads from it. */
  readonly now?: number | undefined
}

/**
 * One thread's view: header and controls, its own transcript position and its own composer.
 * Everything here acts on `row.thread.id`; a split workspace mounts one per open thread.
 */
export function ThreadPane({ row, state, command, store, focused, promptId, error, onOpenThread, onClose, onFocusPane, onOpenBeside, crumb, actions, notice, now }: ThreadPaneProps): ReactNode {
  const [followSignal, setFollowSignal] = useState(0)
  const [handingOff, setHandingOff] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [holdingWriteHere, setHoldingWriteHere] = useState(false)
  /** A Git refusal the branch toolbar shows under its row; the pane's own error line leaves it to the row. */
  const [toolbarExplained, setToolbarExplained] = useState<string | null>(null)
  const compose = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLElement>(null)
  /** Keyboard focus waiting for the composer that a handoff (Manage, Stop managing, Write here) mounts. */
  const handoff = useRef<{ readonly managed: boolean; readonly focused?: true; readonly until: number } | null>(null)
  const submissions = useSubmissions(store)
  const paneDraft = useThreadComposer(store, row.thread.id)
  // Management is the voice coordinator's own work, so with it hidden a managed thread still composes by hand.
  const coordinated = useVoiceCoordinatorEnabled()
  const thread = row.thread
  const closed = isThreadClosed(thread)
  const connected = state.connection === 'connected'
  const assigned = coordinated ? row.assignment : undefined
  const managed = assigned?.mode === 'managed' && !closed
  const rowConnected = row.connected
  // Monitoring is observation, independent of the voice coordinator's authority. A ready notice reports
  // a finished foreground turn; only requests or a coordinator block interrupt a surviving watch.
  const monitoringBlocked = state.queue.some(item => item.threadId === thread.id && item.kind !== 'ready')
  const ornamentAllowed = rowConnected && !closed && !monitoringBlocked && thread.status !== 'error' && thread.requests.length === 0
  const liveMonitors = ornamentAllowed ? thread.monitoring ?? [] : []
  const liveWork = ornamentAllowed ? thread.backgroundWork ?? [] : []
  // One ornament, because the composer reserves room for exactly one, taken by the strongest claim. A watch
  // says the provider is looking at something; background work says only that agents it started still run;
  // waiting says only that time is passing, so the two confirmed states keep the track ahead of the clock.
  const confirmed = liveMonitors.length ? <ThreadMonitor key={`monitor:${thread.id}`} tasks={liveMonitors} />
    : liveWork.length ? <ThreadWorking key={`working:${thread.id}`} work={liveWork} /> : undefined
  const held = useHeldAction(thread, ornamentAllowed && confirmed === undefined, now)
  const ornament = confirmed ?? (held === undefined ? undefined
    : <ThreadHeld key={`held:${thread.id}`} action={held} now={now} />)
  // Sotto's own composer holds a managed thread's draft; every other pane keeps its own.
  const composing = hasDraftContent(paneDraft.draft)
    || (managed && state.draftThreadId === thread.id && Boolean(state.draft.trim() || state.draftAttachments?.length))
  const capabilities = capabilitiesForThread(state.host, thread)
  /** This thread's own lane. Work on another thread leaves every control here live. */
  const threadBusy = isThreadBusy(state, thread.id)
  // Management moves assignment authority and the single composer draft, which is global-lane work.
  const canManage = rowConnected && !state.globalLaneBusy && supportsAgentSupervision(capabilities) && !closed
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
  /** A branch switched in a terminal leaves no activity behind, so a draft that begins re-reads the folder once. */
  const branchRead = useRef<string | null>(null)
  const worktreeReady = thread.worktree?.status === 'ready' || (!thread.worktree && thread.nativeSessionStarted !== false)
  useEffect(() => {
    if (!composing) { branchRead.current = null; return }
    if (!worktreeReady || branchRead.current === thread.id) return
    branchRead.current = thread.id
    void command({ type: 'refresh-thread-worktree', threadId: thread.id })
  }, [composing, worktreeReady, thread.id, command])
  // Coming back from a terminal is the other moment a switch made elsewhere can show; the window regaining
  // focus re-reads the folder once, so the label follows without a keystroke or a send.
  useEffect(() => {
    if (!worktreeReady) return
    const onFocus = (): void => { void command({ type: 'refresh-thread-worktree', threadId: thread.id }) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [worktreeReady, thread.id, command])
  const { settle: settleThread, dialog: settleDialog } = useSettleThread(command)
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
  /* Renaming is Sotto's own record of the thread: it neither waits for a running turn nor tells the provider. */
  const naming: PaneMenuItem[] = [
    ...(!isThreadArchived(thread) && !renaming ? [{ id: 'rename', label: 'Rename', icon: <Pencil size={15} aria-hidden="true" />, run: () => setRenaming(true) }] : []),
    // The thread's own provider writes the name from its first exchange (ADR-0026); a name typed by hand is left
    // alone and offers no rewrite, and neither does a Devin thread, whose provider writes nothing.
    ...(!isThreadArchived(thread) && !renaming && thread.titleSource !== 'user' && providerWritesShortText(thread.providerId)
      ? [{ id: 'regenerate', label: 'Regenerate title', icon: <Sparkles size={15} aria-hidden="true" />, disabled: threadBusy, run: () => void command({ type: 'regenerate-thread-title', threadId: thread.id }) }] : []),
    ...(onOpenBeside ? [{ id: 'beside', label: 'Open beside', icon: <Columns2 size={15} aria-hidden="true" />, run: onOpenBeside }] : []),
  ]
  // Compaction is offered where it can run: the banner under the composer only ever recommends it.
  const context: PaneMenuItem[] = compactionOffered(capabilities, thread) && rowConnected && !closed && !compactionBusy(thread, threadBusy || handingOff)
    ? [{ id: 'compact', label: 'Compact context', icon: <Shrink size={15} aria-hidden="true" />, run: () => void command({ type: 'compact-thread', threadId: thread.id }) }] : []
  // While a handoff waits for its save, nothing else may act on this thread; other panes stay usable.
  const shelf: PaneMenuItem[] = row.settledBy === null
    ? [{ id: 'settle', label: 'Settle', icon: <Archive size={15} aria-hidden="true" />, disabled: threadBusy || handingOff, run: () => void settleThread(thread, row.project) }]
    : row.settledBy === 'thread'
      ? [{ id: 'restore', label: 'Restore', icon: <ArchiveRestore size={15} aria-hidden="true" />, disabled: threadBusy || handingOff, run: () => void command({ type: 'restore-thread', threadId: thread.id }) }] : []
  /* The saved draft is what Sotto's composer shows, so the latest manual typing is saved before a handoff. */
  const supervision: PaneMenuItem[] = !coordinated ? []
    : [
      ...(assigned && !closed
        ? [{ id: 'manage', label: assigned.paused || assigned.mode === 'manual' ? 'Resume managing' : 'Pause managing', disabled: !canManage || handingOff,
          run: () => assigned.mode === 'manual' ? handOff(true, () => store.handoffToManagement(thread.id, 'resume')) : void command({ type: assigned.paused ? 'resume' : 'pause', threadId: thread.id }) }]
        : !assigned && !closed ? [{ id: 'manage', label: 'Manage', disabled: !canManage || handingOff, run: () => handOff(true, () => store.handoffToManagement(thread.id, 'assign')) }] : []),
      ...(assigned ? [{ id: 'unassign', label: 'Stop managing', disabled: state.globalLaneBusy || !connected || handingOff, run: () => handOff(false, () => command({ type: 'unassign', threadId: thread.id })) }] : []),
    ]
  const recovery: PaneMenuItem[] = [
    ...(!rowConnected ? [{ id: 'reconnect', label: 'Reconnect', icon: <Plug size={15} aria-hidden="true" />, disabled: state.connection === 'connecting', run: () => void command({ type: 'connect', ...reconnect }) }] : []),
    // A thread's own composer carries Stop; Sotto's composer for a managed thread does not.
    ...(thread.status === 'running' && managed
      ? [{ id: 'interrupt', label: 'Stop agent', icon: <Square size={15} aria-hidden="true" />, disabled: threadBusy || !rowConnected || !capabilities.interrupt, run: () => void command({ type: 'interrupt', threadId: thread.id }) }] : []),
  ]
  const focusAnswerComposer = (): void => {
    const target = (): void => document.getElementById(managed ? 'agent-prompt' : promptId)?.focus()
    // A managed pane's composer appears only once the pane holds the selection.
    if (managed && !focused) { onFocusPane?.(); window.setTimeout(target, 0) } else target()
  }
  return <>
    <header className="thread-workspace__head" ref={head}>
      <div className="thread-workspace__title">
        <ProviderMark provider={row.providerId} name={row.provider} size={16} />
        {renaming
          ? <h2><ThreadNameField title={thread.title} label={`Rename ${thread.title}`} className="thread-workspace__rename tt-focusable"
            onRename={next => void command({ type: 'rename-thread', threadId: thread.id, title: next })} onDone={() => setRenaming(false)} /></h2>
          : <h2>{thread.title}</h2>}
        <span className="thread-workspace__crumb"><span>{row.project?.title ?? row.provider}</span>{crumb}
          {row.settledBy === 'thread' || row.settledBy === 'project' ? <span className="thread-workspace__tag">Settled</span> : null}
          {!rowConnected ? <span className="thread-workspace__tag" data-tone="warning">{row.provider} disconnected</span> : null}
        </span>
      </div>
      <div className="thread-workspace__actions">
        {actions}
        <PaneMenu groups={[naming, context, shelf, supervision, recovery]} />
      </div>
      {onClose ? <button type="button" className="pane-action thread-pane__close tt-focusable" data-pane-close aria-label={`Close ${thread.title} pane`} title="Close pane" onClick={onClose}><X size={16} aria-hidden="true" /></button> : null}
    </header>
    {settleDialog}
    {error && !deliveryExplains && !answerExplains && error !== toolbarExplained ? <p className="agent-error thread-workspace__error" role="alert">{error}</p> : null}
    <ThreadWebLinks threadId={thread.id} threadTitle={thread.title}><ThreadTranscript row={row} state={state} command={command} store={store} followSignal={followSignal}>
      <ThreadRequests kind="permission" row={row} state={state} command={command} blocked={threadBusy ? 'Waiting for Sotto…' : !rowConnected ? `Reconnect ${row.provider} to answer.` : null}
        onAnswer={focusAnswerComposer} />
      {/* Answers saved for questions no live card shows, such as ones the provider closed while Sotto was shut. */}
      <RequestDraftRecovery owner={{ kind: 'thread', ownerId: thread.id, providerId: row.providerId ?? state.configuration.provider }}
        live={closed ? [] : thread.requests} provider={row.provider}
        observation={state.connection === 'connecting' ? 'loading' : !rowConnected ? 'disconnected' : thread.historyStatus === 'loading' ? 'loading' : thread.historyStatus === 'error' ? 'unavailable' : 'ready'}
        observed={JSON.stringify([rowConnected, state.connection, thread.historyStatus, thread.status, closed, thread.requests.map(request => [request.id, request.delivery, request.questions])])} />
    </ThreadTranscript></ThreadWebLinks>
    <div className="thread-workspace__compose" ref={compose}>
      {notice}
      {/* The branch under this thread moved since its last send. Nothing is refused; the notice waits for a draft to continue. */}
      <ThreadBranchNotice thread={thread} project={row.project} command={command} composing={composing} />
      {managed ? <ThreadFollowups row={row} state={state} command={command} store={store}
        onRetryAdmission={draftId => { void sendThreadRevision(store, row, command, performance.now(), 'queue', draftId) }} /> : null}
      <ThreadRequests kind="question" row={row} state={state} command={command} blocked={threadBusy ? 'Waiting for Sotto…' : !rowConnected ? `Reconnect ${row.provider} to answer.` : null}
        onAnswer={focusAnswerComposer} />
      {managed && (!focused || holdingWriteHere) ? <div className="thread-draft-notice"><p>Sotto is managing this thread.</p><Button variant="secondary"
        // The pane takes the selection in the capture pass of pointerdown or focus, and that update lands before the event
        // reaches this button, which it would replace. So both are handled in the same capture pass: a pointer arms the
        // handoff, and keyboard focus (Tab or Shift+Tab) holds the button until Enter or Space uses it.
        onPointerDownCapture={writeHere} onFocusCapture={() => setHoldingWriteHere(true)} onBlur={() => setHoldingWriteHere(false)}
        onClick={() => { writeHere(); setHoldingWriteHere(false); onFocusPane?.() }}>Write here</Button></div>
        : foreignDraft && managed ? <div className="thread-draft-notice"><p>Your saved draft belongs to <strong>{foreignDraft.title}</strong>.</p><Button variant="secondary" onClick={() => onOpenThread(foreignDraft.id)}>Open draft thread</Button>{options}</div>
          : managed ? <AgentComposer state={state} command={command} ornament={ornament} enterToSend footerControls={capabilities.configureThread || thread.nativeSessionStarted === false ? options : undefined} />
            : <ThreadComposer key={thread.id} ornament={ornament} row={row} state={state} command={command} store={store} composerId={promptId} handingOff={handingOff} focused={focused} onExplainedError={setToolbarExplained} onSend={() => setFollowSignal(signal => signal + 1)} />}
      {/* One row under the composer: what compaction has to say at its start, the two usage figures at its end. One row,
          so panes side by side keep their composers at the same height whether or not one has been compacted. */}
      <div className="thread-pane__meta">
        <ThreadCompaction thread={thread} supported={compactionOffered(capabilities, thread)}
          connected={rowConnected && !closed} blocked={threadBusy || handingOff} command={command} />
        <ThreadUsage usage={thread.usage} modelId={thread.modelId} />
      </div>
    </div>
  </>
}
