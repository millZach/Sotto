import React, { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Square } from 'lucide-react'
import { t } from '@lingui/core/macro'
import { effortLabel } from './EffortPicker'
import { OPTION_CHIP_NAMES } from './optionChipNames'
import './quietComposer.css'

/** Stop, where the quiet composer keeps it while a turn runs: beside the effort dots (ADR-0161). */
export interface DotsStop {
  readonly label: string
  readonly keys?: string | undefined
  readonly title: string
  readonly disabled: boolean
  readonly onStop: () => void
}

/** The thread's speed, where the model offers more than Standard (ADR-0143): the one in force, its name, and a step. */
export interface DotsSpeed {
  readonly value: string
  readonly name: string
  readonly description?: string
  /** Steps to the next offered speed (1) or the one before (-1), wrapping through Standard. */
  readonly onStep: (direction: 1 | -1) => void
}

/**
 * The quiet composer's effort and speed: one dot per level the model offers, lit up to the level set, in the provider's
 * colour at Standard, purple at Fast and a brighter purple with a soft glow at Ultra fast (ADR-0161). It is a single
 * slider: a press on another dot or an arrow key sets that level through the same save as the effort card, and a press on
 * the selected dot or Alt with Up or Down steps the speed. Levels the draft seems to want above the one set ring, with a
 * short note, until a press or a change of draft. The dots stay still. While a turn runs a small Stop stays beside them.
 */
export function EffortDots({ levels, value, disabled, pending = false, describedBy, suggestion, onChange, stop, provider, speed }: {
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
  /** Absent where the model offers no speed but Standard, so the dots keep the provider's colour. */
  readonly speed?: DotsSpeed | undefined
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
    // Alt with Up or Down steps the speed; with Cmd or Ctrl as well it is the next or previous thread.
    if (speed && event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      event.stopPropagation()
      if (!disabled) speed.onStep(event.key === 'ArrowUp' ? 1 : -1)
      return
    }
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key]
    // From the provider's default, either arrow lands on the first level the model offers.
    if (step !== undefined) { event.preventDefault(); set(current < 0 ? 0 : current + step); return }
    if (event.key === 'Home') { event.preventDefault(); set(0) }
    if (event.key === 'End') { event.preventDefault(); set(levels.length - 1) }
  }
  /** A level in words, with the thread's speed where the model offers one: "High · Fast". */
  const named = (level: string): string => {
    const effort = effortLabel(level)
    if (!speed) return effort
    const name = speed.name
    return t({ message: `${effort} · ${name}`, comment: 'An effort dot\'s tooltip and value: {effort} is a reasoning effort level, such as High; {name} is the thread\'s speed, such as Fast or Standard.' })
  }
  const shown = current >= 0 ? named(levels[current]!) : speed ? `${t`Provider default`} · ${speed.name}` : t`Provider default`
  const suggested = suggestion === null ? null : effortLabel(levels[suggestion]!)
  const label = OPTION_CHIP_NAMES.effort
  return <span className="effort-dots" data-provider={provider} data-speed={speed?.value} data-pending={pending || undefined} data-stop={stop ? true : undefined}>
    <span className="effort-dots__hold">
    {levels.length > 0 ? <span className="effort-dots__track tt-focusable" role="slider" tabIndex={disabled ? -1 : 0} aria-label={label}
      aria-valuemin={current >= 0 ? 1 : 0} aria-valuemax={levels.length} aria-valuenow={current + 1} aria-valuetext={shown}
      aria-keyshortcuts={speed ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      aria-disabled={disabled || undefined} aria-describedby={pending ? describedBy : undefined} title={`${label}: ${shown}`} onKeyDown={onKeyDown}
      onClick={event => {
        const dot = (event.target as Element).closest<HTMLElement>('[data-level]')
        if (!dot) return
        const index = Number(dot.dataset.level)
        // The selected dot steps the speed; any other sets its level.
        if (index === current && speed) { if (!disabled) speed.onStep(1) } else set(index)
      }}>
      {levels.map((level, index) => <i key={level} data-level={index} data-lit={index <= current || undefined} title={speed?.description ? `${named(level)}. ${speed.description}` : named(level)}
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
