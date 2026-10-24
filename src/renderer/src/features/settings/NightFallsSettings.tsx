import React, { useEffect, useId, useState, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { AppSettings, RoomTransitionLook, SettingsPatch } from '../../../../shared/settings'
import { SegmentedControl } from '../../components/SegmentedControl'
import { Toggle } from '../../components/Toggle'

const SPEEDS = { min: 0.5, max: 2, step: 0.25 } as const

/** How a speed reads beside the dial: "1x", "1.5x", "0.75x". */
export function speedLabel(speed: number): string {
  return `${Number(speed.toFixed(2))}x`
}

/**
 * Night falls, the move between Threads and Watcher's room (nightFalls.ts): a switch for it, its look (ADR-0119,
 * decision 6) and a dial for its speed. The look saves as it is chosen, the arrow keys moving between Band and Stars, and
 * the dial saves when it is let go, as the theme sliders do. Both rest while the switch is off.
 */
export function NightFallsSettings({ settings, onSave }: {
  readonly settings: Pick<AppSettings, 'roomTransition' | 'roomTransitionSpeed' | 'roomTransitionLook'>
  readonly onSave: (patch: SettingsPatch) => unknown
}): ReactNode {
  const { t } = useLingui()
  const id = useId(), lookId = useId()
  const band = t({ message: 'Band', comment: 'A look for night falls: a band of text characters sweeps across the window' })
  const stars = t({ message: 'Stars', comment: 'A look for night falls: a line of stars sweeps across the window' })
  const look = (value: string): void => { if (value !== settings.roomTransitionLook) void onSave({ roomTransitionLook: value as RoomTransitionLook }) }
  const [speed, setSpeed] = useState(settings.roomTransitionSpeed)
  useEffect(() => setSpeed(settings.roomTransitionSpeed), [settings.roomTransitionSpeed])
  const commit = (): void => { if (speed !== settings.roomTransitionSpeed) void onSave({ roomTransitionSpeed: speed }) }
  const percent = ((speed - SPEEDS.min) / (SPEEDS.max - SPEEDS.min)) * 100
  // The wrapper only names the group (watcher-gate.spec.ts finds Watcher's mentions outside its own page by it); it adds no box.
  return <div id="settings-night-falls" style={{ display: 'contents' }}>
    <Toggle setting="night-falls" label={t`Night falls between Threads and Watcher`} checked={settings.roomTransition} onCheckedChange={checked => void onSave({ roomTransition: checked })}
      description={t`A band of text characters sweeps across the window when you open Watcher's room or go back to Threads, and the owl rides it to its new place. Off, the window changes at once. Reduced motion always changes it at once.`} />
    <div className="tt-field night-falls-look">
      <p className="tt-field__label" id={`${lookId}-label`}><Trans>Night falls look</Trans></p>
      <div className="tt-field__description tt-paragraph">
        <span className="night-falls-look__line"><strong>{band}</strong> <span id={`${lookId}-band`}><Trans>A band of text characters sweeps across the window.</Trans></span></span>
        <span className="night-falls-look__line"><strong>{stars}</strong> <span id={`${lookId}-stars`}><Trans>A line of stars sweeps across, with a faint trail behind it.</Trans></span></span>
      </div>
      <SegmentedControl setting="night-falls-look" label={t`Night falls look`} value={settings.roomTransitionLook} disabled={!settings.roomTransition} onChange={look}
        options={[{ value: 'band', label: band, describedBy: `${lookId}-band` }, { value: 'stars', label: stars, describedBy: `${lookId}-stars` }]} />
    </div>
    <div className="tt-field theme-slider">
      <div className="theme-slider__head">
        <label className="tt-field__label" htmlFor={id}><Trans>Night falls speed</Trans></label>
        <span className="theme-slider__value"><output htmlFor={id}>{speedLabel(speed)}</output></span>
      </div>
      <p className="tt-field__description tt-paragraph" id={`${id}-description`}><Trans>Slower to watch the band sweep, faster to get there sooner. 1x takes under a second.</Trans></p>
      <input id={id} data-setting="night-falls-speed" className="theme-slider__input tt-focusable" type="range" min={SPEEDS.min} max={SPEEDS.max} step={SPEEDS.step} value={speed}
        disabled={!settings.roomTransition} aria-describedby={`${id}-description`} aria-valuetext={speedLabel(speed)}
        style={{ '--theme-slider-fill': `${percent}%` } as React.CSSProperties}
        onChange={event => { const next = Number(event.currentTarget.value); if (Number.isFinite(next)) setSpeed(next) }}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
    </div>
  </div>
}
