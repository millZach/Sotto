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
  const latestCommand = useRef(command)
  latestCommand.current = command
  const pin = useRef(chrome.pinnedThreadId)
  pin.current = chrome.pinnedThreadId
  const observe = useCallback((threadIds: readonly string[]): void => {
    // Parent cleanup already released observations; ignore the child page's later teardown report.
    if (!mounted.current) return
    panes.current = threadIds
    const ids = new Set(threadIds)
    if (pin.current !== null) ids.add(pin.current)
    void command({ type: 'observe-threads', threadIds: [...ids] })
  }, [command])
  // Workspace lifetime is independent of changing command closures. Establish it before refreshing
  // the pin, including React's StrictMode setup replay; genuine teardown uses the latest command.
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; void latestCommand.current({ type: 'observe-threads', threadIds: [] }) }
  }, [])
  useEffect(() => { observe(panes.current) }, [chrome.pinnedThreadId, observe])
  return <ThreadsView {...props}
    tools={tools => <ToolsPanel {...tools} />}
    focusedPaneActions={<ToolsPanelToggle />}
    paneWorkingCopy={({ row, command: paneCommand }) => <ThreadWorkingCopy thread={row.thread} project={row.project} command={paneCommand} />}
    paneNotice={({ row, command: paneCommand, focusPrompt }) => <ThreadWorkingCopyNotice key={`working-copy-${row.thread.id}`} thread={row.thread} project={row.project} command={paneCommand} onRecovered={focusPrompt} />}
    onPaneThreadsChange={observe}
  />
}
