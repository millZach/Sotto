import { afterEach, expect, it, vi } from 'vitest'
import { SPEAKING_HOLD_MS, SpeakingGate } from '../../../../src/renderer/src/audio/speakingGate'

afterEach(() => { vi.useRealTimers() })

function gate(): { gate: SpeakingGate; changes: boolean[] } {
  const changes: boolean[] = []
  return { gate: new SpeakingGate(speaking => changes.push(speaking)), changes }
}

it('opens on a voice at once, holds inside the band, and closes only after the hold of quiet', () => {
  vi.useFakeTimers()
  const { gate: speaking, changes } = gate()
  // A silence-floor level never opens it.
  speaking.feed(0.004)
  expect(speaking.speaking).toBe(false)

  speaking.feed(0.06)
  expect(changes).toEqual([true])

  // Inside the hysteresis band the gate simply holds; nothing is scheduled.
  speaking.feed(0.015)
  vi.advanceTimersByTime(5_000)
  expect(speaking.speaking).toBe(true)
  expect(vi.getTimerCount()).toBe(0)

  // Below the release threshold it still rides out the hold, so a gap between words keeps it open, and a real pause
  // closes it.
  speaking.feed(0.004)
  vi.advanceTimersByTime(300)
  expect(speaking.speaking).toBe(true)
  vi.advanceTimersByTime(SPEAKING_HOLD_MS - 300)
  expect(changes).toEqual([true, false])
})

it('lets a voiced frame inside the hold cancel the close, and never restarts a pending close', () => {
  vi.useFakeTimers()
  const { gate: speaking, changes } = gate()
  speaking.feed(0.05)
  speaking.feed(0)
  vi.advanceTimersByTime(200)
  speaking.feed(0.05)
  vi.advanceTimersByTime(5_000)
  expect(changes).toEqual([true])

  // The hold measures from the first quiet frame: more quiet frames do not push the close back.
  speaking.feed(0)
  vi.advanceTimersByTime(200)
  speaking.feed(0)
  vi.advanceTimersByTime(SPEAKING_HOLD_MS - 200)
  expect(changes).toEqual([true, false])
})

it('clamps out-of-range and non-finite levels rather than trusting them raw', () => {
  vi.useFakeTimers()
  const { gate: speaking, changes } = gate()
  speaking.feed(2)
  expect(speaking.speaking).toBe(true)
  speaking.feed(Number.NaN)
  vi.advanceTimersByTime(SPEAKING_HOLD_MS)
  expect(changes).toEqual([true, false])
})

it('stays open while held, and drops a pending close when disposed', () => {
  vi.useFakeTimers()
  const { gate: speaking, changes } = gate()
  speaking.feed(0, true)
  vi.advanceTimersByTime(5_000)
  expect(changes).toEqual([true])
  speaking.feed(0)
  expect(vi.getTimerCount()).toBe(1)
  speaking.dispose()
  expect(vi.getTimerCount()).toBe(0)
  expect(speaking.speaking).toBe(true)
})
