/*
 * One colour row in the theme editor: its label, a swatch that opens an
 * HSV picker, and a hex field.
 *
 * Ported from T3 Code's apps/web/src/components/settings/ThemeColorPicker.tsx
 * at commit d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3. MIT License, Copyright
 * (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md. The picker opens inline
 * under its row instead of in a popover. Pressing a row's label shows where
 * that colour is used (see themeInspector.ts).
 */

import React, { memo, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

import { parseThemeColor, themeColorToHex } from '../../../../../shared/themes/color'
import type { ThemeColorRole } from '../../../../../shared/themes/library'

const ROLE_LABELS: Partial<Record<ThemeColorRole, string>> = {
  canvas: 'Background',
  toolbar: 'Toolbar background',
  toolbarForeground: 'Toolbar text',
  toolbarBorder: 'Toolbar border',
  toolbarControl: 'Toolbar control',
  toolbarControlForeground: 'Toolbar control text',
  toolbarControlHover: 'Toolbar control hover',
  accent: 'Accent color',
  errorForeground: 'Error text',
  errorSurface: 'Error background',
  warningForeground: 'Warning text',
  warningSurface: 'Warning background',
  updateForeground: 'Update text',
  updateSurface: 'Update background',
}

export function themeRoleLabel(role: ThemeColorRole): string {
  return ROLE_LABELS[role] ?? role.replace(/([A-Z])/gu, ' $1').replace(/^./u, character => character.toUpperCase())
}

export function isEditorColor(value: string): boolean {
  return parseThemeColor(value.trim()) !== null
}

interface Hsv { readonly h: number; readonly s: number; readonly v: number }

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

function pickerHex(value: string): string {
  return (themeColorToHex(value) ?? '#000000').slice(0, 7)
}

/** Alpha travels separately so moving hue or brightness never changes transparency. */
function alphaSuffix(value: string): string {
  const hex = themeColorToHex(value) ?? ''
  const alpha = hex.length === 9 ? hex.slice(7) : ''
  return alpha === 'ff' ? '' : alpha
}

function hexToHsv(hex: string): Hsv {
  const numeric = Number.parseInt(pickerHex(hex).slice(1), 16)
  const red = ((numeric >> 16) & 255) / 255
  const green = ((numeric >> 8) & 255) / 255
  const blue = (numeric & 255) / 255
  const max = Math.max(red, green, blue)
  const delta = max - Math.min(red, green, blue)
  let hue = 0
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6
    else if (max === green) hue = (blue - red) / delta + 2
    else hue = (red - green) / delta + 4
    hue *= 60
    if (hue < 0) hue += 360
  }
  return { h: hue, s: max === 0 ? 0 : delta / max, v: max }
}

function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360
  const chroma = v * s
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const match = v - chroma
  const [red, green, blue] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x]
  return `#${[red, green, blue].map(channel => Math.round((channel + match) * 255).toString(16).padStart(2, '0')).join('')}`
}

function rgbText(hex: string): string {
  const numeric = Number.parseInt(pickerHex(hex).slice(1), 16)
  return [numeric >> 16, (numeric >> 8) & 255, numeric & 255].join(', ')
}

function rgbTextToHex(value: string): string | null {
  const channels = value.trim().replace(/^rgb\(\s*/iu, '').replace(/\s*\)$/u, '').split(/[,\s]+/u).filter(Boolean).map(Number)
  if (channels.length !== 3 || channels.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)) return null
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

function ColorPickerPanel({ label, value, onChange }: { readonly label: string; readonly value: string; readonly onChange: (value: string) => void }): ReactNode {
  const normalized = pickerHex(value)
  const suffix = alphaSuffix(value)
  const [hsv, setHsv] = useState(() => hexToHsv(normalized))
  const [hexDraft, setHexDraft] = useState(normalized)
  const [rgbDraft, setRgbDraft] = useState(() => rgbText(normalized))
  const editingText = useRef(false)
  const current = hsvToHex(hsv)

  useEffect(() => {
    // While a text field has focus the incoming value may be the engine's echo
    // of what is being typed; rewriting the draft would fight the keystrokes.
    if (!editingText.current) {
      setHexDraft(normalized)
      setRgbDraft(rgbText(normalized))
    }
    // Keep hue and saturation when the value is our own change echoed back:
    // hex to HSV is lossy for greys, white and black.
    setHsv(previous => (hsvToHex(previous) === normalized ? previous : hexToHsv(normalized)))
  }, [normalized])

  // Thumbs move at once; the parent commit (which may regenerate a whole
  // palette) is batched to one per animation frame, and flushed on release.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const pending = useRef<string | null>(null)
  const frame = useRef<number | null>(null)
  const flush = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    const next = pending.current
    pending.current = null
    if (next !== null) onChangeRef.current(next)
  }, [])
  useEffect(() => () => flush(), [flush])
  const schedule = useCallback((color: string) => {
    pending.current = color
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      const next = pending.current
      pending.current = null
      if (next !== null) onChangeRef.current(next)
    })
  }, [])

  const commit = (next: Hsv): void => {
    setHsv(next)
    const color = hsvToHex(next)
    setHexDraft(color)
    setRgbDraft(rgbText(color))
    schedule(color + suffix)
  }

  const fromPlane = (event: PointerEvent<HTMLDivElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    commit({ ...hsv, s: clamp01((event.clientX - bounds.left) / bounds.width), v: 1 - clamp01((event.clientY - bounds.top) / bounds.height) })
  }
  const fromHue = (event: PointerEvent<HTMLDivElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect()
    commit({ ...hsv, h: clamp01((event.clientX - bounds.left) / bounds.width) * 360 })
  }
  const dragging = (handler: (event: PointerEvent<HTMLDivElement>) => void) => ({
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture?.(event.pointerId)
      handler(event)
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) handler(event)
    },
    onPointerUp: flush,
    onLostPointerCapture: flush,
  })

  const planeKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 0.1 : 0.02
    commit({
      h: hsv.h,
      s: event.key === 'ArrowLeft' ? clamp01(hsv.s - step) : event.key === 'ArrowRight' ? clamp01(hsv.s + step) : hsv.s,
      v: event.key === 'ArrowUp' ? clamp01(hsv.v + step) : event.key === 'ArrowDown' ? clamp01(hsv.v - step) : hsv.v,
    })
  }
  const hueKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : -1
    commit({ ...hsv, h: (hsv.h + direction * (event.shiftKey ? 10 : 1) + 360) % 360 })
  }

  const textFocus = { onFocus: () => { editingText.current = true }, onBlur: () => { editingText.current = false; setHexDraft(current); setRgbDraft(rgbText(current)) } }

  return (
    <div className="theme-picker">
      <div
        className="theme-picker__plane tt-focusable"
        role="slider"
        tabIndex={0}
        aria-label={`${label} saturation and brightness`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.v * 100)}
        aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        style={{ backgroundColor: `hsl(${Math.round(hsv.h)} 100% 50%)` }}
        onKeyDown={planeKeys}
        {...dragging(fromPlane)}
      >
        <span className="theme-picker__thumb" style={{ left: `calc(${hsv.s} * (100% - 12px) + 6px)`, top: `calc(${1 - hsv.v} * (100% - 12px) + 6px)` }} />
      </div>
      <div
        className="theme-picker__hue tt-focusable"
        role="slider"
        tabIndex={0}
        aria-label={`${label} hue`}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        onKeyDown={hueKeys}
        {...dragging(fromHue)}
      >
        <span className="theme-picker__hue-track" aria-hidden="true" />
        <span className="theme-picker__hue-thumb" style={{ left: `calc(${hsv.h / 360} * (100% - 16px) + 8px)`, backgroundColor: `hsl(${Math.round(hsv.h)} 100% 50%)` }} />
      </div>
      <div className="theme-picker__inputs">
        <label>
          <span>HEX</span>
          <input
            className="tt-input"
            aria-label={`${label} picker hex value`}
            spellCheck={false}
            maxLength={9}
            value={hexDraft}
            {...textFocus}
            onChange={event => {
              const next = event.currentTarget.value
              setHexDraft(next)
              if (!/^#[0-9a-f]{6}$/iu.test(next)) return
              setHsv(hexToHsv(next))
              setRgbDraft(rgbText(next))
              onChange(next.toLowerCase() + suffix)
            }}
          />
        </label>
        <label>
          <span>RGB</span>
          <input
            className="tt-input"
            aria-label={`${label} picker RGB value`}
            spellCheck={false}
            maxLength={24}
            value={rgbDraft}
            {...textFocus}
            onChange={event => {
              const next = event.currentTarget.value
              setRgbDraft(next)
              const color = rgbTextToHex(next)
              if (!color) return
              setHsv(hexToHsv(color))
              setHexDraft(color)
              onChange(color + suffix)
            }}
          />
        </label>
      </div>
    </div>
  )
}

export const ThemeColorField = memo(function ThemeColorField({ role, label, value, onChange, selected = false, onSelect, onToggleSelected }: {
  readonly role: ThemeColorRole
  readonly label?: string
  readonly value: string
  readonly onChange: (role: ThemeColorRole, value: string) => void
  /** Whether the window is spotlighting where this colour is used. */
  readonly selected?: boolean
  readonly onSelect?: (role: ThemeColorRole) => void
  readonly onToggleSelected?: (role: ThemeColorRole) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const name = label ?? themeRoleLabel(role)
  const valid = isEditorColor(value)
  const swatch = valid ? pickerHex(value) : '#000000'
  // OKLCH values show as hex; whatever the user is typing shows as typed.
  const text = value.trim().toLowerCase().startsWith('oklch(') ? themeColorToHex(value) ?? value : value
  return (
    <div className="theme-color-field" data-theme-color-role={role} data-open={open || undefined} data-selected={selected || undefined}>
      <div className="theme-color-field__row">
        {onToggleSelected
          ? (
              <button
                type="button"
                className="theme-color-field__label theme-color-field__usage tt-focusable"
                aria-label={`${selected ? 'Hide' : 'Show'} where ${name} is used`}
                aria-pressed={selected}
                title={`${selected ? 'Hide' : 'Show'} where ${name} is used`}
                onClick={() => onToggleSelected(role)}
              >
                {name}
              </button>
            )
          : <span className="theme-color-field__label">{name}</span>}
        <button
          type="button"
          className="theme-color-field__swatch tt-focusable"
          aria-label={`Choose ${name} color`}
          aria-expanded={open}
          aria-controls={panelId}
          title={`Choose ${name} color`}
          onClick={() => {
            onSelect?.(role)
            setOpen(current => !current)
          }}
        >
          <span style={{ backgroundColor: swatch }} />
        </button>
        <input
          className="theme-color-field__hex tt-input"
          aria-label={`${name} hex value`}
          aria-invalid={!valid}
          spellCheck={false}
          maxLength={96}
          value={text}
          onFocus={() => onSelect?.(role)}
          onChange={event => onChange(role, event.currentTarget.value)}
        />
      </div>
      {open ? <div id={panelId}><ColorPickerPanel label={name} value={swatch + alphaSuffix(value)} onChange={next => onChange(role, next)} /></div> : null}
    </div>
  )
})
