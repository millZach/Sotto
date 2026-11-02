import { useEffect, useRef, useState } from 'react'
import { SEGMENT_SILENCE_RMS, SEGMENT_SILENCE_SECONDS } from './audioRecorder'

/**
 * Voice gating for the listening wave, derived from the recorder's own silence segmentation so the wave and the
 * recorder agree on what counts as a pause: the silence floor releases the gate, twice it attacks, and the hold sits
 * just past the gap the recorder treats as a real pause.
 */
export const SPEAKING_ON_LEVEL = SEGMENT_SILENCE_RMS * 2
export const SPEAKING_OFF_LEVEL = SEGMENT_SILENCE_RMS
export const SPEAKING_HOLD_MS = SEGMENT_SILENCE_SECONDS * 1_000 + 20

export function safeLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0
}

export interface SpeakingGateTimers {
  readonly set: (callback: () => void, delayMs: number) => unknown
  readonly clear: (handle: unknown) => void
}

const globalTimers: SpeakingGateTimers = {
  set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clear: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Whether the microphone is registering a voice, from its level: what the wave shows, and the only part of the level
 * the window and the widget are told about (#993). The microphone reports a level about every 33 ms; the gate changes a
 * few times a sentence.
 *
 * The gate is hysteretic. It opens at once above `SPEAKING_ON_LEVEL`, and closes only below the lower
 * `SPEAKING_OFF_LEVEL` and only after `SPEAKING_HOLD_MS` of quiet, so a voice wavering at the boundary and the ordinary
 * gaps between words both leave it open. Inside the band it holds, and one pending close is never restarted: the hold
 * measures from the first quiet frame after the voice, not from the latest one.
 */
export class SpeakingGate {
  private settle: unknown
  private settling = false
  private open: boolean

  constructor(
    private readonly onChange: (speaking: boolean) => void,
    initial = false,
    private readonly timers: SpeakingGateTimers = globalTimers,
  ) {
    this.open = initial
  }

  get speaking(): boolean { return this.open }

  /** One level from the microphone; `hold` keeps the gate open whatever the level, as the microphone test does. */
  feed(level: number, hold = false): void {
    const bounded = safeLevel(level)
    if (hold || bounded >= SPEAKING_ON_LEVEL) {
      this.cancelSettle()
      this.set(true)
      return
    }
    if (bounded > SPEAKING_OFF_LEVEL || !this.open || this.settling) return
    this.settling = true
    this.settle = this.timers.set(() => {
      this.settling = false
      this.settle = undefined
      this.set(false)
    }, SPEAKING_HOLD_MS)
  }

  /** Lets go of a pending close; the gate keeps its state and can be fed again. */
  dispose(): void { this.cancelSettle() }

  private cancelSettle(): void {
    if (!this.settling) return
    this.settling = false
    this.timers.clear(this.settle)
    this.settle = undefined
  }

  private set(speaking: boolean): void {
    if (this.open === speaking) return
    this.open = speaking
    this.onChange(speaking)
  }
}

/** The gate for a level a component holds itself, such as the microphone test's. */
export function useSpeakingGate(level: number, hold = false): boolean {
  const [speaking, setSpeaking] = useState(() => hold || safeLevel(level) >= SPEAKING_ON_LEVEL)
  const gate = useRef<SpeakingGate | null>(null)
  gate.current ??= new SpeakingGate(setSpeaking, speaking)
  useEffect(() => { gate.current!.feed(level, hold) }, [level, hold])
  useEffect(() => () => gate.current?.dispose(), [])
  return speaking
}
