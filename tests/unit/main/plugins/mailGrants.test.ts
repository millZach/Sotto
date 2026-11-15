// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mailGrantsShown, MailGrants, mailThreadOpen, ownThreadId } from '../../../../src/main/plugins/mailGrants'
import type { PluginAccount } from '../../../../src/shared/plugins'

const folders: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(folders.splice(0).map(made => rm(made, { recursive: true, force: true })))
})

/** Made-up accounts by Sotto's own IDs for them. */
const PERSONAL = '33333333-3333-4333-8333-000000000001', WORK = '33333333-3333-4333-8333-000000000002'

/** The grants in a folder of their own, over threads that are open unless named in `closed`. */
async function grants() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-mail-grants-'))
  folders.push(directory)
  const closed = new Set<string>()
  const file = join(directory, 'plugin-mail-grants.json')
  const make = (): MailGrants => new MailGrants(directory, { open: threadId => !closed.has(threadId), now: () => new Date('2026-11-13T09:00:00.000Z'), checkEveryMs: 50 })
  /** Makes every write of the file fail, as a full or read-only disk does, until `heal` is called. */
  const breakWrites = async (): Promise<void> => { await mkdir(`${file}.next`) }
  const heal = async (): Promise<void> => { await rm(`${file}.next`, { recursive: true, force: true }) }
  return { made: make(), again: make, closed, file, breakWrites, heal }
}

describe('mail grants (ADR-0205, decision 8)', () => {
  it('holds for one thread and one account, and for no other thread or account', async () => {
    const { made } = await grants()
    expect(await made.has('thread-one', PERSONAL)).toBe(false)
    await made.grant('thread-one', PERSONAL)
    expect(await made.has('thread-one', PERSONAL)).toBe(true)
    expect(await made.has('thread-two', PERSONAL)).toBe(false)
    expect(await made.has('thread-one', WORK)).toBe(false)
    // Given twice, it is one grant.
    await made.grant('thread-one', PERSONAL)
    expect(await made.list()).toEqual([{ threadId: 'thread-one', accountId: PERSONAL, at: '2026-11-13T09:00:00.000Z' }])
  })

  it('is kept across a restart, in a file that holds a thread, an account and a time and nothing else', async () => {
    const { made, again, file } = await grants()
    await made.grant('thread-one', PERSONAL)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, grants: [{ threadId: 'thread-one', accountId: PERSONAL, at: '2026-11-13T09:00:00.000Z' }] })
    expect(await again().has('thread-one', PERSONAL)).toBe(true)
  })

  it('ends when its thread is settled, so a thread reopened later asks again', async () => {
    const { made, again, closed } = await grants()
    await made.grant('thread-one', PERSONAL)
    await made.grant('thread-two', PERSONAL)
    closed.add('thread-one')
    await made.endClosed()
    closed.delete('thread-one')
    expect(await made.has('thread-one', PERSONAL)).toBe(false)
    expect(await made.has('thread-two', PERSONAL)).toBe(true)
    expect(await again().has('thread-one', PERSONAL)).toBe(false)

    // A thread found closed when it asks to read holds no grant either, whether or not anything had looked yet.
    closed.add('thread-two')
    expect(await made.has('thread-two', PERSONAL)).toBe(false)
    closed.delete('thread-two')
    expect(await made.has('thread-two', PERSONAL)).toBe(false)
  })

  it('gives no grant to a thread that is no longer open, and says which threads are by the one test everything goes by', async () => {
    const { made, closed } = await grants()
    closed.add('thread-one')
    expect([made.open('thread-one'), made.open('thread-two')]).toEqual([false, true])
    await made.grant('thread-one', PERSONAL)
    closed.delete('thread-one')
    expect(await made.list()).toEqual([])
    expect(await made.has('thread-one', PERSONAL)).toBe(false)
  })

  it('looks at its threads a moment after it is told one may have changed, and costs nothing while it holds no grant', async () => {
    vi.useFakeTimers()
    const { made, closed } = await grants()
    expect(await made.list()).toEqual([])
    for (let told = 0; told < 100; told += 1) made.noticed()
    expect(vi.getTimerCount()).toBe(0)

    await made.grant('thread-one', PERSONAL)
    closed.add('thread-one')
    for (let told = 0; told < 100; told += 1) made.noticed()
    // However often it is told, it looks once.
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(50)
    vi.useRealTimers()
    expect(await made.list()).toEqual([])
    made.close()
  })

  it('ends at the user’s Stop, and says so only once the file says so too', async () => {
    const { made, again, breakWrites, heal } = await grants()
    await made.grant('thread-one', PERSONAL)
    await made.grant('thread-one', WORK)
    await breakWrites()
    // A Stop that could not be written has not happened: the grant stands, as it would after a restart.
    expect(await made.stop('thread-one', PERSONAL)).toBe(false)
    expect(await made.has('thread-one', PERSONAL)).toBe(true)
    await heal()
    expect(await made.stop('thread-one', PERSONAL)).toBe(true)
    expect(await made.has('thread-one', PERSONAL)).toBe(false)
    expect(await made.has('thread-one', WORK)).toBe(true)
    expect(await again().has('thread-one', PERSONAL)).toBe(false)
    // Stopping what is not there is done.
    expect(await made.stop('thread-nine', PERSONAL)).toBe(true)
  })

  it('goes with a deleted thread and with a removed account', async () => {
    const { made, again } = await grants()
    await made.grant('thread-one', PERSONAL)
    await made.grant('thread-two', PERSONAL)
    await made.grant('thread-two', WORK)
    await made.forgetThreads(['thread-one', 'thread-nine'])
    await made.forgetAccount(WORK)
    expect((await again().list()).map(grant => [grant.threadId, grant.accountId])).toEqual([['thread-two', PERSONAL]])
  })

  it('holds no grant for an account from the moment it is forgotten, for a read that asked before and is answered after', async () => {
    const { made } = await grants()
    await made.grant('thread-one', PERSONAL)
    // The read asks whether it may; the account is forgotten before that question is reached. A copy let go and
    // sent again comes under the same ID, and a read that began for the old one must not go by its grant.
    const [had] = await Promise.all([made.has('thread-one', PERSONAL), made.forgetAccount(PERSONAL)])
    expect(had).toBe(false)
    // A grant given after that is a new one, and holds.
    await made.grant('thread-one', PERSONAL)
    expect(await made.has('thread-one', PERSONAL)).toBe(true)
  })

  it('keeps a yes only for the copy of the account that was asked about', async () => {
    const { made } = await grants()
    const asked = made.generation(PERSONAL)
    // The account is forgotten, as a host's copy is when it is let go, and one of the same ID is held again.
    await made.forgetAccount(PERSONAL)
    expect(made.generation(PERSONAL)).not.toBe(asked)
    expect(await made.grant('thread-one', PERSONAL, asked)).toBe(false)
    expect(await made.list()).toEqual([])
    // A yes asked for about the copy held now is kept, and another account's copies are their own.
    expect(await made.grant('thread-one', PERSONAL, made.generation(PERSONAL))).toBe(true)
    expect(await made.grant('thread-one', WORK, made.generation(WORK))).toBe(true)
    expect((await made.list()).map(grant => grant.accountId)).toEqual([PERSONAL, WORK])
  })

  it('holds for this run when the file cannot be written, ends at once all the same, and writes the file when it next can', async () => {
    const { made, again, closed, breakWrites, heal } = await grants()
    await made.grant('thread-one', PERSONAL)
    await breakWrites()
    await made.grant('thread-two', PERSONAL)
    expect(await made.has('thread-two', PERSONAL)).toBe(true)
    // A settled thread's grant is gone from here at once, though the file still holds it.
    closed.add('thread-one')
    await made.endClosed()
    expect(await made.has('thread-one', PERSONAL)).toBe(false)
    expect((await again().list()).map(grant => grant.threadId)).toEqual(['thread-one'])
    await heal()
    await made.endClosed()
    expect((await again().list()).map(grant => grant.threadId)).toEqual(['thread-two'])
  })

  it('does not call a grant stopped while the file still holds it, even when it is already gone from here', async () => {
    const { made, again, closed, breakWrites, heal } = await grants()
    await made.grant('thread-one', PERSONAL)
    await breakWrites()
    // The thread is settled, so its grant ends here; the file could not be written and still holds it.
    closed.add('thread-one')
    await made.endClosed()
    closed.delete('thread-one')
    expect(await made.stop('thread-one', PERSONAL)).toBe(false)
    await heal()
    expect(await made.stop('thread-one', PERSONAL)).toBe(true)
    expect(await again().list()).toEqual([])
  })

  it('says when a grant is given or ended, so a thread’s menu can read its own again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-mail-grants-'))
    folders.push(directory)
    const closed = new Set<string>()
    let told = 0
    const made = new MailGrants(directory, { open: threadId => !closed.has(threadId), changed: () => { told += 1 } })
    await made.grant('thread-one', PERSONAL)
    expect(told).toBe(1)
    // Given again, nothing changed.
    await made.grant('thread-one', PERSONAL)
    expect(told).toBe(1)
    expect(await made.stop('thread-one', PERSONAL)).toBe(true)
    expect(told).toBe(2)
    await made.grant('thread-two', PERSONAL)
    closed.add('thread-two')
    await made.endClosed()
    expect(told).toBe(4)
    // A listener that fails does not stop a grant being kept.
    const failing = new MailGrants(directory, { open: () => true, changed: () => { throw new Error('The window has gone.') } })
    await failing.grant('thread-three', WORK)
    expect(await failing.has('thread-three', WORK)).toBe(true)
  })

  it('takes a file it cannot read as no grants, so every thread asks again', async () => {
    const { made, again, file } = await grants()
    await writeFile(file, '{ not json')
    expect(await made.has('thread-one', PERSONAL)).toBe(false)
    await writeFile(file, JSON.stringify({ version: 2, grants: [{ threadId: 'thread-one', accountId: PERSONAL, at: '2026-11-13T09:00:00.000Z' }] }))
    expect(await again().has('thread-one', PERSONAL)).toBe(false)
    // One entry that makes no sense does not take the others with it.
    await writeFile(file, JSON.stringify({ version: 1, grants: [{ threadId: 'thread-one' }, { threadId: 'thread-two', accountId: PERSONAL, at: '2026-11-13T09:00:00.000Z' }] }))
    expect((await again().list()).map(grant => grant.threadId)).toEqual(['thread-two'])
  })
})

describe('a thread that is open, as a mail grant means it', () => {
  const thread = (id: string, more: object = {}) => ({ id, projectId: 'project-one', ...more })
  const at = '2026-11-13T09:00:00.000Z'
  const snapshot = {
    threads: [thread('open'), thread('settled', { workspaceSettledAt: at }), thread('in-a-settled-project', { projectId: 'project-two' }), thread('archived', { archivedAt: at }),
      thread('parked', { settledAt: at }), thread('marked-settled', { settledOverride: 'settled' as const }), thread('restored', { workspaceSettledAt: null })],
    projects: [{ id: 'project-one' }, { id: 'project-two', workspaceSettledAt: at }],
  }

  it('is one Sotto holds that is not settled, by itself or with its project, and not archived', () => {
    const open = (id: string): boolean => mailThreadOpen(snapshot, id)
    expect([open('open'), open('restored')]).toEqual([true, true])
    // Settle is what the user presses, on a thread or on its project.
    expect([open('settled'), open('in-a-settled-project')]).toEqual([false, false])
    expect([open('archived'), open('parked'), open('marked-settled'), open('not-held')]).toEqual([false, false, false, false])
  })
})

it('reads a thread as a window names it as this computer’s own, and takes none of a paired host’s for its own', () => {
  const here = '11111111-1111-4111-8111-111111111111', forge = '22222222-2222-4222-8222-222222222222'
  // A window names a thread by a key that says which computer holds it.
  expect(ownThreadId(`host:${here}:thread-one`, here)).toBe('thread-one')
  expect(ownThreadId('thread-one', here)).toBe('thread-one')
  // A thread on a paired host keeps its grants there: this computer has none for it and ends none.
  expect(ownThreadId(`host:${forge}:thread-one`, here)).toBeNull()
})

it('lists in a thread’s menu only the mail accounts it holds a grant for and can read now, by name', () => {
  const at = '2026-11-13T09:00:00.000Z'
  const account = (id: string, name: string, more: Partial<PluginAccount> = {}): PluginAccount => ({ id, plugin: 'gmail', name, address: `${name.toLowerCase()}@example.com`, savedAt: at, signedInAs: null, on: true, projects: null, ...more })
  const grant = (threadId: string, accountId: string) => ({ threadId, accountId, at })
  const GONE = '33333333-3333-4333-8333-000000000009'
  const accounts = [account(PERSONAL, 'Personal'), account(WORK, 'Work')]
  const grants = [grant('thread-one', PERSONAL), grant('thread-one', WORK), grant('thread-one', GONE), grant('thread-two', PERSONAL)]
  expect(mailGrantsShown(grants, accounts, 'thread-one', 'folder:site')).toEqual([{ accountId: PERSONAL, plugin: 'gmail', name: 'Personal' }, { accountId: WORK, plugin: 'gmail', name: 'Work' }])
  // Never an address, and never another thread's.
  expect(JSON.stringify(mailGrantsShown(grants, accounts, 'thread-one', null))).not.toContain('example.com')
  expect(mailGrantsShown(grants, accounts, 'thread-two', null).map(shown => shown.name)).toEqual(['Personal'])
  expect(mailGrantsShown(grants, accounts, 'thread-nine', null)).toEqual([])
  // An account switched off, or kept to another project, is not one the thread can read: it has no row.
  expect(mailGrantsShown(grants, [account(PERSONAL, 'Personal', { on: false }), account(WORK, 'Work', { projects: ['folder:other'] })], 'thread-one', 'folder:site')).toEqual([])
  expect(mailGrantsShown(grants, [account(WORK, 'Work', { projects: ['folder:site'] })], 'thread-one', 'folder:site').map(shown => shown.name)).toEqual(['Work'])
  // An account of a plugin that is not mail has no grant to show, whatever the file says.
  expect(mailGrantsShown(grants, [account(PERSONAL, 'Deploys', { plugin: 'vercel' })], 'thread-one', null)).toEqual([])
})
