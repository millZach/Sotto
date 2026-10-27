import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'

import { EFFORT_COLORS, EFFORT_COLOR_LABELS, type EffortColor } from '../../../../../shared/settings'

/**
 * Settings → Appearance → Effort color: the six colourways as a compact row of swatches, each a short strip of the
 * effort card's filled track above its name. Each swatch wears its colourway through the `data-effort-color` attribute
 * tokens.css keys on, so it shows its own hues whatever the root is painted with (ADR-0019).
 */
export function EffortColorChoice({ value, onChoose }: {
  readonly value: EffortColor
  readonly onChoose: (color: EffortColor) => void
}): ReactNode {
  const { t } = useLingui()
  const headingId = useId()
  return (
    <div className="appearance-row effort-colors">
      <div className="appearance-row__text">
        <p className="tt-field__label" id={headingId}><Trans>Effort color</Trans></p>
        <p className="tt-field__description tt-paragraph"><Trans>The color a thread’s effort control turns at its highest level.</Trans></p>
      </div>
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
              <span className="effort-color__pill" aria-hidden="true" />
              <span className="effort-color__name">{EFFORT_COLOR_LABELS[id]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** How long the arrival plays; the same as the composer's (EffortPicker). */
export const SAMPLE_ARRIVAL_MS = 1900

/**
 * The effort control's arrival, for the preview's composer: choosing a colourway plays it once, so the choice is seen
 * where it will be felt. The first colourway seen is the settled state, not an arrival; reduced motion shows the
 * settled state. `run` changes on every play, so a scene keyed on it mounts fresh and an arrival already running
 * restarts: turning the attribute off and on again is never painted in between, so the browser has nothing to stop.
 */
/** The effort control's arrival as the preview plays it: whether it is playing, and which play it is. */
export interface EffortArrival {
  readonly arriving: boolean
  /** Changes on every play, so a part keyed on it mounts fresh and an arrival already running starts over. */
  readonly run: number
}

export function useEffortArrival(effortColor: EffortColor, still: boolean): EffortArrival {
  const [arriving, setArriving] = useState(false)
  const [run, setRun] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seen = useRef<EffortColor | null>(null)
  useEffect(() => {
    const changed = seen.current !== null && seen.current !== effortColor
    seen.current = effortColor
    if (!changed) return
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null }
    if (still) { setArriving(false); return }
    setRun(current => current + 1)
    setArriving(true)
    timer.current = setTimeout(() => { timer.current = null; setArriving(false) }, SAMPLE_ARRIVAL_MS)
  }, [effortColor])
  useEffect(() => { if (still) setArriving(false) }, [still])
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  return { arriving: arriving && !still, run }
}
