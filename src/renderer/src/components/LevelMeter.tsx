import React, { type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'

export interface LevelMeterProps {
  readonly value: number
  readonly label: string
  readonly barCount?: number
}

/** A level from 0 to 1 as a screen reader reads it, "45%", written the way the interface language writes a percentage. */
export function levelText(level: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(level)
}

export function LevelMeter({ value, label, barCount = 12 }: LevelMeterProps): ReactNode {
  const { i18n } = useLingui()
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
      aria-valuetext={levelText(safeValue, i18n.locale)}
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
