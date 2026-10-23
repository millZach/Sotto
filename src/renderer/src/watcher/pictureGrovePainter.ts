import { clamp, gridFor, inkAt, limbY, rampGlyph, seeded, starStrength, twinkleStep, type Grid, type OwlPose, type SceneInk, type Star } from './nightScene'
import { context, drawMoon, drawOwl, GLYPH_PX, makeCanvas, prepare, readField, SS, strokeLimb } from './nightScenePainter'
import { glowStep, owlEyes, perchedGlyphs, spriteCells, type OwlMood } from './owlFamily'
import type { GroveLayout, GroveTree } from './pictureGrove'

/**
 * Draws Watcher's picture as the night scene draws the room's margins (`nightScenePainter.ts`), on two canvases: the
 * landscape, the trees and the moon on one, kept and redrawn only with the stars; the owls on the other. Shapes are
 * drawn as vectors on offscreen fields whose coverage becomes each cell's glyph. Nothing is drawn under a word: the
 * thread's labels, the projects' signs, the computers' names, Watcher's name and You.
 */

/** A thread's owl as the picture draws it this frame. */
export interface GroveOwlFrame {
  readonly key: string
  readonly x: number
  readonly y: number
  readonly mood: OwlMood
  /** Settled threads' owls are drawn fainter. */
  readonly settled: boolean
  /** Its place in the picture, so each blinks at its own moment. */
  readonly order: number
}

/** How long Watcher's own owl keeps its eyes shut, and how often it blinks. */
const WATCHER_BLINK = { every: 7.3, for: 0.16 } as const

/** The trunk, its crown and its limbs, one per row of a project's owls. */
function drawGroveTree(fx: CanvasRenderingContext2D, tree: GroveTree, seed: number): void {
  const r = seeded(seed), dir = tree.dir
  const top = tree.y - tree.h, w0 = clamp(tree.h * 0.035, 5, 11)
  fx.globalAlpha = 0.72
  fx.beginPath()
  fx.moveTo(tree.x - w0 * 2.4, tree.y); fx.quadraticCurveTo(tree.x - w0, tree.y - w0, tree.x - w0 * 0.85, tree.y - tree.h * 0.15)
  fx.lineTo(tree.x - w0 * 0.45, top); fx.lineTo(tree.x + w0 * 0.45, top)
  fx.lineTo(tree.x + w0 * 0.85, tree.y - tree.h * 0.15); fx.quadraticCurveTo(tree.x + w0, tree.y - w0, tree.x + w0 * 2.4, tree.y); fx.closePath(); fx.fill()
  fx.lineCap = 'round'
  // A small crown over the top limb, bare toward the picture and with a few leaves at its tips.
  const branch = (x: number, y: number, len: number, ang: number, w: number, depth: number): void => {
    const x1 = x + Math.cos(ang) * len, y1 = y + Math.sin(ang) * len
    fx.globalAlpha = 0.68; fx.lineWidth = Math.max(2.4, w)
    fx.beginPath(); fx.moveTo(x, y); fx.quadraticCurveTo((x + x1) / 2 + (r() - 0.5) * len * 0.3, (y + y1) / 2, x1, y1); fx.stroke()
    if (depth >= 3) {
      fx.globalAlpha = 0.09
      fx.beginPath(); fx.arc(x1 + (r() - 0.5) * len, y1 - r() * len * 0.4, len * (0.5 + r() * 0.4), 0, 7); fx.fill()
      return
    }
    for (let k = 0; k < 2; k++) branch(x1, y1, len * (0.66 + r() * 0.14), ang + (k - 0.5) * (0.6 + r() * 0.3), w * 0.62, depth + 1)
  }
  const crown = clamp(tree.h * 0.16, 18, 46)
  branch(tree.x, top, crown, -Math.PI / 2 + dir * 0.2, w0 * 0.75, 0)
  branch(tree.x, top + crown * 0.4, crown * 0.8, -Math.PI / 2 - dir * 0.9, w0 * 0.5, 1)
  for (const limb of tree.limbs) {
    fx.globalAlpha = 0.75; fx.lineWidth = Math.max(4, w0 * 0.6); strokeLimb(fx, limb)
    const d = Math.sign(limb.x1 - limb.x0)
    fx.lineWidth = 1.8
    fx.beginPath(); fx.moveTo(limb.x1 - d * 14, limbY(limb, limb.x1 - d * 14)); fx.lineTo(limb.x1 - d * 2, limbY(limb, limb.x1) - 14); fx.stroke()
  }
}

/** Hills across the picture, the ground with its grass, the trees, the moon and Watcher's post. */
function drawGrove(fx: CanvasRenderingContext2D, ax: CanvasRenderingContext2D, g: GroveLayout): void {
  const W = g.width, sky = g.ground - g.horizon
  const hill = (base: number, amp: number, seed: number, alpha: number, ridge: number): void => {
    const r = seeded(seed), ph = [r() * 6, r() * 6, r() * 6] as const
    fx.globalAlpha = alpha; fx.beginPath(); fx.moveTo(0, g.ground + 2)
    for (let x = 0; x <= W; x += 6) {
      const k = x / W
      fx.lineTo(x, base - amp * (0.55 + 0.25 * Math.sin(k * 7 + ph[0]) + 0.15 * Math.sin(k * 17 + ph[1]) + 0.05 * Math.sin(k * 41 + ph[2])))
    }
    fx.lineTo(W, g.ground + 2); fx.closePath(); fx.fill()
    fx.globalAlpha = ridge; fx.lineWidth = 5; fx.stroke()
  }
  hill(g.horizon + sky * 0.1, sky * 0.35, 11, 0.03, 0.4)
  hill(g.horizon + sky * 0.45, sky * 0.25, 23, 0.04, 0.5)
  hill(g.ground - sky * 0.06, sky * 0.14, 37, 0.05, 0.6)
  const R = seeded(7)
  const groundAt = (x: number): number => g.ground + Math.sin(x * 0.013) * 3 + Math.sin(x * 0.051) * 1.5
  const grad = fx.createLinearGradient(0, g.ground, 0, g.height)
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.07)'); grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
  fx.globalAlpha = 1; fx.fillStyle = grad
  fx.beginPath(); fx.moveTo(0, g.ground); for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(x)); fx.lineTo(W, g.height); fx.lineTo(0, g.height); fx.closePath(); fx.fill()
  fx.fillStyle = 'black'; fx.globalAlpha = 0.6; fx.lineWidth = 5
  fx.beginPath(); fx.moveTo(0, g.ground); for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(x)); fx.stroke()
  fx.lineWidth = 3; fx.globalAlpha = 0.45
  for (let x = 4; x < W; x += 5 + R() * 9) {
    const h = 4 + R() * 9, y = groundAt(x)
    fx.beginPath(); fx.moveTo(x, y + 2); fx.lineTo(x + (R() - 0.5) * 5, y - h); fx.stroke()
  }
  if (g.moon !== null) drawMoon(fx, ax, g.moon)
  g.trees.forEach((tree, index) => drawGroveTree(fx, tree, 101 + index * 101))
  if (g.perch !== null) {
    // Watcher's post: a bare stump from the ground, with a short crossbar its owl sits on.
    const { x, y, s } = g.perch
    fx.globalAlpha = 0.7; fx.lineCap = 'round'; fx.lineWidth = 8
    fx.beginPath(); fx.moveTo(x, g.ground); fx.lineTo(x + 2, y + 2); fx.stroke()
    fx.lineWidth = 5
    fx.beginPath(); fx.moveTo(x - 26 * s, y + 4); fx.quadraticCurveTo(x, y - 1, x + 28 * s, y + 3); fx.stroke()
  }
}

/**
 * What a frame shows, summed up: the same key means the same picture, so it is not painted again. Each owl's mood is in
 * it as well as its eyes, since an asleep owl and an awake one mid-blink share their eyes but not their brightness.
 */
export function groveFrameKey(step: number, shut: boolean, owls: readonly GroveOwlFrame[], lines: readonly (readonly string[])[], t: number, still: boolean): string {
  return [step, shut ? 1 : 0, ...owls.map((owl, k) => `${owl.key}:${Math.round(owl.x)}:${Math.round(owl.y)}:${lines[k]![0]}:${owl.mood}:${owl.settled ? 1 : 0}:${owl.mood === 'waiting' ? glowStep(t, still) : 0}`)].join('|')
}

interface CellBox { readonly c0: number; readonly r0: number; readonly cn: number; readonly rn: number }

export class GrovePainter {
  private layout: GroveLayout | null = null
  private grid: Grid = { cols: 0, rows: 0, cw: 7, ch: 12 }
  private dpr = 1
  private ink: SceneInk | null = null
  private font = ''
  private land = new Float32Array(0)
  private landAccent = new Float32Array(0)
  /** 1 where the scene may draw, 0 under words. */
  private open = new Uint8Array(0)
  private noise = new Float32Array(0)
  private stars: Star[] = []
  private starAt = new Int32Array(0)
  /** Watcher's owl's field, eyes open and shut, and the box it covers. */
  private owl: { readonly ink: readonly [Float32Array, Float32Array]; readonly accent: readonly [Float32Array, Float32Array]; readonly box: CellBox } | null = null
  private painted = ''
  private readonly glyphs = makeCanvas()

  constructor(private readonly back: HTMLCanvasElement, private readonly front: HTMLCanvasElement) {}

  get ready(): boolean { return this.layout !== null && this.ink !== null }

  /** Builds the landscape for a layout, and Watcher's owl's two fields. */
  resize(layout: GroveLayout, dpr: number): void {
    const grid = gridFor(layout.width, layout.height), cells = grid.cols * grid.rows
    const field = makeCanvas(), accent = makeCanvas()
    for (const canvas of [field, accent]) { canvas.width = grid.cols * SS; canvas.height = grid.rows * SS }
    const fx = context(field, true), ax = context(accent, true)
    this.layout = null
    if (fx === null || ax === null || cells === 0) return
    prepare(fx, grid, layout); prepare(ax, grid, layout)
    drawGrove(fx, ax, layout)
    this.land = new Float32Array(cells); this.landAccent = new Float32Array(cells)
    readField(fx, this.land, grid, 0, 0, grid.cols, grid.rows); readField(ax, this.landAccent, grid, 0, 0, grid.cols, grid.rows)
    const N = seeded(99)
    this.noise = new Float32Array(cells); for (let i = 0; i < cells; i++) this.noise[i] = N()
    // Every cell is open but those whose middle falls within a word's box and a little air: each box marks its own cells.
    this.open = new Uint8Array(cells).fill(1)
    const pad = 4
    for (const box of layout.words) {
      const c0 = Math.max(0, Math.ceil((box.x - pad) / grid.cw - 0.5)), c1 = Math.min(grid.cols - 1, Math.floor((box.x + box.w + pad) / grid.cw - 0.5))
      const r0 = Math.max(0, Math.ceil((box.y - pad) / grid.ch - 0.5)), r1 = Math.min(grid.rows - 1, Math.floor((box.y + box.h + pad) / grid.ch - 0.5))
      for (let r = r0; r <= r1 && c0 <= c1; r++) this.open.fill(0, r * grid.cols + c0, r * grid.cols + c1 + 1)
    }
    // Stars in the sky, where nothing else is drawn.
    const S = seeded(5), count = Math.round(layout.width * layout.horizon / 6500)
    this.stars = []
    for (let k = 0; k < count; k++) {
      const c = Math.floor(S() * grid.cols), r = Math.floor(S() * grid.rows), i = r * grid.cols + c, tier = S()
      const star = { i, base: tier > 0.93 ? 0.9 : tier > 0.7 ? 0.55 : 0.3, phase: S() * 6.28, speed: 0.5 + S() * 1.2, accent: S() > 0.86 }
      if (r * grid.ch < layout.horizon && this.open[i] && (this.land[i] ?? 1) < 0.05) this.stars.push(star)
    }
    this.starAt = new Int32Array(cells).fill(-1)
    this.stars.forEach((star, index) => { this.starAt[star.i] = index })
    this.owl = null
    if (layout.perch !== null) {
      const { x, y, s } = layout.perch, padOwl = 46 * s
      const c0 = clamp(Math.floor((x - padOwl) / grid.cw), 0, grid.cols), c1 = clamp(Math.ceil((x + padOwl) / grid.cw), 0, grid.cols)
      const r0 = clamp(Math.floor((y - 74 * s) / grid.ch), 0, grid.rows), r1 = clamp(Math.ceil((y + 4) / grid.ch), 0, grid.rows)
      const box = { c0, r0, cn: c1 - c0, rn: r1 - r0 }
      const fields = [false, true].map(blink => {
        const ink = new Float32Array(cells), eyes = new Float32Array(cells)
        prepare(fx, grid, layout); prepare(ax, grid, layout)
        const pose: OwlPose = { x, y, s, bank: 0, squash: 1, spread: 0, flap: 0, turn: 0, gx: 0, gy: 0, blink, legs: 0 }
        drawOwl(fx, ax, pose)
        readField(fx, ink, grid, c0, r0, box.cn, box.rn); readField(ax, eyes, grid, c0, r0, box.cn, box.rn)
        return [ink, eyes] as const
      })
      this.owl = { ink: [fields[0]![0], fields[1]![0]], accent: [fields[0]![1], fields[1]![1]], box }
    }
    this.layout = layout; this.grid = grid; this.dpr = dpr; this.painted = ''
    for (const canvas of [this.back, this.front, this.glyphs]) { canvas.width = Math.round(layout.width * dpr); canvas.height = Math.round(layout.height * dpr) }
    this.paintGlyphs()
  }

  /** The theme's inks and the glyph face; the landscape is drawn again in them. */
  setInk(ink: SceneInk, fontFamily: string): void {
    this.ink = ink
    this.font = `${GLYPH_PX}px ${fontFamily}`
    this.painted = ''
    this.paintGlyphs()
  }

  private textStyle(ctx: CanvasRenderingContext2D): void {
    ctx.font = this.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  }

  private paintGlyphs(): void {
    const ctx = context(this.glyphs)
    if (ctx === null || this.layout === null || this.ink === null) return
    const { cols, rows, cw, ch } = this.grid
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.glyphs.width, this.glyphs.height)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.textStyle(ctx)
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) this.cell(ctx, r * cols + c, -1, (c + 0.5) * cw, (r + 0.5) * ch)
  }

  /** Draws cell `i`: the landscape, or a star stronger than it. Returns whether it drew. */
  private cell(ctx: CanvasRenderingContext2D, i: number, star: number, x: number, y: number): boolean {
    if (!this.open[i]) return false
    const ink = this.ink!, d = this.land[i]!
    if (d < 0.1 && star <= 0) return false
    const accent = this.landAccent[i]! > 0.3 || (this.starAt[i]! >= 0 && this.stars[this.starAt[i]!]!.accent)
    if (star > d) { ctx.fillStyle = inkAt(accent ? ink.accent : ink.ink, 0.15 + 0.6 * star); ctx.fillText(star > 0.7 ? '*' : star > 0.45 ? '+' : '·', x, y); return true }
    const dd = clamp(d + (this.noise[i]! - 0.5) * 0.1, 0, 1)
    ctx.fillStyle = inkAt(accent ? ink.accent : ink.ink, (0.1 + 0.5 * dd) * (accent ? 1.25 : 1)); ctx.fillText(rampGlyph(dd), x, y)
    return true
  }

  /** Draws the frame, unless its picture is the one on screen. Returns whether it painted. */
  draw(t: number, still: boolean, owls: readonly GroveOwlFrame[]): boolean {
    const layout = this.layout, ink = this.ink, back = context(this.back), front = context(this.front)
    if (layout === null || ink === null || back === null || front === null) return false
    const { cols, rows, cw, ch } = this.grid
    const step = twinkleStep(t, still)
    const shut = !still && t % WATCHER_BLINK.every < WATCHER_BLINK.for
    const lines = owls.map(owl => perchedGlyphs(owlEyes(owl, t, !still)))
    const summary = groveFrameKey(step, shut, owls, lines, t, still)
    if (summary === this.painted) return false
    this.painted = summary

    back.setTransform(1, 0, 0, 1, 0, 0); back.clearRect(0, 0, this.back.width, this.back.height)
    back.drawImage(this.glyphs, 0, 0)
    back.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.textStyle(back)
    const cleared = new Set<number>()
    const clear = (c: number, r: number): void => {
      if (c < 0 || c >= cols || r < 0 || r >= rows) return
      const i = r * cols + c
      if (cleared.has(i) || !this.open[i]) return
      cleared.add(i); back.clearRect(c * cw, r * ch, cw, ch)
    }
    const owl = this.owl, which = shut ? 1 : 0
    if (owl !== null) {
      const { box } = owl, inkField = owl.ink[which]!
      for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) {
        if (inkField[r * cols + c]! < 0.1) continue
        for (let y = r - 1; y <= Math.min(r + 1, box.r0 + box.rn - 2); y++) for (let x = c - 1; x <= c + 1; x++) clear(x, y)
      }
    }
    const sprites = owls.map((frame, k) => ({ frame, lines: lines[k]!, cells: spriteCells(lines[k]!, frame.x, frame.y, { w: cw, h: ch }) }))
    for (const { lines: rowsOf, cells } of sprites) for (let k = 0; k < rowsOf.length; k++) for (let j = 0; j < rowsOf[k]!.length; j++) if (rowsOf[k]![j] !== ' ') clear(cells.c0 + j, cells.r0 + k)
    // The stars, twinkling in half-second steps unless the picture holds still.
    for (const star of this.stars) {
      if (cleared.has(star.i)) continue
      const c = star.i % cols, r = (star.i - c) / cols
      back.clearRect(c * cw, r * ch, cw, ch)
      this.cell(back, star.i, starStrength(star, step, still), (c + 0.5) * cw, (r + 0.5) * ch)
    }
    // A thread waiting on you glows in a soft wash of the accent.
    for (const { frame, cells } of sprites) {
      if (frame.mood !== 'waiting') continue
      for (let r = cells.r0 - 1; r <= cells.r0 + cells.n; r++) for (let c = cells.c0 - 1; c <= cells.c0 + cells.w; c++) clear(c, r)
      back.fillStyle = inkAt(ink.accent, 0.12 + 0.12 * glowStep(t, still))
      back.beginPath(); back.roundRect(cells.c0 * cw - 5, cells.r0 * ch - 4, cells.w * cw + 10, cells.n * ch + 4, 7); back.fill()
    }

    front.setTransform(1, 0, 0, 1, 0, 0); front.clearRect(0, 0, this.front.width, this.front.height)
    front.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.textStyle(front)
    const glyph = (c: number, r: number, text: string, color: string): void => {
      if (c < 0 || c >= cols || r < 0 || r >= rows || !this.open[r * cols + c]) return
      front.fillStyle = color; front.fillText(text, (c + 0.5) * cw, (r + 0.5) * ch)
    }
    if (owl !== null) {
      // Watcher's owl: its eyes are the cells the accent covers most, as in the night scene.
      const { box } = owl, inkField = owl.ink[which]!, eyes = owl.accent[which]!
      let strongest = 0
      for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) strongest = Math.max(strongest, eyes[r * cols + c]!)
      const eyeBar = Math.max(0.08, Math.min(0.35, strongest * 0.7))
      for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) {
        const i = r * cols + c, d = inkField[i]!
        if (d < 0.1) continue
        const eye = eyes[i]! > eyeBar
        glyph(c, r, eye ? '@' : rampGlyph(d + (this.noise[i]! - 0.5) * 0.08), eye ? inkAt(ink.accent, 1) : inkAt(ink.ink, 0.5 + 0.5 * d))
      }
    }
    for (const { frame, lines: rowsOf, cells } of sprites) {
      const waiting = frame.mood === 'waiting', base = (frame.mood === 'asleep' ? 0.5 : 0.85) * (frame.settled ? 0.6 : 1)
      const strength = 0.8 + 0.2 * glowStep(t, still)
      for (let k = 0; k < rowsOf.length; k++) for (let j = 0; j < rowsOf[k]!.length; j++) {
        const g = rowsOf[k]![j]!
        if (g === ' ') continue
        const eye = k === 0 && (g === 'o' || g === 'O')
        glyph(cells.c0 + j, cells.r0 + k, g, waiting ? inkAt(ink.accent, strength) : inkAt(ink.ink, eye ? base + 0.15 : base))
      }
    }
    return true
  }
}
