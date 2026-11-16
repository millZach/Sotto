// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginAccounts, type PluginCredentials, type SecretCheck } from '../../../../src/main/plugins/accounts'
import { checkElevenLabsKey, type ElevenLabsFetch } from '../../../../src/main/plugins/elevenlabs/account'

/** ElevenLabs as a plugin account (ADR-0205; slice 12). Every key here is made up, and nothing reaches ElevenLabs. */
const KEY = 'sk_made_up_elevenlabs_key_0123456789'
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })

/** A made-up ElevenLabs that answers the account's subscription with `status`, and keeps what it was asked. */
function elevenLabs(status: number | Error) {
  const asked: { url: string; init: Parameters<ElevenLabsFetch>[1] }[] = []
  const fetcher: ElevenLabsFetch = async (url, init) => {
    asked.push({ url, init })
    if (status instanceof Error) throw status
    return new Response(status === 200 ? JSON.stringify({ tier: 'creator', character_count: 1200, character_limit: 100000, status: 'active' }) : '{"detail":{"status":"made_up"}}', { status })
  }
  return { fetcher, asked }
}

describe('an ElevenLabs key, checked before it is kept', () => {
  it('reads the account\'s subscription, which makes nothing, with the key in its own header and no redirect followed', async () => {
    const { fetcher, asked } = elevenLabs(200)
    expect(await checkElevenLabsKey(fetcher, KEY)).toEqual({ ok: true, signedInAs: null })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.url).toBe('https://api.elevenlabs.io/v1/user/subscription')
    expect(asked[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'xi-api-key': KEY } })
  })

  it('says a key ElevenLabs will not take is refused, one turned away for now is busy, and anything else could not be checked', async () => {
    const answers: [number | Error, SecretCheck][] = [
      [401, { ok: false, problem: 'refused' }],
      // A restricted key that may not read the account.
      [403, { ok: false, problem: 'refused' }],
      [429, { ok: false, problem: 'busy' }],
      [500, { ok: false, problem: 'unreachable' }],
      [new Error('made-up network failure'), { ok: false, problem: 'unreachable' }],
    ]
    for (const [status, result] of answers) expect(await checkElevenLabsKey(elevenLabs(status).fetcher, KEY), String(status)).toEqual(result)
    // A key with a line end in it is not one ElevenLabs issued, and is sent nowhere.
    const { fetcher, asked } = elevenLabs(200)
    expect(await checkElevenLabsKey(fetcher, 'sk_one\r\nX-Other: two')).toEqual({ ok: false, problem: 'refused' })
    expect(asked).toEqual([])
  })
})

describe('an ElevenLabs account in the record of accounts', () => {
  function credentials(): PluginCredentials {
    const slots = new Map<string, string>()
    return { has: slot => slots.has(slot), get: slot => slots.get(slot) ?? '', set: async (slot, value) => { if (value) slots.set(slot, value); else slots.delete(slot) } }
  }
  async function store() {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-elevenlabs-accounts-'))
    folders.push(directory)
    const asked = vi.fn(async (): Promise<SecretCheck> => ({ ok: true, signedInAs: null }))
    return { made: new PluginAccounts(directory, { credentials: credentials(), check: asked, now: () => new Date('2026-11-15T08:00:00.000Z') }), asked, directory }
  }

  it('starts asking before each sound, within $10 a month, in a record builds from before ElevenLabs refuse', async () => {
    const { made, asked, directory } = await store()
    expect((await made.add({ plugin: 'meshy', name: 'Studio', secret: 'msy_made_up_key' })).ok).toBe(true)
    const added = await made.add({ plugin: 'elevenlabs', name: 'Studio', secret: ` ${KEY} ` })
    expect(added.ok).toBe(true)
    // The key as it is pasted, without the spaces a copy can carry.
    expect(asked).toHaveBeenLastCalledWith('elevenlabs', KEY, undefined)
    const accounts = await made.list()
    expect(accounts.find(account => account.plugin === 'elevenlabs')!.spending).toEqual({ askBefore: true, monthlyLimit: 10 })
    // Meshy's own limit is still its credits.
    expect(accounts.find(account => account.plugin === 'meshy')!.spending).toEqual({ askBefore: true, monthlyLimit: 1_000 })
    const record = JSON.parse(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')) as { version: number }
    expect(record.version).toBe(6)
    expect(JSON.stringify(record)).not.toContain(KEY)
    // Without it, the record is the one a build from before ElevenLabs reads.
    const elevenLabsId = accounts.find(account => account.plugin === 'elevenlabs')!.id
    expect((await made.remove({ id: elevenLabsId })).ok).toBe(true)
    expect((JSON.parse(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')) as { version: number }).version).toBe(5)
  })

  it('changes its switch and its limit in dollars', async () => {
    const { made } = await store()
    const added = await made.add({ plugin: 'elevenlabs', name: 'Voices', secret: KEY })
    const id = added.ok ? added.accounts[0]!.id : ''
    expect((await made.update({ id, askBefore: false })).ok).toBe(true)
    expect((await made.update({ id, monthlyLimit: 25 })).ok).toBe(true)
    expect((await made.list())[0]!.spending).toEqual({ askBefore: false, monthlyLimit: 25 })
  })
})
