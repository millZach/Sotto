import { TRANSCRIPTION_SAMPLE_RATE } from '../../../shared/audio'
import { calculateRms } from './audioMath'
import { SEGMENT_MIN_SECONDS, SEGMENT_SILENCE_RMS } from './audioRecorder'

/**
 * The tail is judged in windows this long rather than as a whole, so one quiet
 * word in an otherwise silent tail still counts. A spoken sound lasts tens of
 * milliseconds and fills at least one window; the recorder judges its own
 * blocks (128 frames, 3 to 8 ms) on the same level.
 */
const SILENT_TAIL_WINDOW_SECONDS = 0.01

/**
 * Whether the audio left at stop holds nothing worth transcribing: shorter than
 * the shortest segment the recorder cuts, and never rising above the level it
 * treats as a pause. The speech model makes a filler word ("Uh", "Yeah") out of
 * such a tail (#937), so it is not sent. Any window at or above that level
 * keeps the whole tail, and so does a longer one, which the recorder only
 * leaves when it has stopped cutting segments.
 */
export function isSilentTail(
  samples: Float32Array,
  sampleRate: number = TRANSCRIPTION_SAMPLE_RATE,
): boolean {
  if (samples.length === 0 || samples.length >= SEGMENT_MIN_SECONDS * sampleRate) return false
  const window = Math.max(1, Math.round(SILENT_TAIL_WINDOW_SECONDS * sampleRate))
  for (let start = 0; start < samples.length; start += window) {
    if (calculateRms(samples.subarray(start, start + window)) >= SEGMENT_SILENCE_RMS) return false
  }
  return true
}
