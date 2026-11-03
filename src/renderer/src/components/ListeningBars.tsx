import React, { type ReactNode } from 'react'
import { useSpeakingGate } from '../audio/speakingGate'
import './listeningBars.css'

/** The listening visualizer's fixed column count; CSS staggers their motion. */
const LISTENING_BAR_COUNT = 7

/**
 * The recording visualizer: seven bars that rise and fall on a staggered CSS
 * loop while the microphone is actually registering the voice, so the motion
 * reads as "I hear you" rather than merely "a session is open". Silence settles
 * the bars to their resting height.
 *
 * Whether a voice is heard is `SpeakingGate`'s decision (`audio/speakingGate.ts`):
 * dictation hands it over already made, as `speaking`, so the window and the
 * widget hear of the gate rather than of every level (#993); the microphone test
 * hands over its own level and the bars gate it the same way. Only the container
 * carries the decision, as one data attribute; the bars themselves stay purely
 * CSS-driven.
 *
 * The visualizer stays out of the accessibility tree: the live regions already
 * announce the listening state.
 */
export function ListeningBars(props: { readonly speaking: boolean } | {
  readonly level: number
  /**
   * The microphone test keeps the stream open to show live input. Hold the
   * wave on for that whole session; dictation still gates on voice.
   */
  readonly holdSpeaking?: boolean
}): ReactNode {
  return 'speaking' in props ? <Bars speaking={props.speaking} /> : <GatedBars level={props.level} hold={props.holdSpeaking ?? false} />
}

function GatedBars({ level, hold }: { readonly level: number; readonly hold: boolean }): ReactNode {
  return <Bars speaking={useSpeakingGate(level, hold)} />
}

function Bars({ speaking }: { readonly speaking: boolean }): ReactNode {
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
