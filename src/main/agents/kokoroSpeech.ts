import type { AgentCredentials } from './credentials'
import type { AgentSpeechAudio } from './speech'

const API_URL = 'https://openrouter.ai/api/v1/audio/speech'
const REQUEST_TIMEOUT_MS = 60_000
// Including the WAV header, base64 remains below the shared 20 MB IPC limit.
const MAX_AUDIO_BYTES = 14 * 1024 * 1024

class SpeechRequestError extends Error {}

function invalidAudio(): SpeechRequestError {
  return new SpeechRequestError('Kokoro returned invalid audio. Try again; if this continues, choose Grok in Speech voice settings.')
}

function httpFailure(status: number): SpeechRequestError {
  if (status === 401) return new SpeechRequestError('Kokoro rejected the OpenRouter API key. Save a valid key in AI account settings.')
  if (status === 403) return new SpeechRequestError('This OpenRouter API key cannot use Kokoro. Check its API permissions and model access.')
  if (status === 402) return new SpeechRequestError('Kokoro requires available OpenRouter API credits. Check your OpenRouter billing.')
  if (status === 429) return new SpeechRequestError('Kokoro reached an API usage limit. Check your OpenRouter limits and credits, then try again.')
  if (status >= 500) return new SpeechRequestError('Kokoro is temporarily unavailable. Try again later.')
  return new SpeechRequestError('OpenRouter could not serve Kokoro Heart. Check your model access or choose Grok in Speech voice settings.')
}

function pcmWave(pcm: Buffer, rate: number, channels: number): Buffer {
  if (!Number.isInteger(rate) || rate < 8_000 || rate > 192_000 || ![1, 2].includes(channels) || !pcm.length || pcm.length % (channels * 2)) throw invalidAudio()
  const wave = Buffer.alloc(44 + pcm.length)
  wave.write('RIFF', 0)
  wave.writeUInt32LE(wave.length - 8, 4)
  wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(channels, 22)
  wave.writeUInt32LE(rate, 24)
  wave.writeUInt32LE(rate * channels * 2, 28)
  wave.writeUInt16LE(channels * 2, 32)
  wave.writeUInt16LE(16, 34)
  wave.write('data', 36)
  wave.writeUInt32LE(pcm.length, 40)
  pcm.copy(wave, 44)
  return wave
}

/** Rebuild streamed PCM WAVs with finite lengths before browser decoding. */
function normalizeWave(audio: Buffer): Buffer {
  if (audio.length < 44 || audio.toString('ascii', 8, 12) !== 'WAVE') throw invalidAudio()
  const riffLength = audio.readUInt32LE(4)
  if (riffLength !== audio.length - 8 && ![0x7fffffff, 0xffffffff, 0x80000023].includes(riffLength)) throw invalidAudio()
  let format: { rate: number; channels: number } | undefined
  let pcm: Buffer | undefined
  let offset = 12
  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4)
    let size = audio.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'data' && [0x7fffffff, 0xffffffff].includes(size)) size = audio.length - start
    const end = start + size
    if (end > audio.length) throw invalidAudio()
    if (id === 'fmt ') {
      if (format || size < 16 || audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 14) !== 16) throw invalidAudio()
      const channels = audio.readUInt16LE(start + 2)
      const rate = audio.readUInt32LE(start + 4)
      if (audio.readUInt16LE(start + 12) !== channels * 2 || audio.readUInt32LE(start + 8) !== rate * channels * 2) throw invalidAudio()
      format = { rate, channels }
    }
    if (id === 'data') {
      if (!format || pcm) throw invalidAudio()
      pcm = audio.subarray(start, end)
    }
    offset = end + (size % 2)
  }
  if (offset !== audio.length || !format || !pcm) throw invalidAudio()
  return pcmWave(pcm, format.rate, format.channels)
}

function decodeAudio(audio: Buffer, contentType: string): AgentSpeechAudio {
  let wave: Buffer
  if (audio.toString('ascii', 0, 4) === 'RIFF') {
    wave = normalizeWave(audio)
  } else {
    // audio/L16 is big-endian and must never be interpreted as little-endian PCM.
    if (!/^audio\/pcm(?:;|$)/iu.test(contentType)) throw invalidAudio()
    const rate = /(?:^|;)\s*rate\s*=\s*"?(\d+)"?\s*(?:;|$)/iu.exec(contentType)
    const channels = /(?:^|;)\s*channels\s*=\s*"?(\d+)"?\s*(?:;|$)/iu.exec(contentType)
    if (!rate || !channels) throw invalidAudio()
    wave = pcmWave(audio, Number(rate[1]), Number(channels[1]))
  }
  return { audioBase64: wave.toString('base64'), mimeType: 'audio/wav' }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
    void response.body?.cancel().catch(() => undefined)
    throw new SpeechRequestError('Kokoro returned an oversized audio reply. Try a shorter reply.')
  }
  if (!response.body) throw invalidAudio()
  const reader = response.body.getReader()
  const onAbort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  const chunks: Buffer[] = []
  let length = 0
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const part = await reader.read()
      if (signal.aborted) throw signal.reason
      if (part.done) break
      length += part.value.byteLength
      if (length > MAX_AUDIO_BYTES) throw new SpeechRequestError('Kokoro returned an oversized audio reply. Try a shorter reply.')
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks, length)
  } finally {
    signal.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

interface KokoroSpeechOptions {
  credentials: Pick<AgentCredentials, 'get'>
  fetchFn?: typeof fetch
}

/** Heart through OpenRouter, using the explicitly saved shared OpenRouter key. */
export class KokoroSpeechService {
  private readonly fetchFn: typeof fetch
  private activeSpeech: AbortController | null = null

  constructor(private readonly options: KokoroSpeechOptions) {
    this.fetchFn = options.fetchFn ?? fetch
  }

  async synthesize(text: string): Promise<AgentSpeechAudio> {
    if (!text.trim() || text.length > 2_000) throw new Error('Spoken replies must contain between 1 and 2,000 characters.')
    let key: string
    try { key = this.options.credentials.get('formatting') } catch { throw new Error('Unlock your operating system credential store to use the saved OpenRouter API key.') }
    if (!key) throw new Error('Save an OpenRouter API key in AI account settings to use Kokoro Heart.')
    this.cancel()
    const controller = new AbortController()
    this.activeSpeech = controller
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const timeout = setTimeout(() => controller.abort(new SpeechRequestError('Kokoro speech timed out. Check your connection and try again.')), REQUEST_TIMEOUT_MS)
    try {
      const pending = (async () => {
        const response = await this.fetchFn(API_URL, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'hexgrad/kokoro-82m', input: text, voice: 'af_heart', response_format: 'pcm' }),
        })
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined)
          throw controller.signal.reason
        }
        if (!response.ok) {
          // Never expose provider bodies, which may contain credentials or private reply text.
          void response.body?.cancel().catch(() => undefined)
          throw httpFailure(response.status)
        }
        const contentType = response.headers.get('content-type')?.trim() ?? ''
        const mime = contentType.split(';')[0]?.trim().toLowerCase()
        if (!mime || !['audio/pcm', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(mime)) {
          void response.body?.cancel().catch(() => undefined)
          throw invalidAudio()
        }
        return decodeAudio(await readBounded(response, controller.signal), contentType)
      })()
      return await Promise.race([pending, aborted])
    } catch (error) {
      if (error instanceof SpeechRequestError) throw error
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Could not reach Kokoro through OpenRouter. Check your connection and try again.')
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      if (this.activeSpeech === controller) this.activeSpeech = null
    }
  }

  cancel(): void {
    this.activeSpeech?.abort(new SpeechRequestError('Kokoro speech was cancelled.'))
    this.activeSpeech = null
  }
}
