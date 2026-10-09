import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { pullRequestKey } from '../../../shared/gitPullRequests'

/**
 * The babysitting endings the user dismissed on the Pull request surface (ADR-0061, #825). An ending stays on the
 * thread's record until that pull request is babysat again; once read, Dismiss puts its line away in this window, so it
 * does not hold Merge down for days. It is a window preference, like the pane layout: kept in this window's storage,
 * never sent to the host, and kept whether or not Keep local history is on. So what it keeps names nothing: each ending
 * is kept as a SHA-256 digest of its thread, pull request and the moment it ended, which tells a later ending of the
 * same pull request from this one and cannot be read back into a repository, a number or a thread.
 */
export const BABYSIT_ENDINGS_DISMISSED_KEY = 'sotto.pullRequest.babysitEndingsDismissed'
const CHANGED = 'sotto-babysit-endings-dismissed'
/** The newest this many are kept; an older one shows again only if its thread still holds it, which is rare. */
const KEPT = 200
/** The first 16 bytes of the digest, as hex: no two endings a window sees will share it. */
const DIGEST = /^[0-9a-f]{32}$/u

export interface BabysitEnding { readonly threadId: string; readonly url: string; readonly endedAt: string }
/** One ending as one string, held only in memory and hashed before anything is kept. */
const identity = (ending: BabysitEnding): string => `${ending.threadId}\0${pullRequestKey(ending.url) ?? ending.url}\0${ending.endedAt}`

/** What an ending is kept as: the opaque digest of its thread, pull request and the moment it ended. */
export async function babysitEndingDigest(ending: BabysitEnding): Promise<string> {
  return digestOf(identity(ending))
}
async function digestOf(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...bytes.subarray(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Each ending's digest once worked out, by identity; null where it could not be. Memory only. */
const digests = new Map<string, string | null>()
/** The endings dismissed in this window, by identity, so a line goes at once even when storage refuses the write. Memory only. */
const hiddenHere = new Set<string>()
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

/**
 * Whether one of these endings was dismissed here, and Dismiss. `endings` are the ones the surface may show; until an
 * ending's digest is worked out, a moment after it first appears, its line stays away rather than showing and going.
 */
export function useBabysitEndingsDismissed(endings: readonly BabysitEnding[]): {
  readonly dismissed: (ending: BabysitEnding) => boolean; readonly dismiss: (ending: BabysitEnding) => void
} {
  const snapshot = useSyncExternalStore(subscribe, read, () => '0\n[]')
  const [, worked] = useState(0)
  const pending = [...new Set(endings.map(identity).filter(id => !digests.has(id)))].join('\n')
  useEffect(() => {
    if (!pending) return
    let live = true
    void Promise.all(pending.split('\n').map(async id => {
      try { digests.set(id, await digestOf(id)) } catch { digests.set(id, null) }
    })).then(() => { if (live) worked(count => count + 1) })
    return () => { live = false }
  }, [pending])
  const dismissed = useCallback((ending: BabysitEnding): boolean => {
    const id = identity(ending)
    if (hiddenHere.has(id) || !digests.has(id)) return true
    const digest = digests.get(id)
    return digest !== null && digest !== undefined && parse(snapshot).includes(digest)
  }, [snapshot])
  const dismiss = useCallback((ending: BabysitEnding): void => {
    const id = identity(ending), digest = digests.get(id)
    hiddenHere.add(id)
    if (digest) {
      const next = JSON.stringify([...parse(read()).filter(item => item !== digest), digest].slice(-KEPT))
      try { localStorage.setItem(BABYSIT_ENDINGS_DISMISSED_KEY, next) } catch { /* Kept in this window until it closes. */ }
    }
    revision += 1
    window.dispatchEvent(new Event(CHANGED))
  }, [])
  return { dismissed, dismiss }
}
