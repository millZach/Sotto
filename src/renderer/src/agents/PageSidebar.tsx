import React, { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useOptionalApp } from '../state/AppContext'
import { useAgents } from './AgentContext'
import { overlayDraftThreads, useDraftThreads } from './draftThreads'
import { useClock } from './paneGrid'
import { SidebarFoot, SidebarTop, useSidebarMode, type SidebarMode } from './SidebarFrame'
import { useShared } from './stateSharing'
import { describeThreads, organizeWorkspace } from './threadFacts'
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
  const now = useClock(fixedNow)
  const [mode, setMode] = useSidebarMode()
  const [query, setQuery] = useState('')
  const drafts = useDraftThreads()
  const published = agents.state
  const state = useMemo(() => overlayDraftThreads(published, drafts), [published, drafts])
  const rows = useShared(useMemo(() => state === null ? [] : describeThreads(state, now), [state, now]))
  const organization = useShared(useMemo(() => state === null ? { open: [], settled: [], matching: 0 } : organizeWorkspace(state, rows, query, state.activeProjectId), [state, rows, query]))
  const navigate = app?.actions.navigate
  const command = agents.command
  const openThread = useCallback((threadId: string): void => {
    void command({ type: 'select-thread', threadId })
    navigate?.('threads')
  }, [command, navigate])
  const startNewThread = useCallback((projectId?: string): void => {
    setNewThreadIntent({ projectId })
    navigate?.('threads')
  }, [navigate])
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
