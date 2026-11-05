import { useCallback, useSyncExternalStore } from 'react'

/** The Threads sidebar's key; the pages beside it share it. */
export const THREADS_SIDEBAR_KEY = 'sotto.threadWorkspace.sidebar'
const CHANGED = 'sotto-sidebar-size'
const DEFAULT = '{"collapsed":false}'
/** The narrowest a sidebar can be dragged, and the most it can be. */
const MINIMUM = 260
const MOST = 480
/** The width the sidebar takes until the user drags it: 30% of the window, from 260 up to 280 pixels (ADR-0110). */
export function defaultSidebarWidth(viewport: number): number {
  return Math.round(Math.max(MINIMUM, Math.min(280, viewport * 0.3)))
}
/** The default before ADR-0110, which Collapse and Reset wrote down as if the user had chosen it. A record from then
    carries no `chosen` mark, so only an unmarked 320 is read as no choice; every width saved since is marked. */
const OLD_DEFAULT = 320
/** The last value this window saved for each key, and the keys whose last write storage refused. */
const fallback = new Map<string, string>()
const unsaved = new Set<string>()
/**
 * Below this window width the sidebar stands as the collapsed rail, whatever the user chose, and Expand opens the whole
 * sidebar over the thread rather than beside it, so the thread never gives up its room (ADR-0110, November 5, 2026).
 */
export const NARROW_WINDOW = 1000
/** Whether the sidebar stands open over the thread, in a narrow window. The window's own, never saved. */
let over = false
const overListeners = new Set<() => void>()
function subscribeOver(listener: () => void): () => void {
  overListeners.add(listener)
  return () => { overListeners.delete(listener) }
}
const readOver = (): boolean => over
function setOver(open: boolean): void {
  if (over === open) return
  over = open
  for (const listener of [...overListeners]) listener()
}
/** Puts the sidebar over the thread away; one function for every caller, so a memoised row keeps its props. */
const closeOverlay = (): void => setOver(false)

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener)
  window.addEventListener('storage', listener)
  return () => { window.removeEventListener(CHANGED, listener); window.removeEventListener('storage', listener) }
}
function subscribeWindow(listener: () => void): () => void {
  window.addEventListener('resize', listener)
  return () => window.removeEventListener('resize', listener)
}
const windowWidth = (): number => window.innerWidth

/** A window preference like the pane layout. Shrinking the window clamps the view, not the saved width. */
export function useSidebarSize(key: string = THREADS_SIDEBAR_KEY) {
  const read = useCallback((): string => {
    if (unsaved.has(key)) return fallback.get(key) ?? DEFAULT
    try { return localStorage.getItem(key) ?? DEFAULT } catch { return fallback.get(key) ?? DEFAULT }
  }, [key])
  const stored = useSyncExternalStore(subscribe, read, () => DEFAULT)
  const viewport = useSyncExternalStore(subscribeWindow, windowWidth, () => 1280)
  const overOpen = useSyncExternalStore(subscribeOver, readOver, () => false)
  const narrow = viewport < NARROW_WINDOW
  // Only a width the user dragged is kept; without one the sidebar follows the default as the window changes.
  let chosen: number | null = null, collapsed = false
  try {
    const value: unknown = JSON.parse(stored)
    if (value !== null && typeof value === 'object') {
      if ('width' in value && typeof value.width === 'number' && Number.isFinite(value.width) && ('chosen' in value || value.width !== OLD_DEFAULT)) chosen = Math.min(MOST, Math.max(MINIMUM, value.width))
      if ('collapsed' in value) collapsed = value.collapsed === true
    }
  } catch { /* An old or damaged preference starts at the default. */ }
  const preferred = chosen ?? defaultSidebarWidth(viewport)
  const maximum = Math.min(MOST, Math.max(MINIMUM, viewport - 470))
  const save = (width: number | null, hidden: boolean): void => {
    const next = JSON.stringify(width === null ? { collapsed: hidden } : { width, chosen: true, collapsed: hidden })
    fallback.set(key, next)
    try { localStorage.setItem(key, next); unsaved.delete(key) } catch { unsaved.add(key) }
    window.dispatchEvent(new Event(CHANGED))
  }
  return {
    width: Math.min(preferred, maximum), maximum,
    /** The rail stands: the user collapsed the sidebar, or the window is narrow. */
    collapsed: collapsed || narrow,
    /** The window is under `NARROW_WINDOW`: the rail stands and Expand opens the sidebar over the thread. */
    narrow,
    /** The sidebar stands open over the thread. Only a narrow window has it. */
    over: narrow && overOpen,
    resize: (width: number): void => save(Math.round(Math.max(MINIMUM, Math.min(maximum, width))), collapsed),
    /** Collapse or Expand: in a narrow window they close and open the sidebar over the thread, and nothing is saved. */
    collapse: (hidden: boolean): void => { if (narrow) setOver(!hidden); else save(chosen, hidden) },
    /** Shows or hides the sidebar, as Ctrl+Shift+B does: over the thread in a narrow window, beside it otherwise. */
    toggle: (): void => { if (narrow) setOver(!overOpen); else save(chosen, !collapsed) },
    /** Puts the sidebar over the thread away, as a chosen thread, Escape or a press beside it does. */
    closeOver: closeOverlay,
    reset: (): void => save(null, false),
  }
}
