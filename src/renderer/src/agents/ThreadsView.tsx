import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import { PageWindowControls } from '../components/WindowControls'
import { useOptionalApp } from '../state/AppContext'
import { useVoiceCoordinatorEnabled } from '../state/voiceCoordinator'
import { useAgents, type AgentConnection } from './AgentContext'
import { draftThreads, gateOnCreation, overlayDraftThreads, useDraftThreads } from './draftThreads'
import { describeThreads, organizeWorkspace, type ThreadRow } from './threadFacts'
import { NewThreadDialog, type NewThreadChoices } from './NewThreadDialog'
import { ProviderUpgradeNotice } from './ProviderUpgradeNotice'
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

/** Put the cursor in the composer of the pane that just appeared, once it has been painted. */
function focusNewComposer(): void {
  window.setTimeout(() => document.querySelector<HTMLElement>('.thread-pane[data-focused] .thread-prompt textarea')?.focus(), 0)
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
  /** Once, at the end of the focused pane's header actions (the tools panel's toggle). */
  readonly focusedPaneActions?: ReactNode
  /** In each pane's header, after the project title. */
  readonly paneCrumb?: ThreadPaneSlot | undefined
  /** In each pane, directly above its composer. */
  readonly paneNotice?: ThreadPaneSlot | undefined
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
export function ThreadsView({ onOpenAgents, now: fixedNow, updateControl, tools, focusedPaneActions, paneCrumb, paneNotice, onPaneThreadsChange, layoutStore = splitLayoutStore, terminals, paneAreaWidth, paneAreaHeight }: ThreadsViewProps): ReactNode {
  const agents = useAgents()
  const app = useOptionalApp()
  // Voice is hidden for the beta, and the Agents room is a voice surface: without it the page offers only a new thread.
  const voice = useVoiceCoordinatorEnabled()
  const now = useClock(fixedNow)
  const [mode, setMode] = useSidebarMode()
  const [query, setQuery] = useState('')
  // Reopened with `choices` and `error` when main refuses a creation this view was already showing.
  const [newThread, setNewThread] = useState<{ readonly projectId?: string | undefined; readonly choices?: NewThreadChoices | undefined; readonly error?: string | undefined } | null>(null)
  // A New thread pressed in the sidebar beside another page opens the dialog here, once.
  useEffect(() => { const intent = takeNewThreadIntent(); if (intent !== null) setNewThread(intent) }, [])
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
  const state = useMemo(() => overlayDraftThreads(published, drafts), [published, drafts])
  const command = useMemo(() => gateOnCreation(agents.command), [agents.command])
  useEffect(() => { draftThreads.reconcile(published) }, [published])
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
  // Callbacks that cross into the memoised sidebar are hoisted: a fresh function each render would undo the memo.
  const startNewThread = useCallback((projectId?: string): void => { setNewThread({ projectId }) }, [])
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

  const connected = state.connection === 'connected'
  const localDraftPresent = focusedId !== null && hasDraftContent(store.draft(focusedId))
  const recoverCommand: Command = async request => {
    if (request.type === 'recover-draft' && hasDraftContent(store.draft(request.threadId))) return state
    return command(request)
  }
  const recoveredDraft = Boolean(state.providerUpgrade && state.draftThreadId === null && (state.draft || state.draftAttachments?.length))
  const savedDraft = !recoveredDraft && Boolean(state.draft || state.draftAttachments?.length)
  const error = state.error ?? agents.error
  const split = paneIds.length >= 2
  const renderPane = (threadId: string): ReactNode => {
    const row: ThreadRow | undefined = rowsById.get(threadId)
    if (row === undefined) return null
    const focused = threadId === focusedId
    const slot: ThreadPaneSlotProps = { row, state, command, focused, focusPrompt: () => focusInPane(threadId) }
    return <ThreadPane row={row} state={state} command={command} store={store} focused={focused}
      promptId={split ? threadPromptId(threadId) : THREAD_PROMPT_ID} error={focused ? error : null} onOpenThread={openThread}
      onFocusPane={() => focusPane(threadId)} onOpenBeside={() => openBeside(threadId)}
      crumb={paneCrumb?.(slot)} notice={paneNotice?.(slot)} actions={focused ? focusedPaneActions : undefined} />
  }

  return <SidebarChromeProvider updateControl={updateControl}><div className={page} onKeyDown={grid.onKeyDown}>
    {newThread && <NewThreadDialog state={state} command={command} initialProjectId={newThread.projectId} initialChoices={newThread.choices} initialError={newThread.error}
      onClose={() => setNewThread(null)}
      onCreating={start => {
        // The pane and its composer are on screen before the command is answered; main catches up under the same ID.
        draftThreads.open(start.thread, start.created)
        setNewThread(null)
        setPending({ threadId: start.thread.id })
        focusNewComposer()
        void start.created.then(error => { if (error !== null) setNewThread({ projectId: start.choices.projectId, choices: start.choices, error }) })
      }}
      onCreated={() => { setNewThread(null); focusNewComposer() }} />}
    <ThreadSidebar state={state} command={command} organization={organization} query={query} liveClock={fixedNow === undefined} mode={mode} onMode={setMode} onQuery={setQuery} onOpen={openThread} onNewThread={startNewThread}
      currentThreadId={focusedId} openThreadIds={paneIds} onOpenBeside={openBeside} onDragThread={setDragging} />
    <section className="thread-workspace" aria-label="Thread workspace">
      {recoveredDraft ? <ProviderUpgradeNotice state={state} command={recoverCommand} threadId={focusedId ?? undefined} localDraftPresent={localDraftPresent} /> : null}
      <div className="thread-workspace__body">
        {paneIds.length || dragging !== null
          ? <ThreadPanes layout={layout} paneIds={paneIds} rows={labels} focusedId={focusedId} dragging={dragging} renderPane={renderPane}
            onFocusPane={focusPane} onLayoutChange={next => layoutStore.set(next)} onDrop={(threadId, target) => { setDragging(null); grid.onDrop(threadId, target) }} onClosePane={grid.close} measuredWidth={paneAreaWidth} measuredHeight={paneAreaHeight} />
          : null}
        {!paneIds.length ? <div className="thread-workspace__empty"><MessageSquare size={30} strokeWidth={1.3} aria-hidden="true" /><h2>{savedDraft ? 'Your draft is saved.' : rows.length ? 'Choose a thread.' : 'No threads yet.'}</h2><p>{savedDraft ? 'Reconnect to continue your saved draft.' : rows.length ? 'Select a thread to read its messages and continue working.' : 'Start a thread to begin working with your agent.'}</p>{savedDraft ? <div className="thread-prompt thread-prompt--saved"><label className="tt-visually-hidden" htmlFor="saved-thread-prompt">Prompt</label><textarea id="saved-thread-prompt" rows={4} value={state.draft} readOnly /></div> : null}{!connected ? <Button disabled={state.connection === 'connecting'} onClick={() => void command({ type: 'connect' })}>{state.connection === 'connecting' ? 'Connecting...' : 'Connect providers'}</Button> : <Button onClick={() => setNewThread({ projectId: state.activeProjectId ?? undefined })}>New thread</Button>}{voice ? <Button variant="ghost" onClick={onOpenAgents}>Open Agents</Button> : null}</div> : null}
        {tools ? <div className="thread-workspace__tools">{tools({ focusedThreadId: focusedId, state, command })}</div> : null}
      </div>
    </section>
    <PageWindowControls />
  </div></SidebarChromeProvider>
}
