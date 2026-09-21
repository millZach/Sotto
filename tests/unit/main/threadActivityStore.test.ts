// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { ThreadStore } from '../../../src/main/agents/threadStore'

const stores: ThreadStore[] = []
const databases: DatabaseSync[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) db.close()
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-activity-store-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-activity-store-'))
  roots.push(root)
  const path = join(root, 'threads.sqlite')
  const store = new ThreadStore(path)
  stores.push(store)
  store.open()
  return { root, path, store }
}

function inspect(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  databases.push(db)
  return db
}

const activity = (id: string, output = 'Command output'): AgentActivity => ({
  id, turnId: 'turn', sequence: 0, kind: 'command', status: 'running', title: 'Run tests', output,
  steps: [{ text: 'Run tests', status: 'running' }],
})

async function onDisk(root: string): Promise<string> {
  return (await Promise.all((await readdir(root)).map(name => readFile(join(root, name), 'latin1')))).join(' ')
}

describe('thread activity store', () => {
  it('writes only changed activities and does no serialization or transaction for an unchanged replay', async () => {
    const { path, store } = await fixture()
    const records = [activity('a', 'x'.repeat(65_536)), activity('b')]
    store.syncActivities('thread', records, 'epoch')
    const db = inspect(path)
    db.exec(`CREATE TABLE activity_writes (id TEXT);
      CREATE TRIGGER track_activity_updates AFTER UPDATE ON activities BEGIN
        INSERT INTO activity_writes VALUES (NEW.activity_id);
      END;`)
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
    const stringify = vi.spyOn(JSON, 'stringify')
    store.syncActivities('thread', structuredClone(records), 'epoch')
    expect(exec).not.toHaveBeenCalled()
    expect(stringify).not.toHaveBeenCalled()
    records[1]!.output = 'Updated output'
    records[1]!.steps![0]!.status = 'completed'
    store.syncActivities('thread', records, 'epoch')
    expect(db.prepare('SELECT id FROM activity_writes').all().map(row => row.id)).toEqual(['b'])
    expect(store.readActivities('thread')).toEqual(records)
  })

  it('preserves authoritative order, removes absent records, and resets the epoch across restart', async () => {
    const { store } = await fixture()
    store.syncActivities('thread', [activity('a'), activity('b'), activity('c')], 'first')
    store.syncActivities('other', [activity('separate')], 'first')
    store.syncActivities('thread', [activity('c'), activity('a')], 'first')
    expect(store.readActivities('thread').map(record => record.id)).toEqual(['c', 'a'])
    store.close()
    store.open()
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
    store.syncActivities('thread', [activity('c'), activity('a')], 'first')
    expect(exec).not.toHaveBeenCalled()
    store.syncActivities('thread', [activity('a', 'Reused ID after rewind')], 'second')
    store.close()
    store.open()
    expect(store.readActivities('thread')).toEqual([activity('a', 'Reused ID after rewind')])
    expect(store.readActivities('other')).toEqual([activity('separate')])
    store.syncActivities('thread', [], 'third')
    expect(store.readActivities('thread')).toEqual([])
  })

  it('returns independent values and notices later in-place mutations of input', async () => {
    const { store } = await fixture()
    const records = [activity('a')]
    store.syncActivities('thread', records)
    const read = store.readActivities('thread')
    read[0]!.steps![0]!.text = 'Reader changed its own copy'
    expect(store.readActivities('thread')).toEqual(records)
    records[0]!.steps![0]!.text = 'Provider changed its own copy'
    store.syncActivities('thread', records)
    store.close()
    store.open()
    expect(store.readActivities('thread')).toEqual(records)
  })

  it('rolls back both rows and cached comparisons when a write fails, including an epoch reset', async () => {
    const { path, store } = await fixture()
    const original = [activity('a'), activity('b')]
    store.syncActivities('thread', original, 'first')
    const db = inspect(path)
    db.exec(`CREATE TRIGGER reject_activity BEFORE INSERT ON activities WHEN NEW.activity_id = 'c'
      BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;`)
    const replacement = [activity('a', 'Changed'), activity('c')]
    expect(() => store.syncActivities('thread', replacement, 'second')).toThrow('injected write failure')
    expect(store.readActivities('thread')).toEqual(original)
    db.exec('DROP TRIGGER reject_activity')
    store.syncActivities('thread', replacement, 'second')
    store.close()
    store.open()
    expect(store.readActivities('thread')).toEqual(replacement)
  })


  it('does not restore erased or ephemeral activity when the provider replays it after history returns', async () => {
    const { path, store } = await fixture()
    const durable = activity('durable-private-id', 'Durable private output')
    const ephemeral = activity('ephemeral-private-id', 'Ephemeral private output')
    const evicted = activity('evicted-private-id', 'Evicted ephemeral output')
    const fresh = activity('fresh-id', 'New retained output')
    store.syncActivities('thread', [durable], 'first')
    store.becomeEphemeral()
    store.syncActivities('thread', [durable, evicted, ephemeral], 'first')
    store.syncActivities('thread', [durable, ephemeral], 'first')
    store.becomeDurable()
    store.syncActivities('thread', [durable, evicted, ephemeral, fresh], 'second')
    expect(store.readActivities('thread')).toEqual([fresh])
    store.close()
    store.open()
    store.syncActivities('thread', [durable, evicted, ephemeral, fresh], 'third')
    expect(store.readActivities('thread')).toEqual([fresh])
    // An ID belonging to another thread is a different record.
    store.syncActivities('other', [durable])
    expect(store.readActivities('other')).toEqual([durable])
    const hashes = inspect(path).prepare('SELECT identity_hash FROM activity_redactions').all()
    expect(hashes).toHaveLength(3)
    expect(hashes.every(row => /^[a-f0-9]{64}$/.test(String(row.identity_hash)))).toBe(true)
  })


  it('keeps ephemeral activity suppressed after quitting while retention is off', async () => {
    const { root, path, store } = await fixture()
    store.becomeEphemeral()
    const privateActivity = activity('private-ephemeral-id', 'Never retained activity output')
    store.syncActivities('thread', [privateActivity])
    store.close()
    const disk = await onDisk(root)
    expect(disk).not.toContain('private-ephemeral-id')
    expect(disk).not.toContain('Never retained activity output')
    const restarted = new ThreadStore(path)
    stores.push(restarted)
    restarted.open()
    restarted.syncActivities('thread', [privateActivity, activity('fresh')])
    expect(restarted.readActivities('thread')).toEqual([activity('fresh')])
  })

  it('records unsaved activity identities without reading or saving their payloads', async () => {
    const { root, path, store } = await fixture()
    store.redactActivityIdentities('thread', ['unsaved-private-id'])
    store.becomeEphemeral()
    store.close()
    expect(await onDisk(root)).not.toContain('unsaved-private-id')
    const restarted = new ThreadStore(path)
    stores.push(restarted)
    restarted.open()
    restarted.syncActivities('thread', [activity('unsaved-private-id'), activity('fresh')])
    expect(restarted.readActivities('thread')).toEqual([activity('fresh')])
  })

  it('retries a failed hash-only write without accepting an unsafe ephemeral activity', async () => {
    const { path, store } = await fixture()
    store.becomeEphemeral()
    const db = inspect(path)
    db.exec(`CREATE TRIGGER reject_redaction BEFORE INSERT ON activity_redactions
      BEGIN SELECT RAISE(ABORT, 'injected redaction failure'); END;`)
    expect(() => store.syncActivities('thread', [activity('private')])).toThrow('injected redaction failure')
    expect(store.readActivities('thread')).toEqual([])
    db.exec('DROP TRIGGER reject_redaction')
    store.syncActivities('thread', [activity('private')])
    store.close()
    const restarted = new ThreadStore(path)
    stores.push(restarted)
    restarted.open()
    restarted.syncActivities('thread', [activity('private')])
    expect(restarted.readActivities('thread')).toEqual([])
  })

  it('reuses activity statements and rejects duplicate identities before writing', async () => {
    const { store } = await fixture()
    store.syncActivities('thread', [activity('a')])
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    store.syncActivities('thread', [activity('a', 'Changed')])
    store.syncActivities('thread', [activity('a', 'Changed again')])
    expect(prepare).not.toHaveBeenCalled()
    expect(() => store.syncActivities('thread', [activity('a'), activity('a')])).toThrow('Duplicate')
    expect(store.readActivities('thread')).toEqual([activity('a', 'Changed again')])
  })

  it('rejects corrupt persisted activity rather than returning an invalid record', async () => {
    const { path, store } = await fixture()
    store.syncActivities('thread', [activity('a')])
    store.close()
    inspect(path).prepare('UPDATE activities SET payload = ? WHERE thread_id = ?').run('{"id":"a"}', 'thread')
    store.open()
    expect(() => store.readActivities('thread')).toThrow()
  })

  it('erases forgotten activity from the database and WAL while keeping other threads', async () => {
    const { root, store } = await fixture()
    store.syncActivities('forgotten', [activity('a', 'Private forgotten activity words')])
    store.syncActivities('kept', [activity('b', 'Private retained activity words')])
    store.forget('forgotten')
    expect(store.readActivities('forgotten')).toEqual([])
    expect(store.readActivities('kept')).toHaveLength(1)
    expect(await onDisk(root)).not.toContain('Private forgotten activity words')
    store.redactAll()
    expect(store.readActivities('kept')).toEqual([])
    expect(await onDisk(root)).not.toContain('Private retained activity words')
    store.close()
    store.open()
    expect(store.readActivities('kept')).toEqual([])
  })

  it.each(['running', 'reopened'] as const)('physically erases durable activity when history is disabled (%s)', async mode => {
    const { root, store } = await fixture()
    store.syncActivities('thread', [activity('a', 'Durable private activity words')])
    if (mode === 'running') store.becomeEphemeral()
    else { store.close(); store.open({ ephemeral: true }) }
    expect(store.ephemeral).toBe(true)
    expect(store.readActivities('thread')).toEqual([])
    store.syncActivities('thread', [activity('b', 'Ephemeral private activity words')])
    expect(store.readActivities('thread')).toHaveLength(1)
    const saved = await onDisk(root)
    expect(saved).not.toContain('Durable private activity words')
    expect(saved).not.toContain('Ephemeral private activity words')
    store.becomeDurable()
    expect(store.readActivities('thread')).toEqual([])
  })
})
