import { z } from 'zod'

export const DICTATION_TIMING = 'sotto:dictation:timing'
export const DICTATION_TIMING_ARGUMENT = '--sotto-dictation-timing'

/** Fixed vocabulary only: neither this channel nor its local file accepts dictated content. */
export const DICTATION_TIMING_EVENTS = [
  'hotkey-received', 'dictation-command-sent', 'dictation-command-received',
  'widget-show-started', 'widget-shown',
  'recorder-started', 'audio-context-started', 'audio-context-ready',
  'worklet-load-started', 'worklet-loaded', 'microphone-request-started',
  'microphone-resolved', 'source-connect-started', 'source-connected',
  'start-cue-started', 'start-cue-returned',
  'started-dispatched', 'widget-permission-waiting-committed', 'widget-listening-committed', 'widget-listening-shown',
  'first-audio-chunk', 'stop-pressed', 'controller-stop-received',
  'recorder-stop-started', 'recorder-stop-resolved',
  'transcription-request-started', 'transcription-request-returned', 'last-segment-transcribed',
  'cleanup-started', 'cleanup-request-started', 'cleanup-request-returned', 'cleanup-returned',
  'delivery-started', 'clipboard-write-started', 'clipboard-written',
  'focused-app-started', 'focused-app-returned', 'widget-hide-started', 'widget-hidden',
  'paste-delay-started', 'paste-delay-ended', 'paste-keystroke-started', 'paste-keystroke-sent',
  'paste-settle-started', 'paste-settle-ended', 'delivery-returned',
  'history-started', 'history-returned', 'ready-dispatched', 'widget-ready',
] as const

export type DictationTimingEvent = typeof DICTATION_TIMING_EVENTS[number]
export const dictationTimingMarkSchema = z.object({
  event: z.enum(DICTATION_TIMING_EVENTS),
  atMs: z.number().finite().nonnegative(),
}).strict()
export type DictationTimingMark = z.infer<typeof dictationTimingMarkSchema>
export interface DictationTimingBridge {
  mark(mark: DictationTimingMark): void
}

let sink: ((mark: DictationTimingMark) => void) | undefined

/** Enabled once at process/renderer start; ordinary dictation does no timing IPC. */
export function setDictationTimingSink(next: typeof sink): void {
  sink = next
}

/** timeOrigin puts main and each renderer's monotonic performance.now() on the same epoch. */
export function dictationTimingNow(): number {
  return performance.timeOrigin + performance.now()
}

export function markDictationTiming(event: DictationTimingEvent): void {
  sink?.({ event, atMs: dictationTimingNow() })
}
