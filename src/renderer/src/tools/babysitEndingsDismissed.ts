import { useCallback, useSyncExternalStore } from 'react'
import { pullRequestKey } from '../../../shared/gitPullRequests'

/**
 * The babysitting endings the user dismissed on the Pull request surface (ADR-0061, #825). An ending stays on the
 * thread's record until that pull request is babysat again; once read, Dismiss puts its line away in this window, so it
 * does not hold Merge down for days. It is a window preference, like the pane layout: kept in this window's storage,
 * never sent to the host, and kept whether or not Keep local history is on. So what it keeps names nothing: each ending
 * is kept as a 128-bit digest (FNV-1a) of its thread, pull request and the moment it ended, which tells a later ending of
 * the same pull request from this one and reads as no repository, number or thread. It is worked out at once, so a line
 * never leaves while it is reckoned and takes focus with it.
 */
export const BABYSIT_ENDINGS_DISMISSED_KEY = 'sotto.pullRequest.babysitEndingsDismissed'
const CHANGED = 'sotto-babysit-endings-dismissed'
/** The newest this many are kept; an older one shows again only if its thread still holds it, which is rare. */
const KEPT = 200
/** The digest as 32 hex digits: no two endings a window sees will share it. */
const DIGEST = /^[0-9a-f]{32}$/u

export interface BabysitEnding { readonly threadId: string; readonly url: string; readonly endedAt: string }
/** One ending as one string, held only in memory and digested before anything is kept. */
const identity = (ending: BabysitEnding): string => `${ending.threadId}\0${pullRequestKey(ending.url) ?? ending.url}\0${ending.endedAt}`

/** What an ending is kept as: the opaque digest of its thread, pull request and the moment it ended. */
export function babysitEndingDigest(ending: BabysitEnding): string {
  return digestOf(identity(ending))
}
const FNV_OFFSET = 0x6c62272e07bb014262b821756295c58dn
const FNV_PRIME = 0x0000000001000000000000000000013bn
const FNV_MASK = (1n << 128n) - 1n
function digestOf(text: string): string {
  let hash = FNV_OFFSET
  for (const byte of new TextEncoder().encode(text)) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & FNV_MASK
  return hash.toString(16).padStart(32, '0')
}

/** The endings dismissed in this window, by identity, so a line goes at once even when storage refuses the write. Memory only, the newest KEPT. */
const hiddenHere = new Set<string>()
function hideHere(id: string): void {
  hiddenHere.delete(id)
  hiddenHere.add(id)
  for (const oldest of hiddenHere) {
    if (hiddenHere.size <= KEPT) break
    hiddenHere.delete(oldest)
  }
}
/** Moves with every dismissal, so a press storage refused still reaches every surface in this window. */
let revision = 0

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener)
  window.addEventListener('storage', listener)
  return () => { window.removeEventListener(CHANGED, listener); window.removeEventListener('storage', listener) }
}
function read(): string {
  let stored = '[]'
  try { stored = localStorage.getItem(BABYSIT_ENDINGS_DISMISSED_KEY) ?? '[]' } catch { /* Storage that cannot be read keeps nothing. */ }
  return `${revision}\n${stored}`
}
/** The digests a snapshot holds; anything else in the record is not one and is dropped at the next write. */
function parse(snapshot: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(snapshot.slice(snapshot.indexOf('\n') + 1))
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && DIGEST.test(item)) : []
  } catch { return [] }
}

/** Whether an ending was dismissed here, and Dismiss. */
export function useBabysitEndingsDismissed(): {
  readonly dismissed: (ending: BabysitEnding) => boolean; readonly dismiss: (ending: BabysitEnding) => void
} {
  const snapshot = useSyncExternalStore(subscribe, read, () => '0\n[]')
  const dismissed = useCallback((ending: BabysitEnding): boolean => {
    const id = identity(ending)
    return hiddenHere.has(id) || parse(snapshot).includes(digestOf(id))
  }, [snapshot])
  const dismiss = useCallback((ending: BabysitEnding): void => {
    const id = identity(ending), digest = digestOf(id)
    hideHere(id)
    const next = JSON.stringify([...parse(read()).filter(item => item !== digest), digest].slice(-KEPT))
    try { localStorage.setItem(BABYSIT_ENDINGS_DISMISSED_KEY, next) } catch { /* Kept in this window until it closes. */ }
    revision += 1
    window.dispatchEvent(new Event(CHANGED))
  }, [])
  return { dismissed, dismiss }
}
