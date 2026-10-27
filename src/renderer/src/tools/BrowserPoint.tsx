import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { SquareDashedMousePointer } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { BrowserCapture, BrowserPointPick } from '../../../shared/browser'
import { dataUrlBlob } from '../agents/screenshotResize'
import { STAGING_FAILED } from '../agents/stagedImages'
import './browserPoint.css'

type Rgb = { readonly r: number; readonly g: number; readonly b: number }

/**
 * A theme colour token as plain RGB, which Chromium's inspect overlay needs (themes write OKLCH). Drawn on a 1x1
 * canvas, as the terminal does; null where the window cannot draw one.
 */
export function themeRgb(token: string, root: HTMLElement = document.documentElement): Rgb | null {
  const value = getComputedStyle(root).getPropertyValue(token).trim()
  if (!value) return null
  try {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.fillStyle = '#000000'
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
    return { r, g, b }
  } catch { return null }
}

/**
 * The picture with the element outlined in the accent, so the agent sees what was pointed at as the user did. The
 * capture as it was when the window cannot draw it.
 */
export async function outlinedCapture(capture: BrowserCapture, box: BrowserPointPick['box']): Promise<BrowserCapture> {
  const accent = themeRgb('--tt-accent')
  if (!box || !accent || typeof createImageBitmap !== 'function') return capture
  try {
    const source = dataUrlBlob(capture.image, 'image/png')
    if (!source) return capture
    const bitmap = await createImageBitmap(source)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) { bitmap.close(); return capture }
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const scale = canvas.width / capture.width
    const color = `rgb(${accent.r} ${accent.g} ${accent.b})`
    context.fillStyle = `rgb(${accent.r} ${accent.g} ${accent.b} / 0.1)`
    context.fillRect(box.x * scale, box.y * scale, box.width * scale, box.height * scale)
    context.strokeStyle = color
    context.lineWidth = Math.max(2, Math.round(2 * scale))
    context.strokeRect(box.x * scale - 3, box.y * scale - 3, box.width * scale + 6, box.height * scale + 6)
    return { ...capture, image: canvas.toDataURL('image/png') }
  } catch { return capture }
}

/** How an element is named while pointing: its tag set as code, then its accessible name. */
export function PointLabel({ tag, name }: { readonly tag: string; readonly name: string }): ReactNode {
  return <><code>{tag}</code>{name ? <> · {name}</> : null}</>
}
/** `button · Sign in` back into its tag and name. */
export function splitLabel(label: string): { tag: string; name: string } {
  const at = label.indexOf(' · ')
  return at < 0 ? { tag: label, name: '' } : { tag: label.slice(0, at), name: label.slice(at + 3) }
}

/** The line over the page while pointing: what to do, and the element under the pointer once there is one. */
export function PointLine({ hover }: { readonly hover: string | null }): ReactNode {
  const named = hover ? splitLabel(hover) : null
  return <div className="browser-point__line">
    <SquareDashedMousePointer size={14} aria-hidden="true" />
    {/* The element under the pointer changes as it moves, so only the instruction is announced. */}
    {named ? <span className="browser-point__hovered" aria-hidden="true"><PointLabel {...named} /></span> : null}
    <span role="status"><Trans comment="Shown over a browser page while the user points at something on it. Esc is the Escape key.">Click something on the page to point at it · <kbd>Esc</kbd> to stop</Trans></span>
  </div>
}

/**
 * In the page's place after a click: the picture taken at that moment, the element outlined and named on it, and a
 * short comment beside it. Escape or Cancel goes back to pointing; Add to message hands the comment to `onAdd`.
 */
export function PointComment({ pick, onAdd, onCancel }: {
  readonly pick: BrowserPointPick
  /** `signal` is aborted when the comment closes before the add finishes; nothing is added then. */
  readonly onAdd: (comment: string, signal: AbortSignal) => Promise<string | null>
  readonly onCancel: () => void
}): ReactNode {
  const { t } = useLingui()
  const { capture, box } = pick
  const element = capture.element
  const named = { tag: element?.tag ?? '', name: element?.name ?? '' }
  const label = named.name ? `${named.tag} · ${named.name}` : named.tag
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const frame = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLSpanElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const adding = useRef<AbortController | null>(null)
  const [place, setPlace] = useState<{ outline: React.CSSProperties; chip: React.CSSProperties; popover: React.CSSProperties } | null>(null)
  useEffect(() => { field.current?.focus() }, [])
  useEffect(() => () => adding.current?.abort(), [])

  // The picture is drawn to fit the page's place; the outline, its name and the comment follow it in pixels, the
  // comment under the element, or over it when there is no room below, and never past the picture's edges.
  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const measure = (): void => {
      const width = element.clientWidth, height = element.clientHeight
      const scale = capture.width > 0 ? width / capture.width : 1
      if (!box) { setPlace({ outline: { display: 'none' }, chip: { display: 'none' }, popover: { left: Math.max(8, (width - (popover.current?.offsetWidth ?? 0)) / 2), top: 8 } }); return }
      const pad = 3
      const left = box.x * scale - pad, top = box.y * scale - pad, right = (box.x + box.width) * scale + pad, bottom = (box.y + box.height) * scale + pad
      const chipWidth = chip.current?.offsetWidth ?? 0, chipHeight = chip.current?.offsetHeight ?? 0
      const popWidth = popover.current?.offsetWidth ?? 0, popHeight = popover.current?.offsetHeight ?? 0
      const clampX = (x: number, size: number): number => Math.max(8, Math.min(x, width - size - 8))
      const below = bottom + 6 + chipHeight + 6 + popHeight <= height - 8 || top < height / 2
      const chipTop = below ? Math.min(bottom + 6, height - chipHeight - 8) : Math.max(8, top - 6 - chipHeight)
      const popTop = below ? Math.min(chipTop + chipHeight + 6, height - popHeight - 8) : Math.max(8, chipTop - 6 - popHeight)
      setPlace({
        outline: { left, top, width: right - left, height: bottom - top },
        chip: { left: clampX(right - chipWidth, chipWidth), top: chipTop },
        popover: { left: clampX(right - popWidth, popWidth), top: Math.max(8, popTop) },
      })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [box, capture.width])

  const add = (): void => {
    setBusy(true); setProblem(null)
    const controller = new AbortController(); adding.current = controller
    void onAdd(comment, controller.signal).catch(() => STAGING_FAILED).then(error => {
      if (controller.signal.aborted) return
      adding.current = null
      setBusy(false)
      if (error) { setProblem(error); requestAnimationFrame(() => field.current?.focus()) }
    })
  }
  const cancel = (): void => { adding.current?.abort(); adding.current = null; onCancel() }

  return <div className="browser-point" data-covers-native-view>
    <div ref={frame} className="browser-point__frame" style={{ aspectRatio: `${capture.width} / ${capture.height}`, width: `min(100cqw, ${capture.height > 0 ? capture.width / capture.height * 100 : 100}cqh)` }}>
      <img src={capture.image} alt={t({ message: `The page when you pointed at ${label}`, comment: '{label} is a page element, such as button · Sign in.' })} draggable={false} />
      <span className="browser-point__outline" aria-hidden="true" style={place?.outline} />
      <span ref={chip} className="browser-point__chip" aria-hidden="true" style={place?.chip}><PointLabel {...named} /></span>
      <div ref={popover} className="browser-point__popover" role="dialog" aria-label={t({ message: `Point at ${label}`, comment: '{label} is a page element, such as button · Sign in.' })} style={place?.popover}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() } }}>
        <textarea ref={field} className="tt-focusable" aria-label={t`What should the agent know about this?`} placeholder={t`What should the agent know about this?`}
          value={comment} maxLength={8000} onChange={event => setComment(event.currentTarget.value)} />
        {problem ? <p className="browser-review-problem" role="alert">{problem}</p> : null}
        <div className="browser-point__actions">
          <button type="button" className="tt-button tt-focusable" aria-keyshortcuts="Escape" onClick={cancel}>{t({ message: 'Cancel', comment: 'Closes the comment on a page element and goes back to pointing.' })} <kbd aria-hidden="true">Esc</kbd></button>
          <button type="button" className="tt-button tt-button--primary tt-focusable" disabled={busy} onClick={add}>{t`Add to message`}</button>
        </div>
      </div>
    </div>
  </div>
}
