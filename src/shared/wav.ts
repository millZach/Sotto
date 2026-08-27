/**
 * In-memory WAV writer for the remote transcription upload. OpenAI-compatible
 * `/v1/audio/transcriptions` endpoints take an audio container rather than raw
 * samples, and a canonical 44-byte RIFF header in front of PCM16 is the one
 * encoding every such server accepts. Kept dependency-free so the renderer can
 * encode a segment without pulling anything into production `dependencies`.
 */

/** Canonical RIFF/`fmt `/`data` header, written before the sample bytes. */
export const WAV_HEADER_BYTES = 44

const BYTES_PER_SAMPLE = 2
const PCM_FORMAT_TAG = 1
const MONO_CHANNELS = 1
const BITS_PER_SAMPLE = 16
const INT16_MIN = -32_768
const INT16_MAX = 32_767

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index))
  }
}

/**
 * Symmetric-clip conversion: the negative and positive full-scale floats map to
 * the int16 endpoints, and anything outside [-1, 1] clamps instead of wrapping
 * around. A NaN sample carries no amplitude at all and becomes silence, while
 * an infinite one is over full scale and clamps like any other loud sample.
 */
function toPcm16(sample: number): number {
  if (Number.isNaN(sample)) return 0
  const clamped = Math.max(-1, Math.min(1, sample))
  const scaled = Math.round(clamped * (clamped < 0 ? -INT16_MIN : INT16_MAX))
  return Math.max(INT16_MIN, Math.min(INT16_MAX, scaled))
}

/**
 * Encodes mono float samples as a single-chunk PCM16 WAV file. The returned
 * view always owns its whole buffer, so `bytes.buffer` is exactly the file and
 * can be transferred without a copy.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError('WAV sample rate must be a positive integer')
  }

  const dataBytes = samples.length * BYTES_PER_SAMPLE
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(bytes.buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, PCM_FORMAT_TAG, true)
  view.setUint16(22, MONO_CHANNELS, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * MONO_CHANNELS * BYTES_PER_SAMPLE, true)
  view.setUint16(32, MONO_CHANNELS * BYTES_PER_SAMPLE, true)
  view.setUint16(34, BITS_PER_SAMPLE, true)

  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(
      WAV_HEADER_BYTES + index * BYTES_PER_SAMPLE,
      toPcm16(samples[index] as number),
      true,
    )
  }

  return bytes
}
