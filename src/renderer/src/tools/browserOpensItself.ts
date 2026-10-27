import { useEffect, useRef, type RefObject } from 'react'
import { useBrowserTasks } from './browserStore'
import { useToolsPanelChrome, type ToolsPanelStore } from './toolsPanelStore'

/**
 * The browser pane opens on its own (ADR-0154; Owl): when the focused thread's agent opens a page, a browser task
 * Tools has not seen before, and Tools is open on that thread, Tools shows Browser and that page. It never takes
 * Tools while keyboard focus is inside it (the user is typing in a terminal, say), and never Tools pinned to another
 * thread; the browser player floats instead, as it does while Tools is closed. `enabled` is the Owl switch together
 * with **Show the browser when an agent opens a page**.
 */
export function useBrowserOpensItself(enabled: boolean, focusedThreadId: string | null, store: ToolsPanelStore, panel: RefObject<HTMLElement | null>): void {
  const chrome = useToolsPanelChrome(store)
  const tasks = useBrowserTasks(store.browser)
  /** Every task this window has seen, so a late update to an older task never reads as a page just opened. */
  const seen = useRef(new Set<string>())
  useEffect(() => {
    const fresh = tasks.filter(task => !seen.current.has(task.id))
    for (const task of fresh) seen.current.add(task.id)
    if (!enabled || focusedThreadId === null || !chrome.open) return
    // The newest task is first; a test iPhone's task belongs to Tools > iPhone (ADR-0045).
    const task = fresh.find(item => item.threadId === focusedThreadId && !item.device && item.status === 'working')
    if (!task || (chrome.pinnedThreadId ?? focusedThreadId) !== focusedThreadId) return
    if (panel.current?.contains(document.activeElement)) return
    store.setSurface('browser')
    store.browser.showPage(task.threadId, task.pageId)
  }, [tasks, enabled, focusedThreadId, chrome, store, panel])
}
