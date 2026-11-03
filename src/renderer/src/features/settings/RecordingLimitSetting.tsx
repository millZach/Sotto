import React, { useEffect, useId, useState, type ReactNode } from 'react'
import { useLingui } from '@lingui/react/macro'
import { Infinity as NoLimit } from 'lucide-react'
import type { MaxRecordingSeconds, SettingsPatch } from '../../../../shared/settings'

const STOPS: readonly MaxRecordingSeconds[] = [30, 60, 120, 180, 300, 600, 900, 1800, null]

/**
 * Recording limit as a slider over its stops; the last stop is no limit. It saves when it is let go, as Night falls
 * speed does. The slider moves by stop rather than by second, so the stops sit evenly along it.
 */
export function RecordingLimitSetting({ value, onSave }: {
  readonly value: MaxRecordingSeconds
  readonly onSave: (patch: SettingsPatch) => unknown
}): ReactNode {
  const { t } = useLingui()
  const id = useId()
  const [stop, setStop] = useState(STOPS.indexOf(value))
  useEffect(() => setStop(STOPS.indexOf(value)), [value])
  const chosen = STOPS[stop] ?? null
  const minutes = (chosen ?? 0) / 60
  const commit = (): void => { if (chosen !== value) void onSave({ maxRecordingSeconds: chosen }) }
  const label = chosen === null ? t({ message: 'No limit', comment: 'The last stop of the recording limit slider: a dictation runs until you stop it.' })
    : chosen === 30 ? t({ message: '30 s', comment: 'Thirty seconds, the shortest recording limit.' })
    : t({ message: `${minutes} min`, comment: 'A recording limit in minutes, such as 5 min.' })
  return <div className="tt-field theme-slider theme-slider--inline">
    <div className="theme-slider__head">
      <label className="tt-field__label" htmlFor={id}>{t`Recording limit`}</label>
      <span className="theme-slider__value"><output htmlFor={id}>{chosen === null ? <NoLimit size={16} aria-label={label} /> : label}</output></span>
    </div>
    <input id={id} data-setting="recording-limit" className="theme-slider__input tt-focusable" type="range" min={0} max={STOPS.length - 1} step={1} value={stop}
      aria-valuetext={label} style={{ '--theme-slider-fill': `${(stop / (STOPS.length - 1)) * 100}%` } as React.CSSProperties}
      onChange={event => setStop(Number(event.currentTarget.value))}
      onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
  </div>
}
