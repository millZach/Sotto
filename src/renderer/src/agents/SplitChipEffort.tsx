import React, { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Zap } from 'lucide-react'
import { t } from '@lingui/core/macro'
import { effortLabel } from './EffortPicker'
import { moveListboxFocus } from './listboxKeys'
import { OPTION_CHIP_NAMES } from './optionChipNames'
import { SPEED_STANDARD } from './pendingSettings'
import './quietComposer.css'

/** A speed in the effort list: its id, its name, and what it costs where the provider says. */
export interface SpeedOption { readonly id: string; readonly name: string; readonly description?: string | undefined }

/** The thread's speed, where the model offers more than Standard (ADR-0143): the one in force, every one offered, and a step. */
export interface ChipSpeed {
  readonly value: string
  readonly name: string
  /** Standard first, then each speed the model offers, each with its name and, where the provider says, its cost. */
  readonly options: readonly SpeedOption[]
  readonly onChange: (speed: string) => void
  /** Steps to the next offered speed (1) or the one before (-1), wrapping through Standard. */
  readonly onStep: (direction: 1 | -1) => void
}

/**
 * The quiet composer's effort and speed (ADR-0161): the level in words beside the model, in the same filled chip, and a
 * bolt for speed where the model offers more than Standard: an outline at Standard, one bolt at Fast, two at Ultra fast.
 * A press opens a short list of the levels the model offers and, below it, its speeds; each choice goes through the same
 * save as the effort card. With the chip focused, the arrow keys step the level and Option with Up or Down (Alt on
 * Windows and Linux) steps the speed, as the dots did. Levels the draft seems to want above the one set are marked in the
 * list, and a short note says so for a moment, until a press or a change of draft. Nothing moves at rest.
 */
export function SplitChipEffort({ levels, value, disabled, pending = false, describedBy, suggestion, onChange, speed }: {
  readonly levels: readonly string[]
  readonly value: string
  readonly disabled: boolean
  readonly pending?: boolean
  readonly describedBy?: string | undefined
  /** An index into `levels` above the one set, or null. */
  readonly suggestion: number | null
  readonly onChange: (level: string) => void
  /** Absent where the model offers no speed but Standard, so no bolt is drawn. */
  readonly speed?: ChipSpeed | undefined
}): ReactNode {
  const current = levels.indexOf(value)
  const [open, setOpen] = useState(false)
  const [noted, setNoted] = useState<number | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  // The note shows for a moment each time a new suggestion arrives; the marks in the list stay while it stands.
  useEffect(() => {
    if (suggestion === null) { setNoted(null); return }
    setNoted(suggestion)
    const timer = window.setTimeout(() => setNoted(null), 2400)
    return () => window.clearTimeout(timer)
  }, [suggestion])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    const selected = list.current?.querySelector<HTMLButtonElement>('button[aria-selected="true"]')
    ;(selected ?? list.current?.querySelector<HTMLButtonElement>('button'))?.focus()
    return () => { document.removeEventListener('pointerdown', dismiss, true) }
  }, [open])
  // A turn starting fixes the setting; the chip keeps its focus, as the dots did, and its list closes.
  useEffect(() => { if (disabled && open) { setOpen(false); trigger.current?.focus() } }, [disabled, open])
  const set = (index: number): void => {
    const level = levels[Math.max(0, Math.min(levels.length - 1, index))]
    if (level !== undefined && level !== value && !disabled) onChange(level)
  }
  /** Alt with Up or Down steps the speed, on the chip or anywhere in its list; with Cmd or Ctrl as well it is the next or previous thread. */
  const speedKey = (event: KeyboardEvent<HTMLElement>): boolean => {
    if (!speed || !event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return false
    event.preventDefault()
    event.stopPropagation()
    if (!disabled) speed.onStep(event.key === 'ArrowUp' ? 1 : -1)
    return true
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (speedKey(event) || event.altKey || event.ctrlKey || event.metaKey) return
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key]
    // From the provider's default, either arrow lands on the first level the model offers.
    if (step !== undefined) { event.preventDefault(); set(current < 0 ? 0 : current + step); return }
    if (event.key === 'Home') { event.preventDefault(); set(0) }
    if (event.key === 'End') { event.preventDefault(); set(levels.length - 1) }
  }
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  /** The speeds are one Tab stop: the arrows move the choice along them, as radio buttons do, and save it as they go. */
  const speedArrows = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!speed || event.altKey || event.ctrlKey || event.metaKey) return
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    const at = speed.options.findIndex(option => option.id === speed.value)
    const next = speed.options[(Math.max(0, at) + step + speed.options.length) % speed.options.length]!
    if (!disabled) speed.onChange(next.id)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-speed-id="${next.id}"]`)?.focus()
  }
  const word = current >= 0 ? effortLabel(levels[current]!) : t({ message: 'Default', comment: 'The quiet composer\'s effort word while the thread is on the model\'s own default reasoning effort.' })
  const shown = current >= 0 ? effortLabel(levels[current]!) : t`Provider default`
  const label = OPTION_CHIP_NAMES.effort
  const title = speed ? t({ message: `${label}: ${shown} · ${speed.name}`, comment: 'The effort chip\'s tooltip: {label} is the setting\'s name, {shown} a reasoning effort level such as High, {name} the thread\'s speed such as Fast.' })
    : t({ message: `${label}: ${shown}`, comment: 'A chip\'s tooltip: the setting\'s name, then its value.' })
  const suggested = suggestion === null ? null : effortLabel(levels[suggestion]!)
  const bolts = speed === undefined ? null : speed.value === SPEED_STANDARD ? <Zap size={11} strokeWidth={2} aria-hidden="true" data-off="" />
    : <>{speed.value === 'ultrafast' ? <Zap size={11} strokeWidth={0} fill="currentColor" aria-hidden="true" /> : null}<Zap size={11} strokeWidth={0} fill="currentColor" aria-hidden="true" /></>
  return <span className="split-chip-effort" data-speed={speed?.value} data-pending={pending || undefined}
    onKeyDown={event => {
      if (!open || event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); close()
    }}
    onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}>
    <button ref={trigger} type="button" className="split-chip-effort__trigger tt-focusable" role="combobox" aria-label={label} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? listId : undefined} aria-keyshortcuts={speed ? 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End Alt+ArrowUp Alt+ArrowDown' : 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End'}
      aria-describedby={pending ? describedBy : undefined} title={title} aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown} onClick={() => { if (!disabled) setOpen(value => !value) }}>
      <span className="split-chip-effort__word">{word}</span>
      {speed ? <span className="split-chip-effort__bolts" aria-hidden="true">{bolts}</span> : null}
      {speed ? <span className="tt-visually-hidden">, {speed.name}</span> : null}
    </button>
    {open ? <div ref={panel} id={listId} className="thread-chip-menu__list thread-chip-menu__list--foot split-chip-effort__menu" role="dialog" aria-label={label}>
      <div ref={list} role="listbox" aria-label={t`Reasoning effort`} className="thread-chip-menu__options" onKeyDown={event => { if (!speedKey(event)) moveListboxFocus(event, list.current) }}>
        {levels.map((level, index) => {
          const marked = suggestion !== null && index > current && index <= suggestion
          // The mark is said as the row's description, so the row's name stays the level's.
          return <button type="button" role="option" key={level} aria-selected={index === current} aria-describedby={marked ? `${listId}-suggested` : undefined}
            onClick={() => { set(index); close() }}>
          <span>{effortLabel(level)}{marked ? <small id={index === suggestion ? `${listId}-suggested` : undefined}>{t({ message: 'Suggested for this draft', comment: 'Beside a reasoning effort level the draft seems to want.' })}</small> : null}</span>
          {index === current && <Check size={14} aria-hidden="true" />}</button>
        })}
      </div>
      {speed ? <div className="split-chip-effort__speeds" role="radiogroup" aria-label={OPTION_CHIP_NAMES.fast} onKeyDown={event => { if (!speedKey(event)) speedArrows(event) }}>
        {speed.options.map(option => <button type="button" role="radio" key={option.id} data-speed-id={option.id} aria-checked={option.id === speed.value} title={option.description}
          tabIndex={option.id === speed.value ? 0 : -1} className="tt-focusable"
          onClick={() => { if (option.id !== speed.value) speed.onChange(option.id); close() }}>{option.name}</button>)}
      </div> : null}
    </div> : null}
    {/* Always present, so assistive technology hears a suggestion when it arrives. */}
    <span className="split-chip-effort__note" role="status" data-shown={noted !== null || undefined}>
      {suggested === null ? '' : t({ message: `Suggests ${suggested}. Choose it from the effort list.`, comment: '{suggested} is a reasoning effort level, such as High.' })}
    </span>
  </span>
}
