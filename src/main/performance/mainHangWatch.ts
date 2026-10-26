import { cleanHangFrames, type HangRecord, type HangStack } from './hangRecording'

/** Main has not answered for this long: long enough that no ordinary save or start is mistaken for a hang. */
export const MAIN_HANG_MS = 5_000
/** Once Quit was received, Sotto ends itself after this long whatever main is doing: the quit drain's 10 s, and room. */
export const QUIT_FORCE_MS = 20_000
/** A stack each this often while main stays stopped, up to `HANG_STACKS`. */
export const HANG_STACK_EVERY_MS = 1_000
export const HANG_STACKS = 5
/** At most one recording of each kind in this long, so a slow afternoon does not fill the folder. */
export const HANG_RECORDING_GAP_MS = 10 * 60_000
/** How long a debugger request may wait before the watch gives up on it: main is stopped outside JavaScript. */
export const DEBUGGER_WAIT_MS = 3_000

/** The debugger on main's own thread, reached from the watch's worker without a port (`connectToMainThread`). */
export interface MainDebugger {
  post(method: string, params?: object): Promise<unknown>
  /** The next `Debugger.paused`'s call frames, or null if none comes within `withinMs`. */
  nextPause(withinMs: number): Promise<unknown[] | null>
  close(): void
}

export interface MainHangWatchOptions {
  /** Wall-clock milliseconds when main last answered (its heartbeat). */
  readonly lastAnswered: () => number
  /** Wall-clock milliseconds when Quit was received, or 0. */
  readonly quitReceivedAt: () => number
  readonly now: () => number
  readonly connect: () => MainDebugger
  readonly save: (record: HangRecord) => Promise<string>
  readonly update: (name: string, record: HangRecord) => Promise<void>
  /** Ends the whole process at once. */
  readonly kill: () => void
  readonly sleep: (ms: number) => Promise<void>
  readonly log: (event: 'hang-recording-saved' | 'hang-recording-failed' | 'quit-forced') => void
  readonly appRoots: readonly string[]
  readonly devOrigins?: readonly string[]
  readonly sottoVersion: string
  readonly platform: string
  readonly hangMs?: number
  readonly quitForceMs?: number
  readonly debuggerWaitMs?: number
}

const within = <T>(work: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([work, new Promise<undefined>(resolve => { const timer = setTimeout(() => resolve(undefined), ms); (timer as { unref?: () => void }).unref?.() })])

/**
 * The watch on main that runs off main's thread (#1581). A hang of main stops main's own monitor, its freeze notice and
 * the tray with it, so only another thread can see one. When main has not answered for `hangMs`, it takes main's stack a
 * few times while main stays stopped and saves them as a hang recording; once main answers, it writes how long that took.
 * Once Quit was received, it ends Sotto if main has not done so within `quitForceMs` and has stopped answering.
 */
export class MainHangWatch {
  private recording: { readonly name: string; readonly record: HangRecord } | null = null
  private lastRecordingAt = Number.NEGATIVE_INFINITY
  private readonly hangMs: number
  private readonly quitForceMs: number
  private readonly debuggerWaitMs: number

  constructor(private readonly options: MainHangWatchOptions) {
    this.hangMs = options.hangMs ?? MAIN_HANG_MS
    this.quitForceMs = options.quitForceMs ?? QUIT_FORCE_MS
    this.debuggerWaitMs = options.debuggerWaitMs ?? DEBUGGER_WAIT_MS
  }

  /** One look; the worker calls it a few times a second and never two at once. */
  async tick(): Promise<void> {
    const { now, lastAnswered, quitReceivedAt } = this.options
    const quitAt = quitReceivedAt()
    const answeredAt = lastAnswered()
    // A main that still answers has the quit drain's own deadline, and is left to it: only a main that has stopped is
    // ended from here. A hang during quit is recorded first, like any other, so it too leaves its stack.
    if (quitAt > 0 && now() - quitAt >= this.quitForceMs && now() - answeredAt >= this.hangMs) {
      this.options.log('quit-forced')
      this.options.kill()
      return
    }
    if (now() - answeredAt < this.hangMs) {
      if (this.recording && this.recording.record.answeredAfterMs === null) await this.answered(answeredAt)
      return
    }
    if (this.recording?.record.startedAt === new Date(answeredAt).toISOString()) return
    if (now() - this.lastRecordingAt < HANG_RECORDING_GAP_MS) return
    this.lastRecordingAt = now()
    const stacks = await this.stacks(answeredAt)
    const record: HangRecord = { format: 1, kind: 'main', sottoVersion: this.options.sottoVersion, platform: this.options.platform,
      startedAt: new Date(answeredAt).toISOString(), answeredAfterMs: null, writtenAfterMs: now() - answeredAt, stacks }
    try {
      this.recording = { name: await this.options.save(record), record }
      this.options.log('hang-recording-saved')
    } catch { this.recording = null; this.options.log('hang-recording-failed') }
  }

  /** Main's stack, a few times while it stays stopped. A pause that landed after main had answered is not kept. */
  private async stacks(answeredAt: number): Promise<HangStack[]> {
    const { now, lastAnswered } = this.options
    const stacks: HangStack[] = []
    let debug: MainDebugger
    try { debug = this.options.connect() } catch { return stacks }
    try {
      // Stopped outside JavaScript (a long native call), main cannot take even this until it returns.
      if (await within(debug.post('Debugger.enable').then(() => true), this.debuggerWaitMs) !== true) return stacks
      for (let taken = 0; taken < HANG_STACKS && lastAnswered() === answeredAt; taken += 1) {
        const paused = debug.nextPause(this.debuggerWaitMs)
        void debug.post('Debugger.pause').catch(() => undefined)
        const frames = await paused
        if (frames === null) break
        const stillStopped = lastAnswered() === answeredAt
        await within(debug.post('Debugger.resume').catch(() => undefined), this.debuggerWaitMs)
        if (!stillStopped) break
        stacks.push({ atMs: now() - answeredAt, frames: cleanHangFrames(frames, this.options.appRoots, this.options.devOrigins) })
        if (taken + 1 < HANG_STACKS) await this.options.sleep(HANG_STACK_EVERY_MS)
      }
    } catch { /* what was taken is kept */ } finally {
      void debug.post('Debugger.disable').catch(() => undefined)
      try { debug.close() } catch { /* already closed */ }
    }
    return stacks
  }

  private async answered(answeredAt: number): Promise<void> {
    const current = this.recording!
    const record: HangRecord = { ...current.record, answeredAfterMs: answeredAt - Date.parse(current.record.startedAt) }
    this.recording = { name: current.name, record }
    await this.options.update(current.name, record).catch(() => undefined)
  }
}
