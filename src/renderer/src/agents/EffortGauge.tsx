import React, { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { Workflow, Zap } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import { effortLabel, effortLine } from './EffortPicker'
import { OPTION_CHIP_NAMES } from './optionChipNames'
import { SPEED_STANDARD } from './pendingSettings'
import type { ChipSpeed } from './SplitChipEffort'
import { useReducedMotion } from '../state/reducedMotion'
import { isTopEffort } from '../../../shared/topEffort'
import { ULTRACODE } from '../../../shared/ultracode'
import './combinedPicker.css'

/** How long Prism Ignition runs after arriving at the highest effort stop. */
const IGNITION_MS = 1450
/** A drag within this much of a stop pulls gently toward it so the gauge lands crisply on levels. */
const MAGNET = 0.2

/**
 * The active model's effort and speed controls, drawn inline inside the combined model picker
 * (Zach's pick: Inline Model Card + Power Gauge + Prism Ignition).
 */
export interface CombinedEffort {
  /** Offered effort levels for the active model, in order. */
  readonly levels: readonly string[]
  /** Current effort level (pending press or confirmed value). */
  readonly value: string
  /** True while the setting cannot change (running turn, locked thread, or model without levels). */
  readonly disabled: boolean
  /** Why effort stays fixed, when a provider or model routing holds it. */
  readonly lockedReason?: string | undefined
  /** Index into `levels` suggested for the current draft (ADR-0172), or null. */
  readonly suggestion: number | null
  /** Level Ultracode runs at (ADR-0148), named on the card's line when Ultracode is chosen. */
  readonly ultracodeEffort?: string | undefined
  readonly onChange: (level: string) => void
  /** Speed tiers besides Standard, when the active model offers any (ADR-0143). */
  readonly speed?: ChipSpeed | undefined
  /** True while speed cannot change. */
  readonly speedDisabled?: boolean | undefined
  /** True while model routing chooses both model and effort (ADR-0207). */
  readonly routed?: boolean | undefined
  /**
   * Whether picking `modelId` keeps the combined picker open so the newly chosen model expands
   * inline. Defaults to true; returns false for continuation handovers and Watcher replacements.
   */
  readonly stayOpenOnModel?: ((modelId: string) => boolean) | undefined
}

/**
 * Fires once when `highest` rises from false to true on the same model, never on first mount
 * or under reduced motion. Switching models resets the baseline so opening a model already at
 * its top level settles quietly.
 */
function usePrismIgnition(modelKey: string, highest: boolean, still: boolean): boolean {
  const [arriving, setArriving] = useState(false)
  const last = useRef<{ readonly modelKey: string; readonly highest: boolean } | null>(null)
  useEffect(() => {
    const previous = last.current
    last.current = { modelKey, highest }
    if (!highest || still || previous === null || previous.modelKey !== modelKey || previous.highest) {
      setArriving(false)
      return
    }
    setArriving(true)
    const timer = setTimeout(() => setArriving(false), IGNITION_MS)
    return () => clearTimeout(timer)
  }, [modelKey, highest, still])
  return arriving
}

/**
 * The expanded inline card for the active model inside the combined picker: its clickable model
 * header row, the Power Gauge effort slider with Prism Ignition at the highest tier, and the
 * speed switch when the model offers faster tiers.
 */
export function InlineModelCard({ modelKey, header, expanded, effort, sliderRef, cardRef }: {
  readonly modelKey: string
  readonly header: ReactNode
  readonly expanded: boolean
  readonly effort: CombinedEffort
  readonly sliderRef?: RefObject<HTMLInputElement | null> | undefined
  readonly cardRef?: RefObject<HTMLDivElement | null> | undefined
}): ReactNode {
  const { t } = useLingui()
  const still = useReducedMotion()
  const descId = useId()
  const localRange = useRef<HTMLInputElement>(null)
  const range = sliderRef ?? localRange
  const levels = effort.levels
  const count = levels.length
  const defaultOnly = count === 1 && levels[0] === 'default'
  const editableEffort = !effort.routed && !effort.disabled && !defaultOnly && count > 1
  const actual = levels.indexOf(effort.value)
  const setIndex = Math.max(0, actual)
  const [held, setHeld] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef(false)
  // Reset any in-flight drag when the model changes or effort becomes fixed.
  useEffect(() => {
    drag.current = false
    setDragging(false)
    setHeld(null)
  }, [modelKey, editableEffort])

  const position = held ?? setIndex
  const known = actual >= 0 || held !== null
  const rounded = Math.max(0, Math.min(Math.max(0, count - 1), Math.round(position)))
  const shownId = (dragging ? levels[rounded] : effort.value) ?? effort.value
  const shownIndex = dragging ? rounded : actual
  const x = count > 1 ? position / (count - 1) : 0
  const top = !effort.routed && !defaultOnly && known && count > 1 && isTopEffort(levels, shownId)
  const highest = !effort.routed && !defaultOnly && known && count > 1 && shownIndex === count - 1
  const committedHighest = !effort.routed && !defaultOnly && actual >= 0 && count > 1 && actual === count - 1
  const arriving = usePrismIgnition(modelKey, committedHighest, still)

  const choose = (index: number): void => {
    if (!editableEffort) return
    const next = Math.max(0, Math.min(count - 1, index))
    const id = levels[next]
    setHeld(null)
    setDragging(false)
    drag.current = false
    if (id !== undefined && id !== effort.value) effort.onChange(id)
  }

  // Wheel over the Power Gauge steps one effort level without scrolling the model list behind it.
  useEffect(() => {
    const input = range.current
    if (!input) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (!editableEffort || event.deltaY === 0) return
      const next = !known ? 0 : Math.max(0, Math.min(count - 1, Math.round(position) + (event.deltaY < 0 ? 1 : -1)))
      if (next !== Math.round(position) || !known) choose(next)
    }
    input.addEventListener('wheel', wheel, { passive: false })
    return () => input.removeEventListener('wheel', wheel)
  })

  const magnet = (raw: number): number => {
    const near = Math.round(raw)
    const d = raw - near
    return Math.abs(d) < MAGNET ? near + d * Math.pow(Math.abs(d) / MAGNET, 2) : raw
  }

  const speedKey = (event: KeyboardEvent<HTMLElement>): boolean => {
    const speed = effort.speed
    if (!speed || effort.speedDisabled || !event.altKey || event.ctrlKey || event.metaKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return false
    event.preventDefault()
    event.stopPropagation()
    speed.onStep(event.key === 'ArrowUp' ? 1 : -1)
    return true
  }

  const speedArrows = (event: KeyboardEvent<HTMLDivElement>): void => {
    const speed = effort.speed
    if (!speed || speedKey(event) || event.altKey || event.ctrlKey || event.metaKey) return
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const at = speed.options.findIndex(option => option.id === speed.value)
    const next = speed.options[(Math.max(0, at) + step + speed.options.length) % speed.options.length]!
    if (!effort.speedDisabled) speed.onChange(next.id)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-speed-id="${next.id}"]`)?.focus()
  }

  const setLevel = effort.value ? effortLabel(effort.value) : t`Default`
  const word = effort.routed ? t({ message: 'Auto', comment: 'On a routed thread\'s effort display: model routing chooses the effort.' })
    : !known ? setLevel : effortLabel(shownId)
  const line = effort.routed ? (effort.lockedReason ?? t`Model routing chooses the effort.`)
    : effort.lockedReason ? effort.lockedReason
      : count === 0 ? t`No effort levels.`
        : !known ? t({ message: `${setLevel} is set. Choose a level this model offers.`, comment: '{setLevel} is a reasoning effort level, or "Provider default".' })
          : effortLine(shownId, shownIndex, count, effort.ultracodeEffort)
  const valueText = known ? effortLabel(levels[rounded] ?? effort.value) : setLevel
  const cellCenter = count > 0 ? `${((rounded + 0.5) / count) * 100}%` : '50%'
  const showGauge = !effort.routed && !defaultOnly && count > 1 && !effort.lockedReason
  const wordUltracode = !effort.routed && known && shownId === ULTRACODE
  const heat = effort.routed || !known ? 0 : x

  return <div ref={cardRef} className="inline-model-card" data-collapsed={!expanded || undefined}
    data-top={top} data-highest={highest} data-arriving={arriving} data-dragging={dragging} data-still={still}
    style={{ '--effort-x': x.toFixed(4), '--effort-heat': heat.toFixed(3), '--effort-cell-center': cellCenter } as CSSProperties}
    onKeyDown={event => { if (expanded) speedKey(event) }}>
    <div className="inline-model-card__sheen" aria-hidden="true" />
    <div className="inline-model-card__comet" aria-hidden="true"><div className="inline-model-card__comet-spin" /></div>

    <div className="inline-model-card__content">
      {header}

      {expanded && <div className="effort-gauge">
        {(count > 0 || effort.routed || effort.lockedReason) ? <div className="effort-gauge__head">
          <p className="effort-gauge__word" data-top={top && !dragging}>
            {wordUltracode ? <Workflow className="effort-gauge__mark" size={13} aria-hidden="true" /> : null}
            {Array.from(word, (letter, index) => <span key={`${word}-${index}`} style={{ '--effort-letter': index } as CSSProperties}>{letter === ' ' ? '\u00a0' : letter}</span>)}
          </p>
          <p id={descId} className="effort-gauge__line">{line}</p>
        </div> : null}

        {showGauge ? <>
          <div className="effort-gauge__track">
            <span className="effort-gauge__shockwave" aria-hidden="true" />
            <span className="effort-gauge__shockwave effort-gauge__shockwave--2" aria-hidden="true" />
            <div className="effort-gauge__cells" aria-hidden="true" style={{ '--cell-count': count } as CSSProperties}>
              {levels.map((level, index) => {
                const pos = count > 1 ? `${(index / (count - 1)) * 100}%` : '100%'
                const lit = known && index <= rounded
                const head = known && index === rounded
                return <span key={level} className="effort-gauge__cell" data-lit={lit} data-head={head}
                  style={{ '--cell-pos': pos } as CSSProperties} />
              })}
            </div>
            <input ref={range} className="effort-gauge__range" type="range"
              aria-label={t`Thread reasoning effort`} aria-valuetext={valueText} aria-valuenow={rounded}
              aria-describedby={descId} aria-disabled={!editableEffort || undefined}
              disabled={!editableEffort} min={0} max={Math.max(0, count - 1)} step={0.001} value={position}
              onPointerDown={event => {
                if (!editableEffort) { event.preventDefault(); return }
                drag.current = true
                setHeld(setIndex)
                setDragging(true)
                event.currentTarget.setPointerCapture?.(event.pointerId)
              }}
              onPointerUp={event => {
                if (!drag.current) return
                drag.current = false
                setDragging(false)
                choose(Math.round(Number(event.currentTarget.value)))
              }}
              onPointerCancel={() => { drag.current = false; setDragging(false); setHeld(null) }}
              onChange={event => {
                if (!editableEffort) return
                const next = Number(event.target.value)
                if (drag.current) setHeld(magnet(next))
                else choose(Math.round(next))
              }}
              onKeyDown={event => {
                if (speedKey(event)) return
                if (event.altKey || event.ctrlKey || event.metaKey) return
                if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); return }
                const digit = /^[1-9]$/u.test(event.key) ? Number(event.key) - 1 : -1
                const steps: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1 }
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : digit >= 0 && digit < count ? digit
                  : steps[event.key] !== undefined ? (!known ? 0 : rounded + steps[event.key]!) : null
                if (next === null) return
                event.preventDefault()
                event.stopPropagation()
                choose(next)
              }} />
          </div>
          <div className="effort-gauge__stops">
            {levels.map((level, index) => {
              const label = effortLabel(level)
              const active = known && index === rounded
              const suggested = effort.suggestion === index
              const levelTop = isTopEffort(levels, level)
              return <button key={level} type="button" className="effort-gauge__stop tt-focusable" tabIndex={-1}
                disabled={!editableEffort} data-active={active || undefined} data-top={levelTop || undefined} data-suggested={suggested || undefined}
                title={suggested ? t({ message: `${label} — suggested for this draft`, comment: '{label} is a reasoning effort level, such as High.' }) : label}
                onClick={() => choose(index)}>
                <span>{label}</span>
              </button>
            })}
          </div>
        </> : null}
      </div>}

      {expanded && effort.speed && effort.speed.options.length > 1 ? <div className="inline-model-card__speed">
        <span className="inline-model-card__speed-label">{t({ message: 'Speed', comment: 'Label beside the speed segmented switch inside the combined model picker.' })}</span>
        <div className="inline-model-card__speeds" role="radiogroup" aria-label={OPTION_CHIP_NAMES.fast} onKeyDown={speedArrows}>
          {effort.speed.options.map(option => {
            const checked = option.id === effort.speed!.value
            const fast = option.id !== SPEED_STANDARD
            return <button key={option.id} type="button" role="radio" data-speed-id={option.id} data-fast={fast || undefined}
              aria-checked={checked} title={option.description} tabIndex={checked ? 0 : -1} disabled={effort.speedDisabled}
              className="tt-focusable"
              onClick={() => { if (!effort.speedDisabled && option.id !== effort.speed!.value) effort.speed!.onChange(option.id) }}>
              {option.id === 'fast' ? <Zap size={11} strokeWidth={0} fill="currentColor" aria-hidden="true" /> : null}
              {option.id === 'ultrafast' ? <span className="inline-model-card__double-bolt" aria-hidden="true"><Zap size={11} strokeWidth={0} fill="currentColor" /><Zap size={11} strokeWidth={0} fill="currentColor" /></span> : null}
              <span>{option.name}</span>
            </button>
          })}
        </div>
      </div> : null}
    </div>
  </div>
}
