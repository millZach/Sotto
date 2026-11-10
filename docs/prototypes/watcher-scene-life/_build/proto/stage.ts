// PROTOTYPE, throwaway. What every scene variant shares: it measures Watcher's pane as the real scene does
// (measureRoom, copied from WatcherNightScene.tsx), reads the theme's inks off the pane, and paces frames. A variant only
// lays itself out, takes the inks and draws a frame.
import { heldRoom, sceneInk, type Box, type Rgb, type SceneInk, type SceneMeasure, type Word } from '@w/nightScene'
import { toRgb } from '@w/canvasColor'

export interface Roles { text: Rgb; text2: Rgb; muted: Rgb; hint: Rgb; border: Rgb; accent: Rgb; canvas: Rgb }
export interface Inks { scene: SceneInk; font: string; light: boolean; roles: Roles }
export interface SceneCtx {
  pane: HTMLElement; back: HTMLCanvasElement; front: HTMLCanvasElement; probe: HTMLElement
  reduced: boolean; options: Record<string, string>; owls: import('@w/owlFamily').WatchedOwl[]
}
export interface Hooks {
  /** Lays out for the room; false when nothing can be drawn. */
  layout(measure: SceneMeasure, dpr: number, extra: { strip: number; cardTop: number }): boolean
  ink(inks: Inks): void
  /** Draws the frame for scene time t (seconds); returns the milliseconds until the next one, or null to rest. */
  frame(t: number): number | null
}
export interface Running { stop(): void; wake(): void; clock(): number }

function relative(box: DOMRect, base: DOMRect, scrollTop: number): Box {
  return { x: box.left - base.left, y: box.top - base.top + scrollTop, w: box.width, h: box.height }
}

/** WatcherNightScene.tsx's measureRoom, unchanged. */
export function measureRoom(pane: HTMLElement): SceneMeasure | null {
  const form = pane.querySelector<HTMLElement>('.thread-workspace__compose .thread-prompt')
  const compose = form?.closest<HTMLElement>('.thread-workspace__compose')
  if (form == null || compose == null) return null
  const base = pane.getBoundingClientRect(), top = pane.scrollTop
  const at = (element: Element): Box => relative(element.getBoundingClientRect(), base, top)
  const card = at(form)
  if (card.w < 1 || card.h < 1) return null
  const slim = compose.hasAttribute('data-slim'), style = getComputedStyle(compose)
  const full = slim ? parseFloat(style.getPropertyValue('--thread-prompt-full')) : Number.NaN
  const foot = slim ? parseFloat(style.getPropertyValue('--thread-prompt-foot')) : Number.NaN
  const room = at(compose)
  const composer = !Number.isFinite(full) ? card
    : Number.isFinite(foot) ? { ...card, y: room.y + room.h - foot - full, h: full }
    : full > card.h ? { ...card, y: card.y + card.h - full, h: full } : card
  const words: Box[] = []
  const shown = (box: Box): boolean => box.w > 1 && box.h > 1
  const word = (element: Element): void => { const box = at(element); if (shown(box) && element.textContent?.trim()) words.push(box) }
  let header = 0
  for (const band of pane.querySelectorAll(':scope > :is(.watcher-head, .watcher-glance, .thread-workspace__error)')) {
    const box = at(band)
    header = Math.max(header, box.y + box.h)
    word(band)
  }
  for (const child of compose.children) { if (child.contains(form)) break; word(child) }
  for (const line of compose.querySelectorAll(':scope > .thread-pane__meta')) word(line)
  const scrubber = pane.querySelector('.message-scrubber')
  const lane = scrubber === null ? undefined : at(scrubber)
  return { width: pane.clientWidth, height: pane.clientHeight, header, composer, words, ...lane !== undefined && shown(lane) ? { lane } : {} }
}

const DESKS: readonly Rgb[] = [{ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }]
function toWord(value: string, pixel: CanvasRenderingContext2D): Word | null {
  const rgb = toRgb(value, pixel)
  if (rgb === null) return null
  const a = pixel.getImageData(0, 0, 1, 1).data[3]! / 255
  return a >= 1 ? rgb : { ...rgb, a }
}
function surfaceOf(pane: HTMLElement, pixel: CanvasRenderingContext2D, ink: Rgb | null): Rgb | null {
  const layers: Array<{ rgb: Rgb; a: number }> = []
  for (let node: Element | null = pane; node !== null; node = node.parentElement) {
    const found = toWord(getComputedStyle(node).backgroundColor, pixel)
    if (found === null) continue
    const a = found.a ?? 1
    layers.push({ rgb: { r: found.r, g: found.g, b: found.b }, a })
    if (a >= 1) break
  }
  if (layers.length === 0) return null
  const flatten = (desk: Rgb): Rgb => layers.reduceRight<Rgb>((under, { rgb, a }) => ({ r: rgb.r * a + under.r * (1 - a), g: rgb.g * a + under.g * (1 - a), b: rgb.b * a + under.b * (1 - a) }), desk)
  if (layers[layers.length - 1]!.a >= 1) return flatten(DESKS[0]!)
  const [white, black] = DESKS.map(flatten) as [Rgb, Rgb]
  if (ink === null) return white
  const d = (one: Rgb): number => Math.abs(one.r - ink.r) + Math.abs(one.g - ink.g) + Math.abs(one.b - ink.b)
  return d(white) <= d(black) ? white : black
}

/** The theme's inks, as WatcherNightScene.tsx reads them, and the colour roles the new concepts are drawn in. */
export function readInks(pane: HTMLElement, probe: HTMLElement, pixel: CanvasRenderingContext2D): Inks | null {
  const style = getComputedStyle(probe)
  const text = toRgb(style.color, pixel), accent = toRgb(style.backgroundColor, pixel)
  const surface = surfaceOf(pane, pixel, text)
  if (text === null || accent === null || surface === null) return null
  const words = [toWord(style.color, pixel), toWord(style.borderTopColor, pixel), toWord(style.borderRightColor, pixel), toWord(style.borderBottomColor, pixel)].filter((w): w is Word => w !== null)
  const scene = sceneInk(surface, text, accent, words)
  const role = (name: string): Rgb => {
    const el = document.createElement('i')
    el.style.cssText = `position:absolute;visibility:hidden;color:var(${name})`
    pane.appendChild(el)
    const c = getComputedStyle(el).color
    el.remove()
    return toRgb(c, pixel) ?? text
  }
  const roles: Roles = { text, text2: role('--tt-text-2'), muted: role('--tt-text-muted'), hint: role('--tt-text-hint'), border: role('--tt-hairline'), accent, canvas: surface }
  return { scene, font: style.fontFamily, light: scene.light, roles }
}

/** Runs a variant: measures, reads inks, and paces its frames, until stopped. */
export function runStage(ctx: SceneCtx, hooks: Hooks): Running {
  const { pane, probe } = ctx
  const pixelCanvas = document.createElement('canvas')
  pixelCanvas.width = 1; pixelCanvas.height = 1
  const pixel = pixelCanvas.getContext('2d', { willReadFrequently: true })!
  const origin = performance.now()
  const clock = (): number => (performance.now() - origin) / 1000
  let disposed = false, timer: number | null = null, raf: number | null = null, laid = false, inked = '', measured = '', fullRoom: SceneMeasure | null = null
  const cancel = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (raf !== null) { cancelAnimationFrame(raf); raf = null }
  }
  // One chain of frames at a time: a frame drawn early (a layout, a wake) takes the place of the one that was waiting.
  const frame = (): void => {
    cancel()
    if (disposed || !laid) return
    const next = hooks.frame(clock())
    if (next !== null && !disposed) timer = window.setTimeout(() => { timer = null; raf = requestAnimationFrame(() => { raf = null; frame() }) }, Math.max(0, next - 12))
  }
  const wake = (): void => frame()
  /** Draws on the next display frame, however many times it is asked before then. */
  const wakeSoon = (): void => {
    if (disposed) return
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (raf === null) raf = requestAnimationFrame(() => { raf = null; frame() })
  }
  const readInk = (force = false): void => {
    const inks = readInks(pane, probe, pixel)
    if (inks === null) return
    const key = JSON.stringify([inks.roles, inks.font])
    if (key === inked && !force) return
    inked = key
    hooks.ink(inks)
    wake()
  }
  const relayout = (): void => {
    if (disposed) return
    const room = measureRoom(pane)
    const compose = pane.querySelector(':scope > .thread-workspace__compose')
    if (compose?.hasAttribute('data-slim') !== true) fullRoom = room
    const measure = heldRoom(room, fullRoom)
    const dpr = window.devicePixelRatio || 1
    const key = JSON.stringify([measure, dpr])
    if (key === measured) return
    measured = key
    if (measure === null) return
    const head = pane.querySelector(':scope > .watcher-head')
    const strip = head ? head.getBoundingClientRect().bottom - pane.getBoundingClientRect().top : 0
    const form = pane.querySelector('.thread-workspace__compose .thread-prompt')
    const cardTop = form ? form.getBoundingClientRect().top - pane.getBoundingClientRect().top : measure.composer.y
    laid = hooks.layout(measure, dpr, { strip, cardTop })
    // Laying out cleared the canvases, so the frame is drawn now and the scene never shows blank.
    readInk(true)
    wake()
  }
  const sizes = new ResizeObserver(() => requestAnimationFrame(relayout))
  sizes.observe(pane)
  const theme = new MutationObserver(() => readInk())
  theme.observe(document.documentElement, { attributes: true })
  const font = `10.5px ${getComputedStyle(probe).fontFamily}`
  void document.fonts?.load(font).then(() => { if (!disposed) readInk(true) })
  relayout()
  return { stop: () => { disposed = true; cancel(); sizes.disconnect(); theme.disconnect() }, wake: wakeSoon, clock }
}

export const clearCanvas = (canvas: HTMLCanvasElement): void => { canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height) }
export const rgba = ({ r, g, b }: Rgb, a: number): string => `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`
export const mix = (a: Rgb, b: Rgb, k: number): Rgb => ({ r: Math.round(a.r + (b.r - a.r) * k), g: Math.round(a.g + (b.g - a.g) * k), b: Math.round(a.b + (b.b - a.b) * k) })
