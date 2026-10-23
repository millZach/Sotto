// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { calculateRms } from '../../../../src/renderer/src/audio/audioMath'
import { SEGMENT_MIN_SECONDS, SEGMENT_SILENCE_RMS } from '../../../../src/renderer/src/audio/audioRecorder'
import { isSilentTail } from '../../../../src/renderer/src/audio/silentTail'
import { tone, withBurst } from '../../../fixtures/renderer/syntheticAudio'

describe('isSilentTail', () => {
  it('finds the nearly silent tail the speech model made a word of (#937)', () => {
    expect(isSilentTail(tone(0.47, 0.0005))).toBe(true)
  })

  it('keeps a short tail with a brief sound above the pause level, even when its average is below it', () => {
    const tail = withBurst(tone(0.5, 0.0005), 0.2, 0.03, 0.03)

    expect(calculateRms(tail)).toBeLessThan(SEGMENT_SILENCE_RMS)
    expect(isSilentTail(tail)).toBe(false)
  })

  it('keeps quiet speech that stays just above the pause level', () => {
    expect(isSilentTail(tone(1, SEGMENT_SILENCE_RMS * 1.2))).toBe(false)
  })

  it('judges only tails shorter than the shortest segment the recorder cuts', () => {
    expect(isSilentTail(tone(SEGMENT_MIN_SECONDS - 0.1, 0.0005))).toBe(true)
    expect(isSilentTail(tone(SEGMENT_MIN_SECONDS, 0.0005))).toBe(false)
  })

  it('leaves an empty tail to the empty-recording path', () => {
    expect(isSilentTail(new Float32Array())).toBe(false)
  })
})
