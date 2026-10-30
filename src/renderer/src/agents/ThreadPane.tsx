import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { useMark } from '../components/marks'
import { Archive, ArchiveRestore, ArrowRightLeft, Columns2, CornerDownRight, FolderGit2, Pencil, Plug, Shrink, Sparkles, X } from 'lucide-react'
import { capabilitiesForThread, isThreadBusy, providerWritesShortText, type AgentState } from '../../../shared/agents'
import { isThreadArchived, isThreadClosed, isThreadTurnRunning, threadOrnamentAllowed } from '../../../shared/threadActivity'
import { continueThreadRefusal } from '../../../shared/continueThread'
import { ThreadNameField } from './ThreadName'
import type { AgentConnection } from './AgentContext'
import type { PaneMenuItem } from './PaneMenu'
import { ThreadPaneMenu } from './ThreadPaneMenu'
import type { PaneChrome, PaneClose } from './ThreadPanes'
import { GitActionButton, type GitActionHandle } from './GitActionButton'
import { quickAction } from './gitActionButton.logic'
import { claimedThreadChord, threadChordLabel } from './threadShortcuts'
import { useOptionalApp } from '../state/AppContext'
import { ProviderMark } from './ProviderMark'
import { AgentRequestCard } from './requests/AgentRequestCard'
import { messageLinks } from './requests/messageLinks'
import { CloudIphoneRequest } from './requests/CloudIphoneRequest'
import { PrototypeReady } from './requests/PrototypeReady'
import { RequestDraftRecovery } from './requests/RequestDraftRecovery'
import { requestAnswerOwnerKey, requestAnswerStore } from './requests/requestAnswers'
import { threadRequestBlocked, threadRequestCheck, threadRequestOwner, threadRequestSubmit } from './requests/threadRequests'

export { checkedOnConnectedHost } from './requests/threadRequests'
import { useWatcherEnabled } from '../state/watcherFeature'
import { ThreadComposer } from './ThreadComposer'
import { useRestartStopped } from './RestartStopped'
import { FailedTurnNotice, failedTurnExplanation } from './FailedTurnNotice'
import { isThreadFailureText } from '../../../shared/threadFailures'
import { usePendingSettings } from './pendingSettings'
import { hasDraftContent, submissionStatus, useSubmissions, type ThreadDraftStore } from './threadDraftStore'
import { ThreadBranchNotice, useSettleThread } from './ThreadWorkingCopy'
import { useDeleteThread } from './DeleteThread'
import type { ThreadRow } from './threadFacts'
import { ThreadTranscript } from './ThreadTranscript'
import { ThreadWebLinks } from '../tools/webLinks'
import { RunCommands } from '../tools/runCommand'
import { ThreadBabysitting, ThreadMonitor, ThreadHeld, ThreadWaitingCommand, ThreadWorking, useHeldAction } from './ThreadMonitor'
import { ornamentPose } from './threadActivityView'
import { LardoTurns } from './Lardo'
import { useCreature } from '../state/creature'
import { compactionBusy, compactionOffered, ThreadCompaction } from './ThreadCompaction'
import { useWatchedThread } from '../watcher/watcherRoom'
import { WatchedBadge } from '../watcher/WatcherOwl'
import { WatchHeaderToggle, WatchToast } from '../watcher/WatchControls'
import { prefersReducedMotion } from '../state/reducedMotion'
import { DelegatedBy, DelegationComposerNote } from './DelegatedWork'
import { ContinueComposerNote, ContinueNow } from './ContinueThread'
import { continueChoiceFor, continueModels, continueStore, providerDefaults, useContinueEnabled } from './continuations'
import { useOwlFeature } from '../state/owlFeature'
import { composerSlim, slimMoving, useSlimMotion } from './slimComposer'
import { isPutAway, moveSheetStore, useMoveMachines, useMovesOffered } from '../watcher/MoveThreads'

type Command = AgentConnection['command']

/** A press inside the title that belongs to a control there, not to the pane's handle. */
const INSIDE_CONTROL = 'button, input, textarea, select, a, [contenteditable], [role="menu"]'
/** A pane outside the Threads workspace's pane area: no layout rows, no close of its own, no handle. */
const NO_CHROME: PaneChrome = { layout: [] }

/** How long a send may take to empty the greeting and still carry the composer down with it. */
const LIFT_WINDOW_MS = 2_000

/** Where the composer stood when a send left the greeting, so it can settle from there rather than jump. */
interface Lift { readonly at: number; readonly top: number; readonly left: string; readonly right: string }

/**
 * A new thread holds its greeting and composer in the middle of the pane. When a send from this pane empties the
 * greeting, the composer slides from where it stood to its place at the bottom and widens as it goes; with motion
 * reduced it is simply there. A greeting emptied any other way, such as a message from the phone, moves at once.
 */
function useComposerLift(slot: HTMLElement | null, compose: React.RefObject<HTMLDivElement | null>, threadId: string): () => void {
  const lift = useRef<Lift | null>(null)
  const slide = useRef<Animation | undefined>(undefined)
  // The pane is reused for the next thread. Its composer forgets a send the last thread never started, before the
  // emptied slot is heard, and stops a slide still under way.
  useLayoutEffect(() => () => { lift.current = null; slide.current?.cancel(); slide.current = undefined }, [threadId])
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
      slide.current = element.animate?.([
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
 * From the top of the first thing drawn in the composer to its foot: what of it shows, slim or full. Read from the layout
 * rather than the screen, so the card's move between the two does not count.
 */
function shownHeight(compose: HTMLElement): number {
  let top = compose.offsetHeight
  for (const child of compose.children) {
    if (!(child instanceof HTMLElement) || child.offsetHeight === 0) continue
    // The card's top margin is the creature's room above it.
    top = Math.min(top, child.offsetTop - (parseFloat(getComputedStyle(child).marginTop) || 0))
  }
  return Math.max(0, compose.offsetHeight - top)
}

/**
 * The composer floats over the transcript's foot: the pane learns its height, so the transcript keeps a steady scroll
 * box and a readable edge above the card. While the composer is slim (ADR-0125) it keeps that room, so the
 * transcript neither moves nor changes size; the pane learns how much of it shows, for the Jump button, and keeps the
 * card's full height, which Watcher's night scene lays out by. While the card moves between the two the composer keeps
 * that room too (slimComposer.ts), and nothing is read until the card has settled.
 */
function useComposerFloat(compose: React.RefObject<HTMLDivElement | null>, slim: boolean): () => void {
  const measure = useRef<() => void>(() => undefined)
  useLayoutEffect(() => {
    const element = compose.current
    const pane = element?.parentElement
    if (!element || !pane || typeof ResizeObserver === 'undefined') return
    measure.current = () => {
      const card = element.querySelector<HTMLElement>(':scope > .thread-prompt')
      if (card != null && slimMoving(card)) return
      // The composer's height to the fraction of a pixel, as it is laid out. The transcript fills what the composer's room
      // leaves, so a room rounded up past the composer, as whole pixels at 150% display scaling can be, runs the transcript
      // past the pane's foot and gives the pane a scroll bar of its own.
      pane.style.setProperty('--thread-compose-measured', `${element.getBoundingClientRect().height}px`)
      pane.style.setProperty('--thread-compose-shown', `${shownHeight(element)}px`)
      if (card != null && !element.hasAttribute('data-slim')) {
        // The full card's height and how far its foot stands above the composer's, to the fraction of a pixel, so
        // Watcher's night scene keeps the card's place exactly while it is slim, whatever the row under it does.
        const box = card.getBoundingClientRect()
        pane.style.setProperty('--thread-prompt-full', `${box.height}px`)
        pane.style.setProperty('--thread-prompt-foot', `${element.getBoundingClientRect().bottom - box.bottom}px`)
      }
    }
    const observer = new ResizeObserver(() => measure.current())
    // The border box: a short pane changes only the composer's padding, which its content box does not see.
    observer.observe(element, { box: 'border-box' })
    return () => {
      observer.disconnect()
      measure.current = () => undefined
      for (const name of ['--thread-compose-measured', '--thread-compose-shown', '--thread-prompt-full', '--thread-prompt-foot']) pane.style.removeProperty(name)
    }
  }, [compose])
  // Slim or full, the composer's own box keeps its height; what shows of it changes.
  useLayoutEffect(() => { measure.current() }, [slim])
  return useCallback(() => measure.current(), [])
}

/**
 * The thread's pending requests, each answered by its own ID through the one store every surface sends by
 * (ADR-0135). A plain question points at the composer; everything the provider structured is answered in place.
 */
function ThreadRequests({ row, state, command, onAnswer, kind }: {
  readonly row: ThreadRow; readonly state: AgentState; readonly command: Command; readonly onAnswer: () => void; readonly kind: 'question' | 'permission'
}): ReactNode {
  // What this window answered is kept for Watcher's lines alone, so only where Watcher is on (ADR-0072).
  const watcherOn = useWatcherEnabled()
  const thread = row.thread
  const requests = thread.requests.filter(request => request.kind === kind)
  const shown = !isThreadClosed(thread) && requests.length > 0
  useMark('questions', kind === 'question' && shown)
  if (!shown) return null
  const blocked = threadRequestBlocked(row, state)
  return <div className={kind === 'question' ? 'thread-questions' : undefined}>{requests.map(request => {
    return <AgentRequestCard placement={kind === 'question' ? 'composer' : undefined} key={request.id} ownerId={thread.id} ownerTitle={thread.title} request={request} blocked={blocked}
      messageLinks={kind === 'question' ? messageLinks(thread.messages) : []}
      draftOwner={threadRequestOwner(row, state)}
      onWriteAnswer={onAnswer}
      onSubmit={threadRequestSubmit(command, thread, request, watcherOn)}
      onCheck={() => threadRequestCheck(command, thread.id)} />
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
  /** Present beside Watcher: closes this view only. In the Threads workspace, a split's close comes with `chrome`. */
  readonly onClose?: (() => void) | undefined
  /**
   * What the Threads workspace's pane area hands the header (ADR-0163): Zoom pane, the arrangement and Move pane for the
   * ··· menu, the close in a split, and the title as the handle that moves the pane. Absent beside Watcher.
   */
  readonly chrome?: PaneChrome | undefined
  /** The ··· menu lists Tools: the focused pane in the Threads workspace. */
  readonly tools?: boolean | undefined
  /** The ··· menu lists the pane's own Terminal drawer. */
  readonly terminal?: boolean | undefined
  /** The working-copy control, placed after the project title in the header. */
  readonly workingCopy?: ReactNode
  /** Placed after Watch, before the ··· menu: beside Watcher, Open in Threads. */
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
  /** In Watcher's own pane, what its conversation says while empty, in place of the plain empty line (a new Watcher's note). */
  readonly watcherEmpty?: ReactNode
}

/**
 * One thread's view: header and controls, its own transcript position and its own composer.
 * Everything here acts on `row.thread.id`; a split workspace mounts one per open thread.
 */
export function ThreadPane({ row, state, command, store, focused, promptId, error, onClose, chrome, tools = false, terminal = false, onOpenBeside, workingCopy, actions, notice, drawer, now, watcherHeader, watcherEmpty }: ThreadPaneProps): ReactNode {
  const { t } = useLingui()
  const app = useOptionalApp()
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
  const [branchSlot, setBranchSlot] = useState<HTMLSpanElement | null>(null)
  /** Where a new thread's greeting stands, directly above the composer. */
  const [greetingSlot, setGreetingSlot] = useState<HTMLElement | null>(null)
  const compose = useRef<HTMLDivElement>(null)
  const liftComposer = useComposerLift(greetingSlot, compose, row.thread.id)
  const submissions = useSubmissions(store)
  // The pane only needs to know whether a draft exists. Subscribing to its text
  // re-renders the transcript and header synchronously on every keystroke.
  const paneHasDraft = useSyncExternalStore(store.subscribe, () => hasDraftContent(store.draft(row.thread.id)))
  const thread = row.thread
  // Watcher's own pane carries its own header and composer; it is never itself a watched thread.
  const ownPane = watcherHeader !== undefined
  // The slim composer (ADR-0125; Owl only, and in Watcher's pane only with Watcher on): one line while the user reads
  // back, full again at the end, on focus or with a draft. The transcript tells the pane only when the reader crosses.
  const watcherOn = useWatcherEnabled()
  const slimOn = useOwlFeature('composer-shrink') && (watcherOn || !ownPane)
  const [readingBack, setReadingBack] = useState(false)
  const [composeFocused, setComposeFocused] = useState(false)
  const slim = composerSlim({ enabled: slimOn, readingBack, focused: composeFocused, draft: paneHasDraft,
    questionWaits: !isThreadClosed(thread) && thread.requests.some(request => request.kind === 'question') })
  // The pane wears the slim composer as a mark, for the Jump button above it.
  useMark('slim', slim)
  // The pane measures the composer's new shape before the card starts moving to it.
  const measureCompose = useComposerFloat(compose, slim)
  useSlimMotion(compose, slim, measureCompose)
  const watched = useWatchedThread(thread.id) && !ownPane
  const closed = isThreadClosed(thread)
  const rowConnected = row.connected
  const ornamentAllowed = threadOrnamentAllowed(thread, rowConnected)
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
  // Restarting stopped threads (ADR-0144; Owl only) takes babysitting away, and its pose with it.
  const babysitShown = !useRestartStopped()
  const pose = ornamentPose({ monitoring: liveMonitors.length > 0, agents: liveWork.length > liveCommands.length, held: held !== undefined,
    commands: liveCommands.length > 0, babysitting: babysitShown && ornamentAllowed && (thread.babysitting?.length ?? 0) > 0, running: thread.status === 'running' })
  const staged = pose === 'monitoring' ? <ThreadMonitor key={`monitor:${thread.id}`} tasks={liveMonitors} />
    : pose === 'working' ? <ThreadWorking key={`working:${thread.id}`} work={liveWork} />
    : pose === 'held' && held !== undefined ? <ThreadHeld key={`held:${thread.id}`} action={held} now={now} />
    : pose === 'waiting' ? <ThreadWaitingCommand key={`command:${thread.id}`} commands={liveCommands} now={now} />
    : pose === 'babysitting' ? <ThreadBabysitting key={`babysitting:${thread.id}`} thread={thread} now={now} />
    : undefined
  // Lardo flexes when a turn finishes while he is up; only he is wrapped to hear it, and only where the build offers him.
  const lardo = useCreature() === 'lardo'
  const ornament = staged !== undefined && lardo ? <LardoTurns running={isThreadTurnRunning(thread)}>{staged}</LardoTurns> : staged
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
      threadRequestOwner(row, state)), request.id).error === error))
  // A settings change the provider refused or never answered is told under the option chips; the banner would say it twice.
  const settings = usePendingSettings(thread.id)
  const settingsExplains = error !== null && (Object.values(settings.refusals).some(refusal => refusal?.error === error)
    || Object.values(settings.pending).some(pending => pending?.error === error))
  // Why the last turn failed is said once (ADR-0092): by its line in the transcript when that carries the reason,
  // otherwise by the notice above the composer. While either explains it, a banner about a thread failing, this one's or
  // another's, stands down; one about the provider's own health still shows.
  const failure = failedTurnExplanation(thread, row.provider, row.providerId, error)
  const turnExplains = error !== null && failure !== null
    && (failure.kind === 'transcript' && failure.reason === error || isThreadFailureText(error, state.host.threads))
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
    ...(!isThreadArchived(thread) && !renaming ? [{ id: 'rename', label: t({ message: 'Rename', comment: 'Rename the thread.' }), icon: <Pencil size={15} aria-hidden="true" />, run: () => { renameReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setRenaming(true) } }] : []),
    // The thread's own provider writes the name from its first exchange (ADR-0026); a name typed by hand is left
    // alone and offers no rewrite, and neither does a Devin thread, whose provider writes nothing.
    ...(!isThreadArchived(thread) && !renaming && thread.titleSource !== 'user' && providerWritesShortText(thread.providerId)
      ? [{ id: 'regenerate', label: t`Regenerate title`, icon: <Sparkles size={15} aria-hidden="true" />, disabled: threadBusy, run: () => void command({ type: 'regenerate-thread-title', threadId: thread.id }) }] : []),
  ]
  // Open beside leads the layout rows; Tools, the drawer and the pane area's rows follow it in ThreadPaneMenu.
  const beside: PaneMenuItem | undefined = onOpenBeside ? { id: 'beside', label: t`Open beside`, icon: <Columns2 size={15} aria-hidden="true" />, run: onOpenBeside } : undefined
  // Initialize Git, for a folder the host read as no repository: the ··· menu's row, pressed on the Git action so its
  // notice is the Git action's (ADR-0163). It was the Git action's button, and the only one-time control in the header.
  const gitAction = useRef<GitActionHandle>(null)
  const initialize: PaneMenuItem[] = !closed && quickAction(thread.worktree?.git)?.kind === 'init'
    ? [{ id: 'git-init', label: t`Initialize Git`, icon: <FolderGit2 size={15} aria-hidden="true" />, run: () => gitAction.current?.initialize() }] : []
  // Settle and Restore answer their keys for the focused thread wherever the Threads page has it; beside Watcher they do not.
  const platform = app?.platform ?? 'win32'
  const chordShown = (id: 'settle' | 'restore'): PaneMenuItem['shortcut'] => {
    const chord = chrome ? claimedThreadChord(app?.settings, id, platform) : null
    if (chord === null) return undefined
    const label = threadChordLabel(chord, platform)
    return { plain: label.plain, keys: label.keys }
  }
  // Compaction is offered where it can run: the banner under the composer only ever recommends it.
  const context: PaneMenuItem[] = compactionOffered(capabilities, thread) && rowConnected && !closed && !compactionBusy(thread, threadBusy)
    ? [{ id: 'compact', label: t`Compact context`, icon: <Shrink size={15} aria-hidden="true" />, run: () => void command({ type: 'compact-thread', threadId: thread.id }) }] : []
  const shelf: PaneMenuItem[] = row.settledBy === null
    ? [{ id: 'settle', label: t({ message: 'Settle', comment: 'Settle the thread: put it away on the Settled shelf.' }), icon: <Archive size={15} aria-hidden="true" />, disabled: threadBusy, shortcut: chordShown('settle'), run: () => void settleThread(thread, row.project) }]
    : row.settledBy === 'thread'
      ? [{ id: 'restore', label: t({ message: 'Restore', comment: 'Restore a settled thread to open work.' }), icon: <ArchiveRestore size={15} aria-hidden="true" />, disabled: threadBusy, shortcut: chordShown('restore'), run: () => void command({ type: 'restore-thread', threadId: thread.id }) }] : []
  // Continue on another provider (ADR-0089; Owl only): the composer begins it, with the model picker open on the other providers.
  const continueOn = useContinueEnabled() && !ownPane && thread.nativeSessionStarted !== false && thread.remoteHost !== true && !isThreadArchived(thread)
    && thread.kind !== 'watcher' && thread.kind !== 'watcher-history'
  const continueTargets = continueOn ? providerDefaults(state, continueModels(state, thread)) : []
  const continueRefusal = continueOn ? continueThreadRefusal(thread) : null
  const continuing: PaneMenuItem[] = continueTargets.length > 0 ? [{ id: 'continue', label: t`Continue on another provider…`, icon: <CornerDownRight size={15} aria-hidden="true" />,
    disabled: continueRefusal !== null, ...(continueRefusal !== null ? { hint: continueRefusal } : {}),
    run: () => { continueStore.set(thread.id, { ...continueChoiceFor(state, thread, continueTargets[0]!.id, continueStore.get(thread.id)), pick: true }) } }] : []
  // Continue on another machine… (#1178, Zach, October 29, 2026; Owl Work across machines), while Watcher runs: This
  // computer's threads while another machine is connected, and a connected host's, which can always come here (part 3).
  // It opens Move threads' sheet for this one thread.
  const moves = useMovesOffered()
  const remote = thread.remoteHost === true
  const moveOffered = moves !== undefined && !ownPane && !isPutAway(thread) && thread.kind !== 'watcher' && thread.kind !== 'watcher-history' && (!remote || thread.clientConnected !== false)
  const moveMachines = useMoveMachines(moveOffered)
  const moving: PaneMenuItem[] = moveOffered && (remote || moveMachines.some(machine => machine.connected))
    ? [{ id: 'move', label: t`Continue on another machine…`, icon: <ArrowRightLeft size={15} aria-hidden="true" />,
      run: () => { moveSheetStore.open({ kind: 'one', threadId: thread.id, title: thread.title, ...remote && thread.hostId ? { hostId: thread.hostId } : {} }) } }] : []
  const recovery: PaneMenuItem[] = [
    ...(!rowConnected ? [{ id: 'reconnect', label: t`Reconnect`, icon: <Plug size={15} aria-hidden="true" />, disabled: state.connection === 'connecting', run: () => void command({ type: 'connect', ...reconnect }) }] : []),
  ]
  // Delete thread… (ADR-0140; Owl only): a settled thread's last item, after its own rule, since it cannot be taken back.
  const { items: removal, dialog: deleteDialog } = useDeleteThread(row, state, command, { ownPane })
  const focusAnswerComposer = (): void => { document.getElementById(promptId)?.focus() }
  const title = thread.title, provider = row.provider
  const paneChrome = chrome ?? NO_CHROME
  const handle = paneChrome.handle
  const pressedControl = useRef(false)
  const close: PaneClose | undefined = paneChrome.close ?? (onClose ? { label: t({ message: `Close ${title} pane`, comment: '{title} is a thread\'s title.' }), title: t`Close pane`, keys: undefined, run: onClose } : undefined)
  // A key typed in the transcript is the start of a message: the composer takes it, and comes back full to show it.
  const typeAhead = slimOn ? focusAnswerComposer : undefined
  // Slim, the disc is pressed where it stands: focus would bring the composer back full and move the disc from under the
  // pointer before the press lands. A press anywhere else on the slim card puts the caret in it.
  const pressSlim = (event: React.MouseEvent): void => {
    const target = event.target as Element
    if (target.closest('.thread-prompt__actions button') !== null) { event.preventDefault(); return }
    if (target.closest('.thread-prompt') === null || target.closest('button, a, [contenteditable]') !== null) return
    event.preventDefault()
    focusAnswerComposer()
  }
  return <>
    {ownPane ? watcherHeader : <header className="thread-workspace__head">
      {/* The title, project and folder; while panes stand side by side it is the handle that moves the pane (ADR-0163).
          A press on a control inside it, such as the working copy, stays that control's. */}
      <div className="thread-workspace__title" data-pane-handle={handle ? '' : undefined} draggable={handle && !renaming ? true : undefined}
        onPointerDown={handle ? event => { pressedControl.current = (event.target as Element).closest(INSIDE_CONTROL) !== null } : undefined}
        onDragStart={handle ? event => { if (pressedControl.current || renaming) { event.preventDefault(); return } handle.start(event) } : undefined}
        onDragEnd={handle ? () => handle.end() : undefined}>
        <ProviderMark provider={row.providerId} name={row.provider} size={16} />
        {watched ? <WatchedBadge size={16} /> : null}
        {renaming
          ? <h2><ThreadNameField title={thread.title} label={t`Rename ${title}`} className="thread-workspace__rename tt-focusable"
            onRename={next => void command({ type: 'rename-thread', threadId: thread.id, title: next })} onDone={restore => { restoreRenameFocus.current = restore; setRenaming(false) }} /></h2>
          : <h2 title={thread.title}>{thread.title}</h2>}
        <span className="thread-workspace__crumb" data-has-working-copy={Boolean(workingCopy) || undefined}><span title={row.project?.title ?? row.provider}>{row.project?.title ?? row.provider}</span>{workingCopy}
          {row.settledBy === 'thread' || row.settledBy === 'project' ? <span className="thread-workspace__tag"><Trans>Settled</Trans></span> : null}
          {!rowConnected ? <span className="thread-workspace__tag" data-tone="warning">{t({ message: `${provider} disconnected`, comment: '{provider} is the provider\'s name, such as Codex.' })}</span> : null}
        </span>
        <span className="thread-workspace__branches" ref={setBranchSlot} />
      </div>
      {/* Pinned to the right in a fixed order, so nothing here moves as the pane narrows: the Git action (only while
          there is something to commit, push or open), Watch, the ··· menu and, in a split, close (ADR-0163). */}
      <div className="thread-workspace__actions">
        {/* T3's Git action: the quick action its status decides, the chevron with the rest (ADR-0027). */}
        {!closed ? <GitActionButton ref={gitAction} thread={thread} state={state} command={command} noticeSlot={gitNoticeSlot} onExplainedError={setGitExplained} /> : null}
        {/* Watch, pressed while Watcher watches this thread (Owl only; nothing without Watcher's bridge). */}
        {thread.kind === 'watcher' || thread.kind === 'watcher-history' ? null : <WatchHeaderToggle threadId={thread.id} title={thread.title} />}
        {actions}
        <ThreadPaneMenu threadId={thread.id} state={state} beside={beside} layout={paneChrome.layout} tools={tools} terminal={terminal}
          groups={[initialize, naming, [...continuing, ...moving], context, shelf, recovery, removal]} />
        {close ? <button type="button" className="pane-action thread-pane__close tt-focusable" data-pane-chrome data-pane-close aria-label={close.label}
          aria-keyshortcuts={close.keys} title={close.title} onClick={close.run}><X size={16} aria-hidden="true" /></button> : null}
      </div>
    </header>}
    {/* Delegated by the thread that started this one, a link back (ADR-0081; Owl only). */}
    {ownPane ? null : <DelegatedBy thread={thread} state={state} command={command} />}
    {settleDialog}
    {deleteDialog}
    {thread.historySaveNotice ? <p className="agent-error thread-workspace__error" role="alert">{thread.historySaveNotice}</p> : null}
    {thread.requestNotice ? <p className="agent-error thread-workspace__error" role="alert">{thread.requestNotice}</p> : null}
    {error && error !== thread.requestNotice && !deliveryExplains && !answerExplains && !settingsExplains && !turnExplains && error !== toolbarExplained && error !== gitExplained ? <p className="agent-error thread-workspace__error" role="alert">{error}</p> : null}
    <ThreadWebLinks threadId={thread.id} threadTitle={thread.title} focused={focused}>{/* A reply's commands run only in a pane with its own Terminal drawer, never a paired host's thread (ADR-0139; Owl only). */}<RunCommands threadId={thread.id} offered={drawer != null && !thread.remoteHost}><ThreadTranscript row={row} state={state} command={command} store={store} followSignal={followSignal} watcher={ownPane} greetingSlot={greetingSlot} emptyNote={ownPane ? watcherEmpty : undefined}
      onReadingBack={slimOn ? setReadingBack : undefined} onTypeAhead={typeAhead} onQuoted={focusAnswerComposer}>
      <ThreadRequests kind="permission" row={row} state={state} command={command} onAnswer={focusAnswerComposer} />
      {/* A turn stopped at its limit offers the other providers to continue on (ADR-0089; Owl only). */}
      {ownPane ? null : <ContinueNow thread={thread} state={state} onStart={focusAnswerComposer} />}
      {!isThreadClosed(thread) && !thread.remoteHost && !ownPane ? <CloudIphoneRequest threadId={thread.id} threadTitle={thread.title} onAnswer={focusAnswerComposer} /> : null}
      {/* Answers saved for questions no live card shows, such as ones the provider closed while Sotto was shut. */}
      <RequestDraftRecovery owner={{ kind: 'thread', ownerId: thread.id, providerId: row.providerId ?? state.configuration.provider }}
        live={closed ? [] : thread.requests} provider={row.provider}
        observation={state.connection === 'connecting' ? 'loading' : !rowConnected ? 'disconnected' : thread.historyStatus === 'loading' ? 'loading' : thread.historyStatus === 'error' ? 'unavailable' : 'ready'}
        observed={JSON.stringify([rowConnected, state.connection, thread.historyStatus, thread.status, closed, thread.requests.map(request => [request.id, request.delivery, request.questions])])} />
    </ThreadTranscript></RunCommands></ThreadWebLinks>
    <div className="thread-greeting-slot" data-room-backdrop="" ref={setGreetingSlot} />
    <div className="thread-workspace__compose" data-room-backdrop="" ref={compose} data-slim={slim || undefined} onMouseDown={slim ? pressSlim : undefined}
      onFocus={() => setComposeFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setComposeFocused(false) }}>
      {/* What a Watch or Stop watching press did, just above the focused pane's composer (Owl only). */}
      {focused ? <WatchToast /> : null}
      {notice}
      <FailedTurnNotice explanation={failure} />
      <div className="git-action-notice-slot" ref={setGitNoticeSlot} />
      {/* The branch under this thread moved since its last send. Nothing is refused; the notice waits for a draft to continue. */}
      {/* Watcher keeps to its own folder; it switches no working copy (ADR-0073). */}
      {ownPane ? null : <ThreadBranchNotice thread={thread} project={row.project} command={command} composing={composing} />}
      {/* A prototype waiting for review, with its pages to open (ADR-0108); a waiting question's card carries them instead. */}
      {ownPane ? null : <PrototypeReady thread={thread} />}
      <ThreadRequests kind="question" row={row} state={state} command={command} onAnswer={focusAnswerComposer} />
      <ThreadComposer key={thread.id} ornament={ornament} row={row} state={state} command={command} store={store} composerId={promptId} focused={focused} onExplainedError={setToolbarExplained} onSend={() => { liftComposer(); setFollowSignal(signal => signal + 1) }}
        watcher={ownPane} toolbarSlot={branchSlot}>
        {quiet => <div className="thread-pane__meta">
          {/* What Stop also stops, or what a turn here does to the thread that delegated (ADR-0081; Owl only). */}
          {ownPane ? null : <DelegationComposerNote thread={thread} state={state} hideStop={quiet} />}
          {/* Just continued elsewhere: this thread can still be sent to (ADR-0089; Owl only). */}
          {ownPane ? null : <ContinueComposerNote thread={thread} />}
          <ThreadCompaction thread={thread} supported={compactionOffered(capabilities, thread)}
            connected={rowConnected && !closed} blocked={threadBusy} command={command} />
        </div>}
      </ThreadComposer>
    </div>
    {/* Under a greeting, the room below the composer matches the room above, so the two sit in the middle. */}
    <div className="thread-pane__balance" data-room-backdrop="" aria-hidden="true" />
    {drawer}
  </>
}
