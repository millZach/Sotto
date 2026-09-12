import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { scoreProperNouns, shouldSkipCleanup } from '../../../scripts/asr-bench/stt-scoring.mjs'

describe('STT benchmark scoring', () => {
  it('matches complete normalized names across case and punctuation', () => {
    expect(scoreProperNouns('ZACHE uses Wispr-Flow, ONNX and Electron.',
      ['Zache', 'Wispr Flow', 'ONNX', 'Electron'])).toMatchObject({ matched: 4, total: 4, accuracy: 1 })
  })

  it('requires contiguous whole tokens and exact spelling, without compound reconciliation', () => {
    const result = scoreProperNouns('Zach uses Wispr fast Flow and Super Whisper. Otterbox.',
      ['Zache', 'Wispr Flow', 'Superwhisper', 'Otter'])
    expect(result).toMatchObject({ matched: 0, total: 4, accuracy: 0 })
  })

  it('counts each annotation once even when a hypothesis repeats it', () => {
    expect(scoreProperNouns('Priya Priya Priya', ['Priya', 'Sowmya']))
      .toMatchObject({ matched: 1, total: 2, accuracy: 0.5 })
    expect(scoreProperNouns('', ['Priya']).accuracy).toBe(0)
    expect(scoreProperNouns('ordinary speech', []).accuracy).toBeNull()
  })

  it('annotates literal reference spans and pools fourteen names across the two clips', () => {
    const base = resolve('scripts/asr-bench/fixtures')
    const names = JSON.parse(readFileSync(resolve(base, 'proper-nouns.json'), 'utf8')) as Record<string, string[]>
    const truth = JSON.parse(readFileSync(resolve(base, 'ground-truth.json'), 'utf8').replace(/^\uFEFF/u, '')) as Record<string, string>
    expect(Object.keys(names).sort()).toEqual(Object.keys(truth).sort())
    expect(Object.values(names).flat()).toHaveLength(14)
    for (const [clip, spans] of Object.entries(names)) {
      for (const span of spans) expect(truth[clip]).toContain(span)
      if (spans.length) expect(scoreProperNouns(truth[clip]!, spans).accuracy).toBe(1)
    }
  })

  it('skips fewer than five whitespace words, including the four-word tiny clip', () => {
    for (const text of ['', ' \n\t ', 'Send the email now.', 'one two three four']) {
      expect(shouldSkipCleanup(text)).toBe(true)
    }
    expect(shouldSkipCleanup(' one\ttwo\nthree  four five ')).toBe(false)
    expect(shouldSkipCleanup('one two three and four')).toBe(false)
    expect(shouldSkipCleanup('one-two three four five')).toBe(true)
  })
})
