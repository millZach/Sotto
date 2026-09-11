import { encodeWavPcm16 } from '../../shared/wav'

/** Replaces only xAI HTTP in isolated Electron tests; vault, IPC and playback stay real. */
export const e2eGrokSpeechFetch: typeof fetch = async (input, init) => {
  const url = String(input)
  const authorization = new Headers(init?.headers).get('authorization')
  if (authorization === 'Bearer fixture-invalid-grok-key') return new Response(null, { status: 401 })
  if (!authorization) throw new Error('Fixture speech request omitted authorization')
  if (url === 'https://api.x.ai/v1/tts/voices') return Response.json({ voices: [
    { voice_id: 'ara', name: 'Ara' }, { voice_id: 'eve', name: 'Eve' },
    { voice_id: 'fixture-custom-voice', name: 'My custom voice' },
  ] })
  if (url !== 'https://api.x.ai/v1/tts' || init?.method !== 'POST') throw new Error('Unexpected fixture speech request')
  const audio = encodeWavPcm16(new Float32Array(2_400), 24_000)
  // Match the streaming length placeholders observed in live xAI WAV replies.
  const header = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  header.setUint32(4, 0x80000023, true)
  header.setUint32(40, 0x7fffffff, true)
  return new Response(audio.buffer as ArrayBuffer, { headers: { 'Content-Type': 'audio/wav' } })
}
