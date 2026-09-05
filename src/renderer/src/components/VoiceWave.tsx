import React, { type CSSProperties, type ReactNode } from 'react'

export type VoiceWaveStage = 'idle' | 'listening' | 'processing'

export type VoiceWaveSize = 'widget' | 'deck'

export interface VoiceWaveProps {
  /** What the dictation surface is doing right now. */
  readonly stage: VoiceWaveStage
  /** Live microphone level, 0..1. Only read while listening. */
  readonly value: number
  /** Accessible name used while the wave is reporting a live level. */
  readonly label: string
  /** `widget` is the floating widget's exact geometry; `deck` is the strip's larger cut. */
  readonly size?: VoiceWaveSize
}

const BAR_COUNT = 7

/**
 * The widget's silhouette: a centred hump, so the middle bar answers a voice
 * first and the outer bars only fill in when someone is really speaking.
 */
const PROFILE: readonly number[] = [0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45]

/** Silence never flattens a live line: the widget's bars keep a small roll going. */
const LISTENING_FLOOR = 0.25

/** Transcribing has no level to answer, so the bars roll at a fixed, gentle height. */
const PROCESSING_LEVEL = 0.4

const GEOMETRY: Readonly<Record<VoiceWaveSize, { width: number; gap: number; rest: number; peak: number }>> = {
  widget: { width: 3, gap: 3, rest: 5, peak: 17 },
  deck: { width: 4, gap: 4, rest: 6, peak: 26 },
}

/**
 * The widget's seven-bar visualizer, reproduced for the management window.
 * Each bar's peak is written inline from the microphone level so the CSS loop
 * swings exactly as high as the voice; with motion reduced the same inline
 * height stands still, so the line still reports the level by height alone.
 */
export function VoiceWave({ stage, value, label, size = 'widget' }: VoiceWaveProps): ReactNode {
  const geometry = GEOMETRY[size]
  const safeValue = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  const listening = stage === 'listening'
  const level = listening
    ? Math.max(LISTENING_FLOOR, safeValue)
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

  return (
    <div className="voice-wave" data-stage={stage} style={style} {...liveProps}>
      {Array.from({ length: BAR_COUNT }, (_, index) => {
        const height = Math.round((geometry.rest + level * (PROFILE[index] ?? 1) * (geometry.peak - geometry.rest)) * 10) / 10
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
