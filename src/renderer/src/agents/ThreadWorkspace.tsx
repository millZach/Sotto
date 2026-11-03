import React, { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useToolsPanelChrome } from '../tools/toolsPanelStore'
import { ToolsPanel } from '../tools/ToolsPanel'
import { hideDrawerFromInside, PaneTerminalDrawer } from '../tools/PaneTerminalDrawer'
import { usePaneTerminalShortcut } from '../tools/PaneTerminalToggle'
import { paneTerminalTarget } from '../tools/paneTerminalShortcut'
import { paneTerminalChromeStore, shownView } from '../tools/paneTerminalStore'
import { useCouncilEnabled } from '../features/council/useCouncils'
import { useOwlFeature } from '../state/owlFeature'
import { useAgents } from './AgentContext'
import { ThreadsView, type ThreadPaneSlot, type ThreadPaneSlotProps, type ThreadToolsSlot, type ThreadsViewProps } from './ThreadsView'
import { ThreadWorkingCopy, ThreadWorkingCopyNotice } from './ThreadWorkingCopy'
import { threadMachineName } from '../tools/TerminalSurface'

// The pane slots are made once, here rather than inline, so each pane's memo boundary sees the same slot on every update
// and redraws only for what the slot is handed (#993).
const tools: ThreadToolsSlot = props => <ToolsPanel {...props} />
const paneWorkingCopy: ThreadPaneSlot = ({ row, command }) => <ThreadWorkingCopy thread={row.thread} project={row.project} command={command} />
const paneNotice: ThreadPaneSlot = ({ row, command, focusPrompt }) => <ThreadWorkingCopyNotice key={`working-copy-${row.thread.id}`} thread={row.thread} project={row.project} command={command} onRecovered={focusPrompt} />
/** A thread on a paired host has a drawer only where its shell can run over SSH (ADR-0183; Owl only). Otherwise its pane says where its terminal is. */
const localPaneTerminal = ({ row }: ThreadPaneSlotProps): boolean => row.thread.remoteHost !== true
const everyPaneTerminal = (): boolean => true
const paneDrawerFor = (hosted: boolean): ThreadPaneSlot => ({ row, state }) => row.thread.remoteHost && !hosted ? null : <PaneTerminalDrawer key={`terminal-drawer-${row.thread.id}`} threadId={row.thread.id} thread={row.thread} project={row.project}
  machine={row.thread.remoteHost ? threadMachineName(state, row.thread) : undefined} />
const LOCAL_DRAWER = paneDrawerFor(false)
const HOSTED_DRAWER = paneDrawerFor(true)

/** Connect the shared tools surface, each pane's actual working copy and its own terminal drawer to the workspace. */
export function ThreadWorkspace(props: Pick<ThreadsViewProps, 'now' | 'updateControl'>): ReactNode {
  const { command, state } = useAgents()
  const hostedTerminal = useOwlFeature('paired-host-terminal')
  const paneTerminal = hostedTerminal ? everyPaneTerminal : localPaneTerminal
  const paneDrawer = hostedTerminal ? HOSTED_DRAWER : LOCAL_DRAWER
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
  // keyboard, focus moves into the terminal once it is ready; hidden from inside it, focus returns to the pane. It presses
  // the Terminal drawer button, so a drawer showing the Council shows its shells instead (ADR-0177).
  const shortcut = usePaneTerminalShortcut()
  const council = useCouncilEnabled()
  const selectedThreadId = state?.activeThreadId
  useEffect(() => {
    if (shortcut === null) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      const threadId = paneTerminalTarget(event, shortcut, selectedThreadId)
      if (threadId === null) return
      event.preventDefault()
      const drawer = paneTerminalChromeStore.get(threadId)
      if (drawer.open && shownView(drawer, council) === 'terminal') {
        if (document.activeElement?.closest('.pane-terminal') != null) hideDrawerFromInside(threadId)
        else paneTerminalChromeStore.setOpen(threadId, false)
      } else {
        paneTerminalChromeStore.requestFocus(threadId)
        paneTerminalChromeStore.show(threadId, 'terminal')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcut, selectedThreadId, council])

  // Tools and each pane's Terminal drawer are rows of the pane's ··· menu (ADR-0163).
  return <ThreadsView {...props} tools={tools} paneTools paneTerminal={paneTerminal}
    paneWorkingCopy={paneWorkingCopy} paneNotice={paneNotice} paneDrawer={paneDrawer} onPaneThreadsChange={observe} />
}
