import type { CouncilLayout } from '../../../../shared/council'
import { CELL, inkAt, type SceneInk } from '../../watcher/nightScene'
import { GLYPH_PX } from '../../watcher/nightScenePainter'
import { chamberLayout, type ChamberFigure, type ChamberGeometry, type ChamberPoint } from './chamberLayout'
import { bubbleShape, drawBubble, GlyphGrid, placeBubble, wrapWords, type CellRect } from './chamberGrid'
import type { ChamberAct, ChamberLook, ChamberScene, ChamberSeat } from './chamberScene'

/**
 * Draws the Council's chamber in ASCII, in Watcher's way (`nightScenePainter.ts`): the figures, the furniture and the
 * firelight are drawn first as grey vector shapes on three small offscreen fields (the body, what glows, and the light
 * the lamps and braziers throw), two by four field pixels to each 7 by 12 glyph cell; each cell then becomes a glyph
 * for its density, an edge glyph where a shape's outline crosses it, or the background art drawn only where nothing
 * else is. The crisp glyphs (faces, plates, bubbles, letters, the verdict's words) lie over that. Glyphs are painted in
 * the theme's text and accent inks at 21 strengths (`sceneInk`), so the chamber follows the theme. Ported from
 * `docs/prototypes/council-chamber-prototype.html`, Drake's pick on November 2, 2026, after three polish rounds.
 */

const CW = CELL.w, CH = CELL.h
/** Field pixels per glyph cell, across and down. */
const SX = 2, SY = 4
const RAMP = ' .·:-=+*#%@'
const GRAY = Array.from({ length: 256 }, (_, k) => `rgb(${k},${k},${k})`)
const gray = (value: number): string => GRAY[Math.round(Math.max(0, Math.min(1, value)) * 255)]!
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u
const lp = (p: readonly [number, number], q: readonly [number, number], u: number): [number, number] => [lerp(p[0], q[0], u), lerp(p[1], q[1], u)]
const hash = (c: number, r: number): number => { const x = Math.sin(c * 127.1 + r * 311.7) * 43758.5453; return x - Math.floor(x) }

/** What a seat's plate and bubble say, in the user's language, worked out once per update. */
export interface SeatWords {
  readonly name: string
  readonly sub: string
  /** A shorter second line for a narrow place, or empty. */
  readonly subShort?: string
  /** Its letter and marks under the plate, or empty. */
  readonly mark: string
  readonly markAccent: boolean
  readonly bubble: { readonly text: string; readonly title: string; readonly say: boolean } | null
}

/** A scroll in the air, `t0` the chamber's clock when it set off. */
export interface ChamberFlightNow { readonly from: string; readonly to: string; readonly label: string; readonly t0: number }

export interface ChamberFrame {
  /** The chamber's clock in seconds, and the time since the last frame. */
  readonly t: number
  readonly dt: number
  /** Motion is reduced: figures hold still, flames burn steady, and scrolls arrive and unroll at once. */
  readonly still: boolean
  readonly scene: ChamberScene
  readonly words: ReadonlyMap<string, SeatWords>
  readonly flights: readonly ChamberFlightNow[]
  /** When the verdict scroll began to unroll, and when the finished verdict was first shown, for its shimmer. */
  readonly verdictSince: number
  readonly finishedSince: number
  /** The words on the verdict scroll. */
  readonly verdictText: string
}

/** A figure's pose: each value eases toward the target its thread's state sets. */
interface Pose { alpha: number; arm: number; chin: number; scroll: number; write: number; raise: number; bow: number; turn: number; talk: number; stand: number }
type PoseKey = keyof Pose
const POSE_KEYS: readonly PoseKey[] = ['alpha', 'arm', 'chin', 'scroll', 'write', 'raise', 'bow', 'turn', 'talk', 'stand']
const ACTIVE: ReadonlySet<ChamberAct> = new Set<ChamberAct>(['think', 'write', 'read', 'speak', 'ask', 'present'])
const RESTING: ReadonlySet<ChamberAct> = new Set<ChamberAct>(['done', 'listen', 'idle'])
/** How far a pose may lag its target and count as arrived. */
const SETTLED = 0.05

interface Placed { readonly figure: ChamberFigure; readonly seat: ChamberSeat; readonly pose: Pose; readonly seed: number; head: ChamberPoint }

export class ChamberPainter {
  private readonly view: CanvasRenderingContext2D
  private readonly fields: readonly [HTMLCanvasElement, HTMLCanvasElement, HTMLCanvasElement]
  private readonly b: CanvasRenderingContext2D
  private readonly a: CanvasRenderingContext2D
  private readonly l: CanvasRenderingContext2D
  private ink: SceneInk | null = null
  private font = ''
  private width = 0
  private height = 0
  private dpr = 1
  cols = 0
  rows = 0
  geometry: ChamberGeometry | null = null
  private arranged = ''
  private grid = new GlyphGrid(0, 0)
  /** The background art, drawn once per size and layout, and the copy a frame writes its moving motes and beams into. */
  private staticArt = new GlyphGrid(0, 0)
  private art = new GlyphGrid(0, 0)
  private beamCells = new Int32Array(0)
  /** The beams' centre columns and the row they stop at, where the motes drift. */
  private beamCols: readonly number[] = []
  private beamStop = 0
  private D = new Float32Array(0)
  private E = new Float32Array(0)
  private LT = new Float32Array(0)
  private noise = new Float32Array(0)
  private outCode = new Uint16Array(0)
  private outStrength = new Float32Array(0)
  private outAccent = new Uint8Array(0)
  private bucketOf = new Uint8Array(0)
  private order = new Int32Array(0)
  private readonly counts = new Int32Array(43)
  private readonly glyphs = new Map<number, string>()
  private readonly poses = new Map<string, Pose>()
  private readonly taken: CellRect[] = []
  /** Whether the last frame had anything still easing toward its pose. */
  settling = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.view = canvas.getContext('2d')!
    const field = (): HTMLCanvasElement => document.createElement('canvas')
    this.fields = [field(), field(), field()]
    const read = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => canvas.getContext('2d', { willReadFrequently: true })!
    this.b = read(this.fields[0]); this.a = read(this.fields[1]); this.l = read(this.fields[2])
  }

  get ready(): boolean { return this.ink !== null && this.geometry !== null && this.cols > 0 && this.rows > 0 }

  setInk(ink: SceneInk, fontFamily: string): void {
    this.ink = ink
    this.font = `600 ${GLYPH_PX}px ${fontFamily}`
  }

  /** Sizes the canvas to whole cells of `width` by `height`, and lays the chamber out in it. */
  resize(width: number, height: number, dpr: number, layout: CouncilLayout, count: number): ChamberGeometry | null {
    const cols = Math.floor(width / CW), rows = Math.floor(height / CH)
    const scale = Math.min(2, dpr || 1)
    if (cols !== this.cols || rows !== this.rows || scale !== this.dpr) {
      this.cols = cols; this.rows = rows; this.dpr = scale
      this.width = cols * CW; this.height = rows * CH
      this.canvas.width = Math.max(1, Math.round(this.width * scale)); this.canvas.height = Math.max(1, Math.round(this.height * scale))
      this.canvas.style.width = `${this.width}px`; this.canvas.style.height = `${this.height}px`
      for (const field of this.fields) { field.width = Math.max(1, cols * SX); field.height = Math.max(1, rows * SY) }
      const cells = cols * rows
      this.grid = new GlyphGrid(cols, rows); this.staticArt = new GlyphGrid(cols, rows); this.art = new GlyphGrid(cols, rows)
      this.D = new Float32Array(cells); this.E = new Float32Array(cells); this.LT = new Float32Array(cells)
      this.noise = Float32Array.from({ length: cells }, (_, i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x) })
      this.outCode = new Uint16Array(cells); this.outStrength = new Float32Array(cells); this.outAccent = new Uint8Array(cells)
      this.bucketOf = new Uint8Array(cells); this.order = new Int32Array(cells)
      this.arranged = ''
    }
    if (cols < 1 || rows < 1) { this.geometry = null; return null }
    const key = `${layout}:${count}`
    if (key !== this.arranged) {
      this.arranged = key
      // Poses are kept by seat, so a seat added sits down alone while the others stay as they are.
      this.geometry = chamberLayout(layout, this.width, this.height, count)
      this.buildArt()
    }
    return this.geometry
  }

  /** Where the canvas sits in its box: whole cells, centred. */
  offset(boxWidth: number, boxHeight: number): ChamberPoint {
    return { x: Math.floor((boxWidth - this.width) / 2), y: Math.floor((boxHeight - this.height) / 2) }
  }

  // ---------- The background art, drawn only where nothing else is ----------

  private bg(c: number, r: number, glyph: string, strength = 0.3, accent = false): void { this.staticArt.put(c, r, glyph, strength, accent) }
  private col(x: number): number { return Math.round(x / CW) }
  private row(y: number): number { return Math.round(y / CH) }

  private ashlar(r0: number, r1: number): void {
    for (let r = r0; r < r1; r++) for (let c = 0; c < this.cols; c++) {
      if ((r - r0) % 3 === 2) this.bg(c, r, '─', 0.05)
      else if ((c + (Math.floor((r - r0) / 3) % 2) * 6) % 12 === 0) this.bg(c, r, '│', 0.05)
    }
  }
  private frieze(r0: number): void {
    for (let c = 0; c < this.cols; c++) { this.bg(c, r0, '═', 0.42); this.bg(c, r0 + 1, '┴─'[c % 2]!, 0.3); this.bg(c, r0 + 2, '◦ '[c % 2]!, 0.22) }
  }
  private columnArt(x: number, rTop: number, rBot: number, wc: number, v = 1): void {
    const c0 = this.col(x) - Math.floor(wc / 2)
    this.bg(c0 - 1, rTop, '@', 0.42 * v); this.bg(c0 + wc, rTop, '@', 0.42 * v)
    for (let i = 0; i < wc; i++) this.bg(c0 + i, rTop, '═', 0.42 * v)
    for (let i = -1; i <= wc; i++) this.bg(c0 + i, rTop + 1, '‾', 0.3 * v)
    for (let r = rTop + 2; r < rBot; r++) {
      this.bg(c0, r, '│', 0.3 * v); this.bg(c0 + wc - 1, r, '│', 0.3 * v)
      for (let i = 1; i < wc - 1; i++) this.bg(c0 + i, r, i % 2 ? '¦' : ' ', 0.15 * v)
    }
    for (let i = -1; i <= wc; i++) this.bg(c0 + i, rBot, '▀', 0.32 * v)
  }
  private floorArt(rTop: number, cx: number): void {
    for (const dr of [0, 1, 3, 6, 10, 15]) if (rTop + dr < this.rows) for (let c = 0; c < this.cols; c++) this.bg(c, rTop + dr, '─', 0.08)
    for (let i = -8; i <= 8; i += 2) for (let r = rTop; r < this.rows; r++) {
      const u = (r - rTop) / Math.max(1, this.rows - rTop), x = cx + i * 30 + (i * 160 - i * 30) * u
      this.bg(this.col(x), r, i < 0 ? '/' : i > 0 ? '\\' : '│', 0.08)
    }
  }
  /** Shafts of light falling from high windows: their cells are kept, and their strength breathes each frame. */
  private beams(rStop: number): void {
    const cells: number[] = []
    const top = 3
    const beams = [[Math.round(this.cols * 0.08), 7], [Math.round(this.cols * 0.3), 5], [Math.round(this.cols * 0.62), 6]] as const
    this.beamCols = beams.map(([cb]) => cb)
    this.beamStop = rStop
    for (const [cb, wb] of beams) {
      for (let r = top; r < rStop; r++) {
        const cc = cb + (r - top) * 0.85, w = wb + (r - top) * 0.25
        for (let c = Math.round(cc - w / 2); c <= Math.round(cc + w / 2); c++) {
          if (c < 0 || c >= this.cols || r >= this.rows || hash(c, r) >= 0.16) continue
          this.bg(c, r, '/', 0.05)
          cells.push(r * this.cols + c)
        }
      }
    }
    this.beamCells = Int32Array.from(cells)
  }

  private buildArt(): void {
    const g = this.geometry!
    this.staticArt.clear()
    if (g.layout === 'long-table') {
      const floorTop = g.tableY + 14 + g.faceH
      const count = Math.max(3, Math.round(g.width / 230))
      this.ashlar(3, this.row(g.tableY))
      this.beams(this.row(floorTop))
      this.frieze(0)
      for (let k = 0; k < count; k++) this.columnArt(g.width * (k + 0.5) / count, 3, this.row(g.tableY + 30), clamp(Math.round(4 * g.s), 3, 7))
      this.floorArt(this.row(floorTop) + 1, g.width / 2)
    } else if (g.layout === 'half-circle') {
      this.ashlar(3, this.row(g.cy - g.ry * 0.7))
      this.beams(this.row(g.cy - g.ry * 0.4))
      this.frieze(0)
      // The colonnade behind the half circle.
      for (let k = 0; k <= 8; k++) {
        const th = Math.PI + k * Math.PI / 8, x = g.cx + Math.cos(th) * g.rx * 1.12, u = -Math.sin(th)
        this.columnArt(x, 3, this.row(g.cy + Math.sin(th) * g.ry * 0.9 - 60 * g.s), u > 0.8 ? 3 : 4, 1 - u * 0.35)
      }
      // The floor inside the half circle: rings of marble.
      for (let k = 1; k <= 6; k++) {
        const rr = k / 7
        for (let an = Math.PI; an <= Math.PI * 2; an += 0.02 / rr) this.bg(this.col(g.cx + Math.cos(an) * g.rx * rr * 0.92), this.row(g.cy + 10 + Math.sin(an) * g.ry * rr * 0.55), k % 2 ? '·' : '─', 0.14)
      }
    } else {
      const wallBot = g.cy - g.ry - 40 * g.s, count = Math.max(3, Math.round(g.width / 210))
      this.ashlar(3, this.row(wallBot))
      this.beams(this.row(wallBot))
      this.frieze(0)
      for (let k = 0; k < count; k++) this.columnArt(g.width * (k + 0.5) / count, 3, this.row(wallBot), clamp(Math.round(3.4 * g.s), 3, 6))
      for (let k = 1; k <= 7; k++) {
        const q = 1 + k * 0.17
        for (let an = 0; an < Math.PI * 2; an += 0.012) {
          const c = this.col(g.cx + Math.cos(an) * g.rx * q), r = this.row(g.cy + g.ry * 0.35 + Math.sin(an) * g.ry * q * 1.15)
          if (r > this.row(wallBot)) this.bg(c, r, k % 2 ? '·' : '─', 0.12)
        }
      }
    }
  }

  // ---------- Shapes on the fields ----------

  private ell(c: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0): void {
    c.beginPath(); c.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2); c.fill()
  }
  private limb(c: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[], w: number, armV: number, handV: number): void {
    c.strokeStyle = gray(armV); c.lineWidth = w; c.lineCap = 'round'; c.lineJoin = 'round'
    c.beginPath(); c.moveTo(pts[0]![0], pts[0]![1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i]![0], pts[i]![1]); c.stroke()
    const hand = pts[pts.length - 1]!
    c.fillStyle = gray(handV); this.ell(c, hand[0], hand[1], w * 0.55, w * 0.55)
  }
  private flick(t: number, k: number, still: boolean): number { return still ? 0.85 : 0.72 + 0.28 * Math.sin(t * 9.1 + k * 1.7) * Math.sin(t * 5.3 + k * 2.9) }
  private glow(x: number, y: number, r: number, v: number): void {
    const g = this.l.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, gray(v)); g.addColorStop(1, gray(0))
    this.l.fillStyle = g; this.ell(this.l, x, y, r, r * 0.85)
  }
  private flame(x: number, y: number, s: number, t: number, k: number, still: boolean, lit = 0.45): void {
    const f = this.flick(t, k, still), h = (12 + 7 * f) * s
    if (lit) this.glow(x, y - h * 0.4, (24 + 8 * this.flick(t, k + 3, still)) * s * 1.4, lit)
    const g = this.a.createRadialGradient(x, y - h * 0.35, 0, x, y - h * 0.35, h * 1.4)
    g.addColorStop(0, gray(0.55)); g.addColorStop(1, gray(0))
    this.a.fillStyle = g; this.ell(this.a, x, y - h * 0.4, h * 1.3, h * 1.1)
    this.a.fillStyle = gray(0.95); this.ell(this.a, x + (still ? 0 : Math.sin(t * 7 + k) * 1.2 * s), y - h * 0.45, 3.2 * s, h * 0.5)
  }
  private brazier(x: number, floorY: number, s: number, t: number, k: number, still: boolean): void {
    const b = this.b
    b.strokeStyle = gray(0.34); b.lineWidth = 3 * s; b.lineCap = 'round'
    for (const dx of [-14, 0, 14]) { b.beginPath(); b.moveTo(x + dx * 0.4 * s, floorY - 40 * s); b.lineTo(x + dx * s, floorY); b.stroke() }
    b.fillStyle = gray(0.46); b.beginPath(); b.ellipse(x, floorY - 44 * s, 20 * s, 9 * s, 0, 0, Math.PI); b.fill()
    b.fillStyle = gray(0.6); b.fillRect(x - 21 * s, floorY - 46 * s, 42 * s, 3 * s)
    this.glow(x, floorY - 60 * s, 60 * s * (0.9 + 0.1 * this.flick(t, k, still)), 0.3)
    for (let j = 0; j < 4; j++) this.flame(x + (j - 1.5) * 7 * s, floorY - 46 * s, s * (j % 2 ? 1.25 : 1), t, k * 4 + j, still, 0)
    if (!still) for (let p = 0; p < 6; p++) {
      const ph = (t * 0.55 + p / 6 + k * 0.3) % 1
      this.a.fillStyle = gray(0.9 * (1 - ph)); this.ell(this.a, x + Math.sin(p * 13 + t * 1.6) * 10 * s, floorY - 60 * s - ph * 90 * s, 1.6 * s, 1.6 * s)
    }
  }
  private lamp(x: number, y: number, s: number, t: number, k: number, still: boolean): void {
    this.b.fillStyle = gray(0.62); this.ell(this.b, x, y, 10 * s, 4.5 * s)
    this.b.fillStyle = gray(0.4); this.b.fillRect(x + 6 * s, y - 2 * s, 6 * s, 3 * s)
    this.flame(x + 11 * s, y - 2 * s, 0.55 * s, t, k, still)
  }
  private scrollShape(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, v = 0.9, lines = true): void {
    c.fillStyle = gray(v); c.fillRect(x - w / 2, y - h / 2, w, h)
    c.fillStyle = gray(v * 0.68); c.fillRect(x - w / 2 - 3, y - h / 2 - 3, 5, h + 6); c.fillRect(x + w / 2 - 2, y - h / 2 - 3, 5, h + 6)
    if (lines) { c.fillStyle = gray(v * 0.55); for (let i = 1; i < 4; i++) c.fillRect(x - w / 2 + 5, y - h / 2 + i * h / 4, w - 10, 1.2) }
  }
  /** The chair's high seat, its outline in the glow so it reads as marble lit from the side. */
  private highSeat(x: number, base: number, cs: number, tall: number): void {
    const path = (c: CanvasRenderingContext2D): void => {
      c.beginPath(); c.moveTo(x - 44 * cs, base); c.lineTo(x - 44 * cs, base - tall * cs)
      c.quadraticCurveTo(x, base - (tall + 38) * cs, x + 44 * cs, base - tall * cs); c.lineTo(x + 44 * cs, base)
    }
    this.b.fillStyle = gray(0.22); path(this.b); this.b.fill()
    this.a.strokeStyle = gray(0.55); this.a.lineWidth = 2.2; path(this.a); this.a.stroke()
  }

  private drawBack(t: number, still: boolean): void {
    const g = this.geometry!, b = this.b, W = g.width
    const wash = (x: number, y: number): void => {
      const grad = b.createRadialGradient(x, y, 10, x, y, W * 0.5); grad.addColorStop(0, gray(0.13)); grad.addColorStop(1, gray(0.03))
      b.fillStyle = grad; b.fillRect(0, 0, W, g.height)
    }
    if (g.layout === 'long-table') {
      wash(W / 2, g.tableY - 120 * g.s)
      const floorTop = g.tableY + 14 + g.faceH
      if (W > 640) { this.brazier(W * 0.045 + 14, floorTop + 20, g.s * 0.95, t, 1, still); this.brazier(W * 0.955 - 14, floorTop + 20, g.s * 0.95, t, 2, still) }
      this.highSeat(g.chair.x, g.tableY, g.chair.s, 128)
    } else if (g.layout === 'half-circle') {
      wash(g.cx, g.cy - g.ry)
      // Tiers of marble steps under the seats.
      for (const [k, v] of [[1.08, 0.2], [0.98, 0.28]] as const) {
        b.strokeStyle = gray(v); b.lineWidth = 16 * g.s; b.beginPath(); b.ellipse(g.cx, g.cy + 8 * g.s, g.rx * k, g.ry * k, 0, Math.PI, 0); b.stroke()
      }
      // The altar at the centre, its fire in a brazier.
      this.brazier(g.cx, g.cy - g.ry * 0.12, g.s * 0.95, t, 7, still)
      this.highSeat(g.chair.x, g.chair.y, g.chair.s, 132)
    } else {
      wash(g.cx, g.cy - g.ry * 2)
      const wallBot = g.cy - g.ry - 40 * g.s
      if (W > 640) { this.brazier(W * 0.07, wallBot + 40 * g.s, g.s * 0.8, t, 1, still); this.brazier(W * 0.93, wallBot + 40 * g.s, g.s * 0.8, t, 2, still) }
      this.highSeat(g.chair.x, g.chair.y, g.chair.s, 132)
    }
  }

  private longTable(t: number, still: boolean): { L: number; R: number } {
    const g = this.geometry!
    if (g.layout !== 'long-table') return { L: 0, R: 0 }
    const b = this.b, { tableY, faceH, s } = g
    const xs = [g.chair.x, ...g.panelists.map(item => item.x)]
    const x0 = Math.max(10, Math.min(...xs) - 90 * s), x1 = Math.min(g.width - 10, Math.max(...xs) + 90 * s)
    const hx = Math.max(g.width / 2 - x0, x1 - g.width / 2), L = g.width / 2 - hx, R = g.width / 2 + hx
    let grad = b.createLinearGradient(0, tableY, 0, tableY + 14); grad.addColorStop(0, gray(0.66)); grad.addColorStop(1, gray(0.5))
    b.fillStyle = grad; b.beginPath(); b.moveTo(L + 16, tableY); b.lineTo(R - 16, tableY); b.lineTo(R, tableY + 14); b.lineTo(L, tableY + 14); b.fill()
    grad = b.createLinearGradient(0, tableY + 14, 0, tableY + 14 + faceH); grad.addColorStop(0, gray(0.42)); grad.addColorStop(1, gray(0.26))
    b.fillStyle = grad; b.fillRect(L, tableY + 14, R - L, faceH)
    b.fillStyle = gray(0.8); b.fillRect(L, tableY + 13, R - L, 2)
    const lamps = [g.chair.x - g.spacing / 2, g.chair.x + g.spacing / 2]
    if (g.half > 1) lamps.push(g.chair.x - g.spacing * 1.5, g.chair.x + g.spacing * 1.5)
    lamps.forEach((x, k) => { if (x > L + 20 && x < R - 20) this.lamp(x, tableY + 6, s, t, k + 5, still) })
    return { L, R }
  }

  private roundTable(t: number, still: boolean): void {
    const g = this.geometry!
    if (g.layout !== 'round-table') return
    const b = this.b, a = this.a, { cx, cy, rx, ry, s } = g
    b.fillStyle = gray(0.22); this.ell(b, cx, cy + 16 * s, rx, ry); b.fillRect(cx - rx, cy, rx * 2, 16 * s)
    const grad = b.createRadialGradient(cx - rx * 0.3, cy - ry * 0.4, 10, cx, cy, rx); grad.addColorStop(0, gray(0.66)); grad.addColorStop(1, gray(0.44))
    b.fillStyle = grad; this.ell(b, cx, cy, rx, ry)
    b.strokeStyle = gray(0.3); b.lineWidth = 1.6; b.beginPath(); b.ellipse(cx, cy, rx * 0.7, ry * 0.7, 0, 0, Math.PI * 2); b.stroke()
    // A star inlaid at the table's centre.
    a.fillStyle = gray(0.34); a.beginPath()
    for (let k = 0; k < 16; k++) { const an = k * Math.PI / 8 - Math.PI / 2, rr = k % 2 ? 0.1 : 0.26; a.lineTo(cx + Math.cos(an) * rx * rr, cy + Math.sin(an) * ry * rr) }
    a.fill()
    g.panelists.forEach((item, k) => this.lamp(cx + Math.cos(item.angle + 0.5) * rx * 0.45, cy + Math.sin(item.angle + 0.5) * ry * 0.45, s * 0.9, t, k + 9, still))
    let last = -1
    for (let an = Math.PI * 0.85; an <= Math.PI * 2.15; an += 0.01) {
      const c = this.col(cx + Math.cos(an) * rx * 0.93), r = this.row(cy + Math.sin(an) * ry * 0.9), k = r * this.cols + c
      if (k !== last && (c + r) % 2 === 0) this.grid.put(c, r, '◦', 0.5)
      last = k
    }
  }

  // ---------- Figures ----------

  private poseOf(key: string): Pose {
    let pose = this.poses.get(key)
    if (pose === undefined) { pose = { alpha: 0, arm: 0, chin: 0, scroll: 0, write: 0, raise: 0, bow: 0, turn: 0, talk: 0, stand: 0 }; this.poses.set(key, pose) }
    return pose
  }

  /** The pose a figure eases toward for what its thread is doing, and which way it looks. */
  private target(act: ChamberAct, t: number, seed: number, gaze: number, still: boolean): Pose {
    const g: Pose = { alpha: 1, arm: 0, chin: 0, scroll: 0, write: 0, raise: 0, bow: 0, turn: gaze, talk: 0, stand: 0 }
    const sway = still ? 0 : Math.sin(t * 0.9 + seed) * 0.25
    if (act === 'think') Object.assign(g, { chin: 1, bow: 0.35, turn: sway * 0.6 })
    else if (act === 'write') Object.assign(g, { write: 1, bow: 0.6, turn: 0, talk: 0.25 })
    else if (act === 'read') Object.assign(g, { scroll: 1, bow: 0.45, turn: still ? 0 : Math.sin(t * 2.2 + seed) * 0.35 })
    else if (act === 'speak') Object.assign(g, { arm: 0.85 + (still ? 0 : 0.15 * Math.sin(t * 2.6 + seed)), talk: 1, stand: 1, turn: gaze * 0.5 })
    else if (act === 'ask') Object.assign(g, { raise: 1, turn: 0 })
    else if (act === 'present') Object.assign(g, { arm: 1, turn: 0 })
    else if (act === 'idle') g.turn = still ? 0 : Math.sin(t * 0.35 + seed * 2) * 0.6
    else if (gaze && !still) g.bow = 0.22 * Math.max(0, Math.sin(t * 1.6 + seed * 5)) ** 14
    return g
  }

  /**
   * Eases a pose toward its target. Returns whether it is still on its way somewhere, such as standing to speak; a
   * figure that only follows its own slow glance or sway lags it by less than SETTLED and does not count.
   */
  private ease(pose: Pose, target: Pose, dt: number, still: boolean): boolean {
    const u = still ? 1 : 1 - Math.exp(-dt * 7)
    let moving = false
    for (const key of POSE_KEYS) {
      const gap = target[key] - pose[key]
      // Within a hair it lands exactly, so a still figure never shifts a cell later as a vanishing remainder rounds.
      pose[key] = Math.abs(gap) < 0.002 ? target[key] : pose[key] + gap * u
      if (Math.abs(gap) > SETTLED) moving = true
    }
    return moving
  }

  private aura(x: number, y: number, r: number, v: number): void {
    if (v < 0.02) return
    const g = this.a.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, gray(0.3 * v)); g.addColorStop(0.7, gray(0.12 * v)); g.addColorStop(1, gray(0))
    this.a.fillStyle = g; this.ell(this.a, x, y, r, r * 0.8)
  }

  /** A seated senator behind the table edge at its `y`: seen from the front, or from behind on the round table's near side. */
  private figure(placed: Placed, t: number, still: boolean, writeU: number): void {
    const { figure: f, pose: p, seed } = placed
    const { x, y, s } = f
    const b = this.b, a = this.a
    this.aura(x, y - 60 * s, 95 * s, Math.max(p.talk, p.raise))
    b.save(); a.save(); b.globalAlpha = a.globalAlpha = p.alpha
    const lift = p.stand * 12 * s
    const sh = y - 52 * s - lift + (still ? 0 : Math.sin(t * 1.3 + seed) * 0.7 * s)
    const hx = x + p.turn * 3.2 * s, hy = sh - 27 * s + p.bow * 7 * s
    let g = b.createLinearGradient(x - 46 * s, sh - 8 * s, x + 40 * s, y)
    g.addColorStop(0, gray(0.84)); g.addColorStop(1, gray(0.4))
    b.fillStyle = g; b.beginPath()
    b.moveTo(x - 41 * s, y + 8); b.lineTo(x - 39 * s, sh + 16 * s); b.quadraticCurveTo(x - 37 * s, sh, x - 14 * s, sh - 5 * s)
    b.lineTo(x + 14 * s, sh - 5 * s); b.quadraticCurveTo(x + 37 * s, sh, x + 39 * s, sh + 16 * s); b.lineTo(x + 41 * s, y + 8); b.closePath(); b.fill()
    if (f.back) { b.fillStyle = gray(0.3); b.fillRect(x - 40 * s, sh + 16 * s, 80 * s, y - sh - 8 * s) }
    // The toga's fold over the shoulder, and on it the senator's stripe in the accent.
    b.lineCap = 'round'; b.strokeStyle = gray(f.back ? 0.7 : 0.97); b.lineWidth = 14 * s
    b.beginPath(); b.moveTo(x - 26 * s, sh - 1 * s); b.quadraticCurveTo(x + 2 * s, sh + 22 * s, x + 34 * s, y + 6); b.stroke()
    if (!f.back) {
      a.strokeStyle = gray(1); a.lineWidth = (f.chair ? 7 : 5.6) * s; a.lineCap = 'round'
      a.beginPath(); a.moveTo(x - 30 * s, sh - 6 * s); a.quadraticCurveTo(x + 1 * s, sh + 15 * s, x + 39 * s, y + 2); a.stroke()
    }
    b.strokeStyle = gray(0.22); b.lineWidth = 2.4 * s
    for (const o of [-9, 9, 18]) {
      b.beginPath(); b.moveTo(x - 26 * s + o * 0.4 * s, sh + Math.max(0, o) * 0.6 * s)
      b.quadraticCurveTo(x + 2 * s + o * 0.2 * s, sh + 22 * s + o * s, x + 34 * s - o * 0.5 * s, y + 6); b.stroke()
    }
    b.fillStyle = gray(0.62); b.fillRect(hx - 6 * s, hy + 10 * s, 12 * s, sh - hy - 8 * s)
    const look: ChamberLook = placed.seat.look
    if (look === 'bald') { b.fillStyle = gray(0.3); this.ell(b, hx - 14 * s, hy + 1 * s, 5 * s, 9 * s); this.ell(b, hx + 14 * s, hy + 1 * s, 5 * s, 9 * s) }
    else { b.fillStyle = gray(0.3); this.ell(b, hx - p.turn * 1.5 * s, hy - 4 * s, 18.5 * s, 20 * s) }
    if (f.back) {
      b.fillStyle = gray(0.42); this.ell(b, hx, hy, 15 * s, 18 * s)
      b.fillStyle = gray(0.22); for (let k = 0; k < 7; k++) this.ell(b, hx - 10 * s + k * 3.4 * s, hy - 8 * s + (k % 2) * 5 * s, 2 * s, 2 * s)
    } else {
      g = b.createRadialGradient(hx - 5 * s + p.turn * 2 * s, hy - 6 * s, 2 * s, hx, hy, 24 * s)
      g.addColorStop(0, gray(1)); g.addColorStop(1, gray(0.6))
      b.fillStyle = g; this.ell(b, hx + p.turn * 2 * s, hy + (look === 'bald' ? 0 : 3) * s, 15 * s, (look === 'bald' ? 20 : 17.5) * s)
      if (look === 'curls') { b.fillStyle = gray(0.2); for (let k = 0; k < 6; k++) this.ell(b, hx - 12 * s + k * 4.8 * s, hy - 15 * s + (k % 2) * 2.5 * s, 2.2 * s, 2.2 * s) }
      if (look === 'beard') {
        b.fillStyle = gray(0.36); b.beginPath(); b.ellipse(hx + p.turn * 2 * s, hy + 9 * s, 14 * s, 13 * s, 0, 0, Math.PI); b.fill()
        b.fillStyle = gray(0.22); for (let k = 0; k < 4; k++) this.ell(b, hx - 7 * s + k * 4.6 * s, hy + 16 * s + (k % 2) * 2 * s, 1.6 * s, 2.4 * s)
      }
    }
    // The chair's laurel, in the accent.
    if (f.chair) for (let k = 0; k < 11; k++) {
      const an = Math.PI * 1.02 + k * Math.PI * 0.96 / 10
      a.fillStyle = gray(0.92); this.ell(a, hx + Math.cos(an) * 19 * s, hy - 3 * s + Math.sin(an) * 18 * s, 5 * s, 2.3 * s, an + Math.PI / 2)
    }
    // Arms from the shoulders; at rest the hands lie folded on the table.
    const R0: [number, number] = [x - 32 * s, sh + 9 * s], L0: [number, number] = [x + 32 * s, sh + 9 * s]
    const rest = 1 - Math.max(p.arm, p.chin, p.scroll, p.write, p.raise)
    if (rest > 0.05 && !f.back) {
      b.save(); b.globalAlpha *= rest
      this.limb(b, [[x - 34 * s, y - 2 * s], [x - 8 * s, y - 7 * s]], 8 * s, 0.68, 0.97); this.limb(b, [[x + 34 * s, y - 2 * s], [x + 6 * s, y - 8 * s]], 8 * s, 0.62, 0.97)
      b.restore()
    }
    if (p.arm > 0.03) this.limb(b, [R0, lp([x - 48 * s, y - 14 * s], [x - 58 * s, sh - 10 * s], p.arm), lp([x - 30 * s, y - 4 * s], [x - 50 * s, sh - 46 * s], p.arm)], 10 * s, 0.8, 0.95)
    if (p.chin > 0.03) this.limb(b, [L0, lp([x + 46 * s, y - 14 * s], [x + 34 * s, y - 12 * s], p.chin), lp([x + 30 * s, y - 4 * s], [hx + 7 * s, hy + 19 * s], p.chin)], 10 * s, 0.72, 0.95)
    if (p.raise > 0.03) {
      this.limb(b, [L0, lp([x + 46 * s, y - 14 * s], [x + 50 * s, sh - 24 * s], p.raise), lp([x + 30 * s, y - 4 * s], [x + 47 * s, sh - 64 * s], p.raise)], 10 * s, 0.8, 0.98)
      // The raised hand glows, pulsing while motion is on.
      const pulse = still ? 0.8 : 0.55 + 0.45 * Math.sin(t * 5)
      g = a.createRadialGradient(x + 47 * s, sh - 64 * s, 0, x + 47 * s, sh - 64 * s, 22 * s); g.addColorStop(0, gray(pulse)); g.addColorStop(1, gray(0))
      a.fillStyle = g; this.ell(a, x + 47 * s, sh - 64 * s, 22 * s, 22 * s)
    }
    if (p.write > 0.03) {
      // A wax tablet, its strokes growing with the words, and the stylus moving over it.
      b.fillStyle = gray(0.78); b.fillRect(x - 30 * s, y - 13 * s, 60 * s, 15 * s); b.fillStyle = gray(0.3); b.fillRect(x - 27 * s, y - 11 * s, 54 * s, 11 * s)
      const c0 = this.col(x - 24 * s), c1 = this.col(x + 24 * s), r0 = this.row(y - 6 * s)
      for (let c = c0; c <= c0 + Math.round((c1 - c0) * writeU); c++) this.grid.put(c, r0, '~≈∽'[(c + Math.floor(writeU * 9)) % 3]!, 0.85)
      const wv = still ? 0.5 : (t * 0.85 + seed) % 1
      const hand: [number, number] = [x - 18 * s + 34 * s * wv, y - 6 * s + (still ? 0 : Math.sin(t * 13) * 1.2 * s)]
      this.limb(b, [R0, lp([x - 48 * s, y - 14 * s], [x - 34 * s, y - 20 * s], p.write), lp([x - 30 * s, y - 4 * s], hand, p.write)], 10 * s, 0.78, 0.95)
      b.strokeStyle = gray(0.95); b.lineWidth = 2 * s; b.beginPath(); b.moveTo(hand[0], hand[1]); b.lineTo(hand[0] + 6 * s, hand[1] - 9 * s); b.stroke()
    }
    if (p.scroll > 0.03) {
      const w = (26 + 54 * p.scroll) * s, cy = sh + 24 * s
      this.scrollShape(b, x, cy, w, 22 * s, 0.93)
      this.limb(b, [R0, [x - 44 * s, cy + 6 * s], [x - w / 2 - 2 * s, cy]], 9 * s, 0.76, 0.95)
      this.limb(b, [L0, [x + 44 * s, cy + 6 * s], [x + w / 2 + 2 * s, cy]], 9 * s, 0.76, 0.95)
      // The scrolls it reads, marked by letter.
      if (placed.seat.scrolls.length && p.scroll > 0.6) {
        const label = placed.seat.scrolls.join(' ')
        this.grid.blank(this.col(x) - Math.ceil(label.length / 2) - 1, this.row(cy), label.length + 2, 1)
        this.grid.centered(this.col(x), this.row(cy), label, 1, true)
      }
    }
    b.restore(); a.restore()
    // The face: eyes and a mouth that moves while it talks, as crisp glyphs.
    if (p.alpha > 0.5 && s > 0.45 && !f.back) {
      const ec = this.col(hx + p.turn * 5.5 * s), er = this.row(hy + 1.5 * s + p.bow * 2 * s)
      const gap = Math.max(1, Math.round(6.5 * s / CW))
      const blink = !still && ((t + seed * 2.3) % 4.7) < 0.13
      const eye = blink ? '-' : p.bow > 0.4 ? '‿' : 'o'
      this.grid.put(ec - gap, er, eye, 0.98); this.grid.put(ec + gap, er, eye, 0.98)
      if (p.talk > 0.3) {
        const open = still ? -1 : Math.sin(t * 15 + seed * 3)
        this.grid.put(ec, er + Math.max(1, Math.round(10 * s / CH)), open > 0.4 ? 'O' : open > -0.3 ? 'o' : '-', 0.98)
      }
    }
    placed.head = { x: hx, y: hy - 18 * s }
  }

  // ---------- A frame ----------

  /** Draws one frame. Returns whether anything is still moving toward where it is going: a pose, a scroll in the air, an unrolling. */
  draw(frame: ChamberFrame): boolean {
    const g = this.geometry, ink = this.ink
    if (g === null || ink === null) return false
    const { t, still, scene } = frame
    // A finished Council's tableau holds still; only its fire keeps flickering.
    const posed = still || scene.finished
    const W = g.width, H = g.height
    for (const c of [this.b, this.a, this.l]) { c.setTransform(SX / CW, 0, 0, SY / CH, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over' }
    this.b.fillStyle = gray(0.05); this.b.fillRect(0, 0, W, H)
    this.a.fillStyle = gray(0); this.a.fillRect(0, 0, W, H)
    this.l.fillStyle = gray(0); this.l.fillRect(0, 0, W, H); this.l.globalCompositeOperation = 'lighter'
    this.grid.clear()
    this.taken.length = 0
    // The art behind, with the beams breathing and motes drifting down them.
    this.art.code.set(this.staticArt.code); this.art.strength.set(this.staticArt.strength); this.art.accent.set(this.staticArt.accent)
    if (!posed) {
      for (let i = 0; i < this.beamCells.length; i++) {
        const k = this.beamCells[i]!, r = Math.floor(k / this.cols)
        this.art.strength[k] = 0.05 + 0.035 * Math.sin(t * 0.6 + r * 0.25 + (k % this.cols) * 0.02)
      }
      for (const cb of this.beamCols) for (let i = 0; i < 4; i++) {
        const ph = (t * 0.025 + i / 4 + cb * 0.01) % 1, r = Math.round(3 + ph * Math.max(0, this.beamStop - 3)), c = Math.round(cb + (r - 3) * 0.85 + Math.sin(t * 0.7 + i * 2) * 2)
        this.art.put(c, r, '·', 0.35 * Math.sin(ph * Math.PI), true)
      }
    }
    this.drawBack(t, still)

    // Poses: each figure eases toward what its thread is doing; one at rest turns toward the nearest that is busy.
    const seats = [...scene.panelists, scene.chair]
    const figures = [...g.panelists, g.chair]
    const placed: Placed[] = []
    for (let i = 0; i < seats.length && i < figures.length; i++) {
      const seat = i < scene.panelists.length ? scene.panelists[i]! : scene.chair
      const figure = i < g.panelists.length ? g.panelists[i]! : g.chair
      placed.push({ figure, seat, pose: this.poseOf(seat.key), seed: i * 1.7 + 0.4, head: { x: figure.x, y: figure.y } })
    }
    let moving = false
    for (const item of placed) {
      const act = item.seat.act
      let gaze = 0, near: Placed | undefined, best = Number.POSITIVE_INFINITY
      if (RESTING.has(act)) for (const other of placed) {
        if (other === item || !ACTIVE.has(other.seat.act)) continue
        const d = Math.abs(other.figure.x - item.figure.x)
        if (d < best) { best = d; near = other }
      }
      if (near) gaze = clamp((near.figure.x - item.figure.x) / 120, -1, 1)
      const target = this.target(act === 'listen' ? 'done' : act, t, item.seed, gaze, posed)
      if (item.figure.turn && !near && RESTING.has(act) && act !== 'idle') target.turn = item.figure.turn
      if (item.figure.back) target.turn = 0
      if (this.ease(item.pose, target, frame.dt, still)) moving = true
    }
    const writeU = (seat: ChamberSeat): number => seat.speech.kind === 'words' ? Math.min(1, seat.speech.text.length / 240) : seat.chair ? Math.min(1, frame.verdictText.length / 600) : 0.5

    // Back to front.
    if (g.layout === 'long-table') {
      const chair = placed.find(item => item.figure.chair)
      if (chair) this.figure(chair, t, posed, writeU(chair.seat))
      for (const item of placed) if (!item.figure.chair) this.figure(item, t, posed, writeU(item.seat))
      const span = this.longTable(t, still), kr = this.row(g.tableY + 20)
      for (let c = this.col(span.L) + 1; c < this.col(span.R) - 1; c++) { this.grid.put(c, kr, '╔═╗ '[c % 4]!, 0.42); this.grid.put(c, kr + 1, '╝ ╚═'[c % 4]!, 0.42) }
    } else if (g.layout === 'half-circle') {
      for (const item of [...placed].sort((p, q) => q.figure.depth - p.figure.depth)) {
        this.figure(item, t, posed, writeU(item.seat))
        const f = item.figure, w = 86 * f.s, h = 22 * f.s
        const grad = this.b.createLinearGradient(0, f.y, 0, f.y + h); grad.addColorStop(0, gray(0.62)); grad.addColorStop(1, gray(0.36))
        this.b.fillStyle = grad; this.b.fillRect(f.x - w / 2, f.y, w, h); this.b.fillStyle = gray(0.82); this.b.fillRect(f.x - w / 2, f.y, w, 2)
        this.b.fillStyle = gray(0.2); this.b.fillRect(f.x - w / 2, f.y + h, w, 30 * f.s)
      }
    } else {
      for (const item of placed.filter(item => !item.figure.back).sort((p, q) => p.figure.y - q.figure.y)) this.figure(item, t, posed, writeU(item.seat))
      this.roundTable(t, still)
      for (const item of placed) if (item.figure.back) this.figure(item, t, posed, writeU(item.seat))
    }

    // Each answer's scroll on the table, until the chair gathers them.
    const gathering = scene.stage === 'verdict' || scene.stage === 'fairness' || scene.stage === 'done'
    if (!gathering) for (const item of placed) if (item.seat.answered) { const d = item.figure.desk; this.scrollShape(this.b, d.x, d.y, 26 * item.figure.s, 7 * item.figure.s, 0.86, false) }

    // Scrolls in the air, in the accent, with a trail.
    const deskOf = (key: string): ChamberPoint | undefined => placed.find(item => item.seat.key === key)?.figure.desk
    for (const flight of frame.flights) {
      const u = still ? 1 : clamp((t - flight.t0) / 1.6, 0, 1)
      if (u >= 1 || t < flight.t0) { if (t < flight.t0) moving = true; continue }
      moving = true
      const A0 = deskOf(flight.from), B0 = deskOf(flight.to)
      if (!A0 || !B0) continue
      const ctl = g.layout === 'round-table' ? { x: (A0.x + B0.x) / 2 * 0.4 + g.cx * 0.6, y: (A0.y + B0.y) / 2 * 0.4 + g.cy * 0.6 - 20 }
        : { x: (A0.x + B0.x) / 2, y: Math.min(A0.y, B0.y) - (g.layout === 'half-circle' ? 60 : 90) }
      const at = (v: number): ChamberPoint => ({ x: (1 - v) ** 2 * A0.x + 2 * (1 - v) * v * ctl.x + v * v * B0.x, y: (1 - v) ** 2 * A0.y + 2 * (1 - v) * v * ctl.y + v * v * B0.y })
      const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2
      for (let k = 1; k < 7; k++) { const q = at(Math.max(0, e - k * 0.035)); this.grid.put(this.col(q.x), this.row(q.y), '·', 0.7 - k * 0.09, true) }
      const q = at(e)
      this.scrollShape(this.a, q.x, q.y, 22, 8, 0.95, false)
      this.grid.put(this.col(q.x), this.row(q.y) - 1, flight.label, 1, true)
    }

    // Plates first, then the bubbles find room round them. Each is as wide as its place at the table allows.
    const verdict = scene.verdict
    const cap = g.layout === 'long-table' ? Math.max(6, Math.floor(g.spacing / CW) - 3) : 20
    const fit = (words: string): string => words.length > cap ? `${words.slice(0, Math.max(1, cap - 1))}…` : words
    for (const item of placed) {
      const words = frame.words.get(item.seat.key)
      if (!words) continue
      // At the long table the verdict unrolls over the chair's plate.
      if (item.figure.chair && g.layout === 'long-table' && verdict) continue
      // The chair's plate gives its model alone when its provider and model together would not fit.
      const name = fit(words.name), sub = fit(words.sub.length > cap && words.subShort ? words.subShort : words.sub)
      const p = item.figure.plate, pw = Math.max(name.length, sub.length, words.mark.length) + 2
      const rows = words.mark ? 3 : 2
      const c = this.col(p.x), r = clamp(this.row(p.y), 0, Math.max(0, this.rows - rows))
      this.grid.blank(c - Math.ceil(pw / 2), r, pw, rows)
      this.grid.centered(c, r, name, 0.55); this.grid.centered(c, r + 1, sub, 0.85)
      if (words.mark) this.grid.centered(c, r + 2, words.mark, 0.75, words.markAccent)
      this.taken.push({ l: c - Math.ceil(pw / 2), t: r, w: pw, h: rows })
    }

    // The verdict scroll unrolls from the chair, then shimmers once when it is finished.
    if (verdict) {
      const u = still ? 1 : clamp((t - frame.verdictSince) / 2.4, 0, 1)
      if (u < 1) moving = true
      const chair = g.chair
      const wCols = Math.max(12, Math.min(34, this.cols - 6, g.layout === 'long-table' ? Math.max(22, Math.floor(2 * g.spacing / CW) - 12) : g.layout === 'half-circle' ? 26 : 99))
      const vx = g.layout === 'round-table' ? g.cx : chair.x
      const vy = g.layout === 'long-table' ? g.tableY + 40 : g.layout === 'half-circle' ? chair.y + 54 * chair.s : g.cy - g.ry * 0.62
      const maxH = g.layout === 'round-table' ? g.ry * 1.5 : H - vy - 10
      const all = wrapWords(frame.verdictText, wCols - 4)
      const fits = Math.max(1, Math.floor(Math.max(0, maxH) / CH) - 2)
      const lines = verdict.finished ? all.slice(0, fits) : all.slice(Math.max(0, all.length - fits))
      const hgt = Math.min(maxH, (lines.length + 2) * CH) * u, wPx = wCols * CW
      this.b.fillStyle = gray(0); this.b.fillRect(vx - wPx / 2, vy, wPx, hgt)
      this.a.fillStyle = gray(0.62); this.a.fillRect(vx - wPx / 2 - 5, vy - 6, wPx + 10, 7); this.a.fillRect(vx - wPx / 2 - 5, vy + hgt - 1, wPx + 10, 7)
      const c0 = this.col(vx) - Math.floor(wCols / 2) + 2, shown = Math.max(0, Math.floor(hgt / CH) - 1)
      this.grid.blank(c0 - 2, this.row(vy), wCols, Math.ceil(hgt / CH))
      const sweep = still || !verdict.finished ? -1 : (t - frame.finishedSince) / 1.6
      if (sweep >= 0 && sweep < 1.2) moving = true
      lines.slice(0, shown).forEach((line, i) => {
        for (let j = 0; j < line.length; j++) {
          const f = (j + i * 2) / (wCols + 8), hot = sweep > 0 && sweep < 1.2 && Math.abs(f - sweep) < 0.08
          this.grid.put(c0 + j, this.row(vy) + 1 + i, line[j]!, hot ? 1 : 0.98, hot)
        }
      })
      this.taken.push({ l: c0 - 2, t: this.row(vy), w: wCols, h: Math.ceil(hgt / CH) })
    }

    // Bubbles: words being said first, so they get the best places.
    const dots = still ? '…' : '.'.repeat(1 + Math.floor(t * 2.5) % 3)
    const speakers = placed.filter(item => frame.words.get(item.seat.key)?.bubble).sort((p, q) => Number(frame.words.get(q.seat.key)!.bubble!.say) - Number(frame.words.get(p.seat.key)!.bubble!.say))
    for (const item of speakers) {
      const bubble = frame.words.get(item.seat.key)!.bubble!
      const shape = bubbleShape(bubble.text, bubble.title, bubble.say, Math.min(item.figure.maxCols, this.cols - 2), dots)
      const anchor = item.figure.bubble, c = this.col(anchor.x), r = this.row(anchor.y)
      const box = placeBubble(c, r, shape.w, shape.h, anchor.side, this.cols, this.rows, this.taken)
      this.taken.push(box)
      drawBubble(this.grid, box, shape, bubble.say, { c: this.col(item.head.x), r: this.row(item.head.y) })
    }
    this.settling = moving
    this.rasterize()
    this.paint(ink)
    return moving
  }

  private rasterize(): void {
    const cols = this.cols, rows = this.rows, sw = cols * SX
    const db = this.b.getImageData(0, 0, cols * SX, rows * SY).data, da = this.a.getImageData(0, 0, cols * SX, rows * SY).data, dl = this.l.getImageData(0, 0, cols * SX, rows * SY).data
    const D = this.D, E = this.E, LT = this.LT, noise = this.noise
    const n = SX * SY * 255
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let sb = 0, sa = 0, sl = 0
      for (let yy = 0; yy < SY; yy++) { let i = ((r * SY + yy) * sw + c * SX) * 4; for (let xx = 0; xx < SX; xx++, i += 4) { sb += db[i]!; sa += da[i]!; sl += dl[i]! } }
      const k = r * cols + c
      D[k] = sb / n; E[k] = sa / n; LT[k] = sl / n
    }
    const code = this.outCode, strength = this.outStrength, accent = this.outAccent
    const art = this.art, over = this.grid
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const k = r * cols + c, e = E[k]!, dk = D[k]!, lit = LT[k]! > 0.34 + noise[k]! * 0.2
      const d = dk > 0.25 ? Math.round(dk * 7) / 7 : clamp(dk + (noise[k]! - 0.5) * 0.03, 0, 1)
      code[k] = 0
      if (e > 0.1 && e > d * 0.55) { code[k] = RAMP.charCodeAt(Math.max(1, Math.round(e * 10))); strength[k] = Math.min(1, 0.25 + e); accent[k] = 1 }
      else {
        const gx = c > 0 && c < cols - 1 ? D[k + 1]! - D[k - 1]! : 0, gy = r > 0 && r < rows - 1 ? (D[k + cols]! - D[k - cols]!) * 0.75 : 0
        const mag = Math.hypot(gx, gy)
        if (mag > 0.3 && Math.max(dk, D[k - 1] ?? 0, D[k + 1] ?? 0) > 0.2) {
          const ax = Math.abs(gx), ay = Math.abs(gy)
          code[k] = (ax > ay * 2.2 ? '|' : ay > ax * 2.2 ? (gy > 0 ? '_' : '-') : (gx * gy > 0 ? '/' : '\\')).charCodeAt(0)
          strength[k] = clamp(0.45 + mag * 0.6, 0.5, 1); accent[k] = lit ? 1 : 0
        } else if (d > 0.145) { code[k] = RAMP.charCodeAt(Math.max(1, Math.round(d * 10))); strength[k] = 0.06 + d * 0.66; accent[k] = d > 0.2 && lit ? 1 : 0 }
        else if (art.code[k]) { code[k] = art.code[k]!; strength[k] = art.strength[k]!; accent[k] = art.accent[k]! }
      }
      const written = over.code[k]!
      if (written) { if (written === 32) code[k] = 0; else { code[k] = written; strength[k] = over.strength[k]!; accent[k] = over.accent[k]! } }
    }
  }

  private glyph(code: number): string {
    let glyph = this.glyphs.get(code)
    if (glyph === undefined) { glyph = String.fromCharCode(code); this.glyphs.set(code, glyph) }
    return glyph
  }

  /** Paints the cells grouped by ink and strength, so each of the 42 inks is set once a frame. */
  private paint(ink: SceneInk): void {
    const ctx = this.view, cols = this.cols, cells = cols * this.rows
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    ctx.font = this.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    const counts = this.counts, bucketOf = this.bucketOf, order = this.order
    counts.fill(0)
    for (let k = 0; k < cells; k++) {
      const step = this.outCode[k] ? Math.round(Math.min(1, this.outStrength[k]!) * 20) : 0
      const bucket = step === 0 ? 0 : step + (this.outAccent[k] ? 21 : 0)
      bucketOf[k] = bucket
      counts[bucket + 1] = counts[bucket + 1]! + 1
    }
    for (let i = 1; i < counts.length; i++) counts[i] = counts[i]! + counts[i - 1]!
    for (let k = 0; k < cells; k++) { const bucket = bucketOf[k]!, at = counts[bucket]!; order[at] = k; counts[bucket] = at + 1 }
    let current = -1
    for (let i = 0; i < cells; i++) {
      const k = order[i]!, bucket = bucketOf[k]!
      if (bucket === 0) continue
      if (bucket !== current) { current = bucket; ctx.fillStyle = bucket > 21 ? inkAt(ink.accent, (bucket - 21) / 20) : inkAt(ink.ink, bucket / 20) }
      ctx.fillText(this.glyph(this.outCode[k]!), (k % cols) * CW + CW / 2, Math.floor(k / cols) * CH + CH / 2 + 0.5)
    }
  }
}
