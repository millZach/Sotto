// @vitest-environment node
/**
 * A room read publishes public Watcher state; retained private takeover proofs are not part of that payload.
 * Count proof objects actually passed to native structuredClone instead of timing the read or mocking its record.
 *
 * The room hands out the record's own records rather than copies (#1327). Every change replaces the record instead of
 * editing it, so what the room hands out never changes under its holder, and no reader edits it: each reader here runs
 * over a deep-frozen record, where an edit throws. Since #1450 a publish copies nothing: the desktop room builds the room
 * when its update goes and hands it to the window at once, where it used to copy every room it kept for its publish window,
 * and every reader gets the same room it got when the room copied its records.
 */
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { watcherObservePerformance } from '../fixtures/watcherObservePerformance'
import { centerHostId } from '../fixtures/watcher'
import { createWatcherRoomDesktop } from '../../src/main/agents/watcherRoomDesktop'
import type { PublishScheduler } from '../../src/main/agents/control'
import { WatcherPhoneService } from '../../src/main/agents/watcherPhone'
import type { WatcherRecord } from '../../src/shared/watcher'
import { applyWatcherRoomUpdate, type WatcherRoomHeld, type WatcherRoomState, type WatcherRoomUpdate } from '../../src/shared/watcherRoom'

const counter = vi.hoisted(() => ({ on: false, copied: [] as unknown[] }))
vi.mock('../../src/main/agents/cloneHostSnapshot', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/main/agents/cloneHostSnapshot')>()
  return { ...actual, clonePlainData: <T>(value: T): T => { if (counter.on) counter.copied.push(value); return actual.clonePlainData(value) } }
})

/** Freezes every object the value holds, so any later edit of it throws (test and source modules run in strict mode). */
function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  for (const nested of Object.values(value)) deepFreeze(nested, seen)
  Object.freeze(value)
}
/** The room as main built it when it copied its records: the record's own, and a request without the phone that started it. */
function roomRecords(record: Readonly<WatcherRecord>) {
  const copy = structuredClone(record) as WatcherRecord
  for (const request of copy.requests) delete request.phoneOrigin
  return { current: copy.current, history: copy.history, requests: copy.requests, standingWatches: copy.watches ?? [] }
}
/** A room without the time it was read at, which every read sets afresh. */
const timeless = ({ observedAt: _observedAt, ...room }: WatcherRoomState) => { void _observedAt; return room }

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
    expect(room).not.toHaveProperty('inFlightLimit')
    expect(f.state()).toEqual(before)

    const seen = JSON.stringify({ watches, retainedTakeovers: before.localTakeovers!.length, ...copiedPrivate })
    expect(copiedPrivate.entries, `a public room read copied private takeover proofs: ${seen}`).toBe(0)
    expect(copiedPrivate.bytes, `a public room read copied private takeover proof bytes: ${seen}`).toBe(0)
  } finally { await f.close() }
})

it('hands every reader the room from the record\'s own records, which none of them edits, and copies nothing for a publish', async () => {
  const f = await watcherObservePerformance({ watches: 6, olderMessages: 20, retainedTakeovers: 20,
    includeTakeoverMetadata: true, operationOutcome: 'working' })
  const pending: (() => void)[] = []
  const schedule: PublishScheduler = run => { pending.push(run); return () => { pending.splice(pending.indexOf(run), 1) } }
  // The window's room is put back together from the updates the publish window sends (#1450).
  const sent = { captured: [] as WatcherRoomState[], legacy: [] as WatcherRoomState[] }
  let held: WatcherRoomHeld | null = null
  const captured = createWatcherRoomDesktop({ watcherEnabled: true, streamingPublishCost: true, watcher: f.watcher, schedule,
    send: update => { held = applyWatcherRoomUpdate(held, update as WatcherRoomUpdate); sent.captured.push(held!.room); return true } })!
  const legacy = createWatcherRoomDesktop({ watcherEnabled: true, streamingPublishCost: false, watcher: f.watcher,
    send: state => { sent.legacy.push(state as WatcherRoomState); return true } })!
  const phone = new WatcherPhoneService(f.control, f.watcher)
  const publish = () => (f.watcher as unknown as { publish(observe?: boolean): void }).publish(false)
  try {
    // A request a phone started: the record keeps which phone it was, and no reader is handed it.
    f.control.mutateWatcher(next => { next.requests[0]!.phoneOrigin = { kind: 'phone', hostId: centerHostId, clientId: randomUUID() } })
    const record = f.state(), expected = roomRecords(record)
    expect(record.requests[0]!.phoneOrigin).toBeDefined()
    const phoneBefore = phone.state(true, true, true)
    // From here an edit of the record by any reader throws.
    deepFreeze(record)

    const room = f.watcher.state()
    expect(room).toMatchObject(expected)
    expect(room.requests[0]).not.toHaveProperty('phoneOrigin')
    // The record's own records, not copies: only the request that names its phone is a new record.
    expect(room.current).toBe(record.current)
    expect(room.history).toBe(record.history)
    expect(room.standingWatches).toBe(record.watches)
    expect(room.requests[0]).not.toBe(record.requests[0])
    expect(room.requests.slice(1).every((request, at) => request === record.requests[at + 1])).toBe(true)
    expect(room.receipts.every((receipt, at) => receipt.id === record.operations[at]!.id)).toBe(true)
    expect(f.state().requests[0]!.phoneOrigin).toBeDefined()

    counter.copied = []; counter.on = true
    try { publish(); publish() } finally { counter.on = false }
    // The first publish goes out at once and the second waits for the window; neither copies anything.
    expect(counter.copied, 'a publish copied something').toHaveLength(0)
    pending.shift()!()
    // The second room changed nothing but the time it was read at, so no update went for it.
    expect(sent.captured).toHaveLength(1)
    expect(sent.legacy).toHaveLength(2)
    const read = f.watcher.get()
    if (read.status !== 'ok') throw new Error('The room could not be read')
    for (const state of [...sent.captured, ...sent.legacy, read.state]) {
      expect(state).toMatchObject(expected)
      expect(timeless(state)).toEqual(timeless(room))
    }
    // Both hand the window the record's own records, which no one edits.
    expect(sent.captured[0]!.requests[1]).toBe(record.requests[1])
    expect(sent.legacy[1]!.requests[1]).toBe(record.requests[1])
    // A phone reads the same room and is sent what it was sent before.
    const { observedAt: _before, ...phoneExpected } = phoneBefore, { observedAt: _after, ...phoneNow } = phone.state(true, true, true)
    void _before; void _after
    expect(phoneNow).toEqual(phoneExpected)
    expect(JSON.stringify(phoneNow)).not.toContain('phoneOrigin')

    // A change to the record after a reader kept a room replaces the record, so the kept rooms read as they did.
    const kept = structuredClone({ room, captured: sent.captured, legacy: sent.legacy }), rootAfter = randomUUID()
    f.control.mutateWatcher(next => {
      next.requests[1]!.rootUserMessageId = rootAfter
      next.history = []
      if (next.current) next.current.target.threadId = randomUUID()
    })
    expect(f.state().requests[1]!.rootUserMessageId).toBe(rootAfter)
    expect(f.state().history).toEqual([])
    expect({ room, captured: sent.captured, legacy: sent.legacy }).toEqual(kept)
  } finally { captured.dispose(); legacy.dispose(); await f.close() }
})
