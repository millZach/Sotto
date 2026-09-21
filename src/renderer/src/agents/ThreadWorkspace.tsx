import React, { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useToolsPanelChrome } from '../tools/toolsPanelStore'
import { ToolsPanel, ToolsPanelToggle } from '../tools/ToolsPanel'
import { useAgents } from './AgentContext'
import { ThreadsView, type ThreadsViewProps } from './ThreadsView'
import { ThreadWorkingCopy, ThreadWorkingCopyNotice } from './ThreadWorkingCopy'

/** Connect the shared tools surface and each pane's actual working copy to the workspace. */
export function ThreadWorkspace(props: Pick<ThreadsViewProps, 'onOpenAgents' | 'now' | 'updateControl'>): ReactNode {
  const { command } = useAgents()
  const chrome = useToolsPanelChrome()
  const panes = useRef<readonly string[]>([])
  const mounted = useRef(true)
  const pin = useRef(chrome.pinnedThreadId)
  pin.current = chrome.pinnedThreadId
  const observe = useCallback((threadIds: readonly string[]): void => {
    panes.current = threadIds
    const ids = new Set(threadIds)
    if (mounted.current && pin.current !== null) ids.add(pin.current)
    void command({ type: 'observe-threads', threadIds: [...ids] })
  }, [command])
  useEffect(() => { observe(panes.current) }, [chrome.pinnedThreadId, observe])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void command({ type: 'observe-threads', threadIds: [] }) } }, [command])
  return <ThreadsView {...props}
    tools={tools => <ToolsPanel {...tools} />}
    focusedPaneActions={<ToolsPanelToggle />}
    paneCrumb={({ row, command: paneCommand }) => <ThreadWorkingCopy thread={row.thread} project={row.project} command={paneCommand} />}
    paneNotice={({ row, command: paneCommand, focusPrompt }) => <ThreadWorkingCopyNotice key={`working-copy-${row.thread.id}`} thread={row.thread} project={row.project} command={paneCommand} onRecovered={focusPrompt} />}
    onPaneThreadsChange={observe}
  />
}
