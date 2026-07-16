export interface CueAudioParam {
  cancelScheduledValues(time: number): void
  setValueAtTime(value: number, time: number): void
  linearRampToValueAtTime(value: number, time: number): void
}

export interface CueOscillatorNode {
  frequency: Pick<CueAudioParam, 'setValueAtTime'>
  connect(destination: unknown): void
  disconnect(): void
  start(time: number): void
  stop(time: number): void
}

export interface CueGainNode {
  gain: CueAudioParam
  connect(destination: unknown): void
  disconnect(): void
}

export interface CueAudioContext {
  currentTime: number
  destination: unknown
  createOscillator(): CueOscillatorNode
  createGain(): CueGainNode
  close(): Promise<void>
}

export interface SoundCueOptions {
  enabled?: boolean
  createContext?: () => CueAudioContext
  wait?: (milliseconds: number) => Promise<void>
}

const defaultCreateContext = (): CueAudioContext =>
  new (globalThis as unknown as { AudioContext: new () => CueAudioContext }).AudioContext()

const defaultWait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds))

export class SoundCuePlayer {
  private readonly enabled: boolean
  private readonly createContext: () => CueAudioContext
  private readonly wait: (milliseconds: number) => Promise<void>

  constructor(options: SoundCueOptions = {}) {
    this.enabled = options.enabled ?? true
    this.createContext = options.createContext ?? defaultCreateContext
    this.wait = options.wait ?? defaultWait
  }

  async playStart(): Promise<void> {
    await this.play([620, 880])
  }

  async playStop(): Promise<void> {
    await this.play([880, 620])
  }

  private async play(frequencies: readonly [number, number]): Promise<void> {
    if (!this.enabled) return

    let context: CueAudioContext | undefined
    const oscillators: CueOscillatorNode[] = []
    const gains: CueGainNode[] = []
    try {
      context = this.createContext()
      const cueStart = context.currentTime
      for (let index = 0; index < frequencies.length; index += 1) {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillators.push(oscillator)
        gains.push(gain)

        const toneStart = cueStart + index * 0.04
        const toneEnd = toneStart + 0.04
        oscillator.frequency.setValueAtTime(frequencies[index] ?? 0, toneStart)
        gain.gain.cancelScheduledValues(toneStart)
        gain.gain.setValueAtTime(0, toneStart)
        gain.gain.linearRampToValueAtTime(0.04, toneStart + 0.004)
        gain.gain.linearRampToValueAtTime(0, toneEnd)
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start(toneStart)
        oscillator.stop(toneEnd)
      }
      await this.wait(80)
    } catch {
      // Cue playback is optional; errors are contained so fire-and-forget calls stay safe.
    } finally {
      for (const oscillator of oscillators) {
        try {
          oscillator.disconnect()
        } catch {
          // Continue releasing the remaining cue nodes.
        }
      }
      for (const gain of gains) {
        try {
          gain.disconnect()
        } catch {
          // Continue releasing the remaining cue nodes.
        }
      }
      if (context !== undefined) {
        try {
          await context.close()
        } catch {
          // Optional cue cleanup failures are intentionally contained.
        }
      }
    }
  }
}
