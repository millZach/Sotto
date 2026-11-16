// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginAccounts, type PluginCredentials, type SecretCheck } from '../../../../src/main/plugins/accounts'
import { checkHiggsfieldKey, type HiggsfieldFetch } from '../../../../src/main/plugins/higgsfield/account'
import { pluginAccountAddSchema, pluginAccountReplaceSchema } from '../../../../src/shared/plugins'

/** Higgsfield as a plugin account (ADR-0205; slice 13). Every key here is made up, and nothing reaches Higgsfield. */
const KEY_ID = 'made-up-key-id-0123'
const KEY_SECRET = 'made_up_key_secret_456789'
const PAIR = `${KEY_ID}:${KEY_SECRET}`
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })

/** A made-up Higgsfield that answers the usage report with `status`, and keeps what it was asked. */
function higgsfield(status: number | Error) {
  const asked: { url: string; init: Parameters<HiggsfieldFetch>[1] }[] = []
  const fetcher: HiggsfieldFetch = async (url, init) => {
    asked.push({ url, init })
    if (status instanceof Error) throw status
    return new Response(status === 200 ? JSON.stringify({ items: [] }) : '{"detail":"Invalid credentials"}', { status })
  }
  return { fetcher, asked }
}

describe('a Higgsfield key, checked before it is kept', () => {
  it('reads the usage report, which makes nothing, with the key ID and secret in a Key header and no redirect followed', async () => {
    const { fetcher, asked } = higgsfield(200)
    expect(await checkHiggsfieldKey(fetcher, PAIR)).toEqual({ ok: true, signedInAs: null })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.url).toBe('https://api.higgsfield.ai/models/usage')
    expect(asked[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Authorization: `Key ${PAIR}` } })
  })

  it('reaches the stand-in an end-to-end run names instead', async () => {
    const { fetcher, asked } = higgsfield(200)
    expect(await checkHiggsfieldKey(fetcher, PAIR, { base: 'http://127.0.0.1:4100' })).toEqual({ ok: true, signedInAs: null })
    expect(asked[0]!.url).toBe('http://127.0.0.1:4100/models/usage')
  })

  it('says a key Higgsfield will not take is refused, one turned away for now is busy, and anything else could not be checked', async () => {
    const answers: [number | Error, SecretCheck][] = [
      [401, { ok: false, problem: 'refused' }],
      [403, { ok: false, problem: 'refused' }],
      [429, { ok: false, problem: 'busy' }],
      [302, { ok: false, problem: 'unreachable' }],
      [500, { ok: false, problem: 'unreachable' }],
      [new Error('made-up network failure'), { ok: false, problem: 'unreachable' }],
    ]
    for (const [status, result] of answers) expect(await checkHiggsfieldKey(higgsfield(status).fetcher, PAIR), String(status)).toEqual(result)
  })

  it('sends nowhere a key ID or secret that holds a colon, a line end or anything a header cannot carry', async () => {
    const { fetcher, asked } = higgsfield(200)
    for (const pair of [KEY_SECRET, `${KEY_ID}:`, `:${KEY_SECRET}`, `${KEY_ID}:one:two`, `made:up:${KEY_SECRET}`, `${KEY_ID}:one\r\nX-Other: two`, `made up:${KEY_SECRET}`, `${KEY_ID}:sécret`]) {
      expect(await checkHiggsfieldKey(fetcher, pair), pair).toEqual({ ok: false, problem: 'refused' })
    }
    expect(asked).toEqual([])
  })
})

describe('a Higgsfield account as the add and Replace forms send it', () => {
  it('needs a key ID beside the key secret, each one part, and no other plugin takes one', () => {
    const add = (request: unknown): boolean => pluginAccountAddSchema.safeParse(request).success
    expect(add({ plugin: 'higgsfield', name: 'Studio', keyId: KEY_ID, secret: KEY_SECRET })).toBe(true)
    expect(add({ plugin: 'higgsfield', name: 'Studio', secret: KEY_SECRET })).toBe(false)
    expect(add({ plugin: 'higgsfield', name: 'Studio', keyId: 'made:up', secret: KEY_SECRET })).toBe(false)
    expect(add({ plugin: 'higgsfield', name: 'Studio', keyId: KEY_ID, secret: 'one:two' })).toBe(false)
    expect(add({ plugin: 'higgsfield', name: 'Studio', keyId: KEY_ID, secret: 'one\ntwo' })).toBe(false)
    expect(add({ plugin: 'elevenlabs', name: 'Voices', keyId: KEY_ID, secret: KEY_SECRET })).toBe(false)
    // The key ID comes through trimmed.
    expect(pluginAccountAddSchema.parse({ plugin: 'higgsfield', name: 'Studio', keyId: ` ${KEY_ID} `, secret: KEY_SECRET }).keyId).toBe(KEY_ID)
    expect(pluginAccountReplaceSchema.safeParse({ id: '33333333-3333-4333-8333-000000000001', keyId: 'one two', secret: KEY_SECRET }).success).toBe(false)
  })
})

describe('a Higgsfield account in the record of accounts', () => {
  function credentials() {
    const slots = new Map<string, string>()
    const store: PluginCredentials = { has: slot => slots.has(slot), get: slot => slots.get(slot) ?? '', set: async (slot, value) => { if (value) slots.set(slot, value); else slots.delete(slot) } }
    return { store, slots }
  }
  async function store() {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-higgsfield-accounts-'))
    folders.push(directory)
    const asked = vi.fn(async (): Promise<SecretCheck> => ({ ok: true, signedInAs: null }))
    const { store: kept, slots } = credentials()
    return { made: new PluginAccounts(directory, { credentials: kept, check: asked, now: () => new Date('2026-11-16T08:00:00.000Z') }), asked, directory, slots }
  }

  it('keeps the key ID and secret trimmed in one slot, starts asking before each video within $10 a month, in a record builds from before Higgsfield refuse', async () => {
    const { made, asked, directory, slots } = await store()
    expect((await made.add({ plugin: 'elevenlabs', name: 'Studio', secret: 'sk_made_up_elevenlabs_key' })).ok).toBe(true)
    const added = await made.add({ plugin: 'higgsfield', name: 'Studio', keyId: ` ${KEY_ID} `, secret: ` ${KEY_SECRET}\t` })
    expect(added.ok).toBe(true)
    // Checked and kept as Higgsfield's header carries them, without the spaces a copy can carry.
    expect(asked).toHaveBeenLastCalledWith('higgsfield', PAIR, undefined)
    const accounts = await made.list()
    const studio = accounts.find(account => account.plugin === 'higgsfield')!
    expect(made.secret(studio.id)).toBe(PAIR)
    expect([...slots.values()].filter(value => value.includes(KEY_SECRET))).toEqual([PAIR])
    expect(studio.spending).toEqual({ askBefore: true, monthlyLimit: 10 })
    const record = JSON.parse(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')) as { version: number }
    expect(record.version).toBe(7)
    expect(JSON.stringify(record)).not.toContain(KEY_SECRET)
    expect(JSON.stringify(record)).not.toContain(KEY_ID)
    // Without it, the record is the one a build from before Higgsfield reads.
    expect((await made.remove({ id: studio.id })).ok).toBe(true)
    expect((JSON.parse(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')) as { version: number }).version).toBe(6)
  })

  it('refuses a key ID or secret that holds a colon, or a key with no key ID, before anything is checked', async () => {
    const { made, asked } = await store()
    expect(await made.add({ plugin: 'higgsfield', name: 'Studio', keyId: 'made:up', secret: KEY_SECRET })).toEqual({ ok: false, problem: 'refused' })
    expect(await made.add({ plugin: 'higgsfield', name: 'Studio', keyId: KEY_ID, secret: 'one:two' })).toEqual({ ok: false, problem: 'refused' })
    expect(await made.add({ plugin: 'higgsfield', name: 'Studio', secret: PAIR })).toEqual({ ok: false, problem: 'refused' })
    expect(await made.add({ plugin: 'meshy', name: 'Studio', keyId: KEY_ID, secret: 'msy_made_up_key' })).toEqual({ ok: false, problem: 'refused' })
    expect(asked).not.toHaveBeenCalled()
  })

  it('replaces the key whole, a new key ID beside its new secret, and changes its switch and its limit in dollars', async () => {
    const { made, asked } = await store()
    const added = await made.add({ plugin: 'higgsfield', name: 'Videos', keyId: KEY_ID, secret: KEY_SECRET })
    const id = added.ok ? added.accounts[0]!.id : ''
    expect(await made.replace({ id, secret: 'made_up_new_secret' })).toEqual({ ok: false, problem: 'refused' })
    expect(made.secret(id)).toBe(PAIR)
    expect((await made.replace({ id, keyId: ' made-up-new-id ', secret: 'made_up_new_secret ' })).ok).toBe(true)
    expect(asked).toHaveBeenLastCalledWith('higgsfield', 'made-up-new-id:made_up_new_secret', undefined)
    expect(made.secret(id)).toBe('made-up-new-id:made_up_new_secret')
    expect((await made.update({ id, askBefore: false })).ok).toBe(true)
    expect((await made.update({ id, monthlyLimit: 25 })).ok).toBe(true)
    expect((await made.list())[0]!.spending).toEqual({ askBefore: false, monthlyLimit: 25 })
  })
})
