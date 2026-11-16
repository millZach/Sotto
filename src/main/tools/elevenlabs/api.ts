import { z } from 'zod'

/**
 * ElevenLabs' API behind one adapter (ADR-0205; the plugins plan's slice 12, part 2). Every call goes to
 * `api.elevenlabs.io` with the account's key in the `xi-api-key` header, over Node's own `fetch`, with no redirect
 * followed and nothing from Electron, so a headless host can run the same code. Read from elevenlabs.io/docs on
 * November 15, 2026: speech is `POST /v1/text-to-speech/{voice_id}`, a sound effect `POST /v1/sound-generation` and
 * music `POST /v1/music`, and each answers with the MP3 itself. The account's voices are `GET /v2/voices`, a page at a
 * time: the older `/v1/voices` is deprecated and stops answering past 500 voices (Sol's review).
 *
 * A failure is an `ElevenLabsApiError` naming what happened in one word; it never repeats the key, an address or what
 * ElevenLabs wrote.
 */
export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io'

/** How ElevenLabs' API is reached: `fetch` as main and the host have it, with no redirect followed. */
export type ElevenLabsApiFetch = (url: string, init: {
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly redirect: 'manual'
  readonly signal: AbortSignal
}) => Promise<Response>

/** What a thread can make with ElevenLabs (Zach's pick on #2498): words spoken, a sound effect, or music. */
export const SOUND_KINDS = ['speech', 'effect', 'music'] as const
export type SoundKind = (typeof SOUND_KINDS)[number]

/**
 * What went wrong, in one word. `refused`: ElevenLabs does not take the key (401), or the key may not do this (403).
 * `no-credits`: the account has none left for it (ElevenLabs' `quota_exceeded`). `rejected`: ElevenLabs will not make
 * this one (400, 404 for a voice it does not have, 422), or Sotto would not send it. `busy`: try again later (429).
 * `unreachable`: no answer, or ElevenLabs failed (5xx). `unreadable`: an answer Sotto could not read.
 */
export type ElevenLabsProblem = 'refused' | 'no-credits' | 'rejected' | 'busy' | 'unreachable' | 'unreadable'

export class ElevenLabsApiError extends Error {
  constructor(readonly problem: ElevenLabsProblem, readonly retryAfterMs?: number) { super(`elevenlabs-${problem}`) }
}

/** The MP3 Sotto asks for: 44.1 kHz at 128 kbps, which every plan may have. */
export const SOUND_FORMAT = 'mp3_44100_128'
/** The speech model: Multilingual v2, which takes up to 10,000 characters a request. */
export const SPEECH_MODEL = 'eleven_multilingual_v2'
export const SPEECH_CHARACTERS_MAX = 10_000
/** A sound effect's length, as ElevenLabs takes it. */
export const EFFECT_SECONDS_MIN = 0.5
export const EFFECT_SECONDS_MAX = 30
/**
 * Music's length: 3 seconds to 5 minutes. ElevenLabs' music reference takes up to 10 minutes, and its pricing page says 5;
 * Sotto holds to 5.
 */
export const MUSIC_SECONDS_MIN = 3
export const MUSIC_SECONDS_MAX = 300
/** The words a sound effect or music is made from: short, as a prompt is. */
export const SOUND_WORDS_MAX = 2_000
/** A voice ID Sotto will put in a path: ElevenLabs' are short runs of letters and digits. */
export const VOICE_ID = /^[A-Za-z0-9]{1,64}$/u

/**
 * ElevenLabs' published API prices on November 15, 2026 (elevenlabs.io/pricing/api), in US dollars: speech with
 * Multilingual v2 at $0.08 for 1,000 characters, sound effects at $0.12 a minute and music at $0.15 a minute. The
 * monthly limit counts with these (Zach's pick on #2498).
 */
export const SOUND_PRICES = { speechPerThousandCharacters: 0.08, effectPerMinute: 0.12, musicPerMinute: 0.15 } as const

/** What one sound would cost at the published prices, in US dollars. An effect with no length is priced at its longest. */
export function soundCost(request: { readonly kind: 'speech'; readonly characters: number } | { readonly kind: 'effect'; readonly seconds?: number | undefined } | { readonly kind: 'music'; readonly seconds: number }): number {
  switch (request.kind) {
    case 'speech': return (Math.max(0, request.characters) / 1_000) * SOUND_PRICES.speechPerThousandCharacters
    case 'effect': return ((request.seconds ?? EFFECT_SECONDS_MAX) / 60) * SOUND_PRICES.effectPerMinute
    case 'music': return (request.seconds / 60) * SOUND_PRICES.musicPerMinute
  }
}

/** One of the account's voices, by ElevenLabs' ID and the name the agent asks for it by. */
export interface ElevenLabsVoice { readonly id: string; readonly name: string }
/** Voices are read 100 to a page, and at most 20 pages: far past any account's, and short of a runaway answer. */
const VOICES_PAGE = 100
const VOICES_PAGES_MAX = 20
const voicesPageSchema = z.object({
  voices: z.array(z.object({ voice_id: z.string(), name: z.string() }).loose()).max(VOICES_PAGE),
  has_more: z.boolean().optional().catch(false),
  next_page_token: z.string().max(1_000).nullish().catch(undefined),
}).loose()
/** The most of a refusal Sotto reads, to find its status word. */
const REFUSAL_BYTES_MAX = 4_096
/** ElevenLabs' refusal names what it is in a short word, read only to tell no credits apart from a refused key. */
const refusalSchema = z.object({ detail: z.object({ status: z.string().max(100) }).loose() }).loose()

/** Five minutes for a sound to be made: music runs longest, and ElevenLabs answers with the whole file. */
const MAKE_TIMEOUT_MS = 5 * 60_000
const READ_TIMEOUT_MS = 30_000
/** A `Retry-After` is followed within these bounds, so a wrong one neither hammers ElevenLabs nor stalls a thread. */
const RETRY_AFTER_MIN_MS = 1_000
const RETRY_AFTER_MAX_MS = 10 * 60_000

/** One account's way to ElevenLabs. */
export class ElevenLabsApi {
  private readonly base: string
  constructor(private readonly fetcher: ElevenLabsApiFetch, private readonly key: string, private readonly options: { readonly base?: string; readonly signal?: AbortSignal } = {}) {
    this.base = options.base ?? ELEVENLABS_API_BASE
  }

  /** The account's voices, by name, for the agent to choose from. A voice without an ID or a name is left out. */
  async voices(): Promise<readonly ElevenLabsVoice[]> {
    const found: ElevenLabsVoice[] = []
    let token: string | undefined
    for (let page = 0; page < VOICES_PAGES_MAX; page++) {
      const query = new URLSearchParams({ page_size: String(VOICES_PAGE), ...(token ? { next_page_token: token } : {}) })
      const response = await this.call(`/v2/voices?${query.toString()}`, 'GET', undefined, READ_TIMEOUT_MS)
      let read: unknown
      try { read = await response.json() } catch { throw new ElevenLabsApiError('unreadable') }
      const parsed = voicesPageSchema.safeParse(read)
      if (!parsed.success) throw new ElevenLabsApiError('unreadable')
      for (const voice of parsed.data.voices) {
        if (VOICE_ID.test(voice.voice_id) && voice.name.trim().length > 0) found.push({ id: voice.voice_id, name: voice.name.trim().slice(0, 200) })
      }
      token = parsed.data.has_more === true && parsed.data.next_page_token ? parsed.data.next_page_token : undefined
      if (!token) break
    }
    return found
  }

  /** Speaks `text` in one of the account's voices. The answer's body is the MP3. */
  speech(request: { readonly voiceId: string; readonly text: string }): Promise<Response> {
    if (!VOICE_ID.test(request.voiceId) || request.text.trim().length === 0 || request.text.length > SPEECH_CHARACTERS_MAX) return Promise.reject(new ElevenLabsApiError('rejected'))
    return this.call(`/v1/text-to-speech/${request.voiceId}?output_format=${SOUND_FORMAT}`, 'POST', JSON.stringify({ text: request.text, model_id: SPEECH_MODEL }), MAKE_TIMEOUT_MS)
  }

  /** Makes a sound effect from words, `seconds` long, or as long as ElevenLabs judges when none is given. */
  soundEffect(request: { readonly words: string; readonly seconds?: number }): Promise<Response> {
    if (!wordsFit(request.words) || (request.seconds !== undefined && !within(request.seconds, EFFECT_SECONDS_MIN, EFFECT_SECONDS_MAX))) return Promise.reject(new ElevenLabsApiError('rejected'))
    return this.call(`/v1/sound-generation?output_format=${SOUND_FORMAT}`, 'POST',
      JSON.stringify({ text: request.words, ...(request.seconds !== undefined ? { duration_seconds: request.seconds } : {}) }), MAKE_TIMEOUT_MS)
  }

  /** Makes music from words, `seconds` long, with no singing when `instrumental`. */
  music(request: { readonly words: string; readonly seconds: number; readonly instrumental: boolean }): Promise<Response> {
    if (!wordsFit(request.words) || !within(request.seconds, MUSIC_SECONDS_MIN, MUSIC_SECONDS_MAX)) return Promise.reject(new ElevenLabsApiError('rejected'))
    return this.call(`/v1/music?output_format=${SOUND_FORMAT}`, 'POST',
      JSON.stringify({ prompt: request.words, music_length_ms: Math.round(request.seconds * 1_000), force_instrumental: request.instrumental }), MAKE_TIMEOUT_MS)
  }

  private async call(path: string, method: 'GET' | 'POST', payload: string | undefined, timeoutMs: number): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await this.fetcher(new URL(path, this.base).toString(), {
        method, redirect: 'manual',
        headers: { 'xi-api-key': this.key, Accept: method === 'GET' ? 'application/json' : 'audio/mpeg', ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload !== undefined ? { body: payload } : {}),
        signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout,
      })
    } catch { throw new ElevenLabsApiError('unreachable') }
    if (response.status >= 200 && response.status < 300) return response
    throw await problemOf(response)
  }
}

const wordsFit = (words: string): boolean => words.trim().length > 0 && words.length <= SOUND_WORDS_MAX
const within = (value: number, min: number, max: number): boolean => Number.isFinite(value) && value >= min && value <= max

/**
 * What a refusal means. Only a 401's short status word is read, to tell an account out of credits from a key
 * ElevenLabs does not take; nothing ElevenLabs wrote reaches the user, the agent or a log.
 */
async function problemOf(response: Response): Promise<ElevenLabsApiError> {
  const status = response.status
  if (status === 401) {
    let said: unknown
    try { said = JSON.parse(await firstBytes(response, REFUSAL_BYTES_MAX)) } catch { said = undefined }
    const parsed = refusalSchema.safeParse(said)
    return new ElevenLabsApiError(parsed.success && parsed.data.detail.status === 'quota_exceeded' ? 'no-credits' : 'refused')
  }
  await response.body?.cancel().catch(() => undefined)
  if (status === 403) return new ElevenLabsApiError('refused')
  if (status === 429) return new ElevenLabsApiError('busy', retryAfter(response))
  if (status === 400 || status === 404 || status === 422) return new ElevenLabsApiError('rejected')
  return new ElevenLabsApiError('unreachable')
}

/** The start of an answer's body as text, reading no more than `max` bytes of it and letting the rest go. */
async function firstBytes(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const parts: Uint8Array[] = []
  let held = 0
  try {
    while (held < max) {
      const chunk = await reader.read()
      if (chunk.done) break
      parts.push(chunk.value.subarray(0, max - held))
      held += Math.min(chunk.value.byteLength, max - held)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  return new TextDecoder().decode(Buffer.concat(parts))
}

/** ElevenLabs' `Retry-After`, in seconds or as a date, held within bounds; undefined when it sent none Sotto can read. */
export function retryAfter(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const ms = /^\d+$/u.test(value) ? Number(value) * 1_000 : Date.parse(value) - now
  if (!Number.isFinite(ms)) return undefined
  return Math.max(RETRY_AFTER_MIN_MS, Math.min(RETRY_AFTER_MAX_MS, ms))
}
