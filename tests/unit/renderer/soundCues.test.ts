// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import {
  SoundCuePlayer,
  type CueAudioContext,
  type CueGainNode,
  type CueOscillatorNode,
} from '../../../src/renderer/src/audio/soundCues'
import { deferred } from '../../fixtures/deferred'

function createCueHarness(options: { failStart?: boolean } = {}) {
  const oscillators: CueOscillatorNode[] = []
  const gains: CueGainNode[] = []
  let scheduled: (() => void) | undefined
  const context: CueAudioContext = {
    currentTime: 10,
    destination: {},
    createOscillator: vi.fn(() => {
      const oscillator: CueOscillatorNode = {
        frequency: { setValueAtTime: vi.fn() },
        onended: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: options.failStart
          ? vi.fn(() => {
              throw new Error('audio internals')
            })
          : vi.fn(),
        stop: vi.fn(() => { if (oscillators.length % 2 === 0) scheduled?.() }),
      }
      oscillators.push(oscillator)
      return oscillator
    }),
    createGain: vi.fn(() => {
      const gain: CueGainNode = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        gain: {
          cancelScheduledValues: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          setValueAtTime: vi.fn(),
        },
      }
      gains.push(gain)
      return gain
    }),
    resume: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
  const createContext = vi.fn(() => context)
  return {
    context, createContext, gains, oscillators,
    player: new SoundCuePlayer({ createContext }),
    nextCueScheduled: () => new Promise<void>(resolve => { scheduled = resolve }),
  }
}

describe('SoundCuePlayer', () => {
  it('does nothing when cues are disabled', async () => {
    const createContext = vi.fn()
    const player = new SoundCuePlayer({ enabled: false, createContext })

    await player.prepare()
    await player.playStart()
    await player.playStop()
    player.dispose()

    expect(createContext).not.toHaveBeenCalled()
  })

  it.each([
    ['start', [620, 880]],
    ['stop', [880, 620]],
  ] as const)('plays a short click-free %s pattern and suspends after both tones end', async (kind, frequencies) => {
    const harness = createCueHarness()
    await harness.player.prepare()
    const scheduled = harness.nextCueScheduled()
    const playback = kind === 'start' ? harness.player.playStart() : harness.player.playStop()
    await scheduled

    expect(harness.createContext).toHaveBeenCalledOnce()
    expect(harness.context.resume).toHaveBeenCalledOnce()
    expect(harness.oscillators).toHaveLength(2)
    expect(harness.gains).toHaveLength(2)
    frequencies.forEach((frequency, index) => {
      expect(harness.oscillators[index]?.frequency.setValueAtTime).toHaveBeenCalledWith(
        frequency,
        10 + index * 0.04,
      )
      expect(harness.oscillators[index]?.start).toHaveBeenCalledWith(10 + index * 0.04)
      const stopTime = vi.mocked(harness.oscillators[index]!.stop).mock.calls[0]?.[0]
      expect(stopTime).toBeCloseTo(10 + (index + 1) * 0.04, 10)
      expect(harness.gains[index]?.gain.linearRampToValueAtTime).toHaveBeenCalledTimes(2)
    })
    harness.oscillators[0]!.onended!()
    expect(harness.context.suspend).toHaveBeenCalledOnce()
    harness.oscillators[1]!.onended!()
    await playback
    expect(harness.context.suspend).toHaveBeenCalledTimes(2)
    expect(harness.context.close).not.toHaveBeenCalled()
    for (const oscillator of harness.oscillators) expect(oscillator.disconnect).toHaveBeenCalledOnce()
    for (const gain of harness.gains) expect(gain.disconnect).toHaveBeenCalledOnce()
    harness.player.dispose()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })

  it('prepares one suspended context and reuses it on warm presses, waiting for an idle suspension', async () => {
    const harness = createCueHarness()
    await harness.player.prepare()
    await harness.player.prepare()
    expect(harness.createContext).toHaveBeenCalledOnce()
    expect(harness.context.suspend).toHaveBeenCalledOnce()
    expect(harness.context.resume).not.toHaveBeenCalled()
    expect(harness.oscillators).toHaveLength(0)

    let scheduled = harness.nextCueScheduled()
    const first = harness.player.playStart()
    await scheduled
    const suspended = deferred<void>()
    vi.mocked(harness.context.suspend).mockReturnValueOnce(suspended.promise)
    for (const oscillator of harness.oscillators) oscillator.onended!()
    await first

    scheduled = harness.nextCueScheduled()
    const second = harness.player.playStop()
    expect(harness.createContext).toHaveBeenCalledOnce()
    expect(harness.context.resume).toHaveBeenCalledOnce()
    suspended.resolve()
    await scheduled
    expect(harness.context.resume).toHaveBeenCalledTimes(2)
    for (const oscillator of harness.oscillators.slice(2)) oscillator.onended!()
    await second
    expect(harness.createContext).toHaveBeenCalledOnce()
    harness.player.dispose()
  })

  it('keeps a resuming or overlapping cue alive until the last play ends', async () => {
    const harness = createCueHarness()
    let scheduled = harness.nextCueScheduled()
    const first = harness.player.playStart()
    await scheduled

    const resuming = deferred<void>()
    const resumed = deferred<void>()
    vi.mocked(harness.context.resume).mockImplementationOnce(() => {
      resuming.resolve()
      return resumed.promise
    })
    const second = harness.player.playStop()
    await resuming.promise
    for (const oscillator of harness.oscillators) oscillator.onended!()
    await first
    expect(harness.context.suspend).toHaveBeenCalledOnce()

    scheduled = harness.nextCueScheduled()
    resumed.resolve()
    await scheduled
    scheduled = harness.nextCueScheduled()
    const third = harness.player.playStart()
    await scheduled
    for (const oscillator of harness.oscillators.slice(2, 4)) oscillator.onended!()
    await second
    expect(harness.context.suspend).toHaveBeenCalledOnce()
    for (const oscillator of harness.oscillators.slice(4)) oscillator.onended!()
    await third
    expect(harness.context.suspend).toHaveBeenCalledTimes(2)
    harness.player.dispose()
  })

  it('closes once and releases overlapping playback on disposal without waiting for ended events', async () => {
    const harness = createCueHarness()
    let scheduled = harness.nextCueScheduled()
    const first = harness.player.playStart()
    await scheduled
    scheduled = harness.nextCueScheduled()
    const second = harness.player.playStop()
    await scheduled
    harness.player.dispose()
    harness.player.dispose()
    await Promise.all([first, second, harness.player.prepare(), harness.player.playStart()])

    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.context.suspend).toHaveBeenCalledOnce()
    expect(harness.createContext).toHaveBeenCalledOnce()
    expect(harness.oscillators).toHaveLength(4)
    for (const oscillator of harness.oscillators) {
      expect(oscillator.disconnect).toHaveBeenCalledOnce()
      expect(oscillator.onended).toBeNull()
    }
    for (const gain of harness.gains) expect(gain.disconnect).toHaveBeenCalledOnce()
  })

  it.each(['prepare', 'resume'] as const)('does not schedule tones after disposal during %s', async phase => {
    const harness = createCueHarness()
    const entered = deferred<void>()
    const pending = deferred<void>()
    vi.mocked(harness.context[phase === 'prepare' ? 'suspend' : 'resume']).mockImplementationOnce(() => {
      entered.resolve()
      return pending.promise
    })
    const playback = harness.player.playStart()
    await entered.promise
    harness.player.dispose()
    pending.resolve()
    await playback
    expect(harness.oscillators).toHaveLength(0)
    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.context.suspend).toHaveBeenCalledOnce()
  })

  it('disconnects partial resources and retires the context when Web Audio throws', async () => {
    const harness = createCueHarness({ failStart: true })

    await expect(harness.player.playStart()).resolves.toBeUndefined()

    expect(harness.oscillators[0]?.disconnect).toHaveBeenCalledOnce()
    expect(harness.gains[0]?.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
    harness.player.dispose()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['suspend', 'throw'], ['suspend', 'reject'],
    ['resume', 'throw'], ['resume', 'reject'],
  ] as const)('closes a context when %s will %s and rebuilds for the next cue without disposal', async (method, outcome) => {
    const harness = createCueHarness()
    vi.mocked(harness.context[method]).mockImplementationOnce(() => {
      if (outcome === 'throw') throw new Error('context unavailable')
      return Promise.reject(new Error('context unavailable'))
    })
    if (method === 'suspend') await harness.player.prepare()
    else await harness.player.playStart()
    expect(harness.context.close).toHaveBeenCalledOnce()

    const next = createCueHarness()
    harness.createContext.mockReturnValue(next.context)
    const scheduled = next.nextCueScheduled()
    const playback = harness.player.playStop()
    await scheduled
    expect(harness.createContext).toHaveBeenCalledTimes(2)
    expect(next.context.resume).toHaveBeenCalledOnce()
    for (const oscillator of next.oscillators) oscillator.onended!()
    await playback
    expect(next.context.suspend).toHaveBeenCalledTimes(2)
    harness.player.dispose()
  })

  it('retires a failed idle suspension before a waiting cue can reuse the context', async () => {
    const harness = createCueHarness()
    const scheduled = harness.nextCueScheduled()
    const first = harness.player.playStart()
    await scheduled
    const suspended = deferred<void>()
    vi.mocked(harness.context.suspend).mockReturnValueOnce(suspended.promise)
    for (const oscillator of harness.oscillators) oscillator.onended!()
    await first

    const waiting = harness.player.playStop()
    suspended.reject(new Error('suspend failed'))
    await waiting
    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(harness.context.resume).toHaveBeenCalledOnce()

    const next = createCueHarness()
    harness.createContext.mockReturnValue(next.context)
    const nextScheduled = next.nextCueScheduled()
    const playback = harness.player.playStart()
    await nextScheduled
    for (const oscillator of next.oscillators) oscillator.onended!()
    await playback
    harness.player.dispose()
  })

  it('releases retired playback and keeps a replacement safe from an older pending resume failure', async () => {
    const harness = createCueHarness()
    const scheduled = harness.nextCueScheduled()
    const first = harness.player.playStart()
    await scheduled
    const resuming = deferred<void>()
    const resumed = deferred<void>()
    vi.mocked(harness.context.resume).mockImplementationOnce(() => {
      resuming.resolve()
      return resumed.promise
    }).mockRejectedValueOnce(new Error('context closed'))
    const older = harness.player.playStop()
    await resuming.promise
    await harness.player.playStart()
    await first
    expect(harness.context.close).toHaveBeenCalledOnce()
    for (const oscillator of harness.oscillators) expect(oscillator.disconnect).toHaveBeenCalledOnce()

    const next = createCueHarness()
    harness.createContext.mockReturnValue(next.context)
    const nextScheduled = next.nextCueScheduled()
    const playback = harness.player.playStop()
    await nextScheduled
    resumed.reject(new Error('old resume failed late'))
    await older
    expect(harness.context.close).toHaveBeenCalledOnce()
    expect(next.context.close).not.toHaveBeenCalled()
    expect(next.context.suspend).toHaveBeenCalledOnce()
    for (const oscillator of next.oscillators) oscillator.onended!()
    await playback
    expect(next.context.suspend).toHaveBeenCalledTimes(2)
    harness.player.dispose()
  })

  it('contains a rejected close while retiring a failed context', async () => {
    const harness = createCueHarness()
    vi.mocked(harness.context.resume).mockRejectedValueOnce(new Error('resume failed'))
    vi.mocked(harness.context.close).mockRejectedValueOnce(new Error('close failed'))
    await expect(harness.player.playStart()).resolves.toBeUndefined()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })
})
