import { TRANSCRIPTION_SAMPLE_RATE } from '../../../shared/audio'
import type { AudioRecordingResult } from './audioRecorder'
import { SEGMENT_MIN_SECONDS, SEGMENT_SILENCE_RMS } from './audioRecorder'

/**
 * Whether the audio left at stop holds nothing worth transcribing: shorter than
 * the shortest segment the recorder cuts, and no capture block in it reached the
 * level the recorder treats as a pause. The speech model makes a filler word
 * ("Uh", "Yeah") out of such a tail (#937), so it is not sent. Judging each
 * block rather than the tail's average keeps a short quiet word. A longer tail,
 * which the recorder leaves only once it has stopped cutting segments, and a
 * tail without a measured peak are sent as before.
 */
export function isSilentTail(tail: AudioRecordingResult): boolean {
  const { samples, peakChunkRms } = tail
  return (
    peakChunkRms !== undefined &&
    peakChunkRms < SEGMENT_SILENCE_RMS &&
    samples.length > 0 &&
    samples.length < SEGMENT_MIN_SECONDS * TRANSCRIPTION_SAMPLE_RATE
  )
}
