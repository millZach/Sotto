import { flushSync } from 'react-dom'
import { prefersReducedMotion } from '../state/reducedMotion'
import './watcher.css'

/**
 * Night falls (Drake's pick on October 23, 2026, variant 9 of `docs/prototypes/watcher-room-transition-prototype.html`):
 * moving between Threads and Watcher's room, a band of flickering text characters sweeps across the window. The room
 * being opened shows behind the band and the one being left ahead of it, edged in character cells, and the owl of the
 * room switch rides the band from the sidebar foot to the dock under Watcher's composer (or back). Built on the View
 * Transitions API: the page being left is a still snapshot and the one opened is live, so App keeps rendering one page.
 * Reduced motion, the setting being off, or a browser without view transitions swaps the page in one frame.
 */

/** The run's length at speed 1, in milliseconds. */
export const NIGHT_FALLS_MS = 840
/** The band's width and the character cell, in CSS pixels. */
const BAND = 90
const CELL_W = 7
const CELL_H = 12
/** The ramp the band flickers through, faintest first. */
const RAMP = ' .:-=+*#%@'
/** How long one flicker holds, in milliseconds. */
const FLICKER_MS = 45

/** A small integer hash, so the band's flicker and the front's ragged edge are the same on every run. */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  return (h ^ (h >>> 13)) >>> 0
}

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/** The front's x for each row of cells at progress `u` (0..1), ragged by a cell either way. */
export function frontEdge(u: number, width: number, rows: number, forward: boolean): number[] {
  const travel = width + BAND * 2
  const x = forward ? -BAND + u * travel : width + BAND - u * travel
  return Array.from({ length: rows }, (_, row) => Math.round(x + ((hash(row, 7, 11) % 3) - 1) * CELL_W))
}

/** The time (0..1 of the run) at which the front reaches `x`, so the owl can leave and land with it. */
export function frontTimeAt(x: number, width: number, forward: boolean): number {
  const travel = width + BAND * 2
  const u = Math.min(1, Math.max(0, forward ? (x + BAND) / travel : (width + BAND - x) / travel))
  let lo = 0, hi = 1
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (easeInOut(mid) < u) lo = mid; else hi = mid }
  return (lo + hi) / 2
}

/** The clip that shows the opened page behind the front: everything the front has passed. */
export function revealPolygon(u: number, width: number, height: number, forward: boolean): string {
  const rows = Math.ceil(height / CELL_H)
  const edge = frontEdge(u, width, rows, forward).map(x => Math.max(-1, Math.min(width + 1, x)))
  const side = forward ? 0 : width
  const points = [`${side}px 0px`]
  edge.forEach((x, row) => { points.push(`${x}px ${row * CELL_H}px`, `${x}px ${Math.min(height, (row + 1) * CELL_H)}px`) })
  points.push(`${side}px ${height}px`)
  return `polygon(${points.join(', ')})`
}

function cssColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** Draws the band at progress `u` and time `elapsed`: canvas-coloured cells carrying ramp characters, densest at the front. */
function paintBand(ctx: CanvasRenderingContext2D, u: number, elapsed: number, width: number, height: number, forward: boolean, inks: { ground: string, ink: string, font: string }): void {
  ctx.clearRect(0, 0, width, height)
  const rows = Math.ceil(height / CELL_H)
  const edge = frontEdge(u, width, rows, forward)
  const bucket = Math.floor(elapsed / FLICKER_MS)
  ctx.font = `11px ${inks.font}`
  ctx.textBaseline = 'top'
  for (let row = 0; row < rows; row++) {
    const front = edge[row]!
    const from = Math.floor((front - BAND / 2) / CELL_W), to = Math.ceil((front + BAND / 2) / CELL_W)
    for (let col = Math.max(0, from); col <= to && col * CELL_W < width; col++) {
      const x = col * CELL_W, y = row * CELL_H
      const near = 1 - Math.min(1, Math.abs(x + CELL_W / 2 - front) / (BAND / 2))
      const roll = hash(col, row, bucket)
      if ((roll % 100) / 100 > near * 0.9 + 0.1) continue
      ctx.fillStyle = inks.ground
      ctx.fillRect(x, y, CELL_W, CELL_H)
      const index = Math.min(RAMP.length - 1, Math.floor(near * (RAMP.length - 1) * (0.6 + ((roll >>> 8) % 40) / 100)))
      const glyph = RAMP[index]!
      if (glyph === ' ') continue
      ctx.globalAlpha = 0.35 + near * 0.55
      ctx.fillStyle = inks.ink
      ctx.fillText(glyph, x, y + 1)
      ctx.globalAlpha = 1
    }
  }
}

export interface NightFallsOptions {
  /** True moving into Watcher's room (the band sweeps left to right), false moving back to Threads. */
  readonly forward: boolean
  /** 0.5 is half speed, 2 twice as fast. */
  readonly speed: number
}

/** Whether a run can play here: view transitions exist and motion is not reduced. */
export function nightFallsAvailable(): boolean {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function' && !prefersReducedMotion()
}

let running: ViewTransition | null = null

/**
 * Runs `update` (the state change that swaps the page) inside the night falls transition, or plainly when it cannot
 * play. A press while a run is playing finishes that run at once and starts the next from where the window is.
 */
/** Ends a run at once (another page was opened meanwhile); its page change still applies, then the newer one wins. */
export function cancelNightFalls(): void {
  running?.skipTransition()
}

export function playNightFalls(update: () => void, options: NightFallsOptions): void {
  if (!nightFallsAvailable()) { update(); return }
  running?.skipTransition()
  const root = document.documentElement
  const duration = Math.round(NIGHT_FALLS_MS / Math.min(2, Math.max(0.5, options.speed)))
  const width = window.innerWidth, height = window.innerHeight
  const canvas = document.createElement('canvas')
  canvas.className = 'night-falls-band'
  canvas.setAttribute('aria-hidden', 'true')
  // The thread browser and the test iPhone are native views drawn over all DOM: this marks the run as covering them, so they step aside.
  canvas.setAttribute('data-covers-native-view', '')
  const scale = window.devicePixelRatio || 1
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  ctx?.setTransform(scale, 0, 0, scale, 0, 0)
  const inks = { ground: cssColor('--tt-canvas', 'Canvas'), ink: cssColor('--tt-text', 'CanvasText'), font: cssColor('--tt-font-mono', 'monospace') }
  root.dataset.roomTransition = options.forward ? 'in' : 'out'
  root.style.setProperty('--room-transition-ms', `${duration}ms`)

  const owlSelector = ':is(.thread-nav__foot, .watcher-dock__pill) .thread-nav__seg button[data-room="watcher"]'
  const centre = (): number | null => { const owl = document.querySelector(owlSelector)?.getBoundingClientRect(); return owl && owl.width > 0 ? owl.left + owl.width / 2 : null }
  const from = centre()
  document.body.append(canvas)
  const transition = document.startViewTransition(() => {
    flushSync(update)
    // The owl leaves when the band reaches it and lands when the band reaches its new place.
    const to = centre()
    if (from !== null && to !== null) {
      const start = frontTimeAt(from, width, options.forward), end = Math.max(start + 0.05, frontTimeAt(to, width, options.forward))
      root.style.setProperty('--room-owl-delay', `${Math.round(start * duration)}ms`)
      root.style.setProperty('--room-owl-ms', `${Math.round((end - start) * duration)}ms`)
    }
  })
  running = transition
  transition.updateCallbackDone.catch(() => {})
  let frame = 0
  let clip: Animation | null = null
  const cleanUp = (): void => {
    cancelAnimationFrame(frame)
    clip?.cancel()
    canvas.remove()
    if (running === transition) {
      running = null
      delete root.dataset.roomTransition
      root.style.removeProperty('--room-transition-ms')
      root.style.removeProperty('--room-owl-delay')
      root.style.removeProperty('--room-owl-ms')
    }
  }
  transition.ready.then(() => {
    const frames = 36
    const keyframes = Array.from({ length: frames + 1 }, (_, i) => ({ clipPath: revealPolygon(easeInOut(i / frames), width, height, options.forward), offset: i / frames }))
    try { clip = root.animate(keyframes, { duration, easing: 'linear', fill: 'both', pseudoElement: '::view-transition-new(root)' }) } catch { /* the page shows unclipped; the band still sweeps */ }
    const start = performance.now()
    let painted = ''
    const draw = (now: number): void => {
      const elapsed = now - start
      const u = easeInOut(Math.min(1, elapsed / duration))
      // Paint only when the flicker or the front's cell column has moved.
      const key = `${Math.floor(elapsed / FLICKER_MS)}:${frontEdge(u, width, 1, options.forward)[0]! / CELL_W | 0}`
      if (ctx && key !== painted) { painted = key; paintBand(ctx, u, elapsed, width, height, options.forward, inks) }
      if (elapsed < duration) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
  }).catch(cleanUp)
  transition.finished.then(cleanUp, cleanUp)
}
