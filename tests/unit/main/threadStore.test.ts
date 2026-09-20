// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { AgentMessage } from '../../../src/shared/agents'
import { prepareThreadDatabase, ThreadStore } from '../../../src/main/agents/threadStore'

const open: ThreadStore[] = []
const roots: string[] = []
afterEach(async () => {
  for (const store of open.splice(0)) store.close()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-thread-store-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function store(existing?: string) {
  const root = existing ?? await mkdtemp(join(tmpdir(), 'sotto-thread-store-'))
  if (existing === undefined) roots.push(root)
  const created = new ThreadStore(join(root, 'threads.sqlite'))
  created.open()
  open.push(created)
  return { root, store: created, path: join(root, 'threads.sqlite') }
}

/** Everything the store has on disk for this profile: the database and any write-ahead log beside it. */
async function onDisk(root: string): Promise<string> {
  const names = await readdir(root)
  const parts = await Promise.all(names.map(name => readFile(join(root, name), 'latin1').catch(() => '')))
  return parts.join(' ')
}

const at = '2026-09-19T10:00:00.000Z'
const message = (id: string, role: AgentMessage['role'], text: string): AgentMessage => ({ id, role, text, createdAt: at })
/** `count` whole turns: one user message and one reply each, numbered so a window says where it starts. */
const conversation = (count: number): AgentMessage[] => Array.from({ length: count }, (_, index) => [
  message(`u${index}`, 'user', `Ask ${index}`), message(`a${index}`, 'assistant', `Answer ${index}`),
]).flat()

describe('thread store', () => {
  it('projects added, appended and replaced messages, and answers windows in whole turns', async () => {
    const f = await store()
    f.store.appendMany('thread', conversation(3).map(item => ({ kind: 'message-added', at, message: item })))
    f.store.append('thread', { kind: 'message-text-appended', at, messageId: 'a2', appendText: ' and more' })
    f.store.append('thread', { kind: 'message-replaced', at, message: message('u0', 'user', 'Ask 0, corrected') })
    expect(f.store.messageCount('thread')).toBe(6)

    const whole = f.store.readMessages('thread')
    expect(whole.messages.map(item => item.text)).toEqual(['Ask 0, corrected', 'Answer 0', 'Ask 1', 'Answer 1', 'Ask 2', 'Answer 2 and more'])
    expect(whole).toMatchObject({ earlierAvailable: false, firstPosition: 0, lastPosition: 5 })

    // A window is measured in turns, so it opens on a user message rather than halfway through one.
    const window = f.store.readMessages('thread', { turns: 2 })
    expect(window.messages.map(item => item.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(window).toMatchObject({ earlierAvailable: true, firstPosition: 2, lastPosition: 5 })
    expect(f.store.readMessages('thread', { turns: 10 }).earlierAvailable).toBe(false)
    expect(f.store.readMessages('thread', { turns: 1, beforePosition: 4 }).messages.map(item => item.id)).toEqual(['u1', 'a1'])
    expect(f.store.readMessages('unknown')).toMatchObject({ messages: [], earlierAvailable: false, firstPosition: -1 })
  })

  it('summarises a thread from the projection and reports the log after a sequence', async () => {
    const f = await store()
    f.store.replaceThreadMessages('thread', conversation(2))
    const seq = f.store.latestSeq()
    f.store.append('thread', { kind: 'answer-given', at, requestId: 'request', answer: 'Allow once',
      attribution: { clientId: 'window-1', transport: 'ipc' } })
    expect(f.store.summary('thread')).toMatchObject({ messageCount: 4,
      lastUser: { id: 'u1', text: 'Ask 1' }, lastAssistant: { id: 'a1', text: 'Answer 1' }, lastMessageAt: at })
    const after = f.store.eventsAfter(seq)
    expect(after).toHaveLength(1)
    expect(after[0]?.event).toMatchObject({ kind: 'answer-given', attribution: { clientId: 'window-1', transport: 'ipc' } })
    expect(f.store.eventsAfter(0, 'other')).toEqual([])
  })

  it('rebuilds the projection from the log alone', async () => {
    const f = await store()
    f.store.replaceThreadMessages('thread', conversation(2))
    f.store.append('thread', { kind: 'message-text-appended', at, messageId: 'a1', appendText: '!' })
    const before = f.store.readMessages('thread').messages
    f.store.rebuild()
    expect(f.store.readMessages('thread').messages).toEqual(before)
  })

  it('replaces a thread after a rewind, and the replacement is the whole history', async () => {
    const f = await store()
    f.store.replaceThreadMessages('thread', conversation(3), 'epoch-1')
    f.store.replaceThreadMessages('thread', conversation(1), 'epoch-2')
    expect(f.store.readMessages('thread').messages.map(item => item.id)).toEqual(['u0', 'a0'])
    // The same move run twice leaves the same history, which is what the one-time migration needs.
    f.store.replaceThreadMessages('thread', conversation(1), 'epoch-2')
    expect(f.store.readMessages('thread').messages.map(item => item.id)).toEqual(['u0', 'a0'])
  })

  it('takes the words out of a forgotten thread and out of the whole file, and leaves no text behind', async () => {
    const f = await store()
    f.store.replaceThreadMessages('kept', [message('k0', 'user', 'Keep this one')])
    f.store.replaceThreadMessages('gone', [message('g0', 'user', 'Forget this one')])
    f.store.forget('gone')
    expect(f.store.readMessages('gone').messages).toEqual([])
    expect(f.store.readMessages('kept').messages).toHaveLength(1)
    expect(await onDisk(f.root)).not.toContain('Forget this one')

    f.store.redactAll()
    expect(f.store.readMessages('kept').messages).toEqual([])
    f.store.close()
    expect(await onDisk(f.root)).not.toContain('Keep this one')
    // The log still says what happened, without saying what was said.
    const reopened = await store(f.root)
    expect(reopened.store.eventsAfter(0).some(item => item.event.kind === 'message-added')).toBe(true)
    expect(reopened.store.readMessages('kept').messages).toEqual([])
    // A rebuilt projection does not bring the redacted shapes back as messages.
    reopened.store.rebuild()
    expect(reopened.store.readMessages('kept').messages).toEqual([])
    expect(reopened.store.messageCount('kept')).toBe(0)
  })

  it('prepares a connection with synchronous=NORMAL', () => {
    const db = new DatabaseSync(':memory:')
    try {
      prepareThreadDatabase(db)
      // synchronous is per-connection, so it reads back here even though the memory
      // database's journal_mode reports 'memory' rather than 'wal'.
      expect(db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(1)
    } finally {
      db.close()
    }
  })

  it('opens the file in WAL mode, the setting synchronous=NORMAL exists to serve', async () => {
    // synchronous is per-connection, so a second connection can only vouch for the mode that
    // makes it count: journal_mode lives in the file and reads back from any connection.
    const f = await store()
    const other = new DatabaseSync(f.path)
    try {
      expect(String(other.prepare('PRAGMA journal_mode').get()?.journal_mode)).toBe('wal')
    } finally {
      other.close()
    }
  })

  it('keeps an ephemeral run out of the file and hands the file back when history returns', async () => {
    const f = await store()
    f.store.replaceThreadMessages('thread', [message('m0', 'user', 'Said while history was on')])
    f.store.becomeEphemeral()
    expect(f.store.ephemeral).toBe(true)
    f.store.replaceThreadMessages('thread', [message('m1', 'user', 'Said while history was off')])
    expect(f.store.readMessages('thread').messages.map(item => item.text)).toEqual(['Said while history was off'])
    const saved = await onDisk(f.root)
    expect(saved).not.toContain('Said while history was off')
    expect(saved).not.toContain('Said while history was on')

    f.store.becomeDurable()
    expect(f.store.ephemeral).toBe(false)
    expect(f.store.readMessages('thread').messages).toEqual([])
  })
})
