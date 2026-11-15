// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginAccounts, type PluginCredentials, type SecretCheck } from '../../../../src/main/plugins/accounts'
import { checkMeshyKey, type MeshyFetch } from '../../../../src/main/plugins/meshy/account'

/** Meshy as a plugin account (ADR-0141, ADR-0205; slice 11). Every key here is made up, and nothing reaches Meshy. */
const KEY = 'msy_made_up_key_0123456789'
const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })

/** A made-up Meshy that answers its balance with `status`, and keeps what it was asked. */
function meshy(status: number | Error) {
  const asked: { url: string; init: Parameters<MeshyFetch>[1] }[] = []
  const fetcher: MeshyFetch = async (url, init) => {
    asked.push({ url, init })
    if (status instanceof Error) throw status
    return new Response(status === 200 ? JSON.stringify({ balance: 1000, monthly_credits: 1000, permanent_credits: 0, monthly_resets_at: null }) : '{"message":"made up"}', { status })
  }
  return { fetcher, asked }
}

describe('a Meshy key, checked before it is kept', () => {
  it('asks Meshy for its balance, which is free, with the key as a bearer token and no redirect followed', async () => {
    const { fetcher, asked } = meshy(200)
    expect(await checkMeshyKey(fetcher, KEY)).toEqual({ ok: true, signedInAs: null })
    expect(asked).toHaveLength(1)
    expect(asked[0]!.url).toBe('https://api.meshy.ai/openapi/v1/balance')
    expect(asked[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Authorization: `Bearer ${KEY}` } })
  })

  it('says a key Meshy will not take is refused, one turned away for now is busy, and anything else could not be checked', async () => {
    const answers: [number | Error, SecretCheck][] = [
      [401, { ok: false, problem: 'refused' }],
      // Meshy's free plan has no API access.
      [402, { ok: false, problem: 'refused' }],
      [429, { ok: false, problem: 'busy' }],
      [500, { ok: false, problem: 'unreachable' }],
      [new Error('made-up network failure'), { ok: false, problem: 'unreachable' }],
    ]
    for (const [status, result] of answers) expect(await checkMeshyKey(meshy(status).fetcher, KEY), String(status)).toEqual(result)
    // A key with a line end in it is not one Meshy issued, and is sent nowhere.
    const { fetcher, asked } = meshy(200)
    expect(await checkMeshyKey(fetcher, 'msy_one\r\nX-Other: two')).toEqual({ ok: false, problem: 'refused' })
    expect(asked).toEqual([])
  })
})

describe('a Meshy account in the record of accounts', () => {
  function credentials(): PluginCredentials {
    const slots = new Map<string, string>()
    return { has: slot => slots.has(slot), get: slot => slots.get(slot) ?? '', set: async (slot, value) => { if (value) slots.set(slot, value); else slots.delete(slot) } }
  }
  async function store() {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-meshy-accounts-'))
    folders.push(directory)
    const asked = vi.fn(async (): Promise<SecretCheck> => ({ ok: true, signedInAs: null }))
    return { made: new PluginAccounts(directory, { credentials: credentials(), check: asked, now: () => new Date('2026-11-15T08:00:00.000Z') }), asked, directory }
  }

  it('starts asking before each 3D model, within 1,000 credits a month, in a record older builds refuse', async () => {
    const { made, asked, directory } = await store()
    const added = await made.add({ plugin: 'meshy', name: 'Studio', secret: ` ${KEY} ` })
    expect(added.ok).toBe(true)
    // The key as it is pasted, without the spaces a copy can carry.
    expect(asked).toHaveBeenLastCalledWith('meshy', KEY, undefined)
    expect((await made.list())[0]!.spending).toEqual({ askBefore: true, monthlyLimit: 1_000 })
    const record = JSON.parse(await readFile(join(directory, 'plugin-accounts.json'), 'utf8')) as { version: number }
    expect(record.version).toBe(5)
    expect(JSON.stringify(record)).not.toContain(KEY)
  })

  it('changes the switch and the limit on its own account, and on no account that does not spend', async () => {
    const { made } = await store()
    const studio = await made.add({ plugin: 'meshy', name: 'Studio', secret: KEY })
    const work = await made.add({ plugin: 'vercel', name: 'Work', secret: 'made-up-vercel-token' })
    const studioId = studio.ok ? studio.accounts.find(account => account.plugin === 'meshy')!.id : ''
    const workId = work.ok ? work.accounts.find(account => account.plugin === 'vercel')!.id : ''
    expect((await made.update({ id: studioId, askBefore: false })).ok).toBe(true)
    expect((await made.update({ id: studioId, monthlyLimit: 300 })).ok).toBe(true)
    expect((await made.list()).find(account => account.id === studioId)!.spending).toEqual({ askBefore: false, monthlyLimit: 300 })
    expect(await made.update({ id: workId, askBefore: false })).toEqual({ ok: false, problem: 'refused' })
    expect((await made.list()).find(account => account.id === workId)!.spending).toBeUndefined()
  })
})
