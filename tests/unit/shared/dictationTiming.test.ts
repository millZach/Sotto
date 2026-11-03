import { afterEach, describe, expect, it, vi } from 'vitest'
import { dictationTimingMarkSchema, markDictationTiming, setDictationTimingSink } from '../../../src/shared/dictationTiming'

afterEach(() => setDictationTimingSink(undefined))

describe('dictation timing privacy boundary', () => {
  it('accepts only the fixed handoff vocabulary and a finite clock reading', () => {
    expect(dictationTimingMarkSchema.safeParse({ event: 'first-audio-chunk', atMs: 42 }).success).toBe(true)
    expect(dictationTimingMarkSchema.safeParse({ event: 'widget-permission-waiting-committed', atMs: 42 }).success).toBe(true)
    expect(dictationTimingMarkSchema.safeParse({ event: 'dictated words', atMs: 42 }).success).toBe(false)
    expect(dictationTimingMarkSchema.safeParse({ event: 'first-audio-chunk', atMs: Infinity }).success).toBe(false)
    expect(dictationTimingMarkSchema.safeParse({ event: 'first-audio-chunk', atMs: 42, text: 'private' }).success).toBe(false)
    expect(dictationTimingMarkSchema.safeParse({ event: 'first-audio-chunk', atMs: 42, audio: [] }).success).toBe(false)
  })

  it('does not read the clock while timing is off', () => {
    const clock = vi.spyOn(performance, 'now')
    try {
      markDictationTiming('first-audio-chunk')
      expect(clock).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })
})
