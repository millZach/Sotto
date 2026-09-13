import React, { useCallback, type ReactNode } from 'react'
import { ToolsPanel, ToolsPanelToggle } from '../tools/ToolsPanel'
import { useAgents } from './AgentContext'
import { ThreadsView, type ThreadsViewProps } from './ThreadsView'
import { ThreadWorkingCopy, ThreadWorkingCopyNotice } from './ThreadWorkingCopy'

/** Connect the shared tools surface and each pane's actual working copy to the workspace. */
export function ThreadWorkspace(props: Pick<ThreadsViewProps, 'onOpenAgents' | 'now'>): ReactNode {
  const { command } = useAgents()
  const observe = useCallback((threadIds: readonly string[]): void => {
    void command({ type: 'observe-threads', threadIds: [...threadIds] })
  }, [command])
  return <ThreadsView {...props}
    tools={tools => <ToolsPanel {...tools} />}
    focusedPaneActions={<ToolsPanelToggle />}
    paneCrumb={({ row, command: paneCommand }) => <ThreadWorkingCopy thread={row.thread} project={row.project} command={paneCommand} />}
    paneNotice={({ row, command: paneCommand, focusPrompt }) => <ThreadWorkingCopyNotice key={`working-copy-${row.thread.id}`} thread={row.thread} project={row.project} command={paneCommand} onRecovered={focusPrompt} />}
    onPaneThreadsChange={observe}
  />
}
