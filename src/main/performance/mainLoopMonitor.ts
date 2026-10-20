import { MAIN_FREEZE_MS, MAIN_FROZEN_SHARE, MAIN_LOOP_WINDOW_SECONDS, type MainLoopReading } from '../../shared/mainActivity'

/** Room for this many blocked stretches before the window grows; a minute of ten samples a second holds at most 600. */
const INITIAL_STRETCHES = 64

/**
 * Main's own event loop over exactly the last `seconds` seconds (#1233). It keeps the blocked stretches themselves,
 * each a start and an end on one clock, oldest first, so every figure is read from the same exact window
 * [now - seconds, now] with nothing averaged: the blocked share, the bars, the longest freeze and the count of
 * freezes. A stretch is one late sample; two that overlap are merged into one. Stretches that ended before the window
 * are dropped as samples arrive, so a minute holds few of them (at most one a sample). Only typed arrays and numbers:
 * recording is a comparison and two writes, and nothing here allocates per sample.
 */
export class MainLoopWindow {
  private starts = new Float64Array(INITIAL_STRETCHES)
  private ends = new Float64Array(INITIAL_STRETCHES)
  /** Index of the oldest stretch in the ring. */
  private head = 0
  private count = 0
  /** The latest time the window has been moved to; the window never moves back. */
  private latest = Number.NEGATIVE_INFINITY
  private readonly spanMs: number

  constructor(readonly seconds = MAIN_LOOP_WINDOW_SECONDS, readonly freezeMs = MAIN_FREEZE_MS) {
    this.spanMs = seconds * 1_000
  }

  /** Main could not answer from `now - blockedMs` to `now` (milliseconds on one clock). */
  record(now: number, blockedMs: number): void {
    this.advance(now)
    if (!(blockedMs > 0)) return
    if (now <= this.latest - this.spanMs) return
    let start = now - blockedMs, end = now
    // Merge with any stretch it overlaps, from the newest back. Late samples never overlap in practice.
    while (this.count > 0) {
      const last = this.index(this.count - 1)
      if (this.ends[last]! <= start) break
      start = Math.min(start, this.starts[last]!)
      end = Math.max(end, this.ends[last]!)
      this.count -= 1
    }
    if (this.count === this.starts.length) this.grow()
    const slot = this.index(this.count)
    this.starts[slot] = start
    this.ends[slot] = end
    this.count += 1
  }

  /** Moves the window to `now`, dropping every stretch that ended before it. */
  advance(now: number): void {
    if (now > this.latest) this.latest = now
    const from = this.latest - this.spanMs
    while (this.count > 0 && this.ends[this.head]! <= from) {
      this.head = (this.head + 1) % this.starts.length
      this.count -= 1
    }
  }

  /** The share of exactly the last `seconds` seconds, to `now`, main was blocked. Time before the first sample counts as answered. */
  blockedShare(now: number): number {
    this.advance(now)
    const from = now - this.spanMs
    let total = 0
    for (let at = 0; at < this.count; at += 1) {
      const slot = this.index(at)
      const part = Math.min(this.ends[slot]!, now) - Math.max(this.starts[slot]!, from)
      if (part > 0) total += part
    }
    return Math.min(1, total / this.spanMs)
  }

  /** Frozen: blocked for more than half the window (Zach's pick). */
  frozen(now: number): boolean {
    return this.blockedShare(now) > MAIN_FROZEN_SHARE
  }

  /**
   * The window as the notice and Settings show it, from the same stretches over the same window as the share. Bar `i`
   * is the blocked time in the second from `now - seconds + i` to the one after, oldest first, so the bars add up to
   * the blocked share. A freeze partly outside the window counts for its part inside: that part is what the bars show,
   * what the longest freeze measures and what is held against 100 ms when freezes are counted.
   */
  reading(now: number): MainLoopReading {
    const blockedShare = this.blockedShare(now)
    const from = now - this.spanMs
    const bars = new Array<number>(this.seconds).fill(0)
    let longestFreezeMs = 0, freezesOver100ms = 0
    for (let at = 0; at < this.count; at += 1) {
      const slot = this.index(at)
      const start = Math.max(this.starts[slot]!, from), end = Math.min(this.ends[slot]!, now)
      if (!(end > start)) continue
      const length = end - start
      if (length > longestFreezeMs) longestFreezeMs = length
      if (length >= this.freezeMs) freezesOver100ms += 1
      for (let cursor = start; cursor < end;) {
        const bar = Math.min(this.seconds - 1, Math.floor((cursor - from) / 1_000))
        const stop = Math.min(end, from + (bar + 1) * 1_000)
        bars[bar] = bars[bar]! + (stop - cursor)
        if (stop <= cursor) break
        cursor = stop
      }
    }
    for (let bar = 0; bar < bars.length; bar += 1) bars[bar] = Math.min(1_000, Math.round(bars[bar]!))
    return { blockedShare, longestFreezeMs: Math.round(longestFreezeMs), freezesOver100ms, bars, frozen: blockedShare > MAIN_FROZEN_SHARE }
  }

  private index(at: number): number {
    return (this.head + at) % this.starts.length
  }

  /** Doubles the ring, oldest stretch first. Runs only when a window holds more stretches than ever before. */
  private grow(): void {
    const starts = new Float64Array(this.starts.length * 2), ends = new Float64Array(this.ends.length * 2)
    for (let at = 0; at < this.count; at += 1) {
      const slot = this.index(at)
      starts[at] = this.starts[slot]!
      ends[at] = this.ends[slot]!
    }
    this.starts = starts
    this.ends = ends
    this.head = 0
  }
}

export interface MainLoopClock {
  /** Milliseconds on a monotonic clock. */
  now(): number
  setInterval(callback: () => void, ms: number): { unref?: () => unknown }
  clearInterval(handle: { unref?: () => unknown }): void
}

export interface MainLoopMonitorOptions {
  readonly clock: MainLoopClock
  /** How often the sampler asks to run. A sample that arrives late by more than the tolerance was blocked that long. */
  readonly intervalMs?: number
  readonly windowSeconds?: number
  /** Called once a second at most, when the frozen answer changes. */
  readonly onFrozenChange: (frozen: boolean) => void
}

/** Lateness this small is the timer's own jitter, not main being busy. */
export const SAMPLE_TOLERANCE_MS = 2
/** Ten samples a second: a 50 ms timer cost main's process about 6.5 ms of CPU a second, this about 2 ms (ADR-0098). */
export const SAMPLE_INTERVAL_MS = 100

/**
 * Main's watch on itself: a timer that asks to run every 100 ms and counts how late it ran. Lateness is time main
 * spent on something else and could not answer, which is what a person feels as a freeze. One timer, a subtraction
 * and a few array writes a sample; the frozen answer is worked out once a second. It is started only while the
 * `main-freeze` Owl feature is on.
 */
export class MainLoopMonitor {
  readonly window: MainLoopWindow
  private readonly intervalMs: number
  private handle: { unref?: () => unknown } | null = null
  private last = 0
  private second = -1
  private frozen = false

  constructor(private readonly options: MainLoopMonitorOptions) {
    this.intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS
    this.window = new MainLoopWindow(options.windowSeconds ?? MAIN_LOOP_WINDOW_SECONDS)
  }

  start(): void {
    if (this.handle !== null) return
    this.last = this.options.clock.now()
    this.window.advance(this.last)
    this.handle = this.options.clock.setInterval(() => this.sample(), this.intervalMs)
    this.handle.unref?.()
  }

  stop(): void {
    if (this.handle === null) return
    this.options.clock.clearInterval(this.handle)
    this.handle = null
  }

  get running(): boolean { return this.handle !== null }

  isFrozen(): boolean { return this.frozen }

  reading(): MainLoopReading { return this.window.reading(this.options.clock.now()) }

  /** One sample; public so tests drive it with their own clock. */
  sample(): void {
    const now = this.options.clock.now()
    const late = now - this.last - this.intervalMs
    this.last = now
    this.window.record(now, late > SAMPLE_TOLERANCE_MS ? late : 0)
    const second = Math.floor(now / 1_000)
    if (second === this.second) return
    this.second = second
    const frozen = this.window.frozen(now)
    if (frozen === this.frozen) return
    this.frozen = frozen
    this.options.onFrozenChange(frozen)
  }
}
