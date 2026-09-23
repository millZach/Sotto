import { useCallback, useSyncExternalStore } from 'react'

/** The Threads sidebar's key; Terminal mode and the pages beside it share it. */
export const THREADS_SIDEBAR_KEY = 'sotto.threadWorkspace.sidebar'
/** The Chats list keeps a width and a collapse of its own. */
export const CHATS_SIDEBAR_KEY = 'sotto.chats.sidebar'
const CHANGED = 'sotto-sidebar-size'
const DEFAULT = '{"width":320,"collapsed":false}'
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
  let preferred = 320, collapsed = false
  try {
    const value: unknown = JSON.parse(stored)
    if (value !== null && typeof value === 'object') {
      if ('width' in value && typeof value.width === 'number' && Number.isFinite(value.width)) preferred = Math.min(480, Math.max(260, value.width))
      if ('collapsed' in value) collapsed = value.collapsed === true
    }
  } catch { /* An old or damaged preference starts at the default. */ }
  const maximum = Math.min(480, Math.max(260, viewport - 470))
  const save = (width: number, hidden: boolean): void => {
    const next = JSON.stringify({ width, collapsed: hidden })
    fallback.set(key, next)
    try { localStorage.setItem(key, next); unsaved.delete(key) } catch { unsaved.add(key) }
    window.dispatchEvent(new Event(CHANGED))
  }
  return {
    width: Math.min(preferred, maximum), maximum, collapsed,
    resize: (width: number): void => save(Math.round(Math.max(260, Math.min(maximum, width))), collapsed),
    collapse: (hidden: boolean): void => save(preferred, hidden),
    reset: (): void => save(320, false),
  }
}
