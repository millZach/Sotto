import React, { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useOwlFeature } from '../state/owlFeature'
import { useOptionalApp } from '../state/AppContext'
import { useWatcherEnabled } from '../state/watcherFeature'
import { visibleWatcherState, withoutRoomWatcher } from './watcherVisibility'
import { useRoomWatcherThreadId } from '../watcher/watcherRoom'
import { useAgents } from './AgentContext'
import { overlayDraftThreads, useDraftThreads } from './draftThreads'
import { useClock } from './paneGrid'
import { SidebarFoot, SidebarTop, useSidebarMode, type SidebarMode } from './SidebarFrame'
import { useShared } from './stateSharing'
import { describeThreads, organizeWorkspace } from './threadFacts'
import { useContinueEnabled } from './continuations'
import { setNewThreadIntent } from './threadIntent'
import { ThreadSidebar } from './ThreadSidebar'

const NO_PANES: readonly string[] = []
const noop = (): void => {}

/**
 * The Threads sidebar beside a page that is not Threads (Dictate, History, Help): the same list, the same
 * frame, with no thread current and no pane to open beside. Opening a thread or asking for a new one leads to
 * the Threads page, and the Terminal side of the mode switch leads there too, since terminals open in panes.
 * Until main has agent controls the frame stands with the sentence the Threads page would show. The foot's
 * update control comes from the `SidebarChromeProvider` around the shell.
 */
export function PageSidebar({ now: fixedNow }: {
  /** A fixed clock for captures; the rows' times then hold still. */
  readonly now?: number | undefined
}): ReactNode {
  const agents = useAgents()
  const app = useOptionalApp()
  const watcherEnabled = useWatcherEnabled()
  const now = useClock(fixedNow)
  const [mode, setMode] = useSidebarMode()
  const [query, setQuery] = useState('')
  const drafts = useDraftThreads()
  const published = agents.state
  // Watcher's room keeps the current Watcher; this page lists and selects only the other threads.
  const roomWatcher = useRoomWatcherThreadId()
  const state = useMemo(() => withoutRoomWatcher(visibleWatcherState(overlayDraftThreads(published, drafts), watcherEnabled), watcherEnabled, roomWatcher),
    [published, drafts, watcherEnabled, roomWatcher])
  const continued = useContinueEnabled()
  const rows = useShared(useMemo(() => state === null ? [] : describeThreads(state, now, { continued }), [state, now, continued]))
  // Delegated threads sit under the thread that delegated to them (ADR-0081; Owl only).
  const nestDelegated = useOwlFeature('thread-delegation')
  const organization = useShared(useMemo(() => state === null ? { open: [], settled: [], matching: 0 } : organizeWorkspace(state, rows, query, state.activeProjectId, nestDelegated), [state, rows, query, nestDelegated]))
  const navigate = app?.actions.navigate
  const command = agents.command
  const openThread = useCallback((threadId: string): void => {
    void command({ type: 'select-thread', threadId })
    navigate?.('threads')
  }, [command, navigate])
  // The new thread opens in Threads mode, even when the page was last left in Terminal mode, so it is not made unseen.
  const startNewThread = useCallback((projectId?: string): void => {
    setNewThreadIntent({ projectId })
    setMode('threads')
    navigate?.('threads')
  }, [navigate, setMode])
  const onMode = useCallback((next: SidebarMode): void => {
    setMode(next)
    if (next === 'terminals') navigate?.('threads')
  }, [setMode, navigate])

  if (state === null) {
    return <aside className={app?.platform === 'darwin' ? 'thread-nav thread-nav--mac' : 'thread-nav'} aria-label="Thread sidebar">
      <SidebarTop />
      <div className="thread-nav__scroll"><p className="thread-nav__empty">{agents.error ?? 'Preparing agent controls…'}</p></div>
      <SidebarFoot />
    </aside>
  }
  return <ThreadSidebar state={state} command={command} organization={organization} query={query} liveClock={fixedNow === undefined} mode={mode} onMode={onMode} onQuery={setQuery}
    onOpen={openThread} onNewThread={startNewThread} currentThreadId={null} openThreadIds={NO_PANES} onOpenBeside={noop} onDragThread={noop} title={null} />
}
