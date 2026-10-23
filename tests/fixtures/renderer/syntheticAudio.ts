import { TRANSCRIPTION_SAMPLE_RATE } from '../../../src/shared/audio'

/** A 16 kHz sine of the given length whose RMS is the given level; never real speech. */
export function tone(seconds: number, rms: number): Float32Array {
  const amplitude = rms * Math.SQRT2
  return Float32Array.from(
    { length: Math.round(seconds * TRANSCRIPTION_SAMPLE_RATE) },
    (_, index) => amplitude * Math.sin((2 * Math.PI * 220 * index) / TRANSCRIPTION_SAMPLE_RATE),
  )
}

/** Overwrites part of the audio with a louder tone, as a short word would. */
export function withBurst(samples: Float32Array, atSeconds: number, seconds: number, rms: number): Float32Array {
  const burst = tone(seconds, rms)
  const copy = samples.slice()
  copy.set(burst, Math.round(atSeconds * TRANSCRIPTION_SAMPLE_RATE))
  return copy
}
