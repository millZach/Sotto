import { useEffect, useState } from 'react'
import { agentThreadMediaResultSchema } from '../../../shared/agents'

/** Where one picture of a thread is found (ADR-0170): its thread, the record that carries its handle, and the handle. */
export interface ThreadMediaOrigin { readonly threadId: string; readonly activityId: string; readonly mediaId: string }

// Tiles are small (main makes them at tile size), so a few dozen are kept between scrolls; a whole picture only while
// the viewer shows it and the one before.
const LIMITS = { tile: 48, full: 2 } as const
const kept = { tile: new Map<string, Promise<string | null>>(), full: new Map<string, Promise<string | null>>() }
let requests = 0

/** How many reads of pictures this window has made since it started, for the inline media benchmark. */
export function threadMediaRequests(): number { return requests }

function request(origin: ThreadMediaOrigin, size: 'tile' | 'full'): Promise<string | null> {
  const cache = kept[size]
  const key = JSON.stringify([origin.threadId, origin.activityId, origin.mediaId])
  const hit = cache.get(key)
  if (hit) { cache.delete(key); cache.set(key, hit); return hit }
  const bridge = window.sotto?.agents
  requests += 1
  const pending: Promise<string | null> = bridge?.threadMedia
    ? bridge.threadMedia({ ...origin, size }).then(result => agentThreadMediaResultSchema.safeParse(result).data?.dataUrl ?? null, () => null)
    : Promise.resolve(null)
  cache.set(key, pending)
  // A picture main could not hand over may be there later; only the ones it did are kept.
  void pending.then(source => { if (source === null && cache.get(key) === pending) cache.delete(key) })
  while (cache.size > LIMITS[size]) cache.delete(cache.keys().next().value!)
  return pending
}

/**
 * The picture a handle names, read from main only while `wanted`: a tile that is near the screen, or the viewer. When it
 * stops being wanted the source goes, so the window lets go of the decoded picture. `awaiting` while the read is out.
 */
export function useThreadMediaSource(origin: ThreadMediaOrigin | undefined, size: 'tile' | 'full', wanted = true): { readonly source: string | null; readonly awaiting: boolean } {
  const [read, setRead] = useState<{ readonly key: string; readonly source: string | null } | null>(null)
  const key = origin && wanted ? JSON.stringify([origin.threadId, origin.activityId, origin.mediaId, size]) : null
  useEffect(() => {
    if (key === null || !origin) { setRead(null); return }
    let live = true
    void request(origin, size).then(source => { if (live) setRead({ key, source }) })
    return () => { live = false }
    // The key names the origin and size whole, so it alone decides when to read again.
  }, [key])
  const current = read !== null && read.key === key ? read : null
  return { source: current?.source ?? null, awaiting: key !== null && current === null }
}
