import { describe, expect, it } from 'vitest'

import { formatTranscript } from '../../../src/shared/transcript'

describe('formatTranscript', () => {
  it('collapses runs of spaces without changing words or punctuation', () => {
    expect(formatTranscript('  Hello,   world!  Again.  ')).toBe('Hello, world! Again.')
  })

  it('preserves line breaks so LLM lists survive delivery', () => {
    expect(
      formatTranscript('Things to get:\n- Apples \n-   Oranges\n- Turkey\n'),
    ).toBe('Things to get:\n- Apples\n- Oranges\n- Turkey')
  })

  it('normalizes CRLF and Unicode line separators to newlines', () => {
    expect(formatTranscript('One\r\nTwo\u2028Three\u2029Four')).toBe(
      'One\nTwo\nThree\nFour',
    )
  })

  it('caps blank runs at one empty line (paragraph break)', () => {
    expect(formatTranscript('First paragraph.\n\n\n\nSecond paragraph.')).toBe(
      'First paragraph.\n\nSecond paragraph.',
    )
  })

  it('collapses tabs and Unicode spaces to one ASCII space', () => {
    expect(formatTranscript('\tAlpha\u00a0\u2003Beta Gamma\t')).toBe('Alpha Beta Gamma')
  })

  it.each(['', '   ', '\n\t\u00a0\u2003'])('returns an empty string for silence %#', (text) => {
    expect(formatTranscript(text)).toBe('')
  })

  it('leaves already-clean text exactly unchanged', () => {
    const text = 'Sotto keeps CASE, commas, apostrophes, and punctuation—exactly!\n- Even lists.'

    expect(formatTranscript(text)).toBe(text)
  })
})
