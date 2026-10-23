/*
 * Plays the menu bar owl (ADR-0114): asks the schedule when the picture next changes, sets one timer for that
 * moment and swaps the tray image only when the frame changes. No Electron here: the caller passes in a
 * `setImage` and the frames as images.
 */

import type { MenuBarOwlBody, MenuBarOwlEyes } from '../../../shared/menuBarOwl'
import { allOwlPoses, poseKey } from './poses.mjs'
import { createOwlSchedule, type OwlSchedule } from './schedule'

export interface OwlTimers {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
  now(): number
}

export type OwlEvent = 'owl-started' | 'owl-frames-unavailable' | 'owl-failed' | 'owl-stopped'

export interface OwlAnimatorDeps<Image> {
  readonly setImage: (image: Image) => void
  /** index = frame number; may throw. */
  readonly frames: (body: MenuBarOwlBody, eyes: MenuBarOwlEyes) => readonly Image[]
  readonly random?: () => number
  /** Default: setTimeout with .unref?.(), performance.now(). */
  readonly timers?: OwlTimers
  readonly log?: (event: OwlEvent) => void
  /** Default: createOwlSchedule. */
  readonly createSchedule?: (startMs: number, random: () => number) => OwlSchedule
}

const REST_FRAME = 0

const defaultTimers: OwlTimers = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    handle.unref?.()
    return handle
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
  now: () => performance.now(),
}

let frameByKey: ReadonlyMap<string, number> | null = null

function frameIndex(key: string): number | undefined {
  frameByKey ??= new Map(allOwlPoses().map((pose, i) => [poseKey(pose), i]))
  return frameByKey.get(key)
}

export class TrayOwlAnimator<Image> {
  private readonly timers: OwlTimers
  private readonly random: () => number
  private readonly createSchedule: (startMs: number, random: () => number) => OwlSchedule
  private body: MenuBarOwlBody
  private eyes: MenuBarOwlEyes
  private reducedMotion: boolean
  private paused = false
  private started = false
  private disposed = false
  private images: readonly Image[] | null = null
  private shown = -1
  private schedule: OwlSchedule | null = null
  private timer: unknown = null
  /** Bumped whenever the timer is cleared, so a callback that fires anyway does nothing. */
  private generation = 0

  constructor(
    private readonly deps: OwlAnimatorDeps<Image>,
    initial: { body: MenuBarOwlBody; eyes: MenuBarOwlEyes; reducedMotion: boolean },
  ) {
    this.timers = deps.timers ?? defaultTimers
    this.random = deps.random ?? Math.random
    this.createSchedule = deps.createSchedule ?? createOwlSchedule
    this.body = initial.body
    this.eyes = initial.eyes
    this.reducedMotion = initial.reducedMotion
  }

  /** Loads the frames, shows the rest frame and starts the schedule; false if the frames cannot load. */
  start(): boolean {
    if (this.disposed) return false
    if (this.started) return true
    const images = this.load(this.body, this.eyes)
    if (!images) return false
    this.images = images
    this.started = true
    this.show(REST_FRAME)
    if (this.disposed) return false
    this.deps.log?.('owl-started')
    this.resume()
    return !this.disposed
  }

  /** Swaps the frame set and re-shows the current pose; false, keeping the old set, if the new one cannot load. */
  setLook(body: MenuBarOwlBody, eyes: MenuBarOwlEyes): boolean {
    if (this.disposed) return false
    if (!this.started) {
      this.body = body
      this.eyes = eyes
      return true
    }
    if (body === this.body && eyes === this.eyes) return true
    const images = this.load(body, eyes)
    if (!images) return false
    this.body = body
    this.eyes = eyes
    this.images = images
    const current = this.shown
    this.shown = -1
    this.show(current < 0 ? REST_FRAME : current)
    return !this.disposed
  }

  /** On: sit still on the rest frame with no timer. Off: start again with a fresh schedule. */
  setReducedMotion(on: boolean): void {
    if (this.disposed || on === this.reducedMotion) return
    this.reducedMotion = on
    if (!this.started) return
    if (on) {
      this.stop()
      this.show(REST_FRAME)
    } else {
      this.resume()
    }
  }

  /** On (screen locked, Mac asleep): stop the timer and keep the image. Off: start again with a fresh schedule. */
  setPaused(on: boolean): void {
    if (this.disposed || on === this.paused) return
    this.paused = on
    if (!this.started) return
    if (on) this.stop()
    else this.resume()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    if (this.started) this.deps.log?.('owl-stopped')
  }

  private load(body: MenuBarOwlBody, eyes: MenuBarOwlEyes): readonly Image[] | null {
    try {
      const images = this.deps.frames(body, eyes)
      if (images.length === 0) throw new Error('no frames')
      return images
    } catch {
      this.deps.log?.('owl-frames-unavailable')
      return null
    }
  }

  private show(index: number): void {
    if (this.disposed || index === this.shown || !this.images) return
    const image = this.images[index]
    if (image === undefined) return
    this.shown = index
    try {
      this.deps.setImage(image)
    } catch {
      // The tray is gone or refuses the image: stop for good rather than throw out of a timer or a settings change.
      this.deps.log?.('owl-failed')
      this.dispose()
    }
  }

  private stop(): void {
    this.generation += 1
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
    this.schedule = null
  }

  private resume(): void {
    this.stop()
    if (this.disposed || this.paused || this.reducedMotion) return
    // A fresh schedule starts from the rest pose, so the picture starts there too.
    this.show(REST_FRAME)
    if (this.disposed) return
    this.schedule = this.createSchedule(this.timers.now(), this.random)
    this.arm()
  }

  private arm(): void {
    const schedule = this.schedule
    if (!schedule || !Number.isFinite(schedule.nextAt)) return
    const generation = this.generation
    const delay = Math.max(1, schedule.nextAt - this.timers.now())   // never a zero-delay loop
    this.timer = this.timers.set(() => this.tick(generation), delay)
  }

  private tick(generation: number): void {
    if (generation !== this.generation || this.disposed || !this.schedule) return
    this.timer = null
    try {
      const pose = this.schedule.advance(this.timers.now())
      if (pose) {
        const index = frameIndex(poseKey(pose))
        if (index !== undefined) this.show(index)
      }
      this.arm()
    } catch {
      // A schedule that throws must not escape a timer callback or leave a chain that keeps throwing.
      this.deps.log?.('owl-failed')
      this.dispose()
    }
  }
}
