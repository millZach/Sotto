import React, { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { OPTION_CHIP_NAMES } from './optionChipNames'
import './effortPicker.css'

interface EffortOption { readonly id: string; readonly label: string; readonly disabled?: boolean }
export const effortLabel = (value: string): string => value === 'xhigh' ? 'Extra high' : value.charAt(0).toUpperCase() + value.slice(1)

/** One line per level: what it does and what it costs. The top of any list gets the top line, whatever its name. */
const EFFORT_LINES: Record<string, string> = {
  minimal: 'Fastest. For the smallest tasks.',
  low: 'Fast. For small, clear tasks.',
  medium: 'The usual balance of speed and care.',
  high: 'Takes longer and catches more.',
  xhigh: 'Much longer. For stubborn problems.',
  max: "Near the model's limit. Slow and costly.",
}
const TOP_LINE = 'Everything the model has. Slowest, costliest.'
export function effortLine(id: string, index: number, count: number): string {
  if (count > 1 && index === count - 1) return TOP_LINE
  return EFFORT_LINES[id] ?? (index === 0 ? EFFORT_LINES.low! : 'More time for difficult problems.')
}

/** How long the arrival at the top level plays: the wash through the card and the composer, then the letters settle. */
const ARRIVAL_MS = 1900
/** A drag within this much of a stop is drawn toward it, so the thumb settles on levels rather than between them. */
const MAGNET = 0.2

function useStill(): boolean {
  const read = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.reducedMotion === 'on'
  const [still, setStill] = useState(read)
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const update = (): void => setStill(read())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    media?.addEventListener('change', update)
    return () => { observer.disconnect(); media?.removeEventListener('change', update) }
  }, [])
  return still
}

/**
 * Eases the painted position toward the chosen one and writes it to the card as `--effort-x`, which the fill,
 * thumb and dots read. The first write lands before the card's first paint, so it opens at the saved level
 * rather than flashing from the left; a drag paints where the hand is; reduced motion snaps. The loop sleeps
 * once settled.
 */
function usePaintedPosition(panel: RefObject<HTMLDivElement | null>, position: number, count: number, dragging: boolean, still: boolean): void {
  const painted = useRef(position)
  useLayoutEffect(() => {
    const surface = panel.current
    if (!surface) return
    let raf = 0, previous = performance.now()
    const write = (): void => {
      const x = count > 1 ? painted.current / (count - 1) : 0
      surface.style.setProperty('--effort-x', x.toFixed(4))
      surface.style.setProperty('--effort-heat', x.toFixed(3))
    }
    const frame = (now: number): void => {
      raf = 0
      const dt = Math.min(64, now - previous)
      previous = now
      painted.current += (position - painted.current) * (1 - Math.exp(-dt / 60))
      if (Math.abs(painted.current - position) < .001) painted.current = position
      write()
      if (painted.current !== position) raf = requestAnimationFrame(frame)
    }
    if (still || dragging || typeof requestAnimationFrame !== 'function') painted.current = position
    write()
    if (painted.current !== position) raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [panel, position, count, dragging, still])
}

/**
 * The arrival at a model's highest level: true for a moment after the saved level reaches the top from
 * below, never on the first level seen or under reduced motion. It lives beside the chip rather than in the
 * card, so closing the card mid-arrival leaves the composer's tide to finish.
 */
function useArrival(top: boolean, still: boolean): boolean {
  const [arriving, setArriving] = useState(false)
  const lastTop = useRef<boolean | null>(null)
  useEffect(() => {
    const was = lastTop.current
    lastTop.current = top
    if (!top || was === null || was || still) { setArriving(false); return }
    setArriving(true)
    const timer = setTimeout(() => setArriving(false), ARRIVAL_MS)
    return () => clearTimeout(timer)
  }, [top, still])
  return arriving
}

/**
 * The card. Its `value` is the level the user last chose rather than the one the provider has confirmed, so
 * every press lands here in the frame it happens; the wrapper owns the save and hands back the saved level
 * if the provider refuses.
 */
function EffortSurface({ value, options, disabled, onChange, onUltrathink, hasUltrathink, defaultValue, modelName, id, trigger, arriving, still }: {
  value: string; options: readonly EffortOption[]; disabled: boolean; onChange: (id: string) => void
  onUltrathink?: (() => void) | undefined; hasUltrathink?: boolean | undefined; defaultValue?: string | undefined; modelName?: string | undefined
  id: string; trigger: RefObject<HTMLButtonElement | null>; arriving: boolean; still: boolean
}): ReactNode {
  const choices = options.filter(option => !option.disabled)
  const count = choices.length
  const actual = choices.findIndex(option => option.id === value)
  /** Where the hand is, while the hand is on the thumb; null the rest of the time, which is most of it. */
  const [held, setHeld] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef(false)
  const panel = useRef<HTMLDivElement>(null)
  const range = useRef<HTMLInputElement>(null)
  /** The stop the chosen level sits on; the first stop while the level set is not one this model offers. */
  const set = Math.max(0, actual)
  /**
   * The thumb is not a copy of the chosen level kept in step with it: a copy has to be told when to catch up,
   * and a press and the answer to it can land in one render, which leaves nothing to notice and the thumb on a
   * level that was refused. It is the chosen level, until a hand lifts it off. Where the hand is says so
   * itself rather than a flag beside it saying so, because the two would not have to arrive together, and a
   * thumb under a hand that is still reading a flag from before the press is a thumb that does not move.
   */
  const position = held ?? set
  const known = actual >= 0 || held !== null
  const selected = Math.round(position)
  const shown = choices[selected]
  const top = known && count > 1 && actual === count - 1
  const defaultIndex = defaultValue === undefined ? -1 : choices.findIndex(option => option.id === defaultValue)
  usePaintedPosition(panel, position, count, dragging, still)
  useEffect(() => {
    if (!disabled || !drag.current) return
    drag.current = false; setDragging(false); setHeld(null)
  }, [disabled])
  useLayoutEffect(() => {
    const surface = panel.current
    if (!surface) return
    surface.showPopover?.()
    const place = (): void => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const width = surface.offsetWidth, height = surface.offsetHeight
      const above = anchor.top - height - 8
      surface.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - width - 12))}px`
      surface.style.top = `${Math.max(12, Math.min(above >= 12 ? above : anchor.bottom + 8, innerHeight - height - 12))}px`
    }
    place()
    // The card follows the chip itself, every frame it is open. Watching what resizes is not enough: the chip
    // moves when a line appears under the composer, when the window resize settles a frame after its event, and
    // when the page scrolls, and none of those resize the chip or anything above it. Placing here, before the
    // frame is painted, also keeps a card that grew — a line that wrapped — from being painted a frame too low.
    let placementFrame = 0
    let placed = ''
    const follow = (): void => {
      placementFrame = requestAnimationFrame(follow)
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      const state = `${anchor.top} ${anchor.left} ${surface.offsetHeight} ${surface.offsetWidth} ${innerHeight} ${innerWidth}`
      if (state === placed) return
      placed = state
      place()
    }
    follow()
    range.current?.focus()
    return () => { cancelAnimationFrame(placementFrame); surface.hidePopover?.() }
  }, [trigger])
  const choose = (index: number): void => {
    if (disabled) return
    const next = Math.max(0, Math.min(count - 1, index)), option = choices[next]
    if (!option) return
    setHeld(null); setDragging(false); drag.current = false
    if (option.id !== value) onChange(option.id)
  }
  // The wheel steps a level. React registers wheel listeners as passive, so the page would scroll behind the card without this.
  useEffect(() => {
    const input = range.current
    if (!input) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (disabled || event.deltaY === 0) return
      const next = Math.max(0, Math.min(count - 1, Math.round(position) + (event.deltaY < 0 ? 1 : -1)))
      if (next !== Math.round(position) || !known) choose(next)
    }
    input.addEventListener('wheel', wheel, { passive: false })
    return () => input.removeEventListener('wheel', wheel)
  })
  const magnet = (raw: number): number => { const near = Math.round(raw), d = raw - near; return Math.abs(d) < MAGNET ? near + d * Math.pow(Math.abs(d) / MAGNET, 2) : raw }
  const word = !known ? (value ? effortLabel(value) : 'Provider default') : effortLabel((dragging ? shown?.id : value) ?? value)
  const line = !known ? `${value ? effortLabel(value) : 'Provider default'} is set. Choose a level this model offers.`
    : effortLine((dragging ? shown?.id : value) ?? value, dragging ? selected : actual, count)
  // The slider announces where the thumb is, so a drag is heard as it moves; the word above follows the same rule.
  const valueText = known ? effortLabel(shown?.id ?? value) : value ? effortLabel(value) : 'Provider default'
  return <div ref={panel} id={id} popover={typeof HTMLElement.prototype.showPopover === 'function' ? 'manual' : undefined} role="dialog" aria-label="Reasoning effort"
    className="effort-card" data-still={still} data-top={top} data-arriving={arriving} data-unknown={!known} data-dragging={dragging}>
    <div className="effort-card__head">
      <p className="effort-card__word" data-top={top && !dragging} data-unknown={!known}>
        {Array.from(word, (letter, index) => <span key={`${word}-${index}`} style={{ '--effort-letter': index } as CSSProperties}>{letter === ' ' ? '\u00a0' : letter}</span>)}
      </p>
      {defaultIndex >= 0 && <button type="button" className="effort-card__default tt-focusable" disabled={disabled || value === defaultValue}
        title={`Use ${modelName ?? 'the model'}'s default, ${effortLabel(defaultValue!)}`} onClick={() => choose(defaultIndex)}>Default</button>}
    </div>
    <p id={`${id}-description`} className="effort-card__line">{line}</p>
    <div className="effort-card__track">
      <div className="effort-card__pill" aria-hidden="true">
        <div className="effort-card__fill" />
        {choices.map((option, index) => <span key={option.id} className="effort-card__dot" data-under={index <= selected} style={{ '--effort-stop': count > 1 ? index / (count - 1) : 0 } as CSSProperties} />)}
      </div>
      <span className="effort-card__thumb" aria-hidden="true" />
      <input ref={range} type="range" aria-label="Thread reasoning effort" aria-valuetext={valueText} aria-valuenow={selected}
        aria-describedby={`${id}-description`} aria-disabled={disabled || count === 0} min={0} max={Math.max(0, count - 1)} step={.001} value={position}
        onPointerDown={event => { if (disabled) { event.preventDefault(); return } drag.current = true; setHeld(set); setDragging(true); event.currentTarget.setPointerCapture?.(event.pointerId) }}
        onPointerUp={event => { if (!drag.current) return; drag.current = false; setDragging(false); choose(Math.round(Number(event.currentTarget.value))) }}
        onPointerCancel={() => { drag.current = false; setDragging(false); setHeld(null) }}
        onChange={event => { if (disabled) return; const next = Number(event.target.value); if (drag.current) setHeld(magnet(next)); else choose(Math.round(next)) }}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); return }
          const digit = /^[1-9]$/u.test(event.key) ? Number(event.key) - 1 : -1
          const steps: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1 }
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : digit >= 0 && digit < count ? digit : steps[event.key] !== undefined ? selected + steps[event.key]! : null
          if (next === null) return
          event.preventDefault(); event.stopPropagation()
          choose(next)
        }} />
    </div>
    <div className="effort-card__ends" aria-hidden="true"><span>Faster</span><span>More thorough</span></div>
    {onUltrathink && <button type="button" className="effort-card__ultrathink tt-focusable" disabled={hasUltrathink} data-on={hasUltrathink} onClick={onUltrathink}
      aria-label={hasUltrathink ? 'Ultrathink is in this prompt' : 'Add Ultrathink to prompt'}>
      <i aria-hidden="true"><Check size={10} strokeWidth={3} /></i>{hasUltrathink ? 'Ultrathink is in this prompt' : 'Add Ultrathink to prompt'}
    </button>}
    <div className="effort-card__wash" aria-hidden="true" />
  </div>
}

/**
 * The effort chip and its card. `value` is the level to show: the one the user last pressed while the provider
 * has not confirmed it (`pendingSettings.ts` holds the press and the save behind it), the provider's own level
 * otherwise. So the whole control — the word, the line, the chip and the arrival — moves from the frame a level
 * is pressed; the provider is still authoritative, so the level it answers with is what remains, and a refusal
 * takes the press back (ADR-0019). The chip wears the colourway at the model's highest level, and the composer
 * around it reads that mark for its outline and this wrapper's arrival mark for its tide.
 */
export function EffortPicker({ value, options, disabled, onChange, onUltrathink, hasUltrathink, defaultValue, modelName }: {
  readonly value: string; readonly options: readonly EffortOption[]; readonly disabled: boolean; readonly onChange: (id: string) => void
  readonly onUltrathink?: (() => void) | undefined; readonly hasUltrathink?: boolean | undefined
  /** The model's own default level, offered as the card's Default button when the model reports one. */
  readonly defaultValue?: string | undefined
  readonly modelName?: string | undefined
}): ReactNode {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const id = useId()
  const returnFocus = useRef(false)
  const close = (): void => { returnFocus.current = true; setOpen(false) }
  const choices = options.filter(option => !option.disabled)
  // Named apart from the card's own `shown`, which is the option under the thumb rather than the level set.
  const level = value
  const top = choices.length > 1 && choices[choices.length - 1]?.id === level
  const still = useStill()
  const arriving = useArrival(top, still)
  useLayoutEffect(() => {
    // Hide the native popover before restoring focus; a turn starting or the provider going away disables the chip.
    if (open || disabled || !returnFocus.current) return
    returnFocus.current = false
    if (!document.activeElement || document.activeElement === document.body || wrapper.current?.contains(document.activeElement)) trigger.current?.focus()
  }, [open, disabled])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [open])
  return <div ref={wrapper} className="thread-chip-menu effort-picker-anchor" data-effort-arriving={arriving}
    onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}
    onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
    <button ref={trigger} type="button" role="combobox" aria-label={OPTION_CHIP_NAMES.effort} title={OPTION_CHIP_NAMES.effort} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      className="thread-chip tt-focusable" data-effort-top={top} disabled={disabled} onClick={() => setOpen(current => !current)}>
      <span>{level ? effortLabel(level) : 'Effort'}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && <EffortSurface value={level} options={options} disabled={disabled} onChange={onChange} onUltrathink={onUltrathink} hasUltrathink={hasUltrathink}
      defaultValue={defaultValue} modelName={modelName} id={id} trigger={trigger} arriving={arriving} still={still} />}
  </div>
}
