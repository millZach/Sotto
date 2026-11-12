// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginAccounts, PluginAccountsUnreadable, pluginAccountSlot, PluginSecretLocked, type PluginCredentials, type SecretCheck } from '../../../../src/main/plugins/accounts'
import { PLUGIN_ACCOUNTS_MAX } from '../../../../src/shared/plugins'

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
  it('checks a secret with its service, keeps it in a slot of its own, and never writes it in the record of accounts', async () => {
    const { made, directory, kept, asked, again } = await accounts()
    const result = await made.add({ plugin: 'vercel', name: 'Work', secret: GOOD })
    expect(result).toEqual({ ok: true, accounts: [{ id: expect.any(String), plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user' }] })
    const account = result.ok ? result.accounts[0]! : undefined
    expect(asked).toHaveBeenCalledWith('vercel', GOOD)
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
    for (const problem of ['refused', 'unreachable'] as const) {
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
})
