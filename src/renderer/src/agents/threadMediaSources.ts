import { useEffect, useState } from 'react'
import { agentThreadMediaResultSchema } from '../../../shared/agents'

/** Where one picture of a thread is found (ADR-0170): its thread, the record that carries its handle, and the handle. */
export interface ThreadMediaOrigin { readonly threadId: string; readonly activityId: string; readonly mediaId: string }

// Tiles are small (main makes them at tile size), so a few dozen are kept between scrolls; a whole picture only while
// the viewer shows it and the one before.
const LIMITS = { tile: 48, full: 2 } as const
/** What a read came back with: the picture, `null` when its host keeps no such picture, or `failed` when the read itself failed. */
type Read = string | null | 'failed'
const kept = { tile: new Map<string, Promise<Read>>(), full: new Map<string, Promise<Read>>() }
let requests = 0

/** How many reads of pictures this window has made since it started, for the inline media benchmark. */
export function threadMediaRequests(): number { return requests }
let videoLoads = 0
/** How many times a video tile has given its player a source since the window started, for the same benchmark. */
export function threadVideoLoads(): number { return videoLoads }
/** A video tile gave its player a source: it came near, and the player reads the video's first frame. */
export function countVideoLoad(): void { videoLoads += 1 }

function request(origin: ThreadMediaOrigin, size: 'tile' | 'full'): Promise<Read> {
  const cache = kept[size]
  const key = JSON.stringify([origin.threadId, origin.activityId, origin.mediaId])
  const hit = cache.get(key)
  if (hit) { cache.delete(key); cache.set(key, hit); return hit }
  const bridge = window.sotto?.agents
  requests += 1
  const pending: Promise<Read> = bridge?.threadMedia
    ? bridge.threadMedia({ ...origin, size }).then(result => agentThreadMediaResultSchema.safeParse(result).data?.dataUrl ?? null, () => 'failed' as const)
    : Promise.resolve(null)
  cache.set(key, pending)
  // A picture main could not hand over may be there later; only the ones it did are kept.
  void pending.then(source => { if ((source === null || source === 'failed') && cache.get(key) === pending) cache.delete(key) })
  while (cache.size > LIMITS[size]) cache.delete(cache.keys().next().value!)
  return pending
}

/**
 * The picture a handle names, read from main only while `wanted`: a tile that is near the screen, or the viewer. When it
 * stops being wanted the source goes, so the window lets go of the decoded picture. `awaiting` while the read is out;
 * `failed` when the read itself failed, which is tried again the next time the picture is wanted.
 */
export function useThreadMediaSource(origin: ThreadMediaOrigin | undefined, size: 'tile' | 'full', wanted = true): { readonly source: string | null; readonly awaiting: boolean; readonly failed: boolean } {
  const [read, setRead] = useState<{ readonly key: string; readonly source: Read } | null>(null)
  const key = origin && wanted ? JSON.stringify([origin.threadId, origin.activityId, origin.mediaId, size]) : null
  useEffect(() => {
    if (key === null || !origin) { setRead(null); return }
    let live = true
    void request(origin, size).then(source => { if (live) setRead({ key, source }) })
    return () => { live = false }
    // The key names the origin and size whole, so it alone decides when to read again.
  }, [key])
  const current = read !== null && read.key === key ? read : null
  return { source: current?.source === 'failed' ? null : current?.source ?? null, awaiting: key !== null && current === null, failed: current?.source === 'failed' }
}

/** Each scroller's observers, one per margin, shared by every tile in it: what each target's listener is told. */
const observers = new WeakMap<Element, Map<string, { observer: IntersectionObserver; listeners: Map<Element, (inside: boolean) => void> }>>()
/** Tells `listener` whether `element` is within `margin` of its scroller's view, through that scroller's one observer for it. */
function watchWithin(element: Element, listener: (inside: boolean) => void, margin: string | undefined): () => void {
  const root = element.closest('.thread-workspace__transcript')
  const key = root ?? document.documentElement
  const byMargin = observers.get(key) ?? new Map()
  observers.set(key, byMargin)
  let entry = byMargin.get(margin ?? '')
  if (!entry) {
    const listeners = new Map<Element, (inside: boolean) => void>()
    const observer = new IntersectionObserver(changes => { for (const change of changes) listeners.get(change.target)?.(change.isIntersecting) },
      margin === undefined ? { root } : { root, rootMargin: margin })
    entry = { observer, listeners }
    byMargin.set(margin ?? '', entry)
  }
  const held = entry
  held.listeners.set(element, listener)
  held.observer.observe(element)
  return () => { held.observer.unobserve(element); held.listeners.delete(element) }
}

/**
 * Whether a tile is near: within a screen and a half of what is in view, where only a near tile holds its picture
 * (ADR-0170). A tile scrolled further away lets go of it. Without an observer, everything is near.
 */
export function watchNear(element: Element, listener: (near: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') { listener(true); return () => undefined }
  return watchWithin(element, listener, '150% 0px')
}

/**
 * Whether an element is on screen at all, for a video or GIF that plays only there: it pauses the moment it leaves
 * (ADR-0170). Without an observer it is never told it left.
 */
export function watchOnScreen(element: Element, listener: (shown: boolean) => void): () => void {
  if (typeof IntersectionObserver === 'undefined') return () => undefined
  return watchWithin(element, listener, undefined)
}
