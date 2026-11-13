// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
function fakeHost(hostId: string, options: { feature?: boolean; settings?: boolean; refuses?: PluginAccountCopyReceipt; room?: number } = {}) {
  const held = new Map<string, PluginAccountCopy>()
  const calls: string[] = []
  /** `down`: nothing is answered. `keeps`: a removal is not answered. `asked`: a list waits for it, as a slow host's does. */
  const state: { down: boolean; keeps: boolean; asked?: Promise<void> } = { down: false, keeps: false }
  const target: CopyTarget = { hostId, kind: 'remote', service: {
    supportsPluginAccountCopies: options.feature !== false,
    keepPluginAccountCopy: async copy => {
      calls.push(`keep ${copy.account.name}`)
      if (state.down) throw new Error('The host did not answer.')
      if (options.refuses) return options.refuses
      // A host holds only so many accounts of a plugin, and counts the ones it has not been told to let go.
      if (options.room !== undefined && !held.has(copy.account.id) && held.size >= options.room) return { kept: false, problem: 'limit' }
      held.set(copy.account.id, copy)
      return { kept: true, keptAt: '2026-11-12T09:00:00.000Z' }
    },
    removePluginAccountCopy: async id => { calls.push(`remove ${held.get(id)?.account.name ?? id}`); if (state.down || state.keeps) throw new Error('The host did not answer.'); held.delete(id); return { removed: true } },
    pluginAccountCopies: async () => {
      calls.push('list')
      if (state.down) throw new Error('The host did not answer.')
      const now = [...held.values()]
      await state.asked
      // A host from before the settings were listed says only which account and the day its secret was saved.
      return now.map(({ account }): HeldPluginAccountCopy => options.settings === false ? { id: account.id, plugin: account.plugin, savedAt: account.savedAt }
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
  const states = async (): Promise<string[]> => (await sync.view()).copies.map(copy => `${world.accounts.find(account => account.id === copy.accountId)!.name}@${copy.computerId.replace('saved-', '')}: ${copy.state}${copy.leaving === 'no' ? '' : ` (leaving ${copy.leaving})`}`)
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

  it('sends no secret for an account narrowed, or a copy switched off, while the host was still answering', async () => {
    // A copy sent cannot be unsent, so a look that began before the change must not send what the change stops.
    for (const change of ['narrowed', 'switched off'] as const) {
      const d = await desk()
      const forge = fakeHost('host-forge')
      let answer!: () => void
      forge.state.asked = new Promise<void>(resolve => { answer = resolve })
      d.connect(forge)
      // The host has been asked what it holds and has not answered yet.
      await expect.poll(() => forge.calls).toEqual(['list'])
      if (change === 'narrowed') { d.world.accounts = [{ ...WORK, projects: ['folder:one'] }]; d.sync.accountsChanged() }
      else void d.sync.setCopy(WORK.id, 'saved-host-forge', false)
      delete forge.state.asked
      answer()
      await d.sync.idle()
      expect(forge.calls.filter(call => call.startsWith('keep')), change).toEqual([])
      expect(forge.held.size, change).toBe(0)
      expect(await d.states(), change).toEqual([change === 'narrowed' ? 'Work@host-forge: here-only' : 'Work@host-forge: off'])
    }
  })

  it('sends no secret from a look that begins while a copy is being switched off', async () => {
    const d = await desk()
    const forge = fakeHost('host-forge')
    d.connect(forge)
    await d.sync.idle()
    // forge lost what it held, as a host set up again has, so a look that still wanted a copy would send one.
    forge.held.clear()
    forge.calls.length = 0
    // The choice is asked for and not yet written down when forge connects again and a new look begins.
    const off = d.sync.setCopy(WORK.id, 'saved-host-forge', false)
    d.connect(forge)
    await off
    await d.sync.idle()
    expect(forge.calls.filter(call => call.startsWith('keep'))).toEqual([])
    expect(forge.held.size).toBe(0)
    expect(await d.states()).toEqual(['Work@host-forge: off'])
  })

  it('looks at a host again when a choice could not be written down, so a look it stopped is not the last', async () => {
    const d = await desk()
    const forge = fakeHost('host-forge')
    d.connect(forge)
    await d.sync.idle()
    forge.held.clear()
    forge.calls.length = 0
    // A look is waiting on forge's answer when the copy is switched off, and the choice cannot be written down.
    let answer!: () => void
    forge.state.asked = new Promise<void>(resolve => { answer = resolve })
    d.connect(forge)
    await expect.poll(() => forge.calls).toEqual(['list'])
    await mkdir(join(d.directory, 'plugin-account-copy-choices.json.next'))
    await expect(d.sync.setCopy(WORK.id, 'saved-host-forge', false)).rejects.toThrow()
    delete forge.state.asked
    answer()
    await d.sync.idle()
    // Nothing was changed, so the copy is still wanted, and the look after the stopped one sends it.
    expect(forge.calls.filter(call => call.startsWith('keep'))).toEqual(['keep Work'])
    expect(await d.states()).toEqual(['Work@host-forge: kept'])
  })

  it('does not say a host that cannot speak of copies holds none, nor count one it has not been asked of', async () => {
    // A host that kept copies and now runs a build that does not, such as stable, still has what it was sent.
    const d = await desk()
    const stable = fakeHost('host-forge', { feature: false })
    d.connect(stable)
    await d.sync.setCopy(WORK.id, 'saved-host-forge', false)
    await d.sync.idle()
    expect(stable.calls).toEqual([])
    expect(await d.states()).toEqual(['Work@host-forge: off (leaving cannot)'])
    // A host that has not answered what it holds is still being asked: nothing says it holds a copy.
    const e = await desk()
    await e.sync.setCopyNew(false)
    const forge = fakeHost('host-forge')
    forge.state.down = true
    e.connect(forge)
    await e.sync.idle()
    expect(await e.states()).toEqual(['Work@host-forge: off (leaving asking)'])
    forge.state.down = false
    e.sync.accountsChanged()
    await e.sync.idle()
    expect(await e.states()).toEqual(['Work@host-forge: off'])
  })

  it('keeps both of two choices made a moment apart', async () => {
    const d = await desk()
    const forge = fakeHost('host-forge')
    const anvil = fakeHost('host-anvil')
    d.connect(forge)
    d.connect(anvil, 'anvil')
    await d.sync.idle()
    expect([forge.held.size, anvil.held.size]).toEqual([1, 1])
    // Neither waits for the other to be written down.
    await Promise.all([d.sync.setCopy(WORK.id, 'saved-host-forge', false), d.sync.setCopy(WORK.id, 'saved-host-anvil', false)])
    await d.sync.idle()
    expect(JSON.parse(await readFile(join(d.directory, 'plugin-account-copy-choices.json'), 'utf8')).choices[WORK.id]).toEqual({ 'saved-host-forge': false, 'saved-host-anvil': false })
    expect([forge.held.size, anvil.held.size]).toEqual([0, 0])
    expect(await d.states()).toEqual(['Work@host-forge: off', 'Work@host-anvil: off'])
  })

  it('does not say a host holds no copy until the host has said so', async () => {
    const d = await desk()
    const forge = fakeHost('host-forge')
    d.connect(forge)
    await d.sync.idle()
    // Switched off while forge is away: forge still holds the copy, and is told when it is back.
    d.leave(forge)
    await d.sync.setCopy(WORK.id, 'saved-host-forge', false)
    await d.sync.idle()
    expect(forge.held.size).toBe(1)
    expect(await d.states()).toEqual(['Work@host-forge: off (leaving away)'])
    // Back, but its removal is not answered: it may still hold it.
    forge.state.keeps = true
    d.connect(forge)
    await d.sync.idle()
    expect(forge.held.size).toBe(1)
    expect(await d.states()).toEqual(['Work@host-forge: off (leaving now)'])
    // The removal is answered: only now is there no copy.
    forge.state.keeps = false
    d.sync.accountsChanged()
    await d.sync.idle()
    expect(forge.held.size).toBe(0)
    expect(await d.states()).toEqual(['Work@host-forge: off'])
    // Away again, nothing is leaving: it was seen to hold none, and nothing has been sent since.
    d.leave(forge)
    expect(await d.states()).toEqual(['Work@host-forge: off'])
    // An account kept to projects says the same of a copy made before it was narrowed.
    await d.sync.setCopy(WORK.id, 'saved-host-forge', true)
    d.connect(forge)
    await d.sync.idle()
    expect(await d.states()).toEqual(['Work@host-forge: kept'])
    d.leave(forge)
    d.world.accounts = [{ ...WORK, projects: ['folder:one'] }]
    d.sync.accountsChanged()
    await d.sync.idle()
    expect(await d.states()).toEqual(['Work@host-forge: here-only (leaving away)'])
    d.connect(forge)
    await d.sync.idle()
    expect(await d.states()).toEqual(['Work@host-forge: here-only'])
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
    expect(await d.make().view()).toMatchObject({ copyNew: true, readable: true, copies: [{ accountId: WORK.id }, { accountId: PERSONAL.id, state: 'off' }] })
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
    expect(await d.states()).toEqual(['Work@host-forge: failed'])
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
    expect(forge.calls).toEqual(['list'])
    expect(forge.held.size).toBe(0)
    expect(d.events).toContain('plugin-account-copies-failed')
  })

  it('still takes back the copy of an account removed or kept to projects while its choices cannot be read, and still shows the page', async () => {
    // Removing an account removes every copy (ADR-0205), whatever has become of the record of choices.
    const third = { ...WORK, id: '22222222-2222-4222-8222-000000000003', name: 'Client' }
    const d = await desk([WORK, PERSONAL, third])
    const forge = fakeHost('host-forge')
    d.connect(forge)
    await d.sync.idle()
    expect(forge.held.size).toBe(3)
    // A newer Sotto wrote the record, in a form this one does not read.
    await writeFile(join(d.directory, 'plugin-account-copy-choices.json'), JSON.stringify({ version: 2, copyNew: true, choices: {} }))
    const later = d.make()
    // Work is removed and Personal kept to a project. Client is as it was, with a new token.
    d.world.accounts = [{ ...PERSONAL, projects: ['folder:one'] }, { ...third, savedAt: '2026-11-13T08:00:00.000Z' }]
    forge.calls.length = 0
    d.events.length = 0
    later.connected(forge.target)
    await later.idle()
    // Both copies are taken back. Client's is neither sent again nor taken back: nothing says whether it is wanted.
    expect(forge.calls).toEqual(['list', 'remove Work', 'remove Personal'])
    expect([...forge.held.keys()]).toEqual([third.id])
    // It is still a look that failed, so it is tried again.
    expect(d.events).toEqual(['plugin-account-copies-failed'])
    // The page is told the record cannot be read, and what forge holds all the same.
    expect(await later.view()).toEqual({ copyNew: false, readable: false, computers: [{ id: 'saved-host-forge', name: 'forge', connected: true }], copies: [
      { accountId: PERSONAL.id, computerId: 'saved-host-forge', state: 'here-only', leaving: 'no' },
      { accountId: third.id, computerId: 'saved-host-forge', state: 'kept', leaving: 'no' },
    ] })
    // No choice can be made of it: nothing is written over a record that could not be read.
    await expect(later.setCopy(third.id, 'saved-host-forge', false)).rejects.toThrow()
    await later.idle()
    expect(JSON.parse(await readFile(join(d.directory, 'plugin-account-copy-choices.json'), 'utf8')).version).toBe(2)
    expect([...forge.held.keys()]).toEqual([third.id])
    later.close()
  })

  it('takes back what is no longer wanted before it sends, so a host holding all it can has room for a new copy', async () => {
    const d = await desk([WORK, PERSONAL])
    const forge = fakeHost('host-forge', { room: 2 })
    d.connect(forge)
    await d.sync.idle()
    expect(forge.held.size).toBe(2)
    // While forge is away, Work is removed and Client added.
    d.leave(forge)
    const third = { ...WORK, id: '22222222-2222-4222-8222-000000000003', name: 'Client' }
    d.world.accounts = [PERSONAL, third]
    d.sync.accountsChanged()
    await d.sync.idle()
    forge.calls.length = 0
    d.connect(forge)
    await d.sync.idle()
    expect(forge.calls).toEqual(['list', 'remove Work', 'keep Client'])
    expect([...forge.held.keys()].sort()).toEqual([PERSONAL.id, third.id])
    expect(await d.states()).toEqual(['Personal@host-forge: kept', 'Client@host-forge: kept'])
  })
})
