import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { SEGMENT_SILENCE_RMS, SEGMENT_SILENCE_SECONDS } from '../audio/audioRecorder'
import './listeningBars.css'

/** The listening visualizer's fixed column count; CSS staggers their motion. */
const LISTENING_BAR_COUNT = 7
/**
 * Voice gating for the visualizer, derived from the recorder's own silence
 * segmentation so the wave and the recorder agree on what counts as a pause:
 * the silence floor releases the gate, twice it attacks, and the hold sits
 * just past the gap the recorder treats as a real pause.
 */
const SPEAKING_ON_LEVEL = SEGMENT_SILENCE_RMS * 2
const SPEAKING_OFF_LEVEL = SEGMENT_SILENCE_RMS
const SPEAKING_HOLD_MS = SEGMENT_SILENCE_SECONDS * 1_000 + 20
function safeLevel(level: number): number {
  return Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0
}

/**
 * The recording visualizer: seven bars that rise and fall on a staggered CSS
 * loop while the microphone is actually registering the voice, so the motion
 * reads as "I hear you" rather than merely "a session is open". Silence settles
 * the bars to their resting height.
 *
 * The gate is hysteretic — it opens above SPEAKING_ON_LEVEL and only closes
 * below the lower SPEAKING_OFF_LEVEL, then only after SPEAKING_HOLD_MS of quiet
 * — so a voice wavering at the boundary and the ordinary gaps between words
 * both leave the wave running. Only the container carries the decision, as one
 * data attribute; the bars themselves stay purely CSS-driven.
 *
 * The visualizer stays out of the accessibility tree: the live regions already
 * announce the listening state.
 */
export function ListeningBars({ level }: { readonly level: number }): ReactNode {
  const bounded = safeLevel(level)
  const [speaking, setSpeaking] = useState(() => bounded >= SPEAKING_ON_LEVEL)
  const settleTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (bounded >= SPEAKING_ON_LEVEL) {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
      setSpeaking(true)
      return
    }
    // Inside the hysteresis band the current state simply holds, and one
    // pending settle is never restarted: the hold measures from the last
    // voiced frame, not from the latest quiet one.
    if (bounded > SPEAKING_OFF_LEVEL || !speaking || settleTimerRef.current !== null) return
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null
      setSpeaking(false)
    }, SPEAKING_HOLD_MS)
  }, [bounded, speaking])

  useEffect(() => () => {
    if (settleTimerRef.current === null) return
    window.clearTimeout(settleTimerRef.current)
    settleTimerRef.current = null
  }, [])

  return (
    <span
      className="widget-bars"
      data-testid="listening-bars"
      data-speaking={speaking || undefined}
      aria-hidden="true"
    >
      {Array.from({ length: LISTENING_BAR_COUNT }, (_unused, index) => (
        // The stable index represents one fixed visualizer column.
        <span key={index} className="widget-bars__bar" />
      ))}
    </span>
  )
}
