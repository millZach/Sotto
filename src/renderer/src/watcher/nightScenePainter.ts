import {
  buildRoute, clamp, gridFor, inkAt, layoutScene, lerp, owlAt, placeStars, quietAt, rampGlyph, RIPPLE_GLYPHS, rippleAt, rippleReach, seeded, smooth, starStrength,
  type Grid, type Look, type OwlPose, type OwlStage, type Ripple, type RippleEffect, type Route, type SceneInk, type SceneLayout, type SceneMeasure, type Star, type Tree,
} from './nightScene'

/**
 * Draws Watcher's night scene on two canvases: the landscape behind the room on one, the owl above the composer on the
 * other. Shapes are drawn first as vectors on small offscreen canvases, two field pixels to a glyph cell a side, whose
 * coverage becomes each cell's density; a cell is then drawn as the glyph for its density. The landscape's glyphs are
 * drawn once per size and theme and kept; a frame copies them, clears the cells around the owl, and redraws only the
 * stars and the cells a ripple reaches. The owl is redrawn in its own box alone.
 */

/** Field pixels per glyph cell, a side. */
const SS = 2
/** Only the offscreen fields' coverage is read, never their colour, so they are drawn in any opaque ink. */
const MASK = 'black'
/** The glyphs' size, which fills a 7 by 12 cell. */
const GLYPH_PX = 10.5

function context(canvas: HTMLCanvasElement | OffscreenCanvas, read = false): CanvasRenderingContext2D | null {
  return (canvas as HTMLCanvasElement).getContext('2d', read ? { willReadFrequently: true } : undefined) as CanvasRenderingContext2D | null
}

function makeCanvas(): HTMLCanvasElement {
  return document.createElement('canvas')
}

/** Averages a block of field pixels' coverage into each cell of `out`. */
function readField(ctx: CanvasRenderingContext2D, out: Float32Array, grid: Grid, c0: number, r0: number, cn: number, rn: number): void {
  if (cn <= 0 || rn <= 0) return
  const data = ctx.getImageData(c0 * SS, r0 * SS, cn * SS, rn * SS).data
  const stride = cn * SS
  for (let r = 0; r < rn; r++) for (let c = 0; c < cn; c++) {
    let sum = 0
    for (let y = 0; y < SS; y++) for (let x = 0; x < SS; x++) sum += data[((r * SS + y) * stride + c * SS + x) * 4 + 3]!
    out[(r0 + r) * grid.cols + c0 + c] = sum / (SS * SS * 255)
  }
}

function prepare(ctx: CanvasRenderingContext2D, grid: Grid, layout: SceneLayout): void {
  ctx.setTransform(SS / grid.cw, 0, 0, SS / grid.ch, 0, 0)
  ctx.clearRect(-layout.width, -layout.height, layout.width * 3, layout.height * 3)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = MASK
  ctx.strokeStyle = MASK
}

/** The landscape's two fields: the ink of the hills, river, pines, ground, moon and trees, and the accent's. */
function drawLandscape(fx: CanvasRenderingContext2D, ax: CanvasRenderingContext2D, g: SceneLayout): void {
  const W = g.width, H = g.height, sky = g.sky
  const R = seeded(7)
  // Far, middle and near hills, open on the left and lower toward the right, each with its ridgeline.
  const hill = (base: number, amp: number, seed: number, alpha: number, fade: number, ridge: number): void => {
    const r = seeded(seed), ph = [r() * 6, r() * 6, r() * 6] as const
    fx.globalAlpha = alpha; fx.beginPath(); fx.moveTo(0, g.groundY + 2)
    for (let x = 0; x <= W; x += 6) {
      const k = x / W
      const lift = (1 - smooth(0.25, fade, k) * 0.75) * amp
      fx.lineTo(x, base - lift * (0.55 + 0.25 * Math.sin(k * 7 + ph[0]) + 0.15 * Math.sin(k * 17 + ph[1]) + 0.05 * Math.sin(k * 41 + ph[2])))
    }
    fx.lineTo(W, g.groundY + 2); fx.closePath(); fx.fill()
    fx.globalAlpha = ridge; fx.lineWidth = 5; fx.stroke()
  }
  hill(g.horizon, sky * 0.22, 11, 0.03, 0.6, 0.45)
  hill(g.horizon + sky * 0.1, sky * 0.16, 23, 0.04, 0.5, 0.55)
  hill(g.groundY - sky * 0.04, sky * 0.12, 37, 0.05, 0.42, 0.65)

  // Furrows across the near fields on the left.
  fx.globalAlpha = 0.3; fx.lineWidth = 3.5
  for (let i = 0; i < 6; i++) {
    const y = g.groundY - sky * 0.05 + i * 11 - 30
    fx.beginPath(); fx.moveTo(0, y + 26); fx.quadraticCurveTo(W * 0.12, y, W * 0.26, y + 16); fx.stroke()
  }

  // A river from the far hills to the front left, catching the moon.
  const river = new Path2D()
  river.moveTo(W * 0.3, g.horizon + 6)
  river.bezierCurveTo(W * 0.22, g.horizon + sky * 0.14, W * 0.27, g.groundY - sky * 0.03, W * 0.12, g.groundY + 20)
  river.quadraticCurveTo(W * 0.04, g.groundY + 45, -10, H)
  fx.globalCompositeOperation = 'destination-out'
  for (const [w, a] of [[5, 1], [12, 0.6]] as const) { fx.lineWidth = w; fx.globalAlpha = a; fx.stroke(river) }
  fx.globalCompositeOperation = 'source-over'
  ax.globalAlpha = 0.7; ax.lineWidth = 5; ax.stroke(river)
  fx.globalAlpha = 0.22; fx.lineWidth = 4; fx.stroke(river)

  // Pines on the far hills.
  for (let i = 0; i < 14; i++) {
    const x = W * (0.1 + R() * 0.26), y = g.horizon + sky * (0.03 + R() * 0.12), h = 10 + R() * 14
    fx.globalAlpha = 0.4; fx.beginPath(); fx.moveTo(x, y - h); fx.lineTo(x + h * 0.35, y); fx.lineTo(x - h * 0.35, y); fx.fill()
  }

  // The ground, fading toward the bottom, with grass along its edge.
  const edge = (x: number): number => g.groundY + Math.sin(x * 0.013) * 3 + Math.sin(x * 0.051) * 1.5
  const grad = fx.createLinearGradient(0, g.groundY, 0, H)
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.07)'); grad.addColorStop(0.4, 'rgba(0, 0, 0, 0.03)'); grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
  fx.globalAlpha = 1; fx.fillStyle = grad
  fx.beginPath(); fx.moveTo(0, g.groundY)
  for (let x = 0; x <= W; x += 10) fx.lineTo(x, edge(x))
  fx.lineTo(W, H); fx.lineTo(0, H); fx.closePath(); fx.fill()
  fx.fillStyle = MASK; fx.globalAlpha = 0.6; fx.lineWidth = 5
  fx.beginPath(); fx.moveTo(0, g.groundY); for (let x = 0; x <= W; x += 10) fx.lineTo(x, edge(x)); fx.stroke()
  fx.lineWidth = 3; fx.globalAlpha = 0.45
  for (let x = 4; x < W; x += 5 + R() * 9) {
    const h = 4 + R() * 9, y = g.groundY + Math.sin(x * 0.013) * 3
    fx.beginPath(); fx.moveTo(x, y + 2); fx.lineTo(x + (R() - 0.5) * 5, y - h); fx.stroke()
  }

  // The moon with its rim and craters, and the accent's glow around it.
  const m = g.moon
  fx.globalAlpha = 0.05; for (let k = 2.4; k > 1.2; k -= 0.4) { fx.beginPath(); fx.arc(m.x, m.y, m.r * k, 0, 7); fx.fill() }
  fx.globalAlpha = 0.3; fx.beginPath(); fx.arc(m.x, m.y, m.r, 0, 7); fx.fill()
  fx.globalAlpha = 1; fx.lineWidth = 6; fx.beginPath(); fx.arc(m.x, m.y, m.r - 1.5, 0, 7); fx.stroke()
  fx.globalCompositeOperation = 'destination-out'; fx.globalAlpha = 0.35
  for (const [dx, dy, r] of [[-0.3, -0.25, 0.22], [0.25, 0.1, 0.16], [-0.05, 0.4, 0.12], [0.35, -0.38, 0.09]] as const) { fx.beginPath(); fx.arc(m.x + dx * m.r, m.y + dy * m.r, r * m.r, 0, 7); fx.fill() }
  fx.globalCompositeOperation = 'source-over'
  const glow = ax.createRadialGradient(m.x, m.y, m.r * 0.9, m.x, m.y, m.r * 2.8)
  glow.addColorStop(0, 'rgba(0, 0, 0, 0.55)'); glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ax.globalAlpha = 1; ax.fillStyle = glow; ax.beginPath(); ax.arc(m.x, m.y, m.r * 2.8, 0, 7); ax.fill(); ax.fillStyle = MASK
  ax.globalCompositeOperation = 'destination-out'; ax.beginPath(); ax.arc(m.x, m.y, m.r * 0.98, 0, 7); ax.fill(); ax.globalCompositeOperation = 'source-over'

  // The two trees: a broad one on the left with the owl's branch, a bare one on the right.
  drawTree(fx, g.left, 101, true, 1)
  drawTree(fx, g.right, 202, false, -1)
}

function drawTree(fx: CanvasRenderingContext2D, t: Tree, seed: number, leaves: boolean, dir: 1 | -1): void {
  const r = seeded(seed)
  const w0 = t.h * 0.05
  const topX = t.x - dir * t.h * 0.03, topY = t.y - t.h * 0.46
  fx.globalAlpha = 0.72
  fx.beginPath()
  fx.moveTo(t.x - w0 * 2.2, t.y); fx.quadraticCurveTo(t.x - w0 * 0.9, t.y - w0 * 0.6, t.x - w0 * 0.8, t.y - t.h * 0.12)
  fx.quadraticCurveTo(t.x - w0 * 0.7, topY + t.h * 0.15, topX - w0 * 0.4, topY)
  fx.lineTo(topX + w0 * 0.4, topY); fx.quadraticCurveTo(t.x + w0 * 0.7, topY + t.h * 0.15, t.x + w0 * 0.8, t.y - t.h * 0.12)
  fx.quadraticCurveTo(t.x + w0 * 0.9, t.y - w0 * 0.6, t.x + w0 * 2.2, t.y); fx.closePath(); fx.fill()
  fx.lineCap = 'round'
  const tips: Array<readonly [number, number, number]> = []
  const branch = (x: number, y: number, len: number, ang: number, w: number, depth: number, max: number): void => {
    const x1 = x + Math.cos(ang) * len, y1 = y + Math.sin(ang) * len
    const bend = (r() - 0.5) * len * 0.35
    fx.globalAlpha = 0.7; fx.lineWidth = Math.max(2.6, w)
    fx.beginPath(); fx.moveTo(x, y); fx.quadraticCurveTo((x + x1) / 2 - Math.sin(ang) * bend, (y + y1) / 2 + Math.cos(ang) * bend, x1, y1); fx.stroke()
    if (depth >= max) { tips.push([x1, y1, len]); return }
    const n = r() > 0.6 ? 3 : 2
    for (let k = 0; k < n; k++) branch(x1, y1, len * (0.68 + r() * 0.12), ang + (k - (n - 1) / 2) * (0.55 + r() * 0.25) + (r() - 0.5) * 0.2, w * 0.64, depth + 1, max)
  }
  const max = leaves ? 4 : 5
  branch(topX, topY, t.h * 0.2, -Math.PI / 2 - dir * 0.22, w0 * 0.8, 0, max)
  branch(topX, topY + t.h * 0.03, t.h * 0.15, -Math.PI / 2 + dir * 0.6, w0 * 0.55, 1, max)
  branch(topX, topY + t.h * 0.07, t.h * 0.17, -Math.PI / 2 - dir * 1.0, w0 * 0.55, 1, max)
  // The perch: a long, nearly level branch reaching toward the room.
  const p = t.perch
  const from = { x: t.x, y: p.y + t.h * 0.06 }
  fx.globalAlpha = 0.75; fx.lineWidth = w0 * 0.45
  fx.beginPath(); fx.moveTo(from.x, from.y); fx.quadraticCurveTo((from.x + p.x) / 2, p.y + 6, p.x + dir * 34, p.y - 4); fx.stroke()
  fx.lineWidth = Math.max(1, w0 * 0.18)
  fx.beginPath(); fx.moveTo(p.x + dir * 20, p.y); fx.lineTo(p.x + dir * 34, p.y - 22); fx.stroke()
  if (leaves) {
    for (const [x, y, len] of tips) {
      if (Math.hypot(x - p.x, y - p.y) < t.h * 0.3 || r() < 0.45) continue
      for (let k = 0; k < 2; k++) { fx.globalAlpha = 0.1; fx.beginPath(); fx.arc(x + (r() - 0.5) * len, y + (r() - 0.5) * len * 0.7, len * (0.45 + r() * 0.4), 0, 7); fx.fill() }
    }
    fx.globalCompositeOperation = 'destination-out'; fx.globalAlpha = 0.3
    for (const [x, y, len] of tips) { fx.beginPath(); fx.arc(x + (r() - 0.5) * len, y + (r() - 0.5) * len, len * 0.18, 0, 7); fx.fill() }
    fx.globalCompositeOperation = 'source-over'
  }
}

// ---------- The owl ----------

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0): void {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fill()
}
function poly(ctx: CanvasRenderingContext2D, pts: ReadonlyArray<readonly [number, number]>): void {
  ctx.beginPath(); ctx.moveTo(pts[0]![0], pts[0]![1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.closePath(); ctx.fill()
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
function drawOwl(d: CanvasRenderingContext2D, a: CanvasRenderingContext2D, o: OwlPose): void {
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

/** What a frame drew: where the owl is in its flight. */
export interface FrameResult { readonly stage: OwlStage }

export class NightScenePainter {
  private layout: SceneLayout | null = null
  private route: Route | null = null
  private grid: Grid = { cols: 0, rows: 0, cw: 7, ch: 12 }
  private dpr = 1
  private ink: SceneInk | null = null
  private font = ''
  private land = new Float32Array(0)
  private landAccent = new Float32Array(0)
  private quiet = new Float32Array(0)
  private noise = new Float32Array(0)
  private stars: Star[] = []
  private starAt = new Int32Array(0)
  private owlInk = new Float32Array(0)
  private owlAccent = new Float32Array(0)
  private halo = new Uint8Array(0)
  private touched = new Uint8Array(0)
  private owlBox: CellBox | null = null
  private readonly glyphs = makeCanvas()
  private readonly owlCanvas = makeCanvas()
  private readonly owlAccentCanvas = makeCanvas()
  private readonly effect: RippleEffect = { ring: 0, dx: 0, dy: 0 }

  constructor(private readonly back: HTMLCanvasElement, private readonly front: HTMLCanvasElement) {}

  /** Lays the scene out for the room's size and builds its landscape; false when the room is too small to draw in. */
  resize(measure: SceneMeasure, dpr: number): boolean {
    if (measure.width < 120 || measure.height < 120) { this.layout = null; return false }
    const layout = layoutScene(measure), grid = gridFor(measure.width, measure.height)
    const field = makeCanvas(), accent = makeCanvas()
    for (const canvas of [field, accent, this.owlCanvas, this.owlAccentCanvas]) { canvas.width = grid.cols * SS; canvas.height = grid.rows * SS }
    const fx = context(field, true), ax = context(accent, true)
    if (fx === null || ax === null) { this.layout = null; return false }
    prepare(fx, grid, layout); prepare(ax, grid, layout)
    drawLandscape(fx, ax, layout)
    const cells = grid.cols * grid.rows
    this.land = new Float32Array(cells); this.landAccent = new Float32Array(cells)
    readField(fx, this.land, grid, 0, 0, grid.cols, grid.rows); readField(ax, this.landAccent, grid, 0, 0, grid.cols, grid.rows)
    this.owlInk = new Float32Array(cells); this.owlAccent = new Float32Array(cells)
    this.halo = new Uint8Array(cells); this.touched = new Uint8Array(cells)
    const N = seeded(99)
    this.noise = new Float32Array(cells); for (let i = 0; i < cells; i++) this.noise[i] = N()
    this.quiet = new Float32Array(cells)
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) this.quiet[r * grid.cols + c] = quietAt(layout, (c + 0.5) * grid.cw, (r + 0.5) * grid.ch)
    this.stars = placeStars(layout, grid, this.land)
    this.starAt = new Int32Array(cells).fill(-1)
    this.stars.forEach((star, index) => { this.starAt[star.i] = index })
    this.layout = layout; this.grid = grid; this.dpr = dpr
    this.route = buildRoute(layout)
    this.owlBox = null
    for (const canvas of [this.back, this.front, this.glyphs]) { canvas.width = Math.round(measure.width * dpr); canvas.height = Math.round(measure.height * dpr) }
    this.paintGlyphs()
    return true
  }

  /** The theme's inks and the glyph face; the landscape's glyphs are drawn again in them. */
  setInk(ink: SceneInk, fontFamily: string): void {
    this.ink = ink
    this.font = `${GLYPH_PX}px ${fontFamily}`
    this.paintGlyphs()
  }

  get ready(): boolean { return this.layout !== null && this.ink !== null }

  /** The landscape's glyphs, kept: every cell dense enough to show, in its own ink, quiet where words sit over it. */
  private paintGlyphs(): void {
    const ctx = context(this.glyphs)
    if (ctx === null || this.layout === null || this.ink === null) return
    const { cols, rows, cw, ch } = this.grid
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.glyphs.width, this.glyphs.height)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.textStyle(ctx)
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      this.cell(ctx, i, i, 0, -1, (c + 0.5) * cw, (r + 0.5) * ch)
    }
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
    // Under words nothing is drawn, not even a star or a ripple.
    if (q === 0) return false
    const d = this.land[j]! * q
    ring = Math.min(1, ring) * (0.5 + 0.5 * q)
    if (d < 0.1 && ring < 0.08 && star <= 0) return false
    if (ring > d + 0.05) { ctx.fillStyle = inkAt(ink.accent, 0.18 + 0.6 * ring); ctx.fillText(RIPPLE_GLYPHS[Math.min(3, Math.floor(ring * 4))]!, x, y); return true }
    const st = this.starAt[i]! >= 0 ? this.stars[this.starAt[i]!]! : null
    const accent = this.landAccent[j]! > 0.3 || st?.accent === true
    if (star > d) { ctx.fillStyle = inkAt(accent ? ink.accent : ink.ink, 0.15 + 0.6 * star); ctx.fillText(star > 0.7 ? '*' : star > 0.45 ? '+' : '·', x, y); return true }
    const dd = clamp(d + (this.noise[j]! - 0.5) * 0.1 + ring * 0.3, 0, 1)
    ctx.fillStyle = inkAt(accent ? ink.accent : ink.ink, (0.1 + 0.5 * dd) * (accent ? 1.25 : 1)); ctx.fillText(rampGlyph(dd), x, y)
    return true
  }

  /** Draws the scene at `t` and says where the owl is. */
  draw(t: number, ripples: readonly Ripple[], look: Look | null, still: boolean): FrameResult {
    const layout = this.layout, route = this.route, ink = this.ink
    const { pose, stage } = layout !== null && route !== null ? owlAt(t, layout, route, { still, look }) : { pose: null, stage: 'perched' as const }
    const back = context(this.back), front = context(this.front)
    if (layout === null || pose === null || ink === null || back === null || front === null) return { stage }
    const { cols, rows, cw, ch } = this.grid
    const previous = this.owlBox
    this.readOwl(pose)
    const box = this.owlBox!

    // The landscape as kept, with the cells around the owl cleared so it reads against nothing.
    back.setTransform(1, 0, 0, 1, 0, 0); back.clearRect(0, 0, this.back.width, this.back.height)
    back.drawImage(this.glyphs, 0, 0)
    back.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.textStyle(back)
    this.halo.fill(0)
    for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) {
      if (this.owlInk[r * cols + c]! < 0.1) continue
      for (let y = Math.max(0, r - 1); y <= Math.min(rows - 1, r + 1); y++) for (let x = Math.max(0, c - 1); x <= Math.min(cols - 1, c + 1); x++) {
        const i = y * cols + x
        if (this.halo[i]) continue
        this.halo[i] = 1
        back.clearRect(x * cw, y * ch, cw, ch)
      }
    }

    // The cells a ripple reaches, drawn again with the landscape bent and the ring over it.
    this.touched.fill(0)
    for (const ripple of ripples) {
      const reach = rippleReach(ripple, t, still)
      const c0 = clamp(Math.floor((ripple.x - reach) / cw), 0, cols), c1 = clamp(Math.ceil((ripple.x + reach) / cw), 0, cols)
      const r0 = clamp(Math.floor((ripple.y - reach) / ch), 0, rows), r1 = clamp(Math.ceil((ripple.y + reach) / ch), 0, rows)
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
        const i = r * cols + c
        if (this.touched[i] || this.halo[i]) continue
        const x = (c + 0.5) * cw, y = (r + 0.5) * ch
        const effect = rippleAt(x, y, ripples, t, still, this.effect)
        const sc = c - Math.round(effect.dx), sr = r - Math.round(effect.dy)
        if (effect.ring < 0.01 && sc === c && sr === r) continue
        this.touched[i] = 1
        const j = sc >= 0 && sc < cols && sr >= 0 && sr < rows ? sr * cols + sc : i
        const star = this.starAt[i]! >= 0 ? starStrength(this.stars[this.starAt[i]!]!, t, still) * this.quiet[i]! : 0
        back.clearRect(c * cw, r * ch, cw, ch)
        this.cell(back, i, j, effect.ring, star, x, y)
      }
    }

    // The stars, twinkling unless the scene holds still.
    for (const star of this.stars) {
      if (this.halo[star.i] || this.touched[star.i]) continue
      const c = star.i % cols, r = (star.i - c) / cols
      this.cell(back, star.i, star.i, 0, starStrength(star, t, still) * this.quiet[star.i]!, (c + 0.5) * cw, (r + 0.5) * ch)
    }

    // The owl, above the composer: its old box cleared, its new one drawn.
    front.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.textStyle(front)
    for (const area of previous === null ? [] : [previous]) front.clearRect(area.c0 * cw, area.r0 * ch, area.cn * cw, area.rn * ch)
    front.clearRect(box.c0 * cw, box.r0 * ch, box.cn * cw, box.rn * ch)
    // The eyes are the cells the accent covers most. A smaller owl covers less of each cell, so the bar is the
    // prototype's 0.35 or, below it, most of the strongest eye cell; shut eyes leave no accent at all.
    let strongest = 0
    for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) strongest = Math.max(strongest, this.owlAccent[r * cols + c]!)
    const eyeBar = Math.max(0.08, Math.min(0.35, strongest * 0.7))
    for (let r = box.r0; r < box.r0 + box.rn; r++) for (let c = box.c0; c < box.c0 + box.cn; c++) {
      const i = r * cols + c, d = this.owlInk[i]!
      if (d < 0.1) continue
      const eye = this.owlAccent[i]! > eyeBar
      front.fillStyle = eye ? inkAt(ink.accent, 1) : inkAt(ink.ink, 0.5 + 0.5 * d)
      front.fillText(eye ? '@' : rampGlyph(d + (this.noise[i]! - 0.5) * 0.08), (c + 0.5) * cw, (r + 0.5) * ch)
    }
    return { stage }
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
