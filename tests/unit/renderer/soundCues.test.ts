import { describe, expect, it, vi } from 'vitest'

import {
  SoundCuePlayer,
  type CueAudioContext,
  type CueGainNode,
  type CueOscillatorNode,
} from '../../../src/renderer/src/audio/soundCues'

function createCueHarness(options: { failStart?: boolean } = {}) {
  const oscillators: CueOscillatorNode[] = []
  const gains: CueGainNode[] = []
  const context: CueAudioContext = {
    currentTime: 10,
    destination: {},
    createOscillator: vi.fn(() => {
      const oscillator: CueOscillatorNode = {
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: options.failStart
          ? vi.fn(() => {
              throw new Error('audio internals')
            })
          : vi.fn(),
        stop: vi.fn(),
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
    close: vi.fn(async () => undefined),
  }
  const wait = vi.fn(async () => undefined)
  return { context, gains, oscillators, player: new SoundCuePlayer({ createContext: () => context, wait }) , wait }
}

describe('SoundCuePlayer', () => {
  it('does nothing when cues are disabled', async () => {
    const createContext = vi.fn()
    const player = new SoundCuePlayer({ enabled: false, createContext })

    await player.playStart()
    await player.playStop()

    expect(createContext).not.toHaveBeenCalled()
  })

  it.each([
    ['start', [620, 880]],
    ['stop', [880, 620]],
  ] as const)('plays a short click-free %s two-tone pattern', async (kind, frequencies) => {
    const harness = createCueHarness()

    await (kind === 'start' ? harness.player.playStart() : harness.player.playStop())

    expect(harness.oscillators).toHaveLength(2)
    expect(harness.gains).toHaveLength(2)
    expect(harness.wait).toHaveBeenCalledWith(80)
    frequencies.forEach((frequency, index) => {
      expect(harness.oscillators[index]?.frequency.setValueAtTime).toHaveBeenCalledWith(
        frequency,
        10 + index * 0.04,
      )
      expect(harness.oscillators[index]?.start).toHaveBeenCalledWith(10 + index * 0.04)
      const stopTime = vi.mocked(harness.oscillators[index]!.stop).mock.calls[0]?.[0]
      expect(stopTime).toBeCloseTo(10 + (index + 1) * 0.04, 10)
      expect(harness.gains[index]?.gain.linearRampToValueAtTime).toHaveBeenCalledTimes(2)
      expect(harness.oscillators[index]?.disconnect).toHaveBeenCalledOnce()
      expect(harness.gains[index]?.disconnect).toHaveBeenCalledOnce()
    })
    expect(harness.context.close).toHaveBeenCalledOnce()
  })

  it('closes and disconnects partial resources when Web Audio throws', async () => {
    const harness = createCueHarness({ failStart: true })

    await expect(harness.player.playStart()).resolves.toBeUndefined()

    expect(harness.oscillators[0]?.disconnect).toHaveBeenCalledOnce()
    expect(harness.gains[0]?.disconnect).toHaveBeenCalledOnce()
    expect(harness.context.close).toHaveBeenCalledOnce()
  })
})
