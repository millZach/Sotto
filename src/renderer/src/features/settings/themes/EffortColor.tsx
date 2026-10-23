import React, { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'

import { EFFORT_COLORS, EFFORT_COLOR_LABELS, type EffortColor } from '../../../../../shared/settings'

const STOPS = [0, 0.25, 0.5, 0.75]

/**
 * Settings → Appearance → Effort color: the six colourways as the effort card's own filled track, in the
 * theme grid's columns. Each swatch wears its colourway through the `data-effort-color` attribute tokens.css
 * keys on, so it shows its own hues whatever the root is painted with (ADR-0019).
 */
export function EffortColorChoice({ value, onChoose }: {
  readonly value: EffortColor
  readonly onChoose: (color: EffortColor) => void
}): ReactNode {
  const { t } = useLingui()
  const headingId = useId()
  return (
    <div className="effort-colors">
      <h3 className="theme-settings__subheading" id={headingId}><Trans>Effort color</Trans></h3>
      <p className="theme-settings__assignment-hint tt-paragraph"><Trans>The color a thread’s effort control turns at its highest level.</Trans></p>
      <div className="effort-colors__grid" role="group" data-setting="effort-color" aria-labelledby={headingId}>
        {EFFORT_COLORS.map(id => {
          const active = id === value
          const color = EFFORT_COLOR_LABELS[id]
          return (
            <button
              key={id}
              type="button"
              className="effort-color tt-focusable"
              data-effort-color={id}
              aria-pressed={active}
              aria-label={active ? t`Use ${color} as the effort color, currently active` : t`Use ${color} as the effort color`}
              onClick={() => onChoose(id)}
            >
              <span className="effort-color__pill" aria-hidden="true">
                {STOPS.map(stop => <i key={stop} style={{ '--effort-stop': stop } as CSSProperties} />)}
                <b />
              </span>
              <span className="effort-color__name">{EFFORT_COLOR_LABELS[id]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** How long the sample's arrival plays; the same as the composer's (EffortPicker). */
const SAMPLE_ARRIVAL_MS = 1900

/**
 * The Live appearance card's sample of the effort control at a model's highest level: a small composer
 * wearing the outline, with the card above its chip. Choosing a colourway plays the arrival through it, so
 * the choice is seen where it will be felt. Reduced motion shows the settled state.
 */
export function EffortColorSample({ effortColor, still }: {
  readonly effortColor: EffortColor
  readonly still: boolean
}): ReactNode {
  const { t } = useLingui()
  const [arriving, setArriving] = useState(false)
  const [run, setRun] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seen = useRef<EffortColor | null>(null)
  const play = (): void => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
    if (still) { setArriving(false); return }
    // The scene mounts fresh on every play, which is the one way an arrival already running restarts:
    // turning the attribute off and on again is never painted in between, so the browser has nothing to stop.
    setRun(current => current + 1)
    setArriving(true)
    timer.current = setTimeout(() => { timer.current = null; setArriving(false) }, SAMPLE_ARRIVAL_MS)
  }
  // The colourway changing is the cue; the first colourway seen is the settled state, not an arrival.
  useEffect(() => {
    if (seen.current !== null && seen.current !== effortColor) play()
    seen.current = effortColor
  }, [effortColor])
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  // The sample is the effort card a thread shows, so its words are the card's own.
  const max = t({ message: 'Max', comment: 'The highest reasoning effort level, as the effort card names it' })
  const letters = Array.from(max, (letter, index) => <span key={index} style={{ '--effort-letter': index } as CSSProperties}>{letter}</span>)
  return (
    <div className="effort-sample" data-arriving={arriving} data-still={still}>
      <div className="effort-sample__head">
        <span><Trans>Effort at its highest level</Trans></span>
        <button type="button" className="effort-sample__replay tt-focusable" onClick={play} disabled={still}><Trans>Play again</Trans></button>
      </div>
      <div className="effort-sample__scene" key={run} aria-hidden="true">
        <div className="effort-sample__card">
          <div className="effort-sample__card-head"><p className="effort-sample__word">{letters}</p><span>{t({ message: 'Default', comment: 'Marks the model\'s default effort level on the effort card' })}</span></div>
          <p className="effort-sample__line tt-paragraph"><Trans>Everything the model has. Slowest, costliest.</Trans></p>
          <div className="effort-sample__track">
            <div className="effort-sample__pill"><div className="effort-sample__fill" />{STOPS.map(stop => <i key={stop} style={{ '--effort-stop': stop } as CSSProperties} />)}</div>
            <b className="effort-sample__thumb" />
          </div>
          <div className="effort-sample__ends"><span><Trans>Faster</Trans></span><span><Trans>More thorough</Trans></span></div>
          <div className="effort-sample__wash" />
        </div>
        <div className="effort-sample__composer">
          <div className="effort-sample__wash" />
          <i className="effort-sample__text" />
          <div className="effort-sample__chips"><span>{t({ message: 'Model', comment: 'A composer chip standing for the model' })}</span><span data-effort-top="true">{max}</span><span>{t({ message: 'Auto', comment: 'A composer chip: the Auto permission' })}</span></div>
        </div>
      </div>
    </div>
  )
}
