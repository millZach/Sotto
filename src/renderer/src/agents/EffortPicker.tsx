import React, { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { ChevronDown } from 'lucide-react'
import { rootStyleUnchanged, THEME_TOKEN_PROBE_ATTRIBUTE } from '../state/appearance'
import { furnaceGold, paintFurnace, type FurnaceColor } from './effortFurnace'
import './effortPicker.css'

interface EffortOption { readonly id: string; readonly label: string; readonly disabled?: boolean }
const effortLabel = (value: string): string => value === 'xhigh' ? 'Extra high' : value.charAt(0).toUpperCase() + value.slice(1)

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

/** The loop is awake only during interaction, then leaves a still painting until the next change. */
function useFurnace(canvas: RefObject<HTMLCanvasElement | null>, panel: RefObject<HTMLDivElement | null>, thumb: RefObject<HTMLSpanElement | null>, position: number, count: number, top: boolean, dragging: boolean, still: boolean): void {
  const painted = useRef(position)
  const heat = useRef(position / Math.max(1, count - 1))
  useEffect(() => {
    const element = canvas.current, surface = panel.current
    if (!element || !surface) return
    const context = element.getContext('2d')
    if (!context) return
    let raf = 0, width = 0, height = 0, previous = performance.now(), started = previous, awake = previous + 4200
    const colors = {} as Record<FurnaceColor, string>
    const palette = (): void => {
      const probe = document.createElement('span')
      probe.hidden = true
      probe.setAttribute(THEME_TOKEN_PROBE_ATTRIBUTE, '')
      surface.append(probe)
      for (const key of ['track', 'fill', 'gold', 'highlight', 'shadow', 'fire', 'warm', 'core'] as const) {
        probe.style.color = `var(--tt-effort-${key})`
        colors[key] = getComputedStyle(probe).color
      }
      probe.remove()
    }
    const draw = (now: number): void => {
      raf = 0
      const dt = Math.min(64, now - previous)
      previous = now
      painted.current = still || dragging ? position : painted.current + (position - painted.current) * (1 - Math.exp(-dt / 55))
      if (Math.abs(painted.current - position) < .0005) painted.current = position
      const wantedHeat = position / Math.max(1, count - 1)
      heat.current = still ? wantedHeat : heat.current + (wantedHeat - heat.current) * (1 - Math.exp(-dt / 120))
      const elapsed = top && !dragging ? still ? 4 : (now - started) / 1000 : null
      const gold = furnaceGold(elapsed)
      surface.style.setProperty('--effort-forge', `${gold * 100}%`)
      surface.dataset.gold = String(gold === 1)
      paintFurnace(context, width, height, colors, { position: painted.current, heat: heat.current, count, elapsed, now, moving: !still && now < awake })
      if (thumb.current) thumb.current.style.left = `${8 + (width - 16) * painted.current / Math.max(1, count - 1)}px`
      if (!still && (now < awake || painted.current !== position)) raf = requestAnimationFrame(draw)
    }
    const wake = (): void => {
      awake = performance.now() + 4200
      if (!raf) raf = requestAnimationFrame(draw)
    }
    const resize = (): void => {
      const box = element.getBoundingClientRect()
      width = box.width; height = box.height
      const dpr = window.devicePixelRatio || 1
      element.width = Math.round(width * dpr); element.height = Math.round(height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      palette(); wake()
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(element)
    const themeObserver = new MutationObserver(records => { if (rootStyleUnchanged(records, document.documentElement)) return; palette(); wake() })
    themeObserver.observe(document.documentElement, { attributes: true, attributeOldValue: true, attributeFilter: ['style', 'class', 'data-theme', 'data-appearance'] })
    const visibility = (): void => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0 }
      else { started = performance.now() - 4200; wake() }
    }
    document.addEventListener('visibilitychange', visibility)
    resize()
    return () => { cancelAnimationFrame(raf); resizeObserver.disconnect(); themeObserver.disconnect(); document.removeEventListener('visibilitychange', visibility) }
  }, [canvas, panel, thumb, position, count, top, dragging, still])
}

function EffortSurface({ value, options, disabled, onChange, onUltrathink, hasUltrathink, close, id, trigger }: {
  value: string; options: readonly EffortOption[]; disabled: boolean; onChange: (id: string) => Promise<boolean>
  onUltrathink?: (() => void) | undefined; hasUltrathink?: boolean | undefined; close: () => void; id: string; trigger: RefObject<HTMLButtonElement | null>
}): ReactNode {
  const choices = options.filter(option => !option.disabled)
  const actual = choices.findIndex(option => option.id === value)
  const [position, setPosition] = useState(Math.max(0, actual))
  const [known, setKnown] = useState(actual >= 0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const panel = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  const range = useRef<HTMLInputElement>(null)
  const still = useStill()
  const selected = Math.round(position)
  const choice = choices[selected]
  const highest = known && choices.length > 1 && selected === choices.length - 1
  const label = choice ? effortLabel(choice.id) : 'Provider default'
  useFurnace(canvas, panel, thumb, position, choices.length, highest, dragging, still)
  useEffect(() => { if (!pending.current) { setPosition(Math.max(0, actual)); setKnown(actual >= 0) } }, [actual])
  useEffect(() => {
    if (!disabled || !drag.current) return
    drag.current = false; setDragging(false); setPosition(Math.max(0, actual)); setKnown(actual >= 0)
  }, [disabled, actual])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
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
    let placementFrame = 0
    const schedulePlace = (): void => {
      cancelAnimationFrame(placementFrame)
      // Window resize arrives before the composer's flex layout has settled in Electron.
      placementFrame = requestAnimationFrame(place)
    }
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedulePlace)
    observer?.observe(surface)
    if (trigger.current) {
      observer?.observe(trigger.current)
      // A capped composer can move without changing its own size. Watch the layout that places it.
      for (let ancestor = trigger.current.parentElement; ancestor; ancestor = ancestor.parentElement) observer?.observe(ancestor)
    }
    window.addEventListener('resize', schedulePlace)
    window.addEventListener('scroll', schedulePlace, true)
    range.current?.focus()
    return () => { cancelAnimationFrame(placementFrame); observer?.disconnect(); window.removeEventListener('resize', schedulePlace); window.removeEventListener('scroll', schedulePlace, true); surface.hidePopover?.() }
  }, [trigger])
  const choose = async (index: number): Promise<void> => {
    if (disabled || pending.current) return
    const next = Math.max(0, Math.min(choices.length - 1, index)), option = choices[next]
    if (!option) return
    setPosition(next); setKnown(true); setDragging(false); drag.current = false
    if (option.id === value) return
    pending.current = true
    let saved = false
    try { saved = await onChange(option.id) } catch { saved = false } finally {
      pending.current = false
      if (!saved && mounted.current) { setPosition(Math.max(0, actual)); setKnown(actual >= 0) }
    }
  }
  const description = !known ? `${value ? effortLabel(value) : 'Provider default'} is set. Choose a supported level.`
    : highest ? 'Highest model reasoning effort.'
      : choice?.id === 'low' || choice?.id === 'minimal' ? 'Quick, focused reasoning.'
        : choice?.id === 'medium' ? 'Balanced reasoning.' : 'More time for difficult problems.'
  return <div ref={panel} id={id} popover={typeof HTMLElement.prototype.showPopover === 'function' ? 'manual' : undefined} role="dialog" aria-label="Reasoning effort" className="effort-picker" data-still={still} data-gold="false">
    <div className="effort-picker__drawing">
      <canvas ref={canvas} aria-hidden="true" /><span ref={thumb} className="effort-picker__thumb" aria-hidden="true" />
      <input ref={range} type="range" aria-label="Thread reasoning effort" aria-valuetext={known ? label : value ? effortLabel(value) : 'Provider default'} aria-valuenow={selected}
        aria-describedby={`${id}-description`} aria-disabled={disabled || choices.length === 0} min={0} max={Math.max(0, choices.length - 1)} step={.001} value={position}
        onPointerDown={event => { if (disabled) { event.preventDefault(); return } drag.current = true; setDragging(true); event.currentTarget.setPointerCapture?.(event.pointerId) }}
        onPointerUp={event => { if (!drag.current) return; drag.current = false; setDragging(false); void choose(Math.round(Number(event.currentTarget.value))) }}
        onPointerCancel={() => { drag.current = false; setDragging(false); setPosition(Math.max(0, actual)); setKnown(actual >= 0) }}
        onChange={event => { if (disabled) return; const next = Number(event.target.value); if (drag.current) { setPosition(next); setKnown(true) } else void choose(Math.round(next)) }}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); return }
          const keys = ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']
          if (!keys.includes(event.key)) return
          event.preventDefault(); event.stopPropagation()
          const up = ['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key)
          void choose(event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : selected + (up ? 1 : -1))
        }} />
    </div>
    <div className="effort-picker__stops" role="group" aria-label="Choose effort level" style={{ '--effort-count': choices.length } as CSSProperties}>
      {choices.map((option, index) => {
        const active = known && selected === index
        const tier = index === choices.length - 1 || ['max', 'ultra'].includes(option.id) ? 'forge' : option.id === 'xhigh' ? 'ripple' : option.id === 'high' ? 'spark' : 'rise'
        return <button type="button" key={option.id} aria-label={`${effortLabel(option.id)} effort`} aria-pressed={active} aria-disabled={disabled} className="tt-focusable"
          data-tier={tier} data-highest={active && highest} onClick={() => void choose(index)}>
          <span className="effort-picker__word" key={String(active)} aria-hidden="true">{Array.from(effortLabel(option.id), (letter, i) => <span key={i} style={{ '--letter': i } as CSSProperties}>{letter === ' ' ? '\u00a0' : letter}</span>)}</span>
          {active && ['forge', 'ripple', 'spark'].includes(tier) && <span className="effort-picker__sparks" aria-hidden="true">{Array.from({ length: tier === 'forge' ? 18 : 9 }, (_, i) => <i key={i} style={{ left: `${(i * .61803398875 % 1) * 100}%`, '--spark-x': `${(i % 2 ? 1 : -1) * (3 + i % 5 * 2)}px`, '--spark-y': `${-(9 + i * 7 % 17)}px`, '--spark-delay': `${130 + i * 43 % 430}ms` } as CSSProperties} />)}</span>}
        </button>
      })}
    </div>
    <p id={`${id}-description`} className="effort-picker__description">{description}</p>
    {onUltrathink && <button type="button" className="effort-picker__think tt-focusable" disabled={hasUltrathink} onClick={onUltrathink} aria-label={hasUltrathink ? 'Ultrathink is in this prompt' : 'Add Ultrathink to prompt'}>{hasUltrathink ? 'Ultrathink is in this prompt' : 'Add Ultrathink to prompt'}</button>}
    <button type="button" className="effort-picker__done tt-focusable" onClick={close}>Done</button>
  </div>
}

/** A preview is local until release. The provider remains authoritative for supported values and saves. */
export function EffortPicker({ value, options, disabled, onChange, onUltrathink, hasUltrathink }: {
  readonly value: string; readonly options: readonly EffortOption[]; readonly disabled: boolean; readonly onChange: (id: string) => Promise<boolean>
  readonly onUltrathink?: (() => void) | undefined; readonly hasUltrathink?: boolean | undefined
}): ReactNode {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const id = useId()
  const returnFocus = useRef(false)
  const close = (): void => { returnFocus.current = true; setOpen(false) }
  useLayoutEffect(() => {
    // Hide the native popover before restoring focus; a pending save temporarily disables the chip.
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
  return <div ref={wrapper} className="thread-chip-menu effort-picker-anchor"
    onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}
    onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
    <button ref={trigger} type="button" role="combobox" aria-label="Thread reasoning" title="Thread reasoning" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      className="thread-chip tt-focusable" disabled={disabled} onClick={() => setOpen(current => !current)}>
      <span>{value ? effortLabel(value) : 'Effort'}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && <EffortSurface value={value} options={options} disabled={disabled} onChange={onChange} onUltrathink={onUltrathink} hasUltrathink={hasUltrathink} close={close} id={id} trigger={trigger} />}
  </div>
}
