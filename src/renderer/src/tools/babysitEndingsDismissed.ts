import { useCallback, useSyncExternalStore } from 'react'
import { pullRequestKeyOf } from '../agents/babysitting'

/**
 * The babysitting endings the user dismissed on the Pull request surface (ADR-0061, #825). An ending stays on the
 * thread's record until that pull request is babysat again; once read, Dismiss puts its line away in this window, so it
 * does not hold Merge down for days. Each ending is kept by thread, pull request and the moment it ended, so a later
 * ending of the same pull request is shown again. It is a window preference, like the pane layout: kept in this
 * window's storage, never sent to the host.
 */
export const BABYSIT_ENDINGS_DISMISSED_KEY = 'sotto.pullRequest.babysitEndingsDismissed'
const CHANGED = 'sotto-babysit-endings-dismissed'
/** The newest this many are kept; an older one shows again only if its thread still holds it, which is rare. */
const KEPT = 200
/** What this window dismissed when storage refused the write, so the line stays away until the window closes. */
let unsaved: string | null = null

export interface BabysitEnding { readonly threadId: string; readonly url: string; readonly endedAt: string }
const keyOf = (ending: BabysitEnding): string => `${ending.threadId} ${pullRequestKeyOf(ending.url) ?? ending.url} ${ending.endedAt}`

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener)
  window.addEventListener('storage', listener)
  return () => { window.removeEventListener(CHANGED, listener); window.removeEventListener('storage', listener) }
}
function read(): string {
  if (unsaved !== null) return unsaved
  try { return localStorage.getItem(BABYSIT_ENDINGS_DISMISSED_KEY) ?? '[]' } catch { return '[]' }
}
function parse(stored: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(stored)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch { return [] }
}

/** Whether an ending was dismissed here, and Dismiss. */
export function useBabysitEndingsDismissed(): { readonly dismissed: (ending: BabysitEnding) => boolean; readonly dismiss: (ending: BabysitEnding) => void } {
  const stored = useSyncExternalStore(subscribe, read, () => '[]')
  const dismissed = useCallback((ending: BabysitEnding): boolean => parse(stored).includes(keyOf(ending)), [stored])
  const dismiss = useCallback((ending: BabysitEnding): void => {
    const key = keyOf(ending)
    const next = JSON.stringify([...parse(read()).filter(item => item !== key), key].slice(-KEPT))
    try { localStorage.setItem(BABYSIT_ENDINGS_DISMISSED_KEY, next); unsaved = null } catch { unsaved = next }
    window.dispatchEvent(new Event(CHANGED))
  }, [])
  return { dismissed, dismiss }
}
