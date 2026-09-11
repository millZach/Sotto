import { ListeningBars } from './ListeningBars'
import React, { type CSSProperties, type ReactNode } from 'react'

export type VoiceWaveStage = 'idle' | 'listening' | 'processing'

export type VoiceWaveSize = 'widget' | 'deck' | 'hero' | 'switch'

export interface VoiceWaveProps {
  /** What the dictation surface is doing right now. */
  readonly stage: VoiceWaveStage
  /** Live microphone level, 0..1. Only read while listening. */
  readonly value: number
  /** Accessible name used while the wave is reporting a live level. */
  readonly label: string
  /**
   * `widget` is the floating widget's exact geometry; `deck` the old strip's
   * larger cut; `hero` the Dictate room's centrepiece; `switch` the glyph
   * inside the Dictate tab.
   */
  readonly size?: VoiceWaveSize
}

const BAR_COUNT = 7

/** A centered silhouette for the idle and processing states. */
const PROFILE: readonly number[] = [0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45]

/** Transcribing has no level to answer, so the bars roll at a fixed, gentle height. */
const PROCESSING_LEVEL = 0.4

/**
 * At hero size a flat line reads as "off", so the resting wave keeps a low
 * hump: the middle bars lifted a little, the outer ones on the floor.
 */
const RESTING_PROFILE: readonly number[] = [0, 0.1, 0.2, 0.28, 0.2, 0.1, 0]

const GEOMETRY: Readonly<Record<VoiceWaveSize, { width: number; gap: number; rest: number; peak: number }>> = {
  widget: { width: 3, gap: 3, rest: 5, peak: 17 },
  deck: { width: 4, gap: 4, rest: 6, peak: 26 },
  hero: { width: 14, gap: 12, rest: 14, peak: 130 },
  switch: { width: 2, gap: 2, rest: 4, peak: 14 },
}

/** Listening delegates to the same component and CSS as the floating widget.
 * Idle and processing retain the room's resting silhouette.
 */
export function VoiceWave({ stage, value, label, size = 'widget' }: VoiceWaveProps): ReactNode {
  const geometry = GEOMETRY[size]
  const safeValue = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  const listening = stage === 'listening'
  const level = listening
    ? safeValue
    : stage === 'processing' ? PROCESSING_LEVEL : 0
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
  const style = {
    '--wave-w': `${geometry.width}px`,
    '--wave-gap': `${geometry.gap}px`,
    '--wave-rest': `${geometry.rest}px`,
    '--wave-peak': `${geometry.peak}px`,
  } as CSSProperties

  if (listening) return <div className="voice-wave voice-wave--listening" data-stage={stage} data-size={size} style={style} {...liveProps}><ListeningBars level={safeValue} /></div>

  return (
    <div className="voice-wave" data-stage={stage} style={style} {...liveProps}>
      {Array.from({ length: BAR_COUNT }, (_, index) => {
        const resting = stage === 'idle' && size === 'hero' ? (RESTING_PROFILE[index] ?? 0) : 0
        const swing = Math.max(resting, level * (PROFILE[index] ?? 1))
        const height = Math.round((geometry.rest + swing * (geometry.peak - geometry.rest)) * 10) / 10
        return (
          <span
            key={index}
            className="voice-wave__bar"
            style={{ '--wave-bar': `${height}px`, height: `${height}px` } as CSSProperties}
          />
        )
      })}
    </div>
  )
}
