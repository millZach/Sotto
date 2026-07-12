const INVALID_SAMPLE_RATE_MESSAGE = 'Sample rates must be finite positive numbers.'

function assertSampleRate(sampleRate: number): void {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(INVALID_SAMPLE_RATE_MESSAGE)
  }
}

export function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) return 0

  let sumOfSquares = 0
  for (const sample of samples) {
    const finiteSample = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0
    sumOfSquares += finiteSample * finiteSample
  }

  const rms = Math.sqrt(sumOfSquares / samples.length)
  return Number.isFinite(rms) ? Math.max(0, Math.min(1, rms)) : 0
}

/**
 * Resamples mono PCM using deterministic linear interpolation. Output frame count is
 * rounded from the exact duration, and each output frame samples its source-time position.
 */
export function resampleMono(
  input: Float32Array,
  sourceRate: number,
  targetRate = 16_000,
): Float32Array {
  assertSampleRate(sourceRate)
  assertSampleRate(targetRate)

  if (input.length === 0) return new Float32Array()
  if (sourceRate === targetRate) return input.slice()

  const outputLength = Math.round((input.length * targetRate) / sourceRate)
  if (!Number.isSafeInteger(outputLength) || outputLength < 0 || outputLength > 0xffff_ffff) {
    throw new RangeError('Resampled audio length is outside the supported range.')
  }

  const output = new Float32Array(outputLength)
  const sourceFramesPerOutputFrame = sourceRate / targetRate
  for (let index = 0; index < output.length; index += 1) {
    const sourcePosition = index * sourceFramesPerOutputFrame
    const leftIndex = Math.min(Math.floor(sourcePosition), input.length - 1)
    const rightIndex = Math.min(leftIndex + 1, input.length - 1)
    const fraction = sourcePosition - leftIndex
    const left = input[leftIndex] ?? 0
    const right = input[rightIndex] ?? left
    output[index] = left + (right - left) * fraction
  }
  return output
}
