// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { receiveMessageOnPort, type MessagePort } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { applyEventsToMessage, applyEventsToWindow } from '../../src/main/agents/storeOverlay'
import { immutableActivities, ownBuiltActivity } from '../../src/main/agents/activitySnapshots'
import { CONTROL, type StoreWorker, type StoreWorkerTiming } from '../../src/main/agents/storeWorker'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { ThreadStoreWriterOnMain, ThreadStoreWriterOnWorker, type ThreadStoreWrite, type ThreadStoreWriteOutcome } from '../../src/main/agents/threadStoreWriter'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentMessage } from '../../src/shared/agents'
import type { ThreadEvent } from '../../src/shared/threadEvents'
import { builtStoreWorker, walIndex } from '../fixtures/storeWorker'

/**
 * The store worker writes the thread store off main (#1457, step 2 of docs/plans/store-worker.md). Each test runs the
 * worker as the build compiles it, against a file of its own.
 */
const at = '2026-10-26T10:00:00.000Z'
const message = (id: string, text = randomBytes(600).toString('base64'), role: AgentMessage['role'] = 'assistant'): AgentMessage => ({ id, role, text, createdAt: at })
const added = (id: string, text?: string, role?: AgentMessage['role']): ThreadEvent => ({ kind: 'message-added', at, message: message(id, text, role) })
const appended = (messageId: string, appendText: string): ThreadEvent => ({ kind: 'message-text-appended', at, messageId, appendText })
const record = (id: string, sequence: number): AgentActivity => ({ id, turnId: 'turn', sequence, kind: 'tool', status: 'completed', title: `Tool ${id}`, output: `Output ${id}` })
type Internals = { db: DatabaseSync; worker: StoreWorker | undefined }
const internals = (store: ThreadStore): Internals => store as unknown as Internals

describe('the store worker', () => {
  let worker: Awaited<ReturnType<typeof builtStoreWorker>>
  const roots: string[] = []
  const closers: (() => void)[] = []
  beforeAll(async () => { worker = await builtStoreWorker() }, 120_000)
  afterAll(async () => { await worker?.dispose() })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const close of closers.splice(0).reverse()) { try { close() } catch { /* Closed by the test. */ } }
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  async function folder(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'sotto-store-worker-test-')); roots.push(root)
    return root
  }
  /** A store over the built worker with the writer the workspace uses, and a third connection that reads the file alone. */
  async function open(timing?: StoreWorkerTiming, path?: string) {
    path ??= join(await folder(), 'threads.sqlite')
    const store = new ThreadStore(path, undefined, { path: worker.path, ...(timing ? { timing } : {}) })
    store.open()
    const writer = new ThreadStoreWriterOnWorker(store)
    closers.push(() => writer.close())
    const post = (write: ThreadStoreWrite): Promise<ThreadStoreWriteOutcome> => new Promise(resolve => { writer.post(write, resolve) })
    return { store, writer, path, post }
  }
  /** Busy-waits, without yielding, until the file holds `count` events: the worker committed and main heard nothing yet. */
  function waitForCommitUnheard(path: string, count: number): void {
    const side = new DatabaseSync(path, { readOnly: true })
    try {
      const deadline = performance.now() + 30_000
      while (Number(side.prepare('SELECT COUNT(*) AS count FROM events').get()!.count) < count) {
        if (performance.now() > deadline) throw new Error('The worker did not commit')
      }
    } finally { side.close() }
  }
  /** What the pane is shown: the store's window with what is posted laid over it, read at one moment of the file. */
  function shown(store: ThreadStore, writer: ThreadStoreWriterOnWorker, threadId: string): AgentMessage[] {
    return store.reading(() => applyEventsToWindow(store.readMessages(threadId), writer.posted(threadId), id => store.message(threadId, id))).messages
  }
  function eventRows(path: string): unknown[] {
    const db = new DatabaseSync(path, { readOnly: true })
    try { return db.prepare('SELECT thread_id, kind, payload FROM events ORDER BY seq').all() } finally { db.close() }
  }

  it('makes every write on its own connection while main only reads', async () => {
    const { store, path, post } = await open()
    expect(internals(store).worker).toBeDefined()
    expect(Number(internals(store).db.prepare('PRAGMA query_only').get()!.query_only)).toBe(1)
    expect(Number(internals(store).db.prepare('PRAGMA wal_autocheckpoint').get()!.wal_autocheckpoint)).toBe(0)
    expect(() => store.append('thread', added('direct'))).toThrow()
    expect((await post({ kind: 'events', threadId: 'thread', events: [added('one', 'One')] })).failed.size).toBe(0)
    expect(store.readMessages('thread').messages.map(item => item.text)).toEqual(['One'])
    expect(eventRows(path)).toHaveLength(1)
  })

  it('lays a write the worker committed before its confirmation arrived over the window once, not twice', async () => {
    const { store, writer, path, post } = await open()
    await post({ kind: 'events', threadId: 'thread', events: [added('reply', 'Hello')] })
    writer.post({ kind: 'events', threadId: 'thread', events: [appended('reply', ', world'), added('next', 'Next')] })
    // Main has not yielded since the post, so the confirmation cannot have arrived; the commit can.
    waitForCommitUnheard(path, 3)
    expect(writer.unconfirmed('thread')).toBe(true)
    expect(shown(store, writer, 'thread').map(item => item.text)).toEqual(['Hello, world', 'Next'])
    await writer.confirmed('thread')
    expect(shown(store, writer, 'thread').map(item => item.text)).toEqual(['Hello, world', 'Next'])
  })

  it('reads at the moment the read began, so a write the worker commits during it is laid over once', async () => {
    const { store, writer, path, post } = await open({ busyTimeoutMs: 30_000 })
    await post({ kind: 'events', threadId: 'thread', events: [added('reply', 'Hello')] })
    // Another connection holds the write lock, so the worker waits inside the write ahead and has not begun the append.
    const holder = new DatabaseSync(path, { timeout: 5_000 })
    holder.exec('BEGIN IMMEDIATE')
    writer.post({ kind: 'events', threadId: 'other', events: [added('ahead', 'Ahead')] })
    const ahead = 2
    while (!internals(store).worker!.started(ahead)) await delay(5)
    writer.post({ kind: 'events', threadId: 'thread', events: [appended('reply', ', world')] })
    const read = store.reading(() => {
      // What is held is worked out first, as the workspace's single-message read does: the append is not begun.
      const held = writer.posted('thread')
      expect(held).toHaveLength(1)
      // The worker commits the append before the message itself is read.
      holder.exec('COMMIT'); holder.close()
      waitForCommitUnheard(path, 3)
      return applyEventsToMessage('reply', held, id => store.message('thread', id))
    })
    expect(read?.text).toBe('Hello, world')
    await writer.confirmed()
    expect(store.message('thread', 'reply')?.text).toBe('Hello, world')
  })

  it('lays a write the worker has not committed over the window', async () => {
    const { store, writer, path, post } = await open({ busyTimeoutMs: 30_000 })
    // A first write lands, so the worker's connection has opened: its start takes the write lock a moment, which it must
    // not meet held below.
    await post({ kind: 'events', threadId: 'other', events: [added('first', 'First')] })
    // Another connection holds the write lock, so the worker waits inside the write.
    const holder = new DatabaseSync(path, { timeout: 5_000 })
    holder.exec('BEGIN IMMEDIATE')
    try {
      writer.post({ kind: 'events', threadId: 'thread', events: [added('reply', 'Held')] })
      while (!internals(store).worker!.started(2)) await delay(5)
      expect(shown(store, writer, 'thread').map(item => item.text)).toEqual(['Held'])
    } finally { holder.exec('COMMIT'); holder.close() }
    await writer.confirmed()
    expect(shown(store, writer, 'thread').map(item => item.text)).toEqual(['Held'])
  })

  it('commits writes in the order posted under load, every thread in one stream', async () => {
    const { writer, path } = await open()
    const expected: string[] = []
    for (let index = 0; index < 600; index++) {
      const threadId = `thread-${index % 7}`
      expected.push(`${threadId}:m${index}`)
      if (index % 3 === 0) writer.post({ kind: 'event-batches', batches: new Map([[threadId, [added(`m${index}`)]]]) })
      else writer.post({ kind: 'events', threadId, events: [added(`m${index}`)] })
    }
    await writer.confirmed()
    expect(eventRows(path).map(row => { const { thread_id, payload } = row as { thread_id: string; payload: string }; return `${thread_id}:${(JSON.parse(payload) as { message: { id: string } }).message.id}` })).toEqual(expected)
  })

  it('sends a list that changed as what changed, and rebuilds it whole on the worker', async () => {
    const { store, post } = await open()
    // Records owned as the workspace holds them: frozen and branded, so the same record again is known without comparing.
    const owned = (id: string, sequence: number, title = `Tool ${id}`, status: AgentActivity['status'] = 'completed'): AgentActivity =>
      ownBuiltActivity({ ...record(id, sequence), title, status })
    const sent = vi.spyOn(internals(store).worker! as unknown as { list(entry: unknown): unknown }, 'list')
    const lastSent = (): Record<string, unknown> => sent.mock.results.at(-1)!.value as Record<string, unknown>
    const save = async (activities: readonly AgentActivity[]): Promise<void> => {
      expect((await post({ kind: 'activities', entries: [{ threadId: 'thread', activities }] })).failed.size).toBe(0)
    }
    const stored = () => store.readActivities('thread').map(({ id, title, status }) => ({ id, title, status }))
    const first = immutableActivities(Array.from({ length: 50 }, (_, index) => owned(`a${index}`, index)))
    await save(first)
    expect(lastSent()).toMatchObject({ whole: first })
    // A certified list that dropped ten from its front and added one: only the new record crosses.
    const later = immutableActivities([...first.slice(10), owned('b0', 60)])
    await save(later)
    expect(lastSent()).toMatchObject({ base: expect.any(Number) as number, ids: later.map(activity => activity.id) })
    expect((lastSent().changed as AgentActivity[]).map(activity => activity.id)).toEqual(['b0'])
    // The same certified list again: nothing crosses but that it is the same.
    await save(later)
    expect(lastSent()).toMatchObject({ same: true })
    expect(stored().map(item => item.id)).toEqual(later.map(activity => activity.id))
    // An array that is not certified, edited where it is between saves: a record replaced, one removed and the rest reordered.
    const mutable: AgentActivity[] = [...later.slice(0, 5), owned('c0', 70, 'Before', 'running')]
    await save(mutable)
    expect((lastSent().changed as AgentActivity[]).map(activity => activity.id)).toEqual(['c0'])
    mutable[5] = owned('c0', 70, 'After', 'completed')
    mutable.splice(1, 1)
    mutable.reverse()
    await save(mutable)
    expect(lastSent().same).toBeUndefined()
    expect((lastSent().changed as AgentActivity[]).map(activity => activity.title)).toEqual(['After'])
    expect(stored()).toEqual(mutable.map(({ id, title, status }) => ({ id, title, status })))
  })

  it('commits on main what it was posted once the worker goes mid-batch, and goes on writing there', async () => {
    // The worker waits for the lock as long as it needs: under load the release below can come seconds late, and a write
    // that gave up on the lock first would be a failure, not the worker going.
    const { store, writer, path } = await open({ busyTimeoutMs: 30_000 })
    await new Promise<void>(resolve => { writer.post({ kind: 'events', threadId: 'thread', events: [added('first', 'First')] }, () => resolve()) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const holder = new DatabaseSync(path, { timeout: 5_000 })
    holder.exec('BEGIN IMMEDIATE')
    const writes: ThreadStoreWrite[] = [
      { kind: 'event-batches', batches: new Map([['thread', [added('second', 'Second')]], ['other', [added('o1', 'Other')]]]) },
      { kind: 'events', threadId: 'thread', events: [appended('second', ' and more')] },
      { kind: 'activities', entries: [{ threadId: 'thread', activities: [record('a', 0)] }] },
    ]
    const outcomes: ThreadStoreWriteOutcome[] = []
    for (const write of writes) writer.post(write, outcome => outcomes.push(outcome))
    // The worker has begun the batch and waits for the lock inside it when it goes.
    while (!internals(store).worker!.started(2)) await delay(5)
    // A thread waiting inside SQLite for a lock ends once the wait does, which the lock let go here lets happen at once.
    const gone = internals(store).worker!.terminate()
    await delay(50)
    holder.exec('COMMIT'); holder.close()
    await gone
    await writer.confirmed()
    expect(outcomes).toHaveLength(writes.length)
    // On a loaded machine the lock the worker held can outlast main's own wait, so a write main finished for it fails
    // with the lock busy; the workspace posts a failed write again on its next round, as this does, and it lands there.
    for (const [index, outcome] of outcomes.entries()) {
      if (!outcome.failed.size) continue
      let again: ThreadStoreWriteOutcome | undefined
      writer.post(writes[index]!, heard => { again = heard })
      expect(again?.failed.size, `write ${index} posted again on main`).toBe(0)
    }
    expect(warn).toHaveBeenCalledWith('thread-store-worker-lost')
    expect(internals(store).worker).toBeUndefined()
    expect(Number(internals(store).db.prepare('PRAGMA query_only').get()!.query_only)).toBe(0)
    expect(store.readMessages('thread').messages.map(item => item.text)).toEqual(['First', 'Second and more'])
    expect(store.readMessages('other').messages.map(item => item.text)).toEqual(['Other'])
    expect(store.readActivities('thread').map(activity => activity.id)).toEqual(['a'])
    // Main writes from here, confirming inside the post.
    let heard = false
    writer.post({ kind: 'events', threadId: 'thread', events: [added('third', 'Third')] }, () => { heard = true })
    expect(heard).toBe(true)
    expect(eventRows(path)).toHaveLength(5)
  })

  it('waits for a gone worker’s write lock without holding main, and finishes its writes once the lock is free', async () => {
    const { store, writer, path } = await open({ busyTimeoutMs: 30_000 })
    await new Promise<void>(resolve => { writer.post({ kind: 'events', threadId: 'thread', events: [added('first', 'First')] }, () => resolve()) })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // The lock reads as held twice after the worker goes, as when its connection is still ending.
    const lockFree = vi.spyOn(store as unknown as { writeLockFree: (db: unknown) => boolean }, 'writeLockFree').mockReturnValueOnce(false).mockReturnValueOnce(false)
    const holder = new DatabaseSync(path, { timeout: 5_000 })
    holder.exec('BEGIN IMMEDIATE')
    const outcomes: ThreadStoreWriteOutcome[] = []
    writer.post({ kind: 'events', threadId: 'thread', events: [added('second', 'Second')] }, outcome => outcomes.push(outcome))
    while (!internals(store).worker!.started(2)) await delay(5)
    // Main's own timers keep firing while it waits for the lock: it never blocks on it.
    let ticks = 0
    const ticking = setInterval(() => { ticks++ }, 1)
    const gone = internals(store).worker!.terminate()
    await delay(50)
    holder.exec('COMMIT'); holder.close()
    await gone
    await writer.confirmed()
    clearInterval(ticking)
    expect(lockFree.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(ticks).toBeGreaterThan(0)
    expect(outcomes.map(outcome => outcome.failed.size)).toEqual([0])
    expect(store.readMessages('thread').messages.map(item => item.text)).toEqual(['First', 'Second'])
    expect(eventRows(path)).toHaveLength(2)
  })

  it('counts a batch the worker committed and never answered as committed, so nothing is written twice', async () => {
    const { store, writer, path } = await open()
    await new Promise<void>(resolve => { writer.post({ kind: 'events', threadId: 'thread', events: [added('first', 'First')] }, () => resolve()) })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const outcomes: ThreadStoreWriteOutcome[] = []
    writer.post({ kind: 'events', threadId: 'thread', events: [added('second', 'Second')] }, outcome => outcomes.push(outcome))
    waitForCommitUnheard(path, 2)
    // The answer is on its way and is taken off the port here, as if the worker went between its commit and its answer.
    const handle = internals(store).worker!
    while (Atomics.load(handle.controlArray, CONTROL.DONE) < 2) { /* The worker posts its answer. */ }
    expect(receiveMessageOnPort((handle as unknown as { port: MessagePort }).port)).toBeDefined()
    await handle.terminate()
    await writer.confirmed()
    expect(outcomes.map(outcome => outcome.failed.size)).toEqual([0])
    expect(eventRows(path)).toHaveLength(2)
    expect(store.readMessages('thread').messages.map(item => item.id)).toEqual(['first', 'second'])
  })

  it('fails a write whose commit cannot get the lock, and commits it when it is posted again', async () => {
    const { store, path, post } = await open({ busyTimeoutMs: 50 })
    // The worker's connection has opened before the lock is taken, so it is the write that meets it.
    await post({ kind: 'events', threadId: 'other', events: [added('first', 'First')] })
    const holder = new DatabaseSync(path, { timeout: 5_000 })
    holder.exec('BEGIN IMMEDIATE')
    let failed: ThreadStoreWriteOutcome
    try { failed = await post({ kind: 'events', threadId: 'thread', events: [added('one', 'One')] }) } finally { holder.exec('COMMIT'); holder.close() }
    expect(failed.failed.has('thread')).toBe(true)
    expect(failed.error).toBeInstanceOf(Error)
    // The worker failed it and goes on writing; nothing fell back to main.
    expect(internals(store).worker).toBeDefined()
    expect(store.readMessages('thread').messages).toEqual([])
    expect((await post({ kind: 'events', threadId: 'thread', events: [added('one', 'One')] })).failed.size).toBe(0)
    expect(store.readMessages('thread').messages.map(item => item.text)).toEqual(['One'])
  })

  it('commits every write posted before closing, then closes the worker before main', async () => {
    const { store, writer, path } = await open()
    for (let index = 0; index < 200; index++) writer.post({ kind: 'events', threadId: `thread-${index % 4}`, events: [added(`m${index}`)] })
    writer.post({ kind: 'activities', entries: [{ threadId: 'thread-0', activities: [record('a', 0)] }] })
    const handle = internals(store).worker!
    writer.close()
    expect(Atomics.load(handle.controlArray, CONTROL.LIFE)).toBe(2)
    // Main's close was the file's last, so the log went with it.
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(eventRows(path)).toHaveLength(200)
  })

  it('takes removed words out of the file and its log on the worker, waiting for the disk', async () => {
    const { store, path, post } = await open()
    const marker = `forget-me-${randomBytes(8).toString('hex')}`
    await post({ kind: 'events', threadId: 'forgotten', events: [added('words', `${marker} ${randomBytes(4_000).toString('base64')}`)] })
    for (let index = 0; index < 50; index++) await post({ kind: 'events', threadId: 'kept', events: [added(`k${index}`)] })
    const outcome = await post({ kind: 'forget', threadIds: ['forgotten'] })
    expect(outcome.failed.size).toBe(0)
    const bytes = Buffer.concat([readFileSync(path), existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : Buffer.alloc(0)])
    expect(bytes.includes(Buffer.from(marker))).toBe(false)
    expect(store.messageCount('kept')).toBe(50)
    expect(store.messageCount('forgotten')).toBe(0)
  })

  it('fails a removal whose checkpoint finds a reader on the log, and clears the words when it is asked again', async () => {
    const { path, post } = await open({ busyTimeoutMs: 50 })
    const marker = `forget-me-${randomBytes(8).toString('hex')}`
    await post({ kind: 'events', threadId: 'forgotten', events: [added('words', `${marker} ${randomBytes(4_000).toString('base64')}`)] })
    const reader = new DatabaseSync(path)
    reader.exec('BEGIN')
    reader.prepare('SELECT COUNT(*) FROM events').get()
    let outcome: ThreadStoreWriteOutcome
    try { outcome = await post({ kind: 'forget', threadIds: ['forgotten'] }) } finally { reader.exec('COMMIT'); reader.close() }
    expect(outcome.error).toBeInstanceOf(Error)
    expect((await post({ kind: 'forget', threadIds: ['forgotten'] })).failed.size).toBe(0)
    const bytes = Buffer.concat([readFileSync(path), existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : Buffer.alloc(0)])
    expect(bytes.includes(Buffer.from(marker))).toBe(false)
  })

  it('takes the file\'s words out on the worker when history turns off, then writes in memory on main', async () => {
    const { store, writer, path, post } = await open()
    const marker = `private-${randomBytes(8).toString('hex')}`
    await post({ kind: 'events', threadId: 'thread', events: [added('words', marker)] })
    let afterHeard = false
    writer.post({ kind: 'history-off', reopen: false, threads: [{ threadId: 'thread' }] })
    // Posted while the switch is unanswered: held, then written in memory, never to the file.
    writer.post({ kind: 'events', threadId: 'thread', events: [added('after', `${marker}-after`)] }, () => { afterHeard = true })
    await writer.confirmed()
    expect(afterHeard).toBe(true)
    expect(store.ephemeral).toBe(true)
    expect(internals(store).worker).toBeUndefined()
    expect(store.readMessages('thread').messages.map(item => item.id)).toEqual(['after'])
    const bytes = Buffer.concat([readFileSync(path), existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : Buffer.alloc(0)])
    expect(bytes.includes(Buffer.from(marker))).toBe(false)
    // Turned back on, the file takes over, on a worker again.
    expect((await post({ kind: 'history-on' })).failed.size).toBe(0)
    expect(internals(store).worker).toBeDefined()
    expect((await post({ kind: 'events', threadId: 'thread', events: [added('again', 'Again')] })).failed.size).toBe(0)
    expect(store.readMessages('thread').messages.map(item => item.id)).toEqual(['again'])
  })

  it('agrees with the writer on main over the same seeded writes', async () => {
    const reference = new ThreadStore(join(await folder(), 'threads.sqlite'), undefined, null)
    reference.open()
    const onMain = new ThreadStoreWriterOnMain(reference)
    closers.push(() => onMain.close())
    const { store, writer, path } = await open()
    let state = 1457
    const random = (): number => { state = (state + 0x6D2B79F5) >>> 0; let value = state; value = Math.imul(value ^ (value >>> 15), value | 1); value ^= value + Math.imul(value ^ (value >>> 7), value | 61); return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296 }
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    const threads = ['a', 'b', 'c']
    const ids = new Map<string, string[]>(threads.map(id => [id, []]))
    const lists = new Map<string, AgentActivity[]>()
    const families = ['add', 'append', 'reset', 'alias', 'batch', 'activities', 'release', 'visual', 'wake-up', 'forget'] as const
    const ran = new Map<string, number>()
    /** Threads whose forget is unconfirmed: the workspace stops showing a thread being cleared, so it is not compared. */
    const clearing = new Map<string, number>()
    let serial = 0
    for (let step = 0; step < 400; step++) {
      const family = pick(families), threadId = pick(threads), known = ids.get(threadId)!
      let write: ThreadStoreWrite | undefined
      switch (family) {
        case 'add': { const id = `m${++serial}`; known.push(id); write = { kind: 'events', threadId, events: [added(id, `Words ${serial}`, pick(['user', 'assistant'] as const))] }; break }
        case 'append': if (known.length) write = { kind: 'events', threadId, events: [appended(pick(known), ` more ${++serial}`)] }; break
        case 'reset': known.length = 0; write = { kind: 'events', threadId, events: [{ kind: 'messages-reset', at }] }; break
        case 'alias': if (known.length) { const canonical = pick(known); write = { kind: 'events', threadId, events: [{ kind: 'message-aliased', at, messageId: `copy${++serial}`, canonicalId: canonical }] } } break
        case 'batch': { const batches = new Map<string, ThreadEvent[]>(); for (const id of threads) if (random() < 0.6) { const m = `m${++serial}`; ids.get(id)!.push(m); batches.set(id, [added(m, `Batch ${serial}`)]) } write = { kind: 'event-batches', batches }; break }
        case 'activities': { const list = [...(lists.get(threadId) ?? []).slice(-5), Object.freeze(record(`r${++serial}`, serial)) as AgentActivity]; lists.set(threadId, list); write = { kind: 'activities', entries: [{ threadId, activities: list }] }; break }
        case 'release': write = { kind: 'activities-released', threadId }; break
        case 'visual': write = { kind: 'visual', threadId, stored: { visual: { id: `v${++serial}`, title: `Visual ${serial}`, kind: 'diagram', source: 'flowchart LR\n  A --> B', intro: 'Short.', steps: [{ text: 'A to B.', highlight: ['A->B'] }] } as never, createdAt: at, anchorMessageId: known.at(-1) ?? null, anchorUserMessageId: null } }; break
        case 'wake-up': write = { kind: 'wake-up', threadId, messageId: `wake${++serial}`, hidden: random() < 0.3 }; break
        case 'forget': known.length = 0; lists.delete(threadId); write = { kind: 'forget', threadIds: [threadId] }; break
      }
      if (!write) continue
      ran.set(family, (ran.get(family) ?? 0) + 1)
      onMain.post(write)
      if (write.kind === 'forget') {
        clearing.set(threadId, (clearing.get(threadId) ?? 0) + 1)
        writer.post(structuredClone(write), () => { const left = clearing.get(threadId)! - 1; if (left) clearing.set(threadId, left); else clearing.delete(threadId) })
      } else writer.post(structuredClone(write))
      // What each thread shows, read while the worker may hold any part of what was posted.
      if (random() < 0.3) for (const id of threads) if (!clearing.has(id)) expect(shown(store, writer, id), `${family} ${id}`).toEqual(reference.readMessages(id).messages)
      if (random() < 0.1) await writer.confirmed()
    }
    for (const family of families) expect(ran.get(family) ?? 0, family).toBeGreaterThan(0)
    await writer.confirmed()
    const rowsOf = (file: string) => {
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        return ['SELECT thread_id, kind, payload FROM events ORDER BY seq', 'SELECT thread_id, position, message_id, role, text FROM messages ORDER BY thread_id, position',
          'SELECT thread_id, activity_id, position, payload FROM activities ORDER BY thread_id, position', 'SELECT thread_id, epoch, message_reset_seq FROM activity_epochs ORDER BY thread_id',
          'SELECT thread_id, visual_id, anchor_message_id FROM visuals ORDER BY seq', 'SELECT thread_id, message_id, hidden FROM wake_ups ORDER BY thread_id, message_id']
          .map(sql => db.prepare(sql).all())
      } finally { db.close() }
    }
    const referencePath = (reference as unknown as { path: string }).path
    for (const id of threads) expect(shown(store, writer, id)).toEqual(reference.readMessages(id).messages)
    expect(rowsOf(path)).toEqual(rowsOf(referencePath))
  })

  describe('checkpoints', () => {
    /** What the log holds once the worker has caught up with it, read until it has. */
    async function caughtUp(path: string): Promise<{ frames: number; backfilled: number }> {
      for (;;) {
        const index = walIndex(path)
        if (index.backfilled === index.frames) return index
        await delay(20)
      }
    }

    it('commits writes that grow the log past SQLite\'s own threshold, and folds the log in on the worker', async () => {
      const { store, writer, path } = await open()
      for (let index = 0; index < 400; index++) writer.post({ kind: 'events', threadId: `thread-${index % 3}`, events: Array.from({ length: 4 }, (_, offset) => added(`m-${index}-${offset}`, randomBytes(1_200).toString('base64'))) })
      await writer.confirmed()
      const index = await caughtUp(path)
      expect(index.frames).toBeGreaterThan(1_000)
      expect(index.backfilled).toBe(index.frames)
      expect(store.messageCount('thread-0')).toBeGreaterThan(0)
    }, 120_000)

    it('hands writes and checkpoints back to main when the worker goes', async () => {
      const { store } = await open()
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      await internals(store).worker!.terminate()
      for (;;) {
        if (internals(store).worker === undefined) break
        await delay(20)
      }
      expect(Number(internals(store).db.prepare('PRAGMA wal_autocheckpoint').get()!.wal_autocheckpoint)).toBe(1_000)
      store.append('thread', added('after'))
      expect(store.messageCount('thread')).toBe(1)
    })

    const write = (writer: ThreadStoreWriterOnWorker, index: number): Promise<void> =>
      new Promise<void>(resolve => { writer.post({ kind: 'events', threadId: 'thread', events: [added(`m${index}`, randomBytes(9_000).toString('base64'))] }, () => resolve()) })

    it('keeps the log small while writes keep landing, with no other writer to wait for', async () => {
      const { writer, path } = await open({ intervalMs: 10, restartPages: 200 })
      let most = 0
      for (let index = 0; index < 150; index++) {
        await write(writer, index)
        most = Math.max(most, walIndex(path).frames)
        await delay(2)
      }
      // About 500 pages were written; each passive checkpoint finds no save to wait for, so the log starts over as it goes.
      expect(most).toBeLessThan(300)
    }, 120_000)

    it('starts the log over with a RESTART once a long read that held it back ends', async () => {
      const { store, writer, path } = await open({ intervalMs: 10, restartPages: 200 })
      // A read that holds an old snapshot keeps every checkpoint from reaching the end of the log, so it grows past 200 pages.
      const reader = new DatabaseSync(path)
      reader.exec('BEGIN')
      reader.prepare('SELECT COUNT(*) FROM events').get()
      for (let index = 0; index < 80; index++) await write(writer, index)
      const grown = walIndex(path).frames
      expect(grown).toBeGreaterThan(200)
      reader.exec('COMMIT'); reader.close()
      while (internals(store).worker!.restarts().done === 0) await delay(10)
      await write(writer, 80)
      expect(walIndex(path).frames).toBeLessThan(grown)
    }, 120_000)
  })
})
