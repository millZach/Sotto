import { describe, expect, it } from 'vitest'

import { formatTranscript } from '../../../src/shared/transcript'

describe('formatTranscript', () => {
  it('normalizes whitespace without changing words or punctuation', () => {
    expect(formatTranscript('  Hello,   world!\nAgain.  ')).toBe('Hello, world! Again.')
  })

  it('collapses tabs and Unicode whitespace to one ASCII space', () => {
    expect(formatTranscript('\tAlpha\u00a0\u2003Beta\u2028\u2029Gamma\t')).toBe(
      'Alpha Beta Gamma',
    )
  })

  it.each(['', '   ', '\n\t\u00a0\u2003'])('returns an empty string for silence %#', (text) => {
    expect(formatTranscript(text)).toBe('')
  })

  it('leaves already-clean text exactly unchanged', () => {
    const text = "TalkType keeps CASE, commas, apostrophes, and punctuation—exactly!"

    expect(formatTranscript(text)).toBe(text)
  })
})
