// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KokoroSpeechService } from '../../../src/main/agents/kokoroSpeech'

const samples = Buffer.from([0xe8, 0x03, 0x18, 0xfc])

function wave(): Buffer {
  const audio = Buffer.alloc(48)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(40, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(24_000, 24)
  audio.writeUInt32LE(48_000, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(4, 40)
  samples.copy(audio, 44)
  return audio
}

function audioResponse(audio: Buffer = samples, contentType = 'audio/pcm;rate=24000;channels=1', headers: Record<string, string> = {}) {
  return new Response(new Uint8Array(audio), { headers: { 'content-type': contentType, ...headers } })
}

function setup(fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => audioResponse()), key = 'saved-openrouter-key') {
  const credentials = { get: vi.fn(() => key) }
  return { service: new KokoroSpeechService({ credentials, fetchFn }), credentials, fetchFn }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('KokoroSpeechService', () => {
  it('uses the saved shared OpenRouter credential and fixed Heart model, returning browser-ready finite WAV', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'must-not-use-environment')
    const { service, fetchFn, credentials } = setup()
    const result = await service.synthesize('Ready, Zach.')
    expect(credentials.get).toHaveBeenCalledExactlyOnceWith('formatting')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, request] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://openrouter.ai/api/v1/audio/speech')
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer saved-openrouter-key', 'Content-Type': 'application/json' } })
    expect(JSON.parse(request!.body as string)).toEqual({ model: 'hexgrad/kokoro-82m', input: 'Ready, Zach.', voice: 'af_heart', response_format: 'pcm' })
    expect(result).toEqual({ audioBase64: wave().toString('base64'), mimeType: 'audio/wav' })
  })

  it.each(['audio/wav', 'audio/pcm;rate=24000;channels=1'])('accepts validated WAV under %s and normalizes unknown streaming lengths', async contentType => {
    const streaming = wave()
    streaming.writeUInt32LE(0x80000023, 4)
    streaming.writeUInt32LE(0x7fffffff, 40)
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(audioResponse(wave(), contentType))
      .mockResolvedValueOnce(audioResponse(streaming, contentType))
    const { service } = setup(fetchFn)
    expect(Buffer.from((await service.synthesize('Hi')).audioBase64, 'base64')).toEqual(wave())
    expect(Buffer.from((await service.synthesize('Hi')).audioBase64, 'base64')).toEqual(wave())
  })

  it('accepts all-ones streaming lengths and discards ancillary chunks when making a canonical WAV', async () => {
    const audio = Buffer.concat([wave().subarray(0, 36), Buffer.from('JUNK\x02\0\0\0ab', 'binary'), wave().subarray(36)])
    audio.writeUInt32LE(0xffffffff, 4)
    audio.writeUInt32LE(0xffffffff, 50)
    const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(audioResponse(audio, 'audio/wav')))
    expect(Buffer.from((await service.synthesize('Hi')).audioBase64, 'base64')).toEqual(wave())
  })

  it('honors explicit PCM rate and channel metadata', async () => {
    const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(audioResponse(samples, 'Audio/PCM; rate="48000"; channels="2"')))
    const audio = Buffer.from((await service.synthesize('Hi')).audioBase64, 'base64')
    expect(audio.readUInt32LE(24)).toBe(48_000)
    expect(audio.readUInt16LE(22)).toBe(2)
    expect(audio.readUInt32LE(28)).toBe(192_000)
    expect(audio.readUInt16LE(32)).toBe(4)
    expect(audio.subarray(44)).toEqual(samples)
  })

  it.each([
    '', 'application/json', 'audio/mpeg', 'audio/L16;rate=24000;channels=1',
    'audio/pcm', 'audio/pcm;rate=24000', 'audio/pcm;rate=0;channels=1',
    'audio/pcm;rate=24000;channels=9', 'audio/pcm;rate=24000oops;channels=1',
  ])('rejects unsupported or unspecified audio format %s', async contentType => {
    const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(audioResponse(samples, contentType)))
    await expect(service.synthesize('Hi')).rejects.toThrow('invalid audio')
  })

  it.each([Buffer.alloc(0), Buffer.alloc(3)])('rejects empty or incomplete PCM samples (%#)', async audio => {
    const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(audioResponse(audio)))
    await expect(service.synthesize('Hi')).rejects.toThrow('invalid audio')
  })

  it.each(['bad signature', 'truncated chunk', 'wrong RIFF length', 'empty', 'partial sample', 'missing format', 'zero alignment', 'wrong byte rate', 'float', 'unsupported channels'])('rejects malformed WAV: %s', async kind => {
    let audio = wave()
    if (kind === 'bad signature') audio.write('FAKE', 0)
    if (kind === 'truncated chunk') audio.writeUInt32LE(1000, 40)
    if (kind === 'wrong RIFF length') audio.writeUInt32LE(1, 4)
    if (kind === 'empty') audio.writeUInt32LE(0, 40)
    if (kind === 'partial sample') {
      audio = audio.subarray(0, 47)
      audio.writeUInt32LE(0xffffffff, 4)
      audio.writeUInt32LE(0xffffffff, 40)
    }
    if (kind === 'missing format') audio.write('JUNK', 12)
    if (kind === 'zero alignment') audio.writeUInt16LE(0, 32)
    if (kind === 'wrong byte rate') audio.writeUInt32LE(42, 28)
    if (kind === 'float') audio.writeUInt16LE(3, 20)
    if (kind === 'unsupported channels') audio.writeUInt16LE(3, 22)
    const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(audioResponse(audio, 'audio/wav')))
    await expect(service.synthesize('Hi')).rejects.toThrow('invalid audio')
  })

  it('does not consult other saved or environment credentials when OpenRouter is missing', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'environment-key')
    const fetchFn = vi.fn<typeof fetch>()
    const credentials = { get: vi.fn((slot: string) => slot === 'formatting' ? '' : 'other-provider-key') }
    const service = new KokoroSpeechService({ credentials, fetchFn })
    await expect(service.synthesize('Hi')).rejects.toThrow('Save an OpenRouter API key in AI account settings')
    expect(credentials.get).toHaveBeenCalledExactlyOnceWith('formatting')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('sanitizes credential-store errors without making a request', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const service = new KokoroSpeechService({ credentials: { get() { throw new Error('SECRET keychain diagnostic') } }, fetchFn })
    await expect(service.synthesize('Hi')).rejects.toThrow('Unlock your operating system credential store')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each(['', '   ', 'x'.repeat(2001)])('rejects invalid text before making any billable request (%#)', async text => {
    const { service, fetchFn } = setup()
    await expect(service.synthesize(text)).rejects.toThrow('between 1 and 2,000 characters')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'rejected the OpenRouter API key'], [403, 'API permissions'], [402, 'OpenRouter API credits'],
    [429, 'API usage limit'], [500, 'temporarily unavailable'], [503, 'temporarily unavailable'],
    [400, 'could not serve Kokoro Heart'], [404, 'could not serve Kokoro Heart'], [422, 'could not serve Kokoro Heart'],
  ])('explains HTTP %i without leaking its response, retrying, or switching providers', async (status, message) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('SECRET token and private spoken text', { status }))
    const { service } = setup(fetchFn)
    const error: unknown = await service.synthesize('A private reply').catch(reason => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(message)
    expect((error as Error).message).not.toMatch(/SECRET|private/)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('sanitizes network failures and rejects redirects without retrying', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error('redirect from Bearer SECRET'))
    const { service } = setup(fetchFn)
    await expect(service.synthesize('Hi')).rejects.toThrow('Could not reach Kokoro through OpenRouter')
    expect(fetchFn.mock.calls[0]![1]!.redirect).toBe('error')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('cancels promptly even when fetch ignores abort and discards its late response', async () => {
    let release!: (response: Response) => void
    const fetchFn = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockImplementationOnce(async () => audioResponse())
    const { service } = setup(fetchFn)
    const rejected = expect(service.synthesize('Old')).rejects.toThrow('cancelled')
    service.cancel()
    await rejected
    expect(fetchFn.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    expect((await service.synthesize('New')).mimeType).toBe('audio/wav')
    const bodyCancelled = vi.fn()
    release(new Response(new ReadableStream({ cancel: bodyCancelled })))
    await Promise.resolve()
    expect(bodyCancelled).toHaveBeenCalledTimes(1)
  })

  it('supersedes old speech without letting its cleanup cancel the new request', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined))
    const { service } = setup(fetchFn)
    const old = service.synthesize('Old').catch(reason => (reason as Error).message)
    const next = service.synthesize('New').catch(reason => (reason as Error).message)
    expect(await old).toContain('cancelled')
    expect(fetchFn.mock.calls.map(call => call[1]!.signal!.aborted)).toEqual([true, false])
    service.cancel()
    expect(await next).toContain('cancelled')
    expect(fetchFn.mock.calls[1]![1]!.signal!.aborted).toBe(true)
  })

  it('times out stalled requests and permits explicit retry', async () => {
    vi.useFakeTimers()
    const fetchFn = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementationOnce(async () => audioResponse())
    const { service } = setup(fetchFn)
    const rejected = expect(service.synthesize('Hi')).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    expect(fetchFn.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((await service.synthesize('Retry')).mimeType).toBe('audio/wav')
  })

  it.each(['cancel', 'timeout'])('releases a stalled response body after %s', async kind => {
    vi.useFakeTimers()
    const bodyCancelled = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel: bodyCancelled })
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' } }))
    const { service } = setup(fetchFn)
    const rejected = expect(service.synthesize('Hi')).rejects.toThrow(kind === 'cancel' ? 'cancelled' : 'timed out')
    await Promise.resolve()
    if (kind === 'cancel') service.cancel()
    else await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    expect(bodyCancelled).toHaveBeenCalledTimes(1)
  })

  it('bounds both declared and streamed response sizes', async () => {
    const oversized = Buffer.alloc(14 * 1024 * 1024 + 1)
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(audioResponse(samples, 'audio/pcm;rate=24000;channels=1', { 'content-length': String(oversized.length) }))
      .mockResolvedValueOnce(audioResponse(oversized))
    const { service } = setup(fetchFn)
    await expect(service.synthesize('Hi')).rejects.toThrow('oversized audio')
    await expect(service.synthesize('Hi')).rejects.toThrow('oversized audio')
  })
})
