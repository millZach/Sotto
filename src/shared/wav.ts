/**
 * In-memory WAV for a dictation segment on its way from the renderer to the
 * transcriber in main: a canonical 44-byte RIFF header in front of mono PCM16.
 * The renderer encodes, main decodes back to float samples for the speech model.
 * Kept dependency-free so neither side pulls anything into production `dependencies`.
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

/**
 * Reads back the samples of a file `encodeWavPcm16` wrote, as floats in [-1, 1]. Only that exact
 * shape is accepted, mono PCM16 at `sampleRate` behind the canonical header, because nothing else
 * should reach the transcriber; anything else returns null.
 */
export function decodeWavPcm16(bytes: ArrayBuffer, sampleRate: number): Float32Array | null {
  if (bytes.byteLength < WAV_HEADER_BYTES || (bytes.byteLength - WAV_HEADER_BYTES) % BYTES_PER_SAMPLE !== 0) return null
  const view = new DataView(bytes)
  const ascii = (offset: number): string => String.fromCharCode(...new Uint8Array(bytes, offset, 4))
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE' || ascii(12) !== 'fmt ' || ascii(36) !== 'data') return null
  if (view.getUint16(20, true) !== PCM_FORMAT_TAG || view.getUint16(22, true) !== MONO_CHANNELS) return null
  if (view.getUint32(24, true) !== sampleRate || view.getUint16(34, true) !== BITS_PER_SAMPLE) return null
  if (view.getUint32(40, true) !== bytes.byteLength - WAV_HEADER_BYTES) return null
  const count = (bytes.byteLength - WAV_HEADER_BYTES) / BYTES_PER_SAMPLE
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    const value = view.getInt16(WAV_HEADER_BYTES + index * BYTES_PER_SAMPLE, true)
    // The inverse of toPcm16's symmetric clip: negatives over 32768, positives over 32767.
    samples[index] = value < 0 ? value / -INT16_MIN : value / INT16_MAX
  }
  return samples
}

/** How long the audio in an `encodeWavPcm16` file lasts at `sampleRate`, from its size alone. */
export function pcm16WavDurationMs(byteLength: number, sampleRate: number): number {
  const samples = Math.max(0, byteLength - WAV_HEADER_BYTES) / BYTES_PER_SAMPLE
  return Math.round((samples / sampleRate) * 1_000)
}
