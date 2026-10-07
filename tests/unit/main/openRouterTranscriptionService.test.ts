// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenRouterTranscriptionService } from '../../../src/main/asr/openRouterTranscriptionService'
import { TRANSCRIPTION_MODEL, transcriptionTimeoutMs } from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

function setup(patch: Partial<AppSettings> = {}) {
  // Ephemeral test credential; no saved credential or literal API key is used.
  const credential = randomUUID()
  const settings = { ...DEFAULT_SETTINGS, llmApiKey: credential, ...patch }
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: '  Hello Sotto.  ' }))
  const service = new OpenRouterTranscriptionService({ getSettings: async () => settings, fetchFn })
  return { service, fetchFn, credential }
}

const request = { requestId: 'request-1', wav: new Uint8Array([82, 73, 70, 70, ...new Array<number>(44).fill(0)]).buffer, timeoutMs: 8_000 }
afterEach(() => vi.restoreAllMocks())

describe('OpenRouter transcription', () => {
  it('uploads raw WAV bytes as JSON base64 using the only transcription model', async () => {
    const { service, fetchFn, credential } = setup()
    expect(await service.transcribe(request)).toEqual({ ok: true, text: 'Hello Sotto.' })
    const [url, options] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions')
    expect(options?.method).toBe('POST')
    expect(new Headers(options?.headers).get('Content-Type')).toBe('application/json')
    expect(new Headers(options?.headers).get('Authorization') === `Bearer ${credential}`).toBe(true)
    expect(JSON.parse(String(options?.body))).toEqual({
      model: TRANSCRIPTION_MODEL,
      input_audio: { data: Buffer.from(request.wav).toString('base64'), format: 'wav' },
    })
  })

  it('passes an explicit ISO language and trimmed deduplicated dictionary as Azure phrases', async () => {
    const { service, fetchFn } = setup({ language: 'fr', llmDictionary: ' Sotto\n\nZache\nSotto\n' })
    await service.transcribe(request)
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({
      language: 'fr', provider: { options: { azure: { phraseList: { phrases: ['Sotto', 'Zache'] } } } },
    })
  })

  it('omits the phrase list for a blank dictionary', async () => {
    const { service, fetchFn } = setup({ llmDictionary: ' \n\n' })
    await service.transcribe(request)
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).not.toHaveProperty('provider')
  })

  it('bounds phrases to 200 entries of at most 100 characters', async () => {
    const { service, fetchFn } = setup({ llmDictionary: ['x'.repeat(101), 'y'.repeat(100), ...Array.from({ length: 250 }, (_, index) => `word-${index}`)].join('\n') })
    await service.transcribe(request)
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as { provider: { options: { azure: { phraseList: { phrases: string[] } } } } }
    expect(body.provider.options.azure.phraseList.phrases).toHaveLength(200)
    expect(body.provider.options.azure.phraseList.phrases.every((phrase) => phrase.length <= 100)).toBe(true)
    expect(body.provider.options.azure.phraseList.phrases[0]).toHaveLength(100)
  })

  it('returns unconfigured without making a request when credentials are absent or inaccessible', async () => {
    const { service, fetchFn } = setup({ llmApiKey: '' })
    expect(await service.transcribe(request)).toEqual({ ok: false, reason: 'unconfigured' })
    expect(fetchFn).not.toHaveBeenCalled()
    const inaccessible = new OpenRouterTranscriptionService({ getSettings: async () => { throw new Error('locked') }, fetchFn })
    expect(await inaccessible.transcribe(request)).toEqual({ ok: false, reason: 'unconfigured' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([[400, 'http'], [401, 'unauthorized'], [403, 'unauthorized'], [402, 'billing'], [429, 'rate-limited'], [500, 'http'], [503, 'http']] as const)(
    'maps HTTP %i to %s without retry when little time remains', async (status, reason) => {
      const { service, fetchFn } = setup()
      fetchFn.mockResolvedValue(new Response(null, { status }))
      expect(await service.transcribe({ ...request, timeoutMs: 1_499 })).toEqual({ ok: false, reason })
      expect(fetchFn).toHaveBeenCalledOnce()
    },
  )

  it.each([500, 503])('retries HTTP %i once', async (status) => {
    const { service, fetchFn } = setup()
    fetchFn.mockResolvedValueOnce(new Response(null, { status }))
    expect(await service.transcribe(request)).toEqual({ ok: true, text: 'Hello Sotto.' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('retries a network failure once, waits 300 ms, and does not expose error details', async () => {
    const { service, fetchFn, credential } = setup()
    fetchFn.mockRejectedValue(new Error(credential))
    const started = Date.now()
    const result = await service.transcribe(request)
    expect(result).toEqual({ ok: false, reason: 'network' })
    expect(JSON.stringify(result).includes(credential)).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(290)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('never retries an unauthorized response', async () => {
    const { service, fetchFn, credential } = setup()
    fetchFn.mockResolvedValue(new Response(credential, { status: 401 }))
    const result = await service.transcribe(request)
    expect(result).toEqual({ ok: false, reason: 'unauthorized' })
    expect(JSON.stringify(result).includes(credential)).toBe(false)
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('does not retry a network failure when under 1500 ms remain', async () => {
    const { service, fetchFn } = setup()
    fetchFn.mockRejectedValue(new TypeError('unreachable'))
    expect(await service.transcribe({ ...request, timeoutMs: 1_499 })).toEqual({ ok: false, reason: 'network' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('uses remaining deadline time, including time spent on the first attempt', async () => {
    const { service, fetchFn } = setup()
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    fetchFn.mockImplementation(async () => {
      now.mockReturnValue(16_501)
      return new Response(null, { status: 503 })
    })
    expect(await service.transcribe(request)).toEqual({ ok: false, reason: 'http' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('maps TimeoutError without retrying', async () => {
    const { service, fetchFn } = setup()
    fetchFn.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
    expect(await service.transcribe(request)).toEqual({ ok: false, reason: 'timeout' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('aborts an outstanding fetch at the real transcription deadline', async () => {
    const { service, fetchFn } = setup()
    let observedSignal: AbortSignal | null = null
    fetchFn.mockImplementation(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      observedSignal = options?.signal ?? null
      observedSignal?.addEventListener('abort', () => reject(observedSignal?.reason), { once: true })
    }))
    expect(await service.transcribe({ ...request, timeoutMs: 250 })).toEqual({ ok: false, reason: 'timeout' })
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true)
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('cancels during retry backoff without starting another fetch', async () => {
    const { service, fetchFn } = setup()
    fetchFn.mockResolvedValueOnce(new Response(null, { status: 503 }))
    const result = service.transcribe(request)
    // The first fetch resolves in microtasks; the next turn occurs during its 300 ms backoff.
    await nextTurn()
    expect(fetchFn).toHaveBeenCalledOnce()
    service.cancel(request.requestId)
    expect(await result).toEqual({ ok: false, reason: 'cancelled' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it.each([null, {}, { text: 12 }])('rejects malformed response %#', async (payload) => {
    const { service, fetchFn } = setup()
    fetchFn.mockResolvedValue(Response.json(payload))
    expect(await service.transcribe(request)).toEqual({ ok: false, reason: 'malformed' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('rejects non-JSON responses without exposing their contents', async () => {
    const { service, fetchFn, credential } = setup()
    fetchFn.mockResolvedValue(new Response(credential))
    const result = await service.transcribe(request)
    expect(result).toEqual({ ok: false, reason: 'malformed' })
    expect(JSON.stringify(result).includes(credential)).toBe(false)
  })

  it('lets the newest request with the same id win and cancels without retry', async () => {
    const { service, fetchFn } = setup()
    let firstStarted!: () => void
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    fetchFn.mockImplementationOnce(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
      firstStarted()
    }))
    const first = service.transcribe(request)
    await started
    const second = service.transcribe(request)
    expect(await first).toEqual({ ok: false, reason: 'cancelled' })
    expect(await second).toEqual({ ok: true, text: 'Hello Sotto.' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('dispose aborts uploads and unknown cancellation is a no-op', async () => {
    const { service, fetchFn } = setup()
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    fetchFn.mockImplementationOnce(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
      started()
    }))
    const result = service.transcribe(request)
    await ready
    service.cancel('unknown')
    service.dispose()
    expect(await result).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('computes the shared deadline from duration with bounds', () => {
    expect(transcriptionTimeoutMs(0)).toBe(15_000)
    expect(transcriptionTimeoutMs(9)).toBe(15_000)
    expect(transcriptionTimeoutMs(30)).toBe(17_000)
    expect(transcriptionTimeoutMs(300)).toBe(30_000)
  })
})

describe('rate-limited transcription', () => {
  // OpenRouter's answer when Azure, the provider behind the model, turns a request away.
  const providerLimited = (retryAfter: string | null = '1') => new Response(
    JSON.stringify({ error: { message: 'Provider returned 429', code: 429, metadata: { retry_after_seconds: 1, headers: { 'Retry-After': '1' } } } }),
    { status: 429, headers: retryAfter === null ? {} : { 'Retry-After': retryAfter } },
  )

  function limited(responses: Response[], patch: { timeoutMs?: number; random?: number } = {}) {
    const fetchFn = vi.fn<typeof fetch>()
    for (const response of responses) fetchFn.mockResolvedValueOnce(response)
    fetchFn.mockResolvedValue(Response.json({ text: 'Back again.' }))
    const waits: number[] = []
    const onFailure = vi.fn()
    const onRecovered = vi.fn()
    const service = new OpenRouterTranscriptionService({
      getSettings: async () => ({ ...DEFAULT_SETTINGS, llmApiKey: randomUUID() }),
      fetchFn,
      onFailure,
      onRecovered,
      // The waits are recorded rather than slept, so the backoff itself is the assertion.
      sleep: async (milliseconds) => { waits.push(milliseconds) },
      random: () => patch.random ?? 0,
    })
    return { service, fetchFn, waits, onFailure, onRecovered, request: { ...request, timeoutMs: patch.timeoutMs ?? 15_000 } }
  }

  it('waits out a provider rate limit for longer each time, then transcribes', async () => {
    const run = limited([providerLimited(), providerLimited()])
    expect(await run.service.transcribe(run.request)).toEqual({ ok: true, text: 'Back again.' })
    expect(run.fetchFn).toHaveBeenCalledTimes(3)
    expect(run.waits).toEqual([1_000, 2_000])
    expect(run.onFailure).not.toHaveBeenCalled()
    expect(run.onRecovered).toHaveBeenCalledWith(expect.objectContaining({ recovered: true, rateLimited: 2, attempts: 3, limitedBy: 'provider' }))
  })

  it('waits at least as long as Retry-After asks', async () => {
    const run = limited([providerLimited('3')])
    await run.service.transcribe(run.request)
    expect(run.waits).toEqual([3_000])
  })

  it('reads the wait from the answer when the header is missing', async () => {
    const answer = new Response(JSON.stringify({ error: { message: 'Provider returned 429', metadata: { retry_after_seconds: 2.5 } } }), { status: 429 })
    const run = limited([answer])
    await run.service.transcribe(run.request)
    expect(run.waits).toEqual([2_500])
  })

  it('adds jitter so the parts of one dictation do not retry together', async () => {
    const run = limited([providerLimited()], { random: 0.5 })
    await run.service.transcribe(run.request)
    expect(run.waits).toEqual([1_125])
  })

  it('gives up after three retries and records who limited it and how long it asked for', async () => {
    const run = limited([providerLimited(), providerLimited(), providerLimited(), providerLimited()], { timeoutMs: 30_000 })
    expect(await run.service.transcribe(run.request)).toEqual({ ok: false, reason: 'rate-limited' })
    expect(run.fetchFn).toHaveBeenCalledTimes(4)
    expect(run.waits).toEqual([1_000, 2_000, 4_000])
    expect(run.onFailure).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'rate-limited', status: 429, attempts: 4, limitedBy: 'provider', retryAfterMs: 1_000,
    }))
    expect(JSON.stringify(run.onFailure.mock.calls)).not.toContain('Provider returned')
    expect(run.onRecovered).not.toHaveBeenCalled()
  })

  it('tells OpenRouter’s own limit apart from the provider’s', async () => {
    const own = new Response(JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded' } }), {
      status: 429, headers: { 'X-RateLimit-Limit': '20', 'X-RateLimit-Remaining': '0' },
    })
    const run = limited([own], { timeoutMs: 1_499 })
    expect(await run.service.transcribe(run.request)).toEqual({ ok: false, reason: 'rate-limited' })
    expect(run.onFailure.mock.calls[0]?.[0]).toMatchObject({ limitedBy: 'openrouter' })
    expect(run.onFailure.mock.calls[0]?.[0]).not.toHaveProperty('retryAfterMs')
  })

  it('does not wait out a Retry-After longer than a retry can afford', async () => {
    const run = limited([providerLimited('20')])
    expect(await run.service.transcribe(run.request)).toEqual({ ok: false, reason: 'rate-limited' })
    expect(run.fetchFn).toHaveBeenCalledOnce()
    expect(run.onFailure.mock.calls[0]?.[0]).toMatchObject({ retryAfterMs: 20_000 })
  })

  it('stops retrying when the wait would leave too little of the deadline', async () => {
    const run = limited([providerLimited()], { timeoutMs: 2_400 })
    expect(await run.service.transcribe(run.request)).toEqual({ ok: false, reason: 'rate-limited' })
    expect(run.fetchFn).toHaveBeenCalledOnce()
    expect(run.waits).toEqual([])
  })

  it('reports a rate-limited request whose last retry runs out of time as rate limited', async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(providerLimited())
      // The retry is cut off by the request's deadline.
      .mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
    const onFailure = vi.fn()
    const service = new OpenRouterTranscriptionService({
      getSettings: async () => ({ ...DEFAULT_SETTINGS, llmApiKey: randomUUID() }),
      fetchFn,
      onFailure,
      sleep: async () => undefined,
      random: () => 0,
    })
    expect(await service.transcribe({ ...request, timeoutMs: 4_500 })).toEqual({ ok: false, reason: 'rate-limited' })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ reason: 'rate-limited', attempts: 2, limitedBy: 'provider' }))
  })

  it('leaves a rate-limit retry room to upload and transcribe its part', async () => {
    const run = limited([providerLimited()], { timeoutMs: 3_900 })
    expect(await run.service.transcribe(run.request)).toEqual({ ok: false, reason: 'rate-limited' })
    expect(run.fetchFn).toHaveBeenCalledOnce()
  })

  it('cancels while waiting out a rate limit without another attempt', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(providerLimited())
    let waiting!: () => void
    const waited = new Promise<void>((resolve) => { waiting = resolve })
    const service = new OpenRouterTranscriptionService({
      getSettings: async () => ({ ...DEFAULT_SETTINGS, llmApiKey: randomUUID() }),
      fetchFn,
      sleep: (_milliseconds, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        waiting()
      }),
    })
    const result = service.transcribe({ ...request, timeoutMs: 15_000 })
    await waited
    service.cancel(request.requestId)
    expect(await result).toEqual({ ok: false, reason: 'cancelled' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })
})

describe('transcription diagnostics', () => {
  // One second of 16 kHz PCM16 audio behind a 44-byte header.
  const oneSecond = { ...request, wav: new ArrayBuffer(44 + 32_000) }

  function recorded(fetchFn: typeof fetch) {
    const credential = randomUUID()
    const onFailure = vi.fn()
    let clock = 5_000
    const service = new OpenRouterTranscriptionService({
      getSettings: async () => ({ ...DEFAULT_SETTINGS, llmApiKey: credential, llmDictionary: 'Sotto' }),
      fetchFn,
      onFailure,
      now: () => (clock += 250),
    })
    return { service, onFailure, credential }
  }

  it.each([[402, 'billing'], [429, 'rate-limited'], [400, 'http']] as const)(
    'records HTTP %i as %s with its status and nothing that was said', async (status, reason) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"private body"}', { status }))
      const { service, onFailure, credential } = recorded(fetchFn)
      await service.transcribe({ ...oneSecond, timeoutMs: 1_499 })
      expect(onFailure).toHaveBeenCalledOnce()
      expect(onFailure).toHaveBeenCalledWith({ at: 5_250, reason, status, attempts: 1, audioMs: 1_000, elapsedMs: 250 })
      const written = JSON.stringify(onFailure.mock.calls)
      expect(written).not.toContain('private body')
      expect(written).not.toContain('Sotto')
      expect(written.includes(credential)).toBe(false)
    },
  )

  it('records the retry as a second attempt', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))
    const { service, onFailure } = recorded(fetchFn)
    expect(await service.transcribe(oneSecond)).toEqual({ ok: false, reason: 'http' })
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ reason: 'http', status: 503, attempts: 2 }))
  })

  it('keeps only the last attempt status, so a 503 then a network failure records none', async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new TypeError('unreachable'))
    const { service, onFailure } = recorded(fetchFn)
    expect(await service.transcribe(oneSecond)).toEqual({ ok: false, reason: 'network' })
    expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ reason: 'network', attempts: 2 })
    expect(onFailure.mock.calls[0]?.[0]).not.toHaveProperty('status')
  })

  it('records a network failure without a status and a missing key without an attempt', async () => {
    const offline = recorded(vi.fn<typeof fetch>().mockRejectedValue(new TypeError('unreachable')))
    await offline.service.transcribe({ ...oneSecond, timeoutMs: 1_499 })
    expect(offline.onFailure.mock.calls[0]?.[0]).toEqual({ at: 5_250, reason: 'network', attempts: 1, audioMs: 1_000, elapsedMs: 250 })

    const fetchFn = vi.fn<typeof fetch>()
    const onFailure = vi.fn()
    const unkeyed = new OpenRouterTranscriptionService({ getSettings: async () => DEFAULT_SETTINGS, fetchFn, onFailure })
    await unkeyed.transcribe(oneSecond)
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ reason: 'unconfigured', attempts: 0 }))
    expect(onFailure.mock.calls[0]?.[0]).not.toHaveProperty('status')
  })

  it('records nothing for a success or a request the user cancelled', async () => {
    const ok = recorded(vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: 'fine' })))
    await ok.service.transcribe(oneSecond)
    expect(ok.onFailure).not.toHaveBeenCalled()

    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    }))
    const cancelled = recorded(fetchFn)
    const result = cancelled.service.transcribe(oneSecond)
    await nextTurn()
    cancelled.service.cancel(oneSecond.requestId)
    expect(await result).toEqual({ ok: false, reason: 'cancelled' })
    expect(cancelled.onFailure).not.toHaveBeenCalled()
  })

  it('still answers when the diagnostic cannot be recorded', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 402 }))
    const service = new OpenRouterTranscriptionService({
      getSettings: async () => ({ ...DEFAULT_SETTINGS, llmApiKey: randomUUID() }),
      fetchFn,
      onFailure: () => { throw new Error('disk full') },
    })
    expect(await service.transcribe(oneSecond)).toEqual({ ok: false, reason: 'billing' })
  })
})

describe('OpenRouter key verification', () => {
  it.each([[200, null], [401, 'unauthorized'], [403, 'unauthorized'], [402, 'http'], [429, 'http'], [500, 'http']] as const)(
    'maps status %i without returning credentials', async (status, reason) => {
      const { service, fetchFn, credential } = setup()
      fetchFn.mockResolvedValue(new Response(credential, { status }))
      const result = await service.checkKey()
      expect(result).toEqual(reason === null ? { ok: true } : { ok: false, reason })
      expect(fetchFn.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/key')
      expect(fetchFn.mock.calls[0]?.[1]?.method).toBe('GET')
      expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get('Authorization') === `Bearer ${credential}`).toBe(true)
      expect(JSON.stringify(result).includes(credential)).toBe(false)
      expect(fetchFn).toHaveBeenCalledOnce()
    },
  )

  it.each(['network', 'timeout'] as const)('maps %s errors', async (reason) => {
    const { service, fetchFn, credential } = setup()
    fetchFn.mockRejectedValue(reason === 'timeout' ? new DOMException(credential, 'TimeoutError') : new Error(credential))
    const result = await service.checkKey()
    expect(result).toEqual({ ok: false, reason })
    expect(JSON.stringify(result).includes(credential)).toBe(false)
  })

  it('requires a stored key', async () => {
    const { service, fetchFn } = setup({ llmApiKey: '' })
    expect(await service.checkKey()).toEqual({ ok: false, reason: 'unconfigured' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('uses a five-second timeout for key verification', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const { service } = setup()
    await service.checkKey()
    expect(timeout).toHaveBeenCalledWith(5_000)
  })

  it('rejects a success response arriving after the key-check deadline', async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const { service, fetchFn } = setup()
    fetchFn.mockImplementation(async () => {
      deadline.abort(new DOMException('timed out', 'TimeoutError'))
      return new Response(null, { status: 200 })
    })
    expect(await service.checkKey()).toEqual({ ok: false, reason: 'timeout' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })
})
