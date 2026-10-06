// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { formatTokenCount } from '../../../src/shared/threadUsage'

describe('compact token counts', () => {
  it.each([
    [940, '940'], [999, '999'], [999.9, '1k'], [1_000, '1k'],
    [1_200, '1.2k'], [120_000, '120k'], [999_499, '999k'],
    [999_500, '1M'], [999_999, '1M'], [1_000_000, '1M'], [1_200_000, '1.2M'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatTokenCount(input)).toBe(expected)
  })
})
