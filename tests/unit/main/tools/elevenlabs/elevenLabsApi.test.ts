// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ElevenLabsApi, ElevenLabsApiError, soundCost, type ElevenLabsApiFetch, type ElevenLabsProblem } from '../../../../../src/main/tools/elevenlabs/api'

/** ElevenLabs' API behind one adapter (ADR-0205; slice 12, part 2). Every key is made up, and nothing reaches ElevenLabs. */
const KEY = 'sk_made_up_elevenlabs_key_0123456789'
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64])

type Asked = { url: string; init: Parameters<ElevenLabsApiFetch>[1] }
function elevenLabs(answer: (asked: Asked) => Response | Error) {
  const asked: Asked[] = []
  const fetcher: ElevenLabsApiFetch = async (url, init) => {
    const call = { url, init }
    asked.push(call)
    const made = answer(call)
    if (made instanceof Error) throw made
    return made
  }
  return { api: new ElevenLabsApi(fetcher, KEY), asked }
}
const audio = (): Response => new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
async function problem(made: Promise<unknown>): Promise<ElevenLabsProblem> {
  try { await made } catch (error) { if (error instanceof ElevenLabsApiError) return error.problem; throw error }
  throw new Error('It was made.')
}

describe('making a sound', () => {
  it('speaks words in a voice with Multilingual v2, as an MP3, with the key in its own header and no redirect followed', async () => {
    const { api, asked } = elevenLabs(audio)
    const made = await api.speech({ voiceId: '21m00Tcm4TlvDq8ikWAM', text: 'Welcome to Lumen.' })
    expect(new Uint8Array(await made.arrayBuffer())).toEqual(MP3)
    expect(asked[0]!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128')
    expect(asked[0]!.init).toMatchObject({ method: 'POST', redirect: 'manual', headers: { 'xi-api-key': KEY, Accept: 'audio/mpeg', 'Content-Type': 'application/json' } })
    expect(JSON.parse(asked[0]!.init.body!)).toEqual({ text: 'Welcome to Lumen.', model_id: 'eleven_multilingual_v2' })
  })

  it('makes a sound effect of the length asked for, or ElevenLabs\' own when none is', async () => {
    const { api, asked } = elevenLabs(audio)
    await api.soundEffect({ words: 'A short bright chime', seconds: 2 })
    await api.soundEffect({ words: 'Rain on a tin roof' })
    expect(asked.map(call => call.url)).toEqual(['https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128', 'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128'])
    expect(asked.map(call => JSON.parse(call.init.body!))).toEqual([{ text: 'A short bright chime', duration_seconds: 2 }, { text: 'Rain on a tin roof' }])
  })

  it('makes music of a length in milliseconds, with no singing when asked', async () => {
    const { api, asked } = elevenLabs(audio)
    await api.music({ words: 'Calm acoustic guitar', seconds: 30, instrumental: true })
    expect(asked[0]!.url).toBe('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128')
    expect(JSON.parse(asked[0]!.init.body!)).toEqual({ prompt: 'Calm acoustic guitar', music_length_ms: 30_000, force_instrumental: true })
  })

  it('sends nothing it would refuse itself: no words, too many, a length out of range, or a voice ID that is not one', async () => {
    const { api, asked } = elevenLabs(audio)
    const refused = [
      api.speech({ voiceId: 'voice/../../v1/user', text: 'Hello' }),
      api.speech({ voiceId: 'abc123', text: '   ' }),
      api.speech({ voiceId: 'abc123', text: 'a'.repeat(10_001) }),
      api.soundEffect({ words: 'A chime', seconds: 31 }),
      api.soundEffect({ words: 'A chime', seconds: 0.2 }),
      api.music({ words: 'Calm', seconds: 2, instrumental: false }),
      api.music({ words: 'Calm', seconds: 301, instrumental: false }),
      api.music({ words: 'x'.repeat(2_001), seconds: 30, instrumental: false }),
    ]
    for (const made of refused) expect(await problem(made)).toBe('rejected')
    expect(asked).toEqual([])
  })

  it('says what a refusal means in one word, and tells an account out of credits from a key it does not take', async () => {
    const answers: [Response | Error, ElevenLabsProblem][] = [
      [new Response('{"detail":{"status":"invalid_api_key","message":"made up"}}', { status: 401 }), 'refused'],
      [new Response('{"detail":{"status":"quota_exceeded","message":"made up"}}', { status: 401 }), 'no-credits'],
      [new Response('not json', { status: 401 }), 'refused'],
      // Only the start of a refusal is read: a long one is cut, and its status word is not found in what was read.
      [new Response(`{"detail":{"message":"${'x'.repeat(10_000)}","status":"quota_exceeded"}}`, { status: 401 }), 'refused'],
      [new Response('{}', { status: 403 }), 'refused'],
      [new Response('{}', { status: 404 }), 'rejected'],
      [new Response('{}', { status: 422 }), 'rejected'],
      [new Response('{}', { status: 429, headers: { 'retry-after': '20' } }), 'busy'],
      [new Response('{}', { status: 500 }), 'unreachable'],
      [new Error('made-up network failure'), 'unreachable'],
    ]
    for (const [answer, word] of answers) expect(await problem(elevenLabs(() => answer).api.speech({ voiceId: 'abc123', text: 'Hello' })), word).toBe(word)
    try { await elevenLabs(() => new Response('{}', { status: 429, headers: { 'retry-after': '20' } })).api.music({ words: 'Calm', seconds: 30, instrumental: true }) } catch (error) {
      expect((error as ElevenLabsApiError).retryAfterMs).toBe(20_000)
    }
  })
})

describe('the account\'s voices', () => {
  it('lists each voice by its ID and name, a page at a time, and leaves out one Sotto would not put in a path', async () => {
    const { api, asked } = elevenLabs(call => call.url.includes('next_page_token')
      ? Response.json({ voices: [{ voice_id: 'pNInz6obpgDQGcFmaJgB', name: '  Adam  ' }, { voice_id: 'abc', name: '   ' }], has_more: false, next_page_token: null })
      : Response.json({ voices: [{ voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', category: 'premade' }, { voice_id: 'bad/id', name: 'Odd' }], has_more: true, next_page_token: 'page two' }))
    expect(await api.voices()).toEqual([{ id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel' }, { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' }])
    expect(asked.map(call => call.url)).toEqual(['https://api.elevenlabs.io/v2/voices?page_size=100', 'https://api.elevenlabs.io/v2/voices?page_size=100&next_page_token=page+two'])
    expect(asked[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'xi-api-key': KEY, Accept: 'application/json' } })
    expect(await problem(elevenLabs(() => new Response('[1,2]', { status: 200 })).api.voices())).toBe('unreadable')
  })
})

describe('what a sound costs at ElevenLabs\' published API prices', () => {
  it('prices speech by the character, and sound effects and music by the minute', () => {
    expect(soundCost({ kind: 'speech', characters: 1_000 })).toBeCloseTo(0.08)
    expect(soundCost({ kind: 'speech', characters: 120 })).toBeCloseTo(0.0096)
    expect(soundCost({ kind: 'effect', seconds: 30 })).toBeCloseTo(0.06)
    // An effect with no length is priced at its longest, 30 seconds.
    expect(soundCost({ kind: 'effect' })).toBeCloseTo(0.06)
    expect(soundCost({ kind: 'music', seconds: 60 })).toBeCloseTo(0.15)
    expect(soundCost({ kind: 'music', seconds: 300 })).toBeCloseTo(0.75)
  })
})
