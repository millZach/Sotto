import { useSyncExternalStore } from 'react'
import type { BrowserPage } from '../../../shared/browser'
import { BrowserStore } from './browserStore'
import { ChangesStore } from './changesStore'
import { FilesBrowserStore } from './filesBrowser'
import { TerminalStore } from './terminalStore'
import { SubagentsStore } from './subagentsStore'

/** Surfaces that actually work. Later tools append here; nothing is listed before it exists. */
export const TOOL_SURFACES = [{ id: 'browser', label: 'Browser' }, { id: 'terminal', label: 'Terminal' }, { id: 'files', label: 'Files' }, { id: 'changes', label: 'Changes' }, { id: 'agents', label: 'Agents' }] as const
export type ToolSurfaceId = typeof TOOL_SURFACES[number]['id']

const TOOLS_PANEL_DEFAULT_WIDTH = 600
export const TOOLS_PANEL_MIN_WIDTH = 380
export const TOOLS_PANEL_MAX_WIDTH = 1200
/** The panel docks beside the panes only while they keep at least this much width; otherwise it overlays them. */
export const TOOLS_PANEL_MIN_PANE_WIDTH = 320

export interface ToolsPanelChrome {
  readonly open: boolean
  readonly surface: ToolSurfaceId
  /** Sotto thread ID the panel is held on; null follows the focused thread. */
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

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = (): ToolsPanelChrome => this.chrome

  setOpen(open: boolean): void { this.update({ open, ...(!open ? { expanded: false } : {}) }) }
  toggle(): void { this.setOpen(!this.chrome.open) }
  setSurface(surface: ToolSurfaceId): void { this.update({ surface }) }
  setExpanded(expanded: boolean): void { this.update({ expanded, open: true }) }
  pin(threadId: string): void { this.update({ pinnedThreadId: threadId }) }
  unpin(): void { this.update({ pinnedThreadId: null }) }
  setWidth(width: number): void { this.update({ width: clampPanelWidth(width), resized: true }) }

  /**
   * Shows a page main just opened for a thread. The panel opens on Browser; a panel pinned to another thread
   * keeps its pin, and the answer is false so the caller can say where the page went.
   */
  showBrowserPage(page: BrowserPage): boolean {
    this.browser.adopt(page)
    const pinned = this.chrome.pinnedThreadId
    if (pinned !== null && pinned !== page.workspace.threadId) return false
    this.update({ open: true, surface: 'browser' })
    return true
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

/** The thread the panel shows: its pin when set, otherwise the focused thread. */
export function toolsTarget(chrome: ToolsPanelChrome, focusedThreadId: string | null): string | null {
  return chrome.pinnedThreadId ?? focusedThreadId
}
