import React, { type CSSProperties, type ReactNode } from 'react'

export type BreathLineStage = 'idle' | 'listening' | 'processing'

export interface BreathLineProps {
  /** What the dictation surface is doing right now. */
  readonly stage: BreathLineStage
  /** Live microphone level, 0..1. Only read while listening. */
  readonly value: number
  /** Accessible name used while the line is reporting a live level. */
  readonly label: string
}

const BAR_COUNT = 64
const CENTER = (BAR_COUNT - 1) / 2
const REST_HEIGHT = 2
const PEAK_HEIGHT = 28

/**
 * Per-bar weight: a centred envelope multiplied by a fixed texture. Computed
 * once at module load so the line looks like a waveform and never reshuffles
 * between renders the way a random profile would.
 */
const PROFILE: readonly number[] = Array.from({ length: BAR_COUNT }, (_, index) => {
  const distance = Math.abs(index - CENTER) / CENTER
  const envelope = Math.max(0, 1 - distance ** 1.7)
  const texture = 0.55 + 0.45 * Math.abs(Math.sin(index * 2.399963))
  return envelope * texture
})

/**
 * The resting shape: the widget's seven-bar visualizer, held still at the
 * centre of an otherwise flat line. Heights are the mockup's exactly.
 */
const RESTING: ReadonlyMap<number, number> = new Map([
  [23, 6], [29, 12], [30, 18], [31, 24], [32, 18], [33, 12], [39, 6],
])

function barLevel(height: number): '0' | '1' | '2' {
  if (height <= REST_HEIGHT + 1) return '0'
  return height < 14 ? '1' : '2'
}

/**
 * The dictation surface's signature: a full-width line of hairline bars that
 * rests flat with a slow centre pulse, answers the real microphone level while
 * listening, and reports a travelling swell while transcribing. Motion is
 * carried entirely by CSS so both reduced-motion paths can suppress it.
 */
export function BreathLine({ stage, value, label }: BreathLineProps): ReactNode {
  const safeValue = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  const listening = stage === 'listening'
  const liveProps = listening
    ? {
      role: 'meter',
      'aria-label': label,
      'aria-valuemin': 0,
      'aria-valuemax': 1,
      'aria-valuenow': safeValue,
      'aria-valuetext': `${Math.round(safeValue * 100)} percent`,
    }
    : { 'aria-hidden': true as const }

  return (
    <div className="home-breath" data-stage={stage} {...liveProps}>
      {PROFILE.map((weight, index) => {
        const resting = RESTING.get(index) ?? REST_HEIGHT
        // Listening never falls below the resting shape: silence looks like a
        // line at rest rather than a dead one, and the voice lifts it from
        // there. The widget's bars settle to their floor the same way.
        const height = listening
          ? Math.max(resting, REST_HEIGHT + safeValue * weight * (PEAK_HEIGHT - REST_HEIGHT))
          : resting
        // While transcribing the height belongs to the CSS keyframes, so no
        // inline height is written; the stagger travels along the line.
        const style = {
          '--tt-breath-delay': `${((index / BAR_COUNT) * 1.2).toFixed(2)}s`,
          ...(stage === 'processing' ? {} : { height: `${Math.round(height * 10) / 10}px` }),
        } as CSSProperties

        return (
          <span
            key={index}
            className="home-breath__bar"
            data-level={barLevel(height)}
            style={style}
          />
        )
      })}
    </div>
  )
}
