// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { TrayOwlAnimator, type OwlEvent, type OwlTimers } from '../../../../src/main/tray/owl/animator'
import type { OwlSchedule } from '../../../../src/main/tray/owl/schedule'
import { allOwlPoses, type OwlPose } from '../../../../src/main/tray/owl/poses.mjs'
import type { MenuBarOwlBody, MenuBarOwlEyes } from '../../../../src/shared/menuBarOwl'

const POSES = allOwlPoses()

/** A clock that only moves when the test says so; it keeps every timer set and not cleared. */
class FakeTimers implements OwlTimers {
  time = 1000
  private nextId = 1
  readonly pending = new Map<number, { callback: () => void; at: number }>()
  set(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++
    this.pending.set(id, { callback, at: this.time + delayMs })
    return id
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number)
  }
  now(): number {
    return this.time
  }
  /** Moves the clock to the earliest timer (or `lateBy` ms past it) and fires it. */
  fireNext(lateBy = 0): void {
    const [id, timer] = [...this.pending].sort((a, b) => a[1].at - b[1].at)[0]!
    this.pending.delete(id)
    this.time = Math.max(this.time, timer.at + lateBy)
    timer.callback()
  }
}

/** A schedule that plays a fixed list of [ms after start, pose index]. */
function scriptedSchedule(script: readonly (readonly [number, number])[]) {
  const made: { startMs: number; advances: number[] }[] = []
  const create = (startMs: number): OwlSchedule => {
    const record = { startMs, advances: [] as number[] }
    made.push(record)
    let next = 0
    let last = 0
    return {
      get nextAt() { return next < script.length ? startMs + script[next]![0] : Number.POSITIVE_INFINITY },
      advance(nowMs: number): OwlPose | null {
        record.advances.push(nowMs)
        let index = last
        while (next < script.length && startMs + script[next]![0] <= nowMs) index = script[next++]![1]
        if (index === last) return null
        last = index
        return POSES[index]!
      },
    }
  }
  return { create, made }
}

type Look = `${MenuBarOwlBody}-${MenuBarOwlEyes}`

function setup(options: { reducedMotion?: boolean; script?: readonly (readonly [number, number])[]; broken?: readonly Look[] } = {}) {
  const timers = new FakeTimers()
  const schedule = scriptedSchedule(options.script ?? [[100, 5], [200, 9], [300, 0], [400, 5]])
  const shown: string[] = []
  const events: OwlEvent[] = []
  const broken = new Set<string>(options.broken ?? [])
  const animator = new TrayOwlAnimator<string>({
    setImage: image => shown.push(image),
    frames: (body, eyes) => {
      if (broken.has(`${body}-${eyes}`)) throw new Error('missing')
      return POSES.map((_, i) => `${body}-${eyes}#${i}`)
    },
    timers,
    random: () => 0.5,
    log: event => events.push(event),
    createSchedule: schedule.create,
  }, { body: 'slate', eyes: 'teal', reducedMotion: options.reducedMotion ?? false })
  return { animator, timers, schedule, shown, events, broken }
}

describe('the menu bar owl animator', () => {
  it('shows the rest frame, then each change from one timer at a time', () => {
    const { animator, timers, shown, events } = setup()
    expect(animator.start()).toBe(true)
    expect(events).toEqual(['owl-started'])
    expect(shown).toEqual(['slate-teal#0'])
    for (let i = 0; i < 4; i += 1) {
      expect(timers.pending.size).toBe(1)
      timers.fireNext()
    }
    expect(shown).toEqual(['slate-teal#0', 'slate-teal#5', 'slate-teal#9', 'slate-teal#0', 'slate-teal#5'])
    expect(timers.pending.size).toBe(0)
  })

  it('sets the image only when the frame changes', () => {
    const { animator, timers, shown } = setup({ script: [[100, 5], [200, 5], [300, 0], [400, 0]] })
    animator.start()
    while (timers.pending.size > 0) timers.fireNext()
    expect(shown).toEqual(['slate-teal#0', 'slate-teal#5', 'slate-teal#0'])
  })

  it('advances with the real time when a timer fires late', () => {
    const { animator, timers, schedule, shown } = setup()
    animator.start()
    timers.fireNext(150)
    expect(schedule.made[0]!.advances).toEqual([1250])
    expect(shown).toEqual(['slate-teal#0', 'slate-teal#9'])
    expect([...timers.pending.values()].map(timer => timer.at)).toEqual([1300])
    timers.fireNext()
    expect(schedule.made[0]!.advances).toEqual([1250, 1300])
    expect(shown).toEqual(['slate-teal#0', 'slate-teal#9', 'slate-teal#0'])
  })

  it('returns false and logs when the frames cannot load', () => {
    const { animator, timers, shown, events } = setup({ broken: ['slate-teal'] })
    expect(animator.start()).toBe(false)
    expect(events).toEqual(['owl-frames-unavailable'])
    expect(shown).toEqual([])
    expect(timers.pending.size).toBe(0)
  })

  it('sits still on the rest frame with no timer under reduced motion, and toggles', () => {
    const { animator, timers, schedule, shown } = setup({ reducedMotion: true })
    expect(animator.start()).toBe(true)
    expect(shown).toEqual(['slate-teal#0'])
    expect(timers.pending.size).toBe(0)
    animator.setReducedMotion(false)
    expect(timers.pending.size).toBe(1)
    timers.fireNext()
    expect(shown).toEqual(['slate-teal#0', 'slate-teal#5'])
    animator.setReducedMotion(true)
    expect(timers.pending.size).toBe(0)
    expect(shown).toEqual(['slate-teal#0', 'slate-teal#5', 'slate-teal#0'])
    expect(schedule.made).toHaveLength(1)
  })

  it('pauses keeping the image and resumes with a fresh schedule', () => {
    const { animator, timers, schedule, shown } = setup()
    animator.start()
    timers.fireNext()
    animator.setPaused(true)
    expect(timers.pending.size).toBe(0)
    expect(shown).toEqual(['slate-teal#0', 'slate-teal#5'])
    timers.time += 60_000
    animator.setPaused(false)
    expect(schedule.made.map(made => made.startMs)).toEqual([1000, 61_100])
    expect(shown.at(-1)).toBe('slate-teal#0')
    expect(timers.pending.size).toBe(1)
    timers.fireNext()
    expect(schedule.made[1]!.advances).toEqual([61_200])
    expect(shown.at(-1)).toBe('slate-teal#5')
  })

  it('swaps the frame set and re-shows the current frame', () => {
    const { animator, timers, shown } = setup()
    animator.start()
    timers.fireNext()
    expect(animator.setLook('ink', 'amber')).toBe(true)
    expect(shown.at(-1)).toBe('ink-amber#5')
    expect(timers.pending.size).toBe(1)
    timers.fireNext()
    expect(shown.at(-1)).toBe('ink-amber#9')
  })

  it('keeps the old set when the new one cannot load', () => {
    const { animator, timers, shown, events } = setup({ broken: ['light-ice'] })
    animator.start()
    timers.fireNext()
    expect(animator.setLook('light', 'ice')).toBe(false)
    expect(events).toEqual(['owl-started', 'owl-frames-unavailable'])
    expect(shown).toEqual(['slate-teal#0', 'slate-teal#5'])
    timers.fireNext()
    expect(shown.at(-1)).toBe('slate-teal#9')
  })

  it('plays the real schedule with one timer at a time and no repeated frame', () => {
    const timers = new FakeTimers()
    const shown: number[] = []
    let seed = 7
    const animator = new TrayOwlAnimator<number>({
      setImage: image => shown.push(image),
      frames: () => POSES.map((_, i) => i),
      timers,
      random: () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647,
    }, { body: 'slate', eyes: 'teal', reducedMotion: false })
    animator.start()
    while (timers.time < 1000 + 60_000) {
      expect(timers.pending.size).toBe(1)
      timers.fireNext()
    }
    expect(shown.length).toBeGreaterThan(50)
    expect(shown.every((frame, i) => i === 0 || frame !== shown[i - 1])).toBe(true)
    animator.dispose()
  })

  it('clears the timer on dispose and ignores everything after it', () => {
    const { animator, timers, shown, events } = setup()
    animator.start()
    const { callback } = [...timers.pending.values()][0]!
    animator.dispose()
    animator.dispose()
    expect(timers.pending.size).toBe(0)
    expect(events).toEqual(['owl-started', 'owl-stopped'])
    timers.time += 5000
    callback()
    animator.setLook('ink', 'amber')
    animator.setReducedMotion(true)
    animator.setPaused(true)
    animator.setPaused(false)
    expect(animator.start()).toBe(false)
    expect(shown).toEqual(['slate-teal#0'])
    expect(timers.pending.size).toBe(0)
  })
})

describe('the animator survives a bad tray and a bad schedule', () => {
  it('stops for good, without throwing, when setImage throws', () => {
    const timers = new FakeTimers()
    let calls = 0
    const animator = new TrayOwlAnimator<string>({
      setImage: () => { calls += 1; if (calls > 1) throw new Error('tray destroyed') },
      frames: () => POSES.map((_, i) => `f#${i}`),
      timers,
      random: () => 0.5,
      createSchedule: scriptedSchedule([[100, 5], [200, 9]]).create,
    }, { body: 'slate', eyes: 'teal', reducedMotion: false })
    expect(animator.start()).toBe(true)
    expect(timers.pending.size).toBe(1)
    expect(() => timers.fireNext()).not.toThrow()
    expect(timers.pending.size).toBe(0)
    expect(animator.start()).toBe(false)
  })

  it('fails the start, with no timer and no start event, when the tray refuses the first picture', () => {
    const timers = new FakeTimers()
    const events: OwlEvent[] = []
    const animator = new TrayOwlAnimator<string>({
      setImage: () => { throw new Error('tray destroyed') },
      frames: () => POSES.map((_, i) => `f#${i}`),
      timers,
      log: event => events.push(event),
      createSchedule: scriptedSchedule([[100, 5]]).create,
    }, { body: 'slate', eyes: 'teal', reducedMotion: false })
    expect(animator.start()).toBe(false)
    expect(timers.pending.size).toBe(0)
    expect(events).toEqual(['owl-failed', 'owl-stopped'])
  })

  it('says a change of colours failed when the tray refuses the new picture', () => {
    let refuse = false
    const animator = new TrayOwlAnimator<string>({
      setImage: () => { if (refuse) throw new Error('tray destroyed') },
      frames: (body, eyes) => POSES.map((_, i) => `${body}-${eyes}#${i}`),
      timers: new FakeTimers(),
      createSchedule: scriptedSchedule([[100, 5]]).create,
    }, { body: 'slate', eyes: 'teal', reducedMotion: false })
    expect(animator.start()).toBe(true)
    refuse = true
    expect(animator.setLook('ink', 'amber')).toBe(false)
  })

  it('sets no timer when the tray refuses the rest frame as it resumes', () => {
    const timers = new FakeTimers()
    let refuse = false
    const animator = new TrayOwlAnimator<string>({
      setImage: () => { if (refuse) throw new Error('tray destroyed') },
      frames: () => POSES.map((_, i) => `f#${i}`),
      timers,
      createSchedule: scriptedSchedule([[100, 5], [200, 0]]).create,
    }, { body: 'slate', eyes: 'teal', reducedMotion: false })
    animator.start()
    timers.fireNext()
    animator.setPaused(true)
    refuse = true
    animator.setPaused(false)
    expect(timers.pending.size).toBe(0)
  })

  it('stops for good, without throwing, when the schedule throws', () => {
    const timers = new FakeTimers()
    const events: OwlEvent[] = []
    const animator = new TrayOwlAnimator<string>({
      setImage: () => undefined,
      frames: () => POSES.map((_, i) => `f#${i}`),
      timers,
      log: event => events.push(event),
      createSchedule: () => ({ nextAt: timers.time + 50, advance() { throw new Error('bug') } }),
    }, { body: 'ink', eyes: 'amber', reducedMotion: false })
    expect(animator.start()).toBe(true)
    expect(() => timers.fireNext()).not.toThrow()
    expect(timers.pending.size).toBe(0)
    expect(events).toEqual(['owl-started', 'owl-failed', 'owl-stopped'])
  })

  it('never sets a timer for no time at all', () => {
    const timers = new FakeTimers()
    const delays: number[] = []
    const set = timers.set.bind(timers)
    timers.set = (callback, delay) => { delays.push(delay); return set(callback, delay) }
    const animator = new TrayOwlAnimator<string>({
      setImage: () => undefined,
      frames: () => POSES.map((_, i) => `f#${i}`),
      timers,
      createSchedule: () => ({ nextAt: timers.time - 500, advance: () => null }),
    }, { body: 'slate', eyes: 'teal', reducedMotion: false })
    animator.start()
    expect(delays).toEqual([1])
  })

  it('stays still when it resumes from a pause while reduced motion is on, and the other way round', () => {
    const { animator, timers, shown } = setup({ reducedMotion: true })
    animator.start()
    animator.setPaused(true)
    animator.setPaused(false)
    expect(timers.pending.size).toBe(0)
    animator.setReducedMotion(false)
    expect(timers.pending.size).toBe(1)
    animator.setPaused(true)
    animator.setReducedMotion(true)
    animator.setReducedMotion(false)
    expect(timers.pending.size).toBe(0)
    animator.setPaused(false)
    expect(timers.pending.size).toBe(1)
    expect(new Set(shown).size).toBe(1)
  })
})
