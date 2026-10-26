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
/**
 * A gap this long between two of the watch's own looks, which come every 250 ms, means the whole process was not running:
 * the computer slept, or was too starved to run anything. Main's silence across it is no hang, and it does not count
 * towards Quit's deadline.
 */
export const ASLEEP_GAP_MS = 2_000
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
  /** When main last answered (its heartbeat), on `now`'s clock. */
  readonly lastAnswered: () => number
  /** When Quit was received, on `now`'s clock, or 0. */
  readonly quitReceivedAt: () => number
  /**
   * Milliseconds on a monotonic clock both threads share (`process.hrtime`), so a change of the computer's clock is never
   * taken for a hang.
   */
  readonly now: () => number
  /** The computer's clock, for the time a recording names. */
  readonly wallNow?: () => number
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
 * Once Quit was received, it ends Sotto if main has stopped answering and the process has run for `quitForceMs` since.
 */
export class MainHangWatch {
  private recording: { readonly name: string; readonly record: HangRecord; readonly answeredAt: number } | null = null
  /** When the previous look began and ended; undefined before the first. */
  private previous: { readonly began: number; readonly ended: number } | undefined
  /** The last time the process woke from a gap with no looks: main's silence before it is not counted. */
  private wokeAt = Number.NEGATIVE_INFINITY
  /** The Quit stamp being timed, how long the process has run since it, and whether main answered all through. */
  private quit = { at: 0, ranMs: 0, cancelled: false }
  private ended = false
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
    if (this.ended) return
    const began = this.options.now()
    // How long the process ran since the last look began (a look that took stacks runs long), unless it was not
    // running at all between the two looks.
    let ranMs = 0
    if (this.previous) {
      if (began - this.previous.ended > ASLEEP_GAP_MS) this.wokeAt = began
      else ranMs = began - this.previous.began
    }
    try { await this.look(began, ranMs) } finally { this.previous = { began, ended: this.options.now() } }
  }

  private async look(now: number, ranMs: number): Promise<void> {
    const { lastAnswered, quitReceivedAt } = this.options
    const answeredAt = lastAnswered()
    // Silence across a gap with no looks does not count: the computer slept, and main with it.
    const stoppedFor = now - Math.max(answeredAt, this.wokeAt)
    const quitAt = quitReceivedAt()
    if (quitAt !== this.quit.at) this.quit = { at: quitAt, ranMs: 0, cancelled: false }
    if (quitAt > 0 && !this.quit.cancelled) {
      this.quit.ranMs += ranMs
      if (this.quit.ranMs >= this.quitForceMs) {
        // A main that still answers has the quit drain's own deadline, and is left to it: only a main that has stopped
        // is ended from here. A main that answered all through the deadline was not quitting after all: the quit was
        // cancelled, so this stamp ends nothing. A hang during quit is recorded first, like any other.
        if (stoppedFor >= this.hangMs) {
          this.ended = true
          this.options.log('quit-forced')
          this.options.kill()
          return
        }
        this.quit.cancelled = true
      }
    }
    if (stoppedFor < this.hangMs) {
      if (this.recording && this.recording.record.answeredAfterMs === null && answeredAt !== this.recording.answeredAt) await this.answered(answeredAt)
      return
    }
    if (this.recording?.answeredAt === answeredAt) return
    if (now - this.lastRecordingAt < HANG_RECORDING_GAP_MS) return
    this.lastRecordingAt = now
    const stacks = await this.stacks(answeredAt)
    const wallNow = this.options.wallNow ?? Date.now
    const record: HangRecord = { format: 1, kind: 'main', sottoVersion: this.options.sottoVersion, platform: this.options.platform,
      startedAt: new Date(wallNow() - (this.options.now() - answeredAt)).toISOString(), answeredAfterMs: null,
      writtenAfterMs: this.options.now() - answeredAt, stacks }
    try {
      this.recording = { name: await this.options.save(record), record, answeredAt }
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
    const record: HangRecord = { ...current.record, answeredAfterMs: answeredAt - current.answeredAt }
    this.recording = { name: current.name, record, answeredAt: current.answeredAt }
    await this.options.update(current.name, record).catch(() => undefined)
  }
}
