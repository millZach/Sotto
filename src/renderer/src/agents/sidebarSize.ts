import { useCallback, useSyncExternalStore } from 'react'

/** The Threads sidebar's key; Terminal mode and the pages beside it share it. */
export const THREADS_SIDEBAR_KEY = 'sotto.threadWorkspace.sidebar'
const CHANGED = 'sotto-sidebar-size'
const DEFAULT = '{"collapsed":false}'
/** The narrowest a sidebar can be dragged, and the most it can be. */
const MINIMUM = 260
const MOST = 480
/** The width the sidebar takes until the user drags it: 30% of the window, from 260 up to 280 pixels (ADR-0107). */
export function defaultSidebarWidth(viewport: number): number {
  return Math.round(Math.max(MINIMUM, Math.min(280, viewport * 0.3)))
}
/** The default before ADR-0107, which Collapse and Reset wrote down as if the user had chosen it. */
const OLD_DEFAULT = 320
/** The last value this window saved for each key, and the keys whose last write storage refused. */
const fallback = new Map<string, string>()
const unsaved = new Set<string>()

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
  // Only a width the user dragged is kept; without one the sidebar follows the default as the window changes.
  let chosen: number | null = null, collapsed = false
  try {
    const value: unknown = JSON.parse(stored)
    if (value !== null && typeof value === 'object') {
      if ('width' in value && typeof value.width === 'number' && Number.isFinite(value.width) && value.width !== OLD_DEFAULT) chosen = Math.min(MOST, Math.max(MINIMUM, value.width))
      if ('collapsed' in value) collapsed = value.collapsed === true
    }
  } catch { /* An old or damaged preference starts at the default. */ }
  const preferred = chosen ?? defaultSidebarWidth(viewport)
  const maximum = Math.min(MOST, Math.max(MINIMUM, viewport - 470))
  const save = (width: number | null, hidden: boolean): void => {
    const next = JSON.stringify(width === null ? { collapsed: hidden } : { width, collapsed: hidden })
    fallback.set(key, next)
    try { localStorage.setItem(key, next); unsaved.delete(key) } catch { unsaved.add(key) }
    window.dispatchEvent(new Event(CHANGED))
  }
  return {
    width: Math.min(preferred, maximum), maximum, collapsed,
    resize: (width: number): void => save(Math.round(Math.max(MINIMUM, Math.min(maximum, width))), collapsed),
    collapse: (hidden: boolean): void => save(chosen, hidden),
    reset: (): void => save(null, false),
  }
}
