// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { SubagentStore } from '../../../src/main/agents/subagentStore'
import { ThreadStore } from '../../../src/main/agents/threadStore'
import { WorkspaceHost } from '../../../src/main/agents/workspace'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'
import { CertifyingProviderHost } from '../../fixtures/certifyingProviderHost'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentHostSnapshot } from '../../../src/shared/agents'

// A thread nobody has open keeps its activity records in the thread store, not in memory (#918).

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

const THREAD = 'session-workshop'

function record(id: string, sequence: number, extra: Partial<AgentActivity> = {}): AgentActivity {
  return { id, turnId: 'turn', sequence, kind: 'tool', status: 'completed', title: 'Tool', output: `Output ${id}`, ...extra }
}

/** A workspace whose first run saved `saved` for the workshop thread, reopened with a provider that has not read it. */
async function stored(saved: AgentActivity[], history: () => boolean = () => true, provider: FakeProviderHost = new FakeProviderHost()) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-stored-activity-'))
  cleanup.push(async () => {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-stored-activity-')) throw new Error('Unexpected test directory')
    await rm(directory, { recursive: true, force: true })
  })
  provider.state.threads[0]!.activities = structuredClone(saved)
  const closed = new Set<WorkspaceHost>()
  // A privacy pass with the setting unchanged ends in a save, as quitting does.
  const close = async (host: WorkspaceHost) => {
    if (closed.has(host)) return
    closed.add(host)
    host.disconnect(); await host.privacyChanged().catch(() => undefined); host.dispose()
  }
  const open = async () => {
    const host = new WorkspaceHost(provider, directory, history)
    cleanup.push(() => close(host))
    await host.initialize()
    return host
  }
  const first = await open()
  await first.connect()
  await close(first)
  delete provider.state.threads[0]!.activities
  const disk = () => {
    const store = new ThreadStore(join(directory, 'threads.sqlite'))
    store.open()
    try { return store.readActivities(THREAD) } finally { store.close() }
  }
  return { directory, provider, open, close, disk }
}
const workshop = (host: WorkspaceHost) => host.workspaceSnapshot().threads.find(thread => thread.id === THREAD)!
/** The last snapshot the workspace published, which is what the coordinator holds. */
function published(host: WorkspaceHost) {
  let last: AgentHostSnapshot | undefined
  host.subscribe(snapshot => { last = snapshot })
  return () => last?.threads.find(thread => thread.id === THREAD)
}

it('reads no saved record at start, and counts them from the store', async () => {
  const f = await stored([record('a', 0), record('b', 1)])
  const read = vi.spyOn(ThreadStore.prototype, 'readActivities')
  const host = await f.open()
  await host.connect()
  expect(read).not.toHaveBeenCalled()
  expect(workshop(host).activities).toBeUndefined()
  expect(workshop(host).summary?.activityCount).toBe(2)
})

it('reads every record once on a profile whose store has not said subagent words moved, and none after', async () => {
  const f = await stored([record('a', 0)])
  const db = new DatabaseSync(join(f.directory, 'threads.sqlite'))
  try { db.prepare("DELETE FROM meta WHERE key = 'subagentWordsMoved'").run() } finally { db.close() }
  const read = vi.spyOn(ThreadStore.prototype, 'readActivities')
  const first = await f.open()
  expect(read).toHaveBeenCalledWith(THREAD)
  expect(workshop(first).activities?.map(item => item.id)).toEqual(['a'])
  await f.close(first)
  read.mockClear()
  const second = await f.open()
  expect(read).not.toHaveBeenCalled()
  expect(workshop(second).activities).toBeUndefined()
})

it('puts the roster on the disk before it marks subagent words moved, so a power cut cannot lose their only copy', async () => {
  const f = await stored([record('a', 0)])
  const db = new DatabaseSync(join(f.directory, 'threads.sqlite'))
  try { db.prepare("DELETE FROM meta WHERE key = 'subagentWordsMoved'").run() } finally { db.close() }
  const flushed = vi.spyOn(SubagentStore.prototype, 'flushToDisk'), marked = vi.spyOn(ThreadStore.prototype, 'markSubagentWordsMoved')
  const host = await f.open()
  await f.close(host)
  expect(marked).toHaveBeenCalled()
  expect(flushed).toHaveBeenCalled()
  expect(flushed.mock.invocationCallOrder[0]).toBeLessThan(marked.mock.invocationCallOrder[0]!)
})

// The start that moved every thread's subagent words to the roster reads only the threads it shows, so a Watcher thread
// hidden then still has its words in its rows when it is first read back.
it('moves subagent words still in a thread\'s rows to the roster when it reads them back, before saving them away', async () => {
  const f = await stored([record('a', 0)])
  const spawn: AgentActivity = { id: 'spawn', turnId: 'turn', sequence: 1, kind: 'subagent', status: 'completed', title: 'Private task title',
    agents: [{ id: 'child', assignmentId: 'task', status: 'completed', title: 'Private task title', prompt: 'Private moved task', message: 'Private moved result' }] }
  const store = new ThreadStore(join(f.directory, 'threads.sqlite'))
  store.open()
  try { store.syncActivities(THREAD, [record('a', 0), spawn]) } finally { store.close() }
  const host = await f.open()
  await host.connect()
  const flushed = vi.spyOn(SubagentStore.prototype, 'flushToDisk')
  host.observeThreads([THREAD])
  expect((await host.subagentAssignments({ threadId: THREAD, agentId: 'child' })).assignments[0]).toMatchObject({ prompt: 'Private moved task', result: 'Private moved result' })
  await f.close(host)
  // The roster held the words' only copy once the save stripped them, so it reached the disk first.
  expect(flushed).toHaveBeenCalled()
  expect(f.disk().find(item => item.id === 'spawn')).toMatchObject({ title: 'Subagent' })
  expect(JSON.stringify(f.disk())).not.toContain('Private')
})

const DOCS = 'session-docs'
const privateSpawn = (): AgentActivity => ({ id: 'spawn', turnId: 'turn', sequence: 1, kind: 'subagent', status: 'completed', title: 'Private task title',
  agents: [{ id: 'child', assignmentId: 'task', status: 'completed', title: 'Private task title', prompt: 'Private moved task', message: 'Private moved result' }] })
function seed(directory: string, threadId: string, activities: AgentActivity[]) {
  const store = new ThreadStore(join(directory, 'threads.sqlite'))
  store.open()
  try { store.syncActivities(threadId, activities) } finally { store.close() }
}
function diskOf(directory: string, threadId: string) {
  const store = new ThreadStore(join(directory, 'threads.sqlite'))
  store.open()
  try { return store.readActivities(threadId) } finally { store.close() }
}

// A save that cannot put the roster on the disk still saves every held list, words and all, so a thread let go after
// it is in the store as this run showed it.
it('saves a changed thread before letting it go while the roster cannot reach the disk', async () => {
  const f = await stored([record('a', 0)])
  seed(f.directory, DOCS, [privateSpawn()])
  const host = await f.open()
  await host.connect()
  vi.spyOn(SubagentStore.prototype, 'flushToDisk').mockImplementation(() => { throw new Error('Synthetic roster flush failure') })
  host.observeThreads([THREAD, DOCS])
  f.provider.state.threads[0]!.activities = [record('a', 0, { output: 'Changed output' })]
  await host.snapshot()
  host.observeThreads([DOCS])
  await host.snapshot()
  await f.close(host)
  expect(f.disk().map(item => item.output)).toEqual(['Changed output'])
  // The roster may lack the words, so the record keeps them.
  expect(diskOf(f.directory, DOCS).find(item => item.id === 'spawn')).toMatchObject({ title: 'Private task title' })
})

it('keeps saving activity, words and all, and keeps the warning, once the roster cannot take moved task words', async () => {
  const f = await stored([record('a', 0)])
  seed(f.directory, THREAD, [record('a', 0), privateSpawn()])
  const host = await f.open()
  await host.connect()
  vi.spyOn(SubagentStore.prototype, 'ingest').mockImplementation(() => { throw new Error('Synthetic roster write failure') })
  host.observeThreads([THREAD])
  f.provider.state.threads[0]!.activities = [record('c', 2)]
  await host.snapshot()
  expect(host.workspaceSnapshot().error).toBe('Agent history could not be saved. Thread activity keeps its task words, so nothing was lost. Restore access to local storage and restart Sotto.')
  await f.close(host)
  expect(f.disk().map(item => item.id)).toEqual(['a', 'spawn', 'c'])
  expect(f.disk().find(item => item.id === 'spawn')).toMatchObject({ title: 'Private task title' })
})

it('says it holds nothing once a read of the store fails, and says why', async () => {
  const f = await stored([record('a', 0)])
  const host = await f.open()
  await host.connect()
  expect(host.hasActivities(THREAD, undefined)).toBe(true)
  vi.spyOn(ThreadStore.prototype, 'readActivities').mockImplementationOnce(() => { throw new Error('Synthetic unreadable store') })
  expect(host.activities(THREAD, undefined)).toBeUndefined()
  expect(host.hasActivities(THREAD, undefined)).toBe(false)
  expect(host.workspaceSnapshot().error).toBe('Thread activity could not be read. Saved activity remains available. Restore local storage and restart Sotto.')
})

it('reads a thread\'s records back when a window looks at it, a saved running record no longer live', async () => {
  const f = await stored([record('a', 0), record('b', 1, { status: 'running' })])
  const host = await f.open()
  await host.connect()
  host.observeThreads([THREAD])
  expect(workshop(host).activities?.map(item => [item.id, item.status])).toEqual([['a', 'completed'], ['b', 'unknown']])
  expect(workshop(host).summary?.activityCount).toBe(2)
})

it('lets the records go once saved after the window stops looking, and keeps them in the store', async () => {
  const f = await stored([record('a', 0), record('b', 1)])
  const host = await f.open()
  await host.connect()
  host.observeThreads([THREAD])
  f.provider.state.threads[0]!.activities = [record('c', 0)]
  await host.snapshot()
  expect(workshop(host).activities?.map(item => item.id)).toEqual(['a', 'b', 'c'])
  host.observeThreads([])
  await host.snapshot()
  expect(workshop(host).activities).toBeUndefined()
  expect(workshop(host).summary?.activityCount).toBe(3)
  await f.close(host)
  expect(f.disk().map(item => item.id)).toEqual(['a', 'b', 'c'])
})

it('lets the records go when the window stops looking even when nothing else changed, and says so to the coordinator', async () => {
  const f = await stored([record('a', 0)])
  const host = await f.open()
  await host.connect()
  host.observeThreads([THREAD])
  await host.snapshot()
  expect(workshop(host).activities?.map(item => item.id)).toEqual(['a'])
  const last = published(host)
  host.observeThreads([])
  await vi.waitFor(() => expect(workshop(host).activities).toBeUndefined())
  await vi.waitFor(() => expect(last()?.activities).toBeUndefined())
  expect(last()?.summary?.activityCount).toBe(1)
})

it('leaves a stored thread stored while its provider publishes the same certified list, and reads it back when that changes', async () => {
  const provider = new CertifyingProviderHost()
  const f = await stored([record('a', 0)], () => true, provider)
  const host = await f.open()
  await host.connect()
  provider.state.threads[0]!.activities = [record('b', 0)]
  provider.emitActivity()
  await vi.waitFor(() => expect(workshop(host).activities?.map(item => item.id)).toEqual(['a', 'b']))
  host.observeThreads([])
  await vi.waitFor(() => expect(workshop(host).activities).toBeUndefined())
  const read = vi.spyOn(ThreadStore.prototype, 'readActivities')
  provider.emitActivity()
  provider.emitActivity()
  expect(read).not.toHaveBeenCalled()
  expect(workshop(host).activities).toBeUndefined()
  provider.state.threads[0]!.activities = [...provider.state.threads[0]!.activities!, record('c', 1)]
  provider.emitActivity()
  await vi.waitFor(() => expect(workshop(host).activities?.map(item => item.id)).toEqual(['a', 'b', 'c']))
  expect(read).toHaveBeenCalledTimes(1)
})

it('keeps a running thread\'s records in memory after the window stops looking', async () => {
  const f = await stored([record('a', 0)])
  const host = await f.open()
  await host.connect()
  host.observeThreads([THREAD])
  f.provider.state.threads[0]!.activities = [record('live', 1, { status: 'running' })]
  await host.snapshot()
  host.observeThreads([])
  await host.snapshot()
  expect(workshop(host).activities?.map(item => item.id)).toEqual(['a', 'live'])
})

it.each([
  ['no list', undefined],
  ['an empty list', []],
])('never removes stored records when the provider publishes %s for the thread', async (_name, published) => {
  const f = await stored([record('a', 0), record('b', 1)])
  const host = await f.open()
  await host.connect()
  f.provider.state.threads[0]!.activities = published
  f.provider.emit()
  await host.snapshot()
  expect(workshop(host).activities).toBeUndefined()
  await f.close(host)
  expect(f.disk().map(item => item.id)).toEqual(['a', 'b'])
})

it('merges a changed record onto the stored list, keeping its place, anchor and finished state', async () => {
  const f = await stored([record('a', 0, { afterMessageId: 'message-1' }), record('b', 1)])
  const host = await f.open()
  await host.connect()
  f.provider.state.threads[0]!.activities = [record('b', 9, { output: 'Changed' }), record('a', 4, { status: 'running' })]
  await host.snapshot()
  const merged = workshop(host).activities!
  expect(merged.map(item => [item.id, item.sequence, item.status, item.output])).toEqual([['a', 0, 'completed', 'Output a'], ['b', 1, 'completed', 'Changed']])
  expect(merged[0]!.afterMessageId).toBe('message-1')
  await f.close(host)
  expect(f.disk().map(item => item.output)).toEqual(['Output a', 'Changed'])
})

it('takes a new history epoch\'s list as the whole list', async () => {
  const f = await stored([record('a', 0)])
  const host = await f.open()
  await host.connect()
  f.provider.state.threads[0]!.historyEpoch = 'rewound'
  f.provider.state.threads[0]!.activities = [record('z', 0)]
  await host.snapshot()
  expect(workshop(host).activities?.map(item => item.id)).toEqual(['z'])
  await f.close(host)
  expect(f.disk().map(item => item.id)).toEqual(['z'])
})

it('clears a stored thread\'s records when its history epoch changes with no list', async () => {
  const f = await stored([record('a', 0)])
  const host = await f.open()
  await host.connect()
  f.provider.state.threads[0]!.historyEpoch = 'rewound'
  await host.snapshot()
  expect(workshop(host).activities).toEqual([])
  expect(host.hasActivities(THREAD, undefined)).toBe(false)
  await f.close(host)
  expect(f.disk()).toEqual([])
})

it('keeps a thread in memory while a subagent record has words the store does not keep', async () => {
  const f = await stored([record('a', 0)])
  const host = await f.open()
  await host.connect()
  host.observeThreads([THREAD])
  f.provider.state.threads[0]!.activities = [record('task', 1, { kind: 'subagent', title: 'Review the parser' })]
  await host.snapshot()
  host.observeThreads([])
  await host.snapshot()
  expect(workshop(host).activities?.find(item => item.id === 'task')?.title).toBe('Review the parser')
  expect(f.disk().find(item => item.id === 'task')?.title).toBe('Subagent')
})

it('hands an adapter a stored thread\'s records without keeping them', async () => {
  const f = await stored([record('a', 0), record('b', 1, { status: 'running' })])
  const host = await f.open()
  await host.connect()
  expect(host.hasActivities(THREAD, undefined)).toBe(true)
  expect(host.hasActivities(THREAD, 'another epoch')).toBe(false)
  const read = vi.spyOn(ThreadStore.prototype, 'readActivities')
  expect(host.activities(THREAD, undefined)?.map(item => [item.id, item.status])).toEqual([['a', 'completed'], ['b', 'unknown']])
  expect(read).toHaveBeenCalledWith(THREAD, { keep: false })
  expect(workshop(host).activities).toBeUndefined()
})

it('drops a stored thread\'s activity for this run when Keep local history is turned off, as its messages', async () => {
  let history = true
  const f = await stored([record('a', 0)], () => history)
  const host = await f.open()
  await host.connect()
  const last = published(host)
  history = false
  await host.privacyChanged()
  // The coordinator is told, so the sidebar's count drops with the records.
  expect(last()?.summary?.activityCount).toBe(0)
  host.observeThreads([THREAD])
  expect(workshop(host).activities ?? []).toEqual([])
  expect(workshop(host).summary?.activityCount).toBe(0)
  // The record's identity was suppressed with the rest, so turning history back on does not save it again.
  history = true
  await host.privacyChanged()
  f.provider.state.threads[0]!.activities = [record('a', 0), record('fresh', 1)]
  await host.snapshot()
  await f.close(host)
  expect(f.disk().map(item => item.id)).toEqual(['fresh'])
})
