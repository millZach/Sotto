// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentStore } from '../../../src/main/agents/subagentStore'
import { ThreadStore, type StoredVisual } from '../../../src/main/agents/threadStore'
import { UsageStore } from '../../../src/main/agents/usageStore'
import type { AgentMessage } from '../../../src/shared/agents'
import type { UsageTokenObservation } from '../../../src/shared/usageDashboard'

/**
 * The history stores save without waiting for the disk, and wait for it when the user takes something out
 * (ADR-0016, October 19, 2026 amendment). SQLite's `synchronous` setting belongs to the connection, so these
 * tests read it on each store's own connection, and at every COMMIT, which is where it decides whether to flush.
 */
const NORMAL = 1
const FULL = 2

const roots: string[] = []
const closers: (() => void)[] = []
let commits: number[] = []
/** SQLite's own exec, read before any spy replaces it: a stand-in that called the spy would call itself. */
const realExec = DatabaseSync.prototype.exec

beforeEach(() => {
  commits = []
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.trim() === 'COMMIT') commits.push(synchronous(this))
    return realExec.call(this, sql)
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closers.splice(0)) close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-durability-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

function synchronous(db: DatabaseSync, schema = 'main'): number {
  return Number(db.prepare(`PRAGMA ${schema}.synchronous`).get()?.synchronous)
}
/** The store's own connection: `synchronous` cannot be read from another one. */
function connection(store: ThreadStore | UsageStore | SubagentStore): DatabaseSync {
  const db = (store as unknown as { db: DatabaseSync | undefined }).db
  if (db === undefined) throw new Error('The store is not open')
  return db
}
async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-durability-'))
  roots.push(root)
  return root
}
/** What `work` committed, at the setting each COMMIT ran with. */
function committed(work: () => void): number[] {
  commits = []
  work()
  return commits
}

const at = '2026-10-19T10:00:00.000Z'
const message = (id: string, text: string): AgentMessage => ({ id, role: 'user', text, createdAt: at })

describe('thread history durability', () => {
  async function threads() {
    const store = new ThreadStore(join(await folder(), 'threads.sqlite'))
    store.open()
    closers.push(() => store.close())
    return store
  }

  it('saves at NORMAL with WAL, secure_delete and foreign keys kept', async () => {
    const store = await threads()
    const db = connection(store)
    expect(synchronous(db)).toBe(NORMAL)
    expect(String(db.prepare('PRAGMA journal_mode').get()?.journal_mode)).toBe('wal')
    expect(Number(db.prepare('PRAGMA secure_delete').get()?.secure_delete)).toBe(1)
    expect(Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)).toBe(1)
    expect(committed(() => store.append('thread', { kind: 'message-added', at, message: message('m1', 'Hello') }))).toEqual([NORMAL])
  })

  it('waits for the disk when a thread is forgotten, then saves at NORMAL again', async () => {
    const store = await threads()
    store.append('thread', { kind: 'message-added', at, message: message('m1', 'Private words') })
    const forgetting = committed(() => store.forget('thread'))
    expect(forgetting.length).toBeGreaterThan(0)
    expect(forgetting.every(setting => setting === FULL)).toBe(true)
    expect(synchronous(connection(store))).toBe(NORMAL)
  })

  it('waits for the disk when Keep local history turns off and everything is redacted', async () => {
    const store = await threads()
    store.append('thread', { kind: 'message-added', at, message: message('m1', 'Private words') })
    const redacting = committed(() => store.redactAll())
    expect(redacting.length).toBeGreaterThan(0)
    expect(redacting.every(setting => setting === FULL)).toBe(true)
    expect(synchronous(connection(store))).toBe(NORMAL)
  })

  it('waits for the disk for a redacted activity identity and for a rewind', async () => {
    const store = await threads()
    expect(committed(() => store.redactActivityIdentities('thread', ['activity-1']))).toEqual([FULL])
    store.append('thread', { kind: 'message-added', at, message: message('m1', 'Kept') })
    store.append('thread', { kind: 'message-added', at, message: message('m2', 'Rewound') })
    const rewinding = committed(() => store.replaceThreadMessages('thread', [message('m1', 'Kept')]))
    expect(rewinding.length).toBeGreaterThan(0)
    expect(rewinding.every(setting => setting === FULL)).toBe(true)
    expect(synchronous(connection(store))).toBe(NORMAL)
  })

  it('waits for the disk for any reset, as a rewind writes one, in one thread or a window of several', async () => {
    const store = await threads()
    store.append('thread', { kind: 'message-added', at, message: message('m1', 'Kept') })
    store.append('thread', { kind: 'message-added', at, message: message('m2', 'Rewound') })
    // A rewind the provider confirmed resets the thread's messages through the ordinary append, not replaceThreadMessages.
    expect(committed(() => store.appendMany('thread', [{ kind: 'messages-reset', at }, { kind: 'message-added', at, message: message('m1', 'Kept') }]))).toEqual([FULL])
    expect(committed(() => store.appendBatches(new Map([
      ['thread', [{ kind: 'message-added', at, message: message('m3', 'Streamed') }]],
      ['other', [{ kind: 'messages-reset', at }]],
    ])))).toEqual([FULL])
    // A window with no reset in it saves without waiting.
    expect(committed(() => store.appendBatches(new Map([['thread', [{ kind: 'message-added', at, message: message('m4', 'Streamed') }]]])))).toEqual([NORMAL])
    expect(synchronous(connection(store))).toBe(NORMAL)
  })

  it('waits for the disk when a rewind takes out its turns\' visuals', async () => {
    const store = await threads()
    const drawn = (id: string, anchorUserMessageId: string): StoredVisual => ({
      visual: { id, title: 'Synthetic visual', kind: 'diagram', source: 'flowchart LR\n  A --> B', steps: [{ text: 'A goes to B', highlight: ['A->B'] }] },
      createdAt: at, anchorMessageId: null, anchorUserMessageId,
    })
    store.addVisual('thread', drawn('v1', 'u1'))
    expect(committed(() => store.deleteVisualsForTurns('thread', ['u1']))).toEqual([FULL])
    expect(synchronous(connection(store))).toBe(NORMAL)
  })

  it('goes back to NORMAL when a flushed deletion fails', async () => {
    const store = await threads()
    store.append('thread', { kind: 'message-added', at, message: message('m1', 'Private words') })
    vi.mocked(DatabaseSync.prototype.exec).mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'VACUUM') throw new Error('Synthetic vacuum failure')
      return realExec.call(this, sql)
    })
    expect(() => store.forget('thread')).toThrow('Synthetic vacuum failure')
    expect(synchronous(connection(store))).toBe(NORMAL)
  })
})

describe('usage history durability', () => {
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
  const token: UsageTokenObservation = {
    providerId: 'claude', threadId: 'thread-1', recordKey: hash('request-1'), groupKey: hash('turn-1'), modelId: 'observed-sonnet',
    tokens: { input: 100, output: 20, cached: 40, cacheWrite: 10, cacheWrite5m: 10, cacheWrite1h: 0 },
    at, phase: 'live', partial: false,
  }

  it('saves at NORMAL and waits for the disk when usage is cleared', async () => {
    const store = new UsageStore(join(await folder(), 'usage.sqlite'), () => at)
    store.open()
    closers.push(() => store.close())
    const db = connection(store)
    expect(synchronous(db)).toBe(NORMAL)
    expect(Number(db.prepare('PRAGMA secure_delete').get()?.secure_delete)).toBe(1)
    expect(Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)).toBe(1)
    expect(committed(() => store.observeTokens(token))).toEqual([NORMAL])
    expect(committed(() => store.clear(store.metadata().revision))).toEqual([FULL])
    expect(synchronous(db)).toBe(NORMAL)
  })
})

describe('sub-agent history durability', () => {
  const observation = { id: 'agent', assignmentId: 'first', title: 'Inspect the parser', prompt: 'Private task', status: 'running', observedAt: at, startedAt: at } as const

  it('saves at NORMAL and waits for the disk when Keep local history turns off', async () => {
    const store = new SubagentStore(join(await folder(), 'subagents.sqlite'))
    store.open()
    closers.push(() => store.close())
    expect(synchronous(connection(store))).toBe(NORMAL)
    expect(Number(connection(store).prepare('PRAGMA secure_delete').get()?.secure_delete)).toBe(1)
    expect(committed(() => store.ingest('thread', [observation]))).toEqual([NORMAL])
    // A new epoch takes the thread's earlier tasks out, as a rewind does, so it waits for the disk; the same epoch does not.
    expect(committed(() => store.ingest('thread', [observation], 'epoch-a'))).toEqual([NORMAL])
    expect(committed(() => store.ingest('thread', [observation], 'epoch-a'))).toEqual([NORMAL])
    expect(committed(() => store.ingest('thread', [], 'epoch-b'))).toEqual([FULL])
    expect(synchronous(connection(store))).toBe(NORMAL)
    const erasing = committed(() => store.privacyChanged(false))
    expect(erasing.length).toBeGreaterThan(0)
    expect(erasing.every(setting => setting === FULL)).toBe(true)
    // While history is off, the attached file holds only erased identities, and it keeps SQLite's default.
    expect(synchronous(connection(store), 'privacy')).toBe(FULL)
  })
})
