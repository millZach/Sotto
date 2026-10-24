// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTask, setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { WalCheckpointer } from '../../src/main/storage/walCheckpointer'
import type { AgentMessage } from '../../src/shared/agents'
import { builtCheckpointWorker, walIndex } from '../fixtures/walCheckpointWorker'

/**
 * The thread store's log is checkpointed on a worker thread, so no save on main runs a checkpoint (#1451, ADR-0016's
 * October 23 amendment). Each test runs the worker as the build compiles it.
 */
const at = '2026-10-23T10:00:00.000Z'
const message = (id: string, text = randomBytes(1_200).toString('base64')): AgentMessage => ({ id, role: 'assistant', text, createdAt: at })
type Internals = { db: DatabaseSync; checkpointer: { aside<T>(work: () => T): T; worker: { terminate(): Promise<number> }; control: Int32Array } | undefined }
const internals = (store: ThreadStore): Internals => store as unknown as Internals
/** The control array main shares with its store's worker: slot 0 is the checkpoint's state, slot 1 the worker's life. */
const controlOf = (store: ThreadStore): Int32Array => internals(store).checkpointer!.control

/**
 * Workers that stand in for the checkpoint worker, speaking its control array (`walCheckpointer.ts`), so a test can put
 * main in the moment it means to test without timing it.
 */
const STUBS = {
  // Opens nothing, starts a checkpoint at once and finishes it only once main is waiting for it: a removal that arrives
  // during a checkpoint. Atomics.notify answers how many it woke, so it knows when main waits.
  checkpointInFlight: `
    const { parentPort, workerData } = require('node:worker_threads')
    const control = new Int32Array(workerData.control)
    const pause = new Int32Array(new SharedArrayBuffer(4))
    Atomics.compareExchange(control, 1, 0, 3)
    Atomics.store(control, 0, 1)
    while (Atomics.notify(control, 0, 1) === 0) Atomics.wait(pause, 0, 0, 1)
    Atomics.store(control, 0, 0)
    Atomics.notify(control, 0)
    parentPort.on('message', message => { if (message === 'stop') { Atomics.store(control, 1, 2); Atomics.notify(control, 1) } })
  `,
  // Says it has stopped, as a worker whose start-up or checkpoint failed does, and stays alive, so its exit never
  // reaches main; it answers no message.
  stoppedEarly: `
    const { workerData } = require('node:worker_threads')
    const control = new Int32Array(workerData.control)
    Atomics.store(control, 1, 2)
    Atomics.notify(control, 1)
    setInterval(() => undefined, 1 << 30)
  `,
}

describe('thread store checkpoints off main', () => {
  let worker: Awaited<ReturnType<typeof builtCheckpointWorker>>
  const stubs = { checkpointInFlight: '', stoppedEarly: '' }
  const roots: string[] = []
  const stores: ThreadStore[] = []
  beforeAll(async () => {
    worker = await builtCheckpointWorker()
    const root = await mkdtemp(join(tmpdir(), 'sotto-checkpoint-stubs-')); roots.push(root)
    for (const [name, source] of Object.entries(STUBS)) {
      const path = join(root, `${name}.cjs`)
      await writeFile(path, source)
      stubs[name as keyof typeof stubs] = path
    }
  })
  afterAll(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
    await worker?.dispose()
  })
  afterEach(async () => {
    for (const store of stores.splice(0)) store.close()
    // The stubs' folder stays for the whole file.
    await Promise.all(roots.splice(1).map(root => rm(root, { recursive: true, force: true })))
  })
  async function openStore(checkpointWorker: string | null = worker.path): Promise<{ store: ThreadStore; path: string; root: string }> {
    const root = await mkdtemp(join(tmpdir(), 'sotto-checkpoint-')); roots.push(root)
    const path = join(root, 'threads.sqlite')
    const store = new ThreadStore(path, undefined, checkpointWorker); stores.push(store)
    store.open()
    return { store, path, root }
  }
  /** What the log holds once the worker has caught up with it, read until it has, however long the disk takes. */
  async function caughtUp(path: string): Promise<{ frames: number; backfilled: number }> {
    for (;;) {
      const index = walIndex(path)
      if (index.backfilled === index.frames) return index
      await delay(20)
    }
  }

  /** Saves enough to pass SQLite's 1,000-page threshold, counting those that put pages into the file themselves. */
  function saveAndCount(store: ThreadStore, path: string): { inline: number; frames: number } {
    let inline = 0, frames = 0
    for (let index = 0; index < 400; index++) {
      const before = walIndex(path)
      store.appendMany(`thread-${index % 3}`, Array.from({ length: 4 }, (_, offset) => ({ kind: 'message-added' as const, at, message: message(`m-${index}-${offset}`) })))
      const after = walIndex(path)
      if (after.backfilled !== before.backfilled) inline++
      frames = Math.max(frames, after.frames)
    }
    return { inline, frames }
  }

  it('runs SQLite\'s checkpoint inside the save that grows the log past its threshold, where no worker checkpoints', async () => {
    const { store, path } = await openStore(null)
    expect(saveAndCount(store, path).inline).toBeGreaterThan(0)
  }, 120_000)

  it('commits saves that grow the log past SQLite\'s own threshold without a checkpoint on main', async () => {
    const { store, path } = await openStore()
    expect(Number(internals(store).db.prepare('PRAGMA wal_autocheckpoint').get()!.wal_autocheckpoint)).toBe(0)
    // With the worker held aside, any page that reaches the file during a save was put there by that save.
    const { inline, frames } = internals(store).checkpointer!.aside(() => saveAndCount(store, path))
    // Past SQLite's 1,000 pages, where its own checkpoint would have run inside a save.
    expect(frames).toBeGreaterThan(1_000)
    expect(inline).toBe(0)
    // The worker folds the log into the file once it may.
    const index = await caughtUp(path)
    expect(index.backfilled).toBe(index.frames)
    expect(store.messageCount('thread-0')).toBeGreaterThan(0)
  }, 120_000)

  it('closes the worker\'s connection before main\'s, so the log goes with main\'s close and the folder can be removed', async () => {
    const { store, path, root } = await openStore()
    for (let index = 0; index < 50; index++) store.append('thread', { kind: 'message-added', at, message: message(`m-${index}`) })
    store.close()
    expect(existsSync(`${path}-wal`)).toBe(false)
    await rm(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  })

  it('still clears forgotten words out of the file and its log while the worker checkpoints', async () => {
    const { store, path } = await openStore()
    const marker = `forget-me-${randomBytes(8).toString('hex')}`
    store.append('kept', { kind: 'message-added', at, message: message('kept') })
    store.append('forgotten', { kind: 'message-added', at, message: message('words', `${marker} ${randomBytes(4_000).toString('base64')}`) })
    for (let index = 0; index < 100; index++) store.append('kept', { kind: 'message-added', at, message: message(`k-${index}`) })
    await caughtUp(path)
    store.forget('forgotten')
    const bytes = Buffer.concat([readFileSync(path), existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : Buffer.alloc(0)])
    expect(bytes.includes(Buffer.from(marker))).toBe(false)
    expect(store.messageCount('kept')).toBe(101)
  }, 60_000)

  it('hands checkpoints back to SQLite when the worker goes', async () => {
    const { store } = await openStore()
    const { db, checkpointer } = internals(store)
    await checkpointer!.worker.terminate()
    for (;;) {
      if (Number(db.prepare('PRAGMA wal_autocheckpoint').get()!.wal_autocheckpoint) === 1_000) break
      await delay(20)
    }
    expect(internals(store).checkpointer).toBeUndefined()
    store.append('thread', { kind: 'message-added', at, message: message('after') })
    expect(store.messageCount('thread')).toBe(1)
  })

  it('waits out a checkpoint in flight before a removal\'s own checkpoint, then clears the words', async () => {
    const { store, path } = await openStore(stubs.checkpointInFlight)
    const marker = `forget-me-${randomBytes(8).toString('hex')}`
    store.append('forgotten', { kind: 'message-added', at, message: message('words', `${marker} ${randomBytes(4_000).toString('base64')}`) })
    for (let index = 0; index < 20; index++) store.append('kept', { kind: 'message-added', at, message: message(`k-${index}`) })
    const control = controlOf(store)
    // The stub has started a checkpoint, and finishes it only once main is waiting for it.
    while (Atomics.load(control, 0) !== 1) await nextTask()
    store.forget('forgotten')
    expect(Atomics.load(control, 0)).toBe(0)
    const bytes = Buffer.concat([readFileSync(path), existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : Buffer.alloc(0)])
    expect(bytes.includes(Buffer.from(marker))).toBe(false)
    expect(store.messageCount('kept')).toBe(20)
  }, 60_000)

  it('fails a removal whose checkpoint finds the log busy, and clears the words when it is tried again', async () => {
    const { store, path } = await openStore()
    const marker = `forget-me-${randomBytes(8).toString('hex')}`
    store.append('forgotten', { kind: 'message-added', at, message: message('words', `${marker} ${randomBytes(4_000).toString('base64')}`) })
    await caughtUp(path)
    // A reader holding an older snapshot keeps the log from being cleared. Main answers a busy lock at once here, rather
    // than after its five seconds.
    const reader = new DatabaseSync(path)
    internals(store).db.exec('PRAGMA busy_timeout=0')
    try {
      reader.exec('BEGIN')
      reader.prepare('SELECT COUNT(*) FROM events').get()
      expect(() => store.redactAll()).toThrow('The history log could not be cleared')
    } finally {
      reader.exec('COMMIT')
      reader.close()
    }
    // What Keep local history's maintenance does after a failed removal: it asks again.
    store.redactAll()
    const bytes = Buffer.concat([readFileSync(path), existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : Buffer.alloc(0)])
    expect(bytes.includes(Buffer.from(marker))).toBe(false)
  }, 60_000)

  it('closes at once a worker that stopped before main heard it go', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-checkpoint-')); roots.push(root)
    const checkpointer = WalCheckpointer.start(join(root, 'threads.sqlite'), stubs.stoppedEarly, () => undefined)!
    const control = (checkpointer as unknown as { control: Int32Array }).control
    // The stub says it has stopped, as a worker whose start-up or checkpoint failed does, and its exit has not reached main.
    while (Atomics.load(control, 1) !== 2) await nextTask()
    checkpointer.stop()
    // Main did not ask it to stop and wait for an answer that cannot come.
    expect(Atomics.load(control, 1)).toBe(2)
  }, 60_000)

  it('starts the log over while saves keep coming, rather than letting it grow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-checkpoint-')); roots.push(root)
    const path = join(root, 'threads.sqlite')
    const db = new DatabaseSync(path, { timeout: 5_000 })
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE rows (text TEXT NOT NULL)')
    const checkpointer = WalCheckpointer.start(path, worker.path, () => undefined, { intervalMs: 10, restartPages: 200 })!
    const insert = db.prepare('INSERT INTO rows (text) VALUES (?)')
    let most = 0, restarts = 0, last = 0
    try {
      // Saves back to back, each a few pages, with the event loop turning between them as main's does.
      for (let index = 0; index < 3_000; index++) {
        insert.run(randomBytes(9_000).toString('base64'))
        const { frames } = walIndex(path)
        if (frames < last) restarts++
        last = frames
        most = Math.max(most, frames)
        await nextTask()
      }
    } finally {
      checkpointer.stop()
      db.close()
    }
    // Some 12,000 pages were written. Without a restart the log would hold all of them.
    expect(restarts).toBeGreaterThan(0)
    expect(most).toBeLessThan(4_000)
  }, 120_000)
})
