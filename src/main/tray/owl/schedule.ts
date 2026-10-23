// When the menu bar owl flaps, glances and blinks (ADR-0113): the approved prototype's schedule
// (docs/prototypes/menubar-owl-prototype.html, `brain`), as a pure object. Time only comes in as `nowMs` and chance only
// from `random`, so the animator owns the one timer and tests run it on a made-up clock.

import {
  FLAP_SEQUENCES,
  LOOK_CHOICES,
  REST_POSE,
  blinkSteps,
  glanceSteps,
  lookPose,
  poseKey,
} from './poses.mjs'
import type { OwlLook, OwlPose } from './poses.mjs'

export interface OwlSchedule {
  /** When the picture may next change, on the clock `advance` is given. */
  readonly nextAt: number
  /** Plays everything due by `nowMs`; returns the pose to show when it differs from the one returned before, else null. */
  advance(nowMs: number): OwlPose | null
}

export interface OwlScheduleOptions {
  /** From one flap's start to the next one's, in ms. Default [5000, 10000]. */
  readonly flapGapMs?: readonly [number, number]
  /** From one glance to the next, in ms. Default [2600, 6200]. */
  readonly glanceGapMs?: readonly [number, number]
  /** From the end of one blink to the next, in ms. Default [4000, 9000]. */
  readonly blinkGapMs?: readonly [number, number]
}

type Range = readonly [number, number]
interface Step { readonly at: number; readonly pose: OwlPose }

// A plain flap twice as often as a stretch or a flutter.
const FLAP_CHOICES = ['flap', 'flap', 'stretch', 'flutter'] as const
// An advance this far past the next change means the Mac slept or the app stalled: skip what was missed and start afresh.
const LATE_MS = 10_000
// Bounds one advance's work even when the options leave no gap between events.
const MAX_STARTS = 1000

export function createOwlSchedule(startMs: number, random: () => number, options: OwlScheduleOptions = {}): OwlSchedule {
  const flapGap = options.flapGapMs ?? [5000, 10000]
  const glanceGap = options.glanceGapMs ?? [2600, 6200]
  const blinkGap = options.blinkGapMs ?? [4000, 9000]
  const between = ([low, high]: Range): number => low + random() * (high - low)
  const pick = <T>(list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))]!

  let queue: Step[] = []
  let pose: OwlPose = REST_POSE
  let look: OwlLook = [0, 0]
  let shownKey = poseKey(REST_POSE)
  let lastNow = startMs
  let flapEnd = startMs
  let nextFlap = 0
  let nextGlance = 0
  let nextBlink = 0

  const begin = (t: number): void => {
    queue = []
    flapEnd = t
    nextFlap = t + between(flapGap)
    nextGlance = t + between([900, 2200])
    nextBlink = t + between([2500, 5000])
  }
  // A flap waits for the one before it to end.
  const flapAt = (): number => Math.max(nextFlap, flapEnd)

  const flap = (t: number): void => {
    let at = t
    queue = []
    for (const step of FLAP_SEQUENCES[pick(FLAP_CHOICES)]) {
      queue.push({ at, pose: step.pose })
      at += step.ms
    }
    queue.push({ at, pose: REST_POSE })
    look = [0, 0]
    flapEnd = at
    nextFlap = t + between(flapGap)
    nextGlance = at + between([1200, 2200])
    nextBlink = Math.max(nextBlink, at + 1200)
  }

  const glance = (t: number): void => {
    let to = pick(LOOK_CHOICES)
    for (let tries = 1; tries < 6 && to[0] === look[0] && to[1] === look[1]; tries++) to = pick(LOOK_CHOICES)
    for (const step of glanceSteps(look, to)) queue.push({ at: t + step.afterMs, pose: step.pose })
    look = to
    nextGlance = t + between(glanceGap)
  }

  const blink = (t: number): void => {
    const { steps, lengthMs } = blinkSteps(look, random() < 0.12)
    for (const step of steps) queue.push({ at: t + step.afterMs, pose: step.pose })
    nextBlink = t + lengthMs + between(blinkGap)
  }

  const nextChange = (): number => queue.length > 0
    ? Math.min(queue[0]!.at, flapAt())
    : Math.min(flapAt(), nextGlance, nextBlink)

  begin(startMs)

  return {
    get nextAt() {
      return Math.max(lastNow, nextChange())
    },
    advance(nowMs) {
      if (nowMs > nextChange() + LATE_MS) {
        begin(nowMs)
        pose = lookPose(look)
      }
      lastNow = nowMs
      // One thing at a time, except a flap: when one is due it cuts in on a glance or a blink at its own planned time.
      for (let starts = 0; starts < MAX_STARTS; starts++) {
        const flapDue = flapAt()
        while (queue.length > 0 && queue[0]!.at <= nowMs && queue[0]!.at < flapDue) pose = queue.shift()!.pose
        if (flapDue <= nowMs) flap(flapDue)
        else if (queue.length > 0) break
        else if (nextGlance <= nowMs) glance(nowMs)
        else if (nextBlink <= nowMs) blink(nowMs)
        else break
      }
      const key = poseKey(pose)
      if (key === shownKey) return null
      shownKey = key
      return pose
    },
  }
}
