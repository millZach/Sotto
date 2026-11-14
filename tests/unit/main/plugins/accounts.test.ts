// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { PluginAccounts, PluginAccountsUnreadable, pluginAccountSlot, PluginSecretLocked, type PluginCredentials, type SecretCheck } from '../../../../src/main/plugins/accounts'
import { PLUGIN_ACCOUNTS_MAX, pluginAccountAdmits, type PluginAccount } from '../../../../src/shared/plugins'

const folders: string[] = []
async function folder(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'sotto-plugin-accounts-'))
  folders.push(made)
  return made
}
afterEach(async () => { await Promise.all(folders.splice(0).map(made => rm(made, { recursive: true, force: true }))) })

/** A credential store held in memory. `failing` makes the next write of a secret fail, as a locked store does. */
function credentials() {
  const slots = new Map<string, string>()
  const state = { failing: false, locked: false, failingClear: false }
  const store: PluginCredentials = {
    has: slot => slots.has(slot),
    get: slot => { if (state.locked) throw new Error('Unlock your operating system credential store to continue.'); return slots.get(slot) ?? '' },
    set: async (slot, value) => {
      if (value && state.failing) throw new Error('Secure credential storage is unavailable. No key was saved.')
      if (!value && state.failingClear) throw new Error('The credential file could not be written.')
      if (value) slots.set(slot, value); else slots.delete(slot)
    },
  }
  return { store, slots, state }
}

/** Made-up values: nothing here is a real credential. */
const GOOD = 'made-up-good-token', OTHER = 'made-up-other-token'

async function accounts(check: (plugin: string, secret: string) => Promise<SecretCheck> = async () => ({ ok: true, signedInAs: 'example-user' })) {
  const directory = await folder()
  const kept = credentials()
  const asked = vi.fn(check)
  const made = new PluginAccounts(directory, { credentials: kept.store, check: asked, now: () => new Date('2026-11-12T08:00:00.000Z') })
  return { made, directory, kept, asked, again: () => new PluginAccounts(directory, { credentials: kept.store, check: asked }) }
}

describe('plugin accounts (ADR-0205)', () => {
  it('keeps a mail account with its address, checks the two together, and leaves out the spaces a Gmail app password is shown with', async () => {
    const { made, directory, kept, asked, again } = await accounts(async () => ({ ok: true, signedInAs: null }))
    const result = await made.add({ plugin: 'gmail', name: 'Personal', address: 'reader@example.com', secret: 'abcd efgh ijkl mnop' })
    expect(result).toEqual({ ok: true, accounts: [{ id: expect.any(String), plugin: 'gmail', name: 'Personal', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: null, address: 'reader@example.com', on: true, projects: null }] })
    const account = result.ok ? result.accounts[0]! : undefined
    expect(asked).toHaveBeenLastCalledWith('gmail', 'abcdefghijklmnop', 'reader@example.com')
    expect([...kept.slots]).toEqual([[pluginAccountSlot(account!.id), 'abcdefghijklmnop']])
    // A build from before mail would drop the account and leave its password behind, so the record says it is newer than that build reads.
    const file = JSON.parse(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')) as { version: number }
    expect(file.version).toBe(3)
    expect(JSON.stringify(file)).not.toContain('abcdefghijklmnop')
    expect(await again().list()).toEqual(result.ok ? result.accounts : [])

    // A new password is checked with the account's own address.
    expect((await made.replace({ id: account!.id, secret: 'qrst uvwx yzab cdef' })).ok).toBe(true)
    expect(asked).toHaveBeenLastCalledWith('gmail', 'qrstuvwxyzabcdef', 'reader@example.com')
    expect(made.secret(account!.id)).toBe('qrstuvwxyzabcdef')
    // A token of another plugin keeps its spaces: only Gmail shows a password that way.
    await made.add({ plugin: 'vercel', name: 'Work', secret: 'made up token' })
    expect(asked).toHaveBeenLastCalledWith('vercel', 'made up token', undefined)

    // A mail account without an address, or an address on another plugin's account, is refused before any service is asked.
    asked.mockClear()
    expect(await made.add({ plugin: 'gmail', name: 'No address', secret: GOOD })).toEqual({ ok: false, problem: 'refused' })
    expect(await made.add({ plugin: 'vercel', name: 'An address', secret: GOOD, address: 'reader@example.com' })).toEqual({ ok: false, problem: 'refused' })
    expect(asked).not.toHaveBeenCalled()
    // With the mail account gone, the record is one an older build reads again.
    expect((await made.remove({ id: account!.id })).ok).toBe(true)
    expect((JSON.parse(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')) as { version: number }).version).toBe(1)
  })

  it('checks a secret with its service, keeps it in a slot of its own, and never writes it in the record of accounts', async () => {
    const { made, directory, kept, asked, again } = await accounts()
    const result = await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    expect(result).toEqual({ ok: true, accounts: [{ id: expect.any(String), plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user', on: true, projects: null }] })
    const account = result.ok ? result.accounts[0]! : undefined
    expect(asked).toHaveBeenCalledWith('vercel', GOOD, undefined)
    expect([...kept.slots]).toEqual([[pluginAccountSlot(account!.id), GOOD]])
    expect(made.secret(account!.id)).toBe(GOOD)
    const file = await readFile(join(directory, 'plugin-accounts.json'), 'utf8')
    expect(file).not.toContain(GOOD)
    expect(Object.keys((JSON.parse(file) as { accounts: object[] }).accounts[0]!).sort()).toEqual(['id', 'name', 'plugin', 'savedAt', 'signedInAs'])
    // After a restart the account is found again, and what a window is given never holds the secret.
    expect(JSON.stringify(await again().list())).not.toContain(GOOD)
    expect(await again().list()).toEqual(result.ok ? result.accounts : [])
  })

  it('keeps nothing when the service refuses the secret or cannot be asked', async () => {
    for (const problem of ['refused', 'unreachable', 'busy'] as const) {
      const { made, kept } = await accounts(async () => ({ ok: false, problem }))
      await expect(made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })).resolves.toEqual({ ok: false, problem })
      expect(kept.slots.size).toBe(0)
      expect(await made.list()).toEqual([])
    }
  })

  it('turns away a name the plugin already has, however it is cased, and more accounts than it holds, before asking the service', async () => {
    const { made, asked } = await accounts()
    await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    asked.mockClear()
    await expect(made.add({ plugin: 'vercel', name: ' work ', secret: OTHER })).resolves.toEqual({ ok: false, problem: 'name-taken' })
    for (let index = 1; index < PLUGIN_ACCOUNTS_MAX; index++) await made.add({ plugin: 'vercel', name: `Account ${index}`, secret: GOOD })
    asked.mockClear()
    await expect(made.add({ plugin: 'vercel', name: 'One too many', secret: GOOD })).resolves.toEqual({ ok: false, problem: 'limit' })
    expect(asked).not.toHaveBeenCalled()
  })

  it('leaves no secret and no account behind when the secret cannot be kept', async () => {
    const { made, kept } = await accounts()
    kept.state.failing = true
    await expect(made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })).resolves.toEqual({ ok: false, problem: 'store' })
    expect(kept.slots.size).toBe(0)
    expect(await made.list()).toEqual([])
  })

  it('replaces a secret only once the service accepts the new one, and keeps the old one otherwise', async () => {
    let answer: SecretCheck = { ok: true, signedInAs: 'example-user' }
    const { made, kept } = await accounts(async () => answer)
    const added = await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    const id = added.ok ? added.accounts[0]!.id : ''
    answer = { ok: false, problem: 'refused' }
    await expect(made.replace({ id, secret: OTHER })).resolves.toEqual({ ok: false, problem: 'refused' })
    expect(kept.slots.get(pluginAccountSlot(id))).toBe(GOOD)
    answer = { ok: true, signedInAs: 'other-user' }
    await expect(made.replace({ id, secret: OTHER })).resolves.toMatchObject({ ok: true, accounts: [{ id, signedInAs: 'other-user' }] })
    expect(kept.slots.get(pluginAccountSlot(id))).toBe(OTHER)
    await expect(made.replace({ id: '11111111-1111-4111-8111-111111111111', secret: OTHER })).resolves.toEqual({ ok: false, problem: 'gone' })
  })

  it('removes an account’s secret with the account, and says when the account is not there', async () => {
    const { made, kept } = await accounts()
    const added = await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    const id = added.ok ? added.accounts[0]!.id : ''
    await expect(made.remove({ id })).resolves.toEqual({ ok: true, accounts: [] })
    expect(kept.slots.size).toBe(0)
    expect(made.secret(id)).toBe('')
    await expect(made.remove({ id })).resolves.toEqual({ ok: false, problem: 'gone' })
  })

  it('does not show an account whose secret is gone from the credential store', async () => {
    const { made, kept, again } = await accounts()
    await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    kept.slots.clear()
    expect(await again().list()).toEqual([])
  })

  it('finds the account an agent named, or the only one when it named none', async () => {
    const { made } = await accounts()
    await expect(made.find('vercel', undefined)).resolves.toBe('none')
    await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    await expect(made.find('vercel', undefined)).resolves.toMatchObject({ name: 'Work' })
    await expect(made.find('vercel', 'WORK')).resolves.toMatchObject({ name: 'Work' })
    await expect(made.find('vercel', 'Personal')).resolves.toBe('unknown')
    await made.add({ plugin: 'vercel', name: 'Personal', secret: OTHER })
    await expect(made.find('vercel', undefined)).resolves.toBe('ambiguous')
    await expect(made.find('vercel', 'personal')).resolves.toMatchObject({ name: 'Personal' })
  })

  it('keeps the saved secret in use, and says so truthfully, whichever write of a replacement fails', async () => {
    const { made, directory, kept, again } = await accounts()
    const added = await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    const id = added.ok ? added.accounts[0]!.id : ''
    // The secret cannot be kept: the old one stays, and the day it was saved is put back.
    kept.state.failing = true
    await expect(made.replace({ id, secret: OTHER })).resolves.toEqual({ ok: false, problem: 'store' })
    expect(kept.slots.get(pluginAccountSlot(id))).toBe(GOOD)
    expect((await again().list())[0]!.savedAt).toBe('2026-11-12T08:00:00.000Z')
    kept.state.failing = false
    // The record of accounts cannot be written: nothing was changed, the secret least of all.
    await rm(join(directory, 'plugin-accounts.json'))
    await mkdir(join(directory, 'plugin-accounts.json', 'held'), { recursive: true })
    await expect(made.replace({ id, secret: OTHER })).resolves.toEqual({ ok: false, problem: 'store' })
    expect(kept.slots.get(pluginAccountSlot(id))).toBe(GOOD)
  })

  it('removes an account whose secret is deleted even when its record cannot be written, and changes nothing when the secret cannot be deleted', async () => {
    const { made, directory, kept } = await accounts()
    const added = await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    const id = added.ok ? added.accounts[0]!.id : ''
    kept.state.failingClear = true
    await expect(made.remove({ id })).resolves.toEqual({ ok: false, problem: 'store' })
    expect(kept.slots.get(pluginAccountSlot(id))).toBe(GOOD)
    expect(await made.list()).toHaveLength(1)
    kept.state.failingClear = false
    await rm(join(directory, 'plugin-accounts.json'))
    await mkdir(join(directory, 'plugin-accounts.json', 'held'), { recursive: true })
    await expect(made.remove({ id })).resolves.toEqual({ ok: true, accounts: [] })
    expect(kept.slots.size).toBe(0)
    expect(await made.list()).toEqual([])
  })

  it('changes nothing while the record of accounts cannot be read, so a passing failure never writes over the accounts', async () => {
    const { made, directory, kept } = await accounts()
    await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    const file = join(directory, 'plugin-accounts.json')
    const good = await readFile(file, 'utf8')
    await writeFile(file, 'not json', 'utf8')
    const later = new PluginAccounts(directory, { credentials: kept.store, check: async () => ({ ok: true, signedInAs: null }) })
    await expect(later.list()).rejects.toBeInstanceOf(PluginAccountsUnreadable)
    await expect(later.add({ plugin: 'vercel', name: 'Personal', secret: OTHER })).resolves.toEqual({ ok: false, problem: 'store' })
    expect(await readFile(file, 'utf8')).toBe('not json')
    expect(kept.slots.size).toBe(1)
    // Once the file can be read again, the same store finds the account that was there.
    await writeFile(file, good, 'utf8')
    expect((await later.list()).map(account => account.name)).toEqual(['Work'])
  })

  it('tells a secret that cannot be read from one that is gone', async () => {
    const { made, kept } = await accounts()
    const added = await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    const id = added.ok ? added.accounts[0]!.id : ''
    kept.state.locked = true
    expect(() => made.secret(id)).toThrow(PluginSecretLocked)
    kept.state.locked = false
    expect(made.secret('11111111-1111-4111-8111-111111111111')).toBe('')
  })

  it('switches an account off and keeps it to projects without touching its secret, and remembers both', async () => {
    const { made, kept, asked, again } = await accounts()
    const added = await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    const id = added.ok ? added.accounts[0]!.id : ''
    asked.mockClear()
    await expect(made.update({ id, on: false })).resolves.toMatchObject({ ok: true, accounts: [{ id, on: false, projects: null }] })
    // Each project once, in the order given; the switch is left as it was.
    await expect(made.update({ id, projects: ['p-site', 'p-sotto', 'p-site'] })).resolves.toMatchObject({ ok: true, accounts: [{ id, on: false, projects: ['p-site', 'p-sotto'] }] })
    await expect(made.update({ id, on: true, projects: null })).resolves.toMatchObject({ ok: true, accounts: [{ id, on: true, projects: null }] })
    await made.update({ id, projects: ['p-site'] })
    // Nothing was asked of the service, and the secret is the one saved.
    expect(asked).not.toHaveBeenCalled()
    expect([...kept.slots]).toEqual([[pluginAccountSlot(id), GOOD]])
    expect(await again().list()).toMatchObject([{ id, on: true, projects: ['p-site'] }])
    await expect(made.update({ id: '11111111-1111-4111-8111-111111111111', on: false })).resolves.toEqual({ ok: false, problem: 'gone' })
  })

  it('takes an account kept before the switch existed as on, and for every project', async () => {
    const { directory, kept, again } = await accounts()
    const id = '22222222-2222-4222-8222-000000000001'
    kept.slots.set(pluginAccountSlot(id), GOOD)
    await writeFile(join(directory, 'plugin-accounts.json'), JSON.stringify({ version: 1, accounts: [{ id, plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: null }] }))
    expect(await again().list()).toEqual([{ id, plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: null, on: true, projects: null }])
  })

  it('finds for a thread only the accounts it may use, and says when the plugin has accounts and none is for it', async () => {
    const { made } = await accounts()
    const work = await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    const workId = work.ok ? work.accounts[0]!.id : ''
    await made.add({ plugin: 'vercel', name: 'Personal', secret: OTHER })
    await made.update({ id: workId, projects: ['p-site'] })
    const inProject = (project: string | null) => (account: PluginAccount) => pluginAccountAdmits(account, project)
    // In the project Work is kept to, both are there; elsewhere Work is not, and is not found by name either.
    await expect(made.find('vercel', undefined, inProject('p-site'))).resolves.toBe('ambiguous')
    await expect(made.find('vercel', 'Work', inProject('p-site'))).resolves.toMatchObject({ name: 'Work' })
    await expect(made.find('vercel', undefined, inProject('p-other'))).resolves.toMatchObject({ name: 'Personal' })
    await expect(made.find('vercel', 'Work', inProject('p-other'))).resolves.toBe('unknown')
    // A thread in no project, as Watcher's is, may use only an account kept to none.
    await expect(made.find('vercel', 'Work', inProject(null))).resolves.toBe('unknown')
    await expect(made.find('vercel', 'Personal', inProject(null))).resolves.toMatchObject({ name: 'Personal' })
    const both = await made.list()
    for (const account of both) await made.update({ id: account.id, on: false })
    await expect(made.find('vercel', undefined, inProject('p-site'))).resolves.toBe('withheld')
    // Without a thread to ask for, as the page asks, every account is found.
    await expect(made.find('vercel', 'Work')).resolves.toMatchObject({ name: 'Work', on: false })
  })

  it('writes an account that is on and for every project as an older build reads it, and marks a record an older build must not read', async () => {
    // What the build before the switch read: this shape and nothing more, in a file of version 1. Anything else it dropped.
    const before = z.object({ version: z.literal(1), accounts: z.array(z.object({ id: z.uuid(), plugin: z.literal('vercel'), name: z.string(), savedAt: z.iso.datetime(), signedInAs: z.string().nullable() }).strict()) })
    const { made, directory, again } = await accounts()
    const file = async (): Promise<unknown> => JSON.parse(await readFile(join(directory, 'plugin-accounts.json'), 'utf8'))
    const added = await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    const id = added.ok ? added.accounts[0]!.id : ''
    expect(before.safeParse(await file()).success).toBe(true)
    // Switched off and on again, and narrowed and widened again, it is back to the shape an older build keeps whole.
    await made.update({ id, on: false })
    await made.update({ id, on: true })
    await made.update({ id, projects: ['folder:one'] })
    await made.update({ id, projects: null })
    expect(before.safeParse(await file()).success).toBe(true)
    // Kept to a project, or off: an older build would read it as open to every thread, so the file is one it refuses whole.
    await made.update({ id, projects: ['folder:one'] })
    expect(await file()).toMatchObject({ version: 2, accounts: [{ id, projects: ['folder:one'] }] })
    expect(before.safeParse(await file()).success).toBe(false)
    expect(await again().list()).toMatchObject([{ id, on: true, projects: ['folder:one'] }])
    await made.update({ id, on: false, projects: null })
    expect(await file()).toMatchObject({ version: 2, accounts: [{ id, on: false }] })
    expect(await again().list()).toMatchObject([{ id, on: false, projects: null }])
  })
})
