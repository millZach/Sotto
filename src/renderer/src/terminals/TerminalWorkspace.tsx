import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SquareTerminal } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { TerminalWorkspaceBridge } from '../../../shared/terminalWorkspace'
import type { AgentConnection } from '../agents/AgentContext'
import type { SidebarMode } from '../agents/SidebarFrame'
import { ThreadPanes, type PaneLabel } from '../agents/ThreadPanes'
import { focusPaneLater, paneGridActions, useClock } from '../agents/paneGrid'
import { SplitLayoutStore, browserStorage, isSplit, prune, retarget, setFocused, useSplitLayout } from '../agents/splitLayout'
import { Button } from '../components/Button'
import type { TerminalViewFactory } from '../tools/terminalStore'
import { useTerminalViewFactory } from '../tools/terminalViewLoader'
import { NewTerminalDialog } from './NewTerminalDialog'
import { describeTerminals, isOpenTerminal, organizeTerminals, terminalState, type TerminalRowState } from './terminalFacts'
import { TerminalPane } from './TerminalPane'
import { TerminalSidebar } from './TerminalSidebar'
import { terminalWorkspaceStore, useTerminalWorkspace, type TerminalWorkspaceStore } from './terminalWorkspaceStore'
import './terminals.css'

const TERMINAL_LAYOUT_STORAGE_KEY = 'sotto.terminalWorkspace.layout'
/** Terminal mode's own arrangement, remembered per window beside the thread arrangement. */
const terminalLayoutStore = new SplitLayoutStore(browserStorage(), TERMINAL_LAYOUT_STORAGE_KEY)

function defaultBridge(): TerminalWorkspaceBridge | undefined {
  return (window.sotto as { terminals?: TerminalWorkspaceBridge } | undefined)?.terminals
}
function defaultPlatform(): string | undefined {
  return (window.sotto as { platform?: string } | undefined)?.platform
}

export interface TerminalWorkspaceProps {
  readonly state: AgentState
  readonly command: AgentConnection['command']
  readonly mode: SidebarMode
  readonly onMode: (mode: SidebarMode) => void
  readonly now?: number | undefined
  readonly store?: TerminalWorkspaceStore
  readonly bridge?: TerminalWorkspaceBridge | undefined
  readonly viewFactory?: TerminalViewFactory
  readonly layoutStore?: SplitLayoutStore
  readonly platform?: string | undefined
  /** Test-only: the pane area's size where layout measurement is unavailable. */
  readonly paneAreaWidth?: number | undefined
  readonly paneAreaHeight?: number | undefined
}

/**
 * Terminal mode: the sidebar's terminals and the pane grid they open in. The grid, its divider, grip, expand and
 * close are the thread workspace's; only what a pane holds differs.
 */
export function TerminalWorkspace({ state, command, mode, onMode, now: fixedNow, store = terminalWorkspaceStore, bridge = defaultBridge(), viewFactory: injected,
  layoutStore = terminalLayoutStore, platform = defaultPlatform(), paneAreaWidth, paneAreaHeight }: TerminalWorkspaceProps): ReactNode {
  const workspace = useTerminalWorkspace(store)
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<{ readonly projectId?: string | undefined } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(() => layoutStore.get().focused)
  const lastFocused = useRef<string | null>(null)
  const focusNext = useRef<string | null>(null)
  const openTerminals = useMemo(() => workspace.terminals.filter(isOpenTerminal), [workspace.terminals])
  // Running against Idle needs a clock; it ticks only while a terminal is open.
  const now = useClock(fixedNow, 2_000, openTerminals.length > 0)
  const rows = useMemo(() => describeTerminals(state, workspace.terminals, now), [state, workspace.terminals, now])
  const rowsById = useMemo(() => new Map(rows.map(row => [row.terminal.id, row] as const)), [rows])
  const labels = useMemo(() => new Map<string, PaneLabel>(rows.map(row => [row.terminal.id, { title: row.title, providerId: row.providerId, provider: row.provider }] as const)), [rows])
  const organization = useMemo(() => organizeTerminals(state, rows, query), [state, rows, query])
  const stored = useSplitLayout(layoutStore)
  const isOpen = useCallback((id: string): boolean => { const row = rowsById.get(id); return row !== undefined && isOpenTerminal(row.terminal) }, [rowsById])
  const focused = focusedId !== null && isOpen(focusedId) ? focusedId : null
  const visible = workspace.status === 'ready' ? prune(stored, isOpen) : stored
  const layout = retarget(visible, lastFocused.current ?? visible.focused, focused)
  const paneIds = isSplit(layout) ? layout.panes : focused !== null ? [focused] : []
  const { factory: viewFactory, failed: viewFailed } = useTerminalViewFactory(injected, paneIds.length > 0)

  useEffect(() => { void store.activate(bridge) }, [store, bridge])
  useEffect(() => { if (layout !== visible) layoutStore.set(layout) }, [layout, visible, layoutStore])
  useEffect(() => {
    if (focused === null || !isSplit(layout) || layout.panes.includes(focused)) lastFocused.current = focused
    if (focused !== null && stored.panes.includes(focused)) layoutStore.set(setFocused(stored, focused))
  }, [focused, layout, stored, layoutStore])

  const stateOf = useCallback((id: string): TerminalRowState => {
    const row = rowsById.get(id)
    return row ? terminalState(row.terminal, store.lastOutputAt(id), now) : 'closed'
  }, [rowsById, store, now])
  const openTerminal = (id: string): void => { setFocusedId(id); focusPaneLater(id) }
  // Closing a pane takes it out of the grid; the terminal keeps running and stays in the sidebar.
  const grid = paneGridActions({ layout, focusedId: focused, paneIds, layoutStore, exists: isOpen, open: openTerminal, focus: setFocusedId })
  /** Ends the terminal: its pane goes and it moves to the Closed shelf. */
  const closeTerminal = (id: string): void => {
    if (paneIds.includes(id)) grid.close(id)
    void store.close(bridge, id)
  }
  const reopenTerminal = (id: string): void => {
    focusNext.current = id
    void store.restart(bridge, id).then(() => { const terminal = store.terminal(id); if (terminal && isOpenTerminal(terminal)) openTerminal(id) })
  }

  const renderPane = (id: string): ReactNode => {
    const row = rowsById.get(id)
    if (row === undefined) return null
    return <TerminalPane row={row} store={store} bridge={bridge} viewFactory={viewFactory} viewFailed={viewFailed} focused={id === focused} focusNext={focusNext} busy={workspace.busy} platform={platform} />
  }
  const problem = workspace.status === 'error' ? (bridge ? workspace.error?.message || 'Terminals could not load.' : 'Terminal is not available in this window.') : null

  return <>
    {dialog ? <NewTerminalDialog state={state} command={command} store={store} bridge={bridge} shell={workspace.shell} initialProjectId={dialog.projectId}
      onClose={() => setDialog(null)} onCreated={id => { setDialog(null); focusNext.current = id; if (focused !== null && isSplit(layout)) grid.openBesideFocused(id); else openTerminal(id) }} /> : null}
    <TerminalSidebar state={state} command={command} organization={organization} query={query} stateOf={stateOf} liveClock={fixedNow === undefined} busy={workspace.busy}
      mode={mode} onMode={onMode} onQuery={setQuery} onOpen={openTerminal} onNewTerminal={projectId => setDialog({ projectId })}
      currentId={focused} openIds={paneIds} onOpenBeside={grid.openBesideFocused} onDragTerminal={setDragging} onCloseTerminal={closeTerminal} onReopenTerminal={reopenTerminal} lastLineOf={id => store.lastLine(id)} />
    <section className="thread-workspace terminal-workspace" aria-label="Terminal workspace" onKeyDown={grid.onKeyDown}>
      {workspace.notice ? <p className="agent-error thread-workspace__error" role="alert">{workspace.notice}</p> : null}
      <div className="thread-workspace__body">
        {paneIds.length || dragging !== null
          ? <ThreadPanes layout={layout} paneIds={paneIds} rows={labels} label="Terminal panes" focusedId={focused} dragging={dragging} renderPane={renderPane}
            onFocusPane={setFocusedId} onLayoutChange={next => layoutStore.set(next)} onDrop={(id, target) => { setDragging(null); grid.onDrop(id, target) }} onClosePane={grid.close} measuredWidth={paneAreaWidth} measuredHeight={paneAreaHeight} />
          : null}
        {!paneIds.length ? <div className="thread-workspace__empty"><SquareTerminal size={30} strokeWidth={1.3} aria-hidden="true" />
          <h2>{problem ?? (openTerminals.length ? 'Choose a terminal.' : 'No terminals open.')}</h2>
          <p>{problem ? 'Terminals open in a project folder or its own worktree, with a shell or a provider CLI.' : openTerminals.length ? 'Select a terminal to see its output and type into it.' : 'Open a shell or a provider CLI in a project folder. It keeps running while you work elsewhere.'}</p>
          <Button disabled={!bridge} onClick={() => setDialog({ projectId: state.activeProjectId ?? undefined })}>New terminal</Button>
        </div> : null}
      </div>
    </section>
  </>
}
