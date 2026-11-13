// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginSecretLocked } from '../../../../src/main/plugins/accounts'
import { PluginAccountCopySync, type CopyComputer, type CopySyncEvent, type CopyTarget } from '../../../../src/main/plugins/copySync'
import type { HeldPluginAccountCopy, PluginAccountCopy, PluginAccountCopyReceipt } from '../../../../src/shared/pluginAccountCopies'
import type { PluginAccount } from '../../../../src/shared/plugins'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(made => rm(made, { recursive: true, force: true }))) })

/** Made-up accounts and tokens: nothing here is a real credential. */
const WORK: PluginAccount = { id: '22222222-2222-4222-8222-000000000001', plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user', on: true, projects: null }
const PERSONAL: PluginAccount = { ...WORK, id: '22222222-2222-4222-8222-000000000002', name: 'Personal' }
const tokenOf = (id: string): string => `made-up-token-for-${id.slice(-4)}`

/** A paired host as the desktop reaches it, keeping what it is sent the way a real one does. */
function fakeHost(hostId: string, options: { feature?: boolean; settings?: boolean; refuses?: PluginAccountCopyReceipt } = {}) {
  const held = new Map<string, PluginAccountCopy>()
  const calls: string[] = []
  const state = { down: false }
  const target: CopyTarget = { hostId, kind: 'remote', service: {
    supportsPluginAccountCopies: options.feature !== false,
    keepPluginAccountCopy: async copy => {
      calls.push(`keep ${copy.account.name}`)
      if (state.down) throw new Error('The host did not answer.')
      if (options.refuses) return options.refuses
      held.set(copy.account.id, copy)
      return { kept: true, keptAt: '2026-11-12T09:00:00.000Z' }
    },
    removePluginAccountCopy: async id => { calls.push(`remove ${held.get(id)?.account.name ?? id}`); if (state.down) throw new Error('The host did not answer.'); held.delete(id); return { removed: true } },
    pluginAccountCopies: async () => {
      calls.push('list')
      if (state.down) throw new Error('The host did not answer.')
      // A host from before the settings were listed says only which account and the day its secret was saved.
      return [...held.values()].map(({ account }): HeldPluginAccountCopy => options.settings === false ? { id: account.id, plugin: account.plugin, savedAt: account.savedAt }
        : { id: account.id, plugin: account.plugin, savedAt: account.savedAt, name: account.name, signedInAs: account.signedInAs, on: account.on, projects: account.projects })
    },
  } }
  return { target, held, calls, state }
}

async function desk(start: readonly PluginAccount[] = [WORK]) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-copy-sync-'))
  folders.push(directory)
  const world = { accounts: [...start], computers: [] as CopyComputer[], connections: [] as CopyTarget[], locked: false }
  const events: CopySyncEvent[] = []
  let changes = 0
  const make = (): PluginAccountCopySync => new PluginAccountCopySync(directory, {
    accounts: { list: async () => world.accounts, secret: id => { if (world.locked) throw new PluginSecretLocked(); return tokenOf(id) } },
    computers: () => world.computers, connections: () => world.connections,
    changed: () => { changes += 1 }, log: event => events.push(event), retryAfterMs: 3_600_000,
  })
  const sync = make()
  /** A host the user paired and saved, connected now. */
  const connect = (host: ReturnType<typeof fakeHost>, name = 'forge'): void => {
    const id = `saved-${host.target.hostId}`
    world.computers = [...world.computers.filter(computer => computer.id !== id), { id, name, hostId: host.target.hostId, connected: true }]
    world.connections = [...world.connections.filter(target => target.hostId !== host.target.hostId), host.target]
    sync.connected(host.target)
  }
  const leave = (host: ReturnType<typeof fakeHost>): void => {
    world.computers = world.computers.map(computer => computer.hostId === host.target.hostId ? { ...computer, connected: false } : computer)
    world.connections = world.connections.filter(target => target.hostId !== host.target.hostId)
  }
  const states = async (): Promise<string[]> => (await sync.view()).copies.map(copy => `${world.accounts.find(account => account.id === copy.accountId)!.name}@${copy.computerId.replace('saved-', '')}: ${copy.state}`)
  return { directory, world, sync, make, connect, leave, states, events, changes: () => changes }
}

describe('sending account copies to paired hosts (ADR-0205, amending ADR-0025)', () => {
  it('sends each account to a host when it connects, and sends nothing again while the host holds it as it is here', async () => {
    const d = await desk([WORK, PERSONAL])
    const forge = fakeHost('host-forge')
    d.connect(forge)
    await d.sync.idle()
    expect(forge.calls).toEqual(['list', 'keep Work', 'keep Personal'])
    expect([...forge.held.values()].map(copy => [copy.account, copy.secret])).toEqual([[WORK, tokenOf(WORK.id)], [PERSONAL, tokenOf(PERSONAL.id)]])
    expect(await d.states()).toEqual(['Work@host-forge: kept', 'Personal@host-forge: kept'])
    // It connects again: asked what it holds, and sent no secret, since nothing differs.
    forge.calls.length = 0
    d.connect(forge)
    await d.sync.idle()
    expect(forge.calls).toEqual(['list'])
    // What happened is said in fixed names; nothing of an account or its secret is in them.
    expect(new Set(d.events)).toEqual(new Set(['plugin-account-copies-reconciled']))
  })

  it('carries a change made here to the host: a replaced secret and the switch', async () => {
    const d = await desk()
    const forge = fakeHost('host-forge')
    d.connect(forge)
    await d.sync.idle()
    for (const changed of [{ ...WORK, savedAt: '2026-11-13T08:00:00.000Z' }, { ...WORK, savedAt: '2026-11-13T08:00:00.000Z', on: false }]) {
      forge.calls.length = 0
      d.world.accounts = [changed]
      d.sync.accountsChanged()
      await d.sync.idle()
      expect(forge.calls).toEqual(['list', 'keep Work'])
      expect(forge.held.get(WORK.id)!.account).toEqual(changed)
    }
  })

  it('takes a copy back when the account is removed here or its copy is switched off, even if the host was away then', async () => {
    const d = await desk([WORK, PERSONAL])
    const forge = fakeHost('host-forge')
    d.connect(forge)
    await d.sync.idle()
    // Switched off for Work: the host is told to let it go, and the page says no copy is kept.
    await d.sync.setCopy(WORK.id, 'saved-host-forge', false)
    await d.sync.idle()
    expect([...forge.held.keys()]).toEqual([PERSONAL.id])
    expect(await d.states()).toEqual(['Work@host-forge: off', 'Personal@host-forge: kept'])
    // The host goes away, and Personal is removed here meanwhile. Nothing can be sent, and nothing is.
    d.leave(forge)
    forge.calls.length = 0
    d.world.accounts = [WORK]
    d.sync.accountsChanged()
    await d.sync.idle()
    expect(forge.calls).toEqual([])
    expect(forge.held.size).toBe(1)
    // When it connects again the removal reaches it.
    d.connect(forge)
    await d.sync.idle()
    expect(forge.held.size).toBe(0)
    // Switched back on, Work is sent again.
    await d.sync.setCopy(WORK.id, 'saved-host-forge', true)
    await d.sync.idle()
    expect([...forge.held.keys()]).toEqual([WORK.id])
  })

  it('sends nothing to a host that cannot keep copies, and says why on the page', async () => {
    const d = await desk()
    const old = fakeHost('host-old', { feature: false })
    d.connect(old, 'old-box')
    await d.sync.idle()
    expect(old.calls).toEqual([])
    expect(await d.states()).toEqual(['Work@host-old: too-old'])
    // A host that lists the feature and cannot keep a secret, as one started without a key file cannot.
    const keyless = fakeHost('host-keyless', { refuses: { kept: false, problem: 'store' } })
    d.connect(keyless, 'keyless')
    await d.sync.idle()
    expect(await d.states()).toEqual(['Work@host-old: too-old', 'Work@host-keyless: no-key'])
    for (const [problem, state] of [['limit', 'full'], ['name-taken', 'name-taken'], ['held', 'held']] as const) {
      const host = fakeHost(`host-${problem}`, { refuses: { kept: false, problem } })
      d.connect(host, problem)
      await d.sync.idle()
      expect((await d.states()).at(-1)).toBe(`Work@host-${problem}: ${state}`)
    }
  })

  it('sends a copy to no host this computer has not saved, and waits for one that is not connected', async () => {
    const d = await desk()
    // A connection the saved hosts know nothing of is not one of the user's own paired hosts.
    const stray = fakeHost('host-stray')
    d.world.connections = [stray.target]
    d.sync.connected(stray.target)
    await d.sync.idle()
    expect(stray.calls).toEqual([])
    // A saved host that is away: a copy is wanted, and waits.
    d.world.computers = [{ id: 'saved-host-forge', name: 'forge', hostId: 'host-forge', connected: false }, { id: 'saved-never', name: 'never connected', connected: false }]
    expect(await d.states()).toEqual(['Work@host-forge: waiting', 'Work@never: waiting'])
    // The desktop's own local host is never sent one.
    const local = fakeHost('host-local')
    d.sync.connected({ ...local.target, kind: 'local' })
    await d.sync.idle()
    expect(local.calls).toEqual([])
  })

  it('sends a host its copies once it is saved, when it connected a moment before, as a host being added does', async () => {
    const d = await desk()
    const forge = fakeHost('host-forge')
    // The connection is taken first: this computer has not saved the host yet.
    d.world.connections = [forge.target]
    d.sync.connected(forge.target)
    await d.sync.idle()
    expect(forge.calls).toEqual([])
    // Saved hosts changing for another reason sends it nothing either.
    d.sync.computersChanged()
    await d.sync.idle()
    expect(forge.calls).toEqual([])
    // Then it is saved, and the copy goes.
    d.world.computers = [{ id: 'saved-host-forge', name: 'forge', hostId: 'host-forge', connected: true }]
    d.sync.computersChanged()
    await d.sync.idle()
    expect(forge.calls).toEqual(['list', 'keep Work'])
    expect(await d.states()).toEqual(['Work@host-forge: kept'])
    // Once looked at, a later change among the saved hosts does not send it again.
    forge.calls.length = 0
    d.sync.computersChanged()
    await d.sync.idle()
    expect(forge.calls).toEqual([])
  })

  it('keeps an account kept to chosen projects on this computer: never sent, taken back when it is narrowed, sent again when it is not', async () => {
    // A project is a folder on this computer, so an account kept to some of them has no meaning on another (Zach, November 12).
    const narrowed = { ...PERSONAL, projects: ['folder:one'] }
    const d = await desk([WORK, narrowed])
    const forge = fakeHost('host-forge')
    d.connect(forge)
    await d.sync.idle()
    expect(forge.calls).toEqual(['list', 'keep Work'])
    expect([...forge.held.keys()]).toEqual([WORK.id])
    expect(await d.states()).toEqual(['Work@host-forge: kept', 'Personal@host-forge: here-only'])
    // Asking for its copy by its switch sends nothing either: the choice is kept for when it is open to every project.
    forge.calls.length = 0
    await d.sync.setCopy(narrowed.id, 'saved-host-forge', true)
    await d.sync.idle()
    expect(forge.calls).toEqual(['list'])
    expect(await d.states()).toEqual(['Work@host-forge: kept', 'Personal@host-forge: here-only'])
    // Work is kept to a project: the copy forge holds is taken back.
    forge.calls.length = 0
    d.world.accounts = [{ ...WORK, projects: ['folder:two'] }, narrowed]
    d.sync.accountsChanged()
    await d.sync.idle()
    expect(forge.calls).toEqual(['list', 'remove Work'])
    expect(forge.held.size).toBe(0)
    expect(await d.states()).toEqual(['Work@host-forge: here-only', 'Personal@host-forge: here-only'])
    // Open to every project again, both are sent, with no project list on either.
    forge.calls.length = 0
    d.world.accounts = [WORK, PERSONAL]
    d.sync.accountsChanged()
    await d.sync.idle()
    expect(forge.calls).toEqual(['list', 'keep Work', 'keep Personal'])
    expect([...forge.held.values()].map(copy => copy.account.projects)).toEqual([null, null])
    expect(await d.states()).toEqual(['Work@host-forge: kept', 'Personal@host-forge: kept'])
  })

  it('takes back a narrowed account’s copy from a host that was away when it was narrowed', async () => {
    const d = await desk()
    const forge = fakeHost('host-forge')
    d.connect(forge)
    await d.sync.idle()
    expect(forge.held.size).toBe(1)
    d.leave(forge)
    d.world.accounts = [{ ...WORK, projects: ['folder:one'] }]
    d.sync.accountsChanged()
    await d.sync.idle()
    expect(forge.held.size).toBe(1)
    forge.calls.length = 0
    d.connect(forge)
    await d.sync.idle()
    expect(forge.calls).toEqual(['list', 'remove Work'])
    expect(forge.held.size).toBe(0)
  })

  it('follows the default for new copies as it stood when an account and a computer first met', async () => {
    const d = await desk()
    const forge = fakeHost('host-forge')
    d.connect(forge)
    await d.sync.idle()
    expect((await d.sync.view()).copyNew).toBe(true)
    // The default is turned off: the copy already made stays, and a new account gets none.
    await d.sync.setCopyNew(false)
    d.world.accounts = [WORK, PERSONAL]
    d.sync.accountsChanged()
    await d.sync.idle()
    expect([...forge.held.keys()]).toEqual([WORK.id])
    expect(await d.states()).toEqual(['Work@host-forge: kept', 'Personal@host-forge: off'])
    // Turned back on: Personal, which was met while it was off, still has none until the user asks.
    await d.sync.setCopyNew(true)
    d.sync.accountsChanged()
    await d.sync.idle()
    expect([...forge.held.keys()]).toEqual([WORK.id])
    // The choices are kept across a restart, and hold no secret.
    const file = await readFile(join(d.directory, 'plugin-account-copy-choices.json'), 'utf8')
    expect(JSON.parse(file)).toEqual({ version: 1, copyNew: true, choices: { [WORK.id]: { 'saved-host-forge': true }, [PERSONAL.id]: { 'saved-host-forge': false } } })
    expect(file).not.toContain('made-up-token')
    expect(await d.make().view()).toMatchObject({ copyNew: true, copies: [{ accountId: WORK.id }, { accountId: PERSONAL.id, state: 'off' }] })
  })

  it('says when a copy could not be sent, sends no secret it could not read, and tries again', async () => {
    const d = await desk()
    const forge = fakeHost('host-forge')
    // This computer's credential store is locked: nothing is sent, and the page says so.
    d.world.locked = true
    d.connect(forge)
    await d.sync.idle()
    expect(forge.calls).toEqual(['list'])
    expect(await d.states()).toEqual(['Work@host-forge: locked'])
    expect(d.events).toContain('plugin-account-copies-failed')
    // Unlocked, the next look sends it.
    d.world.locked = false
    d.sync.accountsChanged()
    await d.sync.idle()
    expect(await d.states()).toEqual(['Work@host-forge: kept'])
    // The host stops answering part way: the copy is not called kept.
    forge.state.down = true
    d.world.accounts = [{ ...WORK, on: false }]
    d.sync.accountsChanged()
    await d.sync.idle()
    expect(await d.states()).toEqual(['Work@host-forge: waiting'])
    forge.state.down = false
    d.sync.accountsChanged()
    await d.sync.idle()
    expect(forge.held.get(WORK.id)!.account.on).toBe(false)
  })

  it('sends a copy again to a host that does not say what it holds of it, rather than take it to be the same', async () => {
    const d = await desk()
    const forge = fakeHost('host-forge', { settings: false })
    d.connect(forge)
    await d.sync.idle()
    forge.calls.length = 0
    d.connect(forge)
    await d.sync.idle()
    expect(forge.calls).toEqual(['list', 'keep Work'])
  })

  it('copies nothing while its record of choices cannot be read, rather than everything', async () => {
    const d = await desk()
    await writeFile(join(d.directory, 'plugin-account-copy-choices.json'), 'not json')
    const forge = fakeHost('host-forge')
    d.connect(forge)
    await d.sync.idle()
    expect(forge.calls).toEqual([])
    expect(d.events).toContain('plugin-account-copies-failed')
  })
})
