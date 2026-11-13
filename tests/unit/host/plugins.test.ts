// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostPlugins } from '../../../src/host/plugins'
import { pluginAccountSlot, type PluginCredentials } from '../../../src/main/plugins/accounts'
import type { VercelFetch } from '../../../src/main/plugins/vercel/read'
import type { PluginAccount } from '../../../src/shared/plugins'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(made => rm(made, { recursive: true, force: true }))) })

/** Made-up values: nothing here is a real credential. */
const TOKEN = 'made-up-token-of-a-revoked-desktop'
const WORK: PluginAccount = { id: '22222222-2222-4222-8222-000000000001', plugin: 'vercel', name: 'Work', savedAt: '2026-11-12T08:00:00.000Z', signedInAs: 'example-user', on: true, projects: null }
const PERSONAL: PluginAccount = { ...WORK, id: '22222222-2222-4222-8222-000000000002', name: 'Personal' }
const LAPTOP = 'desktop-laptop', TOWER = 'desktop-tower'

/** A credential store held in memory. `failingClear` makes deleting a secret fail, as a credential file that cannot be written does. */
function credentials() {
  const slots = new Map<string, string>()
  const state = { failingClear: false }
  const store: PluginCredentials = {
    has: slot => slots.has(slot),
    get: slot => slots.get(slot) ?? '',
    set: async (slot, value) => {
      if (!value && state.failingClear) throw new Error('The credential file could not be written.')
      if (value) slots.set(slot, value); else slots.delete(slot)
    },
  }
  return { store, slots, state }
}

/** A host's plugins over a folder, with the desktops named as paired, and what its threads' calls send to Vercel. */
async function host(directory?: string, kept = credentials()) {
  if (!directory) { directory = await mkdtemp(join(tmpdir(), 'sotto-host-plugins-')); folders.push(directory) }
  const paired = new Set([LAPTOP, TOWER])
  const sent: { url: string; authorization: string | undefined }[] = []
  const vercelFetch: VercelFetch = async (url, init) => {
    sent.push({ url, authorization: init.headers['Authorization'] })
    return new Response(JSON.stringify({ user: { username: 'example-user' } }), { status: 200 })
  }
  const plugins = hostPlugins({ directory, credentials: kept.store, thread: () => undefined, admits: () => true, paired: clientId => paired.has(clientId),
    standIns: { vercelFetch, vercelBase: 'http://127.0.0.1:9', gh: async () => JSON.stringify({ hosts: {} }) } })
  /** One of the host's threads calls a tool, and what it is told. */
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await plugins.tools.call('a-host-thread', name, args)
    return { text: result.content.map(part => part.type === 'text' ? part.text : '').join('\n'), failed: result.isError === true }
  }
  return { directory, kept, paired, plugins, sent, call }
}

describe('a host’s threads and the copies of a desktop that is no longer paired (ADR-0205)', () => {
  it('uses nothing of a revoked desktop’s copy when deleting it failed: not its name, and not its token', async () => {
    const h = await host()
    await expect(h.plugins.copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)).resolves.toMatchObject({ kept: true })
    await expect(h.plugins.copies.keep({ account: PERSONAL, secret: 'made-up-token-of-a-paired-desktop' }, TOWER)).resolves.toMatchObject({ kept: true })
    expect((await h.call('plugin_accounts', {})).text).toContain('"Work"')
    await h.call('plugin_read', { plugin: 'vercel', account: 'Work', path: 'v2/user' })
    expect(h.sent.map(made => made.authorization)).toEqual([`Bearer ${TOKEN}`])

    // The laptop is revoked while the credential file cannot be written: its copy is still in the host's files.
    h.sent.length = 0
    h.kept.state.failingClear = true
    h.paired.delete(LAPTOP)
    await h.plugins.copies.forgetDesktop(LAPTOP).catch(() => undefined)
    expect(h.kept.slots.get(pluginAccountSlot(WORK.id))).toBe(TOKEN)

    // No thread is told of it or reads through it, named or not, and nothing is sent to Vercel with its token.
    const listed = await h.call('plugin_accounts', {})
    expect(listed.text).not.toContain('Work')
    expect(listed.text).toContain('"Personal"')
    expect(await h.call('plugin_read', { plugin: 'vercel', account: 'Work', path: 'v2/user' })).toMatchObject({ failed: true })
    expect(h.sent).toEqual([])
    // The other desktop's copy is as it was.
    expect(await h.call('plugin_read', { plugin: 'vercel', account: 'Personal', path: 'v2/user' })).toMatchObject({ failed: false })
    expect(h.sent.map(made => made.authorization)).toEqual(['Bearer made-up-token-of-a-paired-desktop'])
    await h.plugins.close()
  })

  it('reads no token for a copy whose desktop was revoked while a thread’s call was looking for it', async () => {
    // Whether the sender is paired is asked as the account is looked for and again as its token is read, not once at the start.
    const h = await host()
    await h.plugins.copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)
    let revokedWhileReading = false
    const read = h.kept.store.get.bind(h.kept.store)
    h.kept.store.get = slot => { revokedWhileReading = true; return read(slot) }
    // The desktop is revoked once the call has read who sent each copy.
    const find = h.plugins.copies.senders.bind(h.plugins.copies)
    h.plugins.copies.senders = async () => { const senders = await find(); queueMicrotask(() => { h.paired.delete(LAPTOP) }); return senders }
    expect(await h.call('plugin_read', { plugin: 'vercel', account: 'Work', path: 'v2/user' })).toMatchObject({ failed: true })
    expect(h.sent).toEqual([])
    expect(revokedWhileReading).toBe(false)
    await h.plugins.close()
  })

  it('deletes what no paired desktop sent when the host starts', async () => {
    const first = await host()
    await first.plugins.copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)
    await first.plugins.copies.keep({ account: PERSONAL, secret: 'made-up-token-of-a-paired-desktop' }, TOWER)
    // The laptop was revoked as the host went away: nothing was deleted.
    await first.plugins.close()
    // It starts again, and its credential file can be written.
    const again = await host(first.directory, first.kept)
    again.paired.delete(LAPTOP)
    await again.plugins.copies.forgetUnpaired(clientId => again.paired.has(clientId))
    expect([...first.kept.slots.keys()]).toEqual([pluginAccountSlot(PERSONAL.id)])
    expect(JSON.parse(await readFile(join(first.directory, 'plugin-accounts.json'), 'utf8')).accounts.map((account: { name: string }) => account.name)).toEqual(['Personal'])
    expect(JSON.parse(await readFile(join(first.directory, 'plugin-account-copy-senders.json'), 'utf8')).senders).toEqual({ [PERSONAL.id]: TOWER })
    // The paired desktop's copy is untouched, and still its own to list.
    await expect(again.plugins.copies.list(TOWER)).resolves.toMatchObject([{ id: PERSONAL.id }])
    await again.plugins.close()
  })

  it('uses no copy while it cannot read who sent them', async () => {
    const h = await host()
    await h.plugins.copies.keep({ account: WORK, secret: TOKEN }, LAPTOP)
    h.plugins.copies.senders = async () => { throw new Error('The senders could not be read.') }
    expect((await h.call('plugin_accounts', {})).text).not.toContain('Work')
    expect(await h.call('plugin_read', { plugin: 'vercel', account: 'Work', path: 'v2/user' })).toMatchObject({ failed: true })
    expect(h.sent).toEqual([])
    await h.plugins.close()
  })
})
