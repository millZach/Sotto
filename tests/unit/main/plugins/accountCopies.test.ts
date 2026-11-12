// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostPluginAccountCopies } from '../../../../src/main/plugins/accountCopies'
import { PluginAccounts, pluginAccountSlot, type PluginCredentials } from '../../../../src/main/plugins/accounts'
import { PLUGIN_ACCOUNTS_MAX, type PluginAccount } from '../../../../src/shared/plugins'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(made => rm(made, { recursive: true, force: true }))) })

/** A credential store held in memory. `failing` makes the next write of a secret fail, as a host with no key file does. */
function credentials() {
  const slots = new Map<string, string>()
  const state = { failing: false, failingClear: false }
  const store: PluginCredentials = {
    has: slot => slots.has(slot),
    get: slot => slots.get(slot) ?? '',
    set: async (slot, value) => {
      if (value && state.failing) throw new Error('Supply a host key file before saving credentials.')
      if (!value && state.failingClear) throw new Error('The credential file could not be written.')
      if (value) slots.set(slot, value); else slots.delete(slot)
    },
  }
  return { store, slots, state }
}

/** Made-up values: nothing here is a real credential. */
const TOKEN = 'made-up-token-for-a-copy', OTHER = 'made-up-token-replaced'
const WORK: PluginAccount = { id: '22222222-2222-4222-8222-000000000001', plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user', on: true, projects: null }

async function host() {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-account-copies-'))
  folders.push(directory)
  const kept = credentials()
  const copies = hostPluginAccountCopies(directory, kept.store, () => new Date('2026-11-12T09:00:00.000Z'))
  /** The host's own plugin accounts, as its tools will read them: the same record and the same slots. */
  const accounts = (): PluginAccounts => new PluginAccounts(directory, { credentials: kept.store, check: async () => ({ ok: false, problem: 'unreachable' }) })
  return { directory, kept, copies, accounts }
}

describe('a headless host’s account copies (ADR-0205, amending ADR-0025)', () => {
  it('keeps a copy as one of the host’s own plugin accounts, under the desktop’s ID for it, and lists it without its secret', async () => {
    const { directory, kept, copies, accounts } = await host()
    await expect(copies.keep({ account: WORK, secret: TOKEN })).resolves.toEqual({ kept: true, keptAt: '2026-11-12T09:00:00.000Z' })
    expect([...kept.slots]).toEqual([[pluginAccountSlot(WORK.id), TOKEN]])
    const listed = await copies.list()
    expect(listed).toEqual([{ id: WORK.id, plugin: 'vercel', savedAt: WORK.savedAt }])
    expect(JSON.stringify(listed)).not.toContain(TOKEN)
    expect(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')).not.toContain(TOKEN)
    // The host's tools find it as they find any account, with the secret the desktop sent.
    await expect(accounts().find('vercel', 'Work')).resolves.toEqual(WORK)
    expect(accounts().secret(WORK.id)).toBe(TOKEN)
  })

  it('replaces a copy it already holds, secret and settings, and asks no service anything', async () => {
    const { kept, copies, accounts } = await host()
    await copies.keep({ account: WORK, secret: TOKEN })
    const narrowed = { ...WORK, name: 'Work, renamed', savedAt: '2026-11-13T08:00:00.000Z', on: false, projects: ['folder:one'] }
    await expect(copies.keep({ account: narrowed, secret: OTHER })).resolves.toMatchObject({ kept: true })
    expect([...kept.slots]).toEqual([[pluginAccountSlot(WORK.id), OTHER]])
    expect(await accounts().list()).toEqual([narrowed])
    expect(await copies.list()).toEqual([{ id: WORK.id, plugin: 'vercel', savedAt: '2026-11-13T08:00:00.000Z' }])
  })

  it('keeps nothing when the secret cannot be kept, and leaves a copy it already held as it was', async () => {
    const { kept, copies, accounts } = await host()
    kept.state.failing = true
    await expect(copies.keep({ account: WORK, secret: TOKEN })).resolves.toEqual({ kept: false, problem: 'store' })
    expect(await copies.list()).toEqual([])
    expect(kept.slots.size).toBe(0)
    // With one already held, a replacement that cannot be kept changes neither the account nor its secret.
    kept.state.failing = false
    await copies.keep({ account: WORK, secret: TOKEN })
    kept.state.failing = true
    await expect(copies.keep({ account: { ...WORK, on: false }, secret: OTHER })).resolves.toEqual({ kept: false, problem: 'store' })
    expect(await accounts().list()).toEqual([WORK])
    expect([...kept.slots]).toEqual([[pluginAccountSlot(WORK.id), TOKEN]])
  })

  it('holds no more accounts of a plugin than a plugin takes, though one it holds can always be replaced', async () => {
    const { copies } = await host()
    const numbered = (index: number): PluginAccount => ({ ...WORK, id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`, name: `Account ${index}` })
    for (let index = 1; index <= PLUGIN_ACCOUNTS_MAX; index += 1) await expect(copies.keep({ account: numbered(index), secret: TOKEN })).resolves.toMatchObject({ kept: true })
    await expect(copies.keep({ account: numbered(PLUGIN_ACCOUNTS_MAX + 1), secret: TOKEN })).resolves.toEqual({ kept: false, problem: 'limit' })
    await expect(copies.keep({ account: numbered(1), secret: OTHER })).resolves.toMatchObject({ kept: true })
    expect(await copies.list()).toHaveLength(PLUGIN_ACCOUNTS_MAX)
  })

  it('lets a copy go with its secret, counts one it never held as gone, and says when it could not be deleted', async () => {
    const { kept, copies } = await host()
    await copies.keep({ account: WORK, secret: TOKEN })
    await expect(copies.remove(WORK.id)).resolves.toEqual({ removed: true })
    expect(kept.slots.size).toBe(0)
    expect(await copies.list()).toEqual([])
    await expect(copies.remove(WORK.id)).resolves.toEqual({ removed: true })
    // A secret that cannot be deleted is still there, so the copy is not said to be gone.
    await copies.keep({ account: WORK, secret: TOKEN })
    kept.state.failingClear = true
    await expect(copies.remove(WORK.id)).rejects.toThrow()
    expect(await copies.list()).toHaveLength(1)
  })
})
