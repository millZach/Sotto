// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hostPlugins } from '../../../src/host/plugins'
import type { PluginCredentials } from '../../../src/main/plugins/accounts'
import { monthOf } from '../../../src/main/plugins/spending'
import { soundCost, type ElevenLabsApiFetch } from '../../../src/main/tools/elevenlabs/api'
import type { SoundRecord } from '../../../src/main/tools/elevenlabs/records'
import { MAKE_SOUND_TOOL, type PluginAccount } from '../../../src/shared/plugins'

/**
 * A paired host's threads make sounds with the ElevenLabs copy its desktop sent (the plugins plan's slice 12, part 4a):
 * asking on the card as the desktop's switch says, within the one monthly limit counting what the desktop last said in
 * cents, into the host thread's own folder. ElevenLabs is a stand-in in this process: every key and account here is
 * made up, and nothing reaches ElevenLabs.
 */
const KEY = 'sk_made_up_elevenlabs_key_0123456789'
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64])
const folders: string[] = []
let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-host-sound-thread-')))
  folders.push(root)
})
afterEach(async () => { await Promise.all(folders.splice(0).map(made => rm(made, { recursive: true, force: true }))) })

const LAPTOP = 'desktop-laptop', TOWER = 'desktop-tower'
const THREAD = 'a-host-thread'
const VOICES: PluginAccount = { id: '55555555-5555-4555-8555-000000000001', plugin: 'elevenlabs', name: 'Voices', savedAt: '2026-11-15T08:00:00.000Z', signedInAs: null, on: true, projects: null, spending: { askBefore: true, monthlyLimit: 10 } }
/** A sound effect of ten seconds, and what it costs at ElevenLabs' published prices. */
const CHIME = { kind: 'effect', name: 'Door chime', words: 'A soft two-note door chime', seconds: 10 }
const CHIME_COST = soundCost({ kind: 'effect', seconds: 10 })
const SESSIONS: Record<string, string> = { [LAPTOP]: '66666666-6666-4666-8666-000000000001', [TOWER]: '66666666-6666-4666-8666-000000000002' }
let revision = 0
/** What a desktop says an account spent elsewhere this month, in cents, as the next report of its run. */
const said = (accountId: string, cents: number, clientId = LAPTOP) => ({ accountId, month: monthOf(new Date()), credits: cents, session: SESSIONS[clientId]!, revision: ++revision })

function credentials(): PluginCredentials {
  const slots = new Map<string, string>()
  return { has: slot => slots.has(slot), get: slot => slots.get(slot) ?? '', set: async (slot, value) => { if (value) slots.set(slot, value); else slots.delete(slot) } }
}

/** A host's plugins with one open thread working in `root`, its cards answered as `answer` says. */
async function host(options: { answer?: boolean; history?: boolean | (() => boolean); directory?: string } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'sotto-host-sound-'))
  folders.push(directory)
  const sent: { readonly path: string; readonly key: string | undefined }[] = []
  const elevenLabsFetch: ElevenLabsApiFetch = async (url, init) => {
    sent.push({ path: `${init.method} ${new URL(url).pathname}`, key: init.headers['xi-api-key'] })
    if (init.headers['xi-api-key'] !== KEY) return new Response(null, { status: 401 })
    if (init.method === 'GET') return Response.json({ voices: [{ voice_id: 'rachel01', name: 'Rachel' }], has_more: false })
    return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
  }
  const shown: { threadId: string; sound: SoundRecord }[] = []
  const thread = { id: THREAD, kind: 'agent', projectId: 'project-1', providerId: 'codex' } as never
  const plugins = hostPlugins({ directory, credentials: credentials(), thread: id => id === THREAD ? thread : undefined, admits: id => id === THREAD,
    paired: clientId => clientId === LAPTOP || clientId === TOWER,
    historyEnabled: typeof options.history === 'function' ? options.history : () => (options.history as boolean | undefined) ?? true,
    folderOf: async id => id === THREAD ? root : null,
    showSoundInThread: async (threadId, sound) => { shown.push({ threadId, sound }); return true },
    standIns: { elevenLabsFetch, gh: async () => JSON.stringify({ hosts: {} }) } })
  const cards: string[] = []
  plugins.changes.subscribe(() => {
    for (const request of plugins.changes.requests().get(THREAD) ?? []) {
      if (cards.includes(request.id)) continue
      cards.push(request.id)
      queueMicrotask(() => { try { plugins.changes.answer(THREAD, request.id, options.answer ?? true) } catch { /* Already answered. */ } })
    }
  })
  const make = async (args: Record<string, unknown> = CHIME) => {
    const result = await plugins.tools.call(THREAD, MAKE_SOUND_TOOL, args)
    return { text: result.content.map(part => part.type === 'text' ? part.text : '').join('\n'), failed: result.isError === true }
  }
  const made = (): string[] => sent.filter(call => call.path.startsWith('POST')).map(call => call.path)
  /** A desktop sends its copy, and then what the account spent elsewhere, as it does on every reconcile. */
  const keep = async (account: PluginAccount, clientId = LAPTOP, cents = 0) => {
    await plugins.copies.keep({ account, secret: KEY }, clientId)
    await plugins.elevenLabsSpending.share([said(account.id, cents, clientId)], clientId)
  }
  return { plugins, cards, make, made, sent, shown, keep, directory }
}

describe('a sound made on a paired host', () => {
  it('asks on the card while Ask before each is on, saves it into the host thread’s folder with the copy’s key, shows its line, and asks no more once it is off', async () => {
    const h = await host()
    await h.keep(VOICES)
    const asked = await h.make()
    expect(asked.failed).toBe(false)
    expect(asked.text).toContain('The user allowed it.')
    expect(h.cards).toHaveLength(1)
    expect(await readdir(join(root, 'sounds'))).toEqual(['Door chime.mp3'])
    expect(h.sent.every(call => call.key === KEY)).toBe(true)
    expect(h.made()).toEqual(['POST /v1/sound-generation'])
    expect(await h.plugins.sounds.list()).toEqual([expect.objectContaining({ threadId: THREAD, accountId: VOICES.id, state: 'made', fileName: 'Door chime.mp3' })])
    // Its line goes into the host thread as on the desktop.
    expect(h.shown.map(entry => [entry.threadId, entry.sound.name])).toEqual([[THREAD, 'Door chime']])

    // The desktop turns asking off and sends the copy again, as it does on every change: the next call asks nothing.
    await h.plugins.copies.keep({ account: { ...VOICES, spending: { askBefore: false, monthlyLimit: 10 } }, secret: KEY }, LAPTOP)
    const unasked = await h.make({ ...CHIME, name: 'Second chime' })
    expect(unasked.text).toContain('Made without a card')
    expect(h.cards).toHaveLength(1)
    await h.plugins.close()
  })

  it('makes nothing when the user says no on the card', async () => {
    const h = await host({ answer: false })
    await h.keep(VOICES)
    expect(await h.make()).toMatchObject({ failed: true })
    expect(h.made()).toEqual([])
    await h.plugins.close()
  })

  it('makes nothing from a copy whose desktop has not yet said what the account spent, with Meshy’s words', async () => {
    const h = await host()
    // The report comes before the copy, so there is no copy for it to speak for, and it is not kept.
    await h.plugins.elevenLabsSpending.share([said(VOICES.id, 0)], LAPTOP)
    await h.plugins.copies.keep({ account: { ...VOICES, spending: { askBefore: false, monthlyLimit: 10 } }, secret: KEY }, LAPTOP)
    const waiting = await h.make()
    expect(waiting.failed).toBe(true)
    expect(waiting.text).toContain(`waiting to hear this month's spending for the ElevenLabs account "Voices" from the desktop that sent it to this computer`)
    expect(waiting.text).toContain('Nothing was sent to ElevenLabs, and nothing was counted.')
    expect(h.cards).toEqual([])
    expect(h.made()).toEqual([])
    // What Meshy's desktop said counts for nothing here: each plugin hears its own.
    await h.plugins.spending.share([said(VOICES.id, 0)], LAPTOP)
    expect((await h.make()).text).toContain('waiting to hear')
    await h.plugins.elevenLabsSpending.share([said(VOICES.id, 0)], LAPTOP)
    expect(await h.make()).toMatchObject({ failed: false })
    await h.plugins.close()
  })

  it('makes nothing while its record of what the desktop said cannot be kept', async () => {
    const h = await host()
    await h.plugins.copies.keep({ account: { ...VOICES, spending: { askBefore: false, monthlyLimit: 10 } }, secret: KEY }, LAPTOP)
    await h.plugins.elevenLabsSpending.share([said(VOICES.id, 0)], LAPTOP)
    await mkdir(join(h.directory, 'plugin-elevenlabs-spending.json.next'))
    await expect(h.plugins.elevenLabsSpending.share([said(VOICES.id, 900)], LAPTOP)).rejects.toThrow()
    const refused = await h.make()
    expect(refused.failed).toBe(true)
    expect(refused.text).toContain('could not read or keep its record of what the ElevenLabs account "Voices" spent on other computers this month')
    expect(h.made()).toEqual([])
    await h.plugins.close()
  })

  it('refuses one that would pass the one monthly limit, counting what the desktop last said in cents', async () => {
    const h = await host()
    // $10 a month, and the desktop says $9.99 went elsewhere: a chime of more than a cent does not fit.
    await h.keep(VOICES, LAPTOP, 999)
    expect(CHIME_COST).toBeGreaterThan(0.01)
    const refused = await h.make()
    expect(refused.failed).toBe(true)
    expect(refused.text).toContain('$9.99 of the account\'s monthly limit of $10 is used this month, so it would pass the limit')
    expect(h.cards).toEqual([])
    expect(h.made()).toEqual([])
    await h.plugins.close()
  })

  it('tells each desktop what its own threads spent of that desktop’s copies alone, rounded up to the cent, and keeps nothing said of another’s', async () => {
    const h = await host()
    const other: PluginAccount = { ...VOICES, id: '55555555-5555-4555-8555-000000000002', name: 'Tower voices', spending: { askBefore: false, monthlyLimit: 10 } }
    await h.keep({ ...VOICES, spending: { askBefore: false, monthlyLimit: 10 } })
    await h.keep(other, TOWER)
    let told = 0
    h.plugins.elevenLabsSpending.subscribe(() => { told += 1 })
    expect(await h.make({ ...CHIME, account: 'Voices' })).toMatchObject({ failed: false })
    const month = monthOf(new Date())
    await expect(h.plugins.elevenLabsSpending.own(LAPTOP)).resolves.toEqual([{ accountId: VOICES.id, month, credits: Math.ceil(CHIME_COST * 100 - 1e-6), session: expect.any(String), revision: expect.any(Number) }])
    await expect(h.plugins.elevenLabsSpending.own(TOWER)).resolves.toMatchObject([{ accountId: other.id, credits: 0 }])
    // Meshy's report names no ElevenLabs copy.
    await expect(h.plugins.spending.own(LAPTOP)).resolves.toEqual([])
    await expect.poll(() => told).toBeGreaterThan(0)
    // The laptop speaks for the tower's copy: nothing of it is kept, so the tower's account is not held back.
    await h.plugins.elevenLabsSpending.share([said(other.id, 1_000)], LAPTOP)
    expect(await h.make({ ...CHIME, account: 'Tower voices' })).toMatchObject({ failed: false })
    await h.plugins.close()
  })
})

describe('a host’s sounds’ records', () => {
  it('keep no words while the host’s Keep local history is off, and a forgotten thread’s sounds still count this month', async () => {
    const h = await host({ history: false })
    await h.plugins.start()
    await h.keep({ ...VOICES, spending: { askBefore: false, monthlyLimit: 10 } })
    expect(await h.make()).toMatchObject({ failed: false })
    const [sound] = await h.plugins.sounds.list()
    expect(sound?.words).toBeUndefined()
    expect(await readFile(join(h.directory, 'sounds.json'), 'utf8')).not.toContain(CHIME.words)
    h.plugins.forgetThreads([THREAD])
    await expect.poll(async () => (await h.plugins.sounds.list()).length).toBe(0)
    // The MP3 is the user's and stays; what it cost is still reported to the desktop.
    expect(await readdir(join(root, 'sounds'))).toEqual(['Door chime.mp3'])
    await expect(h.plugins.elevenLabsSpending.own(LAPTOP)).resolves.toMatchObject([{ credits: Math.ceil(CHIME_COST * 100 - 1e-6) }])
    await h.plugins.close()
  })

  it('keeps the words of sounds kept before when the host starts with Keep local history on, read only after it was built', async () => {
    // Sol's review: the host reads its settings after its plugins are built, so history reads as off until then.
    const first = await host({ history: true })
    await first.keep({ ...VOICES, spending: { askBefore: false, monthlyLimit: 10 } })
    expect(await first.make()).toMatchObject({ failed: false })
    await first.plugins.close()
    let history = false
    const again = await host({ history: () => history, directory: first.directory })
    history = true
    await again.plugins.start()
    expect((await again.plugins.sounds.list())[0]?.words).toBe(CHIME.words)
    expect(await readFile(join(first.directory, 'sounds.json'), 'utf8')).toContain(CHIME.words)
    await again.plugins.close()
  })

  it('takes words already kept out when the host starts with Keep local history off', async () => {
    const first = await host({ history: true })
    await first.keep({ ...VOICES, spending: { askBefore: false, monthlyLimit: 10 } })
    expect(await first.make()).toMatchObject({ failed: false })
    await first.plugins.close()
    expect(await readFile(join(first.directory, 'sounds.json'), 'utf8')).toContain(CHIME.words)
    const again = await host({ history: false, directory: first.directory })
    await again.plugins.start()
    expect(await readFile(join(first.directory, 'sounds.json'), 'utf8')).not.toContain(CHIME.words)
    await again.plugins.close()
  })
})
