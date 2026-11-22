// @vitest-environment node
/**
 * Covering index `messages_thread_role_position` and off-main-thread `loadWindow()` via the store worker (#2733):
 * verifies the SQLite query plan, idempotent migration on an existing pre-v11 database, worker offload with zero
 * main-thread SQLite window reads, cancellation on unwatch, and synchronous fallback when the worker is absent or lost.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { StoreWorker } from '../../../src/main/agents/storeWorker'
import { FIRST_WINDOW_TURNS, prepareThreadDatabase, ThreadStore } from '../../../src/main/agents/threadStore'
import type { ThreadStoreWriter, WindowReadBack } from '../../../src/main/agents/threadStoreWriter'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import type { AgentMessage } from '../../../src/shared/agents'
import { heldProvidersOf } from '../../../src/shared/heldProviders'
import type { ThreadEvent } from '../../../src/shared/threadEvents'
import { deferred } from '../../fixtures/deferred'
import { builtStoreWorker } from '../../fixtures/storeWorker'
import { EventProvider, visual, windowReadsInFlight, WORKSHOP } from '../../fixtures/storeWriterEquivalence'

const AT = '2026-11-22T12:00:00.000Z'
const makeMessage = (id: string, role: AgentMessage['role'], text: string): AgentMessage => ({ id, role, text, createdAt: AT })

function seedTurns(store: ThreadStore, threadId: string, turns: number): void {
  const events: ThreadEvent[] = []
  for (let turn = 0; turn < turns; turn++) {
    events.push({ kind: 'message-added', at: AT, message: makeMessage(`u-${turn}`, 'user', `Prompt ${turn}`) })
    events.push({ kind: 'message-added', at: AT, message: makeMessage(`a-${turn}`, 'assistant', `Reply ${turn}`) })
  }
  store.appendMany(threadId, events)
}

describe('messages covering index and off-main-thread loadWindow (#2733)', () => {
  let worker: Awaited<ReturnType<typeof builtStoreWorker>>
  const roots: string[] = []
  const cleanups: Array<() => Promise<void> | void> = []

  beforeAll(async () => {
    worker = await builtStoreWorker()
  }, 120_000)

  afterAll(async () => {
    await worker?.dispose()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  async function folder(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-load-window-'))
    roots.push(dir)
    return dir
  }

  it('uses the covering index messages_thread_role_position for newest-turns and summary lookups', async () => {
    const dir = await folder()
    const store = new ThreadStore(join(dir, 'threads.sqlite'), undefined, null)
    store.open()
    cleanups.push(() => store.close())
    seedTurns(store, WORKSHOP, 25)

    const db = (store as unknown as { db: DatabaseSync }).db
    const newestTurnsPlan = db
      .prepare("EXPLAIN QUERY PLAN SELECT position FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY position DESC LIMIT ?")
      .all(WORKSHOP, FIRST_WINDOW_TURNS)
      .map(row => String(row.detail))
      .join(' | ')
    expect(newestTurnsPlan).toContain('COVERING INDEX messages_thread_role_position')

    const beforePositionPlan = db
      .prepare("EXPLAIN QUERY PLAN SELECT position FROM messages WHERE thread_id = ? AND role = 'user' AND position < ? ORDER BY position DESC LIMIT ?")
      .all(WORKSHOP, 40, FIRST_WINDOW_TURNS)
      .map(row => String(row.detail))
      .join(' | ')
    expect(beforePositionPlan).toContain('COVERING INDEX messages_thread_role_position')

    const summaryRolePlan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM messages WHERE thread_id = ? AND role = ? ORDER BY position DESC LIMIT 1')
      .all(WORKSHOP, 'user')
      .map(row => String(row.detail))
      .join(' | ')
    expect(summaryRolePlan).toContain('INDEX messages_thread_role_position')
  })

  it('migrates an existing pre-index (v10) database idempotently without losing rows', async () => {
    const dir = await folder()
    const dbPath = join(dir, 'threads.sqlite')

    // Build a database with messages and roll it back to pre-v11 (no messages_thread_role_position index).
    const initial = new ThreadStore(dbPath, undefined, null)
    initial.open()
    seedTurns(initial, WORKSHOP, 15)
    initial.close()

    const preIndex = new DatabaseSync(dbPath)
    preIndex.exec('DROP INDEX messages_thread_role_position; DELETE FROM schema_migrations WHERE version = 11;')
    const beforePlan = preIndex
      .prepare("EXPLAIN QUERY PLAN SELECT position FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY position DESC LIMIT ?")
      .all(WORKSHOP, FIRST_WINDOW_TURNS)
      .map(row => String(row.detail))
      .join(' | ')
    expect(beforePlan).not.toContain('messages_thread_role_position')
    preIndex.close()

    // Reopening applies migration 11 cleanly and preserves all existing messages.
    const migrated = new ThreadStore(dbPath, undefined, null)
    migrated.open()
    cleanups.push(() => migrated.close())
    const db = (migrated as unknown as { db: DatabaseSync }).db
    expect(db.prepare('SELECT version FROM schema_migrations WHERE version = 11').get()).toEqual({ version: 11 })
    const afterPlan = db
      .prepare("EXPLAIN QUERY PLAN SELECT position FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY position DESC LIMIT ?")
      .all(WORKSHOP, FIRST_WINDOW_TURNS)
      .map(row => String(row.detail))
      .join(' | ')
    expect(afterPlan).toContain('COVERING INDEX messages_thread_role_position')

    // Re-running prepareThreadDatabase is safe and idempotent.
    expect(() => prepareThreadDatabase(db)).not.toThrow()
    const window = migrated.readMessages(WORKSHOP, { turns: FIRST_WINDOW_TURNS })
    expect(window.messages).toHaveLength(FIRST_WINDOW_TURNS * 2)
    expect(window.earlierAvailable).toBe(true)
    expect(window.messages[0]?.id).toBe('u-5')
    expect(window.messages.at(-1)?.id).toBe('a-14')
  })

  it('loads pane windows and Show earlier messages on the store worker without reading SQLite on main, and falls back if the worker dies', async () => {
    const dir = await folder()
    const dbPath = join(dir, 'threads.sqlite')

    // Pre-populate store with 25 turns, a wake-up mark, and a visual anchored to the newest turn.
    const seeded = new ThreadStore(dbPath, undefined, null)
    seeded.open()
    seedTurns(seeded, WORKSHOP, 25)
    seeded.addWakeUp(WORKSHOP, 'u-24')
    seeded.addVisual(WORKSHOP, {
      visual: { id: 'vis-1', ...visual('Architecture flow') },
      createdAt: AT,
      anchorMessageId: 'a-24',
      anchorUserMessageId: 'u-24',
    })
    seeded.close()

    const adapter = new EventProvider()
    const project = join(dir, 'project')
    await mkdir(project)
    adapter.state.projects[0]!.path = project
    const host = new WorkspaceHost(adapter, dir, {
      historyEnabled: () => true,
      watcherEnabled: false,
      heldProviders: heldProvidersOf({ muse: false }),
      streamingPublishCostEnabled: true,
      storeWorker: { path: worker.path },
    })
    cleanups.push(async () => { host.disconnect(); await host.close().catch(() => undefined) })
    await host.initialize()
    await host.connect()
    host.observeThreads([])

    const readMessagesOnMain = vi.spyOn(ThreadStore.prototype, 'readMessages')
    const readVisualsOnMain = vi.spyOn(ThreadStore.prototype, 'readVisuals')
    const wakeUpsOnMain = vi.spyOn(ThreadStore.prototype, 'wakeUps')
    const summaryMessagesOnMain = vi.spyOn(ThreadStore.prototype, 'summaryMessages')

    host.observeThreads([WORKSHOP])
    // While the worker read is in flight, main executed zero SQLite window reads and marks the cold thread loading.
    expect(readMessagesOnMain).not.toHaveBeenCalled()
    expect(readVisualsOnMain).not.toHaveBeenCalled()
    expect(wakeUpsOnMain).not.toHaveBeenCalled()
    expect(summaryMessagesOnMain).not.toHaveBeenCalled()

    await vi.waitFor(() => {
      const thread = host.workspaceSnapshot().threads.find(item => item.id === WORKSHOP)!
      expect(thread.messages.length).toBe(FIRST_WINDOW_TURNS * 2 + 1)
      expect(thread.historyStatus).toBeUndefined()
    })

    const loaded = host.workspaceSnapshot().threads.find(item => item.id === WORKSHOP)!
    expect(loaded.earlierAvailable).toBe(true)
    expect(loaded.messages.some(item => item.id === 'u-24' && item.wakeUp === true)).toBe(true)
    expect(loaded.messages.some(item => item.visual?.id === 'vis-1')).toBe(true)
    expect(loaded.summary?.messageCount).toBe(50)
    expect(readMessagesOnMain).not.toHaveBeenCalled()
    expect(readVisualsOnMain).not.toHaveBeenCalled()
    expect(wakeUpsOnMain).not.toHaveBeenCalled()
    expect(summaryMessagesOnMain).not.toHaveBeenCalled()

    // Show earlier messages also reads on the worker without hitting main's SQLite connection.
    const widened = await host.loadEarlierMessages(WORKSHOP)
    const widenedThread = widened.threads.find(item => item.id === WORKSHOP)!
    expect(widenedThread.messages.length).toBe(50 + 1)
    expect(widenedThread.earlierAvailable).toBeUndefined()
    expect(readMessagesOnMain).not.toHaveBeenCalled()

    // Unwatching while an off-main read is in flight cancels cleanly, keeps the existing summary, and leaves no stuck loading state.
    host.observeThreads([])
    host.observeThreads([WORKSHOP])
    const pending = windowReadsInFlight(host).get(WORKSHOP)
    expect(pending).toBeDefined()
    host.observeThreads([])
    await pending!.done
    const unwatched = host.workspaceSnapshot().threads.find(item => item.id === WORKSHOP)!
    expect(unwatched.messages).toEqual([])
    expect(unwatched.historyStatus).toBeUndefined()
    expect(unwatched.summary?.messageCount).toBe(50)

    // If the worker terminates, observing falls back to reading synchronously on main.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = (host as unknown as { threadStore: { readonly worker: StoreWorker | undefined } }).threadStore
    void store.worker!.terminate()
    await vi.waitFor(() => expect(store.worker).toBeUndefined())

    host.observeThreads([WORKSHOP])
    const fallback = host.workspaceSnapshot().threads.find(item => item.id === WORKSHOP)!
    expect(fallback.messages.length).toBe(FIRST_WINDOW_TURNS * 2 + 1)
    expect(fallback.earlierAvailable).toBe(true)
    expect(readMessagesOnMain).toHaveBeenCalled()
  })

  it('preserves synchronous loadWindow() fallback when the store worker is disabled', async () => {
    const dir = await folder()
    const dbPath = join(dir, 'threads.sqlite')
    const seeded = new ThreadStore(dbPath, undefined, null)
    seeded.open()
    seedTurns(seeded, WORKSHOP, 15)
    seeded.close()

    const adapter = new EventProvider()
    const project = join(dir, 'project')
    await mkdir(project)
    adapter.state.projects[0]!.path = project
    const host = new WorkspaceHost(adapter, dir, {
      historyEnabled: () => true,
      watcherEnabled: false,
      heldProviders: heldProvidersOf({ muse: false }),
      streamingPublishCostEnabled: true,
      storeWorker: null,
    })
    cleanups.push(async () => { host.disconnect(); await host.close().catch(() => undefined) })
    await host.initialize()
    await host.connect()
    host.observeThreads([])

    // Synchronous load: messages are populated immediately on return from observeThreads.
    host.observeThreads([WORKSHOP])
    const thread = host.workspaceSnapshot().threads.find(item => item.id === WORKSHOP)!
    expect(thread.messages).toHaveLength(FIRST_WINDOW_TURNS * 2)
    expect(thread.earlierAvailable).toBe(true)
  })

  it('ignores a stale worker window answer when an event is written and confirmed while the read is in flight', async () => {
    const dir = await folder()
    const dbPath = join(dir, 'threads.sqlite')
    const seeded = new ThreadStore(dbPath, undefined, null)
    seeded.open()
    seeded.appendMany(WORKSHOP, [
      { kind: 'message-added', at: AT, message: makeMessage('u-0', 'user', 'Prompt 0') },
      { kind: 'message-added', at: AT, message: makeMessage('a-0', 'assistant', 'Initial reply') },
    ])
    seeded.close()

    const adapter = new EventProvider()
    const project = join(dir, 'project')
    await mkdir(project)
    adapter.state.projects[0]!.path = project
    const host = new WorkspaceHost(adapter, dir, {
      historyEnabled: () => true,
      watcherEnabled: false,
      heldProviders: heldProvidersOf({ muse: false }),
      streamingPublishCostEnabled: true,
      storeWorker: { path: worker.path },
    })
    cleanups.push(async () => { host.disconnect(); await host.close().catch(() => undefined) })
    await host.initialize()
    await host.connect()
    host.observeThreads([])

    const writes = (host as unknown as { writes: ThreadStoreWriter }).writes
    const originalReadWindow = writes.readWindow!.bind(writes)
    const gate = deferred<void>()
    let staleAnswer: WindowReadBack | undefined
    vi.spyOn(writes, 'readWindow').mockImplementationOnce((threadId, turns) => {
      const real = originalReadWindow(threadId, turns)!
      return real.then(async result => {
        staleAnswer = result
        await gate.promise
        return result
      })
    })

    host.observeThreads([WORKSHOP])
    const pending = windowReadsInFlight(host).get(WORKSHOP)
    expect(pending).toBeDefined()
    await vi.waitFor(() => expect(staleAnswer).toBeDefined())

    // Write and confirm a replacement event while the worker window read is still held open (so heldEvents is empty on arrival).
    adapter.publish({ kind: 'message-replaced', at: AT, message: makeMessage('a-0', 'assistant', 'Replaced reply') })
    await host.flush()
    await writes.confirmed(WORKSHOP)

    gate.resolve()
    await pending!.done

    expect(host.threadMessages(WORKSHOP).find(item => item.id === 'a-0')?.text).toBe('Replaced reply')
    const shown = host.workspaceSnapshot().threads.find(item => item.id === WORKSHOP)!
    expect(shown.messages.find(item => item.id === 'a-0')?.text).toBe('Replaced reply')
  })

  it('never persists temporary loading historyStatus to workspace.json or leaves it stuck after close mid-read', async () => {
    const dir = await folder()
    const dbPath = join(dir, 'threads.sqlite')
    const seeded = new ThreadStore(dbPath, undefined, null)
    seeded.open()
    seedTurns(seeded, WORKSHOP, 15)
    seeded.close()

    const adapter = new EventProvider()
    const project = join(dir, 'project')
    await mkdir(project)
    adapter.state.projects[0]!.path = project
    const host = new WorkspaceHost(adapter, dir, {
      historyEnabled: () => true,
      watcherEnabled: false,
      heldProviders: heldProvidersOf({ muse: false }),
      streamingPublishCostEnabled: true,
      storeWorker: { path: worker.path },
    })
    await host.initialize()
    await host.connect()
    host.observeThreads([])

    const writes = (host as unknown as { writes: ThreadStoreWriter }).writes
    const gate = deferred<WindowReadBack>()
    vi.spyOn(writes, 'readWindow').mockImplementationOnce(() => gate.promise)

    host.observeThreads([WORKSHOP])
    expect(windowReadsInFlight(host).has(WORKSHOP)).toBe(true)
    expect(host.workspaceSnapshot().threads.find(item => item.id === WORKSHOP)?.historyStatus).toBe('loading')

    // Flushing while the off-main window read is in flight must not write temporary 'loading' to workspace.json.
    await host.flush()
    const duringRead = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')) as { snapshot: { threads: Array<{ id: string; historyStatus?: string }> } }
    expect(duringRead.snapshot.threads.find(item => item.id === WORKSHOP)?.historyStatus).toBeUndefined()

    // Closing mid-read must clear temporary 'loading' and never persist it to workspace.json.
    host.disconnect()
    await host.close()
    gate.resolve({ lost: true })
    const afterClose = JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')) as { snapshot: { threads: Array<{ id: string; historyStatus?: string }> } }
    expect(afterClose.snapshot.threads.find(item => item.id === WORKSHOP)?.historyStatus).toBeUndefined()

    // Reopening when the provider no longer lists the thread must not show a stuck 'loading' status.
    const silentAdapter = new EventProvider()
    silentAdapter.state.projects[0]!.path = project
    silentAdapter.state.threads = []
    const reopened = new WorkspaceHost(silentAdapter, dir, {
      historyEnabled: () => true,
      watcherEnabled: false,
      heldProviders: heldProvidersOf({ muse: false }),
      streamingPublishCostEnabled: true,
      storeWorker: null,
    })
    cleanups.push(async () => { reopened.disconnect(); await reopened.close().catch(() => undefined) })
    await reopened.initialize()
    await reopened.connect()
    expect(reopened.workspaceSnapshot().threads.find(item => item.id === WORKSHOP)?.historyStatus).toBeUndefined()
  })
})
