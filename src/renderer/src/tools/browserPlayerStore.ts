import { useSyncExternalStore } from 'react'

/** A rectangle in window coordinates: where the floating browser player sits, and how big it is. */
export interface BrowserPlayerRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface WindowSize {
  readonly width: number
  readonly height: number
}

/** Open shows the full player; shrunk is the pill at its corner; hidden draws neither (a way back is Tools > Browser). */
export type BrowserPlayerVisibility = 'open' | 'shrunk' | 'hidden'

export const BROWSER_PLAYER_DEFAULT_WIDTH = 340
export const BROWSER_PLAYER_DEFAULT_HEIGHT = 250
export const BROWSER_PLAYER_MIN_WIDTH = 280
export const BROWSER_PLAYER_MIN_HEIGHT = 200
/** The drag strip's height (`.thread-workspace__head`, `.thread-nav__top`): its controls and the window buttons stay reachable below it. */
export const BROWSER_PLAYER_STRIP_HEIGHT = 44
const EDGE_GAP = 16
/** How far the arrow keys move the player at a press, and with Shift held. */
export const BROWSER_PLAYER_MOVE_STEP = 16
export const BROWSER_PLAYER_MOVE_STEP_LARGE = 64

/** Above the composer, clear of the window's edges, the spot the prototype starts a player in. */
function defaultRect(window: WindowSize): BrowserPlayerRect {
  const width = Math.min(BROWSER_PLAYER_DEFAULT_WIDTH, Math.max(BROWSER_PLAYER_MIN_WIDTH, window.width - EDGE_GAP * 2))
  const height = Math.min(BROWSER_PLAYER_DEFAULT_HEIGHT, Math.max(BROWSER_PLAYER_MIN_HEIGHT, window.height - BROWSER_PLAYER_STRIP_HEIGHT - EDGE_GAP * 2))
  return { x: window.width - width - 24, y: window.height - height - 132, width, height }
}

/** Keeps a placement's size at least the minimum and its whole rectangle inside the window, below the drag strip. */
export function clampBrowserPlayerRect(rect: BrowserPlayerRect, window: WindowSize): BrowserPlayerRect {
  const width = Math.round(Math.min(Math.max(rect.width, BROWSER_PLAYER_MIN_WIDTH), Math.max(BROWSER_PLAYER_MIN_WIDTH, window.width - EDGE_GAP)))
  const height = Math.round(Math.min(Math.max(rect.height, BROWSER_PLAYER_MIN_HEIGHT), Math.max(BROWSER_PLAYER_MIN_HEIGHT, window.height - BROWSER_PLAYER_STRIP_HEIGHT - EDGE_GAP)))
  const x = Math.round(Math.min(Math.max(rect.x, 0), Math.max(0, window.width - width)))
  const y = Math.round(Math.min(Math.max(rect.y, BROWSER_PLAYER_STRIP_HEIGHT), Math.max(BROWSER_PLAYER_STRIP_HEIGHT, window.height - height)))
  return { x, y, width, height }
}

/**
 * The thread browser player's placement and per-thread visibility for this session. One placement serves every
 * thread (switching threads never moves it); visibility is per thread, so a shrink or hide in one thread does not
 * touch another's, and it survives while the thread is unfocused. Nothing here is saved across a restart.
 */
export class BrowserPlayerStore {
  private rect: BrowserPlayerRect | null = null
  private readonly visibility = new Map<string, BrowserPlayerVisibility>()
  private readonly lastTaskId = new Map<string, string>()
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private emit(): void { for (const listener of [...this.listeners]) listener() }

  /** The placement the user set, unclamped; `null` before the user has ever moved or resized it. */
  getRect(): BrowserPlayerRect | null { return this.rect }
  /** The placement to draw at, clamped to `window`. Reads `getRect()` too, so a caller only needs one of the two. */
  rectFor(window: WindowSize): BrowserPlayerRect { return clampBrowserPlayerRect(this.rect ?? defaultRect(window), window) }

  setRect(rect: BrowserPlayerRect, window: WindowSize): void {
    const next = clampBrowserPlayerRect(rect, window)
    if (this.rect && sameRect(this.rect, next)) return
    this.rect = next
    this.emit()
  }
  move(dx: number, dy: number, window: WindowSize): void {
    const current = this.rectFor(window)
    this.setRect({ ...current, x: current.x + dx, y: current.y + dy }, window)
  }
  resize(width: number, height: number, window: WindowSize): void {
    const current = this.rectFor(window)
    this.setRect({ ...current, width, height }, window)
  }
  /** The window resized: pull a placement that no longer fits back inside, and leave one that still fits alone. */
  reclamp(window: WindowSize): void {
    if (!this.rect) return
    const next = clampBrowserPlayerRect(this.rect, window)
    if (sameRect(this.rect, next)) return
    this.rect = next
    this.emit()
  }

  visibilityFor(threadId: string): BrowserPlayerVisibility { return this.visibility.get(threadId) ?? 'hidden' }
  private setVisibility(threadId: string, visibility: BrowserPlayerVisibility): void {
    if (this.visibility.get(threadId) === visibility) return
    this.visibility.set(threadId, visibility)
    this.emit()
  }
  shrink(threadId: string): void { this.setVisibility(threadId, 'shrunk') }
  restore(threadId: string): void { this.setVisibility(threadId, 'open') }
  hide(threadId: string): void { this.setVisibility(threadId, 'hidden') }

  /**
   * A thread's current task changed. A genuinely new task (a page the agent just opened) opens the player when
   * `autoShow` is on, and otherwise leaves it hidden; the same task's own progress never overrides what the user
   * chose for it (open, shrunk or hidden).
   */
  taskSeen(threadId: string, taskId: string, autoShow: boolean): void {
    if (this.lastTaskId.get(threadId) === taskId) return
    this.lastTaskId.set(threadId, taskId)
    this.setVisibility(threadId, autoShow ? 'open' : 'hidden')
  }
}

function sameRect(a: BrowserPlayerRect, b: BrowserPlayerRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** In-session singleton, like the Tools panel's own chrome: leaving the Threads page keeps the placement. */
export const browserPlayerStore = new BrowserPlayerStore()

export function useBrowserPlayerVisibility(store: BrowserPlayerStore, threadId: string | null): BrowserPlayerVisibility {
  return useSyncExternalStore(store.subscribe, () => threadId === null ? 'hidden' : store.visibilityFor(threadId))
}

/** The raw placement (unclamped, possibly unset); a consumer clamps it to the current window size itself. */
export function useBrowserPlayerRect(store: BrowserPlayerStore): BrowserPlayerRect | null {
  return useSyncExternalStore(store.subscribe, () => store.getRect())
}
