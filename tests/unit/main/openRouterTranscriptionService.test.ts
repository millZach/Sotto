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

  it.each([429, 500, 503])('retries HTTP %i once', async (status) => {
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
    expect(transcriptionTimeoutMs(0)).toBe(8_000)
    expect(transcriptionTimeoutMs(2)).toBe(8_600)
    expect(transcriptionTimeoutMs(4.4)).toBe(9_320)
    expect(transcriptionTimeoutMs(300)).toBe(30_000)
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
