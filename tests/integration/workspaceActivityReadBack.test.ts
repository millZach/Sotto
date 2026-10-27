// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { StoreWorker, StoreWorkerOptions, WorkerMessage } from '../../src/main/agents/storeWorker'
import { READ_PIECE_RECORDS } from '../../src/main/agents/storeWorkerProtocol'
import { ThreadStore } from '../../src/main/agents/threadStore'
import type { ThreadStoreWriter } from '../../src/main/agents/threadStoreWriter'
import { WorkspaceHost } from '../../src/main/agents/workspace'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { readsArrived, readsInFlight, storedIn } from '../fixtures/storeWriterEquivalence'
import { builtStoreWorker } from '../fixtures/storeWorker'

/**
 * Opening a stored thread over the store worker as the build compiles it (#1457, step 3 of docs/plans/store-worker.md):
 * the worker reads the thread's records back, and its provider hears of the observation only once they have arrived.
 * The worker answers on a task of its own, so whatever a test does before it yields happens while the list is on its way;
 * each test waits for the read itself (`readsArrived`), never for time.
 */
const THREAD = 'session-workshop'
const DOCS = 'session-docs'
const cleanup: Array<() => Promise<void>> = []

function record(id: string, sequence: number, extra: Partial<AgentActivity> = {}): AgentActivity {
  return { id, turnId: 'turn', sequence, kind: 'tool', status: 'completed', title: 'Tool', output: `Output ${id}`, ...extra }
}

describe('a stored thread read back on the store worker', () => {
  let worker: Awaited<ReturnType<typeof builtStoreWorker>>
  beforeAll(async () => { worker = await builtStoreWorker() }, 120_000)
  afterAll(async () => { await worker?.dispose() })
  afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

  /**
   * A workspace whose first run saved `saved` for the workshop thread, reopened over the worker with a provider that has
   * not read it, so the thread is stored. Every observation its provider hears is kept with what the thread held then.
   */
  async function stored(saved: AgentActivity[], history: () => boolean = () => true, options: { timing?: StoreWorkerOptions['timing']; threads?: number } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-read-back-'))
    cleanup.push(async () => {
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-read-back-')) throw new Error('Unexpected test directory')
      await rm(directory, { recursive: true, force: true })
    })
    const provider = new FakeProviderHost()
    // More stored threads beside the workshop, each with a record of its own.
    for (let index = 0; index < (options.threads ?? 0); index++) {
      provider.state.threads.push({ id: `session-more-${index}`, projectId: 'project', title: `More ${index}`, modelId: 'fake:model', status: 'idle', messages: [], requests: [],
        activities: [record(`more-${index}`, 0)] })
    }
    provider.state.threads[0]!.activities = structuredClone(saved)
    const first = new WorkspaceHost(provider, directory, history, undefined, false, false, false, undefined, null)
    await first.initialize()
    await first.connect()
    first.disconnect(); await first.privacyChanged(); first.dispose()
    for (const thread of provider.state.threads) delete thread.activities
    const host = new WorkspaceHost(provider, directory, history, undefined, false, false, false, undefined, options.timing ? { path: worker.path, timing: options.timing } : worker.path)
    cleanup.push(async () => { host.disconnect(); await host.close().catch(() => undefined) })
    const told: { ids: readonly string[]; activities: string[] | undefined }[] = []
    provider.observeThreads = ids => {
      provider.observed = [...ids]
      told.push({ ids: [...ids], activities: shown(host)?.activities?.map(item => item.id) })
    }
    await host.initialize()
    await host.connect()
    const store = (host as unknown as { threadStore: { readonly worker: StoreWorker | undefined } }).threadStore
    expect(store.worker).toBeDefined()
    expect(shown(host)!.activities).toBeUndefined()
    const disk = (threadId = THREAD) => {
      const reader = new ThreadStore(join(directory, 'threads.sqlite'), undefined, null)
      reader.open()
      try { return reader.readActivities(threadId) } finally { reader.close() }
    }
    const writes = (host as unknown as { writes: ThreadStoreWriter }).writes
    return { directory, provider, host, told, store, disk, writes }
  }

  /**
   * Holds back the worker's answers to reads until the test lets them through, or until the answer to the write of the kind
   * named arrives, which they are then heard just before. Writes' answers are heard as they come.
   */
  function holdReads(store: { readonly worker: StoreWorker | undefined }, before?: string) {
    const handle = store.worker! as unknown as { heard(message: WorkerMessage): void; post: StoreWorker['post'] }
    const heard = handle.heard.bind(handle), post = handle.post.bind(handle)
    const held: WorkerMessage[] = []
    let holding = true, beforeId: number | undefined
    vi.spyOn(handle, 'post').mockImplementation((write, settle, preserved) => {
      const id = post(write, settle, preserved)
      if (write.kind === before) beforeId = id
      return id
    })
    const release = (): void => { holding = false; for (const message of held.splice(0)) heard(message) }
    vi.spyOn(handle, 'heard').mockImplementation(message => {
      if ('read' in message && holding) { held.push(message); return }
      if (!('read' in message) && message.id === beforeId) release()
      heard(message)
    })
    return { release, held: () => held.length }
  }
  const shown = (host: WorkspaceHost, threadId = THREAD) => host.workspaceSnapshot().threads.find(thread => thread.id === threadId)

  it('tells the provider of a stored thread once its records have arrived, and of the other threads at once', async () => {
    const f = await stored([record('a', 0), record('b', 1, { status: 'running' })])
    const read = vi.spyOn(ThreadStore.prototype, 'readActivities')
    f.host.observeThreads([THREAD, DOCS])
    // The list is on its way: the pane has the thread's messages and summary, its provider has heard of the docs alone.
    expect(readsInFlight(f.host).has(THREAD)).toBe(true)
    expect(f.provider.observed).toEqual([DOCS])
    expect(shown(f.host)!.activities).toBeUndefined()
    expect(shown(f.host)!.summary?.activityCount).toBe(2)
    await readsArrived(f.host)
    expect(f.provider.observed).toEqual([THREAD, DOCS])
    // When the provider first heard of the thread, the thread already held its records.
    expect(f.told.find(call => call.ids.includes(THREAD))?.activities).toEqual(['a', 'b'])
    expect(shown(f.host)!.activities?.map(item => [item.id, item.status])).toEqual([['a', 'completed'], ['b', 'unknown']])
    // The read ran on the worker; main read no record.
    expect(read).not.toHaveBeenCalled()
  })

  it('merges what the provider publishes while the list is on its way onto it, keeping each record\'s sequence, anchor and finished state', async () => {
    const f = await stored([record('a', 0, { afterMessageId: 'message-1' }), record('b', 1)])
    f.host.observeThreads([THREAD])
    f.provider.state.threads[0]!.activities = [record('b', 9, { output: 'Changed' }), record('a', 4, { status: 'running' }), record('c', 0)]
    f.provider.emit()
    f.provider.state.threads[0]!.activities = [...f.provider.state.threads[0]!.activities, record('d', 1)]
    f.provider.emit()
    // The records wait for the list: none of them shows yet.
    expect(readsInFlight(f.host).get(THREAD)?.held).toHaveLength(2)
    expect(shown(f.host)!.activities).toBeUndefined()
    await readsArrived(f.host)
    const merged = shown(f.host)!.activities!
    expect(merged.map(item => [item.id, item.sequence, item.status, item.output])).toEqual([
      ['a', 0, 'completed', 'Output a'], ['b', 1, 'completed', 'Changed'], ['c', 2, 'completed', 'Output c'], ['d', 3, 'completed', 'Output d']])
    expect(merged[0]!.afterMessageId).toBe('message-1')
    f.host.disconnect()
    await f.host.close()
    expect(f.disk().map(item => [item.id, item.sequence, item.output])).toEqual([['a', 0, 'Output a'], ['b', 1, 'Changed'], ['c', 2, 'Output c'], ['d', 3, 'Output d']])
  })

  it('holds the records of a thread the window stopped looking at while its list was on its way, as a read on main had, until a save lets them go', async () => {
    const f = await stored([record('a', 0), record('b', 1)])
    f.host.observeThreads([THREAD])
    f.host.observeThreads([])
    await readsArrived(f.host)
    expect(shown(f.host)!.activities?.map(item => item.id)).toEqual(['a', 'b'])
    expect(f.told.some(call => call.ids.includes(THREAD))).toBe(false)
    await f.host.flush()
    await vi.waitFor(() => expect(shown(f.host)!.activities).toBeUndefined())
    expect(shown(f.host)!.summary?.activityCount).toBe(2)
    // Looked at again, it is read again.
    f.host.observeThreads([THREAD])
    await readsArrived(f.host)
    expect(shown(f.host)!.activities?.map(item => item.id)).toEqual(['a', 'b'])
    expect(f.provider.observed).toEqual([THREAD])
  })

  it('merges what the provider published before the window stopped looking, then lets the records go at the next save', async () => {
    const f = await stored([record('a', 0)])
    f.host.observeThreads([THREAD])
    f.provider.state.threads[0]!.activities = [record('c', 0)]
    f.provider.emit()
    f.host.observeThreads([])
    await readsArrived(f.host)
    expect(shown(f.host)!.activities?.map(item => item.id)).toEqual(['a', 'c'])
    expect(f.provider.observed).toEqual([])
    await f.host.flush()
    await vi.waitFor(() => expect(shown(f.host)!.activities).toBeUndefined())
    expect(f.disk().map(item => item.id)).toEqual(['a', 'c'])
  })

  it('takes nothing from a read whose thread was cleared while its list was on its way', async () => {
    const f = await stored([record('a', 0)])
    f.host.observeThreads([THREAD])
    f.provider.state.threads[0]!.activities = [record('c', 0)]
    f.provider.emit()
    const result = await f.host.deleteThreads([THREAD], { automatic: false, hold: () => null })
    expect(result.deleted).toEqual([THREAD])
    await readsArrived(f.host)
    expect(shown(f.host)).toBeUndefined()
    f.host.disconnect()
    await f.host.close()
    expect(f.disk()).toEqual([])
  })

  it('never tells the provider of a thread deleted while its list was on its way', async () => {
    const f = await stored([record('a', 0)])
    f.host.observeThreads([THREAD, DOCS])
    expect(f.provider.observed).toEqual([DOCS])
    const told = f.told.length
    expect((await f.host.deleteThreads([THREAD], { automatic: false, hold: () => null })).deleted).toEqual([THREAD])
    await readsArrived(f.host)
    await vi.waitFor(() => expect(readsInFlight(f.host).size).toBe(0))
    // The read let go with the delete tells the provider again, without the thread the window still named.
    expect(f.told.slice(told).some(call => call.ids.includes(THREAD))).toBe(false)
    expect(f.provider.observed).not.toContain(THREAD)
  })

  it('reads the list before Keep local history turns off when the switch follows the read, and the file keeps no words', async () => {
    let history = true
    const f = await stored([record('a', 0)], () => history)
    f.host.observeThreads([THREAD])
    history = false
    await f.host.privacyChanged()
    // The read was posted before the switch, so it was answered first: the thread holds what it showed, as a thread a window
    // already had open does, and the switch took the words out of the file.
    expect(readsInFlight(f.host).size).toBe(0)
    expect(shown(f.host)!.activities?.map(item => item.id)).toEqual(['a'])
    expect(f.provider.observed).toEqual([THREAD])
    f.host.disconnect()
    await f.host.close()
    expect(f.disk()).toEqual([])
  })

  it('reads on main when the worker goes while the list is on its way', async () => {
    const f = await stored([record('a', 0), record('b', 1)])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const read = vi.spyOn(ThreadStore.prototype, 'readActivities')
    // Asked to end before the read is posted, the worker never answers it.
    void f.store.worker!.terminate()
    f.host.observeThreads([THREAD])
    f.provider.state.threads[0]!.activities = [record('c', 0)]
    f.provider.emit()
    expect(readsInFlight(f.host).has(THREAD)).toBe(true)
    await readsArrived(f.host)
    expect(warn).toHaveBeenCalledWith('thread-store-worker-lost')
    expect(read).toHaveBeenCalledWith(THREAD, { shared: true })
    expect(shown(f.host)!.activities?.map(item => [item.id, item.sequence])).toEqual([['a', 0], ['b', 1], ['c', 2]])
    expect(f.provider.observed).toEqual([THREAD])
    f.host.disconnect()
    await f.host.close()
    expect(f.disk().map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('reads on main, the provider told at once, once the worker has gone', async () => {
    const f = await stored([record('a', 0)])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await f.store.worker!.terminate()
    await vi.waitFor(() => expect(f.store.worker).toBeUndefined())
    f.host.observeThreads([THREAD])
    expect(readsInFlight(f.host).size).toBe(0)
    expect(f.told.find(call => call.ids.includes(THREAD))?.activities).toEqual(['a'])
  })

  it('receives a list of more than one piece whole, with what the provider published meanwhile merged after it', async () => {
    const many = Array.from({ length: READ_PIECE_RECORDS * 2 + 3 }, (_, index) => record(`r${index}`, index))
    const f = await stored(many)
    const pieces = vi.spyOn(f.store.worker! as unknown as { heard(message: WorkerMessage): void }, 'heard')
    f.host.observeThreads([THREAD])
    f.provider.state.threads[0]!.activities = [record('r1', 7, { output: 'Changed' }), record('late', 0)]
    f.provider.emit()
    await readsArrived(f.host)
    expect(pieces).toHaveBeenCalledTimes(3)
    const shownRecords = shown(f.host)!.activities!
    expect(shownRecords).toHaveLength(many.length + 1)
    expect(shownRecords.map(item => item.id)).toEqual([...many.map(item => item.id), 'late'])
    expect(shownRecords[1]).toMatchObject({ sequence: 1, output: 'Changed' })
    expect(shownRecords.at(-1)).toMatchObject({ id: 'late', sequence: many.length })
    expect(f.provider.observed).toEqual([THREAD])
  })

  it('reads on main when the worker goes between the pieces of a list', async () => {
    const many = Array.from({ length: READ_PIECE_RECORDS + 1 }, (_, index) => record(`r${index}`, index))
    const f = await stored(many)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const read = vi.spyOn(ThreadStore.prototype, 'readActivities')
    const handle = f.store.worker! as unknown as { heard(message: WorkerMessage): void }
    const heard = handle.heard.bind(handle)
    // The worker is asked to end as the first piece is received, before the second is asked for, so it never sends it.
    vi.spyOn(handle, 'heard').mockImplementation(message => { heard(message); void f.store.worker?.terminate() })
    f.host.observeThreads([THREAD])
    await readsArrived(f.host)
    expect(warn).toHaveBeenCalledWith('thread-store-worker-lost')
    expect(read).toHaveBeenCalledWith(THREAD, { shared: true })
    expect(shown(f.host)!.activities?.map(item => item.id)).toEqual(many.map(item => item.id))
    expect(f.provider.observed).toEqual([THREAD])
  })

  it('takes nothing from a read asked for before a new history epoch\'s list replaced it and was let go', async () => {
    const f = await stored([record('a', 0)])
    const reads = holdReads(f.store)
    f.host.observeThreads([THREAD])
    f.host.observeThreads([])
    f.provider.state.threads[0]!.historyEpoch = 'rewound'
    f.provider.state.threads[0]!.activities = [record('z', 0)]
    f.provider.emit()
    // The new epoch's list is saved and let go while the old read is still held back: the thread is stored again.
    for (let save = 0; save < 2; save++) { await f.host.flush(); await f.writes.confirmed() }
    expect(storedIn(f.host, THREAD)).toBe(true)
    expect(reads.held()).toBe(1)
    reads.release()
    await readsArrived(f.host)
    expect(shown(f.host)!.activities).toBeUndefined()
    // Looked at again, the thread reads what it holds now.
    f.host.observeThreads([THREAD])
    await readsArrived(f.host)
    expect(shown(f.host)!.activities?.map(item => item.id)).toEqual(['z'])
    f.host.disconnect()
    await f.host.close()
    expect(f.disk().map(item => item.id)).toEqual(['z'])
  })

  it('keeps what the provider published behind a list that arrives while a clear that fails is under way', async () => {
    const f = await stored([record('a', 0)], () => true, { timing: { busyTimeoutMs: 50 } })
    await f.writes.confirmed()
    const reads = holdReads(f.store, 'forget')
    f.host.observeThreads([THREAD])
    f.provider.state.threads[0]!.activities = [record('c', 0)]
    f.provider.emit()
    // Another connection holds the write lock, so the forget fails; the list is heard just before it does.
    const holder = new DatabaseSync(join(f.directory, 'threads.sqlite'), { timeout: 5_000 })
    holder.exec('BEGIN IMMEDIATE')
    try {
      await expect(f.host.deleteThreads([THREAD], { automatic: false, hold: () => null })).rejects.toThrow(/kept them/)
    } finally { holder.exec('COMMIT'); holder.close() }
    expect(reads.held()).toBe(0)
    await readsArrived(f.host)
    expect(shown(f.host)!.activities?.map(item => item.id)).toEqual(['a', 'c'])
    expect(f.provider.observed).toEqual([THREAD])
    f.host.disconnect()
    await f.host.close().catch(() => undefined)
    expect(f.disk().map(item => item.id)).toEqual(['a', 'c'])
  })

  it('reads on main while closing when the worker goes with a list on its way, so the last save keeps what was published behind it', async () => {
    const f = await stored([record('a', 0)])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const read = vi.spyOn(ThreadStore.prototype, 'readActivities')
    void f.store.worker!.terminate()
    f.host.observeThreads([THREAD])
    f.provider.state.threads[0]!.activities = [record('c', 0)]
    f.provider.emit()
    f.host.disconnect()
    await f.host.close()
    expect(read).toHaveBeenCalledWith(THREAD, { shared: true })
    expect(f.disk().map(item => item.id)).toEqual(['a', 'c'])
  })

  it('tells the provider once for many stored threads opened together, not once for each', async () => {
    const MANY = 40
    const f = await stored([record('a', 0)], () => true, { threads: MANY })
    const ids = [THREAD, ...Array.from({ length: MANY }, (_, index) => `session-more-${index}`)]
    for (const id of ids) expect(storedIn(f.host, id), id).toBe(true)
    const tells = vi.spyOn(f.host as unknown as { tellObservation(): void }, 'tellObservation')
    const before = f.told.length
    f.host.observeThreads(ids)
    expect(readsInFlight(f.host).size).toBe(ids.length)
    await readsArrived(f.host)
    // Once as the window looked, with none of them, and once when the last list was in, with all of them.
    expect(tells).toHaveBeenCalledTimes(2)
    const heard = f.told.slice(before)
    expect(heard.map(call => call.ids.length)).toEqual([0, ids.length])
    for (const id of ids) expect(shown(f.host, id)!.activities?.length, id).toBe(1)
  })

  it('waits for a list on its way before closing, so what the provider published behind it is saved', async () => {
    const f = await stored([record('a', 0)])
    f.host.observeThreads([THREAD])
    f.provider.state.threads[0]!.activities = [record('c', 0)]
    f.provider.emit()
    f.host.disconnect()
    await f.host.close()
    expect(f.disk().map(item => item.id)).toEqual(['a', 'c'])
  })
})
