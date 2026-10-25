// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { MainLoopMonitor, MainLoopWindow, SAMPLE_INTERVAL_MS, type MainLoopClock } from '../../../src/main/performance/mainLoopMonitor'
import { mainFreezeNoticeVisible, blockedPercent, freezeLength, type MainActivityState } from '../../../src/shared/mainActivity'

function fakeClock(start = 1_000_000): MainLoopClock & { at: number; set: (value: number) => void; callback: (() => void) | null } {
  const clock = {
    at: start,
    callback: null as (() => void) | null,
    now: () => clock.at,
    set: (value: number) => { clock.at = value },
    setInterval: (callback: () => void) => { clock.callback = callback; return { unref: () => undefined } },
    clearInterval: () => { clock.callback = null },
  }
  return clock
}

describe('MainLoopWindow', () => {
  it('sums blocked time over the last minute and reads it as a share of the whole minute', () => {
    const window = new MainLoopWindow(60)
    window.record(10_000, 0)
    window.record(10_500, 250)
    window.record(11_900, 400)
    const reading = window.reading(11_900)
    expect(reading.blockedShare).toBeCloseTo(650 / 60_000)
    expect(reading.bars).toHaveLength(60)
    // The 250 ms block sat inside second 10; the 400 ms one ended at 11.9 s, inside second 11.
    expect(reading.bars.slice(-2)).toEqual([250, 400])
    expect(reading.longestFreezeMs).toBe(400)
    expect(reading.freezesOver100ms).toBe(2)
    expect(reading.frozen).toBe(false)
  })

  it('spreads a long freeze over the seconds it spanned, and counts it once', () => {
    const window = new MainLoopWindow(60)
    window.record(20_000, 0)
    window.record(21_900, 1_900)
    const reading = window.reading(21_900)
    // The bars are the minute's seconds counted back from now: 20.9 s to 21.9 s, and 19.9 s to 20.9 s before it.
    expect(reading.bars.slice(-2)).toEqual([900, 1_000])
    expect(reading.freezesOver100ms).toBe(1)
    expect(reading.longestFreezeMs).toBe(1_900)
  })

  it('does not count a stall under 100 ms as a freeze, though it counts as blocked', () => {
    const window = new MainLoopWindow(60)
    window.record(5_000, 0)
    window.record(5_500, 99)
    const reading = window.reading(5_500)
    expect(reading.freezesOver100ms).toBe(0)
    expect(reading.bars.at(-1)).toBe(99)
  })

  it('forgets seconds that fall out of the minute, and clears seconds that passed with no sample', () => {
    const window = new MainLoopWindow(60)
    window.record(1_000, 0)
    window.record(1_800, 800)
    expect(window.reading(1_800).blockedShare).toBeCloseTo(800 / 60_000)
    expect(window.reading(60_999).blockedShare).toBeCloseTo(800 / 60_000)
    // At 61 s the window still starts at 1 s, so the block from 1 s to 1.8 s is in it.
    expect(window.reading(61_000).blockedShare).toBeCloseTo(800 / 60_000)
    expect(window.reading(62_000).blockedShare).toBe(0)
    expect(window.reading(62_000).longestFreezeMs).toBe(0)
    expect(window.reading(62_000).freezesOver100ms).toBe(0)
    // A long gap clears the whole window rather than looping over every missed second.
    window.record(10_000_000, 300)
    expect(window.reading(10_000_000).bars.reduce((sum, bar) => sum + bar, 0)).toBe(300)
  })

  it('is frozen only when blocked for more than half the minute', () => {
    const half = new MainLoopWindow(60)
    half.record(0, 0)
    for (let second = 1; second <= 30; second += 1) half.record(second * 1_000, 1_000)
    // Exactly 30 s of 60: not more than half.
    expect(half.reading(30_000).blockedShare).toBe(0.5)
    expect(half.frozen(30_000)).toBe(false)
    half.record(30_500, 1)
    expect(half.frozen(30_500)).toBe(true)
  })

  it('holds exactly the last minute: a 31-second block ending at 31 s is still more than half of it at 60 s', () => {
    const window = new MainLoopWindow(60)
    window.record(0, 0)
    for (let second = 1; second <= 31; second += 1) window.record(second * 1_000, 1_000)
    for (let second = 32; second <= 60; second += 1) window.record(second * 1_000, 0)
    // From 0 s to 60 s, 31 s were blocked.
    expect(window.reading(60_000).blockedShare).toBeCloseTo(31 / 60)
    expect(window.frozen(60_000)).toBe(true)
    // Half a second on, the window starts at 0.5 s: 30.5 s blocked, still more than half.
    expect(window.reading(60_500).blockedShare).toBeCloseTo(30.5 / 60)
    expect(window.frozen(60_500)).toBe(true)
    // From 1 s to 61 s, 30 s were blocked: exactly half, not frozen.
    expect(window.reading(61_000).blockedShare).toBeCloseTo(0.5)
    expect(window.frozen(61_000)).toBe(false)
  })

  it('reads exactly 30 s blocked as not frozen, with no second averaged', () => {
    // At 60.5 s the window is 0.5 s to 60.5 s. Blocked 0 to 0.5 s (outside it) and 1 s to 31 s: exactly 30 s inside.
    const window = new MainLoopWindow(60)
    window.record(0, 0)
    window.record(500, 500)
    window.record(31_000, 30_000)
    expect(window.reading(60_500).blockedShare).toBe(0.5)
    expect(window.frozen(60_500)).toBe(false)
  })

  it('reads a true 30.2 s blocked as frozen, with no second averaged', () => {
    // At 60.5 s the window is 0.5 s to 60.5 s. Blocked 0.5 s to 1 s and 1 s to 30.7 s: 30.2 s inside.
    const window = new MainLoopWindow(60)
    window.record(0, 0)
    window.record(1_000, 500)
    window.record(30_700, 29_700)
    expect(window.reading(60_500).blockedShare).toBeCloseTo(30.2 / 60, 10)
    expect(window.frozen(60_500)).toBe(true)
  })

  it('shows in the chart and the freeze figures every freeze the blocked share counts', () => {
    // A 400 ms freeze from 0.1 s to 0.5 s, read at 60 s: the window is 0 s to 60 s, so all of it is inside.
    const window = new MainLoopWindow(60)
    window.record(0, 0)
    window.record(500, 400)
    for (let second = 1; second <= 60; second += 1) window.record(second * 1_000, 0)
    const reading = window.reading(60_000)
    expect(reading.blockedShare).toBeCloseTo(400 / 60_000)
    expect(reading.bars).toHaveLength(60)
    expect(reading.bars[0]).toBe(400)
    expect(reading.bars.reduce((sum, bar) => sum + bar, 0)).toBe(400)
    expect(reading.longestFreezeMs).toBe(400)
    expect(reading.freezesOver100ms).toBe(1)
  })

  it('counts a freeze partly outside the minute for its part inside, in the bars, the longest freeze and the count', () => {
    const window = new MainLoopWindow(60)
    window.record(0, 0)
    window.record(2_000, 1_500)
    // At 61.6 s the window starts at 1.6 s: 400 ms of the 1.5 s freeze is inside it.
    let reading = window.reading(61_600)
    expect(reading.blockedShare).toBeCloseTo(400 / 60_000)
    expect(reading.bars[0]).toBe(400)
    expect(reading.longestFreezeMs).toBe(400)
    expect(reading.freezesOver100ms).toBe(1)
    // At 61.95 s only 50 ms is inside: still blocked time, no longer a freeze of 100 ms or more.
    reading = window.reading(61_950)
    expect(reading.bars[0]).toBe(50)
    expect(reading.longestFreezeMs).toBe(50)
    expect(reading.freezesOver100ms).toBe(0)
  })

  it('keeps every stretch of a minute of late samples, however many there are', () => {
    const window = new MainLoopWindow(60)
    window.record(0, 0)
    // Ten samples a second, each 50 ms late: 600 stretches, more than the window's first room.
    for (let sample = 1; sample <= 600; sample += 1) window.record(sample * 100, 50)
    expect(window.reading(60_000).blockedShare).toBeCloseTo(0.5)
    expect(window.reading(60_000).bars.every(bar => bar === 500)).toBe(true)
    expect(window.reading(90_000).blockedShare).toBeCloseTo(0.25)
  })

  it('never reads a bucket above a whole second, however blocks overlap', () => {
    const window = new MainLoopWindow(4)
    window.record(1_000, 0)
    window.record(1_900, 900)
    window.record(1_950, 900)
    expect(Math.max(...window.reading(1_950).bars)).toBeLessThanOrEqual(1_000)
  })
})

describe('MainLoopMonitor', () => {
  it('counts how late each sample ran, ignoring the timer\'s own jitter', () => {
    const clock = fakeClock()
    const monitor = new MainLoopMonitor({ clock, onFrozenChange: () => undefined })
    monitor.start()
    expect(monitor.running).toBe(true)
    clock.set(clock.at + SAMPLE_INTERVAL_MS + 1); monitor.sample()
    expect(monitor.reading().bars.reduce((sum, bar) => sum + bar, 0)).toBe(0)
    clock.set(clock.at + SAMPLE_INTERVAL_MS + 300); monitor.sample()
    const reading = monitor.reading()
    expect(reading.longestFreezeMs).toBe(300)
    expect(reading.freezesOver100ms).toBe(1)
    monitor.stop()
    expect(monitor.running).toBe(false)
    expect(clock.callback).toBeNull()
  })

  it('says when main freezes and when it recovers, once each', () => {
    const clock = fakeClock(0)
    const changes: boolean[] = []
    const monitor = new MainLoopMonitor({ clock, windowSeconds: 4, onFrozenChange: frozen => changes.push(frozen) })
    monitor.start()
    // Three seconds of a four-second window blocked.
    for (let step = 0; step < 3; step += 1) { clock.set(clock.at + SAMPLE_INTERVAL_MS + 1_000); monitor.sample() }
    expect(monitor.isFrozen()).toBe(true)
    // Quiet seconds roll the blocked ones out of the window.
    for (let step = 0; step < 120; step += 1) { clock.set(clock.at + SAMPLE_INTERVAL_MS); monitor.sample() }
    expect(monitor.isFrozen()).toBe(false)
    expect(changes).toEqual([true, false])
  })

  it('asks for its timer to be unreferenced, so it never keeps Sotto running', () => {
    const unref = vi.fn()
    const clock = { ...fakeClock(), setInterval: () => ({ unref }) }
    new MainLoopMonitor({ clock, onFrozenChange: () => undefined }).start()
    expect(unref).toHaveBeenCalledOnce()
  })
})

describe('the notice\'s answer', () => {
  const reading = { blockedShare: 0.7, longestFreezeMs: 1_900, freezesOver100ms: 23, bars: [], frozen: true }
  const state = (patch: Partial<MainActivityState>): MainActivityState => ({ reading, recording: { phase: 'idle' }, noticeHidden: false, ...patch })

  it('shows while frozen, unless Not now hid it or the setting is off', () => {
    expect(mainFreezeNoticeVisible(null, true)).toBe(false)
    expect(mainFreezeNoticeVisible(state({}), true)).toBe(true)
    expect(mainFreezeNoticeVisible(state({ noticeHidden: true }), true)).toBe(false)
    expect(mainFreezeNoticeVisible(state({}), false)).toBe(false)
    expect(mainFreezeNoticeVisible(state({ reading: { ...reading, frozen: false } }), true)).toBe(false)
  })

  it('shows a running or saved recording whatever the freeze and the setting say', () => {
    const calm = { ...reading, frozen: false }
    expect(mainFreezeNoticeVisible(state({ reading: calm, recording: { phase: 'recording', startedAt: 1, durationMs: 60_000 } }), false)).toBe(true)
    expect(mainFreezeNoticeVisible(state({ reading: calm, recording: { phase: 'saved', name: 'n', folder: 'f', files: ['main.cpuprofile'], bytes: 1, windowRecorded: true } }), false)).toBe(true)
  })

  it('says the numbers the way the mock-up does', () => {
    expect(blockedPercent(0.7)).toBe('70%')
    expect(blockedPercent(0.001)).toBe('under 1%')
    expect(blockedPercent(0)).toBe('0%')
    expect(freezeLength(90)).toBe('90 ms')
    expect(freezeLength(1_940)).toBe('1.9 s')
  })
})
