import { z } from 'zod'
import type { AgentCredentials } from './credentials'
import type { AgentSpeechAudio } from './speech'

const API_ORIGIN = 'https://api.x.ai'
const REQUEST_TIMEOUT_MS = 60_000
// Base64 stays below the shared 20 MB IPC limit.
const MAX_AUDIO_BYTES = 14 * 1024 * 1024
const MAX_CATALOG_BYTES = 1_000_000
const VOICE_ID = z.string().min(1).max(256).refine(value => value.trim().length > 0 && !/[\p{Cc}]/u.test(value))
const CATALOG = z.object({ voices: z.array(z.object({ voice_id: VOICE_ID, name: z.string().min(1).max(300) })).max(5_000) })

class SpeechRequestError extends Error {}

function httpFailure(status: number): SpeechRequestError {
  if (status === 401) return new SpeechRequestError('Grok speech rejected the API key. Save a valid xAI API key in Speech voice settings.')
  if (status === 403) return new SpeechRequestError('This xAI API key cannot use Grok speech. Check its API permissions and voice access.')
  if (status === 402) return new SpeechRequestError('Grok speech requires available xAI API credits. Check your xAI API billing; your Grok subscription does not cover speech API usage.')
  if (status === 429) return new SpeechRequestError('Grok speech reached an API usage limit. Check your xAI API limits and credits, then try again.')
  if (status >= 500) return new SpeechRequestError('Grok speech is temporarily unavailable. Try again later.')
  if (status === 400 || status === 404 || status === 422) return new SpeechRequestError('Grok speech could not use this request or voice. Refresh the available voices and choose one you can access.')
  return new SpeechRequestError('Grok speech rejected the request. Check your xAI API access and try again.')
}

async function readBounded(response: Response, limit: number, label: string): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new SpeechRequestError(`Grok speech returned an oversized ${label}.`)
  }
  if (!response.body) throw new SpeechRequestError(`Grok speech returned an empty ${label}.`)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) throw new SpeechRequestError(`Grok speech returned an oversized ${label}.`)
      chunks.push(Buffer.from(part.value))
    }
    return Buffer.concat(chunks, length)
  } finally {
    // Also releases an unread oversized or interrupted response without retaining it.
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function validateWave(audio: Buffer): AgentSpeechAudio {
  const invalid = () => new SpeechRequestError('Grok speech returned invalid WAV audio. Try the voice again.')
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw invalid()
  let hasFormat = false
  let hasAudio = false
  let blockAlign = 0
  for (let offset = 12; offset + 8 <= audio.length;) {
    let size = audio.readUInt32LE(offset + 4)
    const start = offset + 8
    const id = audio.toString('ascii', offset, offset + 4)
    // xAI streams WAV with data=0x7fffffff and RIFF=0x80000023.
    // Finalize known unknown-length markers after the bounded body completes,
    // so the browser receives a normal WAV with an accurate playback duration.
    if (id === 'data' && (size === 0x7fffffff || size === 0xffffffff)) {
      size = audio.length - start
      if (!hasFormat || !blockAlign || !size || size % blockAlign !== 0) throw invalid()
      if (size % 2) audio = Buffer.concat([audio, Buffer.alloc(1)])
      audio.writeUInt32LE(size, offset + 4)
      audio.writeUInt32LE(audio.length - 8, 4)
    }
    const end = start + size
    if (end > audio.length) throw invalid()
    if (id === 'fmt ') {
      if (size < 16 || ![1, 3, 0xfffe].includes(audio.readUInt16LE(start))) throw invalid()
      hasFormat = true
      blockAlign = audio.readUInt16LE(start + 12)
    }
    if (id === 'data' && end > start) hasAudio = true
    offset = end + (size % 2)
  }
  if (!hasFormat || !hasAudio) throw invalid()
  return { audioBase64: audio.toString('base64'), mimeType: 'audio/wav' }
}

interface GrokSpeechOptions {
  credentials: Pick<AgentCredentials, 'get'>
  fetchFn?: typeof fetch
}

/** Explicitly configured, API-billed speech. No environment or subscription credentials are consulted. */
export class GrokSpeechService {
  private readonly fetchFn: typeof fetch
  private activeSpeech: AbortController | null = null

  constructor(private readonly options: GrokSpeechOptions) {
    this.fetchFn = options.fetchFn ?? fetch
  }

  async synthesize(text: string, voice: string): Promise<AgentSpeechAudio> {
    if (!text.trim() || text.length > 2_000) throw new Error('Spoken replies must contain between 1 and 2,000 characters.')
    if (!VOICE_ID.safeParse(voice).success) throw new Error('Choose a valid Grok speech voice.')
    return this.request('/v1/tts', {
      method: 'POST',
      body: JSON.stringify({ text, voice_id: voice, language: 'auto', output_format: { codec: 'wav', sample_rate: 24000 } }),
    }, true, async response => {
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (!mime || !['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(mime)) {
        void response.body?.cancel().catch(() => undefined)
        throw new SpeechRequestError('Grok speech did not return WAV audio. Try the voice again.')
      }
      return validateWave(await readBounded(response, MAX_AUDIO_BYTES, 'audio reply'))
    })
  }

  async voices(): Promise<Array<{ id: string; name: string }>> {
    return this.request('/v1/tts/voices', { method: 'GET' }, false, async response => {
      const data = await readBounded(response, MAX_CATALOG_BYTES, 'voice list')
      let decoded: unknown
      try { decoded = JSON.parse(data.toString('utf8')) } catch { throw new SpeechRequestError('Grok speech returned an invalid voice list. Refresh the voices and try again.') }
      const result = CATALOG.safeParse(decoded)
      if (!result.success) throw new SpeechRequestError('Grok speech returned an invalid voice list. Refresh the voices and try again.')
      return result.data.voices.map(voice => ({ id: voice.voice_id, name: voice.name }))
    })
  }

  cancel(): void {
    this.activeSpeech?.abort(new SpeechRequestError('Grok speech was cancelled.'))
    this.activeSpeech = null
  }

  private async request<T>(path: '/v1/tts' | '/v1/tts/voices', init: RequestInit, speech: boolean, consume: (response: Response) => Promise<T>): Promise<T> {
    let key: string
    try { key = this.options.credentials.get('grokSpeech') } catch { throw new Error('Unlock your operating system credential store to use the saved Grok speech API key.') }
    if (!key) throw new Error('Save an xAI API key in Speech voice settings to use Grok speech. API usage is billed separately from your Grok subscription.')
    const controller = new AbortController()
    if (speech) {
      this.cancel()
      this.activeSpeech = controller
    }
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const timeout = setTimeout(() => controller.abort(new SpeechRequestError('Grok speech timed out. Check your connection and try again.')), REQUEST_TIMEOUT_MS)
    try {
      const pending = (async () => {
        const response = await this.fetchFn(`${API_ORIGIN}${path}`, {
          ...init, headers: { Authorization: `Bearer ${key}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
          redirect: 'error', signal: controller.signal,
        })
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined)
          throw controller.signal.reason
        }
        if (!response.ok) {
          // Provider response bodies can contain prompt text or account details; never expose them.
          void response.body?.cancel().catch(() => undefined)
          throw httpFailure(response.status)
        }
        return consume(response)
      })()
      return await Promise.race([pending, aborted])
    } catch (error) {
      if (error instanceof SpeechRequestError) throw error
      // Do not retain native fetch diagnostics: they may contain authorization or spoken text.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Could not reach Grok speech. Check your connection and try again.')
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', onAbort)
      if (this.activeSpeech === controller) this.activeSpeech = null
    }
  }
}
