import { isDeepStrictEqual } from 'node:util'
import { watcherRoomStateSchema, type WatcherRoomState } from '../../src/shared/watcherRoom'

/**
 * Checks every room state a Watcher publishes against the full room schema, and records any it would refuse or hand
 * back with other values. The window takes the room update on trust (#1336): what main publishes must already be what
 * the full parse would give the page. Only the order of keys may differ, which no reader of the room observes.
 */
export function watchRoomFixedPoint(service: { subscribe(listener: (state: WatcherRoomState) => void): () => void }) {
  const failures = new Set<string>()
  let published = 0
  const unsubscribe = service.subscribe(state => {
    published++
    const parsed = watcherRoomStateSchema.safeParse(state)
    if (!parsed.success) failures.add(`refused at ${parsed.error.issues.map(issue => `${issue.path.join('.')} (${issue.code})`).join(', ')}`)
    else if (!isDeepStrictEqual(parsed.data, state)) failures.add('changed by the parse')
  })
  return { failures: () => [...failures], published: () => published, unsubscribe }
}
