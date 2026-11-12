// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
/** Two desktops the launch script recorded for the host, by their paired client IDs. */
const LAPTOP = 'desktop-laptop', TOWER = 'desktop-tower'

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
    await expect(copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)).resolves.toEqual({ kept: true, keptAt: '2026-11-12T09:00:00.000Z' })
    expect([...kept.slots]).toEqual([[pluginAccountSlot(WORK.id), TOKEN]])
    const listed = await copies.list(LAPTOP)
    expect(listed).toEqual([{ id: WORK.id, plugin: 'vercel', savedAt: WORK.savedAt }])
    expect(JSON.stringify(listed)).not.toContain(TOKEN)
    expect(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')).not.toContain(TOKEN)
    expect(await readFile(join(directory, 'plugin-account-copy-senders.json'), 'utf8')).not.toContain(TOKEN)
    // The host's tools find it as they find any account, with the secret the desktop sent.
    await expect(accounts().find('vercel', 'Work')).resolves.toEqual(WORK)
    expect(accounts().secret(WORK.id)).toBe(TOKEN)
  })

  it('replaces a copy its own desktop sent, secret and settings, and asks no service anything', async () => {
    const { kept, copies, accounts } = await host()
    await copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)
    const narrowed = { ...WORK, name: 'Work, renamed', savedAt: '2026-11-13T08:00:00.000Z', on: false, projects: ['folder:one'] }
    await expect(copies.keep({ account: narrowed, secret: OTHER }, LAPTOP)).resolves.toMatchObject({ kept: true })
    expect([...kept.slots]).toEqual([[pluginAccountSlot(WORK.id), OTHER]])
    expect(await accounts().list()).toEqual([narrowed])
    expect(await copies.list(LAPTOP)).toEqual([{ id: WORK.id, plugin: 'vercel', savedAt: '2026-11-13T08:00:00.000Z' }])
  })

  it('tells a desktop of its own copies alone, and lets no other desktop replace or remove them', async () => {
    const { kept, copies, accounts } = await host()
    await copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)
    // The other recorded desktop is told nothing of it.
    expect(await copies.list(TOWER)).toEqual([])
    // It cannot put its own secret under the laptop's account, whatever it calls it, or open it to every thread.
    await expect(copies.keep({ account: WORK, secret: OTHER }, TOWER)).resolves.toEqual({ kept: false, problem: 'held' })
    await expect(copies.keep({ account: { ...WORK, name: 'Mine now', savedAt: '2026-11-14T08:00:00.000Z' }, secret: OTHER }, TOWER)).resolves.toEqual({ kept: false, problem: 'held' })
    // It cannot remove it.
    await expect(copies.remove(WORK.id, TOWER)).resolves.toEqual({ removed: false })
    // And it cannot bring an account of the same name under an ID of its own: a host never holds two of one name.
    const theirs = { ...WORK, id: '22222222-2222-4222-8222-000000000002' }
    await expect(copies.keep({ account: theirs, secret: OTHER }, TOWER)).resolves.toEqual({ kept: false, problem: 'name-taken' })
    expect(await accounts().list()).toEqual([WORK])
    expect([...kept.slots]).toEqual([[pluginAccountSlot(WORK.id), TOKEN]])
    expect(await copies.list(LAPTOP)).toEqual([{ id: WORK.id, plugin: 'vercel', savedAt: WORK.savedAt }])
    // An account of another name is the other desktop's own, and each then lists only its own.
    const personal = { ...theirs, name: 'Personal' }
    await expect(copies.keep({ account: personal, secret: OTHER }, TOWER)).resolves.toMatchObject({ kept: true })
    expect((await copies.list(TOWER)).map(copy => copy.id)).toEqual([personal.id])
    expect((await copies.list(LAPTOP)).map(copy => copy.id)).toEqual([WORK.id])
  })

  it('deletes a revoked desktop’s copies and their secrets, and leaves another desktop’s alone', async () => {
    const { directory, kept, copies, accounts } = await host()
    const personal = { ...WORK, id: '22222222-2222-4222-8222-000000000002', name: 'Personal' }
    await copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)
    await copies.keep({ account: { ...WORK, id: '22222222-2222-4222-8222-000000000003', name: 'Side project' }, secret: TOKEN }, LAPTOP)
    await copies.keep({ account: personal, secret: OTHER }, TOWER)
    await copies.forgetDesktop(LAPTOP)
    expect(await accounts().list()).toEqual([personal])
    expect([...kept.slots]).toEqual([[pluginAccountSlot(personal.id), OTHER]])
    expect(JSON.parse(await readFile(join(directory, 'plugin-account-copy-senders.json'), 'utf8'))).toEqual({ version: 1, senders: { [personal.id]: TOWER } })
    expect(await copies.list(LAPTOP)).toEqual([])
    // A client that sent nothing, as a revoked phone did not, changes nothing.
    await copies.forgetDesktop('some-phone')
    expect(await accounts().list()).toEqual([personal])
  })

  it('takes over its own stale copy of the same name, so an agent that names the account is never handed the old secret', async () => {
    const { kept, copies, accounts } = await host()
    // The desktop removed "Work" while the host was away, so the removal never arrived, and then added a new "Work".
    await copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)
    const again = { ...WORK, id: '22222222-2222-4222-8222-000000000009', savedAt: '2026-11-14T08:00:00.000Z' }
    await expect(copies.keep({ account: again, secret: OTHER }, LAPTOP)).resolves.toMatchObject({ kept: true })
    // One "Work", the new one, with the new secret; the stale one and its secret are gone.
    expect(await accounts().list()).toEqual([again])
    expect([...kept.slots]).toEqual([[pluginAccountSlot(again.id), OTHER]])
    await expect(accounts().find('vercel', 'Work')).resolves.toEqual(again)
    await expect(accounts().find('vercel', undefined)).resolves.toEqual(again)
    expect((await copies.list(LAPTOP)).map(copy => copy.id)).toEqual([again.id])
    // A rename onto a name another of its copies has takes that one's place too.
    const side = { ...WORK, id: '22222222-2222-4222-8222-000000000003', name: 'Side project' }
    await copies.keep({ account: side, secret: TOKEN }, LAPTOP)
    await expect(copies.keep({ account: { ...side, name: ' work ' }, secret: TOKEN }, LAPTOP)).resolves.toMatchObject({ kept: true })
    expect((await accounts().list()).map(account => account.id)).toEqual([side.id])
    expect([...kept.slots.keys()]).toEqual([pluginAccountSlot(side.id)])
  })

  it('leaves a newer copy as it is when an older one of the same account arrives late', async () => {
    const { kept, copies, accounts } = await host()
    const newer = { ...WORK, savedAt: '2026-11-13T08:00:00.000Z', on: false }
    await copies.keep({ account: newer, secret: OTHER }, LAPTOP)
    // A retry of the earlier copy, sent before the newer one and delivered after it.
    await expect(copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)).resolves.toMatchObject({ kept: true })
    expect(await accounts().list()).toEqual([newer])
    expect([...kept.slots]).toEqual([[pluginAccountSlot(WORK.id), OTHER]])
    // A change to who may use it leaves the day its secret was saved as it was, and still arrives.
    await expect(copies.keep({ account: { ...newer, on: true }, secret: OTHER }, LAPTOP)).resolves.toMatchObject({ kept: true })
    expect(await accounts().list()).toEqual([{ ...newer, on: true }])
  })

  it('keeps nothing when the secret cannot be kept, and leaves a copy it already held as it was', async () => {
    const { directory, kept, copies, accounts } = await host()
    kept.state.failing = true
    await expect(copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)).resolves.toEqual({ kept: false, problem: 'store' })
    expect(await copies.list(LAPTOP)).toEqual([])
    expect(kept.slots.size).toBe(0)
    // Nobody is left on record as having sent a copy that was never kept.
    expect(JSON.parse(await readFile(join(directory, 'plugin-account-copy-senders.json'), 'utf8'))).toEqual({ version: 1, senders: {} })
    // With one already held, a replacement that cannot be kept changes neither the account nor its secret.
    kept.state.failing = false
    await copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)
    kept.state.failing = true
    await expect(copies.keep({ account: { ...WORK, on: false }, secret: OTHER }, LAPTOP)).resolves.toEqual({ kept: false, problem: 'store' })
    expect(await accounts().list()).toEqual([WORK])
    expect([...kept.slots]).toEqual([[pluginAccountSlot(WORK.id), TOKEN]])
  })

  it('never changes who may use a copy it then says it did not keep, even when the record cannot be written or put back', async () => {
    const { directory, kept, copies } = await host()
    await copies.keep({ account: { ...WORK, projects: ['folder:one'] }, secret: TOKEN }, LAPTOP)
    const before = await readFile(join(directory, 'plugin-accounts.json'), 'utf8')
    // The record of accounts can no longer be written: a folder stands where the next one would be put.
    await mkdir(join(directory, 'plugin-accounts.json.next', 'held'), { recursive: true })
    // The desktop sends the account opened to every project, with a new secret.
    await expect(copies.keep({ account: { ...WORK, projects: null }, secret: OTHER }, LAPTOP)).resolves.toEqual({ kept: false, problem: 'store' })
    // On disk, where a restart reads it, the account is still kept to its project, and its secret is the one it had.
    expect(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')).toBe(before)
    expect(JSON.parse(before)).toMatchObject({ accounts: [{ projects: ['folder:one'] }] })
    expect([...kept.slots]).toEqual([[pluginAccountSlot(WORK.id), TOKEN]])
    // The other way round: the secret cannot be kept, and by then the record cannot be written either, so nothing
    // could be put back. The host says it kept nothing, so the record must not have moved: it holds who may use the
    // account, and a restart reads it from disk.
    await rm(join(directory, 'plugin-accounts.json.next'), { recursive: true })
    kept.store.set = async () => {
      await mkdir(join(directory, 'plugin-accounts.json.next', 'held'), { recursive: true })
      throw new Error('The credential file could not be written.')
    }
    await expect(copies.keep({ account: { ...WORK, projects: null }, secret: OTHER }, LAPTOP)).resolves.toEqual({ kept: false, problem: 'store' })
    expect(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')).toBe(before)
    expect([...kept.slots]).toEqual([[pluginAccountSlot(WORK.id), TOKEN]])
  })

  it('holds no more accounts of a plugin than a plugin takes, though one it holds can always be replaced', async () => {
    const { copies } = await host()
    const numbered = (index: number): PluginAccount => ({ ...WORK, id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`, name: `Account ${index}` })
    for (let index = 1; index <= PLUGIN_ACCOUNTS_MAX; index += 1) await expect(copies.keep({ account: numbered(index), secret: TOKEN }, LAPTOP)).resolves.toMatchObject({ kept: true })
    await expect(copies.keep({ account: numbered(PLUGIN_ACCOUNTS_MAX + 1), secret: TOKEN }, LAPTOP)).resolves.toEqual({ kept: false, problem: 'limit' })
    await expect(copies.keep({ account: numbered(1), secret: OTHER }, LAPTOP)).resolves.toMatchObject({ kept: true })
    expect(await copies.list(LAPTOP)).toHaveLength(PLUGIN_ACCOUNTS_MAX)
  })

  it('lets a copy go with its secret, counts one it never held as gone, and says when it could not be deleted', async () => {
    const { kept, copies } = await host()
    await copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)
    await expect(copies.remove(WORK.id, LAPTOP)).resolves.toEqual({ removed: true })
    expect(kept.slots.size).toBe(0)
    expect(await copies.list(LAPTOP)).toEqual([])
    await expect(copies.remove(WORK.id, LAPTOP)).resolves.toEqual({ removed: true })
    // A secret that cannot be deleted is still there, so the copy is not said to be gone.
    await copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)
    kept.state.failingClear = true
    await expect(copies.remove(WORK.id, LAPTOP)).rejects.toThrow()
    expect(await copies.list(LAPTOP)).toHaveLength(1)
  })
})
