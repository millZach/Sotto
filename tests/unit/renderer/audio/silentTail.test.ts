// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { SEGMENT_MIN_SECONDS, SEGMENT_SILENCE_RMS } from '../../../../src/renderer/src/audio/audioRecorder'
import { isSilentTail } from '../../../../src/renderer/src/audio/silentTail'
import { tone } from '../../../fixtures/renderer/syntheticAudio'

const tail = (seconds: number, peakChunkRms?: number) => ({
  samples: tone(seconds, 0.0005),
  sourceSampleRate: 48_000,
  durationMs: 13_000,
  ...(peakChunkRms === undefined ? {} : { peakChunkRms }),
})

describe('isSilentTail', () => {
  it('finds the nearly silent tail the speech model made a word of (#937)', () => {
    expect(isSilentTail(tail(0.47, 0.0006))).toBe(true)
  })

  it('keeps a tail with any capture block at or above the pause level', () => {
    expect(isSilentTail(tail(0.5, SEGMENT_SILENCE_RMS))).toBe(false)
    expect(isSilentTail(tail(0.5, 0.03))).toBe(false)
  })

  it('judges only tails shorter than the shortest segment the recorder cuts', () => {
    expect(isSilentTail(tail(SEGMENT_MIN_SECONDS - 0.1, 0.0006))).toBe(true)
    expect(isSilentTail(tail(SEGMENT_MIN_SECONDS, 0.0006))).toBe(false)
  })

  it('sends a tail the recorder did not measure, and leaves an empty one to the empty-recording path', () => {
    expect(isSilentTail(tail(0.47))).toBe(false)
    expect(isSilentTail({ ...tail(0, 0), samples: new Float32Array() })).toBe(false)
  })
})
