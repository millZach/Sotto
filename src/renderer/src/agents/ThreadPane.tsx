import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Archive, ArchiveRestore, Columns2, Pencil, Plug, Shrink, Sparkles, X } from 'lucide-react'
import { capabilitiesForThread, isThreadBusy, providerWritesShortText, type AgentState } from '../../../shared/agents'
import { isThreadArchived, isThreadClosed } from '../../../shared/threadActivity'
import { ThreadNameField } from './ThreadName'
import type { AgentConnection } from './AgentContext'
import { PaneMenu, type PaneMenuItem } from './PaneMenu'
import { GitActionButton } from './GitActionButton'
import { ProviderMark } from './ProviderMark'
import { AgentRequestCard } from './requests/AgentRequestCard'
import { messageLinks } from './requests/messageLinks'
import { CloudIphoneRequest } from './requests/CloudIphoneRequest'
import { RequestDraftRecovery } from './requests/RequestDraftRecovery'
import { requestAnswerOwnerKey, requestAnswerStore } from './requests/requestAnswers'
import { ThreadComposer } from './ThreadComposer'
import { usePendingSettings } from './pendingSettings'
import { hasDraftContent, submissionStatus, useSubmissions, type ThreadDraftStore } from './threadDraftStore'
import { ThreadBranchNotice, useSettleThread } from './ThreadWorkingCopy'
import type { ThreadRow } from './threadFacts'
import { ThreadTranscript } from './ThreadTranscript'
import { ThreadWebLinks } from '../tools/webLinks'
import { ThreadBabysitting, ThreadMonitor, ThreadHeld, ThreadWaitingCommand, ThreadWorking, useHeldAction } from './ThreadMonitor'
import { ornamentPose } from './threadActivityView'
import { compactionBusy, compactionOffered, ThreadCompaction } from './ThreadCompaction'
import { useWatchedThread } from '../watcher/watcherRoom'
import { WatchedBadge } from '../watcher/WatcherOwl'
import { WatchedNote, WatchHeaderToggle, WatchToast } from '../watcher/WatchControls'
import { prefersReducedMotion } from '../state/reducedMotion'

type Command = AgentConnection['command']

/** How long a send may take to empty the greeting and still carry the composer down with it. */
const LIFT_WINDOW_MS = 2_000

/** Where the composer stood when a send left the greeting, so it can settle from there rather than jump. */
interface Lift { readonly at: number; readonly top: number; readonly left: string; readonly right: string }

/**
 * A new thread holds its greeting and composer in the middle of the pane. When a send from this pane empties the
 * greeting, the composer slides from where it stood to its place at the bottom and widens as it goes; with motion
 * reduced it is simply there. A greeting emptied any other way, such as a message from the phone, moves at once.
 */
function useComposerLift(slot: HTMLElement | null, compose: React.RefObject<HTMLDivElement | null>): () => void {
  const lift = useRef<Lift | null>(null)
  useEffect(() => {
    if (slot === null) return
    const observer = new MutationObserver(() => {
      const from = lift.current
      const element = compose.current
      if (from === null || slot.firstElementChild !== null) return
      lift.current = null
      if (element === null || performance.now() - from.at > LIFT_WINDOW_MS) return
      const style = getComputedStyle(element)
      const rise = from.top - element.getBoundingClientRect().top
      element.animate?.([
        { transform: `translateY(${rise}px)`, paddingLeft: from.left, paddingRight: from.right },
        { transform: 'translateY(0)', paddingLeft: style.paddingLeft, paddingRight: style.paddingRight },
      ], { duration: 320, easing: 'cubic-bezier(.2, .8, .2, 1)' })
    })
    observer.observe(slot, { childList: true })
    return () => observer.disconnect()
  }, [slot, compose])
  return () => {
    const element = compose.current
    if (element === null || slot?.firstElementChild == null || prefersReducedMotion()) return
    const style = getComputedStyle(element)
    lift.current = { at: performance.now(), top: element.getBoundingClientRect().top, left: style.paddingLeft, right: style.paddingRight }
  }
}

/**
 * The thread's pending requests, each answered by its own ID in this pane and nowhere else on the page.
 * A plain question points at the composer; everything the provider structured is answered in place.
 */
function ThreadRequests({ row, state, command, blocked, onAnswer, kind }: {
  readonly row: ThreadRow; readonly state: AgentState; readonly command: Command; readonly blocked: string | null; readonly onAnswer: () => void; readonly kind: 'question' | 'permission'
}): ReactNode {
  const thread = row.thread
  const requests = thread.requests.filter(request => request.kind === kind)
  if (isThreadClosed(thread) || requests.length === 0) return null
  return <div className={kind === 'question' ? 'thread-questions' : undefined}>{requests.map(request => {
    return <AgentRequestCard placement={kind === 'question' ? 'composer' : undefined} key={request.id} ownerId={thread.id} ownerTitle={thread.title} request={request} blocked={blocked}
      messageLinks={kind === 'question' ? messageLinks(thread.messages) : []}
      draftOwner={{ kind: 'thread', ownerId: thread.id, providerId: row.providerId ?? state.configuration.provider }}
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
  /** This pane holds the selection and shows the last command's error. */
  readonly focused: boolean
  /** The composer's element ID; unique per pane. */
  readonly promptId: string
  /** The latest command error, passed only to the focused pane. */
  readonly error: string | null
  /** Present in a split: closes this view only. */
  readonly onClose?: (() => void) | undefined
  /** The working-copy control, placed after the project title in the header. */
  readonly workingCopy?: ReactNode
  /** Placed at the end of the header actions. */
  readonly actions?: ReactNode
  /** Placed directly above the composer. */
  readonly notice?: ReactNode
  /** Placed directly after the composer, full pane width: the pane's own terminal drawer. */
  readonly drawer?: ReactNode
  /** Opens this thread in a second pane. The More menu leaves the item out where the page cannot split. */
  readonly onOpenBeside?: (() => void) | undefined
  /** A fixed clock where the page holds one still (a capture run); the held ornament reads from it. */
  readonly now?: number | undefined
  /**
   * Watcher's own pane (ADR-0073): its header stands in for the thread's, and its composer keeps asking before
   * changes, with no skills, branch toolbar, Git action or thread menu, since Watcher coordinates rather than works.
   */
  readonly watcherHeader?: ReactNode
  /** In Watcher's own pane, what stands in its conversation's place (the Watched view); its own requests stay under it. */
  readonly watcherBody?: ReactNode
}

/**
 * One thread's view: header and controls, its own transcript position and its own composer.
 * Everything here acts on `row.thread.id`; a split workspace mounts one per open thread.
 */
export function ThreadPane({ row, state, command, store, focused, promptId, error, onClose, onOpenBeside, workingCopy, actions, notice, drawer, now, watcherHeader, watcherBody }: ThreadPaneProps): ReactNode {
  const [followSignal, setFollowSignal] = useState(0)
  const [renaming, setRenaming] = useState(false)
  const renameReturn = useRef<HTMLElement | null>(null)
  const restoreRenameFocus = useRef(false)
  useLayoutEffect(() => {
    if (!renaming && restoreRenameFocus.current) { restoreRenameFocus.current = false; renameReturn.current?.focus() }
  }, [renaming])
  /** A Git refusal the branch toolbar shows under its row; the pane's own error line leaves it to the row. */
  const [toolbarExplained, setToolbarExplained] = useState<string | null>(null)
  /** The same for the Git action's notice above the composer. */
  const [gitExplained, setGitExplained] = useState<string | null>(null)
  /** Where the Git action draws its notice: above the composer, in the pane's own flow. */
  const [gitNoticeSlot, setGitNoticeSlot] = useState<HTMLElement | null>(null)
  /** Where a new thread's greeting stands, directly above the composer. */
  const [greetingSlot, setGreetingSlot] = useState<HTMLElement | null>(null)
  const compose = useRef<HTMLDivElement>(null)
  const liftComposer = useComposerLift(greetingSlot, compose)
  const submissions = useSubmissions(store)
  // The pane only needs to know whether a draft exists. Subscribing to its text
  // re-renders the transcript and header synchronously on every keystroke.
  const paneHasDraft = useSyncExternalStore(store.subscribe, () => hasDraftContent(store.draft(row.thread.id)))
  const thread = row.thread
  // Watcher's own pane carries its own header and composer; it is never itself a watched thread.
  const ownPane = watcherHeader !== undefined
  const watched = useWatchedThread(thread.id) && !ownPane
  const closed = isThreadClosed(thread)
  const rowConnected = row.connected
  const ornamentAllowed = rowConnected && !closed && thread.status !== 'error' && thread.requests.length === 0
  const liveMonitors = ornamentAllowed ? thread.monitoring ?? [] : []
  const liveWork = ornamentAllowed ? thread.backgroundWork ?? [] : []
  const liveCommands = liveWork.filter(task => task.type === 'command')
  // One ornament, because the composer reserves room for exactly one, taken by the strongest claim. A watch
  // says the provider is looking at something; background agents say only that work it started still runs;
  // waiting says only that time is passing, so the two confirmed states keep the track ahead of the clock.
  // A command left running in the background waits once the turn is over; while it is live, the turn's own held
  // action already holds the glass. Babysitting is Sotto's own claim, the weakest, and steps aside while a turn runs.
  const confirmed = liveMonitors.length > 0 || liveWork.length > liveCommands.length
  const held = useHeldAction(thread, ornamentAllowed && !confirmed, now)
  const pose = ornamentPose({ monitoring: liveMonitors.length > 0, agents: liveWork.length > liveCommands.length, held: held !== undefined,
    commands: liveCommands.length > 0, babysitting: ornamentAllowed && (thread.babysitting?.length ?? 0) > 0, running: thread.status === 'running' })
  const ornament = pose === 'monitoring' ? <ThreadMonitor key={`monitor:${thread.id}`} tasks={liveMonitors} />
    : pose === 'working' ? <ThreadWorking key={`working:${thread.id}`} work={liveWork} />
    : pose === 'held' && held !== undefined ? <ThreadHeld key={`held:${thread.id}`} action={held} now={now} />
    : pose === 'waiting' ? <ThreadWaitingCommand key={`command:${thread.id}`} commands={liveCommands} now={now} />
    : pose === 'babysitting' ? <ThreadBabysitting key={`babysitting:${thread.id}`} thread={thread} now={now} />
    : undefined
  const composing = paneHasDraft
  const capabilities = capabilitiesForThread(state.host, thread)
  /** This thread's own lane. Work on another thread leaves every control here live. */
  const threadBusy = isThreadBusy(state, thread.id)
  const reconnect = row.providerId && state.host.providers ? { provider: row.providerId } : {}
  // A send that failed or went unconfirmed is already told by its pending message in this thread; other errors still show.
  const deliveryExplains = error !== null && submissions.some(item => item.threadId === thread.id && item.error === error
    && ['failed', 'uncertain'].includes(submissionStatus(item, state).status))
  // A refused answer is told in its request card, where it can be answered again; the banner would say it twice.
  const answerExplains = useSyncExternalStore(requestAnswerStore.subscribe,
    () => error !== null && thread.requests.some(request => requestAnswerStore.get(requestAnswerOwnerKey(thread.id, request,
      { kind: 'thread', ownerId: thread.id, providerId: row.providerId ?? state.configuration.provider }), request.id).error === error))
  // A settings change the provider refused or never answered is told under the option chips; the banner would say it twice.
  const settings = usePendingSettings(thread.id)
  const settingsExplains = error !== null && (Object.values(settings.refusals).some(refusal => refusal?.error === error)
    || Object.values(settings.pending).some(pending => pending?.error === error))
  /** A branch switched in a terminal leaves no activity behind, so a draft that begins re-reads the folder once. */
  const branchRead = useRef<string | null>(null)
  const worktreeReady = thread.worktree?.status === 'ready' || (!thread.worktree && thread.nativeSessionStarted !== false)
  useEffect(() => {
    if (!composing) { branchRead.current = null; return }
    if (!worktreeReady || branchRead.current === thread.id) return
    branchRead.current = thread.id
    void command({ type: 'refresh-thread-worktree', threadId: thread.id, background: true })
  }, [composing, worktreeReady, thread.id, command])
  // Coming back from a terminal is the other moment a switch made elsewhere can show; the window regaining
  // focus re-reads the folder once, so the label follows without a keystroke or a send. Both are the window's own reads,
  // not the user's, so GitHub is asked about the pull request only as the timer would ask it (#820).
  useEffect(() => {
    if (!worktreeReady) return
    const onFocus = (): void => { void command({ type: 'refresh-thread-worktree', threadId: thread.id, background: true }) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [worktreeReady, thread.id, command])
  const { settle: settleThread, dialog: settleDialog } = useSettleThread(command)
  /* Renaming is Sotto's own record of the thread: it neither waits for a running turn nor tells the provider. */
  const naming: PaneMenuItem[] = [
    ...(!isThreadArchived(thread) && !renaming ? [{ id: 'rename', label: 'Rename', icon: <Pencil size={15} aria-hidden="true" />, run: () => { renameReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setRenaming(true) } }] : []),
    // The thread's own provider writes the name from its first exchange (ADR-0026); a name typed by hand is left
    // alone and offers no rewrite, and neither does a Devin thread, whose provider writes nothing.
    ...(!isThreadArchived(thread) && !renaming && thread.titleSource !== 'user' && providerWritesShortText(thread.providerId)
      ? [{ id: 'regenerate', label: 'Regenerate title', icon: <Sparkles size={15} aria-hidden="true" />, disabled: threadBusy, run: () => void command({ type: 'regenerate-thread-title', threadId: thread.id }) }] : []),
    ...(onOpenBeside ? [{ id: 'beside', label: 'Open beside', icon: <Columns2 size={15} aria-hidden="true" />, run: onOpenBeside }] : []),
  ]
  // Compaction is offered where it can run: the banner under the composer only ever recommends it.
  const context: PaneMenuItem[] = compactionOffered(capabilities, thread) && rowConnected && !closed && !compactionBusy(thread, threadBusy)
    ? [{ id: 'compact', label: 'Compact context', icon: <Shrink size={15} aria-hidden="true" />, run: () => void command({ type: 'compact-thread', threadId: thread.id }) }] : []
  const shelf: PaneMenuItem[] = row.settledBy === null
    ? [{ id: 'settle', label: 'Settle', icon: <Archive size={15} aria-hidden="true" />, disabled: threadBusy, run: () => void settleThread(thread, row.project) }]
    : row.settledBy === 'thread'
      ? [{ id: 'restore', label: 'Restore', icon: <ArchiveRestore size={15} aria-hidden="true" />, disabled: threadBusy, run: () => void command({ type: 'restore-thread', threadId: thread.id }) }] : []
  const recovery: PaneMenuItem[] = [
    ...(!rowConnected ? [{ id: 'reconnect', label: 'Reconnect', icon: <Plug size={15} aria-hidden="true" />, disabled: state.connection === 'connecting', run: () => void command({ type: 'connect', ...reconnect }) }] : []),
  ]
  const focusAnswerComposer = (): void => { document.getElementById(promptId)?.focus() }
  return <>
    {ownPane ? watcherHeader : <header className="thread-workspace__head">
      <div className="thread-workspace__title">
        <ProviderMark provider={row.providerId} name={row.provider} size={16} />
        {watched ? <WatchedBadge size={16} /> : null}
        {renaming
          ? <h2><ThreadNameField title={thread.title} label={`Rename ${thread.title}`} className="thread-workspace__rename tt-focusable"
            onRename={next => void command({ type: 'rename-thread', threadId: thread.id, title: next })} onDone={restore => { restoreRenameFocus.current = restore; setRenaming(false) }} /></h2>
          : <h2>{thread.title}</h2>}
        <span className="thread-workspace__crumb" data-has-working-copy={Boolean(workingCopy) || undefined}><span>{row.project?.title ?? row.provider}</span>{workingCopy}
          {row.settledBy === 'thread' || row.settledBy === 'project' ? <span className="thread-workspace__tag">Settled</span> : null}
          {!rowConnected ? <span className="thread-workspace__tag" data-tone="warning">{row.provider} disconnected</span> : null}
        </span>
      </div>
      <div className="thread-workspace__actions">
        {/* Watch, pressed while Watcher watches this thread (Owl only; nothing without Watcher's bridge). */}
        {thread.kind === 'watcher' || thread.kind === 'watcher-history' ? null : <WatchHeaderToggle threadId={thread.id} title={thread.title} />}
        {/* T3's Git action: the quick action its status decides, the chevron with the rest (ADR-0027). */}
        {!closed ? <GitActionButton thread={thread} command={command} noticeSlot={gitNoticeSlot} onExplainedError={setGitExplained} /> : null}
        {actions}
        <PaneMenu groups={[naming, context, shelf, recovery]} />
      </div>
      {onClose ? <button type="button" className="pane-action thread-pane__close tt-focusable" data-pane-close aria-label={`Close ${thread.title} pane`} title="Close pane" onClick={onClose}><X size={16} aria-hidden="true" /></button> : null}
    </header>}
    {settleDialog}
    {thread.historySaveNotice ? <p className="agent-error thread-workspace__error" role="alert">{thread.historySaveNotice}</p> : null}
    {thread.requestNotice ? <p className="agent-error thread-workspace__error" role="alert">{thread.requestNotice}</p> : null}
    {error && error !== thread.requestNotice && !deliveryExplains && !answerExplains && !settingsExplains && error !== toolbarExplained && error !== gitExplained ? <p className="agent-error thread-workspace__error" role="alert">{error}</p> : null}
    {ownPane && watcherBody != null ? <div className="thread-transcript">
      {watcherBody}
      <ThreadRequests kind="permission" row={row} state={state} command={command} blocked={threadBusy ? 'Waiting for Sotto…' : !rowConnected ? `Reconnect ${row.provider} to answer.` : null}
        onAnswer={focusAnswerComposer} />
    </div> : <ThreadWebLinks threadId={thread.id} threadTitle={thread.title} focused={focused}><ThreadTranscript row={row} state={state} command={command} store={store} followSignal={followSignal} watcher={ownPane} greetingSlot={greetingSlot}>
      <ThreadRequests kind="permission" row={row} state={state} command={command} blocked={threadBusy ? 'Waiting for Sotto…' : !rowConnected ? `Reconnect ${row.provider} to answer.` : null}
        onAnswer={focusAnswerComposer} />
      {!isThreadClosed(thread) && !thread.remoteHost && !ownPane ? <CloudIphoneRequest threadId={thread.id} threadTitle={thread.title} onAnswer={focusAnswerComposer} /> : null}
      {/* Answers saved for questions no live card shows, such as ones the provider closed while Sotto was shut. */}
      <RequestDraftRecovery owner={{ kind: 'thread', ownerId: thread.id, providerId: row.providerId ?? state.configuration.provider }}
        live={closed ? [] : thread.requests} provider={row.provider}
        observation={state.connection === 'connecting' ? 'loading' : !rowConnected ? 'disconnected' : thread.historyStatus === 'loading' ? 'loading' : thread.historyStatus === 'error' ? 'unavailable' : 'ready'}
        observed={JSON.stringify([rowConnected, state.connection, thread.historyStatus, thread.status, closed, thread.requests.map(request => [request.id, request.delivery, request.questions])])} />
    </ThreadTranscript></ThreadWebLinks>}
    <div className="thread-greeting-slot" ref={setGreetingSlot} />
    <div className="thread-workspace__compose" ref={compose}>
      {/* What a Watch or Stop watching press did, just above the focused pane's composer (Owl only). */}
      {focused ? <WatchToast /> : null}
      {notice}
      <div className="git-action-notice-slot" ref={setGitNoticeSlot} />
      {/* The branch under this thread moved since its last send. Nothing is refused; the notice waits for a draft to continue. */}
      {/* Watcher keeps to its own folder; it switches no working copy (ADR-0073). */}
      {ownPane ? null : <ThreadBranchNotice thread={thread} project={row.project} command={command} composing={composing} />}
      <ThreadRequests kind="question" row={row} state={state} command={command} blocked={threadBusy ? 'Waiting for Sotto…' : !rowConnected ? `Reconnect ${row.provider} to answer.` : null}
        onAnswer={focusAnswerComposer} />
      <ThreadComposer key={thread.id} ornament={ornament} row={row} state={state} command={command} store={store} composerId={promptId} focused={focused} onExplainedError={setToolbarExplained} onSend={() => { liftComposer(); setFollowSignal(signal => signal + 1) }}
        watcher={ownPane} />
      {/* The row under the composer is compaction's alone. Side by side it keeps one line even when compaction has
          nothing to say, so panes keep their composers at the same height whether or not one has been compacted. */}
      <div className="thread-pane__meta">
        {/* Said before a send, not after: what watching means here, and Stop watching. */}
        {ownPane ? null : <WatchedNote threadId={thread.id} title={thread.title} />}
        <ThreadCompaction thread={thread} supported={compactionOffered(capabilities, thread)}
          connected={rowConnected && !closed} blocked={threadBusy} command={command} />
      </div>
    </div>
    {/* Under a greeting, the room below the composer matches the room above, so the two sit in the middle. */}
    <div className="thread-pane__balance" aria-hidden="true" />
    {drawer}
  </>
}
