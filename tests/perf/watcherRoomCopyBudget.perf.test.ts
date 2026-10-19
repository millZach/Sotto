// @vitest-environment node
/**
 * A room read publishes public Watcher state; retained private takeover proofs are not part of that payload.
 * Count proof objects actually passed to native structuredClone instead of timing the read or mocking its record.
 * Public fields must remain detached from authority when the private record copy is removed.
 */
import { expect, it, vi } from 'vitest'
import { watcherObservePerformance } from '../fixtures/watcherObservePerformance'

it.each([1, 6])('copies no private takeover proofs when reading the room with %i watches', async watches => {
  const f = await watcherObservePerformance({ watches, olderMessages: 20, retainedTakeovers: 200,
    includeTakeoverMetadata: true, operationOutcome: 'working' })
  try {
    const before = structuredClone(f.state()), proofs = new Set<object>(f.state().localTakeovers!)
    expect(before.localTakeovers).toHaveLength(200)
    expect(before.localTakeovers!.every(proof => proof.userDrafts?.length === 1)).toBe(true)
    const copiedPrivate = { entries: 0, bytes: 0 }
    const nativeClone = globalThis.structuredClone
    const copies = vi.spyOn(globalThis, 'structuredClone').mockImplementation(((value: unknown, options?: StructuredSerializeOptions) => {
      // Identify the actual retained proofs by reference, whether a caller copies the record, array or one proof.
      const seen = new WeakSet<object>()
      const count = (item: unknown): void => {
        if (typeof item !== 'object' || item === null || seen.has(item)) return
        seen.add(item)
        if (proofs.has(item)) {
          copiedPrivate.entries++
          copiedPrivate.bytes += Buffer.byteLength(JSON.stringify(item), 'utf8')
          return
        }
        for (const nested of Object.values(item)) count(nested)
      }
      count(value)
      return nativeClone(value, options)
    }) as typeof structuredClone)
    let room: ReturnType<typeof f.watcher.state>
    try { room = f.watcher.state() } finally { copies.mockRestore() }

    expect(room).not.toHaveProperty('localTakeovers')
    expect(room.current).toEqual(before.current)
    expect(room.history).toEqual(before.history)
    expect(room.requests).toEqual(before.requests)
    expect(room.standingWatches).toEqual(before.watches)
    expect(room.receipts.map(receipt => receipt.id)).toEqual(before.operations.map(operation => operation.id))
    expect(room.watchedThreads.filter(row => row.watched)).toHaveLength(watches)
    expect(room.watchedThreads.filter(row => row.watched).every(row => !row.paused && row.status === 'running')).toBe(true)
    expect(room).toMatchObject({ inFlight: 0, inFlightLimit: 8 })

    // A consumer may change its copy. Neither the public records nor their nested targets may alias authority.
    room.current!.target.threadId = 'room-only-current'
    room.requests[0]!.state = 'closed'
    room.requests[0]!.participants[0]!.target.threadId = 'room-only-participant'
    room.standingWatches![0]!.pausedByUserMessageId = 'room-only-pause'
    room.standingWatches![0]!.target.threadId = 'room-only-watch'
    room.receipts[0]!.target.threadId = 'room-only-receipt'
    expect(f.state()).toEqual(before)

    const seen = JSON.stringify({ watches, retainedTakeovers: before.localTakeovers!.length, ...copiedPrivate })
    expect(copiedPrivate.entries, `a public room read copied private takeover proofs: ${seen}`).toBe(0)
    expect(copiedPrivate.bytes, `a public room read copied private takeover proof bytes: ${seen}`).toBe(0)
  } finally { await f.close() }
})
