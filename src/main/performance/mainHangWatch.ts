import { cleanHangFrames, type HangRecord, type HangStack } from './hangRecording'
import { WATCH_TICK_MS } from './hangWatchdogShared'

/**
 * Main has not answered for this long: the watch takes its stack and saves a hang recording (Zach's pick, November 12,
 * 2026). It was `MAIN_HANG_MS` until then, so the common freeze of one to five seconds left nothing to diagnose. It is
 * measured from main's last heartbeat, which comes every 250 ms, so a freeze from about 750 ms that starts just after a
 * beat reaches it too.
 */
export const MAIN_RECORD_MS = 1_000
/**
 * A hang of main: it has not answered for this long, long enough that no ordinary save or start is mistaken for one.
 * Quit's backstop ends only a main stopped this long, and a stop this long is recorded even inside
 * `MAIN_RECORDING_GAP_MS`, as it was before the threshold moved.
 */
export const MAIN_HANG_MS = 5_000
/** Once Quit was received, Sotto ends itself after this long whatever main is doing: the quit drain's 10 s, and room. */
export const QUIT_FORCE_MS = 20_000
/**
 * A stack each this often while main stays stopped, up to `HANG_STACKS`: from 1 s to 9 s, so a stop that lasts past 5 s
 * keeps the stacks at 5 to 9 s that a hang recording held before, and the four before them.
 */
export const HANG_STACK_EVERY_MS = 1_000
export const HANG_STACKS = 9
/**
 * Tries at a stack in one recording, those that got one and those that did not. A try that gets nothing waits for the
 * debugger first, so a main that stays outside JavaScript for good is tried for about a minute and then left.
 */
export const HANG_TRIES = 2 * HANG_STACKS
/**
 * At most one recording of main in this long: two freezes 24 s apart are both kept, and a minute of freezes writes
 * three at most.
 */
export const MAIN_RECORDING_GAP_MS = 20_000
/**
 * At most one window hang in this long. A hang of main (`MAIN_HANG_MS`) is also recorded inside `MAIN_RECORDING_GAP_MS`
 * at most once in this long, so a short freeze never costs the hang after it its recording.
 */
export const HANG_RECORDING_GAP_MS = 10 * 60_000
/**
 * A gap this long between two of the watch's own looks, which come every 250 ms, means the whole process was not running:
 * the computer slept, or was too starved to run anything. Main's silence across it is no hang, and it does not count
 * towards Quit's deadline.
 */
export const ASLEEP_GAP_MS = 2_000
/**
 * The same, for the 1 s recording. A look finds main's heartbeat, written every 250 ms, up to 250 ms old while main runs.
 * So a stall of the whole process of 750 ms or more between two looks would read as main stopped for 1 s, and
 * `ASLEEP_GAP_MS` lets stalls up to 2 s through. A gap over 500 ms restarts the count towards `MAIN_RECORD_MS`, leaving
 * the heartbeat 250 ms of lateness and the watch's own look 250 ms. Quit and the hang rule still use `ASLEEP_GAP_MS`.
 */
export const NOT_RUNNING_GAP_MS = 500
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
 * the tray with it, so only another thread can see one. When main has not answered for `MAIN_RECORD_MS`, it takes main's stack
 * at once and saves it as a hang recording, then takes it again once a second while main stays stopped and rewrites the
 * recording with them; once main answers, it writes how long that took. Once Quit was received, it ends Sotto if main has
 * stopped answering for `hangMs` and the process has run for `quitForceMs` since.
 */
export class MainHangWatch {
  private recording: { readonly name: string; readonly record: HangRecord; readonly answeredAt: number
    /** Time the computer slept between two of its stacks, left out of how long main was stopped. */
    readonly asleepMs: number } | null = null
  /** When the previous look began and ended; undefined before the first. */
  private previous: { readonly began: number; readonly ended: number } | undefined
  /** When the look that is running began. */
  private lookBegan = 0
  /** The last time the process woke from a gap with no looks: main's silence before it is not counted. */
  private wokeAt = Number.NEGATIVE_INFINITY
  /** The same for `NOT_RUNNING_GAP_MS`: main's silence before it does not count towards `MAIN_RECORD_MS`. */
  private resumedAt = Number.NEGATIVE_INFINITY
  /** The Quit stamp being timed, how long the process has run since it, and whether main answered all through. */
  private quit = { at: 0, ranMs: 0, cancelled: false }
  private ended = false
  private lastRecordingAt = Number.NEGATIVE_INFINITY
  private lastHangRecordingAt = Number.NEGATIVE_INFINITY
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
    this.lookBegan = began
    // How long the process ran since the last look began (a look that took stacks runs long), unless it was not
    // running at all between the two looks.
    let ranMs = 0
    if (this.previous) {
      const gap = began - this.previous.ended
      if (gap > NOT_RUNNING_GAP_MS) this.resumedAt = began
      if (gap > ASLEEP_GAP_MS) this.wokeAt = began
      else ranMs = began - this.previous.began
    }
    // A look that took stacks may have moved `lookBegan` on: Quit's time before it is already counted.
    try { await this.look(began, ranMs) } finally { this.previous = { began: this.lookBegan, ended: this.options.now() } }
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
      if (this.quit.ranMs >= this.quitForceMs && this.quitDeadline(stoppedFor)) return
    }
    if (this.recording && this.recording.record.answeredAfterMs === null && answeredAt !== this.recording.answeredAt) await this.answered(answeredAt)
    if (this.recording?.answeredAt === answeredAt) return
    const hang = stoppedFor >= this.hangMs
    const due = (now - Math.max(answeredAt, this.resumedAt) >= MAIN_RECORD_MS && now - this.lastRecordingAt >= MAIN_RECORDING_GAP_MS)
      || (hang && now - this.lastHangRecordingAt >= HANG_RECORDING_GAP_MS)
    if (!due) return
    this.lastRecordingAt = now
    if (hang) this.lastHangRecordingAt = now
    await this.record(answeredAt)
    // The stacks stopped at Quit's deadline: the backstop decides now, on the stop as it is now, as a look would have.
    if (this.quitLeftMs() <= 0) {
      const at = this.options.now()
      this.quit.ranMs += at - this.lookBegan
      this.lookBegan = at
      this.quitDeadline(at - Math.max(lastAnswered(), this.wokeAt))
    }
  }

  /**
   * Quit's deadline has come. A main that still answers has the quit drain's own deadline, and is left to it: only a main
   * that has stopped for `hangMs` is ended from here. A main that answered all through the deadline was not quitting
   * after all: the quit was cancelled, so this stamp ends nothing. A hang during quit is recorded first, like any other.
   * True when Sotto is being ended.
   */
  private quitDeadline(stoppedFor: number): boolean {
    if (stoppedFor >= this.hangMs) {
      this.ended = true
      this.options.log('quit-forced')
      this.options.kill()
      return true
    }
    this.quit.cancelled = true
    return false
  }

  /**
   * Main's stack at once, saved, then once a second while it stays stopped, rewritten with them. A try that gets nothing,
   * as when main is inside a long native call, is tried again a second later in the same recording, so a stop that goes
   * back into JavaScript still gets its stacks. A pause that landed after main had answered is not kept. Stacks stop at
   * Quit's deadline, so the backstop decides on time.
   */
  private async record(answeredAt: number): Promise<void> {
    const session: Session = { debug: null }
    try {
      const stacks: HangStack[] = []
      const first = await this.take(session, answeredAt)
      if (first) stacks.push(first)
      if (!await this.save(answeredAt, stacks)) return
      for (let tries = 1; stacks.length < HANG_STACKS && tries < HANG_TRIES && await this.whileStopped(answeredAt, HANG_STACK_EVERY_MS); tries += 1) {
        const next = await this.take(session, answeredAt)
        if (next) stacks.push(next)
      }
      await this.rewrite(answeredAt, stacks)
    } finally { if (session.debug) release(session.debug) }
  }

  /**
   * One try at main's stack: a debugger session if there is none, then a pause. A session whose pause did not land is let
   * go, which drops the pause it asked for, so main is never left paused by a pause that lands later.
   */
  private async take(session: Session, answeredAt: number): Promise<HangStack | null> {
    session.debug ??= await this.connect()
    const stack = session.debug ? await this.stack(session.debug, answeredAt) : null
    if (!stack && session.debug) { release(session.debug); session.debug = null }
    return stack
  }

  /**
   * Waits `ms` while main stays stopped, looking as often as the watch does, so the first heartbeat after main answers is
   * the one read and a 1.2 s freeze is not written as 2 s. False once main has answered, Quit's deadline has come, or
   * the computer slept.
   */
  private async whileStopped(answeredAt: number, ms: number): Promise<boolean> {
    const { now, sleep, lastAnswered } = this.options
    for (let waited = 0; waited < ms;) {
      const left = this.quitLeftMs()
      if (left <= 0) return false
      const step = Math.min(WATCH_TICK_MS, ms - waited, left)
      const before = now()
      await sleep(step)
      const after = now()
      // Asleep between two stacks, as between two looks: main's silence across it is not counted, nor is the time
      // towards Quit's deadline, and no stack taken after it would belong to this stop.
      if (after - before - step > ASLEEP_GAP_MS) {
        if (this.quit.at > 0 && !this.quit.cancelled) this.quit.ranMs += before - this.lookBegan
        this.lookBegan = after
        this.wokeAt = after
        this.resumedAt = after
        const current = this.recording
        if (current?.answeredAt === answeredAt) this.recording = { ...current, asleepMs: current.asleepMs + after - before - step }
        return false
      }
      waited += step
      if (lastAnswered() !== answeredAt) return false
    }
    return this.quitLeftMs() > 0
  }

  /** Main's debugger, enabled; null when it could not be had, as when main is stopped outside JavaScript. */
  private async connect(): Promise<MainDebugger | null> {
    let debug: MainDebugger
    try { debug = this.options.connect() } catch { return null }
    try {
      // Stopped outside JavaScript (a long native call), main cannot take even this until it returns.
      if (await within(debug.post('Debugger.enable').then(() => true), this.debuggerWait()) === true) return debug
    } catch { /* released below */ }
    release(debug)
    return null
  }

  /** One stack, or null when none came or main had answered by the time it did. */
  private async stack(debug: MainDebugger, answeredAt: number): Promise<HangStack | null> {
    const { now, lastAnswered } = this.options
    try {
      const paused = debug.nextPause(this.debuggerWait())
      void debug.post('Debugger.pause').catch(() => undefined)
      const frames = await paused
      if (frames === null) return null
      const stillStopped = lastAnswered() === answeredAt
      await within(debug.post('Debugger.resume').catch(() => undefined), this.debuggerWaitMs)
      return stillStopped ? { atMs: now() - answeredAt, frames: cleanHangFrames(frames, this.options.appRoots, this.options.devOrigins) } : null
    } catch { return null }
  }

  private async save(answeredAt: number, stacks: readonly HangStack[]): Promise<boolean> {
    const { now } = this.options
    const wallNow = this.options.wallNow ?? Date.now
    const record: HangRecord = { format: 1, kind: 'main', sottoVersion: this.options.sottoVersion, platform: this.options.platform,
      startedAt: new Date(wallNow() - (now() - answeredAt)).toISOString(), answeredAfterMs: null,
      writtenAfterMs: now() - answeredAt, stacks: [...stacks] }
    try {
      this.recording = { name: await this.options.save(record), record, answeredAt, asleepMs: 0 }
      this.options.log('hang-recording-saved')
      return true
    } catch { this.recording = null; this.options.log('hang-recording-failed'); return false }
  }

  /**
   * The saved recording again, with every stack taken while main stayed stopped, and how long it lasted if main has
   * answered meanwhile. Not written when neither has changed.
   */
  private async rewrite(answeredAt: number, stacks: readonly HangStack[]): Promise<void> {
    const current = this.recording
    if (!current || current.answeredAt !== answeredAt) return
    const answered = this.options.lastAnswered()
    const answeredAfterMs = answered === answeredAt ? null : answered - answeredAt - current.asleepMs
    if (answeredAfterMs === null && stacks.length === (current.record.stacks?.length ?? 0)) return
    await this.write({ ...current.record, answeredAfterMs,
      writtenAfterMs: Math.min(this.options.now() - answeredAt - current.asleepMs, answeredAfterMs ?? Number.POSITIVE_INFINITY), stacks: [...stacks] })
  }

  /** How long main was stopped, leaving out any time the computer slept between two of the recording's stacks. */
  private async answered(answeredAt: number): Promise<void> {
    const current = this.recording!
    await this.write({ ...current.record, answeredAfterMs: answeredAt - current.answeredAt - current.asleepMs })
  }

  /** The open recording, written again over its saved file. */
  private async write(record: HangRecord): Promise<void> {
    const current = this.recording!
    this.recording = { ...current, record }
    await this.options.update(current.name, record).catch(() => undefined)
  }

  /** How long a debugger request may wait: `debuggerWaitMs`, and no later than Quit's deadline, so the backstop decides on time. */
  private debuggerWait(): number {
    return Math.max(1, Math.min(this.debuggerWaitMs, this.quitLeftMs()))
  }

  /** How long until Quit's deadline, counting the look that is running; infinite while no quit is being timed. */
  private quitLeftMs(): number {
    if (this.quit.at === 0 || this.quit.cancelled) return Number.POSITIVE_INFINITY
    return this.quitForceMs - this.quit.ranMs - (this.options.now() - this.lookBegan)
  }
}

/** The debugger session a recording holds between its tries, or none. */
interface Session { debug: MainDebugger | null }

function release(debug: MainDebugger): void {
  void debug.post('Debugger.disable').catch(() => undefined)
  try { debug.close() } catch { /* already closed */ }
}
