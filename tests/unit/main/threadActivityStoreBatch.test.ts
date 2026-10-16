// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_AGENT_ACTIVITIES, type AgentActivity } from '../../../src/shared/agentActivity'
import { ThreadStore } from '../../../src/main/agents/threadStore'
import { immutableActivities } from '../../../src/main/agents/activitySnapshots'

// Counted, not replaced: the store compares records with it, and an unchanged frozen record must not be compared.
const compared = vi.hoisted(() => ({ calls: 0 }))
vi.mock('node:util', async importOriginal => {
  const original = await importOriginal<typeof import('node:util')>()
  return { ...original, isDeepStrictEqual: (left: unknown, right: unknown) => { compared.calls++; return original.isDeepStrictEqual(left, right) } }
})

const stores: ThreadStore[] = []
const databases: DatabaseSync[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-activity-batch-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-activity-batch-'))
  roots.push(root)
  const store = new ThreadStore(join(root, 'threads.sqlite'))
  stores.push(store)
  store.open()
  return store
}

/** The store's own file, opened beside it to read what is on disk. */
function inspect(): DatabaseSync {
  const db = new DatabaseSync(join(roots.at(-1)!, 'threads.sqlite'), { readOnly: true })
  databases.push(db)
  return db
}

const activity = (id: string, output = 'Command output'): AgentActivity => ({
  id, turnId: 'turn', sequence: 0, kind: 'command', status: 'running', title: 'Run tests', output,
  steps: [{ text: 'Run tests', status: 'running' }],
})
const records = (prefix: string, count: number) => immutableActivities(Array.from({ length: count }, (_, index) => activity(`${prefix}-${index}`, `Output ${index}`)))
/** A busy thread's next list, as an adapter publishes it: a new array sharing every record but the running one. */
const withLastGrown = (list: readonly AgentActivity[], text: string) => immutableActivities([...list.slice(0, -1), { ...list.at(-1)!, output: text }])

describe('saving busy threads\' activity', () => {
  // The workspace saves every visible thread's records about four times a second while threads work. Comparing every
  // record of a thread whose list changed, and one disk flush per thread, froze main for hundreds of milliseconds.
  it('compares only the record that changed when a busy thread\'s list is replaced', async () => {
    const store = await fixture()
    const first = records('work', 300)
    store.syncActivities('thread', first)
    const next = withLastGrown(first, 'Output 299, and more')
    compared.calls = 0
    store.syncActivities('thread', next)
    expect(compared.calls).toBeLessThanOrEqual(1)
    expect(store.readActivities('thread')).toEqual(next)
    // The same list again is still recognised without comparing.
    compared.calls = 0
    store.syncActivities('thread', withLastGrown(next, 'Output 299, and more'))
    expect(compared.calls).toBeLessThanOrEqual(1)
  })

  it('still compares a record that is not frozen', async () => {
    const store = await fixture()
    store.syncActivities('thread', [activity('a'), activity('b')])
    compared.calls = 0
    store.syncActivities('thread', [activity('a'), activity('b', 'Changed')])
    expect(compared.calls).toBe(2)
    expect(store.readActivities('thread').map(record => record.output)).toEqual(['Command output', 'Changed'])
  })

  it('commits several threads\' records in one transaction', async () => {
    const store = await fixture()
    const lists = ['one', 'two', 'three'].map(id => ({ threadId: id, activities: records(id, 50) }))
    store.syncActivitiesMany(lists)
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
    store.syncActivitiesMany(lists.map(entry => ({ ...entry, activities: withLastGrown(entry.activities, 'Grown') })))
    expect(exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE')).toHaveLength(1)
    for (const id of ['one', 'two', 'three']) expect(store.readActivities(id).at(-1)?.output).toBe('Grown')
  })

  // A thread at the record limit drops its oldest record with every new one. Renumbering the rest rewrote two thousand
  // rows on each save, inside the transaction main waited for.
  it('adds a record to a thread at the limit without moving the records it keeps', async () => {
    const store = await fixture()
    const full = records('work', MAX_AGENT_ACTIVITIES)
    store.syncActivities('thread', full)
    const positions = () => new Map(inspect().prepare('SELECT activity_id, position FROM activities WHERE thread_id = ?').all('thread')
      .map(row => [String(row.activity_id), Number(row.position)]))
    const before = positions()
    const slid = immutableActivities([...full.slice(1), activity('work-new', 'New output')])
    const run = vi.spyOn(StatementSync.prototype, 'run')
    store.syncActivities('thread', slid)
    expect(run.mock.calls.length).toBeLessThanOrEqual(3)
    const after = positions()
    for (const record of full.slice(1)) expect(after.get(record.id)).toBe(before.get(record.id))
    expect(after.get('work-new')).toBeGreaterThan(Math.max(...before.values()))
    expect(after.has('work-0')).toBe(false)
    expect(store.readActivities('thread').map(record => record.id)).toEqual(slid.map(record => record.id))
  })

  it('still reads records back in their new order after they are reordered', async () => {
    const store = await fixture()
    const list = records('work', 5)
    store.syncActivities('thread', list)
    const reordered = immutableActivities([list[3]!, list[0]!, activity('work-new'), list[4]!, list[1]!])
    store.syncActivities('thread', reordered)
    expect(store.readActivities('thread').map(record => record.id)).toEqual(reordered.map(record => record.id))
    store.close()
    const reopened = new ThreadStore(join(roots.at(-1)!, 'threads.sqlite')); stores.push(reopened); reopened.open()
    expect(reopened.readActivities('thread').map(record => record.id)).toEqual(reordered.map(record => record.id))
  })

  it('keeps the other threads\' records when one thread\'s list is refused, and refuses it after', async () => {
    const store = await fixture()
    const one = records('one', 10), two = records('two', 10)
    store.syncActivitiesMany([{ threadId: 'one', activities: one }, { threadId: 'two', activities: two }])
    const duplicate = immutableActivities([...two, two[0]!])
    expect(() => store.syncActivitiesMany([
      { threadId: 'one', activities: withLastGrown(one, 'Grown') },
      { threadId: 'two', activities: duplicate },
    ])).toThrow('Duplicate thread activity identity')
    expect(store.readActivities('one').at(-1)?.output).toBe('Grown')
    expect(store.readActivities('two')).toEqual(two)
  })

  it('rolls back only the thread whose write fails partway, commits the others, and saves it on the retry', async () => {
    const store = await fixture()
    const lists = ['one', 'two', 'three'].map(id => ({ threadId: id, activities: records(id, 10) }))
    store.syncActivitiesMany(lists)
    // The middle thread drops a record (a delete) and grows another (an insert); the insert fails after the delete ran.
    const next = lists.map(entry => ({ ...entry, activities: entry.threadId === 'two'
      ? immutableActivities([...withLastGrown(entry.activities, 'Grown').slice(1)]) : withLastGrown(entry.activities, 'Grown') }))
    const run = StatementSync.prototype.run
    let middle = 0
    const failing = vi.spyOn(StatementSync.prototype, 'run').mockImplementation(function (this: StatementSync, ...args: Parameters<StatementSync['run']>) {
      if (args[0] === 'two' && ++middle === 2) throw new Error('disk full')
      return run.apply(this, args)
    })
    expect(() => store.syncActivitiesMany(next)).toThrow('disk full')
    expect(middle).toBe(2)
    failing.mockRestore()
    expect(store.readActivities('one').at(-1)?.output).toBe('Grown')
    expect(store.readActivities('three').at(-1)?.output).toBe('Grown')
    expect(store.readActivities('two')).toEqual(lists[1]!.activities)
    // What is committed, read beside the store rather than from its memory: the middle thread's delete was undone.
    const committed = (threadId: string) => inspect().prepare('SELECT activity_id FROM activities WHERE thread_id = ? ORDER BY position').all(threadId).map(row => String(row.activity_id))
    expect(committed('two')).toEqual(lists[1]!.activities.map(record => record.id))
    expect(committed('one')).toEqual(next[0]!.activities.map(record => record.id))
    // The same frozen list again is written, not taken as already saved.
    store.syncActivitiesMany(next)
    expect(store.readActivities('two')).toEqual(next[1]!.activities)
    expect(committed('two')).toEqual(next[1]!.activities.map(record => record.id))
  })
})
