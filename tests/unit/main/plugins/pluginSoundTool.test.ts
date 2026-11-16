// @vitest-environment node
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wordPluginChange } from '../../../../src/main/plugins/changeWords'
import { wordPluginChangeInEnglish } from '../../../../src/main/plugins/changeWordsPlain'
import type { PluginChangeAnswer } from '../../../../src/main/plugins/pendingChanges'
import { PluginToolServer } from '../../../../src/main/plugins/pluginTools'
import type { PluginUseReport } from '../../../../src/main/plugins/useRecord'
import { soundCost, type ElevenLabsApiFetch } from '../../../../src/main/tools/elevenlabs/api'
import { SoundRecords } from '../../../../src/main/tools/elevenlabs/records'
import { ElevenLabsSounds } from '../../../../src/main/tools/elevenlabs/service'
import { MAKE_SOUND_TOOL, pluginAccountAdmits, type PluginAccount, type PluginChange } from '../../../../src/shared/plugins'

/**
 * `make_sound` (ADR-0205; the plugins plan's slice 12, part 2), the way `make_3d_model` asks, counts and refuses. The
 * sound is made by Sotto's own service and saved by its own save, over a stand-in for ElevenLabs' API in this process:
 * every key and account here is made up, and nothing reaches ElevenLabs.
 */
const KEY = 'sk_made_up_elevenlabs_key_0123456789'
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64])
const servers: PluginToolServer[] = []
const stops: AbortController[] = []
let root: string
let data: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'sotto-sound-tool-')))
  data = await mkdtemp(join(tmpdir(), 'sotto-sound-data-'))
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  for (const stop of stops.splice(0)) stop.abort()
  await rm(root, { recursive: true, force: true })
  await rm(data, { recursive: true, force: true })
})

const VOICES: PluginAccount = { id: '55555555-5555-4555-8555-000000000001', plugin: 'elevenlabs', name: 'Voices', savedAt: '2026-11-15T08:00:00.000Z', signedInAs: null, on: true, projects: null, spending: { askBefore: true, monthlyLimit: 10 } }
const ACCOUNT_VOICES = [{ voice_id: 'rachel01', name: 'Rachel' }, { voice_id: 'adam0002', name: 'Adam' }]

interface Options {
  answers?: PluginChangeAnswer[]
  /** What the account spent this month before these calls, in dollars. */
  used?: number
  account?: Partial<PluginAccount>
  /** ElevenLabs' answer to a request to make a sound: its status, or the MP3 when left out. */
  status?: number
  voices?: readonly { voice_id: string; name: string }[]
  noElevenLabs?: boolean
  whileAsked?: (world: { accounts: PluginAccount[] }) => void | Promise<void>
  whileCounting?: (world: { accounts: PluginAccount[] }) => void
}

/** The tools for thread `one`, over one ElevenLabs account, with the user's answers and ElevenLabs' answers scripted. */
function tools(options: Options = {}) {
  const world = { accounts: [{ ...VOICES, ...options.account }] }
  const answers = [...options.answers ?? []]
  const asked: PluginChange[] = []
  const recorded: PluginUseReport[] = []
  const sent: string[] = []
  const records = new SoundRecords(data, { historyEnabled: () => true })
  const fetcher: ElevenLabsApiFetch = async (url, init) => {
    const { pathname } = new URL(url)
    sent.push(`${init.method} ${pathname}`)
    if (init.headers['xi-api-key'] !== KEY) return new Response(null, { status: 401 })
    if (init.method === 'GET') return Response.json({ voices: options.voices ?? ACCOUNT_VOICES, has_more: false })
    if (options.status === 401) return Response.json({ detail: { status: 'quota_exceeded' } }, { status: 401 })
    if (options.status !== undefined) return new Response(null, { status: options.status })
    return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
  }
  const stop = new AbortController()
  stops.push(stop)
  const sounds = new ElevenLabsSounds({ records, fetch: fetcher, signal: stop.signal, keyOf: async accountId => world.accounts.some(account => account.id === accountId) ? KEY : undefined })
  const mine = (): PluginAccount[] => world.accounts.filter(account => pluginAccountAdmits(account, null))
  const never = async (): Promise<never> => { throw new Error('Not part of these tests.') }
  const server = new PluginToolServer({
    admits: threadId => threadId === 'one',
    gitHubSignIn: async () => ({ state: 'signed-out' }),
    readGitHub: never, readVercel: never, commentOnGitHub: never, openGitHubIssue: never, describeGitHubIssue: never, setGitHubIssueState: never,
    describeVercelDeployment: never, cancelVercelDeployment: never, moveVercelProduction: never,
    accounts: async () => mine(),
    findAccount: async (_threadId, plugin, name) => {
      const usable = mine().filter(account => account.plugin === plugin)
      if (usable.length === 0) return world.accounts.length === 0 ? 'none' : 'withheld'
      return name === undefined ? usable[0]! : usable.find(account => account.name === name) ?? 'unknown'
    },
    holdsAccount: async accountId => world.accounts.some(account => account.id === accountId),
    record: async report => { recorded.push(report) },
    isWatcher: () => false,
    askChange: async (_threadId, change) => {
      asked.push(change)
      await options.whileAsked?.(world)
      return answers.shift() ?? 'allowed'
    },
    ...(options.noElevenLabs ? {} : { elevenlabs: {
      folderOf: async () => root,
      // What this computer counts: what was spent before, and each sound asked for here at its estimate.
      monthSpent: async accountId => { options.whileCounting?.(world); return (options.used ?? 0) + ((await records.monthSpent()).get(accountId) ?? 0) },
      keyTrouble: () => null,
      voices: accountId => sounds.voices(accountId),
      make: request => sounds.make(request),
    } }),
  })
  servers.push(server)
  const make = (args: Record<string, unknown>, context: { waitMs?: number; signal?: AbortSignal } = {}) => server.call('one', MAKE_SOUND_TOOL, args, context)
  const made = (): string[] => sent.filter(call => call.startsWith('POST'))
  const spent = async (): Promise<number> => (await records.monthSpent()).get(VOICES.id) ?? 0
  return { server, world, asked, recorded, sent, made, records, spent, make }
}
const said = (result: { content: { type: string; text?: string }[] }): string => result.content.map(part => part.text ?? '').join('\n')
const uses = (recorded: readonly PluginUseReport[]): string[] => recorded.map(use => `${use.tool} ${use.kind} ${use.outcome}`)
const files = async (): Promise<string[]> => { try { return await readdir(join(root, 'sounds')) } catch { return [] } }
const WELCOME = { kind: 'speech', name: 'Welcome video', words: 'Welcome to Lumen. In the next two minutes you will set up your shop.' }
const WELCOME_COST = soundCost({ kind: 'speech', characters: WELCOME.words.length })

describe('making a sound through make_sound', () => {
  it('asks first with everything that goes to ElevenLabs and what it costs, saves the MP3 after the yes, and answers with its path', async () => {
    const t = tools({ used: 1.2 })
    const result = await t.make(WELCOME)
    expect(result.isError).toBeUndefined()
    expect(t.asked).toEqual([{ kind: 'elevenlabs-sound', account: 'Voices', name: 'Welcome video', sound: 'speech', words: WELCOME.words, voice: 'Rachel',
      cost: WELCOME_COST, monthSpent: 1.2, monthlyLimit: 10, folder: 'sounds' }])
    expect(t.made()).toEqual(['POST /v1/text-to-speech/rachel01'])
    expect(new Uint8Array(await readFile(join(root, 'sounds', 'Welcome video.mp3')))).toEqual(MP3)
    expect(said(result)).toBe('The user allowed it. The sound "Welcome video" is made and saved in the thread\'s folder at sounds/Welcome video.mp3, for under $0.01 at ElevenLabs\' published prices, spoken in the voice Rachel. Nothing plays on its own; tell the user where it is.')
    // A made sound counts its estimate against the month.
    expect(await t.spent()).toBeCloseTo(WELCOME_COST, 9)
    expect(uses(t.recorded)).toEqual(['make_sound sound-speech done'])
  })

  it('sends nothing, saves nothing and counts nothing when the user says no or nobody answers', async () => {
    for (const answer of ['denied', 'lapsed'] as const) {
      const t = tools({ answers: [answer] })
      const result = await t.make(WELCOME)
      expect(result.isError).toBe(true)
      expect(said(result)).toContain('Nothing was sent to ElevenLabs, and nothing was counted.')
      expect(t.made()).toEqual([])
      expect(await files()).toEqual([])
      expect(await t.spent()).toBe(0)
      expect(uses(t.recorded)).toEqual([`make_sound sound-speech ${answer}`])
    }
  })

  it('refuses one that would pass the month’s limit before asking or sending anything', async () => {
    const t = tools({ used: 9.9 })
    const result = await t.make({ kind: 'music', name: 'Theme', words: 'A calm piano theme', seconds: 300 })
    expect(result.isError).toBe(true)
    expect(said(result)).toBe('This sound would cost about $0.75, and $9.90 of the account\'s monthly limit of $10 is used this month, so it would pass the limit. Nothing was sent to ElevenLabs, and nothing was counted. Tell the user, who can raise the limit in Settings > Plugins.')
    expect(t.asked).toEqual([])
    expect(t.sent).toEqual([])
    expect(uses(t.recorded)).toEqual(['make_sound sound-music refused'])
  })

  it('looks at the limit again after the yes, as the user may have lowered it while the card waited', async () => {
    const t = tools({ whileAsked: world => { world.accounts = [{ ...world.accounts[0]!, spending: { askBefore: true, monthlyLimit: 0 } }] } })
    const result = await t.make({ kind: 'effect', name: 'Chime', words: 'A bright two-note chime', seconds: 2 })
    expect(result.isError).toBe(true)
    expect(said(result)).toContain('of the account\'s monthly limit of $0 is used this month, so it would pass the limit.')
    expect(t.asked).toHaveLength(1)
    expect(t.made()).toEqual([])
    expect(uses(t.recorded)).toEqual(['make_sound sound-effect refused'])
  })

  it('lets only one of two sounds asked for at once fit under the limit', async () => {
    // $9.20 used, and each 300 seconds of music is $0.75: one fits, and the second finds the first counted.
    const t = tools({ used: 9.2, account: { spending: { askBefore: false, monthlyLimit: 10 } } })
    const music = { kind: 'music', words: 'A calm piano theme', seconds: 300 }
    const results = await Promise.all([t.make({ ...music, name: 'First' }), t.make({ ...music, name: 'Second' })])
    expect(results.filter(result => result.isError === undefined)).toHaveLength(1)
    expect(said(results.find(result => result.isError)!)).toContain('so it would pass the limit.')
    expect(t.made()).toEqual(['POST /v1/music'])
  })

  it('makes one without a card once the user turned asking off, still within the limit', async () => {
    const t = tools({ account: { spending: { askBefore: false, monthlyLimit: 10 } } })
    const result = await t.make({ kind: 'effect', name: 'Rain', words: 'Rain on a tin roof' })
    expect(result.isError).toBeUndefined()
    expect(t.asked).toEqual([])
    expect(said(result)).toBe('Made without a card, since the user turned asking off for the account. The sound "Rain" is made and saved in the thread\'s folder at sounds/Rain.mp3, for about $0.06 at ElevenLabs\' published prices. Nothing plays on its own; tell the user where it is.')
    // An effect with no length is priced at its longest, 30 seconds.
    expect(await t.spent()).toBeCloseTo(soundCost({ kind: 'effect', seconds: 30 }), 9)
  })

  it('shows the card after all when asking was turned back on while the call was being looked at', async () => {
    let counted = 0
    const t = tools({ account: { spending: { askBefore: false, monthlyLimit: 10 } }, answers: ['denied'],
      whileCounting: world => { if (counted++ === 0) world.accounts = [{ ...world.accounts[0]!, spending: { askBefore: true, monthlyLimit: 10 } }] } })
    const result = await t.make({ kind: 'effect', name: 'Rain', words: 'Rain on a tin roof' })
    expect(t.asked).toHaveLength(1)
    expect(result.isError).toBe(true)
    expect(t.made()).toEqual([])
  })

  it('speaks in a voice named in any case, the account’s first when none is named, and refuses one it does not have, listing its voices', async () => {
    const named = tools()
    await named.make({ ...WELCOME, voice: 'adam' })
    expect(named.made()).toEqual(['POST /v1/text-to-speech/adam0002'])
    const many = Array.from({ length: 25 }, (_, index) => ({ voice_id: `voice${index}`, name: `Voice ${index}` }))
    const unknown = tools({ voices: many })
    const result = await unknown.make({ ...WELCOME, voice: 'Nobody' })
    expect(result.isError).toBe(true)
    expect(said(result)).toBe(`The ElevenLabs account has no voice called "Nobody". Its voices: ${many.slice(0, 20).map(voice => `"${voice.name}"`).join(', ')}, and 5 more. Give "voice" as one of them, or leave it out for the first. Nothing was sent to ElevenLabs, and nothing was counted.`)
    expect(unknown.asked).toEqual([])
    expect(unknown.sent).toEqual(['GET /v2/voices'])
    expect(uses(unknown.recorded)).toEqual(['make_sound sound-speech refused'])
  })

  it('says plainly why ElevenLabs did not make one, saves nothing and counts nothing', async () => {
    const cases: [number, string][] = [
      [401, 'The ElevenLabs account has no credits left for this. Tell the user. Nothing was saved, and nothing was counted against this month\'s limit.'],
      [400, 'ElevenLabs would not make this speech from these words in this voice. Nothing was saved, and nothing was counted against this month\'s limit.'],
      [429, 'ElevenLabs is turning requests away for now. Nothing was saved, and nothing was counted against this month\'s limit. Call make_sound again in a few minutes if it is still wanted.'],
      [503, 'ElevenLabs could not be reached, or stopped before the whole sound came back. Nothing was saved, and nothing was counted against this month\'s limit.'],
    ]
    for (const [status, words] of cases) {
      const t = tools({ status })
      const result = await t.make(WELCOME)
      expect(result.isError).toBe(true)
      expect(said(result)).toBe(`The sound "Welcome video" was not made. ${words}`)
      expect(await files()).toEqual([])
      expect(await t.spent()).toBe(0)
      expect((await t.records.list())[0]).toMatchObject({ state: 'failed', cost: 0 })
      expect(uses(t.recorded)).toEqual(['make_sound sound-speech failed'])
    }
  })

  it('takes only what each kind of sound can be, and a folder inside the thread’s', async () => {
    const t = tools()
    const refusals = await Promise.all([
      t.make({ kind: 'effect', name: 'Chime', words: 'A chime', voice: 'Rachel' }),
      t.make({ kind: 'music', name: 'Theme', words: 'A calm theme' }),
      t.make({ kind: 'music', name: 'Theme', words: 'A calm theme', seconds: 2 }),
      t.make({ kind: 'effect', name: 'Chime', words: 'A chime', seconds: 31 }),
      t.make({ kind: 'effect', name: 'Chime', words: 'a'.repeat(2_001) }),
      t.make({ kind: 'speech', name: 'Hello', words: 'Hello', seconds: 3 }),
      t.make({ kind: 'effect', name: 'Chime', words: 'A chime', instrumental: true }),
      t.make({ kind: 'effect', name: 'Chime', words: 'A chime', folder: '../outside' }),
      t.make({ kind: 'speech', name: 'x'.repeat(81), words: 'Hello' }),
    ])
    expect(refusals.map(result => result.isError)).toEqual(refusals.map(() => true))
    expect(said(refusals[1]!)).toBe('Music needs "seconds", from 3 to 300. Nothing was sent to ElevenLabs, and nothing was counted.')
    expect(t.sent).toEqual([])
    expect(t.asked).toEqual([])
  })

  it('makes music with no singing when asked, into the folder named', async () => {
    const t = tools()
    const result = await t.make({ kind: 'music', name: 'Theme', words: 'A calm piano theme', seconds: 30, instrumental: true, folder: 'audio/music' })
    expect(t.asked[0]).toMatchObject({ sound: 'music', seconds: 30, instrumental: true, folder: 'audio/music' })
    expect(said(result)).toContain('at audio/music/Theme.mp3')
    expect(await readdir(join(root, 'audio', 'music'))).toEqual(['Theme.mp3'])
  })

  it('is not made on a computer whose threads cannot make sounds yet', async () => {
    const t = tools({ noElevenLabs: true })
    const result = await t.make(WELCOME)
    expect(said(result)).toBe('Threads on this computer cannot make sounds through Sotto yet. Nothing was sent to ElevenLabs, and nothing was counted.')
  })
})

describe('the card a sound waits on', () => {
  const base = { kind: 'elevenlabs-sound', account: 'Studio', name: 'Welcome video', cost: 0.0096, monthSpent: 1.2, monthlyLimit: 10, folder: 'sounds' } as const
  const TRAINS = 'ElevenLabs may use what it is sent to train its own models, unless that is turned off in the ElevenLabs account.'
  const GOES = 'The file goes to sounds in this thread’s folder. Nothing plays on its own.'

  it('words speech with its voice and characters, and the cost in dollars, from the prototype', () => {
    const change: PluginChange = { ...base, sound: 'speech', words: 'Welcome to Lumen.', voice: 'Rachel' }
    expect(wordPluginChange(change)).toEqual({
      plugin: 'ElevenLabs',
      text: 'Make the sound Welcome video with the ElevenLabs account Studio? Under $0.01.',
      action: 'Make a sound with ElevenLabs', target: 'Speech · Welcome video',
      details: ['Speaks these words in the voice Rachel (17 characters):', '“Welcome to Lumen.”', TRAINS,
        'Under $0.01 on the ElevenLabs account Studio; $1.20 of its $10 used this month.', GOES].join('\n'),
      allow: 'Make the sound', deny: 'Deny',
    })
    expect(wordPluginChangeInEnglish(change)).toEqual(wordPluginChange(change))
  })

  it('words a sound effect with and without its length, and music with and without singing', () => {
    const line = (change: PluginChange): string[] => wordPluginChange(change).details.split('\n').slice(0, 2)
    expect(wordPluginChange({ ...base, sound: 'effect', words: 'A chime', seconds: 2 }).target).toBe('Sound effect · Welcome video')
    expect(line({ ...base, sound: 'effect', words: 'A chime', seconds: 2 })).toEqual(['Makes a sound effect, 2 seconds long, from these words:', '“A chime”'])
    expect(line({ ...base, sound: 'effect', words: 'A chime', seconds: 1 })[0]).toBe('Makes a sound effect, 1 second long, from these words:')
    expect(line({ ...base, sound: 'effect', words: 'A chime' })[0]).toBe('Makes a sound effect, as long as ElevenLabs judges, up to 30 seconds, from these words:')
    expect(wordPluginChange({ ...base, sound: 'music', words: 'A theme', seconds: 90 }).target).toBe('Music · Welcome video')
    expect(line({ ...base, sound: 'music', words: 'A theme', seconds: 90 })[0]).toBe('Makes music, 90 seconds long, from these words:')
    expect(line({ ...base, sound: 'music', words: 'A theme', seconds: 90, instrumental: true })[0]).toBe('Makes music, 90 seconds long, with no singing, from these words:')
    // Two decimals from a cent up.
    expect(wordPluginChange({ ...base, sound: 'music', words: 'A theme', seconds: 90, cost: 0.225 }).text).toBe('Make the sound Welcome video with the ElevenLabs account Studio? About $0.23.')
  })
})
