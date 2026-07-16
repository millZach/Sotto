import { describe, expect, it } from 'vitest'

import { calculateRms, resampleMono } from '../../../src/renderer/src/audio/audioMath'

function sineWave(frequency: number, sampleRate: number, seconds = 1): Float32Array {
  return Float32Array.from(
    { length: sampleRate * seconds },
    (_, index) => Math.sin((2 * Math.PI * frequency * index) / sampleRate),
  )
}

function correlation(left: Float32Array, right: Float32Array): number {
  let dot = 0
  let leftEnergy = 0
  let rightEnergy = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftSample = left[index] ?? 0
    const rightSample = right[index] ?? 0
    dot += leftSample * rightSample
    leftEnergy += leftSample * leftSample
    rightEnergy += rightSample * rightSample
  }
  return dot / Math.sqrt(leftEnergy * rightEnergy)
}

describe('calculateRms', () => {
  it('returns a finite normalized RMS value', () => {
    expect(calculateRms(new Float32Array([1, -1, 1, -1]))).toBe(1)
    expect(calculateRms(new Float32Array([2, -2]))).toBe(1)
    expect(calculateRms(new Float32Array([Number.NaN, Number.POSITIVE_INFINITY]))).toBe(0)
    expect(calculateRms(new Float32Array())).toBe(0)
  })
})

describe('resampleMono', () => {
  it('uses deterministic duration mapping with exact output length and midpoint accuracy', () => {
    const input = new Float32Array(48_000)
    for (let index = 0; index < input.length; index += 1) input[index] = index / 48_000
    const before = input.slice()

    const output = resampleMono(input, 48_000)

    expect(output).toHaveLength(16_000)
    expect(output[8_000]).toBeCloseTo(0.5, 5)
    expect(input).toStrictEqual(before)
  })

  it('returns independent arrays for empty and same-rate input', () => {
    const input = new Float32Array([0.25, -0.5])
    const sameRate = resampleMono(input, 16_000)

    expect(resampleMono(new Float32Array(), 48_000)).toStrictEqual(new Float32Array())
    expect(sameRate).toStrictEqual(input)
    expect(sameRate).not.toBe(input)
  })

  it('strongly attenuates frequencies above the target Nyquist when downsampling', () => {
    const output = resampleMono(sineWave(12_000, 48_000), 48_000)
    const steadyState = output.slice(128, -128)

    expect(calculateRms(steadyState)).toBeLessThan(0.03)
  })

  it('substantially preserves speech-band amplitude and frequency deterministically', () => {
    const input = sineWave(1_000, 48_000)
    const first = resampleMono(input, 48_000)
    const second = resampleMono(input, 48_000)
    const steadyState = first.slice(128, -128)
    const reference = sineWave(1_000, 16_000).slice(128, -128)

    expect(first).toStrictEqual(second)
    expect(calculateRms(steadyState)).toBeGreaterThan(0.65)
    expect(calculateRms(steadyState)).toBeLessThan(0.75)
    expect(correlation(steadyState, reference)).toBeGreaterThan(0.98)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects impossible source rate %s with a finite application error',
    (sourceRate) => {
      expect(() => resampleMono(new Float32Array([1]), sourceRate)).toThrow(
        'Sample rates must be finite positive numbers.',
      )
    },
  )
})
