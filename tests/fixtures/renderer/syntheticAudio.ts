import { TRANSCRIPTION_SAMPLE_RATE } from '../../../src/shared/audio'

/** A sine of the given length whose RMS is the given level; never real speech. */
export function tone(seconds: number, rms: number, sampleRate: number = TRANSCRIPTION_SAMPLE_RATE, hz = 220): Float32Array {
  const amplitude = rms * Math.SQRT2
  return Float32Array.from(
    { length: Math.round(seconds * sampleRate) },
    (_, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / sampleRate),
  )
}

/** Splits audio into capture blocks the size the audio worklet posts. */
export function blocks(samples: Float32Array, size = 128): Float32Array[] {
  const parts: Float32Array[] = []
  for (let start = 0; start < samples.length; start += size) parts.push(samples.slice(start, start + size))
  return parts
}
