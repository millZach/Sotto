import React, { type ReactNode } from 'react'

export interface LevelMeterProps {
  readonly value: number
  readonly label: string
  readonly barCount?: number
}

export function LevelMeter({ value, label, barCount = 12 }: LevelMeterProps): ReactNode {
  const safeValue = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  const bars = Math.max(4, Math.min(24, Math.round(barCount)))
  return (
    <div
      className="tt-level-meter"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={safeValue}
      aria-valuetext={`${Math.round(safeValue * 100)} percent`}
    >
      {Array.from({ length: bars }, (_, index) => {
        const threshold = (index + 1) / bars
        const active = safeValue >= threshold - (1 / bars / 2)
        return (
          <span
            aria-hidden="true"
            className="tt-level-meter__bar"
            data-active={active}
            key={index}
            style={{ height: `${8 + ((index % 4) + 1) * 6}px` }}
          />
        )
      })}
    </div>
  )
}
