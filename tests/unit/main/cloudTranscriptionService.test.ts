// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  CloudTranscriptionService,
  type CloudSpeechModelSource,
  type CloudTranscriptionFailureDiagnostic,
  type CloudTranscriptionRecoveryDiagnostic,
} from '../../../src/main/asr/cloudTranscriptionService'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { encodeWavPcm16 } from '../../../src/shared/wav'
import { deferred } from '../../fixtures/deferred'

const wav = encodeWavPcm16(new Float32Array(16_000).fill(0.25), 16_000).buffer as ArrayBuffer
const request = { requestId: 'segment-1', wav, timeoutMs: 15_000 }
const body = (fetchFn: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): Record<string, unknown> =>
  JSON.parse(String(fetchFn.mock.calls[call]?.[1]?.body)) as Record<string, unknown>

function setup(patch: Partial<AppSettings> = {}, models: Partial<CloudSpeechModelSource> = {}) {
  // Ephemeral test credential; no saved credential or literal API key is used.
  const credential = randomUUID()
  const settings: AppSettings = { ...DEFAULT_SETTINGS, llmApiKey: credential, cloudTranscription: true, cloudSpeechModel: 'elevenlabs/scribe-v2', ...patch }
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: '  Hello Sotto.  ' }))
  const sleep = vi.fn(async (_milliseconds: number, _signal: AbortSignal) => undefined)
  const failures: CloudTranscriptionFailureDiagnostic[] = []
  const recoveries: CloudTranscriptionRecoveryDiagnostic[] = []
  const service = new CloudTranscriptionService({
    getSettings: async () => settings,
    models: { best: async () => 'microsoft/mai-transcribe-2', hasZeroRetentionHost: async () => true, ...models },
    fetchFn,
    sleep,
    random: () => 0,
    now: () => 5_000,
    onFailure: (diagnostic) => failures.push(diagnostic),
    onRecovered: (diagnostic) => recoveries.push(diagnostic),
  })
  return { service, fetchFn, sleep, failures, recoveries, credential }
}

describe('CloudTranscriptionService', () => {
  it('sends the segment as base64 WAV to the chosen model, only to a host that keeps no audio, and returns trimmed text', async () => {
    const { service, fetchFn, credential } = setup()
    expect(await service.transcribe(request)).toEqual({ ok: true, text: 'Hello Sotto.' })
    const [url, options] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
    expect(new Headers(options?.headers).get('Authorization') === `Bearer ${credential}`).toBe(true)
    expect(body(fetchFn)).toEqual({
      model: 'elevenlabs/scribe-v2',
      input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' },
      provider: { zdr: true },
    })
  })

  it('leaves out zero-retention routing for a model with no such host', async () => {
    const { service, fetchFn } = setup({}, { hasZeroRetentionHost: async () => false })
    await service.transcribe(request)
    expect(body(fetchFn)).not.toHaveProperty('provider')
  })

  it('uses the first model in the ranking when none is chosen, and says OpenRouter cannot be reached when there is no ranking', async () => {
    const chosen = setup({ cloudSpeechModel: null })
    await chosen.service.transcribe(request)
    expect(body(chosen.fetchFn)).toMatchObject({ model: 'microsoft/mai-transcribe-2' })
    const unread = setup({ cloudSpeechModel: null }, { best: async () => null })
    expect(await unread.service.transcribe(request)).toEqual({ ok: false, reason: 'network' })
    expect(unread.fetchFn).not.toHaveBeenCalled()
  })

  it('says no key is saved, without a request, when the key is missing or cannot be read', async () => {
    const { service, fetchFn } = setup({ llmApiKey: '' })
    expect(await service.transcribe(request)).toEqual({ ok: false, reason: 'no-key' })
    const locked = new CloudTranscriptionService({ getSettings: async () => { throw new Error('locked') }, models: { best: async () => null, hasZeroRetentionHost: async () => false }, fetchFn })
    expect(await locked.transcribe(request)).toEqual({ ok: false, reason: 'no-key' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('sends the dictionary as spelling hints, bounded to 200 terms of 100 characters', async () => {
    const { service, fetchFn } = setup({ llmDictionary: ['Sotto', 'Zache', 'x'.repeat(120), ...Array.from({ length: 250 }, (_, index) => `word-${index}`)].join('\n') })
    await service.transcribe(request)
    const keyterms = body(fetchFn).keyterms as string[]
    expect(keyterms.slice(0, 2)).toEqual(['Sotto', 'Zache'])
    expect(keyterms).toHaveLength(200)
    expect(keyterms.every((term) => term.length <= 100)).toBe(true)
  })

  it('asks again without hints when a model refuses them, and stops offering that model hints', async () => {
    const { service, fetchFn } = setup({ llmDictionary: 'Sotto' })
    fetchFn.mockResolvedValueOnce(new Response('{"error":{"message":"keyterms not supported"}}', { status: 400 }))
    expect(await service.transcribe(request)).toEqual({ ok: true, text: 'Hello Sotto.' })
    expect(body(fetchFn, 0)).toHaveProperty('keyterms')
    expect(body(fetchFn, 1)).not.toHaveProperty('keyterms')
    await service.transcribe({ ...request, requestId: 'segment-2' })
    expect(body(fetchFn, 2)).not.toHaveProperty('keyterms')
  })

  it('fails a 400 without hints at once, as a failed transcription', async () => {
    const { service, fetchFn } = setup()
    fetchFn.mockResolvedValue(new Response(null, { status: 400 }))
    expect(await service.transcribe(request)).toEqual({ ok: false, reason: 'failed' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it.each([[401, 'unauthorized'], [403, 'unauthorized'], [402, 'billing'], [404, 'model-unavailable']] as const)(
    'says HTTP %i is %s and does not retry it', async (status, reason) => {
      const { service, fetchFn, credential } = setup()
      fetchFn.mockResolvedValue(new Response(credential, { status }))
      const result = await service.transcribe(request)
      expect(result).toEqual({ ok: false, reason })
      expect(JSON.stringify(result).includes(credential)).toBe(false)
      expect(fetchFn).toHaveBeenCalledOnce()
    },
  )

  it('retries a server error and a dropped connection once each', async () => {
    const server = setup()
    server.fetchFn.mockResolvedValueOnce(new Response(null, { status: 503 }))
    expect(await server.service.transcribe(request)).toEqual({ ok: true, text: 'Hello Sotto.' })
    expect(server.sleep).toHaveBeenCalledWith(300, expect.any(AbortSignal))
    const offline = setup()
    offline.fetchFn.mockRejectedValue(new TypeError('offline'))
    expect(await offline.service.transcribe(request)).toEqual({ ok: false, reason: 'network' })
    expect(offline.fetchFn).toHaveBeenCalledTimes(2)
  })

  it('waits out a rate limit as long as Retry-After asks, and records that the retry worked', async () => {
    const { service, fetchFn, sleep, recoveries } = setup()
    fetchFn.mockResolvedValueOnce(new Response('{"error":{"message":"Provider returned 429"}}', { status: 429, headers: { 'Retry-After': '3' } }))
    expect(await service.transcribe(request)).toEqual({ ok: true, text: 'Hello Sotto.' })
    expect(sleep).toHaveBeenCalledWith(3_000, expect.any(AbortSignal))
    expect(recoveries).toEqual([expect.objectContaining({ route: 'openrouter', model: 'elevenlabs/scribe-v2', recovered: true, rateLimited: 1, limitedBy: 'provider' })])
  })

  it('gives up on a rate limit after three waits and records who set it, never what was said or the key', async () => {
    const { service, fetchFn, sleep, failures, credential } = setup({ llmDictionary: 'Zache' })
    fetchFn.mockImplementation(async () => new Response('{"error":{"message":"Rate limit"}}', { status: 429, headers: { 'X-RateLimit-Limit': '20' } }))
    expect(await service.transcribe({ ...request, timeoutMs: 30_000 })).toEqual({ ok: false, reason: 'rate-limited' })
    expect(sleep.mock.calls.map(([wait]) => wait)).toEqual([1_000, 2_000, 4_000])
    expect(failures).toEqual([expect.objectContaining({ route: 'openrouter', model: 'elevenlabs/scribe-v2', reason: 'rate-limited', status: 429, attempts: 4, limitedBy: 'openrouter', audioMs: 1_000 })])
    const recorded = JSON.stringify(failures)
    for (const secret of [credential, 'Zache', 'Hello']) expect(recorded.includes(secret)).toBe(false)
  })

  it('says a cancelled segment was cancelled, aborts its request and records nothing', async () => {
    const { service, fetchFn, failures } = setup()
    const answer = deferred<Response>()
    let signal: AbortSignal | undefined
    fetchFn.mockImplementation(async (_url, options) => {
      signal = options?.signal ?? undefined
      return answer.promise
    })
    const result = service.transcribe(request)
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce())
    service.cancel('segment-1')
    answer.resolve(Response.json({ text: 'late' }))
    expect(await result).toEqual({ ok: false, reason: 'cancelled' })
    expect(signal?.aborted).toBe(true)
    expect(failures).toEqual([])
  })

  it('says a reply without text is malformed', async () => {
    const { service, fetchFn } = setup()
    fetchFn.mockResolvedValue(Response.json({ usage: { seconds: 1 } }))
    expect(await service.transcribe(request)).toEqual({ ok: false, reason: 'malformed' })
  })
})
