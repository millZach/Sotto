import { focusedComposerField } from './promptSelection'
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentProject, AgentState } from '../../../shared/agents'
import type { SottoPlatform } from '../../../shared/platform'
import { Button } from '../components/Button'
import { PageWindowControls } from '../components/WindowControls'
import { useOptionalApp } from '../state/AppContext'
import { useVoiceCoordinatorEnabled } from '../state/voiceCoordinator'
import { useAgents, type AgentConnection } from './AgentContext'
import { draftThreads, gateOnCreation, overlayDraftThreads, useDraftThreads } from './draftThreads'
import { describeThreads, organizeWorkspace, type ThreadRow } from './threadFacts'
import { NewThreadDialog } from './NewThreadDialog'
import { beginNewThread, unusedNewThread, type ThreadCreationStart } from './newThread'
import { newThreadChord, newThreadChordLabel, newThreadChordPressed } from './newThreadShortcut'
import { ProviderUpgradeNotice, isRecoveredDraft } from './ProviderUpgradeNotice'
import { EmptyWorkspace, type CarriedDraft } from './EmptyWorkspace'
import { HostUpdateControl } from './HostUpdates'
import { THREAD_PROMPT_ID } from './ThreadComposer'
import { hasDraftContent } from './threadDraftStore'
import { ThreadPane } from './ThreadPane'
import { ThreadPanes, focusInPane, type PaneLabel } from './ThreadPanes'
import { paneGridActions, useClock } from './paneGrid'
import { ThreadSidebar } from './ThreadSidebar'
import { SidebarChromeProvider, useSidebarMode } from './SidebarFrame'
import { useShared } from './stateSharing'
import { takeNewThreadIntent } from './threadIntent'
import { TerminalWorkspace, type TerminalWorkspaceProps } from '../terminals/TerminalWorkspace'
import { qualifyLegacyLayout, isSplit, prune, retarget, setFocused, splitLayoutStore, threadPromptId, useSplitLayout, type SplitLayoutStore } from './splitLayout'

type Command = AgentConnection['command']

const TOO_LONG_TO_MOVE = "This draft is too long to add after what the new thread's composer already holds. Nothing was moved, and the draft is still saved."

/** Put the cursor in the composer of the pane that just appeared, once it has been painted. */
function focusNewComposer(): void {
  window.setTimeout(() => focusedComposerField()?.focus(), 0)
}

/** What a shared tools surface beside the panes receives. It follows the focused thread unless it pins its own. */
export interface ThreadToolsProps {
  readonly focusedThreadId: string | null
  readonly state: AgentState
  readonly command: Command
}
export type ThreadToolsSlot = (props: ThreadToolsProps) => ReactNode

/** What a per-pane slot receives: that pane's thread, whether it holds focus, and a way to put the cursor in its composer. */
export interface ThreadPaneSlotProps {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly command: Command
  readonly focused: boolean
  readonly focusPrompt: () => void
}
export type ThreadPaneSlot = (props: ThreadPaneSlotProps) => ReactNode

export interface ThreadsViewProps {
  readonly onOpenAgents: () => void
  readonly now?: number | undefined
  /** The update control, seated at the end of the sidebar's foot where the app footer used to carry it. */
  readonly updateControl?: ReactNode
  /** One shared tools panel, rendered beside the thread panes. */
  readonly tools?: ThreadToolsSlot | undefined
  /** Once, in the focused pane's header actions, before the every-pane actions (the tools panel's toggle). */
  readonly focusedPaneActions?: ReactNode
  /** In every pane's header actions, focused or not (the pane terminal drawer's own toggle). */
  readonly paneActions?: ThreadPaneSlot | undefined
  /** The working-copy control in each pane's header, after the project title. */
  readonly paneWorkingCopy?: ThreadPaneSlot | undefined
  /** In each pane, directly above its composer. */
  readonly paneNotice?: ThreadPaneSlot | undefined
  /** In every pane, directly after its composer: the pane's own terminal drawer. */
  readonly paneDrawer?: ThreadPaneSlot | undefined
  /**
   * The threads shown in panes, including one hidden by narrow focus, whenever that list changes; an empty list
   * when Threads closes. It is for keeping those threads current and never selects or grants anything.
   */
  readonly onPaneThreadsChange?: ((threadIds: readonly string[]) => void) | undefined
  readonly layoutStore?: SplitLayoutStore | undefined
  /** What Terminal mode is given beyond the state: its bridge, view and stores; tests pass stand-ins. */
  readonly terminals?: Pick<TerminalWorkspaceProps, 'store' | 'bridge' | 'viewFactory' | 'layoutStore' | 'platform'> | undefined
  /** Test-only: the pane area's size where layout measurement is unavailable. */
  readonly paneAreaWidth?: number | undefined
  readonly paneAreaHeight?: number | undefined
}
export function ThreadsView({ onOpenAgents, now: fixedNow, updateControl, tools, focusedPaneActions, paneActions, paneWorkingCopy, paneNotice, paneDrawer, onPaneThreadsChange, layoutStore = splitLayoutStore, terminals, paneAreaWidth, paneAreaHeight }: ThreadsViewProps): ReactNode {
  const agents = useAgents()
  const app = useOptionalApp()
  // Voice is hidden for the beta, and the Agents room is a voice surface: without it the page offers only a new thread.
  const voice = useVoiceCoordinatorEnabled()
  const now = useClock(fixedNow)
  const [mode, setMode] = useSidebarMode()
  const [query, setQuery] = useState('')
  // The chooser for the top New thread button and the sidebar's own top button; the pen and the empty page's
  // button already know their project and skip it, opening the thread at once (issue #347). Opened by New thread
  // with this draft, it carries that draft into the thread it opens, and closing it lets the draft go with it.
  const [chooser, setChooser] = useState<{ readonly carried?: CarriedDraft } | null>(null)
  const [newThreadError, setNewThreadError] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  // The pane the user just focused, shown at once while main confirms the selection. Once the command
  // settles, the next published state is the truth, so an older echo cannot pull focus back meanwhile.
  const [pending, setPending] = useState<{ readonly threadId: string; readonly settled?: AgentState | null } | null>(null)
  const stateRef = useRef<AgentState | null>(null)
  const lastFocused = useRef<string | null>(null)
  const store = agents.threadDrafts
  // A thread created in this window is shown from its local record until main's state carries it, and every
  // command about it waits for that creation instead of being refused for naming a thread main does not know.
  const drafts = useDraftThreads()
  const published = agents.state
  const publishedRef = useRef(published)
  const state = useMemo(() => overlayDraftThreads(published, drafts), [published, drafts])
  const command = useMemo(() => gateOnCreation(agents.command), [agents.command])
  useEffect(() => { publishedRef.current = published; draftThreads.reconcile(published) }, [published])
  // Derived facts are shared with the ones on screen: an update that did not touch a thread leaves its row,
  // its folder and its pane label at the same reference, so the memoised sidebar and panes below skip it.
  const rows = useShared(useMemo(() => state === null ? [] : describeThreads(state, now), [state, now]))
  const rowsById = useMemo(() => new Map(rows.map(row => [row.thread.id, row] as const)), [rows])
  const labels = useShared(useMemo(() => new Map<string, PaneLabel>(rows.map(row => [row.thread.id, { title: row.thread.title, providerId: row.providerId, provider: row.provider }] as const)), [rows]))
  const organization = useShared(useMemo(() => state === null ? { open: [], settled: [], matching: 0 } : organizeWorkspace(state, rows, query, state.activeProjectId), [state, rows, query]))
  const originalStored = useSplitLayout(layoutStore)
  const stored = useMemo(() => qualifyLegacyLayout(originalStored, state?.hostId), [originalStored, state?.hostId])
  useEffect(() => { if (stored !== originalStored) layoutStore.set(stored) }, [stored, originalStored, layoutStore])
  const activeId = state?.activeThreadId != null && rowsById.has(state.activeThreadId) ? state.activeThreadId : null
  const pendingFocus = pending?.threadId ?? null
  const focusedId = pendingFocus !== null && rowsById.has(pendingFocus) ? pendingFocus : activeId
  // Panes whose thread is missing are left out without forgetting them, so a provider still connecting after a restart keeps
  // its panes. A selection made elsewhere (voice, attention, a new thread) moves only the focused pane; after a restart that is
  // the pane focused when the arrangement was saved.
  const visible = state === null || rows.length === 0 ? stored : prune(stored, id => rowsById.has(id))
  const layout = retarget(visible, lastFocused.current ?? visible.focused, focusedId)
  const paneIds = useShared(isSplit(layout) ? layout.panes : focusedId !== null ? [focusedId] : [])

  useEffect(() => { if (layout !== visible) layoutStore.set(layout) }, [layout, visible, layoutStore])
  useEffect(() => {
    if (focusedId === null || !isSplit(layout) || layout.panes.includes(focusedId)) lastFocused.current = focusedId
    if (focusedId !== null && stored.panes.includes(focusedId)) layoutStore.set(setFocused(stored, focusedId))
  }, [focusedId, layout, stored, layoutStore])
  useEffect(() => { stateRef.current = state })
  useEffect(() => {
    if (pending === null || state === null) return
    if (state.activeThreadId === pending.threadId || !rowsById.has(pending.threadId) || (pending.settled !== undefined && state !== pending.settled)) setPending(null)
  }, [pending, state, rowsById])
  // Leaving a thread (or the page) saves its latest revision now instead of after the debounce.
  useEffect(() => () => { if (focusedId !== null) store.flush(focusedId) }, [focusedId, store])
  useEffect(() => () => store.flushAll(), [store])
  // Report the threads on screen once per change, and clear them when Threads closes. A thread main has not
  // taken yet is reported when it lands, since naming an unknown thread would say nothing.
  const paneThreads = useRef({ sent: '[]', notify: onPaneThreadsChange })
  useEffect(() => { paneThreads.current.notify = onPaneThreadsChange })
  const paneKey = JSON.stringify(drafts.length === 0 ? paneIds : paneIds.filter(id => !drafts.some(draft => draft.id === id)))
  useEffect(() => {
    if (paneKey === paneThreads.current.sent) return
    paneThreads.current.sent = paneKey
    paneThreads.current.notify?.(JSON.parse(paneKey) as string[])
  }, [paneKey])
  useEffect(() => {
    const current = paneThreads.current
    return () => { if (current.sent !== '[]') current.notify?.([]) }
  }, [])

  const openThread = useCallback((threadId: string): void => { setPending(null); void command({ type: 'select-thread', threadId }) }, [command])
  // A leftover draft taken into a new thread's composer. The coordinator lets its copy go only once main has saved
  // the composer with it, and only if that copy is still the one carried, images included; until then both are kept.
  const placeCarriedDraft = useCallback((threadId: string, carried: CarriedDraft): void => {
    void store.place(threadId, carried).then(placed => {
      if (placed === 'too-long') { setNewThreadError(TOO_LONG_TO_MOVE); return }
      const latest = publishedRef.current
      const sameImages = (latest?.draftAttachments ?? []).map(image => image.id).join('\n') === carried.attachments.map(image => image.id).join('\n')
      if (placed === 'saved' && latest !== null && latest.draft === carried.text && latest.draftThreadId === carried.threadId && sameImages) void command({ type: 'cancel-draft' })
    })
  }, [store, command])
  // Callbacks that cross into the memoised sidebar are hoisted: a fresh function each render would undo the memo.
  // The pane and its composer are on screen before the command is answered; main catches up under the same ID.
  // Shared by every instant-creation entry point: the pen, the empty page's button and the chooser.
  const handleCreationStart = useCallback((start: ThreadCreationStart, carried?: CarriedDraft): void => {
    const projectTitle = publishedRef.current?.host.projects.find(project => project.id === start.thread.projectId)?.title
    draftThreads.open(start.thread, start.created)
    setPending({ threadId: start.thread.id })
    store.restoreRefusedCreation(start.thread.id, start.thread.projectId)
    if (carried) placeCarriedDraft(start.thread.id, carried)
    focusNewComposer()
    void start.created.then(creationError => {
      if (creationError === null) return
      // A broadcast can confirm creation and release sends before the command's reply is lost.
      if (publishedRef.current?.host.threads.some(thread => thread.id === start.thread.id)) return
      // The pane is gone and gated sends never left the window; retain all its content, not just unsent text.
      const kept = store.carryRefusedCreation(start.thread.id, start.thread.projectId)
      setNewThreadError(kept
        ? `${creationError} Your prompt and screenshots are kept. Open New thread in ${projectTitle ?? 'the same project'} to get them back.`
        : creationError)
    })
  }, [store, placeCarriedDraft])
  // The pen and the empty page's button already know their project: the thread opens at once, on the defaults
  // from Settings → Agents, selected and focused; a refusal shows in the sidebar's own error place.
  // Settles once the thread has opened or been refused.
  const createThreadIn = useCallback((project: AgentProject, carried?: CarriedDraft): Promise<void> => {
    if (state === null) return Promise.resolve()
    setNewThreadError(null)
    const unused = unusedNewThread(state, project)
    if (unused) {
      store.restoreRefusedCreation(unused.id, project.id)
      if (carried) placeCarriedDraft(unused.id, carried)
      openThread(unused.id); focusNewComposer(); return Promise.resolve()
    }
    return beginNewThread(state, command, project).then(start => {
      if ('error' in start) { setNewThreadError(start.error); return }
      handleCreationStart(start, carried)
    })
  }, [state, command, handleCreationStart, openThread, store, placeCarriedDraft])
  // A new thread in this project, or the chooser when there is none; with a draft, the thread opens with it.
  const startNewThread = useCallback((projectId?: string, carried?: CarriedDraft): Promise<void> => {
    setNewThreadError(null)
    const project = projectId !== undefined ? state?.host.projects.find(item => item.id === projectId) : undefined
    if (project) return createThreadIn(project, carried)
    setChooser(carried ? { carried } : {})
    return Promise.resolve()
  }, [state, createThreadIn])
  const openNewThread = useCallback((projectId?: string): void => { void startNewThread(projectId) }, [startNewThread])
  // A New thread pressed in the sidebar beside another page lands here, once, after the navigation to Threads.
  useEffect(() => { const intent = takeNewThreadIntent(); if (intent !== null) openNewThread(intent.projectId) }, [openNewThread])
  // Ctrl+Shift+N (Cmd+Shift+N on a Mac): a new thread in the focused thread's project, or the chooser when none
  // is focused. Checked against the dictation hotkey like every other chord; an open dialog or a terminal keeps
  // its keys.
  const platform: SottoPlatform = app?.platform ?? 'win32'
  const hotkey = app?.settings?.hotkey
  const shortcutChord = newThreadChord(hotkey, platform)
  // Hoisted rather than a fresh object every render: passed down to the memoised sidebar rows, which compare it.
  const newThreadShortcutLabel = useMemo(() => shortcutChord ? newThreadChordLabel(platform) : undefined, [shortcutChord, platform])
  const dismissNewThreadError = useCallback((): void => setNewThreadError(null), [])
  useEffect(() => {
    if (shortcutChord === null) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (!newThreadChordPressed(event, shortcutChord, platform)) return
      event.preventDefault()
      // The focused pane's project, or the chooser: unlike the empty page's own button, this never falls back
      // to the last-active project, since no thread being focused is exactly when the project is unclear.
      openNewThread(focusedId !== null ? rowsById.get(focusedId)?.thread.projectId : undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcutChord, platform, focusedId, rowsById, openNewThread])
  // The pane actions are rebuilt every render from the current layout; the sidebar is handed a stable
  // entry point into the latest one instead.
  const gridRef = useRef<ReturnType<typeof paneGridActions> | null>(null)
  const openBeside = useCallback((threadId: string): void => gridRef.current?.openBesideFocused(threadId), [])
  /** The user put this pane in focus: it takes the selection. Nothing else ever sends select-thread from here. */
  const focusPane = useCallback((threadId: string): void => {
    if (threadId === focusedId) return
    setPending({ threadId })
    const settle = (): void => setPending(current => current?.threadId === threadId && current.settled === undefined ? { threadId, settled: stateRef.current } : current)
    void command({ type: 'select-thread', threadId }).then(settle, settle)
  }, [command, focusedId])
  // macOS paints its own window controls, so the page keeps no room for ours at its right edge.
  const mac = app?.platform === 'darwin'
  const page = `management-view threads-view${mac ? ' threads-view--mac' : ''}`
  if (state === null) return <div className={mac ? 'threads-view threads-view--bare threads-view--mac' : 'threads-view threads-view--bare'}>
    <p role="status">{agents.error ?? 'Preparing agent controls…'}</p>
    {/* An error can stand for good, and this page has no sidebar to leave by. */}
    {agents.error && app ? <Button variant="ghost" onClick={() => app.actions.navigate('settings')}>Open Settings</Button> : null}
    <PageWindowControls />
  </div>
  // Terminal mode keeps the same frame; the threads and their panes wait, unchanged, for the switch back.
  if (mode === 'terminals') {
    return <SidebarChromeProvider updateControl={updateControl}><div className={page} data-mode="terminals">
      <TerminalWorkspace state={state} command={command} mode={mode} onMode={setMode} now={fixedNow} {...terminals} paneAreaWidth={paneAreaWidth} paneAreaHeight={paneAreaHeight} />
      <PageWindowControls />
    </div></SidebarChromeProvider>
  }

  const grid = paneGridActions({ layout, focusedId, paneIds, layoutStore, exists: id => rowsById.has(id), open: openThread, focus: focusPane })
  gridRef.current = grid

  const localDraftPresent = focusedId !== null && hasDraftContent(store.draft(focusedId))
  const recoverCommand: Command = async request => {
    if (request.type === 'recover-draft' && hasDraftContent(store.draft(request.threadId))) return state
    return command(request)
  }
  const recoveredDraft = isRecoveredDraft(state)
  const error = state.error ?? agents.error
  const split = paneIds.length >= 2
  const renderPane = (threadId: string): ReactNode => {
    const row: ThreadRow | undefined = rowsById.get(threadId)
    if (row === undefined) return null
    const focused = threadId === focusedId
    const slot: ThreadPaneSlotProps = { row, state, command, focused, focusPrompt: () => focusInPane(threadId) }
    // The focused pane's own actions come first: the header's actions sit at its right edge, so one that appears
    // only on focus must not push the every-pane actions sideways under a pointer that is focusing the pane.
    const focusedActions = focused ? focusedPaneActions : undefined
    const everyPaneActions = paneActions?.(slot)
    const actions = focusedActions || everyPaneActions ? <>{focusedActions}{everyPaneActions}</> : undefined
    return <ThreadPane row={row} state={state} command={command} store={store} focused={focused}
      promptId={split ? threadPromptId(threadId) : THREAD_PROMPT_ID} error={focused ? error : null} onOpenThread={openThread}
      onFocusPane={() => focusPane(threadId)} onOpenBeside={() => openBeside(threadId)} now={fixedNow}
      workingCopy={paneWorkingCopy?.(slot)} notice={paneNotice?.(slot)} actions={actions} drawer={paneDrawer?.(slot)} />
  }

  return <SidebarChromeProvider updateControl={updateControl}><div className={page} onKeyDown={grid.onKeyDown}>
    {chooser !== null && <NewThreadDialog state={state} command={command}
      onClose={() => setChooser(null)}
      onCreating={start => { setChooser(null); handleCreationStart(start, chooser.carried) }}
      onCreated={() => { setChooser(null); focusNewComposer() }} />}
    <ThreadSidebar state={state} command={command} organization={organization} query={query} liveClock={fixedNow === undefined} mode={mode} onMode={setMode} onQuery={setQuery} onOpen={openThread} onNewThread={openNewThread}
      currentThreadId={focusedId} openThreadIds={paneIds} onOpenBeside={openBeside} onDragThread={setDragging}
      newThreadError={newThreadError} onDismissNewThreadError={dismissNewThreadError} newThreadShortcut={newThreadShortcutLabel} />
    <section className="thread-workspace" aria-label="Thread workspace">
      {/* Before the panes, so it comes first in keyboard order; it sits in the top strip beside the window controls. */}
      <HostUpdateControl />
      {recoveredDraft ? <ProviderUpgradeNotice state={state} command={recoverCommand} threadId={focusedId ?? undefined} localDraftPresent={localDraftPresent} /> : null}
      <div className="thread-workspace__body">
        {paneIds.length || dragging !== null
          ? <ThreadPanes layout={layout} paneIds={paneIds} rows={labels} focusedId={focusedId} dragging={dragging} renderPane={renderPane}
            onFocusPane={focusPane} onLayoutChange={next => layoutStore.set(next)} onDrop={(threadId, target) => { setDragging(null); grid.onDrop(threadId, target) }} onClosePane={grid.close} measuredWidth={paneAreaWidth} measuredHeight={paneAreaHeight} />
          : null}
        {!paneIds.length ? <EmptyWorkspace state={state} command={command} voice={voice} error={error}
          onNewThread={() => openNewThread(state.activeProjectId ?? undefined)} onNewThreadWithDraft={draft => startNewThread(state.activeProjectId ?? undefined, draft)}
          onOpenThread={threadId => { focusPane(threadId); focusNewComposer() }} onOpenAgents={onOpenAgents} /> : null}
        {tools ? <div className="thread-workspace__tools">{tools({ focusedThreadId: focusedId, state, command })}</div> : null}
      </div>
    </section>
    <PageWindowControls />
  </div></SidebarChromeProvider>
}
