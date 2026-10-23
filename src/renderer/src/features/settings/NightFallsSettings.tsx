import React, { useEffect, useId, useState, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AppSettings, SettingsPatch } from '../../../../shared/settings'
import { Toggle } from '../../components/Toggle'

const SPEEDS = { min: 0.5, max: 2, step: 0.25 } as const

/** How a speed reads beside the dial: "1x", "1.5x", "0.75x". */
export function speedLabel(speed: number): string {
  return `${Number(speed.toFixed(2))}x`
}

/**
 * Night falls, the move between Threads and Watcher's room (nightFalls.ts): a switch for it and a dial for its speed.
 * The dial saves when it is let go, as the theme sliders do, and rests while the switch is off.
 */
export function NightFallsSettings({ settings, onSave }: {
  readonly settings: Pick<AppSettings, 'roomTransition' | 'roomTransitionSpeed'>
  readonly onSave: (patch: SettingsPatch) => unknown
}): ReactNode {
  const { t } = useLingui()
  const id = useId()
  const [speed, setSpeed] = useState(settings.roomTransitionSpeed)
  useEffect(() => setSpeed(settings.roomTransitionSpeed), [settings.roomTransitionSpeed])
  const commit = (): void => { if (speed !== settings.roomTransitionSpeed) void onSave({ roomTransitionSpeed: speed }) }
  const percent = ((speed - SPEEDS.min) / (SPEEDS.max - SPEEDS.min)) * 100
  // The wrapper only names the group (watcher-gate.spec.ts finds Watcher's mentions outside its own page by it); it adds no box.
  return <div id="settings-night-falls" style={{ display: 'contents' }}>
    <Toggle label={t`Night falls between Threads and Watcher`} checked={settings.roomTransition} onCheckedChange={checked => void onSave({ roomTransition: checked })}
      description={t`A band of text characters sweeps across the window when you open Watcher's room or go back to Threads, and the owl rides it to its new place. Off, the window changes at once. Reduced motion always changes it at once.`} />
    <div className="tt-field theme-slider">
      <div className="theme-slider__head">
        <label className="tt-field__label" htmlFor={id}><Trans>Night falls speed</Trans></label>
        <span className="theme-slider__value"><output htmlFor={id}>{speedLabel(speed)}</output></span>
      </div>
      <p className="tt-field__description" id={`${id}-description`}><Trans>Slower to watch the band sweep, faster to get there sooner. 1x takes under a second.</Trans></p>
      <input id={id} className="theme-slider__input tt-focusable" type="range" min={SPEEDS.min} max={SPEEDS.max} step={SPEEDS.step} value={speed}
        disabled={!settings.roomTransition} aria-describedby={`${id}-description`} aria-valuetext={speedLabel(speed)}
        style={{ '--theme-slider-fill': `${percent}%` } as React.CSSProperties}
        onChange={event => { const next = Number(event.currentTarget.value); if (Number.isFinite(next)) setSpeed(next) }}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
    </div>
  </div>
}
