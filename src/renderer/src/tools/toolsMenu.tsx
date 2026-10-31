import React, { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { PanelRight, Pin } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import { delegatedThreadsBelow } from '../../../shared/delegation'
import { useDelegationsEnabled } from '../agents/delegations'
import type { PaneMenuItem } from '../agents/PaneMenu'
import { useBrowserTasks } from './browserStore'
import { delegatedBelow } from './delegatedRoster'
import { toolsPanelStore, useToolsPanelChrome, type ToolsPanelStore } from './toolsPanelStore'

/** Where the panel hands focus back when it closes: the More button of the pane whose menu shows Tools. */
export const TOOLS_OPENER = 'tools'

export interface ToolsMenu {
  /** The More menu's Tools row: shows or hides the shared panel and never changes the focused thread. */
  readonly item: PaneMenuItem
  /** The dot the More button wears while this pane's thread has agents working or a browser request waiting. */
  readonly mark: ReactNode
  /** The dot's meaning in words, read with the More button's name. */
  readonly description: string | undefined
  readonly buttonRef: React.RefObject<HTMLButtonElement | null>
}

/**
 * Tools as a row of a pane's More menu (ADR-0163): the focused pane's, as its header button was. Pinned to another
 * thread, the row shows a pin and says whose files are open. The dot it used to wear moves to the More button:
 * this pane's own thread has agents working, or a browser request waiting, never a pinned thread's (#331); the browser
 * player can be closed, shrunk, hidden or showing another pane's thread, so a waiting request still shows here.
 */
export function useToolsMenu({ threadId, offered, store = toolsPanelStore, state }: {
  readonly threadId: string
  /** False in a pane that does not offer Tools; the hooks still run, and nothing is drawn. */
  readonly offered: boolean
  readonly store?: ToolsPanelStore | undefined
  readonly state: AgentState
}): ToolsMenu | null {
  const { t } = useLingui()
  const chrome = useToolsPanelChrome(store)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  // A panel closed from the keyboard hands focus to the More button, including one the resulting layout change re-mounted.
  useLayoutEffect(() => {
    const element = buttonRef.current
    if (!offered || !element || !store.togglePendingFocus()) return
    const active = document.activeElement
    if (active === element) return
    if (active === null || active === document.body || !active.isConnected) element.focus()
    else store.clearToggleFocus()
  }, [chrome.open, store, offered])
  const delegation = useDelegationsEnabled()
  const browserTasks = useBrowserTasks(store.browser)
  if (!offered) return null
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
  return {
    item: { id: 'tools', label: tools, icon: pinnedElsewhere ? <Pin size={15} aria-hidden="true" /> : <PanelRight size={15} aria-hidden="true" />, shown: chrome.open,
      description: [pinnedWords, live].filter(Boolean).join('. ') || undefined, run: () => store.toggle() },
    mark: workingAgents || browserWaiting || delegatedWaiting ? <span className="tools-dot" data-needs={delegatedWaiting || undefined} aria-hidden="true" /> : null,
    description: live,
    buttonRef,
  }
}
