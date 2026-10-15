import { useSyncExternalStore } from 'react'
import type { WatcherThreadTarget } from '../../../shared/watcher'

/**
 * What the last Watch or Stop watching press did, for the toast that says so: done, with Undo, or main's refusal in
 * its own words. One at a time, for as long as the window lasts, so a press on Threads is still said in Watcher's room.
 */
export interface WatchNotice {
  readonly id: number
  readonly target: WatcherThreadTarget
  readonly title: string
  /** What the press asked for: watched, or not. */
  readonly watched: boolean
  /** Main's refusal, or null when the press took. */
  readonly refusal: string | null
}

/** How long a toast stays: long enough to reach Undo, or to read a refusal. */
export const WATCH_NOTICE_MS = 8_000
export const WATCH_REFUSAL_MS = 15_000

let current: WatchNotice | null = null
let next = 1
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
const publish = (): void => { for (const listener of [...listeners]) listener() }

export const watchNotices = {
  get: (): WatchNotice | null => current,
  show(notice: Omit<WatchNotice, 'id'>): void {
    current = { ...notice, id: next++ }
    if (timer !== undefined) clearTimeout(timer)
    const id = current.id
    timer = setTimeout(() => watchNotices.dismiss(id), notice.refusal === null ? WATCH_NOTICE_MS : WATCH_REFUSAL_MS)
    publish()
  },
  /** Takes the toast away, if it is still the one named. */
  dismiss(id: number): void {
    if (current?.id !== id) return
    current = null
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    publish()
  },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
}

export function useWatchNotice(): WatchNotice | null {
  return useSyncExternalStore(watchNotices.subscribe, watchNotices.get, watchNotices.get)
}
