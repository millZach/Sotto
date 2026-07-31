import { describe, expect, it } from 'vitest'

import { collapseRepeatedPhrases, countWords } from '../../../src/shared/textRepair'

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('  one two\tthree\n')).toBe(3)
    expect(countWords('')).toBe(0)
  })
})

describe('collapseRepeatedPhrases', () => {
  it('collapses a hallucinated single-word repetition loop', () => {
    expect(
      collapseRepeatedPhrases(
        'four, wait, no, no, no, no, no, no, no, no, no, no Nothing for',
      ),
    ).toBe('four, wait, no, Nothing for')
  })

  it('ignores case and punctuation when matching repeats', () => {
    expect(collapseRepeatedPhrases('stop No. no, NO no! go')).toBe('stop No. go')
  })

  it('collapses repeated multi-word phrases', () => {
    expect(
      collapseRepeatedPhrases('and then thank you thank you thank you thank you goodbye'),
    ).toBe('and then thank you goodbye')
  })

  it('keeps intentional double repeats', () => {
    expect(collapseRepeatedPhrases('it was very very good, no, no, listen')).toBe(
      'it was very very good, no, no, listen',
    )
  })

  it('returns unchanged text verbatim', () => {
    expect(collapseRepeatedPhrases('  spacing   preserved here  ')).toBe(
      '  spacing   preserved here  ',
    )
    expect(collapseRepeatedPhrases('')).toBe('')
  })

  it('collapses a loop that spans a segment join boundary', () => {
    expect(collapseRepeatedPhrases('groceries are one one one. One, one done')).toBe(
      'groceries are one done',
    )
  })
})
