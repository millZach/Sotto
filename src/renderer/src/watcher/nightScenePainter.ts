import type { WatcherScene } from '../../../shared/watcherScene'
import {
  clamp, COLUMN_QUIET, gridFor, inkAt, inLane, inMargin, layoutScene, lerp, OWL_GAP, owlLayer, placeStars, quietAt, rampGlyph,
  RIPPLE_GLYPHS, rippleAt, rippleReach, runningRipples, seeded, starStrength, twinkleStep, WHIRL_GLYPHS,
  type Grid, type OwlPose, type OwlStage, type Ripple, type RippleEffect, type SceneInk, type SceneLayout, type SceneMeasure, type Spot, type Star,
} from './nightScene'
import { glowStep, owlGlyphs, pileLabel, spriteCells, type ThreadOwlPose } from './owlFamily'
import { ambienceStep, ambienceTime, type Ambience, type AmbientGlyph } from './scenePlace'
import { SCENE_PLACES } from './scenePlaces'
import { MASK, poly } from './sceneDraw'

/**
 * Draws Watcher's night scene in the room's side margins, on two canvases: the landscape on one, under everything in
 * the pane, and the owls on the other, over the composer and under every menu. Shapes are drawn first as vectors on
 * small offscreen canvases, two field pixels to a glyph cell a side, whose coverage becomes each cell's density; a cell
 * is then drawn as the glyph for its density. The landscape is the chosen place's (`scenePlaces.ts`, ADR-0148), and its
 * glyphs are drawn once per size, theme and place and kept. A frame copies them, clears the cells under the owls, and
 * redraws only the stars, the place's few moving glyphs, the whirlpool and the cells a ripple reaches; the owls are
 * drawn on their own canvas. A frame whose picture would not change is not painted at all.
 * Between the margins the sky and the hills show at the column's share, still whatever the words over them do, with no
 * glyph stronger than the words written over it allow (`SceneInk.column`). Trees, owls and ripples stay in the margins.
 */

/** Field pixels per glyph cell, a side. */
export const SS = 2
/** The glyphs' size, which fills a 7 by 12 cell. */
export const GLYPH_PX = 10.5

export function context(canvas: HTMLCanvasElement | OffscreenCanvas, read = false): CanvasRenderingContext2D | null {
  return (canvas as HTMLCanvasElement).getContext('2d', read ? { willReadFrequently: true } : undefined) as CanvasRenderingContext2D | null
}

export function makeCanvas(): HTMLCanvasElement {
  return document.createElement('canvas')
}

/** Averages a block of field pixels' coverage into each cell of `out`. */
export function readField(ctx: CanvasRenderingContext2D, out: Float32Array, grid: Grid, c0: number, r0: number, cn: number, rn: number): void {
  if (cn <= 0 || rn <= 0) return
  const data = ctx.getImageData(c0 * SS, r0 * SS, cn * SS, rn * SS).data
  const stride = cn * SS
  for (let r = 0; r < rn; r++) for (let c = 0; c < cn; c++) {
    let sum = 0
    for (let y = 0; y < SS; y++) for (let x = 0; x < SS; x++) sum += data[((r * SS + y) * stride + c * SS + x) * 4 + 3]!
    out[(r0 + r) * grid.cols + c0 + c] = sum / (SS * SS * 255)
  }
}

export function prepare(ctx: CanvasRenderingContext2D, grid: Grid, layout: { readonly width: number; readonly height: number }): void {
  ctx.setTransform(SS / grid.cw, 0, 0, SS / grid.ch, 0, 0)
  ctx.clearRect(-layout.width, -layout.height, layout.width * 3, layout.height * 3)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = MASK
  ctx.strokeStyle = MASK
}

// ---------- Watcher's owl ----------

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0): void {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fill()
}

function wing(d: CanvasRenderingContext2D, side: 1 | -1, o: OwlPose): void {
  const span = 12 + 52 * o.spread
  const lift = Math.sin(o.flap) * span * 0.55
  const persp = 0.8 + 0.2 * Math.cos(o.flap)
  const sx = side * 9, sy = -3
  const tx = side * (9 + span * persp), ty = sy - lift
  const rx = side * 7, ry = sy + 17 - lift * 0.15
  d.globalAlpha = 0.72
  d.beginPath(); d.moveTo(sx, sy - 5)
  d.quadraticCurveTo(side * (9 + span * 0.5 * persp), sy - lift * 0.8 - 10, tx, ty)
  let px = tx, py = ty
  for (let k = 1; k <= 5; k++) {
    const t = k / 5
    const nx = lerp(tx, rx, t), ny = lerp(ty, ry, t) + Math.sin(t * Math.PI) * 7
    d.quadraticCurveTo((px + nx) / 2, (py + ny) / 2 + 5, nx, ny)
    px = nx; py = ny
  }
  d.closePath(); d.fill()
  d.globalCompositeOperation = 'destination-out'; d.globalAlpha = 0.32; d.lineWidth = 1.6
  for (let k = 1; k <= 3; k++) {
    const t = k / 4
    d.beginPath(); d.moveTo(lerp(sx, tx, t), lerp(sy - 3, ty, t)); d.lineTo(lerp(sx, tx, t * 0.85), lerp(sy + 12, ty + 6, t)); d.stroke()
  }
  d.globalCompositeOperation = 'source-over'
}

/** The owl as vectors: its body on `d`, its eyes on `a`, the accent's field. */
export function drawOwl(d: CanvasRenderingContext2D, a: CanvasRenderingContext2D, o: OwlPose): void {
  for (const ctx of [d, a]) { ctx.save(); ctx.translate(o.x, o.y - 30 * o.s); ctx.rotate(o.bank); ctx.scale(o.s, o.s * o.squash); ctx.translate(0, 30 * (1 - o.squash)) }
  const fly = o.spread > 0.05
  d.globalAlpha = 0.9
  poly(d, [[-5, 22], [5, 22], [fly ? 8 : 4, fly ? 33 : 31], [fly ? -8 : -4, fly ? 33 : 31]])
  if (fly) { wing(d, -1, o); wing(d, 1, o) }
  d.globalAlpha = 0.5; ellipse(d, 0, 6, fly ? 14 : 17, fly ? 19 : 22)
  if (!fly) { d.globalAlpha = 0.85; ellipse(d, -13.5, 7, 6.5, 18, 0.12); ellipse(d, 13.5, 7, 6.5, 18, -0.12) }
  d.globalCompositeOperation = 'destination-out'; d.globalAlpha = 0.55; d.lineWidth = 1.5
  for (let row = 0; row < 4; row++) for (let k = -1; k <= 1; k++) {
    const x = k * 6 + (row % 2) * 3 - 1.5, y = 1 + row * 5.5
    if (Math.abs(x) > 9 - row) continue
    d.beginPath(); d.moveTo(x - 2.2, y); d.lineTo(x, y + 2); d.lineTo(x + 2.2, y); d.stroke()
  }
  d.globalCompositeOperation = 'source-over'
  const hx = o.turn * 4
  d.globalAlpha = 0.62; ellipse(d, hx * 0.5, -17, 16, 13)
  d.globalAlpha = 0.85
  const tuft = fly ? -31 : -37
  poly(d, [[-12 + hx, -25], [-18 + hx * 1.2, tuft], [-5 + hx, -28]])
  poly(d, [[12 + hx, -25], [18 + hx * 1.2, tuft], [5 + hx, -28]])
  const sp = 6.6 * (1 - 0.22 * Math.abs(o.turn))
  d.globalCompositeOperation = 'destination-out'; d.globalAlpha = 0.6
  ellipse(d, hx - sp, -17, 6.8, 6.8); ellipse(d, hx + sp, -17, 6.8, 6.8)
  d.globalCompositeOperation = 'source-over'
  for (const side of [-1, 1] as const) {
    const ex = hx + side * sp, ey = -17
    if (o.blink) { d.globalAlpha = 0.9; ellipse(d, ex, ey + 0.5, 4.8, 1.5) }
    else {
      d.globalAlpha = 1; ellipse(d, ex + o.gx, ey + o.gy, 3.2, 3.2)
      a.globalAlpha = 1; ellipse(a, ex + o.gx, ey + o.gy, 3.8, 3.8)
    }
  }
  d.globalAlpha = 1; poly(d, [[hx - 1.9, -13], [hx + 1.9, -13], [hx, -8.3]])
  d.lineCap = 'round'; d.lineWidth = 1.7
  if (!fly) {
    for (const side of [-1, 1]) for (const t of [-2, 0, 2]) { d.beginPath(); d.moveTo(side * 5, 27); d.lineTo(side * 5 + t, 30.5); d.stroke() }
  } else if (o.legs > 0) {
    for (const side of [-1, 1]) {
      const fy = 24 + 9 * o.legs
      d.beginPath(); d.moveTo(side * 4, 22); d.lineTo(side * 5, fy); d.stroke()
      for (const t of [-2.2, 0, 2.2]) { d.beginPath(); d.moveTo(side * 5, fy); d.lineTo(side * 5 + t, fy + 3); d.stroke() }
    }
  }
  d.restore(); a.restore()
}

// ---------- The painter ----------

interface CellBox { readonly c0: number; readonly r0: number; readonly cn: number; readonly rn: number }

/** Everything one frame shows. */
export interface SceneFrame {
  readonly t: number
  readonly still: boolean
  readonly ripples: readonly Ripple[]
  /** Watcher's owl, where the margin has trees; null on the rail or with no scene. */
  readonly watcher: { readonly pose: OwlPose; readonly stage: OwlStage } | null
  readonly owls: readonly ThreadOwlPose[]
  /** How open the moon's whirlpool is, 0 to 1. */
  readonly whirl: number
  /** The "+N" pile, in the last spot, while there is one. */
  readonly pile: { readonly spot: Spot; readonly count: number } | null
}

/** A perched thread owl's cells, for its button in the room. */
export interface OwlTarget { readonly key: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export class NightScenePainter {
  private layout: SceneLayout | null = null
  private grid: Grid = { cols: 0, rows: 0, cw: 7, ch: 12 }
  private dpr = 1
  private ink: SceneInk | null = null
  private font = ''
  private land = new Float32Array(0)
  private landAccent = new Float32Array(0)
  /** Each cell's share of the scene: quietAt, for the theme's column strength. */
  private quiet = new Float32Array(0)
  /** Cells in a margin, the only ones a ripple or the whirlpool reaches, and the only ones past the column's ink ceiling. */
  private marginCells = new Uint8Array(0)
  private light = false
  /** Cells an owl may be drawn in: the margins, below the header, clear of words. */
  private owlCells = new Uint8Array(0)
  /** Cells where an owl passing over the column or the scrubber's lane is drawn behind the words, on the landscape's canvas. */
  private behindCells = new Uint8Array(0)
  /** What the last painted frame drew behind the words over the column and the scrubber's lane: ripple cells and owl glyphs. */
  behind = { ripple: 0, owl: 0 }
  private noise = new Float32Array(0)
  private stars: Star[] = []
  private starAt = new Int32Array(0)
  /** The place the scene is set in, and what moves in it there. */
  private placeId: WatcherScene = 'night-wood'
  private ambience: Ambience | null = null
  /** The frame each cell last had an ambient glyph in, so no cell takes two and goes past the column's ceiling. */
  private ambientAt = new Uint32Array(0)
  private frameCount = 0
  private owlInk = new Float32Array(0)
  private owlAccent = new Float32Array(0)
  private cleared = new Uint8Array(0)
  private touched = new Uint8Array(0)
  private owlBox: CellBox | null = null
  private painted = ''
  private readonly glyphs = makeCanvas()
  private readonly owlCanvas = makeCanvas()
  private readonly owlAccentCanvas = makeCanvas()
  private readonly effect: RippleEffect = { ring: 0, dx: 0, dy: 0 }

  constructor(private readonly back: HTMLCanvasElement, private readonly front: HTMLCanvasElement) {}

  /** Lays the scene out for the room's size and builds its landscape; null when the room is too small to draw in. */
  resize(measure: SceneMeasure, dpr: number): SceneLayout | null {
    if (measure.width < 120 || measure.height < 120) { this.layout = null; return null }
    const layout = layoutScene(measure), grid = gridFor(measure.width, measure.height)
    const cells = grid.cols * grid.rows
    for (const canvas of [this.owlCanvas, this.owlAccentCanvas]) { canvas.width = grid.cols * SS; canvas.height = grid.rows * SS }
    if (!this.buildLand(layout, grid)) { this.layout = null; return null }
    this.owlInk = new Float32Array(cells); this.owlAccent = new Float32Array(cells)
    this.cleared = new Uint8Array(cells); this.touched = new Uint8Array(cells)
    const N = seeded(99)
    this.noise = new Float32Array(cells); for (let i = 0; i < cells; i++) this.noise[i] = N()
    this.quiet = new Float32Array(cells); this.owlCells = new Uint8Array(cells); this.behindCells = new Uint8Array(cells); this.marginCells = new Uint8Array(cells)
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
      const x = (c + 0.5) * grid.cw, y = (r + 0.5) * grid.ch, i = r * grid.cols + c
      // The scrubber's lane takes the column's ink ceiling, and no glow is drawn in it. An owl crossing the column or the
      // lane is drawn behind the words there, at the column's share and under its ceiling (the user's pick A on October
      // 25, 2026); in the margins it is drawn over everything, as before.
      const owl = owlLayer(layout, x, y)
      this.marginCells[i] = inMargin(layout, x) && !inLane(layout, x, y) ? 1 : 0
      this.owlCells[i] = owl === 'over' ? 1 : 0
      this.behindCells[i] = owl === 'behind' ? 1 : 0
    }
    this.layout = layout; this.grid = grid; this.dpr = dpr
    this.baseQuiet()
    this.owlBox = null
    this.painted = ''
    for (const canvas of [this.back, this.front, this.glyphs]) { canvas.width = Math.round(measure.width * dpr); canvas.height = Math.round(measure.height * dpr) }
    this.paintGlyphs()
    return layout
  }

  /**
   * The landscape's fields for the place, its stars and what moves in it; false when no field can be drawn. Only the
   * trees have a landscape: the rail of eyes is the same in every place.
   */
  private buildLand(layout: SceneLayout, grid: Grid): boolean {
    const cells = grid.cols * grid.rows, place = SCENE_PLACES[this.placeId]
    this.land = new Float32Array(cells); this.landAccent = new Float32Array(cells)
    this.ambience = null
    if (layout.mode === 'trees') {
      const field = makeCanvas(), accent = makeCanvas()
      for (const canvas of [field, accent]) { canvas.width = grid.cols * SS; canvas.height = grid.rows * SS }
      const fx = context(field, true), ax = context(accent, true)
      if (fx === null || ax === null) return false
      prepare(fx, grid, layout); prepare(ax, grid, layout)
      place.draw(fx, ax, layout)
      readField(fx, this.land, grid, 0, 0, grid.cols, grid.rows); readField(ax, this.landAccent, grid, 0, 0, grid.cols, grid.rows)
      this.ambience = place.ambience?.(layout) ?? null
    }
    this.stars = layout.mode === 'trees' ? placeStars(layout, grid, this.land, place.stars) : []
    this.starAt = new Int32Array(cells).fill(-1)
    this.stars.forEach((star, index) => { this.starAt[star.i] = index })
    this.ambientAt = new Uint32Array(cells)
    return true
  }

  /** The place the scene is set in. */
  get place(): WatcherScene { return this.placeId }

  /**
   * Sets the scene in another place: its landscape is drawn now, and the next frame shows it whole. The owls, the moon
   * and every spot stay where they are, since every place is laid out alike. Returns whether the place changed.
   */
  setPlace(place: WatcherScene): boolean {
    if (place === this.placeId) return false
    this.placeId = place
    const layout = this.layout
    if (layout === null) return true
    if (!this.buildLand(layout, this.grid)) { this.invalidate(); return true }
    this.painted = ''
    this.paintGlyphs()
    return true
  }

  /** The theme's inks and the glyph face; the landscape's glyphs are drawn again in them. */
  setInk(ink: SceneInk, fontFamily: string): void {
    this.ink = ink
    this.font = `${GLYPH_PX}px ${fontFamily}`
    this.painted = ''
    if (ink.light !== this.light) { this.light = ink.light; this.baseQuiet() }
    this.paintGlyphs()
  }

  /** Every cell's share, for the theme's column strength. */
  private baseQuiet(): void {
    const layout = this.layout
    if (layout === null) return
    const { cols, rows, cw, ch } = this.grid, strength = this.light ? COLUMN_QUIET.light : COLUMN_QUIET.dark
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) this.quiet[r * cols + c] = quietAt(layout, (c + 0.5) * cw, (r + 0.5) * ch, strength)
  }

  get ready(): boolean { return this.layout !== null && this.ink !== null }

  /**
   * Forgets the layout, so nothing is drawn until the room can be measured again. The canvases keep the last frame drawn:
   * the scene never blinks, and the next layout draws over it in the frame it is made.
   */
  invalidate(): void {
    this.layout = null
    this.owlBox = null
    this.painted = ''
  }

  /** The perched thread owls' boxes in the pane, for their buttons. */
  targets(owls: readonly ThreadOwlPose[], t: number, still: boolean): OwlTarget[] {
    const layout = this.layout
    if (layout === null) return []
    const { cw, ch } = this.grid, rail = layout.mode === 'rail'
    // A little larger than the glyphs, and held inside the pane, so an owl at the window's edge keeps its whole button.
    return owls.filter(pose => !pose.flying && pose.owl.animation === null).map(pose => {
      const box = spriteCells(owlGlyphs(pose, t, { rail, still }), pose.x, pose.y, { w: cw, h: ch })
      const x0 = Math.max(0, box.c0 * cw - 3), x1 = Math.min(layout.width, (box.c0 + box.w) * cw + 3)
      const y0 = Math.max(0, box.r0 * ch - 3), y1 = Math.min(layout.height, (box.r0 + box.n) * ch + 3)
      return { key: pose.owl.key, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    })
  }

  /**
   * The landscape's glyphs, kept: every cell dense enough to show, in its own ink, quiet in the column and around still words.
   * Given rows and columns, only that block is cleared and drawn again, clipped to it so its neighbours keep every pixel.
   */
  private paintGlyphs(r0 = 0, r1 = this.grid.rows, c0 = 0, c1 = this.grid.cols): void {
    const ctx = context(this.glyphs)
    if (ctx === null || this.layout === null || this.ink === null) return
    const { cols, rows, cw, ch } = this.grid, dpr = this.dpr
    const x0 = Math.round(c0 * cw * dpr), x1 = Math.round(c1 * cw * dpr), y0 = Math.round(r0 * ch * dpr), y1 = Math.round(r1 * ch * dpr)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip()
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.textStyle(ctx)
    // A glyph may reach a pixel past its cell, so the cells around the block are drawn too, clipped to it.
    for (let r = Math.max(0, r0 - 1); r < Math.min(rows, r1 + 1); r++) for (let c = Math.max(0, c0 - 1); c < Math.min(cols, c1 + 1); c++) {
      const i = r * cols + c
      this.cell(ctx, i, i, 0, -1, (c + 0.5) * cw, (r + 0.5) * ch)
    }
    ctx.restore()
  }

  private textStyle(ctx: CanvasRenderingContext2D): void {
    ctx.font = this.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  }

  /**
   * Draws cell `i` showing the landscape at cell `j` (where a ripple bends it), with a ripple's ring and a star's
   * strength. Returns whether it drew anything. This is the prototype's rule for a cell, whole.
   */
  private cell(ctx: CanvasRenderingContext2D, i: number, j: number, ring: number, star: number, x: number, y: number): boolean {
    const ink = this.ink!
    const q = this.quiet[i]!
    // Under still words nothing is drawn, not even a star or a ripple.
    if (q === 0) return false
    // In the column, where the conversation's words pass over it, no glyph is stronger than they allow.
    const cap = this.marginCells[i] ? 1 : ink.column.ink, accentCap = this.marginCells[i] ? 1 : ink.column.accent
    const tone = (accent: boolean, strength: number): string => accent ? inkAt(ink.accent, Math.min(accentCap, strength)) : inkAt(ink.ink, Math.min(cap, strength))
    const d = this.land[j]! * q
    ring = Math.min(1, ring) * (0.5 + 0.5 * q)
    if (d < 0.1 && ring < 0.08 && star <= 0) return false
    if (ring > d + 0.05) { ctx.fillStyle = tone(true, 0.18 + 0.6 * ring); ctx.fillText(RIPPLE_GLYPHS[Math.min(3, Math.floor(ring * 4))]!, x, y); return true }
    const st = this.starAt[i]! >= 0 ? this.stars[this.starAt[i]!]! : null
    const accent = this.landAccent[j]! > 0.3 || st?.accent === true
    if (star > d) { ctx.fillStyle = tone(accent, 0.15 + 0.6 * star); ctx.fillText(star > 0.7 ? '*' : star > 0.45 ? '+' : '·', x, y); return true }
    const dd = clamp(d + (this.noise[j]! - 0.5) * 0.1 + ring * 0.3, 0, 1)
    ctx.fillStyle = tone(accent, (0.1 + 0.5 * dd) * (accent ? 1.25 : 1)); ctx.fillText(rampGlyph(dd), x, y)
    return true
  }

  /** What the frame would show, summed up: the same summary means the same picture, so it is not painted again. */
  private summary(frame: SceneFrame, owlLines: readonly (readonly string[])[]): string {
    const { t, still } = frame, { cw, ch } = this.grid
    // Only the trees have stars, so only they change with the twinkle's step.
    const parts: Array<string | number> = [this.layout!.mode === 'trees' ? twinkleStep(t, still) : 0, ambienceStep(this.ambience, t, still)]
    if (frame.whirl > 0.01 || runningRipples(frame.ripples, t) > 0) parts.push('m', Math.round(t * 30))
    const w = frame.watcher?.pose
    if (w !== undefined) parts.push(Math.round(w.x), Math.round(w.y), Math.round(w.turn * 20), Math.round(w.gx * 4), Math.round(w.gy * 4), w.blink ? 1 : 0, Math.round(w.flap * 4), Math.round(w.spread * 10))
    frame.owls.forEach((pose, k) => {
      parts.push(pose.owl.key, Math.round(pose.x / cw), Math.round(pose.y / ch), Math.round(pose.alpha * 10), owlLines[k]![0]!, pose.owl.mood,
        pose.owl.mood === 'waiting' ? glowStep(t, still) : 0)
    })
    if (frame.pile !== null) parts.push('p', frame.pile.count)
    return parts.join('|')
  }

  /** Draws the frame, unless its picture is the one already on screen. Returns whether it painted. */
  draw(frame: SceneFrame): boolean {
    const layout = this.layout, ink = this.ink
    const back = context(this.back), front = context(this.front)
    if (layout === null || ink === null || back === null || front === null) return false
    const { t, still, ripples } = frame
    const rail = layout.mode === 'rail'
    const owlLines = frame.owls.map(pose => owlGlyphs(pose, t, { rail, still }))
    const summary = this.summary(frame, owlLines)
    if (summary === this.painted) return false
    this.painted = summary
    this.behind = { ripple: 0, owl: 0 }
    const { cols, rows, cw, ch } = this.grid
    if (frame.watcher !== null) this.readOwl(frame.watcher.pose)
    else this.owlBox = null
    const box = this.owlBox

    // The landscape as kept, with the cells under every owl cleared so it reads against nothing.
    back.setTransform(1, 0, 0, 1, 0, 0); back.clearRect(0, 0, this.back.width, this.back.height)
    back.drawImage(this.glyphs, 0, 0)
    back.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.textStyle(back)
    this.cleared.fill(0)
    const clear = (c: number, r: number): void => {
      if (c < 0 || c >= cols || r < 0 || r >= rows) return
      const i = r * cols + c
      if (this.cleared[i] || this.quiet[i] === 0) return
      this.cleared[i] = 1
      back.clearRect(c * cw, r * ch, cw, ch)
    }
    if (box !== null && frame.watcher !== null) {
      // A sitting owl keeps the row its feet stand on, so its branch still runs under it.
      const feet = frame.watcher.pose.spread < 0.05 ? Math.floor((frame.watcher.pose.y - 1) / ch) : rows
      for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) {
        if (this.owlInk[r * cols + c]! < 0.1 || !(this.owlCells[r * cols + c] || this.behindCells[r * cols + c])) continue
        for (let y = r - 1; y <= Math.min(r + 1, feet - 1); y++) for (let x = c - 1; x <= c + 1; x++) clear(x, y)
      }
    }
    const sprites = frame.owls.map((pose, k) => ({ pose, lines: owlLines[k]!, cells: spriteCells(owlLines[k]!, pose.x, pose.y, { w: cw, h: ch }) }))
    for (const { lines, cells } of sprites) for (let k = 0; k < lines.length; k++) for (let j = 0; j < lines[k]!.length; j++) {
      if (lines[k]![j] !== ' ') clear(cells.c0 + j, cells.r0 + k)
    }

    // The cells a ripple reaches, drawn again with the landscape bent and the ring over it.
    this.touched.fill(0)
    for (const ripple of ripples) {
      const reach = rippleReach(ripple, t, still)
      if (reach <= 0) continue
      const c0 = clamp(Math.floor((ripple.x - reach) / cw), 0, cols), c1 = clamp(Math.ceil((ripple.x + reach) / cw), 0, cols)
      const r0 = clamp(Math.floor((ripple.y - reach) / ch), 0, rows), r1 = clamp(Math.ceil((ripple.y + reach) / ch), 0, rows)
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
        const i = r * cols + c
        // A ripple runs on under the column and the scrubber's lane at their share and under their ink ceiling, as the
        // hills do (the user's pick A on October 25, 2026), so every word over it keeps 4.5:1.
        if (this.touched[i] || this.cleared[i] || this.quiet[i] === 0) continue
        const x = (c + 0.5) * cw, y = (r + 0.5) * ch
        const effect = rippleAt(x, y, ripples, t, still, this.effect)
        const sc = c - Math.round(effect.dx), sr = r - Math.round(effect.dy)
        if (effect.ring < 0.01 && sc === c && sr === r) continue
        this.touched[i] = 1
        const j = sc >= 0 && sc < cols && sr >= 0 && sr < rows ? sr * cols + sc : i
        const star = this.starAt[i]! >= 0 ? starStrength(this.stars[this.starAt[i]!]!, twinkleStep(t, still), still) * this.quiet[i]! : 0
        back.clearRect(c * cw, r * ch, cw, ch)
        if (this.cell(back, i, j, effect.ring, star, x, y) && !this.marginCells[i]) this.behind.ripple++
      }
    }

    // The stars, twinkling in half-second steps unless the scene holds still.
    const step = twinkleStep(t, still)
    for (const star of this.stars) {
      if (this.cleared[star.i] || this.touched[star.i]) continue
      const c = star.i % cols, r = (star.i - c) / cols
      this.cell(back, star.i, star.i, 0, starStrength(star, step, still) * this.quiet[star.i]!, (c + 0.5) * cw, (r + 0.5) * ch)
    }

    // What moves in the place: a few glyphs, held to each cell's share and the column's ceiling, never under still words,
    // a star, an owl or a ripple, and over the landscape's glyphs only where the place asks.
    if (this.ambience !== null) {
      const stamp = ++this.frameCount
      const emit: AmbientGlyph = (x, y, glyph, accent, strength, over) => {
        const c = Math.floor(x / cw), r = Math.floor(y / ch)
        if (c < 0 || c >= cols || r < 0 || r >= rows) return
        const i = r * cols + c, q = this.quiet[i]!
        if (q === 0 || this.cleared[i] || this.touched[i] || this.starAt[i]! >= 0 || this.ambientAt[i] === stamp) return
        if (!over && this.land[i]! * q >= 0.1) return
        this.ambientAt[i] = stamp
        const cap = this.marginCells[i] ? 1 : accent ? ink.column.accent : ink.column.ink
        if (over) back.clearRect(c * cw, r * ch, cw, ch)
        back.fillStyle = inkAt(accent ? ink.accent : ink.ink, Math.min(cap, strength * q)); back.fillText(glyph, (c + 0.5) * cw, (r + 0.5) * ch)
      }
      this.ambience.cells(ambienceTime(this.ambience, t, still), emit)
    }

    // The moon's whirlpool: three arms turning inward, in the accent, over a moon that gives way under them.
    if (frame.whirl > 0.01 && layout.mode === 'trees') {
      const w = frame.whirl, m = layout.moon, R = m.r * (0.9 + 0.9 * w)
      const c0 = clamp(Math.floor((m.x - R) / cw), 0, cols - 1), c1 = clamp(Math.ceil((m.x + R) / cw), 0, cols - 1)
      const r0 = clamp(Math.floor((m.y - R) / ch), 0, rows - 1), r1 = clamp(Math.ceil((m.y + R) / ch), 0, rows - 1)
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const i = r * cols + c
        const dx = (c + 0.5) * cw - m.x, dy = (r + 0.5) * ch - m.y, d = Math.hypot(dx, dy)
        if (d > R || this.quiet[i] === 0 || this.cleared[i] || !this.marginCells[i]) continue
        const v = 0.5 + 0.5 * Math.sin(3 * Math.atan2(dy, dx) + d * 0.22 - t * 7)
        const a = w * (1 - d / R * 0.7) * (0.4 + 0.6 * v)
        back.clearRect(c * cw, r * ch, cw, ch)
        if (a > 0.12) { back.fillStyle = inkAt(ink.accent, 0.25 + a); back.fillText(WHIRL_GLYPHS[Math.min(WHIRL_GLYPHS.length - 1, Math.floor(a * WHIRL_GLYPHS.length))]!, (c + 0.5) * cw, (r + 0.5) * ch) }
      }
    }

    // A thread owl waiting on you glows: it sits in a soft wash of the accent, cut to its own margin.
    for (const { pose, cells } of sprites) {
      if (pose.owl.mood !== 'waiting' || !this.owlCells[clamp(cells.r0, 0, rows - 1) * cols + clamp(cells.c0 + (cells.w >> 1), 0, cols - 1)]) continue
      const [x0, x1] = this.withinMargin(cells.c0 * cw - 5, (cells.c0 + cells.w) * cw + 5)
      const y = cells.r0 * ch - 4, h = cells.n * ch + 4
      for (let r = cells.r0 - 1; r <= cells.r0 + cells.n; r++) for (let c = cells.c0 - 1; c <= cells.c0 + cells.w; c++) clear(c, r)
      back.fillStyle = inkAt(ink.accent, (0.12 + 0.12 * glowStep(t, still)) * pose.alpha)
      back.beginPath(); back.roundRect(x0, y, x1 - x0, h, 7); back.fill()
    }
    // The "+N" pile reads as a small label in the last spot, not as more grass.
    let pileCells: ReturnType<typeof spriteCells> | null = null
    if (frame.pile !== null) {
      pileCells = spriteCells([pileLabel(frame.pile.count, rail)], frame.pile.spot.x, frame.pile.spot.y, { w: cw, h: ch })
      for (let c = pileCells.c0 - 1; c <= pileCells.c0 + pileCells.w; c++) clear(c, pileCells.r0)
      if (!rail) {
        const [x0, x1] = this.withinMargin(pileCells.c0 * cw - 3.5, (pileCells.c0 + pileCells.w) * cw + 3.5)
        back.strokeStyle = inkAt(ink.ink, 0.4); back.lineWidth = 1
        back.beginPath(); back.roundRect(x0, pileCells.r0 * ch - 1.5, x1 - x0, ch + 3, 5); back.stroke()
      }
    }

    // The owls, on their own canvas over everything in the margins: Watcher's in its own box, the thread owls as glyphs,
    // and the pile's label. Over the column and the scrubber's lane an owl is drawn behind the words instead, on the
    // landscape's canvas, at the column's share and under its ink ceiling, so every word over it keeps 4.5:1.
    front.setTransform(1, 0, 0, 1, 0, 0); front.clearRect(0, 0, this.front.width, this.front.height)
    front.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.textStyle(front)
    const glyph = (c: number, r: number, text: string, accent: boolean, strength: number): void => {
      if (c < 0 || c >= cols || r < 0 || r >= rows) return
      const i = r * cols + c
      if (this.owlCells[i]) { front.fillStyle = inkAt(accent ? ink.accent : ink.ink, strength); front.fillText(text, (c + 0.5) * cw, (r + 0.5) * ch); return }
      if (!this.behindCells[i]) return
      const cap = accent ? ink.column.accent : ink.column.ink
      back.clearRect(c * cw, r * ch, cw, ch)
      back.fillStyle = inkAt(accent ? ink.accent : ink.ink, Math.min(cap, strength * this.quiet[i]!)); back.fillText(text, (c + 0.5) * cw, (r + 0.5) * ch)
      this.behind.owl++
    }
    if (box !== null) {
      // The eyes are the cells the accent covers most. A smaller owl covers less of each cell, so the bar is the
      // prototype's 0.35 or, below it, most of the strongest eye cell; shut eyes leave no accent at all.
      let strongest = 0
      for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) strongest = Math.max(strongest, this.owlAccent[r * cols + c]!)
      const eyeBar = Math.max(0.08, Math.min(0.35, strongest * 0.7))
      for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) {
        const i = r * cols + c, d = this.owlInk[i]!
        if (d < 0.1) continue
        const eye = this.owlAccent[i]! > eyeBar
        glyph(c, r, eye ? '@' : rampGlyph(d + (this.noise[i]! - 0.5) * 0.08), eye, eye ? 1 : 0.5 + 0.5 * d)
      }
    }
    for (const { pose, lines, cells } of sprites) {
      const waiting = pose.owl.mood === 'waiting', base = pose.owl.mood === 'asleep' ? 0.5 : 0.85
      const strength = waiting ? (0.8 + 0.2 * glowStep(t, still)) * pose.alpha : 0
      for (let k = 0; k < lines.length; k++) for (let j = 0; j < lines[k]!.length; j++) {
        const g = lines[k]![j]!
        if (g === ' ') continue
        const eye = k === 0 && (g === 'o' || g === 'O')
        glyph(cells.c0 + j, cells.r0 + k, g, waiting, waiting ? strength : (eye ? base + 0.15 : base) * pose.alpha)
      }
    }
    if (frame.pile !== null && pileCells !== null) {
      const label = pileLabel(frame.pile.count, rail)
      for (let j = 0; j < label.length; j++) glyph(pileCells.c0 + j, pileCells.r0, label[j]!, false, 0.95)
    }
    return true
  }

  /** A span from `x0` to `x1` cut to the margin it starts in, so a glow or an outline never reaches the column. */
  private withinMargin(x0: number, x1: number): [number, number] {
    const { left, right } = this.layout!.column
    return x0 < left ? [Math.max(0, x0), Math.min(x1, left - OWL_GAP)] : [Math.max(x0, right + OWL_GAP), Math.min(x1, this.layout!.width)]
  }

  /** The owl's own field, drawn and read only around it. */
  private readOwl(pose: OwlPose): void {
    const ox = context(this.owlCanvas, true), oax = context(this.owlAccentCanvas, true)
    const layout = this.layout!, grid = this.grid
    const previous = this.owlBox
    if (previous !== null) for (let r = previous.r0; r < previous.r0 + previous.rn; r++) for (let c = previous.c0; c < previous.c0 + previous.cn; c++) {
      this.owlInk[r * grid.cols + c] = 0; this.owlAccent[r * grid.cols + c] = 0
    }
    const pad = 84 * pose.s
    const c0 = clamp(Math.floor((pose.x - pad) / grid.cw), 0, grid.cols), c1 = clamp(Math.ceil((pose.x + pad) / grid.cw), 0, grid.cols)
    const r0 = clamp(Math.floor((pose.y - 30 * pose.s - pad) / grid.ch), 0, grid.rows), r1 = clamp(Math.ceil((pose.y + 14 * pose.s) / grid.ch), 0, grid.rows)
    this.owlBox = { c0, r0, cn: c1 - c0, rn: r1 - r0 }
    if (ox === null || oax === null) return
    prepare(ox, grid, layout); prepare(oax, grid, layout)
    drawOwl(ox, oax, pose)
    readField(ox, this.owlInk, grid, c0, r0, c1 - c0, r1 - r0); readField(oax, this.owlAccent, grid, c0, r0, c1 - c0, r1 - r0)
  }
}
