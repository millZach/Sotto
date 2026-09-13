import { useSyncExternalStore } from 'react'
import { FilesBrowserStore } from './filesBrowser'

/** Surfaces that actually work. Later tools append here; nothing is listed before it exists. */
export const TOOL_SURFACES = [{ id: 'files', label: 'Files' }] as const
export type ToolSurfaceId = typeof TOOL_SURFACES[number]['id']

export const TOOLS_PANEL_DEFAULT_WIDTH = 380
export const TOOLS_PANEL_MIN_WIDTH = 320
export const TOOLS_PANEL_MAX_WIDTH = 640
/** The panel docks beside the panes only while they keep at least this much width; otherwise it overlays them. */
export const TOOLS_PANEL_MIN_PANE_WIDTH = 480

export interface ToolsPanelChrome {
  readonly open: boolean
  readonly surface: ToolSurfaceId
  /** Sotto thread ID the panel is held on; null follows the focused thread. */
  readonly pinnedThreadId: string | null
  readonly width: number
}

export function clampPanelWidth(width: number): number {
  return Math.round(Math.min(TOOLS_PANEL_MAX_WIDTH, Math.max(TOOLS_PANEL_MIN_WIDTH, width)))
}

/** The shared tools panel for this session: its chrome plus each thread's retained Files browsing. */
export class ToolsPanelStore {
  readonly files = new FilesBrowserStore()
  private chrome: ToolsPanelChrome = { open: false, surface: 'files', pinnedThreadId: null, width: TOOLS_PANEL_DEFAULT_WIDTH }
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = (): ToolsPanelChrome => this.chrome

  setOpen(open: boolean): void { this.update({ open }) }
  toggle(): void { this.update({ open: !this.chrome.open }) }
  setSurface(surface: ToolSurfaceId): void { this.update({ surface }) }
  pin(threadId: string): void { this.update({ pinnedThreadId: threadId }) }
  unpin(): void { this.update({ pinnedThreadId: null }) }
  setWidth(width: number): void { this.update({ width: clampPanelWidth(width) }) }

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
