import { useSyncExternalStore } from 'react'

const KEY = 'sotto.threadWorkspace.sidebar'
const CHANGED = 'sotto-sidebar-size'
const DEFAULT = '{"width":320,"collapsed":false}'
let fallback = DEFAULT
let unsaved = false

function read(): string {
  if (unsaved) return fallback
  try { return localStorage.getItem(KEY) ?? DEFAULT } catch { return fallback }
}
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
export function useSidebarSize() {
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
    fallback = JSON.stringify({ width, collapsed: hidden })
    try { localStorage.setItem(KEY, fallback); unsaved = false } catch { unsaved = true }
    window.dispatchEvent(new Event(CHANGED))
  }
  return {
    width: Math.min(preferred, maximum), maximum, collapsed,
    resize: (width: number): void => save(Math.round(Math.max(260, Math.min(maximum, width))), collapsed),
    collapse: (hidden: boolean): void => save(preferred, hidden),
    reset: (): void => save(320, false),
  }
}
