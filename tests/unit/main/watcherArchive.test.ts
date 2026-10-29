// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { archivableWatcherRequests, NOTHING_ARCHIVED, removeArchivedWork, WATCHER_ARCHIVE_FILE, WATCHER_ARCHIVE_INDEX, WATCHER_LIVE_CLOSED_REQUESTS,
  WatcherArchive, watcherArchiveBatch, WatcherArchiveUnreadable, type WatcherArchiveOpen } from '../../../src/main/agents/watcherArchive'
import { emptyWatcherRecord, watcherRecordSchema, type WatcherOperation, type WatcherRecord, type WatcherRequest } from '../../../src/shared/watcher'

// Watcher's archive (#1759): what may leave the live record, that the record stays valid without it, and that the store
// gives back the work placed on the messages a conversation holds, follows Keep local history and survives a restart.
/** While `most` is set, every file write takes at most that many bytes, as a short write on a full disk does. */
const shortWrites = vi.hoisted(() => ({ most: undefined as number | undefined }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args)
    const most = shortWrites.most
    if (most === undefined) return file
    const write = file.write.bind(file) as (buffer: Uint8Array, offset: number, length: number) => Promise<{ bytesWritten: number }>
    return Object.assign(file, { write: (buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset) => write(buffer, offset, Math.min(length, most)) })
  } }
})
const roots: string[] = []
afterEach(async () => { shortWrites.most = undefined; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const HOST = '00000000-0000-4000-8000-000000000001'
const WATCHER = { hostId: HOST, threadId: 'watcher-thread' }
const at = (minute: number): string => new Date(Date.UTC(2026, 9, 20, 0, minute)).toISOString()
const digest = (index: number): string => index.toString(16).padStart(64, '0')

/** `count` closed requests, each rooted in message `m{index}` and begun in its own prompt turn with one send. */
function record(count: number, extra: (record: WatcherRecord) => void = () => {}): WatcherRecord {
  const value = emptyWatcherRecord()
  value.current = { target: WATCHER, projectId: 'project', provider: 'claude', creationOperationId: randomUUID(), createdAt: at(0) }
  value.promptTurns = []
  for (let index = 0; index < count; index++) {
    const id = randomUUID(), turn = randomUUID(), target = { hostId: HOST, threadId: `worker-${index % 7}` }
    value.requests.push({ id, watcher: WATCHER, rootUserMessageId: `m${index}`, state: 'closed', createdAt: at(index), closedAt: at(index),
      participants: [{ target, requestId: id, startedBy: 'watcher', generation: 0, state: 'participating', promptCount: 1 }] })
    value.promptTurns.push({ id: turn, watcher: WATCHER, createdAt: at(index), rootUserMessageId: `m${index}` })
    value.operations.push({ id: randomUUID(), requestId: id, retryKey: randomUUID(), digest: digest(index + 1), promptTurnId: turn, action: 'send', target,
      generation: 0, deliveryState: 'accepted', createdAt: at(index), updatedAt: at(index), receiptId: `receipt-${index}`, cardId: `card-${index}`, outcome: 'answered', outcomeAt: at(index) })
  }
  extra(value)
  return watcherRecordSchema.parse(value)
}
const requestAt = (value: WatcherRecord, index: number): WatcherRequest => value.requests[index]!
const operationOf = (value: WatcherRecord, request: WatcherRequest): WatcherOperation => value.operations.find(item => item.requestId === request.id)!

describe('what leaves the live record', () => {
  it('keeps the newest closed requests and lets the older go, oldest first', () => {
    const value = record(WATCHER_LIVE_CLOSED_REQUESTS + 60)
    const ids = archivableWatcherRequests(value)
    expect(ids).toEqual(value.requests.slice(0, 60).map(item => item.id))
    expect(archivableWatcherRequests(record(WATCHER_LIVE_CLOSED_REQUESTS))).toEqual([])
  })

  it('keeps every request something still names, and an active one, whatever its age', () => {
    const value = record(WATCHER_LIVE_CLOSED_REQUESTS + 20, next => {
      next.requests[0]!.state = 'active'; next.requests[0]!.closedAt = null
      next.reservations.push({ target: next.requests[1]!.participants[0]!.target, requestId: next.requests[1]!.id, operationId: next.operations[1]!.id, generation: 0, reason: 'creation' })
      next.localTakeovers = [{ target: { hostId: HOST, threadId: 'taken' }, at: at(2), lastRequestId: next.requests[2]!.id }]
      next.operations[3]!.deliveryState = 'uncertain'
      next.operations[4]!.creationUncertain = true
      next.requests[5]!.remoteOrigin = { clientId: 'desktop', master: next.current!, creationOperationId: randomUUID(), ceiling: 'approval-required' }
      next.requests[6]!.userFollowups = [{ draftId: randomUUID() }]
      // Two requests took the same thread over: the newer of them holds the fence, the older may go.
      for (const index of [7, 8]) Object.assign(next.requests[index]!.participants[0]!, { target: { hostId: HOST, threadId: 'fenced' }, state: 'taken-over', takeover: { reason: 'user-send', at: at(index) } })
      next.operations[7]!.target = next.operations[8]!.target = { hostId: HOST, threadId: 'fenced' }
      next.remoteAbsences = [{ operationId: next.operations[9]!.id, master: next.current!, clientId: 'desktop', observedAt: at(9) }]
      // A stopped request whose worker Watcher started still holds that thread's queue for the user's review, as does a
      // participation whose automation was stopped (preserveUserQueue).
      next.requests[12]!.state = 'stopped'
      next.requests[13]!.participants[0]!.automationStopped = true
    })
    const retained = new Set(archivableWatcherRequests(value, operation => operation.id === value.operations[10]!.id))
    for (const index of [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 13]) expect.soft(retained.has(requestAt(value, index).id), `request ${index}`).toBe(false)
    for (const index of [7, 11, 19]) expect.soft(retained.has(requestAt(value, index).id), `request ${index}`).toBe(true)
  })

  it('leaves a record that is still valid, with every reference it holds still named', () => {
    const value = record(WATCHER_LIVE_CLOSED_REQUESTS + 80, next => {
      next.reservations.push({ target: next.requests[1]!.participants[0]!.target, requestId: next.requests[1]!.id, operationId: next.operations[1]!.id, generation: 0, reason: 'creation' })
      next.localTakeovers = [{ target: { hostId: HOST, threadId: 'taken' }, at: at(2), lastRequestId: next.requests[2]!.id }]
    })
    const ids = archivableWatcherRequests(value)
    const batch = watcherArchiveBatch(value, ids)
    expect(batch.requests).toHaveLength(ids.length)
    expect(batch.operations.every(operation => ids.includes(operation.requestId))).toBe(true)
    expect(new Set(batch.promptTurns.map(turn => turn.id))).toEqual(new Set(batch.operations.map(operation => operation.promptTurnId)))
    const next = structuredClone(value) as WatcherRecord
    removeArchivedWork(next, new Set(ids))
    expect(() => watcherRecordSchema.parse(next)).not.toThrow()
    expect(next.requests.filter(item => item.state !== 'active')).toHaveLength(WATCHER_LIVE_CLOSED_REQUESTS + 2)
    expect(next.requests.some(item => item.id === value.requests[1]!.id) && next.requests.some(item => item.id === value.requests[2]!.id)).toBe(true)
    expect(next.operations).toHaveLength(value.operations.length - ids.length)
  })
})

describe('the archive on disk', () => {
  const directory = async () => { const root = await mkdtemp(join(tmpdir(), 'sotto-watcher-archive-')); roots.push(root); return root }

  it('gives back the work placed on the messages a conversation holds, and only that, after a restart too', async () => {
    const root = await directory(), value = record(300)
    const ids = archivableWatcherRequests(value)
    const archive = new WatcherArchive(root, () => true)
    await archive.append(watcherArchiveBatch(value, ids.slice(0, 50)))
    await archive.append(watcherArchiveBatch(value, ids.slice(50)))
    expect(archive.through()).toBe(at(99))
    // The conversation holds messages 90 to 299: the archived work rooted in 90 to 99 comes back, nothing older.
    const held = { threadId: WATCHER.threadId, ids: new Set(Array.from({ length: 210 }, (_, index) => `m${index + 90}`)), from: at(90) }
    for (const reader of [archive, new WatcherArchive(root, () => true)]) {
      const work = await reader.recall(held)
      expect(work.requests.map(item => item.rootUserMessageId)).toEqual(Array.from({ length: 10 }, (_, index) => `m${index + 90}`))
      expect(work.operations).toEqual(work.requests.map(request => operationOf(value, request)))
      expect(work.promptTurns.map(turn => turn.rootUserMessageId)).toEqual(work.requests.map(request => request.rootUserMessageId))
    }
    expect(await archive.recall({ threadId: 'another-watcher', ids: held.ids, from: at(90) })).toBe(NOTHING_ARCHIVED)
    expect(await archive.recall({ threadId: WATCHER.threadId, ids: new Set(['m250']), from: at(250) })).toBe(NOTHING_ARCHIVED)
  })

  it('brings back a takeover after the oldest held message, for its line', async () => {
    const root = await directory()
    const value = record(260, next => Object.assign(next.requests[30]!.participants[0]!, { state: 'taken-over', takeover: { reason: 'user-send', at: at(31) } }))
    // A later request records the same thread taken over, so this one may go.
    const later = record(1, next => Object.assign(next.requests[0]!.participants[0]!, { target: value.requests[30]!.participants[0]!.target, state: 'taken-over', takeover: { reason: 'user-send', at: at(250) } }))
    value.requests.push(later.requests[0]!)
    const archive = new WatcherArchive(root, () => true)
    await archive.append(watcherArchiveBatch(value, archivableWatcherRequests(value)))
    const work = await archive.recall({ threadId: WATCHER.threadId, ids: new Set(['m31']), from: at(31) })
    // Request 31 is rooted in the held message; request 30 comes for its takeover after it.
    expect(work.requests.map(item => item.id)).toEqual([value.requests[30]!.id, value.requests[31]!.id])
  })

  it('keeps nothing on disk while Keep local history is off, removes the file when it goes off, and writes this run\'s when it comes back', async () => {
    const root = await directory(), value = record(260)
    let history = true
    const archive = new WatcherArchive(root, () => history)
    const batch = watcherArchiveBatch(value, archivableWatcherRequests(value))
    await archive.append(batch)
    expect((await readdir(root)).sort()).toEqual([WATCHER_ARCHIVE_INDEX, WATCHER_ARCHIVE_FILE].sort())
    history = false
    await archive.privacyChanged()
    expect(await readdir(root)).toEqual([])
    // What this run archived stays, in memory, as this run's conversation does.
    expect(archive.holds(batch.requests[0]!.id)).toBe(true)
    await archive.append(batch)
    expect(await readdir(root)).toEqual([])
    const held = { threadId: WATCHER.threadId, ids: new Set(['m0']), from: at(0) }
    expect((await archive.recall(held)).requests).toHaveLength(1)
    history = true
    await archive.privacyChanged()
    expect((await readdir(root)).sort()).toEqual([WATCHER_ARCHIVE_INDEX, WATCHER_ARCHIVE_FILE].sort())
    expect((await new WatcherArchive(root, () => true).recall(held)).requests).toHaveLength(1)
    // A start with history off removes what an earlier run saved.
    await new WatcherArchive(root, () => false).settled()
    expect(await readdir(root)).toEqual([])
  })

  /** `open` whose append fails, as a locked disk does. */
  const opening = (behaviour: { appendFails?: boolean }): WatcherArchiveOpen => async (path, flags) => {
    if (behaviour.appendFails && flags === 'a') throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    const file = await open(path, flags)
    return { read: (buffer, offset, length, position) => file.read(buffer, offset, length, position), sync: () => file.sync(), close: () => file.close(),
      write: (buffer, offset, length) => file.write(buffer, offset, length) }
  }

  it('writes every byte of a batch however short each write is, and reads it whole', async () => {
    const root = await directory(), value = record(260)
    const ids = archivableWatcherRequests(value)
    const archive = new WatcherArchive(root, () => true)
    shortWrites.most = 121
    await archive.append(watcherArchiveBatch(value, ids))
    shortWrites.most = undefined
    const fresh = new WatcherArchive(root, () => true)
    expect((await fresh.read({ requests: ids })).requests.map(item => item.id)).toEqual(ids)
  })

  it('refuses a lookup by ID when the batch the index names cannot be read, rather than calling the work absent', async () => {
    const root = await directory(), value = record(260)
    const ids = archivableWatcherRequests(value)
    await new WatcherArchive(root, () => true).append(watcherArchiveBatch(value, ids))
    const handle = await open(join(root, WATCHER_ARCHIVE_FILE), 'r+')
    await handle.truncate(100); await handle.close()
    const archive = new WatcherArchive(root, () => true)
    await archive.ready()
    expect(archive.hasRequest(ids[0]!)).toBe(true)
    await expect(archive.read({ requests: [ids[0]!] })).rejects.toBeInstanceOf(WatcherArchiveUnreadable)
  })

  it('keeps work held in memory until turning history back on has written it, when the write fails', async () => {
    const root = await directory(), value = record(260)
    let history = false
    const archive = new WatcherArchive(root, () => history, opening({ appendFails: true }))
    const batch = watcherArchiveBatch(value, archivableWatcherRequests(value))
    await archive.append(batch)
    history = true
    await expect(archive.privacyChanged()).rejects.toThrow()
    expect(archive.holds(batch.requests[0]!.id)).toBe(true)
    expect((await archive.read({ requests: [batch.requests[0]!.id] })).requests.map(item => item.id)).toContain(batch.requests[0]!.id)
  })

  it('adds one batch to what it holds for each batch archived, however many it already holds', async () => {
    /** The batches indexed in memory while one more is archived, after `held` one-request batches. */
    const added = async (held: number): Promise<number> => {
      const root = await directory(), value = record(WATCHER_LIVE_CLOSED_REQUESTS + held + 1)
      const ids = archivableWatcherRequests(value)
      const archive = new WatcherArchive(root, () => true)
      for (const id of ids.slice(0, held)) await archive.append(watcherArchiveBatch(value, [id]))
      const prototype = WatcherArchive.prototype as unknown as { add(slot: unknown): void }
      const adding = vi.spyOn(prototype, 'add')
      await archive.append(watcherArchiveBatch(value, [ids[held]!]))
      const count = adding.mock.calls.length
      adding.mockRestore()
      return count
    }
    expect({ few: await added(5), many: await added(60) }).toEqual({ few: 1, many: 1 })
  })

  it('gives each request, operation and prompt turn once when a crash left a batch archived twice', async () => {
    const root = await directory(), value = record(260)
    const batch = watcherArchiveBatch(value, archivableWatcherRequests(value))
    const archive = new WatcherArchive(root, () => true)
    await archive.append(batch); await archive.append(batch)
    const work = await new WatcherArchive(root, () => true).read({ requests: [batch.requests[0]!.id] })
    expect(work.requests).toHaveLength(batch.requests.length)
    expect(work.operations).toHaveLength(batch.operations.length)
    expect(work.promptTurns).toHaveLength(batch.promptTurns.length)
    expect(archive.turnPrompts(batch.promptTurns[0]!.id)).toHaveLength(1)
  })
})
