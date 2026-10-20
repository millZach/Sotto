import { z } from 'zod'

/**
 * Main's own activity (#1233, ADR-0097): how often Sotto's main process was blocked over the last minute, and an
 * activity recording, one minute of main's and the window's CPU profiles saved on this computer. An Owl feature: the
 * window has this bridge only while the startup answers turn `main-freeze` on.
 */
export const MAIN_ACTIVITY_READ = 'sotto:main-activity:read'
export const MAIN_ACTIVITY_COMMAND = 'sotto:main-activity:command'
export const MAIN_ACTIVITY_CHANGED = 'sotto:main-activity:changed'
export const MAIN_ACTIVITY_RENDERER_ARGUMENT = '--sotto-main-activity-enabled'

/** One bar a second over the last minute. */
export const MAIN_LOOP_WINDOW_SECONDS = 60
/** A stretch this long or longer without main answering counts as one freeze. */
export const MAIN_FREEZE_MS = 100
/** Frozen: main was blocked for more than this share of the last minute (Zach's pick, October 20, 2026). */
export const MAIN_FROZEN_SHARE = 0.5
/** How long Record a minute records. */
export const ACTIVITY_RECORDING_MS = 60_000
/** Only the newest activity recordings stay in the folder. */
export const ACTIVITY_RECORDINGS_KEPT = 5

const share = z.number().min(0).max(1)
const milliseconds = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const mainLoopReadingSchema = z.object({
  /** The share of the window main was blocked, from 0 to 1. */
  blockedShare: share,
  longestFreezeMs: milliseconds,
  freezesOver100ms: z.number().int().nonnegative(),
  /** Milliseconds main was blocked in each second of the window, oldest first. */
  bars: z.array(z.number().nonnegative().max(1_000)).max(600),
  frozen: z.boolean(),
}).strict()
export type MainLoopReading = z.infer<typeof mainLoopReadingSchema>

export const activityRecordingStateSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('idle') }).strict(),
  z.object({ phase: z.literal('recording'), startedAt: milliseconds, durationMs: milliseconds }).strict(),
  z.object({
    phase: z.literal('saved'),
    /** The recording's folder name, which is also what the window calls it. */
    name: z.string().min(1).max(128),
    /** The folder on this computer, so a thread's draft can say where the files are. */
    folder: z.string().min(1).max(4_096),
    files: z.array(z.string().min(1).max(64)).max(8),
    bytes: z.number().int().nonnegative(),
    /** False when the window could not be recorded and only main's profile was kept. */
    windowRecorded: z.boolean(),
  }).strict(),
  z.object({ phase: z.literal('failed'), message: z.string().min(1).max(500) }).strict(),
])
export type ActivityRecordingState = z.infer<typeof activityRecordingStateSchema>

export const mainActivityStateSchema = z.object({
  reading: mainLoopReadingSchema,
  recording: activityRecordingStateSchema,
  /** Not now was pressed during this freeze: the notice stays away until main recovers and freezes again. */
  noticeHidden: z.boolean(),
}).strict()
export type MainActivityState = z.infer<typeof mainActivityStateSchema>

export const mainActivityCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('record') }).strict(),
  z.object({ type: z.literal('discard') }).strict(),
  z.object({ type: z.literal('not-now') }).strict(),
  z.object({ type: z.literal('close') }).strict(),
  z.object({ type: z.literal('show-in-folder') }).strict(),
])
export type MainActivityCommand = z.infer<typeof mainActivityCommandSchema>

export interface MainActivityBridge {
  read(): Promise<MainActivityState>
  command(command: MainActivityCommand): Promise<MainActivityState>
  onChanged(listener: (state: MainActivityState) => void): () => void
}

/**
 * Whether the notice shows (variant A of the mock-up): while main is frozen, unless Not now hid it or Settings turned
 * it off; while a recording runs; while a saved recording or a failure waits to be seen.
 */
export function mainFreezeNoticeVisible(state: MainActivityState | null, noticeSetting: boolean): boolean {
  if (state === null) return false
  if (state.recording.phase !== 'idle') return true
  return state.reading.frozen && !state.noticeHidden && noticeSetting
}

/** The share as people say it: whole percent, never "0%" for a little. */
export function blockedPercent(blockedShare: number): string {
  const percent = Math.round(blockedShare * 100)
  return percent === 0 && blockedShare > 0 ? 'under 1%' : `${percent}%`
}

/** A freeze's length as people say it: milliseconds under a second, then seconds to one place. */
export function freezeLength(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`
  return `${(Math.round(ms / 100) / 10).toFixed(1)} s`
}

/** What a thread's composer says when an activity recording is attached to a new thread; the user sends it. */
export function activityRecordingDraft(folder: string, files: readonly string[]): string {
  return [
    `Sotto's main process was slow, so I recorded a minute of its activity on this computer. The recording is in ${folder}`,
    `(${files.join(', ')}). The .cpuprofile files are Chrome CPU profiles of main and the window; summary.json has the event-loop numbers.`,
    'Read them and tell me what main was doing while it was blocked.',
  ].join(' ')
}
