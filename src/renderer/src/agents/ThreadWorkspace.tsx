import React, { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useToolsPanelChrome } from '../tools/toolsPanelStore'
import { ToolsPanel, ToolsPanelToggle } from '../tools/ToolsPanel'
import { hideDrawerFromInside, PaneTerminalDrawer } from '../tools/PaneTerminalDrawer'
import { PaneTerminalToggle, usePaneTerminalShortcut } from '../tools/PaneTerminalToggle'
import { paneTerminalTarget } from '../tools/paneTerminalShortcut'
import { paneTerminalChromeStore } from '../tools/paneTerminalStore'
import { useAgents } from './AgentContext'
import { ThreadsView, type ThreadsViewProps } from './ThreadsView'
import { ThreadWorkingCopy, ThreadWorkingCopyNotice } from './ThreadWorkingCopy'

/** Connect the shared tools surface, each pane's actual working copy and its own terminal drawer to the workspace. */
export function ThreadWorkspace(props: Pick<ThreadsViewProps, 'now' | 'updateControl'>): ReactNode {
  const { command, state } = useAgents()
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

  // Ctrl+J (Cmd+J on a Mac) toggles the drawer of the pane it lands in, or the selected thread's pane when that
  // is on screen, including from inside the drawer's own terminal, which passes the chord to the page. Opened by
  // keyboard, focus moves into the terminal once it is ready; hidden from inside it, focus returns to the pane.
  const shortcut = usePaneTerminalShortcut()
  const selectedThreadId = state?.activeThreadId
  useEffect(() => {
    if (shortcut === null) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      const threadId = paneTerminalTarget(event, shortcut, selectedThreadId)
      if (threadId === null) return
      event.preventDefault()
      if (paneTerminalChromeStore.get(threadId).open) {
        if (document.activeElement?.closest('.pane-terminal') != null) hideDrawerFromInside(threadId)
        else paneTerminalChromeStore.setOpen(threadId, false)
      } else {
        paneTerminalChromeStore.requestFocus(threadId)
        paneTerminalChromeStore.setOpen(threadId, true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcut, selectedThreadId])

  return <ThreadsView {...props}
    tools={tools => <ToolsPanel {...tools} />}
    focusedPaneActions={<ToolsPanelToggle />}
    // A thread on a paired host keeps its terminal on that machine, as Tools says, so its pane has no drawer.
    paneActions={({ row }) => row.thread.remoteHost ? null : <PaneTerminalToggle threadId={row.thread.id} />}
    paneWorkingCopy={({ row, command: paneCommand }) => <ThreadWorkingCopy thread={row.thread} project={row.project} command={paneCommand} />}
    paneNotice={({ row, command: paneCommand, focusPrompt }) => <ThreadWorkingCopyNotice key={`working-copy-${row.thread.id}`} thread={row.thread} project={row.project} command={paneCommand} onRecovered={focusPrompt} />}
    paneDrawer={({ row }) => row.thread.remoteHost ? null : <PaneTerminalDrawer key={`terminal-drawer-${row.thread.id}`} threadId={row.thread.id} thread={row.thread} project={row.project} />}
    onPaneThreadsChange={observe}
  />
}
