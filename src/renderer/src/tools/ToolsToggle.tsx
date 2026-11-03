import React, { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { PanelRight, Pin } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import { delegatedThreadsBelow } from '../../../shared/delegation'
import { useDelegationsEnabled } from '../agents/delegations'
import { useBrowserTasks } from './browserStore'
import { delegatedBelow } from './delegatedRoster'
import { toolsPanelStore, useToolsPanelChrome, type ToolsPanelStore } from './toolsPanelStore'

export const TOOLS_PANEL_ID = 'sotto-tools-panel'

/**
 * The Tools symbol in a pane's header (ADR-0182), in every pane of the Threads workspace so nothing there moves as focus
 * changes. It shows and hides the shared panel and never changes the focused thread. Its dot means this pane's own thread
 * has agents working or a browser request waiting, never a pinned thread's (#331); the browser player can be closed,
 * shrunk, hidden or showing another pane's thread, so a waiting request still shows here. In a pane that does not hold
 * focus, the press that focuses the pane moves Tools to its thread, so that press opens the panel and never closes it.
 */
export function ToolsToggle({ threadId, focused, store = toolsPanelStore, state }: {
  readonly threadId: string
  /** This pane holds focus, so Tools is showing its thread and the panel hands focus back here. */
  readonly focused: boolean
  readonly store?: ToolsPanelStore | undefined
  /** The window's state as the pane has it, for what the dot says about this thread. */
  readonly state: AgentState
}): ReactNode {
  const { t } = useLingui()
  const chrome = useToolsPanelChrome(store)
  const button = useRef<HTMLButtonElement | null>(null)
  const pressedUnfocused = useRef(false)
  // A panel closed from the keyboard hands focus here, including to a toggle the resulting layout change re-mounted.
  useLayoutEffect(() => {
    const element = button.current
    if (!focused || !element || !store.togglePendingFocus()) return
    const active = document.activeElement
    if (active === element) return
    if (active === null || active === document.body || !active.isConnected) element.focus()
    else store.clearToggleFocus()
  }, [chrome.open, store, focused])
  const delegation = useDelegationsEnabled()
  const browserTasks = useBrowserTasks(store.browser)
  const pinned = chrome.pinnedThreadId
  // The threads this pane's thread delegated (ADR-0081; Owl only) count as its agents: working, or waiting on you.
  const below = delegation ? delegatedBelow(state.host.threads, threadId) : { needs: 0, working: 0 }
  const workingAgents = (state.host.threads.find(thread => thread.id === threadId)?.subagentSummary?.working ?? 0) > 0 || below.working > 0
  // This pane's own thread, never the pin: a pin shows in another pane's Tools, not by lighting every pane's dot (#331).
  const browserWaiting = browserTasks.some(task => task.threadId === threadId && task.pendingAction !== null)
  // While Tools is pinned to a roster's thread and this pane shows that thread or one it delegated, a delegated thread
  // waiting on you there still marks the button: answering one, Tools stays on the roster where others may wait. The
  // pin lights nothing else here (#331).
  const rosterOwner = delegation && pinned !== null && threadId !== pinned
    && delegatedThreadsBelow(state.host.threads, pinned).includes(threadId) ? pinned : undefined
  const delegatedWaiting = (rosterOwner !== undefined ? delegatedBelow(state.host.threads, rosterOwner) : below).needs > 0
  const pinnedElsewhere = chrome.open && (chrome.surface !== 'agents' || delegation) && pinned !== null && threadId !== pinned
  const pinnedTitle = pinnedElsewhere ? state.host.threads.find(thread => thread.id === pinned)?.title ?? t({ message: 'another thread', comment: 'Stands in for a thread\'s title, as in "Tools are pinned to another thread".' }) : null
  const tools = t({ message: 'Tools', comment: 'The panel beside a thread that holds its browser, terminal, files, changes and agents.' })
  const live = [delegatedWaiting ? t`A delegated thread needs you` : null, workingAgents ? t`Agents are working` : null, browserWaiting ? t`A browser request is waiting for your answer` : null].filter(Boolean).join('. ') || undefined
  const pinnedWords = pinnedTitle === null ? null : t({ message: `Showing ${pinnedTitle}, pinned`, comment: '{pinnedTitle} is a thread\'s title.' })
  const name = pinnedTitle === null ? tools : t({ message: `Tools are pinned to ${pinnedTitle}`, comment: '{pinnedTitle} is a thread\'s title.' })
  // Icon only in the header; the word stays for a screen reader, and as the title when nothing else explains it.
  return <button ref={button} type="button" className="pane-action tt-focusable tools-toggle" aria-pressed={chrome.open && (focused || pinned === threadId)} aria-controls={TOOLS_PANEL_ID}
    data-pinned-elsewhere={pinnedElsewhere || undefined} aria-description={[pinnedWords, live].filter(Boolean).join('. ') || undefined} title={live ? `${name}. ${live}` : name}
    onPointerDown={() => { pressedUnfocused.current = !focused }} onKeyDown={() => { pressedUnfocused.current = false }}
    onClick={() => {
      const opensOnly = pressedUnfocused.current
      pressedUnfocused.current = false
      if (opensOnly) store.setOpen(true)
      else store.toggle()
    }}>
    {pinnedElsewhere ? <Pin size={16} aria-hidden="true" /> : <PanelRight size={16} aria-hidden="true" />}<span className="tt-visually-hidden">{tools}</span>
    {workingAgents || browserWaiting || delegatedWaiting ? <span className="tools-dot" data-needs={delegatedWaiting || undefined} aria-hidden="true" /> : null}
  </button>
}
