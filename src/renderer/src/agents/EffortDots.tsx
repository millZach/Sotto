import React, { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Square } from 'lucide-react'
import { t } from '@lingui/core/macro'
import { effortLabel } from './EffortPicker'
import { OPTION_CHIP_NAMES } from './optionChipNames'
import './quietComposer.css'

/** Stop, where the quiet composer keeps it while a turn runs: over the effort dots (ADR-0161). */
export interface DotsStop {
  readonly label: string
  readonly keys?: string | undefined
  readonly title: string
  readonly disabled: boolean
  readonly onStop: () => void
}

/**
 * The quiet composer's effort: one dot per level the model offers, lit up to the level set, in the provider's colour
 * (ADR-0161). It is a single slider: a press on a dot or an arrow key sets that level through the same save as the effort
 * card. Levels the draft seems to want above the one set ring and pulse, with a short note, until a press or a change of
 * draft. While a turn runs the dots bounce, and they are also Stop: pointing at them or reaching them with Tab shows the
 * Stop button they hold.
 */
export function EffortDots({ levels, value, disabled, pending = false, describedBy, suggestion, onChange, stop, provider }: {
  readonly levels: readonly string[]
  /** Whose colour the dots take. */
  readonly provider?: string | undefined
  readonly value: string
  readonly disabled: boolean
  readonly pending?: boolean
  readonly describedBy?: string | undefined
  /** An index into `levels` above the one set, or null. */
  readonly suggestion: number | null
  readonly onChange: (level: string) => void
  readonly stop?: DotsStop | undefined
}): ReactNode {
  const current = levels.indexOf(value)
  const [noted, setNoted] = useState<number | null>(null)
  // The note shows for a moment each time a new suggestion arrives; the rings stay while it stands.
  useEffect(() => {
    if (suggestion === null) { setNoted(null); return }
    setNoted(suggestion)
    const timer = window.setTimeout(() => setNoted(null), 2400)
    return () => window.clearTimeout(timer)
  }, [suggestion])
  const set = (index: number): void => {
    const level = levels[Math.max(0, Math.min(levels.length - 1, index))]
    if (level !== undefined && level !== value && !disabled) onChange(level)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key]
    // From the provider's default, either arrow lands on the first level the model offers.
    if (step !== undefined) { event.preventDefault(); set(current < 0 ? 0 : current + step); return }
    if (event.key === 'Home') { event.preventDefault(); set(0) }
    if (event.key === 'End') { event.preventDefault(); set(levels.length - 1) }
  }
  const shown = current >= 0 ? effortLabel(levels[current]!) : t`Provider default`
  const suggested = suggestion === null ? null : effortLabel(levels[suggestion]!)
  const label = OPTION_CHIP_NAMES.effort
  return <span className="effort-dots" data-provider={provider} data-pending={pending || undefined} data-stop={stop ? true : undefined}>
    <span className="effort-dots__hold">
    {levels.length > 0 ? <span className="effort-dots__track tt-focusable" role="slider" tabIndex={disabled ? -1 : 0} aria-label={label}
      aria-valuemin={current >= 0 ? 1 : 0} aria-valuemax={levels.length} aria-valuenow={current + 1} aria-valuetext={shown}
      aria-disabled={disabled || undefined} aria-describedby={pending ? describedBy : undefined} title={`${label}: ${shown}`} onKeyDown={onKeyDown}
      onClick={event => {
        const dot = (event.target as Element).closest<HTMLElement>('[data-level]')
        if (dot) set(Number(dot.dataset.level))
      }}>
      {levels.map((level, index) => <i key={level} data-level={index} data-lit={index <= current || undefined}
        data-suggested={suggestion !== null && index > current && index <= suggestion || undefined} />)}
    </span> : null}
    {stop ? <button type="button" className="effort-dots__stop tt-focusable" aria-label={stop.label} aria-keyshortcuts={stop.keys} title={stop.title}
      disabled={stop.disabled} onClick={stop.onStop}><Square size={10} fill="currentColor" aria-hidden="true" /></button> : null}
    </span>
    {/* Always present, so assistive technology hears a suggestion when it arrives. */}
    <span className="effort-dots__note" role="status" data-shown={noted !== null || undefined}>
      {suggested === null ? '' : t({ message: `Suggests ${suggested}. Press a ringed dot to use it.`, comment: '{suggested} is a reasoning effort level, such as High.' })}
    </span>
  </span>
}
