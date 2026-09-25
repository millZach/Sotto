import { useSyncExternalStore } from 'react'
import type { BrowserPage, BrowserTask, BrowserBridge } from '../../../shared/browser'
import { BrowserStore } from './browserStore'
import { ChangesStore } from './changesStore'
import { FilesBrowserStore } from './filesBrowser'
import { TerminalStore } from './terminalStore'
import { SubagentsStore } from './subagentsStore'

/** Surfaces that actually work. Later tools append here; nothing is listed before it exists. */
/** Pull request's word on the rail is T3's short one, the one its Git action says (Create PR, View PR); the tile is too narrow for two words. */
export const TOOL_SURFACES = [{ id: 'browser', label: 'Browser' }, { id: 'terminal', label: 'Terminal' }, { id: 'files', label: 'Files' }, { id: 'changes', label: 'Changes' }, { id: 'pull-request', label: 'PR' }, { id: 'agents', label: 'Agents' }] as const
export type ToolSurfaceId = typeof TOOL_SURFACES[number]['id']

const TOOLS_PANEL_DEFAULT_WIDTH = 600
export const TOOLS_PANEL_MIN_WIDTH = 380
export const TOOLS_PANEL_MAX_WIDTH = 1200
/** The panel docks beside the panes only while they keep at least this much width; otherwise it overlays them. */
export const TOOLS_PANEL_MIN_PANE_WIDTH = 320

export interface ToolsPanelChrome {
  readonly open: boolean
  readonly surface: ToolSurfaceId
  /** Sotto thread ID held for working-copy surfaces; Agents always follows the focused thread. */
  readonly pinnedThreadId: string | null
  readonly width: number
  readonly resized: boolean
  readonly expanded: boolean
}

function clampPanelWidth(width: number): number {
  return Math.round(Math.min(TOOLS_PANEL_MAX_WIDTH, Math.max(TOOLS_PANEL_MIN_WIDTH, width)))
}

/** How long a closed panel keeps asking for its toggle to take focus, for a toggle re-mounted by the layout change. */
const TOGGLE_FOCUS_RETURN_MS = 1_500

/** The shared tools panel for this session: its chrome plus each thread's retained browsing and review. */
export class ToolsPanelStore {
  readonly files = new FilesBrowserStore()
  readonly changes = new ChangesStore()
  readonly terminals = new TerminalStore()
  readonly browser = new BrowserStore()
  readonly subagents = new SubagentsStore()
  private chrome: ToolsPanelChrome = { open: false, surface: 'files', pinnedThreadId: null, width: TOOLS_PANEL_DEFAULT_WIDTH, resized: false, expanded: false }
  private readonly listeners = new Set<() => void>()
  private focusReturnUntil = 0
  private quietOpen = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = (): ToolsPanelChrome => this.chrome

  setOpen(open: boolean): void { if (!open) this.quietOpen = false; this.update({ open, ...(!open ? { expanded: false } : {}) }) }
  toggle(): void { this.setOpen(!this.chrome.open) }
  setSurface(surface: ToolSurfaceId): void { this.update({ surface }) }
  setExpanded(expanded: boolean): void { this.update({ expanded, open: true }) }
  pin(threadId: string): void { this.update({ pinnedThreadId: threadId }) }
  unpin(): void { this.update({ pinnedThreadId: null }) }
  setWidth(width: number): void { this.update({ width: clampPanelWidth(width), resized: true }) }

  /**
   * Shows a page main just opened for a thread's own pane. The page is adopted either way, so Tools > Browser has
   * it once the user gets there; the panel itself only opens on Browser when the click came from the *focused*
   * pane (a link in an unfocused split pane must never pull the focused thread's Browser open, #331) and the panel
   * is not pinned to a different thread. The answer is false so the caller can say where the page went.
   */
  showBrowserPage(page: BrowserPage, focused: boolean): boolean {
    this.browser.adopt(page)
    if (!focused) return false
    const pinned = this.chrome.pinnedThreadId
    if (pinned !== null && pinned !== page.workspace.threadId) return false
    this.update({ open: true, surface: 'browser' })
    return true
  }

  /**
   * Proactive panels: opens Changes after a large turn of `threadId`. Only a closed panel opens, and only when it
   * is not pinned to another thread; the open is quiet, so keyboard focus stays where the user left it. The answer
   * says whether it opened.
   */
  showChangesProactively(threadId: string): boolean {
    const pinned = this.chrome.pinnedThreadId
    if (this.chrome.open || (pinned !== null && pinned !== threadId)) return false
    this.quietOpen = true
    this.update({ open: true, surface: 'changes' })
    return true
  }
  /** Whether the open that just happened was a quiet one, which leaves focus alone; asking clears it. */
  takeQuietOpen(): boolean { const quiet = this.quietOpen; this.quietOpen = false; return quiet }

  /**
   * Moves a task's page into Tools > Browser: what the player's own "Move into Tools" button asks for. It never
   * pins (only the rail's own pin control pins, ADR-0020's September 25 player amendment); the player shows only
   * the focused thread's task, so Tools already follows it there once unpinned.
   */
  async showBrowserTask(task: BrowserTask, bridge: BrowserBridge | undefined): Promise<boolean> {
    await this.browser.activate(bridge, task.threadId)
    if (!this.browser.thread(task.threadId)?.pages.some(page => page.id === task.pageId && page.workspace.workspaceId === task.workspaceId)) return false
    this.browser.select(task.threadId, task.pageId)
    this.update({ open: true, surface: 'browser' })
    return true
  }

  /**
   * Opens the Pull request surface for a thread, as the pull request badge under its composer asks. A panel
   * pinned to another thread is pinned to this one instead, since the press names this thread's pull request.
   */
  showPullRequest(threadId: string): void {
    const pinned = this.chrome.pinnedThreadId
    this.update({ open: true, surface: 'pull-request', ...(pinned !== null && pinned !== threadId ? { pinnedThreadId: threadId } : {}) })
  }

  /** Closing moved focus to the toggle; a toggle mounted shortly after (the panes re-laid out) takes it if nothing else has. */
  requestToggleFocus(now = Date.now()): void { this.focusReturnUntil = now + TOGGLE_FOCUS_RETURN_MS }
  togglePendingFocus(now = Date.now()): boolean { return !this.chrome.open && now < this.focusReturnUntil }
  clearToggleFocus(): void { this.focusReturnUntil = 0 }

  private update(patch: Partial<ToolsPanelChrome>): void {
    const next = { ...this.chrome, ...patch }
    if ((Object.keys(patch) as (keyof ToolsPanelChrome)[]).every(key => next[key] === this.chrome[key])) return
    this.chrome = next
    for (const listener of [...this.listeners]) listener()
  }
}

/** In-session singleton: leaving the Threads page or changing focus keeps the panel and its browsing. */
export const toolsPanelStore = new ToolsPanelStore()

export function useToolsPanelChrome(store: ToolsPanelStore = toolsPanelStore): ToolsPanelChrome {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/** Agents belongs to the focused thread; the other surfaces share a pinned working copy. */
export function toolsTarget(chrome: ToolsPanelChrome, focusedThreadId: string | null): string | null {
  return chrome.surface === 'agents' ? focusedThreadId : chrome.pinnedThreadId ?? focusedThreadId
}
