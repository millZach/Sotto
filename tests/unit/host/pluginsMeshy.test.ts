// @vitest-environment node
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hostPlugins } from '../../../src/host/plugins'
import type { PluginCredentials } from '../../../src/main/plugins/accounts'
import { MODEL_COST } from '../../../src/main/plugins/meshy/tool'
import { monthOf } from '../../../src/main/plugins/meshy/spending'
import { MAKE_3D_MODEL_TOOL, type PluginAccount } from '../../../src/shared/plugins'
import { FAKE_MESHY_KEY, startFakeMeshy, type FakeMeshy } from '../../fixtures/fakeMeshy'

/**
 * A paired host's threads make 3D models with the Meshy copy its desktop sent (the Meshy plan's ticket 6, part 1):
 * asking on the card as the desktop's switch says, within the one monthly limit counting what the desktop last said,
 * into the host thread's own folder. Every key and account here is made up; nothing reaches Meshy.
 */
const folders: string[] = []
let meshy: FakeMeshy
let root: string
beforeEach(async () => {
  meshy = await startFakeMeshy()
  meshy.behaviour.readsToFinish = 1
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-host-meshy-thread-')))
  folders.push(root)
})
afterEach(async () => {
  await meshy.close()
  await Promise.all(folders.splice(0).map(made => rm(made, { recursive: true, force: true })))
})

const LAPTOP = 'desktop-laptop', TOWER = 'desktop-tower'
const THREAD = 'a-host-thread'
const STUDIO: PluginAccount = { id: '44444444-4444-4444-8444-000000000001', plugin: 'meshy', name: 'Studio', savedAt: '2026-11-15T08:00:00.000Z', signedInAs: null, on: true, projects: null, spending: { askBefore: true, monthlyLimit: 1_000 } }
const BARREL = { name: 'Oak barrel', words: 'An oak barrel with iron hoops' }
/** The desktops' runs, as each one's reports name it. */
const SESSIONS: Record<string, string> = { [LAPTOP]: '55555555-5555-4555-8555-000000000001', [TOWER]: '55555555-5555-4555-8555-000000000002' }
let revision = 0
/** What a desktop says an account spent elsewhere this month, as the next report of its run. */
const said = (accountId: string, credits: number, clientId = LAPTOP, month = monthOf(new Date())) => ({ accountId, month, credits, session: SESSIONS[clientId]!, revision: ++revision })

function credentials(): PluginCredentials {
  const slots = new Map<string, string>()
  return { has: slot => slots.has(slot), get: slot => slots.get(slot) ?? '', set: async (slot, value) => { if (value) slots.set(slot, value); else slots.delete(slot) } }
}

/** A host's plugins with one open thread working in `root`, its cards answered as `answer` says. */
async function host(options: { answer?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-host-meshy-'))
  folders.push(directory)
  const thread = { id: THREAD, kind: 'agent', projectId: 'project-1', providerId: 'codex' } as never
  const plugins = hostPlugins({ directory, credentials: credentials(), thread: id => id === THREAD ? thread : undefined, admits: id => id === THREAD,
    paired: clientId => clientId === LAPTOP || clientId === TOWER,
    folderOf: async id => id === THREAD ? root : null,
    showInThread: async () => true,
    standIns: { meshyBase: meshy.base, meshyWait: async () => undefined, gh: async () => JSON.stringify({ hosts: {} }) } })
  const cards: string[] = []
  plugins.changes.subscribe(() => {
    for (const request of plugins.changes.requests().get(THREAD) ?? []) {
      if (cards.includes(request.id)) continue
      cards.push(request.id)
      queueMicrotask(() => { try { plugins.changes.answer(THREAD, request.id, options.answer ?? true) } catch { /* Already answered. */ } })
    }
  })
  const make = async (args: Record<string, unknown> = BARREL) => {
    const result = await plugins.tools.call(THREAD, MAKE_3D_MODEL_TOOL, args)
    return { text: result.content.map(part => part.type === 'text' ? part.text : '').join('\n'), failed: result.isError === true }
  }
  /** A desktop sends its copy, and then what the account spent elsewhere, as it does on every reconcile. */
  const keep = async (account: PluginAccount, clientId = LAPTOP, credits = 0) => {
    await plugins.copies.keep({ account, secret: FAKE_MESHY_KEY }, clientId)
    await plugins.spending.share([said(account.id, credits, clientId)], clientId)
  }
  return { plugins, cards, make, keep, directory }
}

describe('a 3D model made on a paired host', () => {
  it('asks on the card while Ask before each is on, makes it into the host thread’s folder with the copy’s key, and asks no more once it is off', async () => {
    const h = await host()
    await h.keep(STUDIO)
    const asked = await h.make()
    expect(asked.failed).toBe(false)
    expect(asked.text).toContain('The user allowed it.')
    expect(h.cards).toHaveLength(1)
    expect((await readdir(join(root, 'models'))).sort()).toEqual(['Oak barrel.glb', 'Oak barrel.png', 'Oak barrel.usdz'])
    expect(meshy.requests.filter(request => request.method === 'POST').map(request => request.authorization)).toEqual([`Bearer ${FAKE_MESHY_KEY}`, `Bearer ${FAKE_MESHY_KEY}`])
    expect(await h.plugins.models.list()).toEqual([expect.objectContaining({ threadId: THREAD, accountId: STUDIO.id, state: 'done', root })])

    // The desktop turns asking off and sends the copy again, as it does on every change (#2591): the next call asks nothing.
    await h.plugins.copies.keep({ account: { ...STUDIO, spending: { askBefore: false, monthlyLimit: 1_000 } }, secret: FAKE_MESHY_KEY }, LAPTOP)
    const unasked = await h.make({ ...BARREL, name: 'Second barrel' })
    expect(unasked.text).toContain('Made without a card')
    expect(h.cards).toHaveLength(1)
    await h.plugins.close()
  })

  it('makes nothing when the user says no on the card', async () => {
    const h = await host({ answer: false })
    await h.keep(STUDIO)
    expect(await h.make()).toMatchObject({ failed: true })
    expect(meshy.created()).toEqual([])
    await h.plugins.close()
  })

  it('refuses one that would pass the one monthly limit, counting what the desktop last said it spent', async () => {
    const h = await host()
    await h.plugins.copies.keep({ account: { ...STUDIO, spending: { askBefore: true, monthlyLimit: 100 } }, secret: FAKE_MESHY_KEY }, LAPTOP)
    await h.plugins.spending.share([said(STUDIO.id, 100 - MODEL_COST.words + 1)], LAPTOP)
    const refused = await h.make()
    expect(refused.failed).toBe(true)
    expect(refused.text).toContain(`${100 - MODEL_COST.words + 1} of the account's monthly limit of 100 credits are used this month`)
    expect(h.cards).toEqual([])
    expect(meshy.created()).toEqual([])
    await h.plugins.close()
  })

  it('keeps to what was left when it last heard from the desktop, and no more, while the desktop is away', async () => {
    const h = await host()
    await h.plugins.copies.keep({ account: { ...STUDIO, spending: { askBefore: false, monthlyLimit: 40 + 2 * MODEL_COST.words } }, secret: FAKE_MESHY_KEY }, LAPTOP)
    // The desktop last said 40 were spent elsewhere; then it went away.
    await h.plugins.spending.share([said(STUDIO.id, 40)], LAPTOP)
    expect(await h.make({ ...BARREL, name: 'One' })).toMatchObject({ failed: false })
    expect(await h.make({ ...BARREL, name: 'Two' })).toMatchObject({ failed: false })
    const third = await h.make({ ...BARREL, name: 'Three' })
    expect(third.failed).toBe(true)
    expect(third.text).toContain('would pass the limit')
    expect(meshy.created('preview')).toHaveLength(2)
    await h.plugins.close()
  })

  it('sends a photo with its location and camera taken out of the file, and its pixels as they were', async () => {
    const h = await host()
    await h.keep(STUDIO)
    const segment = (marker: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([0xff, marker, (body.byteLength + 2) >> 8, (body.byteLength + 2) & 0xff]), body])
    const picture = [segment(0xc0, Buffer.from([0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 1, 0x11, 0])), segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0x34, 0xff, 0x00])]
    const exif = segment(0xe1, Buffer.from('Exif\0\0GPS 51.5007 N 0.1246 W', 'latin1'))
    await writeFile(join(root, 'barrel.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8]), exif, ...picture, Buffer.from([0xff, 0xd9])]))
    expect(await h.make({ name: 'Barrel', photo: 'barrel.jpg' })).toMatchObject({ failed: false })
    const sent = String(meshy.created('photo')[0]!.body['image_url'])
    const bytes = Buffer.from(sent.replace('data:image/jpeg;base64,', ''), 'base64')
    expect(bytes.equals(Buffer.concat([Buffer.from([0xff, 0xd8]), ...picture, Buffer.from([0xff, 0xd9])]))).toBe(true)
    await h.plugins.close()
  })
})

describe('shared spending on a paired host (ADR-0205)', () => {
  it('answers a desktop with its own credits for that desktop’s copies alone, and keeps nothing it says of another’s', async () => {
    const h = await host()
    const other: PluginAccount = { ...STUDIO, id: '44444444-4444-4444-8444-000000000002', name: 'Tower studio', spending: { askBefore: false, monthlyLimit: 1_000 } }
    await h.plugins.copies.keep({ account: { ...STUDIO, spending: { askBefore: false, monthlyLimit: 1_000 } }, secret: FAKE_MESHY_KEY }, LAPTOP)
    await h.keep(other, TOWER)
    let told = 0
    h.plugins.spending.subscribe(() => { told += 1 })
    const month = monthOf(new Date())
    await expect(h.plugins.spending.share([said(STUDIO.id, 0)], LAPTOP)).resolves.toEqual([{ accountId: STUDIO.id, month, credits: 0, session: expect.any(String), revision: expect.any(Number) }])
    expect(await h.make({ account: 'Studio', ...BARREL })).toMatchObject({ failed: false })
    await expect(h.plugins.spending.own(LAPTOP)).resolves.toMatchObject([{ accountId: STUDIO.id, month, credits: MODEL_COST.words }])
    await expect(h.plugins.spending.own(TOWER)).resolves.toMatchObject([{ accountId: other.id, month, credits: 0 }])
    // Its own count moved, so its desktops are told.
    await expect.poll(() => told).toBeGreaterThan(0)
    // The laptop speaks for the tower's copy: nothing of it is kept, so the tower's account is not held back.
    await h.plugins.spending.share([said(other.id, 1_000)], LAPTOP)
    expect(await h.make({ account: 'Tower studio', ...BARREL })).toMatchObject({ failed: false })
    await h.plugins.close()
  })
})
