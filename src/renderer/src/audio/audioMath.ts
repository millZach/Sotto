const INVALID_SAMPLE_RATE_MESSAGE = 'Sample rates must be finite positive numbers.'
const DOWNSAMPLE_HALF_TAPS = 16
const DOWNSAMPLE_TAP_COUNT = DOWNSAMPLE_HALF_TAPS * 2 + 1
const DOWNSAMPLE_PHASE_COUNT = 256

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

function sinc(value: number): number {
  return value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value)
}

/**
 * Builds a compact fractional-phase Blackman-windowed sinc table. Its cutoff is
 * 80% of the target Nyquist: the conservative transition band strongly rejects
 * aliasing while 33 taps keep five-minute recordings practical and allocation bounded.
 */
function createDownsampleKernels(rateRatio: number): Float64Array[] {
  const cutoff = rateRatio * 0.8
  return Array.from({ length: DOWNSAMPLE_PHASE_COUNT }, (_, phaseIndex) => {
    const phase = phaseIndex / DOWNSAMPLE_PHASE_COUNT
    const kernel = new Float64Array(DOWNSAMPLE_TAP_COUNT)
    for (let tapIndex = 0; tapIndex < kernel.length; tapIndex += 1) {
      const offset = tapIndex - DOWNSAMPLE_HALF_TAPS - phase
      const windowPosition = offset / (DOWNSAMPLE_HALF_TAPS + 0.5)
      const window =
        0.42 +
        0.5 * Math.cos(Math.PI * windowPosition) +
        0.08 * Math.cos(2 * Math.PI * windowPosition)
      kernel[tapIndex] = cutoff * sinc(cutoff * offset) * window
    }
    return kernel
  })
}

function downsampleMono(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
  outputLength: number,
): Float32Array {
  const output = new Float32Array(outputLength)
  const kernels = createDownsampleKernels(targetRate / sourceRate)
  const sourceFramesPerOutputFrame = sourceRate / targetRate

  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const exactSourcePosition = outputIndex * sourceFramesPerOutputFrame
    let sourceBase = Math.floor(exactSourcePosition)
    const fraction = exactSourcePosition - sourceBase
    let phaseIndex = Math.round(fraction * DOWNSAMPLE_PHASE_COUNT)
    if (phaseIndex === DOWNSAMPLE_PHASE_COUNT) {
      phaseIndex = 0
      sourceBase += 1
    }
    const kernel = kernels[phaseIndex]!
    let weightedSamples = 0
    let availableWeight = 0
    for (let tapIndex = 0; tapIndex < kernel.length; tapIndex += 1) {
      const sourceIndex = sourceBase + tapIndex - DOWNSAMPLE_HALF_TAPS
      if (sourceIndex < 0 || sourceIndex >= input.length) continue
      const weight = kernel[tapIndex] ?? 0
      weightedSamples += (input[sourceIndex] ?? 0) * weight
      availableWeight += weight
    }
    output[outputIndex] = availableWeight === 0 ? 0 : weightedSamples / availableWeight
  }
  return output
}

/**
 * Resamples mono PCM with a bounded polyphase low-pass FIR for downsampling and
 * deterministic linear interpolation for upsampling. Output length is rounded from duration.
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

  if (targetRate < sourceRate) {
    return downsampleMono(input, sourceRate, targetRate, outputLength)
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
