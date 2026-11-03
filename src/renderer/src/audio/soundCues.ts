export interface CueAudioParam {
  cancelScheduledValues(time: number): void
  setValueAtTime(value: number, time: number): void
  linearRampToValueAtTime(value: number, time: number): void
}

export interface CueOscillatorNode {
  frequency: Pick<CueAudioParam, 'setValueAtTime'>
  onended: (() => void) | null
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
  resume(): Promise<void>
  suspend(): Promise<void>
  close(): Promise<void>
}

export interface SoundCueOptions {
  enabled?: boolean
  createContext?: () => CueAudioContext
}

const defaultCreateContext = (): CueAudioContext =>
  new (globalThis as unknown as { AudioContext: new () => CueAudioContext }).AudioContext()

interface PreparedCueContext {
  readonly audio: CueAudioContext
  activePlays: number
  suspension: Promise<void>
  readonly pendingEnds: Set<() => void>
}

export class SoundCuePlayer {
  private readonly enabled: boolean
  private readonly createContext: () => CueAudioContext
  private context: PreparedCueContext | undefined
  private disposed = false

  constructor(options: SoundCueOptions = {}) {
    this.enabled = options.enabled ?? true
    this.createContext = options.createContext ?? defaultCreateContext
  }

  /** Construct off the dictation path, then leave the audio hardware idle. */
  prepare(): Promise<void> {
    if (!this.enabled || this.disposed) return Promise.resolve()
    if (this.context !== undefined) return this.context.suspension
    try {
      const context: PreparedCueContext = {
        audio: this.createContext(), activePlays: 0,
        suspension: Promise.resolve(), pendingEnds: new Set(),
      }
      this.context = context
      context.suspension = this.suspend(context)
      return context.suspension
    } catch {
      // Optional cues remain unavailable if the audio context cannot be made.
    }
    return Promise.resolve()
  }

  playStart(): Promise<void> {
    return this.play([620, 880])
  }

  playStop(): Promise<void> {
    return this.play([880, 620])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.context !== undefined) this.retire(this.context)
  }

  private retire(context: PreparedCueContext): void {
    if (this.context !== context) return
    this.context = undefined
    for (const finish of context.pendingEnds) finish()
    context.pendingEnds.clear()
    try {
      void context.audio.close().catch(() => undefined)
    } catch {
      // Optional cue cleanup failures stay contained.
    }
  }

  private async suspend(context: PreparedCueContext): Promise<void> {
    try {
      await context.audio.suspend()
    } catch {
      this.retire(context)
    }
  }

  private async play(frequencies: readonly [number, number]): Promise<void> {
    if (!this.enabled || this.disposed) return

    const preparation = this.prepare()
    const context = this.context
    if (context === undefined) return
    // Include pending resumes, so another cue ending cannot suspend this one.
    context.activePlays += 1
    const oscillators: CueOscillatorNode[] = []
    const gains: CueGainNode[] = []
    let finish: (() => void) | undefined
    try {
      await preparation
      if (this.context !== context || this.disposed) return
      const audio = context.audio
      await audio.resume()
      if (this.context !== context || this.disposed) return

      const ended = new Promise<void>(resolve => { finish = resolve })
      context.pendingEnds.add(finish!)
      let remaining = frequencies.length
      const cueStart = audio.currentTime
      for (let index = 0; index < frequencies.length; index += 1) {
        const oscillator = audio.createOscillator()
        oscillators.push(oscillator)
        const gain = audio.createGain()
        gains.push(gain)
        oscillator.onended = () => { if (--remaining === 0) finish!() }

        const toneStart = cueStart + index * 0.04
        const toneEnd = toneStart + 0.04
        oscillator.frequency.setValueAtTime(frequencies[index] ?? 0, toneStart)
        gain.gain.cancelScheduledValues(toneStart)
        gain.gain.setValueAtTime(0, toneStart)
        gain.gain.linearRampToValueAtTime(0.04, toneStart + 0.004)
        gain.gain.linearRampToValueAtTime(0, toneEnd)
        oscillator.connect(gain)
        gain.connect(audio.destination)
        oscillator.start(toneStart)
        oscillator.stop(toneEnd)
      }
      await ended
    } catch {
      // Cue playback is optional; errors are contained so fire-and-forget calls stay safe.
      this.retire(context)
    } finally {
      if (finish !== undefined) context.pendingEnds.delete(finish)
      for (const oscillator of oscillators) {
        oscillator.onended = null
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
      context.activePlays -= 1
      if (context.activePlays === 0 && this.context === context && !this.disposed) {
        context.suspension = this.suspend(context)
      }
    }
  }
}
