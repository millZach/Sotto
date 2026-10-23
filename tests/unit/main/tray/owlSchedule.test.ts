// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { FLAP_SEQUENCES, allOwlPoses, poseKey, type OwlPose } from '../../../../src/main/tray/owl/poses.mjs'
import { createOwlSchedule, type OwlScheduleOptions } from '../../../../src/main/tray/owl/schedule'

// The prototype's seeded random numbers (mulberry32), so a run is the same every time.
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Change { readonly t: number; readonly pose: OwlPose }

/**
 * Runs a schedule on a made-up clock for `minutes`: an advance every 20 ms, and also at `nextAt` when that comes
 * sooner, as the animator's timer would, so each change is seen at its own time.
 */
function simulate(seed: number, minutes: number, options?: OwlScheduleOptions) {
  const schedule = createOwlSchedule(0, seeded(seed), options)
  const changes: Change[] = []
  const end = minutes * 60_000
  let nextAtBehind = 0
  for (let t = 0; t <= end;) {
    const pose = schedule.advance(t)
    if (pose) changes.push({ t, pose })
    if (schedule.nextAt < t) nextAtBehind++
    t = schedule.nextAt > t ? Math.min(t + 20, schedule.nextAt) : t + 20
  }
  return { changes, end, nextAtBehind }
}

const flapStartKeys = new Set(Object.values(FLAP_SEQUENCES).map(sequence => poseKey(sequence[0]!.pose)))
const flapStarts = (changes: readonly Change[]) => changes.filter(change => flapStartKeys.has(poseKey(change.pose))).map(change => change.t)
const gaps = (times: readonly number[]) => times.slice(1).map((t, i) => t - times[i]!)
const flapLength = (name: keyof typeof FLAP_SEQUENCES) => FLAP_SEQUENCES[name].reduce((sum, step) => sum + step.ms, 0)

describe('the menu bar owl schedule', () => {
  it('plays the same run for the same seed and another for another seed', () => {
    const keys = (seed: number) => simulate(seed, 2).changes.map(change => `${change.t}:${poseKey(change.pose)}`)
    expect(keys(7)).toEqual(keys(7))
    expect(keys(7)).not.toEqual(keys(11))
  })

  it('flaps every 5 to 10 s start to start, changes often and never sits still for 8 s, over 200 seeds of 10 minutes', () => {
    const known = new Set(allOwlPoses().map(poseKey))
    const allGaps: number[] = []
    let swaps = 0
    let longestStill = 0
    for (let seed = 1; seed <= 200; seed++) {
      const { changes, end, nextAtBehind } = simulate(seed, 10)
      expect(nextAtBehind).toBe(0)
      let previousKey = poseKey(allOwlPoses()[0]!)
      let previousT = 0
      for (const change of changes) {
        const key = poseKey(change.pose)
        expect(known.has(key)).toBe(true)
        expect(key).not.toBe(previousKey)
        longestStill = Math.max(longestStill, change.t - previousT)
        previousKey = key
        previousT = change.t
      }
      longestStill = Math.max(longestStill, end - previousT)
      const starts = flapStarts(changes)
      expect(starts.length).toBeGreaterThanOrEqual(59)
      expect(starts[0]).toBeGreaterThanOrEqual(5000)
      expect(starts[0]).toBeLessThanOrEqual(10_000)
      allGaps.push(...gaps(starts))
      swaps += changes.length
    }
    expect(Math.min(...allGaps)).toBeGreaterThanOrEqual(5000)
    expect(Math.max(...allGaps)).toBeLessThanOrEqual(10_000)
    expect(longestStill).toBeLessThan(8000)
    const perMinute = swaps / (200 * 10)
    expect(perMinute).toBeGreaterThan(100)
    expect(perMinute).toBeLessThan(220)
  })

  it('plays every flap to its end before the next starts, even with no gap between them', () => {
    const lengths = new Set([flapLength('flap'), flapLength('flutter'), flapLength('stretch')])
    const { changes } = simulate(3, 1, { flapGapMs: [0, 0] })
    const starts = flapStarts(changes)
    expect(starts.length).toBeGreaterThan(40)
    for (const gap of gaps(starts)) expect(lengths.has(gap)).toBe(true)
  })

  it('glances on its own gap, the first one 0.9 to 2.2 s in', () => {
    const { changes } = simulate(5, 1, { flapGapMs: [600_000, 600_000], glanceGapMs: [1000, 1000], blinkGapMs: [600_000, 600_000] })
    // A glance starts with a flared half-step (a far one) or goes straight to a resting look (a near one). The one blink,
    // 2.5 to 5 s in, is over by 6 s and may hold a glance back, so the gaps are counted from there.
    const starts = changes.filter((change, i) => change.pose.lid === 0 && (change.pose.glow === 2 || (i > 0 && changes[i - 1]!.pose.glow !== 2))).map(change => change.t)
    expect(starts[0]).toBeGreaterThanOrEqual(900)
    expect(starts[0]).toBeLessThanOrEqual(2200)
    const later = starts.filter(t => t > 6000)
    expect(later.length).toBeGreaterThan(40)
    for (const gap of gaps(later)) expect(Math.abs(gap - Math.round(gap / 1000) * 1000)).toBeLessThan(1e-6)
  })

  it('blinks on its own gap, once or twice, the first one 2.5 to 5 s in', () => {
    const { changes } = simulate(9, 2, { flapGapMs: [600_000, 600_000], glanceGapMs: [600_000, 600_000], blinkGapMs: [1000, 1000] })
    // A blink starts half shut after a rest of a second or more; the second half of a double one comes 160 ms after the first.
    const starts = changes.filter((change, i) => change.pose.lid === 0.5 && (i === 0 || change.t - changes[i - 1]!.t >= 1000)).map(change => change.t)
    expect(starts[0]).toBeGreaterThanOrEqual(2500)
    expect(starts[0]).toBeLessThanOrEqual(5000)
    const blinkGaps = gaps(starts)
    expect(blinkGaps.length).toBeGreaterThan(50)
    for (const gap of blinkGaps) expect(Math.min(Math.abs(gap - 1320), Math.abs(gap - 1720))).toBeLessThan(1e-6)
    expect(blinkGaps.some(gap => Math.abs(gap - 1720) < 1e-6)).toBe(true)
  })

  it('lets a due flap cut in on a glance or a blink at its own planned time', () => {
    const { changes } = simulate(13, 2, { flapGapMs: [5000, 5000], glanceGapMs: [0, 0], blinkGapMs: [0, 0] })
    const starts = flapStarts(changes)
    expect(starts.length).toBeGreaterThan(20)
    for (const gap of gaps(starts)) expect(gap).toBeCloseTo(5000, 6)
  })

  it('never puts nextAt before the last advance', () => {
    const schedule = createOwlSchedule(1000, seeded(21))
    for (let t = 1000; t < 60_000; t += 333) {
      schedule.advance(t)
      expect(schedule.nextAt).toBeGreaterThanOrEqual(t)
    }
  })

  it('wakes from a 2-hour jump quickly on a known pose and carries on', () => {
    const known = new Set(allOwlPoses().map(poseKey))
    const schedule = createOwlSchedule(0, seeded(17))
    for (let t = 0; t < 7000; t += 20) schedule.advance(t)
    const late = 2 * 60 * 60 * 1000
    const before = performance.now()
    const pose = schedule.advance(late)
    expect(performance.now() - before).toBeLessThan(50)
    if (pose) expect(known.has(poseKey(pose))).toBe(true)
    expect(schedule.nextAt).toBeGreaterThan(late)
    let changed = 0
    for (let t = late; t < late + 15_000; t += 20) if (schedule.advance(t)) changed++
    expect(changed).toBeGreaterThan(5)
  })
})
