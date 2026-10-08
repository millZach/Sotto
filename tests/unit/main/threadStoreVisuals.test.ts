// @vitest-environment node
/**
 * Visuals in the thread store (ADR-0056): their own table rather than thread events, kept in order, untouched by a
 * messages-reset, and gone with Keep local history, a forgotten thread and a confirmed rewind of their turn.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../src/shared/agents'
import { prepareThreadDatabase, ThreadStore, type StoredVisual } from '../../../src/main/agents/threadStore'

const open: ThreadStore[] = []
const roots: string[] = []
afterEach(async () => {
  for (const store of open.splice(0)) store.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-visual-store-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function store(existing?: string, ephemeral = false) {
  const root = existing ?? await mkdtemp(join(tmpdir(), 'sotto-visual-store-'))
  if (existing === undefined) roots.push(root)
  const created = new ThreadStore(join(root, 'threads.sqlite'))
  created.open({ ephemeral })
  open.push(created)
  return { root, store: created }
}

async function onDisk(root: string): Promise<string> {
  const names = await readdir(root)
  return (await Promise.all(names.map(name => readFile(join(root, name), 'latin1').catch(() => '')))).join(' ')
}

const at = '2026-10-06T10:00:00.000Z'
const message = (id: string, role: AgentMessage['role']): AgentMessage => ({ id, role, text: `Words of ${id}`, createdAt: at })
const visual = (id: string, anchorMessageId: string | null, anchorUserMessageId: string | null): StoredVisual => ({
  visual: { id, title: `Secret visual ${id}`, kind: 'diagram', source: 'flowchart LR\n  A --> B', steps: [{ text: 'A goes to B', highlight: ['A->B'] }] },
  createdAt: at, anchorMessageId, anchorUserMessageId,
})

describe('visuals in the thread store', () => {
  it('migrates an older database and keeps visuals in the order they were drawn, across a reopen', async () => {
    // A database from before visuals, holding a thread: written by this store, then taken back to version 3 by undoing
    // what migrations 4 and 5 do.
    const older = await store()
    const root = older.root
    older.store.appendMany('thread', [message('u1', 'user'), message('a1', 'assistant')].map(item => ({ kind: 'message-added' as const, at, message: item })))
    older.store.close()
    const old = new DatabaseSync(join(root, 'threads.sqlite'))
    try {
      old.exec('DROP TABLE wake_ups; DROP INDEX visuals_thread; DROP TABLE visuals; DELETE FROM schema_migrations WHERE version >= 4')
      expect(old.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => Number(row.version))).toEqual([1, 2, 3])
      expect(old.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('visuals')).toBeUndefined()
      expect(old.prepare('SELECT message_id FROM messages WHERE thread_id = ? ORDER BY position').all('thread').map(row => row.message_id)).toEqual(['u1', 'a1'])
    } finally { old.close() }

    const f = await store(root)
    // The migration adds the table and loses nothing the thread held.
    expect(f.store.readMessages('thread').messages).toEqual([message('u1', 'user'), message('a1', 'assistant')])
    expect(f.store.readVisuals('thread')).toEqual([])
    expect(f.store.newestMessages('thread')).toEqual({ messageId: 'a1', userMessageId: 'u1' })
    expect(f.store.newestMessages('empty')).toEqual({ messageId: null, userMessageId: null })
    f.store.addVisual('thread', visual('first', 'a1', 'u1'))
    f.store.addVisual('thread', visual('second', 'a1', 'u1'))
    expect(f.store.readVisuals('thread').map(item => item.visual.id)).toEqual(['first', 'second'])
    f.store.close()

    const reopened = await store(root)
    expect(reopened.store.readVisuals('thread')).toEqual([visual('first', 'a1', 'u1'), visual('second', 'a1', 'u1')])
    expect(reopened.store.readVisuals('other')).toEqual([])
    const db = new DatabaseSync(join(root, 'threads.sqlite'))
    try { expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => Number(row.version))).toEqual([1, 2, 3, 4, 5]) }
    finally { db.close() }
  })

  it('is not a thread event, so a messages-reset and a rebuilt projection leave visuals where they are', async () => {
    const f = await store()
    f.store.appendMany('thread', [message('u1', 'user'), message('a1', 'assistant')].map(item => ({ kind: 'message-added' as const, at, message: item })))
    f.store.addVisual('thread', visual('kept', 'a1', 'u1'))
    f.store.replaceThreadMessages('thread', [message('u1', 'user'), message('a1', 'assistant')], 'coalesced')
    f.store.rebuild()
    expect(f.store.readVisuals('thread').map(item => item.visual.id)).toEqual(['kept'])
    expect(f.store.eventsAfter(0).some(row => JSON.stringify(row.event).includes('Secret visual'))).toBe(false)
  })

  it('removes the visuals of the turns a confirmed rewind took back, and keeps the rest', async () => {
    const f = await store()
    f.store.addVisual('thread', visual('early', 'a1', 'u1'))
    f.store.addVisual('thread', visual('late', 'a2', 'u2'))
    f.store.addVisual('thread', visual('later', 'u3', 'u3'))
    expect(f.store.deleteVisualsForTurns('thread', ['u2', 'u3'])).toBe(2)
    expect(f.store.readVisuals('thread').map(item => item.visual.id)).toEqual(['early'])
    expect(f.store.deleteVisualsForTurns('thread', ['missing'])).toBe(0)
    f.store.close()
    const reopened = await store(f.root)
    expect(reopened.store.readVisuals('thread').map(item => item.visual.id)).toEqual(['early'])
  })

  it('takes a forgotten thread\'s visuals out of the file, leaving other threads\' alone', async () => {
    const f = await store()
    f.store.addVisual('gone', visual('gone-visual', null, null))
    f.store.addVisual('kept', visual('kept-visual', null, null))
    f.store.forget('gone')
    expect(f.store.readVisuals('gone')).toEqual([])
    expect(f.store.readVisuals('kept').map(item => item.visual.id)).toEqual(['kept-visual'])
    f.store.close()
    const text = await onDisk(f.root)
    expect(text).not.toContain('Secret visual gone-visual')
    expect(text).toContain('Secret visual kept-visual')
  })

  it('takes every visual out of the file when Keep local history turns off, and keeps new ones in memory only', async () => {
    const f = await store()
    f.store.addVisual('thread', visual('before', null, null))
    f.store.becomeEphemeral()
    expect(f.store.readVisuals('thread')).toEqual([])
    f.store.addVisual('thread', visual('private', null, null))
    expect(f.store.readVisuals('thread').map(item => item.visual.id)).toEqual(['private'])
    expect(await onDisk(f.root)).not.toContain('Secret visual')
    // Turning history back on starts from the file, which kept nothing said while it was off.
    f.store.becomeDurable()
    expect(f.store.readVisuals('thread')).toEqual([])
  })

  it('redacts visuals from a file an earlier run kept, when it opens with history off', async () => {
    const f = await store()
    f.store.addVisual('thread', visual('earlier', null, null))
    f.store.close()
    const reopened = await store(f.root, true)
    expect(reopened.store.readVisuals('thread')).toEqual([])
    reopened.store.close()
    expect(await onDisk(f.root)).not.toContain('Secret visual')
  })

  it('leaves out a row it cannot read rather than refusing the thread', async () => {
    const f = await store()
    f.store.addVisual('thread', visual('good', null, null))
    f.store.close()
    const db = new DatabaseSync(join(f.root, 'threads.sqlite'))
    prepareThreadDatabase(db)
    db.prepare('INSERT INTO visuals (thread_id, visual_id, created_at, payload) VALUES (?, ?, ?, ?)').run('thread', 'bad', at, '{not json')
    db.close()
    const reopened = await store(f.root)
    expect(reopened.store.readVisuals('thread').map(item => item.visual.id)).toEqual(['good'])
  })
})
