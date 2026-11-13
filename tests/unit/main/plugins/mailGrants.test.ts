// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MailGrants } from '../../../../src/main/plugins/mailGrants'

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
