import { useSyncExternalStore } from 'react'

/**
 * Whether a turn's steps start open: the working line, the Worked for fold, the groups inside it and Watcher's news
 * work. Every one the user has not pressed follows the last one they did press, in every thread and after a restart.
 */
export const STEPS_OPEN_KEY = 'sotto.threads.stepsOpen'
const listeners = new Set<() => void>()
/** What the user last chose when storage refused to keep it. */
let unsaved: boolean | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => { listeners.delete(listener); window.removeEventListener('storage', listener) }
}
function read(): boolean {
  if (unsaved !== null) return unsaved
  try { return localStorage.getItem(STEPS_OPEN_KEY) === 'true' } catch { return false }
}

export function useStepsOpen(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}

/**
 * Called only from a press on a fold. Escape folds only the one it is in, since it is also how a pane beside Watcher is
 * put away, and a fold that opens itself sets nothing.
 */
export function setStepsOpen(open: boolean): void {
  if (open === read()) return
  try { localStorage.setItem(STEPS_OPEN_KEY, String(open)); unsaved = null } catch { unsaved = open }
  for (const listener of listeners) listener()
}
