import { describe, expect, it } from 'vitest'

import { calculateRms, resampleMono } from '../../../src/renderer/src/audio/audioMath'

describe('calculateRms', () => {
  it('returns a finite normalized RMS value', () => {
    expect(calculateRms(new Float32Array([1, -1, 1, -1]))).toBe(1)
    expect(calculateRms(new Float32Array([2, -2]))).toBe(1)
    expect(calculateRms(new Float32Array([Number.NaN, Number.POSITIVE_INFINITY]))).toBe(0)
    expect(calculateRms(new Float32Array())).toBe(0)
  })
})

describe('resampleMono', () => {
  it('uses deterministic linear interpolation with exact output length and midpoint accuracy', () => {
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

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects impossible source rate %s with a finite application error',
    (sourceRate) => {
      expect(() => resampleMono(new Float32Array([1]), sourceRate)).toThrow(
        'Sample rates must be finite positive numbers.',
      )
    },
  )
})
