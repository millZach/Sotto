import { flushSync } from 'react-dom'
import type { UpdateStatus } from '../../../shared/contracts'
import type { AppSettings, RoomTransitionLook } from '../../../shared/settings'
import { prefersReducedMotion } from '../state/reducedMotion'
import { toRgb } from './canvasColor'
import { clamp, inkAt, sceneInk, type Rgb } from './nightScene'
import './watcher.css'

/**
 * Night falls (Drake's pick on October 23, 2026, variant 9 of `docs/prototypes/watcher-room-transition-prototype.html`):
 * moving between Threads and Watcher's room, a band of flickering text characters sweeps across the window. The room
 * being opened shows behind the band and the one being left ahead of it, edged in character cells, and the owl of the
 * room switch rides the band from the sidebar foot to the dock under Watcher's composer (or back). Built on the View
 * Transitions API: the page being left is a still snapshot and the one opened is live, so App keeps rendering one page.
 * Reduced motion, the setting being off, or a browser without view transitions swaps the page in one frame.
 *
 * The run has two looks (ADR-0119, decision 6): the Band, above, and Stars (variant C of the Band and Stars prototype,
 * kept at the tag `prototype/night-falls-look`), a line of stars along the same front with a faint trail behind it. Both
 * share the front, the clip that reveals the room being opened and the timing; only what is painted on the canvas differs.
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

// ---------- Stars ----------

/** How far the Stars look's trail reaches behind its front, in CSS pixels. */
export const TRAIL = 140
/** The glyphs the Stars front is made of. Not words, so never translated. */
export const STARS = ['*', '+', '·'] as const

/** What the Stars front shows on one row at one flicker step: a glyph at a strength from 0 to 1. */
export interface FrontStar { readonly glyph: string; readonly strength: number }

/**
 * The star on `row` at flicker step `step`, or null on the quarter of the rows that show none. The rest take one of the
 * three glyphs, most of them bright and one in five faint. The same row and step always give the same star.
 */
export function frontStar(row: number, step: number): FrontStar | null {
  if (hash(row, 3, 5) % 4 === 0) return null
  const roll = hash(row, step, 9)
  return { glyph: STARS[roll % STARS.length]!, strength: roll % 5 === 0 ? 0.45 : 0.95 }
}

/** How strong the trail is `distance` pixels behind the front: full at the front, nothing at TRAIL. */
export function trailStrength(distance: number): number {
  return clamp(1 - distance / TRAIL, 0, 1)
}

/**
 * How much of the trail is left once the front runs on past the far side of the window, where the clip already shows the
 * whole room: all of it until the front reaches that side at progress `u`, none at the end of the run. So the trail leaves
 * with the run rather than vanishing when the canvas is taken away.
 */
export function trailLeft(u: number, width: number): number {
  return clamp((1 - u) * (width + BAND * 2) / BAND, 0, 1)
}

/** One trail cell: a ramp glyph at a strength from 0 to 1, and whether it covers the room under it with the ground. */
export interface TrailMark { readonly glyph: string; readonly strength: number; readonly ground: boolean }

/**
 * The trail cell `cells` behind the front, at grid cell (`col`, `row`) and flicker step `step`, or null where it shows
 * nothing. It thins with distance: fewer cells show, fainter and in lighter glyphs. The cell next to the star always
 * covers the room, so the front reads crisp; further back one in three does, the only darkening of the room being opened.
 */
export function trailMark(cells: number, col: number, row: number, step: number, left = 1): TrailMark | null {
  const p = trailStrength(cells * CELL_W)
  const roll = hash(col, row, step)
  if (p <= 0 || (roll % 100) / 100 >= p * 0.5 * left) return null
  const index = clamp(Math.floor(p * 5 * (0.5 + ((roll >>> 8) % 50) / 100)), 1, 5)
  return { glyph: RAMP[index]!, strength: 0.14 + p * 0.3, ground: cells === 1 || (roll >>> 5) % 3 === 0 }
}

/** A cell the Stars look paints at (`x`, `y`): the ground under it or not, and a glyph in the accent or the text's ink. */
export interface StarsCell {
  readonly x: number
  readonly y: number
  readonly ground: boolean
  readonly glyph: string | null
  readonly ink: 'accent' | 'text'
  readonly strength: number
}

/**
 * Every cell the Stars look paints at progress `u` (0..1) and time `elapsed`. Each row's star sits in the cell its front
 * edge falls in, the edge `revealPolygon` clips the room to, on a cell of ground so the edge is crisp. The trail runs back
 * from it into the room being opened.
 */
export function starsCells(u: number, elapsed: number, width: number, height: number, forward: boolean): StarsCell[] {
  const rows = Math.ceil(height / CELL_H)
  const edge = frontEdge(u, width, rows, forward)
  const step = Math.floor(elapsed / FLICKER_MS)
  const back = forward ? -1 : 1
  const cols = Math.ceil(width / CELL_W)
  const left = trailLeft(u, width)
  const cells: StarsCell[] = []
  for (let row = 0; row < rows; row++) {
    const front = edge[row]!
    const y = row * CELL_H
    const col = Math.floor(front / CELL_W)
    for (let k = 1; k * CELL_W < TRAIL; k++) {
      const at = col + back * k
      if (at < 0 || at >= cols) continue
      const mark = trailMark(k, at, row, step, left)
      if (mark !== null) cells.push({ x: at * CELL_W, y, ground: mark.ground, glyph: mark.glyph, ink: 'text', strength: mark.strength })
    }
    if (col < 0 || col >= cols) continue
    const star = frontStar(row, step)
    cells.push({ x: col * CELL_W, y, ground: true, glyph: star?.glyph ?? null, ink: 'accent', strength: star?.strength ?? 0 })
  }
  return cells
}

/** The Stars look's inks: the canvas, and the text and the accent in 21 steps of strength (`inkAt` reads them). */
export interface StarsInk {
  readonly ground: string
  readonly text: readonly string[]
  readonly accent: readonly string[]
}

/**
 * The Stars look's inks for a surface: the theme's accent and text laid over it the way Watcher's night scene lays them
 * (`sceneInk`), so on a light surface they take LIGHT_ACCENT_BOOST and LIGHT_INK_BOOST and show as well as on a dark one.
 */
export function starsInk(surface: Rgb, text: Rgb, accent: Rgb): StarsInk {
  const ink = sceneInk(surface, text, accent)
  return { ground: `rgb(${surface.r}, ${surface.g}, ${surface.b})`, text: ink.ink, accent: ink.accent }
}

/** Draws the Stars look at progress `u` and time `elapsed`. */
function paintStars(ctx: CanvasRenderingContext2D, u: number, elapsed: number, width: number, height: number, forward: boolean, inks: StarsInk & { readonly font: string }): void {
  ctx.clearRect(0, 0, width, height)
  ctx.font = `11px ${inks.font}`
  ctx.textBaseline = 'top'
  for (const cell of starsCells(u, elapsed, width, height, forward)) {
    if (cell.ground) { ctx.fillStyle = inks.ground; ctx.fillRect(cell.x, cell.y, CELL_W, CELL_H) }
    if (cell.glyph === null) continue
    ctx.fillStyle = inkAt(cell.ink === 'accent' ? inks.accent : inks.text, cell.strength)
    ctx.fillText(cell.glyph, cell.x, cell.y + 1)
  }
}

/** The theme's colours for Stars, read through `pixel` (`--tt-canvas`, `--tt-text`, `--tt-accent`); null where one cannot be read, and the band plays. */
function readStarsInk(pixel: CanvasRenderingContext2D, font: string): (StarsInk & { readonly font: string }) | null {
  const surface = toRgb(cssColor('--tt-canvas', 'Canvas'), pixel)
  const text = toRgb(cssColor('--tt-text', 'CanvasText'), pixel)
  const accent = toRgb(cssColor('--tt-accent', 'Highlight'), pixel)
  if (surface === null || text === null || accent === null) return null
  return { ...starsInk(surface, text, accent), font }
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
  /** The band or the stars (ADR-0119, decision 6). Left out, the band. */
  readonly look?: RoomTransitionLook
}

/** Whether a run can play here: view transitions exist and motion is not reduced. */
export function nightFallsAvailable(): boolean {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function' && !prefersReducedMotion()
}

let running: ViewTransition | null = null

/** Ends a run at once (another page was opened meanwhile); its page change still applies, then the newer one wins. */
export function cancelNightFalls(): void {
  running?.skipTransition()
}

/**
 * Whether this build has night falls at all: its own Owl feature (ADR-0119) and Watcher's room, as main answered at
 * start. Read here rather than through owlFeature.ts, which imports AppContext, the caller. Missing answers keep it off.
 */
export function nightFallsShipped(update: UpdateStatus | null | undefined): boolean {
  return update?.owlFeatures?.watcher === true && update.owlFeatures['night-falls'] === true
}

/**
 * The run a move from page `from` to page `to` plays, or null where the page swaps at once: the move is not between
 * Threads and Watcher's room, this build has no night falls, its switch is off, or no run can play here (reduced motion,
 * or no view transitions), in which case the look is never read. Settings not yet read play the band at speed 1, as the
 * defaults do.
 */
export function nightFallsRun(from: string, to: string, update: UpdateStatus | null | undefined,
  settings: Pick<AppSettings, 'roomTransition' | 'roomTransitionSpeed' | 'roomTransitionLook'> | null | undefined): NightFallsOptions | null {
  const betweenRooms = (from === 'threads' && to === 'watcher') || (from === 'watcher' && to === 'threads')
  if (!betweenRooms || !nightFallsShipped(update) || !nightFallsAvailable() || settings?.roomTransition === false) return null
  return { forward: to === 'watcher', speed: settings?.roomTransitionSpeed ?? 1, look: settings?.roomTransitionLook ?? 'band' }
}

/**
 * Runs `update` (the state change that swaps the page) inside the night falls transition, or plainly when it cannot
 * play. A press while a run is playing finishes that run at once and starts the next from where the window is.
 */
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
  // Stars reads its inks on the band's own canvas before it is shown; the first paint clears it.
  const stars = options.look === 'stars' && ctx ? readStarsInk(ctx, inks.font) : null
  const paint = (c: CanvasRenderingContext2D, u: number, elapsed: number): void => {
    if (stars) paintStars(c, u, elapsed, width, height, options.forward, stars)
    else paintBand(c, u, elapsed, width, height, options.forward, inks)
  }
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
      if (ctx && key !== painted) { painted = key; paint(ctx, u, elapsed) }
      if (elapsed < duration) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
  }).catch(cleanUp)
  transition.finished.then(cleanUp, cleanUp)
}
