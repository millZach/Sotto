// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GrokSpeechService } from '../../../src/main/agents/grokSpeech'

function wave(): Buffer {
  const audio = Buffer.alloc(48)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(40, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(24000, 24)
  audio.writeUInt32LE(48000, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(4, 40)
  audio.writeInt16LE(1000, 44)
  return audio
}

function audioResponse(audio = wave(), headers: Record<string, string> = {}) {
  return new Response(new Uint8Array(audio), { headers: { 'content-type': 'audio/wav', ...headers } })
}

function setup(fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => audioResponse()), key = 'explicit-speech-key') {
  const credentials = { get: vi.fn(() => key) }
  return { service: new GrokSpeechService({ credentials, fetchFn }), credentials, fetchFn }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('GrokSpeechService', () => {
  it('posts the exact requested voice and reply to the fixed API, using only the separately saved speech credential', async () => {
    vi.stubEnv('XAI_API_KEY', 'must-not-use-env')
    vi.stubEnv('GROK_API_KEY', 'must-not-use-other-env')
    const { service, fetchFn, credentials } = setup()
    const reply = 'Ready, Zach. Your project is open.'
    const result = await service.synthesize(reply, 'team-custom-voice-123')
    expect(credentials.get).toHaveBeenCalledExactlyOnceWith('grokSpeech')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, request] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://api.x.ai/v1/tts')
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer explicit-speech-key', 'Content-Type': 'application/json' } })
    expect(JSON.parse(request!.body as string)).toEqual({ text: reply, voice_id: 'team-custom-voice-123', language: 'auto', output_format: { codec: 'wav', sample_rate: 24000 } })
    expect(result).toEqual({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav' })
  })

  it('returns every voice from the native catalog including newly introduced and custom entries', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ voices: [
      { voice_id: 'eve', name: 'Eve', description: 'Upbeat' },
      { voice_id: 'new-future-voice', name: 'Future Voice' },
      { voice_id: 'custom:my-voice-123', name: 'My Voice' },
    ] }), { headers: { 'content-type': 'application/json' } }))
    const { service } = setup(fetchFn)
    expect(await service.voices()).toEqual([
      { id: 'eve', name: 'Eve' }, { id: 'new-future-voice', name: 'Future Voice' }, { id: 'custom:my-voice-123', name: 'My Voice' },
    ])
    expect(fetchFn).toHaveBeenCalledWith('https://api.x.ai/v1/tts/voices', expect.objectContaining({ method: 'GET', redirect: 'error' }))
    expect(fetchFn.mock.calls[0]![1]!.body).toBeUndefined()
  })

  it.each([0x7fffffff, 0xffffffff])('finalizes streaming WAV lengths (%i) without changing audio samples', async size => {
    // The live xAI response uses data=0x7fffffff and RIFF=0x80000023.
    const audio = wave()
    audio.writeUInt32LE((size + 36) >>> 0, 4)
    audio.writeUInt32LE(size, 40)
    const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(audioResponse(audio)))
    const result = await service.synthesize('Hi', 'altair')
    expect(Buffer.from(result.audioBase64, 'base64')).toEqual(wave())
  })

  it.each(['empty', 'partial sample', 'missing format', 'zero alignment'])('rejects a streaming WAV with %s', async kind => {
    let audio = wave()
    audio.writeUInt32LE(0x80000023, 4)
    audio.writeUInt32LE(0x7fffffff, 40)
    if (kind === 'empty') audio = audio.subarray(0, 44)
    if (kind === 'partial sample') audio = audio.subarray(0, 47)
    if (kind === 'missing format') audio.write('JUNK', 12)
    if (kind === 'zero alignment') audio.writeUInt16LE(0, 32)
    const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(audioResponse(audio)))
    await expect(service.synthesize('Hi', 'altair')).rejects.toThrow('invalid WAV')
  })

  it('pads an odd streaming data length without counting the padding as audio', async () => {
    const audio = wave().subarray(0, 47)
    audio.writeUInt32LE(0x80000023, 4)
    audio.writeUInt32LE(0x7fffffff, 40)
    audio.writeUInt32LE(24000, 28)
    audio.writeUInt16LE(1, 32)
    audio.writeUInt16LE(8, 34)
    const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(audioResponse(audio)))
    const result = Buffer.from((await service.synthesize('Hi', 'altair')).audioBase64, 'base64')
    expect(result.length).toBe(48)
    expect(result.readUInt32LE(4)).toBe(40)
    expect(result.readUInt32LE(40)).toBe(3)
    expect(result.subarray(44, 47)).toEqual(audio.subarray(44))
    expect(result[47]).toBe(0)
  })

  it('does not use environment or other saved keys when the speech key is missing', async () => {
    vi.stubEnv('XAI_API_KEY', 'environment-key')
    const fetchFn = vi.fn<typeof fetch>()
    const credentials = { get: vi.fn((slot: string) => slot === 'grokSpeech' ? '' : 'reasoning-key') }
    const service = new GrokSpeechService({ credentials, fetchFn })
    await expect(service.synthesize('Hi', 'eve')).rejects.toThrow('Save an xAI API key')
    await expect(service.voices()).rejects.toThrow('Save an xAI API key')
    expect(credentials.get.mock.calls).toEqual([['grokSpeech'], ['grokSpeech']])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('keeps credential store failures sanitized and performs no request', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const service = new GrokSpeechService({ credentials: { get() { throw new Error('SECRET credential diagnostic') } }, fetchFn })
    await expect(service.synthesize('Hi', 'eve')).rejects.toThrow('Unlock your operating system credential store')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    ['', 'eve'], [' '.repeat(4), 'eve'], ['x'.repeat(2001), 'eve'], ['Hi', ''], ['Hi', 'x'.repeat(257)], ['Hi', 'eve\n'],
  ])('rejects invalid input before any billable request (%#)', async (text, voice) => {
    const { service, fetchFn } = setup()
    await expect(service.synthesize(text, voice)).rejects.toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'rejected the API key'], [403, 'API permissions'], [402, 'API credits'],
    [429, 'API usage limit'], [500, 'temporarily unavailable'], [503, 'temporarily unavailable'],
    [400, 'Refresh the available voices'], [404, 'Refresh the available voices'], [422, 'Refresh the available voices'],
  ])('explains HTTP %i without exposing its response or automatically retrying', async (status, message) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('SECRET token and spoken private text', { status }))
    const { service } = setup(fetchFn)
    const error = await service.synthesize('A private reply', 'eve').catch(reason => reason as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(message)
    expect((error as Error).message).not.toMatch(/SECRET|private/)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('sanitizes network and redirect failures without retrying', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error('redirect from Bearer SECRET'))
    const { service } = setup(fetchFn)
    await expect(service.synthesize('Hi', 'eve')).rejects.toThrow('Could not reach Grok speech')
    expect(fetchFn.mock.calls[0]![1]!.redirect).toBe('error')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('cancels promptly and allows a new request even when the old network ignores cancellation', async () => {
    let release!: (response: Response) => void
    const fetchFn = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockImplementationOnce(async () => audioResponse())
    const { service } = setup(fetchFn)
    const first = service.synthesize('Old reply', 'eve')
    const rejected = expect(first).rejects.toThrow('cancelled')
    const signal = fetchFn.mock.calls[0]![1]!.signal!
    service.cancel()
    await rejected
    expect(signal.aborted).toBe(true)
    expect((await service.synthesize('New reply', 'ara')).mimeType).toBe('audio/wav')
    release(audioResponse())
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('supersedes active synthesis without interrupting a separate catalog request', async () => {
    const signals: AbortSignal[] = []
    let releaseCatalog!: (response: Response) => void
    const fetchFn = vi.fn<typeof fetch>().mockImplementation((url, request) => {
      signals.push(request!.signal!)
      if (String(url).endsWith('/voices')) return new Promise(resolve => { releaseCatalog = resolve })
      return new Promise(() => undefined)
    })
    const { service } = setup(fetchFn)
    const old = service.synthesize('Old', 'eve').catch(reason => (reason as Error).message)
    const catalog = service.voices()
    const next = service.synthesize('New', 'ara').catch(reason => (reason as Error).message)
    expect(await old).toContain('cancelled')
    expect(signals.map(signal => signal.aborted)).toEqual([true, false, false])
    service.cancel()
    expect(await next).toContain('cancelled')
    expect(signals[1]!.aborted).toBe(false)
    releaseCatalog(new Response(JSON.stringify({ voices: [] })))
    expect(await catalog).toEqual([])
  })

  it('times out a stalled synthesis and allows an explicit retry', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(async () => audioResponse())
    const { service } = setup(fetchFn)
    const request = service.synthesize('Hi', 'eve')
    const rejected = expect(request).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    expect(fetchFn.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((await service.synthesize('Try again', 'eve')).mimeType).toBe('audio/wav')
  })

  it('applies the deadline to reading the response body, not only receiving headers', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const body = new ReadableStream<Uint8Array>({ start(controller) { finish = () => controller.close() } })
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'content-type': 'audio/wav' } }))
    const { service } = setup(fetchFn)
    const rejected = expect(service.synthesize('Hi', 'eve')).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    finish()
  })

  it.each(['text/html', 'audio/mpeg', 'application/json'])('rejects a non-WAV content type %s', async contentType => {
    const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(audioResponse(wave(), { 'content-type': contentType })))
    await expect(service.synthesize('Hi', 'eve')).rejects.toThrow('did not return WAV')
  })

  it.each(['header', 'chunk', 'empty'])('rejects malformed WAV %s data', async kind => {
    const audio = wave()
    if (kind === 'header') audio.write('FAKE', 0)
    if (kind === 'chunk') audio.writeUInt32LE(1000, 40)
    if (kind === 'empty') audio.writeUInt32LE(0, 40)
    const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(audioResponse(audio)))
    await expect(service.synthesize('Hi', 'eve')).rejects.toThrow('invalid WAV')
  })

  it('bounds audio using both announced size and streamed bytes', async () => {
    const oversized = Buffer.alloc(14 * 1024 * 1024 + 1)
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(audioResponse(wave(), { 'content-length': String(oversized.length) }))
      .mockResolvedValueOnce(audioResponse(oversized))
    const { service } = setup(fetchFn)
    await expect(service.synthesize('Hi', 'eve')).rejects.toThrow('oversized audio')
    await expect(service.synthesize('Hi', 'eve')).rejects.toThrow('oversized audio')
  })

  it.each(['not JSON', JSON.stringify({ voices: [{ voice_id: 'eve' }] }), JSON.stringify({ voices: [{ voice_id: 'eve\n', name: 'Eve' }] })])('rejects an invalid catalog without echoing its content', async body => {
    const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))
    await expect(service.voices()).rejects.toThrow('invalid voice list')
  })

  it('bounds and times out the catalog independently', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('x'.repeat(1_000_001)))
      .mockImplementationOnce(() => new Promise(() => undefined))
    const { service } = setup(fetchFn)
    await expect(service.voices()).rejects.toThrow('oversized voice list')
    const rejected = expect(service.voices()).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
