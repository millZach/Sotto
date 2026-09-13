import React, { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import { Button } from '../components/Button'
import { useAgents, type AgentConnection } from './AgentContext'
import { describeThreads, organizeWorkspace, type ThreadRow } from './threadFacts'
import { NewThreadDialog } from './NewThreadDialog'
import { ProviderUpgradeNotice } from './ProviderUpgradeNotice'
import { THREAD_PROMPT_ID } from './ThreadComposer'
import { hasDraftContent } from './threadDraftStore'
import { ThreadPane } from './ThreadPane'
import { ThreadPanes, focusInPane, type DropTarget } from './ThreadPanes'
import { ThreadSidebar } from './ThreadSidebar'
import {
  closePane, evenSplit, isSplit, openBeside, prune, replacePane, resizeSplit, retarget, splitLayoutStore, threadPromptId, useSplitLayout,
  type SplitLayoutStore,
} from './splitLayout'

type Command = AgentConnection['command']

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
  /** Test-only: the pane area's width where layout measurement is unavailable. */
  readonly paneAreaWidth?: number | undefined
}
function useClock(fixed: number | undefined): number {
  const [tick, setTick] = useState(() => Date.now())
  useEffect(() => {
    if (fixed !== undefined) return
    const timer = setInterval(() => setTick(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [fixed])
  return fixed ?? tick
}

export function ThreadsView({ onOpenAgents, now: fixedNow, tools, focusedPaneActions, paneCrumb, paneNotice, onPaneThreadsChange, layoutStore = splitLayoutStore, paneAreaWidth }: ThreadsViewProps): ReactNode {
  const agents = useAgents()
  const now = useClock(fixedNow)
  const [query, setQuery] = useState('')
  const [newThread, setNewThread] = useState<{ readonly projectId?: string | undefined } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  // The pane the user just focused, shown at once while main confirms the selection. Once the command
  // settles, the next published state is the truth, so an older echo cannot pull focus back meanwhile.
  const [pending, setPending] = useState<{ readonly threadId: string; readonly settled?: AgentState | null } | null>(null)
  const stateRef = useRef<AgentState | null>(null)
  const lastFocused = useRef<string | null>(null)
  const store = agents.threadDrafts
  const state = agents.state
  const command = agents.command
  const rows = useMemo(() => state === null ? [] : describeThreads(state, now), [state, now])
  const rowsById = useMemo(() => new Map(rows.map(row => [row.thread.id, row] as const)), [rows])
  const organization = useMemo(() => state === null ? { open: [], settled: [], matching: 0 } : organizeWorkspace(state, rows, query, state.activeProjectId), [state, rows, query])
  const stored = useSplitLayout(layoutStore)
  const activeId = state?.activeThreadId != null && rowsById.has(state.activeThreadId) ? state.activeThreadId : null
  const pendingFocus = pending?.threadId ?? null
  const focusedId = pendingFocus !== null && rowsById.has(pendingFocus) ? pendingFocus : activeId
  // Panes whose thread is gone close; a selection made elsewhere (voice, attention, a new thread) moves only the focused pane.
  const layout = state === null || rows.length === 0 ? stored : retarget(prune(stored, id => rowsById.has(id)), lastFocused.current, focusedId)
  const paneIds = isSplit(layout) ? layout.panes : focusedId !== null ? [focusedId] : []

  useEffect(() => { if (layout !== stored) layoutStore.set(layout) }, [layout, stored, layoutStore])
  useEffect(() => { if (focusedId === null || !isSplit(layout) || layout.panes.includes(focusedId)) lastFocused.current = focusedId }, [focusedId, layout])
  useEffect(() => { stateRef.current = state })
  useEffect(() => {
    if (pending === null || state === null) return
    if (state.activeThreadId === pending.threadId || !rowsById.has(pending.threadId) || (pending.settled !== undefined && state !== pending.settled)) setPending(null)
  }, [pending, state, rowsById])
  // Leaving a thread (or the page) saves its latest revision now instead of after the debounce.
  useEffect(() => () => { if (focusedId !== null) store.flush(focusedId) }, [focusedId, store])
  useEffect(() => () => store.flushAll(), [store])
  // Report the threads on screen once per change, and clear them when Threads closes.
  const paneThreads = useRef({ sent: '[]', notify: onPaneThreadsChange })
  useEffect(() => { paneThreads.current.notify = onPaneThreadsChange })
  const paneKey = JSON.stringify(paneIds)
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
  /** The user put this pane in focus: it takes the selection. Nothing else ever sends select-thread from here. */
  const focusPane = useCallback((threadId: string): void => {
    if (threadId === focusedId) return
    setPending({ threadId })
    const settle = (): void => setPending(current => current?.threadId === threadId && current.settled === undefined ? { threadId, settled: stateRef.current } : current)
    void command({ type: 'select-thread', threadId }).then(settle, settle)
  }, [command, focusedId])
  const focusPaneLater = (threadId: string): void => { window.setTimeout(() => focusInPane(threadId), 0) }

  if (state === null) return <div className="threads-view"><p role="status">{agents.error ?? 'Preparing agent controls...'}</p></div>

  const openBesideFocused = (threadId: string, side: 'start' | 'end' = 'end'): void => {
    if (focusedId === null) { openThread(threadId); return }
    if (threadId === focusedId) return
    layoutStore.set(openBeside(layout, focusedId, threadId, side))
    focusPane(threadId)
  }
  const onDrop = (threadId: string, target: DropTarget): void => {
    setDragging(null)
    if (!rowsById.has(threadId)) return
    if (target.kind === 'open') openThread(threadId)
    else if (target.kind === 'side') openBesideFocused(threadId, target.side)
    else {
      if (!layout.panes.includes(threadId)) layoutStore.set(replacePane(layout, target.index, threadId))
      focusPane(threadId)
    }
    focusPaneLater(threadId)
  }
  const close = (threadId: string): void => {
    const others = layout.panes.filter(id => id !== threadId)
    layoutStore.set(closePane(layout, threadId))
    // Closing changes only the view. Focus goes to the neighbouring pane when the closed one had it.
    const keep = threadId === focusedId ? others[Math.max(0, layout.panes.indexOf(threadId) - 1)] : focusedId
    if (keep === undefined || keep === null) return
    if (threadId === focusedId) focusPane(keep)
    focusPaneLater(keep)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // F6 moves between panes, as it moves between the panes of other Windows apps.
    if (event.key !== 'F6' || event.altKey || event.ctrlKey || event.metaKey || paneIds.length < 2) return
    event.preventDefault()
    const index = focusedId === null ? -1 : paneIds.indexOf(focusedId)
    // From outside the panes (the sidebar), F6 enters the focused pane; inside, it moves to the next one.
    const inside = (event.target as HTMLElement).closest('.thread-pane') !== null
    const next = !inside && focusedId !== null ? focusedId : paneIds[(index + (event.shiftKey ? -1 : 1) + paneIds.length) % paneIds.length]!
    focusPane(next)
    focusPaneLater(next)
  }

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
      onClose={split ? () => close(threadId) : undefined} onFocusPane={() => focusPane(threadId)}
      crumb={paneCrumb?.(slot)} notice={paneNotice?.(slot)} actions={focused ? focusedPaneActions : undefined} />
  }

  return <div className="management-view threads-view" onKeyDown={onKeyDown}>
    {newThread && <NewThreadDialog state={state} command={command} initialProjectId={newThread.projectId} onClose={() => setNewThread(null)} onCreated={() => { setNewThread(null); window.setTimeout(() => document.querySelector<HTMLElement>('.thread-pane[data-focused] .thread-prompt textarea')?.focus(), 0) }} />}
    <ThreadSidebar state={state} command={command} organization={organization} query={query} onQuery={setQuery} onOpen={openThread} onNewThread={projectId => setNewThread({ projectId })}
      currentThreadId={focusedId} openThreadIds={paneIds} onOpenBeside={openBesideFocused} onDragThread={setDragging} />
    <section className="thread-workspace" aria-label="Thread workspace">
      {recoveredDraft ? <ProviderUpgradeNotice state={state} command={recoverCommand} threadId={focusedId ?? undefined} localDraftPresent={localDraftPresent} /> : null}
      <div className="thread-workspace__body">
        {paneIds.length || dragging !== null
          ? <ThreadPanes paneIds={paneIds} rows={rowsById} focusedId={focusedId} share={layout.sizes[0] ?? 0.5} dragging={dragging} renderPane={renderPane}
            onFocusPane={focusPane} onResize={(share, width) => layoutStore.set(resizeSplit(layout, share, width))} onEven={() => layoutStore.set(evenSplit(layout))} onDrop={onDrop} measuredWidth={paneAreaWidth} />
          : null}
        {!paneIds.length ? <div className="thread-workspace__empty"><MessageSquare size={30} strokeWidth={1.3} aria-hidden="true" /><h2>{savedDraft ? 'Your draft is saved.' : rows.length ? 'Choose a thread.' : 'No threads yet.'}</h2><p>{savedDraft ? 'Reconnect to continue your saved draft.' : rows.length ? 'Select a thread to read its messages and continue working.' : 'Start a thread to begin working with your agent.'}</p>{savedDraft ? <div className="thread-prompt thread-prompt--saved"><label className="tt-visually-hidden" htmlFor="saved-thread-prompt">Prompt</label><textarea id="saved-thread-prompt" rows={4} value={state.draft} readOnly /></div> : null}{!connected ? <Button disabled={state.connection === 'connecting'} onClick={() => void command({ type: 'connect' })}>{state.connection === 'connecting' ? 'Connecting...' : 'Connect providers'}</Button> : <Button onClick={() => setNewThread({ projectId: state.activeProjectId ?? undefined })}>New thread</Button>}<Button variant="ghost" onClick={onOpenAgents}>Open Agents</Button></div> : null}
        {tools ? <div className="thread-workspace__tools">{tools({ focusedThreadId: focusedId, state, command })}</div> : null}
      </div>
    </section>
  </div>
}
