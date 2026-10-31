import React, { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { AppWindow, Archive, ArchiveRestore, ChevronRight, Columns2, Folder, FolderGit2, Gauge, GitBranch, Hourglass, MessageSquare, Pencil, Sparkles, SquarePen } from 'lucide-react'
import { AGENT_DISMISS_FAILURES_MAX, isThreadBusy, providerWritesShortText, type AgentState, type AgentThread } from '../../../shared/agents'
import type { SottoPlatform } from '../../../shared/platform'
import { useOptionalApp } from '../state/AppContext'
import { claimedThreadChord, fixedKeyFree, openBesidePressed, threadChordLabel, threadChordPressed, type ThreadChordLabel } from './threadShortcuts'
import { isThreadArchived } from '../../../shared/threadActivity'
import { countWorkingThreads, WORKING_THREADS_CAUTION, WORKING_THREADS_QUIET_MAX, workingThreadsLead } from '../../../shared/workingThreads'
import { ProviderMark } from './ProviderMark'
import { ThreadNameField } from './ThreadName'
import { describeWorkingCopy, useSettleThread } from './ThreadWorkingCopy'
import { useSidebarSize } from './sidebarSize'
import type { AgentConnection } from './AgentContext'
import { ProjectSettleAction, SidebarFrame } from './SidebarFrame'
import { holdSettledRows, rowStatus, unseenFailures, workingLabel, type ProjectFolder, type ThreadRow, type WorkspaceOrganization } from './threadFacts'
import { THREAD_DRAG_TYPE } from './splitLayout'
import { HostBadge, hostIdOf, listedHosts, type ListedHost } from './HostBadge'
import { MainCheckoutLine } from './MainCheckoutLine'
import { useMainCheckoutLines } from './mainCheckoutLine.logic'
import { projectWorkingCopyDefaultKey } from '../../../shared/clientIdentity'
import type { ProjectMainCheckout } from '../../../shared/mainCheckout'
import { useInterfaceLanguageState } from '../state/interfaceLanguage'
import { useWatchActions, useWatchedThread, useWatchedThreadIds } from '../watcher/watcherRoom'
import { WATCHED_BY_WATCHER, WatchedBadge, WatcherOwl } from '../watcher/WatcherOwl'
import { WatchRowToggle } from '../watcher/WatchControls'
import { shownCount } from '../state/interfaceNumbers'
import { entryFailure, NeedsYouCard, NeedsYouQueue, popWords } from './NeedsYouQueue'
import { useOwlFeature } from '../state/owlFeature'
import { RestartBands, useRestartStopped } from './RestartStopped'
import { SwarmAngles, swarmAnglesByLead } from './SwarmAngles'
import type { PaneMenuItem } from './PaneMenu'
import { RowMenu, rowMenuPlace, rowMenuPressed, type RowMenuPlace } from './RowMenu'
import { ROVING_GROUP, ROVING_KEY, ROVING_TOGGLE, ROW_ACTIONS, useRovingList } from './rovingList'
import { useSettleGaps, type HeldGap } from './settleGap'
import { SettleToast } from './SettleToast'
import './workingThreadsLine.css'

export { useAddProject } from './addProject'

type Command = AgentConnection['command']
type Section = 'open' | 'settled'
type SettleThread = ReturnType<typeof useSettleThread>['settle']
/** Settle from the list: a pointer's press over the list holds the row's place while the pointer stays (ADR-0167). */
type ListSettle = (thread: Parameters<SettleThread>[0], project: Parameters<SettleThread>[1], row?: HTMLElement | null) => Promise<boolean>

/**
 * The working threads line (#1183, Zach's pick A from the prototype): while more than ten threads are working on this
 * computer, a quiet line under the search field says it may slow down or use its battery faster. Nothing is held back.
 * It is never dismissed and never announced, and it goes at ten or fewer. The collapsed rail does not show it.
 */
export function WorkingThreadsLine({ threads }: { readonly threads: AgentState['host']['threads'] }): ReactNode {
  const count = useMemo(() => countWorkingThreads(threads), [threads])
  if (count <= WORKING_THREADS_QUIET_MAX) return null
  return <p className="thread-nav__working tt-paragraph"><Gauge size={15} aria-hidden="true" /><span><strong>{workingThreadsLead(count)}</strong> {WORKING_THREADS_CAUTION}</span></p>
}

/** "3 waiting on you": threads that need the user. */
const waitingOnYou = (needs: number): string => plural(needs, { other: `${{ needing: shownCount(needs) }} waiting on you` })
/** "2 working": threads whose agent is working. */
const workingCount = (working: number): string => plural(working, { other: `${{ workingThreads: shownCount(working) }} working` })

function Indicators({ working, needs, id, hidden = false }: { readonly working: number; readonly needs: number; readonly id?: string; readonly hidden?: boolean }): ReactNode {
  // Subscribes, so the counts' words follow a change of language.
  useInterfaceLanguageState()
  if (!working && !needs) return null
  // While Needs you stands (ADR-0135) the dots are not drawn, but the toggle keeps naming what waits behind it.
  if (hidden) return <span id={id} className="tt-visually-hidden">{[needs ? waitingOnYou(needs) : '', working ? workingCount(working) : ''].filter(Boolean).join(', ')}</span>
  return <span id={id} className="thread-nav__indicators">
    {needs ? <span data-state="needs" title={waitingOnYou(needs)}><i aria-hidden="true" /><span className="tt-visually-hidden">{waitingOnYou(needs)}</span></span> : null}
    {working ? <span data-state="working" title={workingCount(working)}><i aria-hidden="true" /><span className="tt-visually-hidden">{workingCount(working)}</span></span> : null}
  </span>
}

/**
 * A row's clock. A working row counts up once a second and writes its own text, the way the transcript's
 * clock does, so one running thread never re-renders the sidebar every second.
 */
export function RowTime({ row, live, id }: { readonly row: ThreadRow; readonly live: boolean; readonly id?: string }): ReactNode {
  const { t } = useLingui()
  const ref = useRef<HTMLTimeElement>(null)
  const since = live && row.state === 'working' ? row.workingSince : Number.NaN
  useEffect(() => {
    if (!Number.isFinite(since)) return
    const tick = (): void => { if (ref.current) ref.current.textContent = workingLabel(since, Date.now()) }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [since])
  const at = Number.isFinite(row.activityAt) ? new Date(row.activityAt) : null
  return <time ref={ref} id={id} className="thread-nav__time" title={at === null ? t`Last activity unavailable` : at.toLocaleString()} dateTime={at?.toISOString()}>{row.when}</time>
}

/** What the workspace offers a sidebar row beyond opening it: a place beside the focused thread. */
export interface PaneActions {
  /** The focused pane's thread; a row can open beside it. */
  readonly currentThreadId: string | null
  /**
   * The row marked current: the focused thread's own, or for a delegated thread, which has no row, the top of its
   * delegation (ADR-0081). Pane actions still go by `currentThreadId`. Absent, the focused thread's own row.
   */
  readonly listedThreadId?: string | null | undefined
  /** Threads open in the workspace, the focused one included. */
  readonly openThreadIds: readonly string[]
  readonly onOpenBeside: (threadId: string) => void
  /** A row started (thread ID) or finished (null) being dragged toward the workspace. */
  readonly onDragThread: (threadId: string | null) => void
  /** Open beside's chord (Settings › Keyboard, ADR-0133) and its label; absent where the user removed it or dictation owns it. */
  readonly openBesideChord?: { readonly chord: string; readonly platform: SottoPlatform; readonly label: ThreadChordLabel } | undefined
  /** Settle's and Restore's labels, for their row buttons' titles; the chords act on the focused thread, so a row claims keys only while it is that thread. */
  readonly settleShortcut?: ThreadChordLabel | undefined
  readonly restoreShortcut?: ThreadChordLabel | undefined
  /**
   * The thread list's own keys (ADR-0164) that dictation leaves free: F2 renames the focused row and Shift+F10 opens its
   * menu. The menu key and a right-click open it whatever dictation holds. Absent, both answer.
   */
  readonly rowKeys?: { readonly rename: boolean; readonly menu: boolean } | undefined
}

/** A menu row's keys, from a chord's label. */
const menuKeys = (label: ThreadChordLabel | undefined): PaneMenuItem['shortcut'] => label === undefined ? undefined : { plain: label.plain, keys: label.keys }

/** One tile on Owl's rail: what waits on you and what rests are told apart by position and by look. */
type RailItem = { readonly row: ThreadRow; readonly status: ReturnType<typeof rowStatus>; readonly waiting: boolean; readonly resting: boolean }

/** A rail tile's two letters: the first letters of the title's first two words, or a one-word title's first two. */
export function railMark(title: string): string {
  const [first = '', second] = title.trim().split(/\s+/)
  return first.slice(0, 1).toUpperCase() + (second === undefined ? first.slice(1, 2) : second.slice(0, 1)).toLowerCase()
}

/** The status ring a row and its rail tile share; a Done thread something will still wake shows an hourglass (variant d). */
function StatusRing({ row, finished, background }: { readonly row: ThreadRow; readonly finished: boolean; readonly background: boolean }): ReactNode {
  return <span className="thread-nav__ring" data-state={row.state} data-waiting={row.waitingFor ?? undefined} data-unseen={finished || undefined}
    data-background={background || undefined} data-disconnected={row.connected ? undefined : true} aria-hidden="true">
    {background ? <Hourglass size={10} strokeWidth={2.5} /> : null}
  </span>
}

/**
 * One thread in the sidebar. Memoised: with the state and the rows derived from it structurally shared, a
 * row whose thread the update did not touch keeps every prop it had and does not re-render. Its props stay
 * cheap to compare — no object or array is built for it here.
 */
const ThreadNavRow = memo(function ThreadNavRow({ row, current, open, busy, liveClock, onOpen, command, panes, settle, angles }: {
  readonly row: ThreadRow; readonly current: boolean; readonly open: boolean; readonly onOpen: (threadId: string) => void; readonly command: Command
  /** This thread's own lane is running a command. Another thread's work leaves this row's actions live. */
  readonly busy: boolean
  readonly liveClock: boolean
  readonly panes: PaneActions
  readonly settle: ListSettle
  /** This thread leads a swarm (Owl `worker-swarms`): its angles, listed under its row. */
  readonly angles?: readonly AgentThread[] | undefined
}): ReactNode {
  const { t } = useLingui()
  const title = row.thread.title
  // Prototype ready (ADR-0108), Just finished (ADR-0046) and Babysitting #74 (ADR-0061) stand where the row would say Done;
  // Restarts at 3:00 pm (ADR-0144; Owl only) stands where a stopped thread's failure line would be.
  const restartOn = useRestartStopped()
  const { text: status, finished, babysitting, prototype, background, restart } = rowStatus(row, { restart: restartOn })
  // Beside the focused pane's own thread, which a row marked current only for a delegated thread in the pane is not.
  const besideAvailable = panes.currentThreadId !== null && panes.currentThreadId !== row.thread.id
  const [renaming, setRenaming] = useState(false)
  // A finished rename hands the focus back to the row itself, the list's stop, wherever the rename was asked from.
  const rowButton = useRef<HTMLButtonElement>(null)
  const restoreRenameFocus = useRef(false)
  useLayoutEffect(() => {
    if (!renaming && restoreRenameFocus.current) { restoreRenameFocus.current = false; rowButton.current?.focus() }
  }, [renaming])
  // The row's menu (ADR-0164): closed, beside the row (Shift+F10, the menu key) or at a right-click's point.
  const [menu, setMenu] = useState<RowMenuPlace | null>(null)
  const rowItem = useRef<HTMLLIElement>(null)
  const watchActions = useWatchActions()
  // The button's name is the title alone; the state sentence is its description, or the label would swallow it.
  const statusId = useId()
  const timeId = useId()
  const detailsId = useId()
  const archived = isThreadArchived(row.thread)
  const copy = describeWorkingCopy(row.thread, row.project)
  const WorkingCopyIcon = copy.status === 'pending' || copy.status === 'error' ? FolderGit2 : copy.branch || copy.repositoryRoot ? GitBranch : Folder
  const branch = copy.status === 'ready' ? copy.branch : undefined
  const copyLabel = copy.status === 'error' ? t`Worktree not ready` : copy.status === 'pending' ? (copy.mode === 'independent' ? t`New worktree pending` : t`Project folder pending`) : copy.mode === 'independent' ? t`Worktree` : copy.mode === 'shared' ? t`Project folder` : copy.label
  const branchName = branch ?? (copy.status === 'ready' && copy.repositoryRoot ? t({ message: 'Detached HEAD', comment: 'Git\'s name for a checkout on no branch.' }) : copyLabel)
  // What follows a row's status while its provider is out of reach: Reconnecting while its host restarts for an update.
  const disconnected = row.connected ? '' : row.reconnecting ? ` · ${t`Reconnecting`}` : ` · ${t`Disconnected`}`
  const watched = useWatchedThread(row.thread.id)
  // A row that says it needs you for a thread it delegated names that thread (ADR-0081, October 17, 2026).
  const waitingIn = row.waitingIn
  const copyDetails = [...new Set([waitingIn ? t({ message: `Waiting in ${waitingIn}`, comment: '{waitingIn} is the title of a thread this one delegated to.' }) : undefined, row.thread.hostLabel, row.model?.name, branchName, copyLabel, watched ? WATCHED_BY_WATCHER : undefined].filter(Boolean))].join(', ')
  const swarm = angles === undefined ? null : <SwarmAngles lead={row.thread} angles={angles} currentThreadId={panes.currentThreadId} onOpen={onOpen} command={command} />
  const id = row.thread.id
  const canRename = !archived
  // A name the user typed is never written over, so this thread's own name is the one offered for rewriting.
  const canRegenerate = !archived && row.thread.titleSource !== 'user' && providerWritesShortText(row.thread.providerId)
  const canWatch = row.thread.kind !== 'watcher' && row.thread.kind !== 'watcher-history'
  // Settle's and Restore's keys act on the focused thread, so only that thread's row says them, as its buttons do.
  const shelfKeys = panes.currentThreadId === id
  const renameKey = panes.rowKeys?.rename ?? true
  // Each action once, for the menu and the hover icon alike, so the two cannot drift apart.
  const openBeside = (): void => panes.onOpenBeside(id)
  const regenerate = (): void => void command({ type: 'regenerate-thread-title', threadId: id })
  const settleRow = (): void => void settle(row.thread, row.project, rowItem.current)
  const restoreRow = (): void => void command({ type: 'restore-thread', threadId: id })
  // The row's actions in words, with the keys that do the same from the row: the hover icons' twin for the keyboard
  // and the right-click. Built only while the menu is open.
  const menuGroups = (): PaneMenuItem[][] => [
    [{ id: 'open', label: t({ message: 'Open', comment: 'A sidebar row\'s menu: open the thread in the focused pane.' }), icon: <MessageSquare size={15} aria-hidden="true" />, shortcut: { plain: 'Enter', keys: 'Enter' }, run: () => onOpen(id) },
      ...besideAvailable && !open ? [{ id: 'beside', label: t`Open beside`, icon: <Columns2 size={15} aria-hidden="true" />, shortcut: menuKeys(panes.openBesideChord?.label), run: openBeside }] : []],
    [...canRename ? [{ id: 'rename', label: t({ message: 'Rename', comment: 'Rename the thread.' }), icon: <Pencil size={15} aria-hidden="true" />, shortcut: renameKey ? { plain: 'F2', keys: 'F2' } : undefined, run: () => setRenaming(true) }] : [],
      ...canRegenerate ? [{ id: 'regenerate', label: t`Regenerate title`, icon: <Sparkles size={15} aria-hidden="true" />, disabled: busy, run: regenerate }] : [],
      ...canWatch && watchActions !== null ? [{ id: 'watch', label: t({ message: 'Watch', context: 'Put a thread under Watcher\'s watch' }), icon: <WatcherOwl size={15} />, shown: watched, run: () => void watchActions.setThread(id, !watched) }] : []],
    row.settledBy === null
      ? [{ id: 'settle', label: t({ message: 'Settle', comment: 'Settle the thread: put it away on the Settled shelf.' }), icon: <Archive size={15} aria-hidden="true" />, disabled: busy, shortcut: shelfKeys ? menuKeys(panes.settleShortcut) : undefined, run: settleRow }]
      : row.settledBy === 'thread'
        ? [{ id: 'restore', label: t({ message: 'Restore', comment: 'Restore a settled thread to open work.' }), icon: <ArchiveRestore size={15} aria-hidden="true" />, disabled: busy, shortcut: shelfKeys ? menuKeys(panes.restoreShortcut) : undefined, run: restoreRow }] : [],
  ]
  if (renaming) return <><li className="thread-nav__row" data-current={current || undefined} data-open={open && !current ? true : undefined}>
    <span className="thread-nav__item thread-nav__item--renaming">
      <ThreadNameField title={title} label={t`Rename ${title}`} className="thread-nav__rename tt-focusable"
        onRename={next => void command({ type: 'rename-thread', threadId: row.thread.id, title: next })} onDone={restore => { restoreRenameFocus.current = restore; setRenaming(false) }} />
    </span>
  </li>{swarm}</>
  return <><li ref={rowItem} className="thread-nav__row thread-nav__row--details" data-current={current || undefined} data-open={open && !current ? true : undefined}
    onContextMenu={event => { event.preventDefault(); rowButton.current?.focus(); setMenu(rowMenuPlace(event)) }}>
    <button ref={rowButton} type="button" className="thread-nav__item tt-focusable" aria-label={title} title={title} aria-describedby={[statusId, timeId, detailsId].join(' ')} aria-current={current ? 'page' : undefined} draggable
      aria-keyshortcuts={besideAvailable ? panes.openBesideChord?.label.keys : undefined} {...{ [ROVING_KEY]: `thread:${id}` }}
      onClick={event => { if (besideAvailable && (event.ctrlKey || event.metaKey)) panes.onOpenBeside(row.thread.id); else onOpen(row.thread.id) }}
      onKeyDown={event => {
        if (besideAvailable && panes.openBesideChord && openBesidePressed(event, panes.openBesideChord.chord, panes.openBesideChord.platform)) { event.preventDefault(); panes.onOpenBeside(row.thread.id); return }
        if (rowMenuPressed(event, panes.rowKeys?.menu ?? true)) { event.preventDefault(); setMenu('beside'); return }
        if (event.key === 'F2' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && canRename && renameKey) { event.preventDefault(); setRenaming(true) }
      }}
      onDragStart={event => { event.dataTransfer.setData(THREAD_DRAG_TYPE, row.thread.id); event.dataTransfer.effectAllowed = 'move'; panes.onDragThread(row.thread.id) }}
      onDragEnd={() => panes.onDragThread(null)}>
      <StatusRing row={row} finished={finished} background={background} />
      <span className="thread-nav__title">{title}</span>
      <RowTime row={row} live={liveClock} id={timeId} />
      <span id={detailsId} className="tt-visually-hidden">{copyDetails}</span>
      <span className="thread-nav__metadata">
        {/* The mark stands for the provider's name; the status below says the name for a screen reader, and hovering says it here. */}
        <span className="thread-nav__provider" title={[row.provider, row.model?.name].filter(Boolean).join(' · ')}>
          <span className="thread-nav__mark" data-provider={row.providerId}><ProviderMark provider={row.providerId} name={row.provider} /></span>
          {watched ? <WatchedBadge size={14} /> : null}
          <span className="thread-nav__model">{row.model?.name ?? ''}</span>
        </span>
        <span id={statusId} className="thread-nav__status" data-state={row.state} data-waiting={row.waitingFor ?? undefined} data-unseen={finished || undefined} data-babysitting={babysitting || undefined} data-prototype={prototype || undefined} data-restart={restart || undefined} data-disconnected={row.connected ? undefined : true} title={status + disconnected}><span className="tt-visually-hidden">{row.provider}, </span>{prototype ? <AppWindow size={12} aria-hidden="true" /> : null}{status}{disconnected}</span>
      </span>
      <span className="thread-nav__branch" data-working-copy-state={copy.status} title={branchName !== copyLabel ? `${branchName} · ${copyLabel}` : copyLabel}>
        <WorkingCopyIcon size={12} aria-hidden="true" />{row.thread.hostLabel ? <span>{row.thread.hostLabel} · </span> : null}
        <span className="thread-nav__branch-name">{branchName}</span>{branchName !== copyLabel ? <span className="thread-nav__copy-kind"> · {copyLabel}</span> : null}
      </span>
    </button>
    {/* The pointer's shortcuts to the row's menu. They leave the Tab order to the menu, which says the same in words. */}
    <span className="thread-nav__row-actions" {...{ [ROW_ACTIONS]: '' }}>
      {besideAvailable && !open ? <button type="button" className="thread-nav__action tt-focusable" tabIndex={-1} aria-label={t`Open ${title} beside`} title={panes.openBesideChord ? `${t`Open beside`} ${panes.openBesideChord.label.suffix}` : t`Open beside`} onClick={openBeside}><Columns2 size={16} aria-hidden="true" /></button> : null}
      {canRename ? <button type="button" className="thread-nav__action tt-focusable" tabIndex={-1} aria-label={t`Rename ${title}`} title={renameKey ? `${t`Rename thread`} (F2)` : t`Rename thread`} onClick={() => setRenaming(true)}><Pencil size={16} aria-hidden="true" /></button> : null}
      {canRegenerate
        ? <button type="button" className="thread-nav__action tt-focusable" tabIndex={-1} aria-label={t`Regenerate title for ${title}`} title={t`Regenerate title`} disabled={busy} onClick={regenerate}><Sparkles size={16} aria-hidden="true" /></button>
        : null}
      {/* The owl: Watch, pressed while Watcher watches this thread (Owl only; nothing without Watcher's bridge). */}
      {canWatch ? <WatchRowToggle threadId={row.thread.id} title={title} /> : null}
      {row.settledBy === null
        ? <button type="button" className="thread-nav__action tt-focusable" tabIndex={-1} aria-label={t`Settle ${title}`} title={panes.settleShortcut ? `${t`Settle thread`} ${panes.settleShortcut.suffix}` : t`Settle thread`} aria-keyshortcuts={shelfKeys ? panes.settleShortcut?.keys : undefined} disabled={busy} onClick={settleRow}><Archive size={16} aria-hidden="true" /></button>
        : row.settledBy === 'thread'
          ? <button type="button" className="thread-nav__action tt-focusable" tabIndex={-1} aria-label={t`Restore ${title}`} title={panes.restoreShortcut ? `${t`Restore thread`} ${panes.restoreShortcut.suffix}` : t`Restore thread`} aria-keyshortcuts={shelfKeys ? panes.restoreShortcut?.keys : undefined} disabled={busy} onClick={restoreRow}><ArchiveRestore size={16} aria-hidden="true" /></button>
          : null}
    </span>
    {menu !== null ? <RowMenu label={t`Actions for ${title}`} groups={menuGroups()} anchor={() => rowItem.current} place={menu}
      onClose={restore => { setMenu(null); if (restore) rowButton.current?.focus() }} /> : null}
  </li>{swarm}</>
})

/** A folder's key in the sidebar's toggled set; a project can appear in both sections. */
export const folderKey = (section: Section, folderId: string): string => `${section}:${folderId}`

/**
 * The folders the user toggled. Every folder starts closed when Sotto starts; what the user opens stays open while
 * the window lives, across pages that remount the sidebar, which is why it is kept in session storage. The e2e
 * harness starts them open, as it holds the clock still, so its journeys and design captures reach the rows.
 */
export const FOLDER_TOGGLES_KEY = 'sotto.threadWorkspace.folderToggles'
const toggleListeners = new Set<() => void>()
/** The last value this window saved, and whether storage refused it; once refused, the window reads its own copy. */
let togglesFallback = '[]'
let togglesUnsaved = false
function readToggles(): string {
  if (togglesUnsaved) return togglesFallback
  try { return sessionStorage.getItem(FOLDER_TOGGLES_KEY) ?? '[]' } catch { return togglesFallback }
}
function parseToggles(stored: string): Set<string> {
  try {
    const value: unknown = JSON.parse(stored)
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [])
  } catch { return new Set() }
}
function useFolderToggles(): readonly [(key: string) => boolean, (key: string) => void] {
  const subscribe = useCallback((listener: () => void) => { toggleListeners.add(listener); return () => { toggleListeners.delete(listener) } }, [])
  const stored = useSyncExternalStore(subscribe, readToggles, () => '[]')
  const isOpen = useMemo(() => {
    const toggled = parseToggles(stored)
    const startOpen = window.sottoE2E !== undefined
    return (key: string): boolean => startOpen !== toggled.has(key)
  }, [stored])
  const toggle = useCallback((key: string): void => {
    const next = parseToggles(readToggles())
    if (next.has(key)) next.delete(key); else next.add(key)
    togglesFallback = JSON.stringify([...next])
    try { sessionStorage.setItem(FOLDER_TOGGLES_KEY, togglesFallback); togglesUnsaved = false } catch { togglesUnsaved = true }
    for (const listener of [...toggleListeners]) listener()
  }, [])
  return [isOpen, toggle]
}

/** How long the pointer or focus rests on a closed folder before its preview opens, and how long it lingers after leaving. */
const PEEK_DELAY_MS = 350
const PEEK_GRACE_MS = 300

/** One project folder and its rows. Memoised for the same reason a row is: its folder is shared across updates. */
const FolderView = memo(function FolderView({ folder, section, panes, activeProjectId, expanded, liveClock, onToggle, onOpen, onNewThread, command, settle, globalLaneBusy, busyThreadIds, host, newThreadShortcut, peekEnabled, indicatorsHidden, mainCheckout, swarmAngles, gaps }: {
  readonly folder: ProjectFolder; readonly section: Section; readonly panes: PaneActions; readonly activeProjectId: string | null
  /** Each swarm lead's angles (Owl `worker-swarms`); absent while the feature is off. */
  readonly swarmAngles?: ReadonlyMap<string, readonly AgentThread[]> | undefined
  /** Keep main up to date's line for this project, when it has one (ADR-0142). */
  readonly mainCheckout?: ProjectMainCheckout | undefined
  /** The host the project is on, once a remote host is connected; its badge tells same-named projects apart. */
  readonly host?: ListedHost | undefined
  readonly expanded: boolean; readonly onToggle: (key: string) => void; readonly onOpen: (threadId: string) => void
  readonly liveClock: boolean
  readonly onNewThread: (projectId: string) => void; readonly command: Command
  readonly settle: ListSettle
  /** The held gaps among this folder's rows (ADR-0167): settled rows whose places stay empty while the pointer stays. */
  readonly gaps?: ReadonlyMap<string, HeldGap> | undefined
  /** Settling or restoring a whole project moves every thread of it at once, so it waits on the global lane. */
  readonly globalLaneBusy: boolean
  /** The threads whose own lane is running; each row reads only its own entry. */
  readonly busyThreadIds: readonly string[] | undefined
  readonly newThreadShortcut?: ThreadChordLabel | undefined
  /** The folder peek (Owl, docs/plans/collapsed-folder-peek.md): a closed folder previews its rows in place while rested on. */
  readonly peekEnabled: boolean
  /** Needs you stands at the sidebar's head (ADR-0135): the folder dots give their telling to it. */
  readonly indicatorsHidden: boolean
}): ReactNode {
  const { t } = useLingui()
  const listId = `thread-folder-${section}-${folder.id}`
  const indicatorsId = `${listId}-indicators`
  const project = folder.project
  // The chord opens a thread in the focused pane's project, so only this project's pen answers to it while one of its threads is focused.
  const listed = panes.listedThreadId ?? panes.currentThreadId
  const chordAppliesHere = listed !== null && folder.rows.some(row => row.thread.id === listed)
  // A held gap is a settled thread's place, not one of the folder's threads.
  const projectTitle = folder.title, hostName = host?.name, count = folder.rows.length - (gaps?.size ?? 0)
  const toggleLabel = hostName === undefined
    ? plural(count, { one: `${projectTitle} ${{ threads: shownCount(count) }} thread`, other: `${projectTitle} ${{ threads: shownCount(count) }} threads` })
    : plural(count, { one: `${projectTitle} on ${hostName} ${{ threads: shownCount(count) }} thread`, other: `${projectTitle} on ${hostName} ${{ threads: shownCount(count) }} threads` })
  const suffix = newThreadShortcut?.suffix
  const key = folderKey(section, folder.id)
  // The preview: a closed folder rested on by pointer or focus opens in place until you leave (Zach's pick, variant B).
  // It never touches the toggled folders; Keep open and the toggle itself do the real opening.
  const [preview, setPreview] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const previewRef = useRef<HTMLUListElement>(null)
  const enterTimer = useRef(0)
  const leaveTimer = useRef(0)
  const hoverRef = useRef(false)
  const draggingRef = useRef(false)
  /** Escape latches the preview shut until focus leaves the folder; returned focus alone must not reopen it. */
  const suppressRef = useRef(false)
  const canPreview = peekEnabled && !expanded && count > 0
  const peeking = preview && canPreview
  useEffect(() => () => { window.clearTimeout(enterTimer.current); window.clearTimeout(leaveTimer.current) }, [])
  // The folder's menu (ADR-0164): its head's actions in words, for the keyboard and a right-click.
  const [menu, setMenu] = useState<RowMenuPlace | null>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const settleOffered = project !== undefined && (folder.settled || section === 'open')
  const menuGroups = (): PaneMenuItem[][] => project === undefined ? [] : [[
    ...section === 'open' ? [{ id: 'new', label: t`New thread here`, icon: <SquarePen size={15} aria-hidden="true" />, shortcut: chordAppliesHere ? menuKeys(newThreadShortcut) : undefined, run: () => onNewThread(folder.id) }] : [],
    ...settleOffered ? [folder.settled
      ? { id: 'restore', label: t`Restore project`, icon: <ArchiveRestore size={15} aria-hidden="true" />, disabled: globalLaneBusy, run: () => void command({ type: 'restore-project', projectId: folder.id }) }
      : { id: 'settle', label: t`Settle project`, icon: <Archive size={15} aria-hidden="true" />, disabled: globalLaneBusy, run: () => void command({ type: 'settle-project', projectId: folder.id }) }] : [],
  ]]
  const menuOffered = project !== undefined && (section === 'open' || settleOffered)
  const clearTimers = (): void => { window.clearTimeout(enterTimer.current); window.clearTimeout(leaveTimer.current) }
  const focusInside = (): boolean => { const active = document.activeElement; return active !== null && active !== document.body && rootRef.current?.contains(active) === true }
  const schedulePreview = (trigger: 'hover' | 'focus'): void => {
    if (!canPreview) return
    if (trigger === 'focus' && suppressRef.current) return
    if (trigger === 'hover') suppressRef.current = false
    window.clearTimeout(leaveTimer.current)
    if (peeking) return
    window.clearTimeout(enterTimer.current)
    enterTimer.current = window.setTimeout(() => setPreview(true), PEEK_DELAY_MS)
  }
  const scheduleHide = (from: 'hover' | 'focus'): void => {
    window.clearTimeout(enterTimer.current)
    if (draggingRef.current) return
    if (from === 'hover' && focusInside()) return
    if (from === 'focus' && hoverRef.current) return
    window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => setPreview(false), PEEK_GRACE_MS)
  }
  const hidePreview = (latch = false): void => { if (latch) suppressRef.current = true; clearTimers(); setPreview(false) }
  const keepOpen = (): void => { hidePreview(); onToggle(key); toggleRef.current?.focus() }
  const fineHover = (pointerType: string): boolean => {
    if (pointerType !== '' && pointerType !== 'mouse' && pointerType !== 'pen') return false
    return typeof window.matchMedia !== 'function' || window.matchMedia('(hover: hover) and (pointer: fine)').matches
  }
  // A held gap is the settled row's height of nothing: no control, no name, and a click on it does nothing.
  const renderRows = (open: (threadId: string) => void, rowPanes: PaneActions): ReactNode => folder.rows.map(row => {
    const gap = gaps?.get(row.thread.id)
    if (gap !== undefined) return <li key={row.thread.id} className="thread-nav__gap" aria-hidden="true" data-closing={gap.closing || undefined} style={{ height: gap.height }} />
    return <ThreadNavRow key={row.thread.id} row={row} current={listed === row.thread.id} open={rowPanes.openThreadIds.includes(row.thread.id)} busy={isThreadBusy({ busyThreadIds }, row.thread.id)}
      liveClock={liveClock} onOpen={open} command={command} panes={rowPanes} settle={settle} angles={swarmAngles?.get(row.thread.id)} />
  })
  return <div ref={rootRef} className="thread-folder" data-section={section} data-active={activeProjectId === folder.id || undefined} {...{ [ROVING_GROUP]: '' }}
    onPointerEnter={event => { if (fineHover(event.pointerType)) { hoverRef.current = true; schedulePreview('hover') } }}
    onPointerLeave={() => { hoverRef.current = false; scheduleHide('hover') }}
    onFocus={event => { if (!rootRef.current?.contains(event.relatedTarget as Node | null)) schedulePreview('focus'); else window.clearTimeout(leaveTimer.current) }}
    onBlur={event => { if (rootRef.current?.contains(event.relatedTarget as Node | null)) return; suppressRef.current = false; scheduleHide('focus') }}
    onDragStart={() => { draggingRef.current = true; clearTimers() }}
    onDragEnd={() => { draggingRef.current = false; scheduleHide('hover') }}
    onKeyDown={event => {
      // Keys typed in a row's rename field belong to the field: caret arrows must never navigate the preview.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return
      if (event.key === 'Escape' && peeking) { event.preventDefault(); event.stopPropagation(); hidePreview(true); toggleRef.current?.focus(); return }
      // Up, Down, Home and End walk the preview's rows as the thread list's own (ADR-0164); Left puts it away.
      const inPreview = previewRef.current?.contains(event.target as Node) === true
      if (inPreview && event.key === 'ArrowLeft') { event.preventDefault(); hidePreview(true); toggleRef.current?.focus() }
    }}>
    <div ref={headRef} className="thread-folder__head" data-peeking={peeking || undefined}
      onContextMenu={event => { if (!menuOffered) return; event.preventDefault(); toggleRef.current?.focus(); setMenu(rowMenuPlace(event)) }}>
      {/* The toggle includes the visible count in its accessible name, with the project title first. */}
      <button ref={toggleRef} type="button" className="thread-folder__toggle tt-focusable" aria-expanded={expanded} aria-controls={listId} onClick={() => { hidePreview(); onToggle(key) }}
        {...{ [ROVING_TOGGLE]: '', [ROVING_KEY]: `folder:${key}` }}
        onKeyDown={event => { if (menuOffered && rowMenuPressed(event, panes.rowKeys?.menu ?? true)) { event.preventDefault(); setMenu('beside') } }}
        aria-label={toggleLabel} aria-describedby={!expanded && (folder.working || folder.needs) ? indicatorsId : undefined} title={peeking ? undefined : project?.path}>
        <ChevronRight size={12} aria-hidden="true" className="thread-folder__chevron" />
        <Folder size={14} aria-hidden="true" /><span className="thread-folder__title">{folder.title}</span>{host ? <HostBadge host={host} /> : null}
        {!expanded ? <Indicators id={indicatorsId} working={folder.working} needs={folder.needs} hidden={indicatorsHidden} /> : null}
        {/* An empty folder shows its name alone; the room says once that there are no threads (#1834). */}
        {count ? <span className="thread-folder__count" aria-hidden="true">{count}</span> : null}
      </button>
      {project !== undefined ? <span className="thread-folder__actions" {...{ [ROW_ACTIONS]: '' }}>
        {section === 'open' ? <button type="button" className="thread-nav__action tt-focusable" tabIndex={-1} aria-label={t`New thread in ${projectTitle}`}
          title={suffix !== undefined ? t({ message: `New thread here ${suffix}`, comment: '{suffix} names the keyboard shortcut.' }) : t`New thread here`}
          aria-keyshortcuts={chordAppliesHere ? newThreadShortcut?.keys : undefined}
          onClick={() => onNewThread(folder.id)}><SquarePen size={16} aria-hidden="true" /></button> : null}
        {folder.settled || section === 'open' ? <ProjectSettleAction projectId={folder.id} title={folder.title} settled={folder.settled} disabled={globalLaneBusy} command={command} /> : null}
      </span> : null}
      {menu !== null ? <RowMenu label={t`Actions for ${projectTitle}`} groups={menuGroups()} anchor={() => headRef.current} place={menu}
        onClose={restore => { setMenu(null); if (restore) toggleRef.current?.focus() }} /> : null}
    </div>
    {mainCheckout ? <MainCheckoutLine line={mainCheckout} title={folder.title} /> : null}
    {peeking ? <ul ref={previewRef} className="thread-folder__rows thread-folder__preview" id={`${listId}-preview`} role="group" aria-label={t`Preview of threads in ${projectTitle}`}>
      {renderRows(threadId => { hidePreview(); onOpen(threadId) }, { ...panes, onOpenBeside: threadId => { hidePreview(); panes.onOpenBeside(threadId) } })}
      <li className="thread-folder__preview-foot"><span>Preview</span>
        <button type="button" className="thread-folder__preview-action tt-focusable" onClick={keepOpen}>{t`Keep open`}</button>
        {section === 'open' && project !== undefined ? <button type="button" className="thread-folder__preview-action tt-focusable" aria-label={t`New thread in ${projectTitle}`} onClick={() => { hidePreview(); onNewThread(folder.id) }}>{t`New thread`}</button> : null}
      </li>
    </ul> : null}
    {expanded ? <ul className="thread-folder__rows" id={listId}>
      {renderRows(onOpen, panes)}
    </ul> : null}
  </div>
})

/**
 * "3 need attention" with Dismiss all beside it, under the search, while any thread's failed turn has not been seen
 * (ADR-0092, prototype variant A). It counts failed turns alone: a thread waiting on a permission or a question is the
 * user's to answer and is never counted or dismissed. One press marks every counted thread seen, on every host that holds
 * one. Once the hosts accept it and the line goes, the search field just above takes the focus; when a host keeps its
 * threads as they were, the line stays and so does the focus, on Dismiss all, beside the refusal that says why. While a
 * press is on its way the button keeps the focus and ignores another press, rather than going disabled and dropping it.
 */
function NeedsAttentionLine({ failures, command }: { readonly failures: ReturnType<typeof unseenFailures>; readonly command: Command }): ReactNode {
  const line = useRef<HTMLDivElement>(null)
  /** The search field that takes the focus once an accepted Dismiss all has taken the line away. */
  const handOff = useRef<HTMLInputElement | null>(null)
  const [dismissing, setDismissing] = useState(false)
  const { t } = useLingui()
  const count = failures.length
  useLayoutEffect(() => {
    // The line went: the field takes the focus. It changed instead, as when another failure came: the press is over.
    if (count === 0) handOff.current?.focus()
    handOff.current = null
  }, [count])
  if (!count) return null
  const dismiss = (): void => {
    if (dismissing) return
    const search = line.current?.closest('.thread-nav')?.querySelector<HTMLInputElement>('.threads-search input') ?? null
    setDismissing(true)
    void command({ type: 'dismiss-failures', failures: failures.slice(0, AGENT_DISMISS_FAILURES_MAX) }).then(result => {
      if (result === null || result.error) return
      if (line.current === null) search?.focus()
      else handOff.current = search
    }).finally(() => setDismissing(false))
  }
  return <div ref={line} className="thread-nav__attention">
    <i aria-hidden="true" />
    <span className="thread-nav__attention-count">{plural(count, { one: `${{ threads: shownCount(count) }} needs attention`, other: `${{ threads: shownCount(count) }} need attention` })}</span>
    <button type="button" className="thread-nav__attention-dismiss tt-focusable" aria-label={plural(count, { one: `Dismiss Needs attention on ${{ threads: shownCount(count) }} thread`, other: `Dismiss Needs attention on ${{ threads: shownCount(count) }} threads` })}
      aria-disabled={dismissing || undefined} onClick={dismiss}>{t`Dismiss all`}</button>
  </div>
}

/** The Threads sidebar: project folders of open work, then the Settled shelf. */
export function ThreadSidebar({ state, command, organization, query, liveClock = true, onQuery, onOpen, onNewThread,
  currentThreadId, listedThreadId, openThreadIds, onOpenBeside, onDragThread, title, newThreadError, onDismissNewThreadError, newThreadShortcut, shortcutsLive = false, restartThreads }: PaneActions & {
  readonly state: AgentState
  /**
   * Every thread the host publishes, Watcher's own included, which the page's own list leaves out: the restart band
   * (ADR-0144; Owl only) names Watcher's thread among the ones a limit stopped. The listed threads where absent.
   */
  readonly restartThreads?: readonly AgentThread[] | undefined
  readonly command: Command
  readonly organization: WorkspaceOrganization
  readonly query: string
  /** The hidden page heading the frame carries; `null` beside a page that has its own. */
  readonly title?: string | null
  /** False where the page holds its clock still (a capture run); working rows then keep the time they were given. */
  readonly liveClock?: boolean | undefined
  readonly onQuery: (query: string) => void
  readonly onOpen: (threadId: string) => void
  readonly onNewThread: (projectId?: string) => void
  /** A pen, the empty page's button or the chooser refused a creation; shown where Add project shows its own. */
  readonly newThreadError?: string | null | undefined
  readonly onDismissNewThreadError?: (() => void) | undefined
  readonly newThreadShortcut?: ThreadChordLabel | undefined
  /**
   * True on the Threads page, where the window's thread chords (Settings › Keyboard, ADR-0133) land: Settle,
   * Restore and moving between threads. The same list beside another page (PageSidebar) leaves the keys alone.
   */
  readonly shortcutsLive?: boolean | undefined
}): ReactNode {
  const { t, i18n: { locale } } = useLingui()
  const queueOn = useOwlFeature('needs-you-queue')
  const railOn = useOwlFeature('sidebar-rail')
  /** The waiting thread whose card stands popped open beside its rail tile, and that tile (ADR-0135, October 29 amendment). */
  const [railCard, setRailCard] = useState<string | null>(null)
  const railNav = useRef<HTMLElement>(null)
  const [railDismissing, setRailDismissing] = useState(false)
  const railCardId = useId()
  const watchedIds = useWatchedThreadIds()
  const [settledOpen, setSettledOpen] = useState(false)
  const settledButton = useRef<HTMLButtonElement>(null)
  const { settle, dialog: settleDialog } = useSettleThread(command, settledButton)
  const [isFolderOpen, toggle] = useFolderToggles()
  const folderPeek = useOwlFeature('folder-peek')
  // Worker swarms (Owl, ADR-0162): each lead's angles under its row. Off, nothing is read and no row changes.
  const swarmsOn = useOwlFeature('worker-swarms')
  const hostThreads = state.host.threads
  const listedAs = organization.listedAs
  const swarmAngles = useMemo(() => swarmsOn ? swarmAnglesByLead(hostThreads, listedAs) : undefined, [swarmsOn, hostThreads, listedAs])
  const { collapsed } = useSidebarSize()
  const app = useOptionalApp()
  const platform: SottoPlatform = app?.platform ?? 'win32'
  const settings = app?.settings
  // Rows carry these labels so their buttons can say their keys; memoised like the New thread label above them.
  const openBesideChord = useMemo(() => {
    const chord = claimedThreadChord(settings, 'open-beside', platform)
    return chord === null ? undefined : { chord, platform, label: threadChordLabel(chord, platform) }
  }, [settings, platform])
  const settleChord = claimedThreadChord(settings, 'settle', platform)
  const restoreChord = claimedThreadChord(settings, 'restore', platform)
  const nextChord = claimedThreadChord(settings, 'next-thread', platform)
  const previousChord = claimedThreadChord(settings, 'previous-thread', platform)
  const waitingChord = claimedThreadChord(settings, 'next-waiting', platform)
  const settleShortcut = useMemo(() => settleChord ? threadChordLabel(settleChord, platform) : undefined, [settleChord, platform])
  const restoreShortcut = useMemo(() => restoreChord ? threadChordLabel(restoreChord, platform) : undefined, [restoreChord, platform])
  // F2 and Shift+F10 on a row (ADR-0164), each standing down where one of dictation's shortcuts means the same keys.
  const renameKey = fixedKeyFree(settings, 'f2', platform), menuKey = fixedKeyFree(settings, 'shift+f10', platform)
  const rowKeys = useMemo(() => ({ rename: renameKey, menu: menuKey }), [renameKey, menuKey])
  // One object for the whole list, rebuilt only when a pane action actually changes: every row compares it.
  const panes = useMemo<PaneActions>(() => ({ currentThreadId, listedThreadId, openThreadIds, onOpenBeside, onDragThread, openBesideChord, settleShortcut, restoreShortcut, rowKeys }),
    [currentThreadId, listedThreadId, openThreadIds, onOpenBeside, onDragThread, openBesideChord, settleShortcut, restoreShortcut, rowKeys])
  // The thread list and the collapsed rail are each one Tab stop with arrow keys inside (ADR-0164).
  const threadList = useRef<HTMLDivElement>(null)
  const listKeys = useRovingList(threadList, { tree: true })
  const railKeys = useRovingList(railNav, { tree: false })
  // The held gap (ADR-0167): a row settled by a pointer over the list keeps its place empty until the pointer leaves.
  const { gaps, hold, drop } = useSettleGaps(threadList)
  const settleFromList = useCallback<ListSettle>(async (thread, project, row) => {
    const holding = row !== undefined && hold(thread.id, row)
    const settled = await settle(thread, project)
    if (!settled && holding) drop(thread.id)
    return settled
  }, [settle, hold, drop])
  const heldIds = useMemo(() => new Set(gaps.keys()), [gaps])
  const held = useMemo(() => holdSettledRows(organization.open, organization.settled, heldIds), [organization.open, organization.settled, heldIds])
  const gapsByFolder = useMemo(() => {
    const folders = new Map<string, Map<string, HeldGap>>()
    for (const [threadId, folderId] of held.placed) {
      const gap = gaps.get(threadId)
      if (gap === undefined) continue
      const folder = folders.get(folderId) ?? new Map<string, HeldGap>()
      folder.set(threadId, gap)
      folders.set(folderId, folder)
    }
    return folders
  }, [held.placed, gaps])
  // A gap whose thread came back (Undo, the shelf's Restore) goes at once, rather than waiting for the pointer to leave.
  const heldSettled = useRef(new Set<string>())
  useEffect(() => {
    const seen = heldSettled.current
    for (const id of gaps.keys()) {
      if (held.placed.has(id)) seen.add(id)
      else if (seen.has(id)) { seen.delete(id); drop(id) }
    }
    for (const id of [...seen]) if (!gaps.has(id)) seen.delete(id)
  }, [gaps, held.placed, drop])
  // The chords that act from anywhere in the window (Settings › Keyboard): Settle and Restore for the focused
  // thread — the same press their row buttons make, worktree question included — and moving between threads in
  // the sidebar's order, the waiting ones included from the Settled shelf too.
  useEffect(() => {
    if (!shortcutsLive) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      const press = (chord: string | null): boolean => chord !== null && threadChordPressed(event, chord, platform)
      const openRows = organization.open.flatMap(folder => folder.rows)
      if (press(settleChord)) {
        const row = openRows.find(item => item.thread.id === currentThreadId)
        if (!row || row.settledBy !== null || isThreadBusy({ busyThreadIds: state.busyThreadIds }, row.thread.id)) return
        event.preventDefault()
        // The collapsed rail keeps showing the focused thread even once settled, so move on to the top open one.
        const next = collapsed ? openRows.find(item => item.thread.id !== row.thread.id) : undefined
        void settle(row.thread, row.project).then(settled => { if (settled && next) onOpen(next.thread.id) })
        return
      }
      if (press(restoreChord)) {
        const row = organization.settled.flatMap(folder => folder.rows).find(item => item.thread.id === currentThreadId)
        if (!row || row.settledBy !== 'thread' || isThreadBusy({ busyThreadIds: state.busyThreadIds }, row.thread.id)) return
        event.preventDefault()
        void command({ type: 'restore-thread', threadId: row.thread.id })
        return
      }
      const step = press(nextChord) ? 1 : press(previousChord) ? -1 : 0
      if (step !== 0) {
        if (openRows.length === 0) return
        const at = openRows.findIndex(item => item.thread.id === currentThreadId)
        const target = openRows[(at === -1 ? (step === 1 ? -1 : 0) : at) + step]
          ?? (step === 1 ? openRows[0] : openRows.at(-1))
        if (!target || target.thread.id === currentThreadId) return
        event.preventDefault()
        onOpen(target.thread.id)
        return
      }
      if (press(waitingChord)) {
        const waiting = [...openRows, ...organization.settled.flatMap(folder => folder.rows)].filter(item => item.state === 'needs')
        const at = waiting.findIndex(item => item.thread.id === currentThreadId)
        const target = waiting[(at + 1) % Math.max(waiting.length, 1)]
        if (!target || target.thread.id === currentThreadId) return
        event.preventDefault()
        onOpen(target.thread.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcutsLive, collapsed, platform, settleChord, restoreChord, nextChord, previousChord, waitingChord, organization, currentThreadId, state.busyThreadIds, settle, command, onOpen])
  const listed = listedThreadId ?? currentThreadId
  const searching = query.trim() !== ''
  const connections = state.connections
  // "This computer" is in the interface language, so a change of language names the hosts again.
  const hosts = useMemo(() => listedHosts({ connections }), [connections, locale])
  // Keep main up to date (ADR-0142): this computer's projects only, by their local ID, and only among open work.
  const mainCheckout = useMainCheckoutLines(useOwlFeature('keep-main-current') ? window.sotto?.mainCheckout : undefined)
  const folderView = (section: Section) => (folder: ProjectFolder): ReactNode => {
    const key = folderKey(section, folder.id)
    const hostId = hosts.length ? hostIdOf(folder.project) ?? hostIdOf({ id: folder.id }) ?? folder.rows[0]?.thread.hostId : undefined
    return <FolderView key={key} folder={folder} section={section} panes={panes} activeProjectId={state.activeProjectId} liveClock={liveClock}
      host={hosts.find(item => item.hostId === hostId)} newThreadShortcut={newThreadShortcut} peekEnabled={folderPeek}
      mainCheckout={section === 'open' && mainCheckout.size ? mainCheckout.get(projectWorkingCopyDefaultKey(state, folder.id)) : undefined}
      expanded={searching || isFolderOpen(key)} onToggle={toggle} onOpen={onOpen} onNewThread={onNewThread} command={command} settle={settleFromList} globalLaneBusy={state.globalLaneBusy} busyThreadIds={state.busyThreadIds} indicatorsHidden={queueOn}
      swarmAngles={swarmAngles} gaps={section === 'open' ? gapsByFolder.get(folder.id) : undefined} />
  }
  const { open, settled } = organization
  // The collapsed rail's threads: every open one, and the focused one even once settled.
  const railRows = [...open.flatMap(folder => folder.rows), ...settled.flatMap(folder => folder.rows).filter(row => row.thread.id === listed)]
  // A waiting tile whose thread's own request or failure the Needs you card would pop pops the same card beside the
  // rail; every other tile opens its thread, as the card's own entries do.
  const railPops = railOn && queueOn ? new Map(organization.needsYou.entries.filter(entry => entry.action !== 'open').map(entry => [entry.row.thread.id, entry])) : undefined
  const railEntry = railCard !== null && collapsed ? railPops?.get(railCard) : undefined
  // A tile is found by its thread each time: dismissing or answering can move it to another group, drawn anew.
  const railTileOf = (threadId: string | null): HTMLElement | null => threadId === null ? null
    : [...railNav.current?.querySelectorAll<HTMLElement>('[data-rail-thread]') ?? []].find(tile => tile.dataset.railThread === threadId) ?? null
  // The card closes when its thread stops waiting, is answered elsewhere, or the rail goes; a focus it held goes back to its tile.
  useLayoutEffect(() => {
    if (railCard === null || railEntry !== undefined) return
    setRailCard(null)
    const active = document.activeElement
    if (active === null || active === document.body) railTileOf(railCard)?.focus()
  }, [railCard, railEntry])
  const railTile = ({ row, status, waiting, resting }: RailItem, watched: boolean): ReactNode => {
    const pops = railPops?.get(row.thread.id)
    const id = row.thread.id
    return <button key={id} type="button" data-rail-thread={id} {...{ [ROVING_KEY]: `rail:${id}` }}
    className="thread-nav__rail-thread thread-nav__rail-mark tt-focusable" data-resting={resting || undefined} data-waiting={waiting || undefined} aria-label={pops ? popWords(pops).name : row.thread.title}
    title={[row.thread.title, status.text, watched ? t`Watched by Watcher` : ''].filter(Boolean).join(' · ')}
    aria-haspopup={pops ? 'dialog' : undefined} aria-expanded={pops ? railCard === id : undefined} aria-controls={pops && railCard === id ? railCardId : undefined}
    aria-current={listed === id ? 'page' : undefined} onClick={() => { if (pops) setRailCard(current => current === id ? null : id); else onOpen(id) }}
    onKeyDown={event => { if (pops && railCard === id && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRailCard(null) } }}>
    {watched ? <span className="thread-nav__rail-watched-mark" aria-hidden="true"><WatcherOwl size={10} /></span> : null}
    <span aria-hidden="true">{railMark(row.thread.title)}</span><StatusRing row={row} {...status} />
  </button>
  }
  const threads = state.host.threads
  const restartOn = useRestartStopped()
  const failures = useMemo(() => unseenFailures(threads), [threads])
  const settledThreads = settled.reduce((count, folder) => count + folder.rows.length, 0)
  const settledWorking = settled.reduce((count, folder) => count + folder.working, 0)
  const settledNeeds = settled.reduce((count, folder) => count + folder.needs, 0)
  const settledShown = settledOpen || searching
  let owlRail: ReactNode = null
  if (railOn) {
    // Owl's rail (ADR-0146): the threads Watcher watches right under its tile, each with the owl at its corner, then the
    // rest. Each part runs what waits on you (the Needs you queue's order, settled threads included, edged in the
    // attention colour), then what is moving, then the resting ones smaller; the rest's resting ones are a part of their
    // own. A watched thread shows here even once settled.
    const queued = organization.needsYou.entries.map(entry => entry.row)
    const waitingIds = new Set(queued.map(row => row.thread.id))
    const pool = [...new Map([...queued, ...railRows, ...settled.flatMap(folder => folder.rows).filter(row => watchedIds.has(row.thread.id))].map(row => [row.thread.id, row])).values()]
    const items = pool.map(row => {
      const status = rowStatus(row, { restart: restartOn })
      const waiting = waitingIds.has(row.thread.id)
      const moving = row.state === 'working' || status.finished || status.prototype || status.background || status.restart
      return { row, status, waiting, resting: !waiting && !moving }
    })
    const ordered = (watched: boolean): RailItem[] => {
      const part = items.filter(item => watchedIds.has(item.row.thread.id) === watched)
      return [...part.filter(item => item.waiting), ...part.filter(item => !item.waiting && !item.resting), ...part.filter(item => item.resting)]
    }
    const watched = ordered(true), rest = ordered(false)
    const restAwake = rest.filter(item => !item.resting), restResting = rest.filter(item => item.resting)
    // A part of two or more tiles sits in a tray of its own colour, the trays taking the theme's group colours in turn;
    // a lone tile stands bare.
    let trays = 0
    const part = (items: RailItem[], watchedPart: boolean): ReactNode => {
      if (!items.length) return null
      const tray = items.length > 1 ? ++trays : undefined
      return <div className={`thread-nav__rail-group${watchedPart ? ' thread-nav__rail-watched' : ''}${tray ? ' thread-nav__rail-tray' : ''}`} data-hue={tray}
        role={watchedPart ? 'group' : undefined} aria-label={watchedPart ? t`Watched by Watcher` : undefined}>{items.map(item => railTile(item, watchedPart))}</div>
    }
    owlRail = <>{part(watched, true)}{part(restAwake, false)}{part(restResting, false)}
      {railEntry ? <NeedsYouCard id={railCardId} entry={railEntry} state={state} command={command} anchor={() => railTileOf(railCard)} trigger={() => railTileOf(railCard)} placement="beside"
        dismissing={railDismissing} onClose={focusTile => { setRailCard(null); if (focusTile) railTileOf(railCard)?.focus() }}
        onOpen={() => { setRailCard(null); onOpen(railEntry.row.thread.id) }}
        onDismiss={() => {
          setRailDismissing(true)
          void command({ type: 'dismiss-failures', failures: [entryFailure(railEntry)] }).finally(() => setRailDismissing(false))
        }} /> : null}
    </>
  }
  // The chord opens the chooser (what the top button does) only while no thread is focused; a focused thread
  // answers it from its own project's pen instead, so the top button's aria-keyshortcuts stands down then.
  const suffix = newThreadShortcut?.suffix
  const topShortcut = newThreadShortcut ? { title: t({ message: `New thread ${suffix}`, comment: '{suffix} names the keyboard shortcut.' }), keys: currentThreadId === null ? newThreadShortcut.keys : undefined } : undefined
  return <SidebarFrame state={state} command={command} label={t`Thread sidebar`} query={query} searchPlaceholder={t`Search threads`} onQuery={onQuery}
    onNew={() => onNewThread()} newLabel={t`New thread`} NewIcon={SquarePen} newShortcut={topShortcut} title={title}
    extraError={newThreadError} onDismissExtraError={onDismissNewThreadError} onProjectAdded={onNewThread} notice={<WorkingThreadsLine threads={state.host.threads} />}
    toast={<SettleToast command={command} threads={state.host.threads} list={threadList} platform={platform} />}
    afterSearch={<>
      {/* When Sotto restarts what a limit stopped, under the search and before what waits on you (ADR-0144; Owl only). */}
      <RestartBands threads={restartThreads ?? threads} command={command} onOpen={onOpen} />
      {queueOn ? <NeedsYouQueue queue={organization.needsYou} state={state} command={command} failures={failures} panes={panes} onOpen={onOpen} /> : <NeedsAttentionLine failures={failures} command={command} />}
    </>}
    collapsedContent={<nav ref={railNav} aria-label={t`Threads`} data-region-entry="1" onKeyDown={railKeys.onKeyDown} onFocus={railKeys.onFocus}>{owlRail ?? railRows.map(row => <button key={row.thread.id} type="button" className="thread-nav__rail-thread tt-focusable" {...{ [ROVING_KEY]: `rail:${row.thread.id}` }} aria-label={row.thread.title} title={`${row.thread.title} · ${rowStatus(row, { restart: restartOn }).text}`} aria-current={listed === row.thread.id ? 'page' : undefined} onClick={() => onOpen(row.thread.id)}>
      <span aria-hidden="true">{row.thread.title.slice(0, 1)}</span><StatusRing row={row} {...rowStatus(row, { restart: restartOn })} />
    </button>)}</nav>}>
      {/* The thread list: its folders, rows and the Settled shelf are one Tab stop, walked with the arrow keys, and the
          first place F6 lands in the sidebar (ADR-0164). */}
      <div ref={threadList} className="thread-nav__list" data-region-entry="1" onKeyDown={listKeys.onKeyDown} onFocus={listKeys.onFocus}>
      <section aria-label={t`Projects`}>
        {held.open.map(folderView('open'))}
        {!held.open.length ? <p className="thread-nav__empty tt-paragraph">{searching ? t`No matching open threads.` : state.host.projects.length ? t`All caught up.` : t`Add a project folder to start.`}</p> : null}
      </section>
      <section aria-label={t`Settled`} className="thread-nav__shelf" {...{ [ROVING_GROUP]: '' }}>
        <button ref={settledButton} className="thread-nav__settled tt-focusable" type="button" aria-expanded={settledShown} onClick={() => setSettledOpen(!settledOpen)}
          {...{ [ROVING_TOGGLE]: '', [ROVING_KEY]: 'settled' }}
          aria-label={[plural(settledThreads, { one: `Settled ${{ threads: shownCount(settledThreads) }} thread`, other: `Settled ${{ threads: shownCount(settledThreads) }} threads` }), settledNeeds ? waitingOnYou(settledNeeds) : '', settledWorking ? workingCount(settledWorking) : ''].filter(Boolean).join(', ')}>
          <ChevronRight size={13} aria-hidden="true" className="thread-folder__chevron" />
          <span><Trans>Settled</Trans></span>
          {!settledShown && !queueOn ? <Indicators working={settledWorking} needs={settledNeeds} /> : null}
        </button>
        {settledShown ? <div>{settled.map(folderView('settled'))}{!settled.length ? <p className="thread-nav__empty tt-paragraph"><Trans>No settled threads.</Trans></p> : null}</div> : null}
      </section>
      {searching && !organization.matching ? <p className="thread-nav__empty tt-paragraph"><Trans>Nothing matches "{query}".</Trans></p> : null}
      </div>
      {settleDialog}
  </SidebarFrame>
}
