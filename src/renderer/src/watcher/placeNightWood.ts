import { groundAt, limbY, seeded, smooth, type Box, type SceneLayout, type Tree } from './nightScene'
import type { SceneLayers, ScenePlace } from './scenePlace'
import { drawMoon, drawMoonInk, MASK, strokeLimb, type Field } from './sceneDraw'

/**
 * The night wood's layers, the farthest first (ADR-0199): the moon, the three hills, the river, the ground with its
 * grass, the bare tree, Watcher's tree and the composer's branches.
 */
export const WOOD_LAYERS = ['moon', 'far', 'mid', 'near', 'river', 'ground', 'bare', 'tree', 'branch'] as const
export type WoodLayer = typeof WOOD_LAYERS[number]

/** How strong each layer's ink is drawn in line art: the moon brightest, the far hills faintest (ADR-0199). */
export const WOOD_TONE: Readonly<Record<WoodLayer, number>> = { moon: 1.3, far: 0.5, mid: 0.64, near: 0.78, river: 0.9, ground: 0.92, bare: 0.9, tree: 1.08, branch: 1.08 }

/**
 * The night wood, Watcher's first place and the default (Zach's pick on October 21, 2026): far, middle and near hills
 * with a river catching the moon, pines on the far hills, grass along the ground, Watcher's broad tree on the left, a
 * bare one on the right and a branch out of each side of the composer. Hills and ground run the room's width; the
 * column's cells take its share when the glyphs are drawn.
 *
 * Drawn by density, `only` is null: every part is drawn on `fx`, and `ax` takes the accent, as light does. Drawn a layer
 * at a time for line art (ADR-0199), `only` names the layer, nothing of any other is drawn, `ax` is null, and two things
 * differ, since the ground then hides the hills' feet: a hill is stroked along its ridge only, not round its foot, and
 * the ground's edge is drawn as strong as the hills' feet and its own line were together. The random draws are made in
 * the same order either way, so every pine and blade of grass stands where it does.
 */
function drawWood(fx: Field, ax: Field | null, g: SceneLayout, only: WoodLayer | null): void {
  const W = g.width, H = g.height, sky = g.sky, edge = g.column.left - 14
  const R = seeded(7)
  const apart = only !== null, wants = (layer: WoodLayer): boolean => only === null || only === layer
  // Far, middle and near hills, open on the left and lower toward the right, each with its ridgeline.
  const hill = (base: number, amp: number, seed: number, alpha: number, fade: number, ridge: number): void => {
    const r = seeded(seed), ph = [r() * 6, r() * 6, r() * 6] as const
    const top = (x: number): number => {
      const k = x / W
      const lift = (1 - smooth(0.25, fade, k) * 0.75) * amp
      return base - lift * (0.55 + 0.25 * Math.sin(k * 7 + ph[0]) + 0.15 * Math.sin(k * 17 + ph[1]) + 0.05 * Math.sin(k * 41 + ph[2]))
    }
    fx.globalAlpha = alpha; fx.beginPath(); fx.moveTo(0, g.groundY + 2)
    for (let x = 0; x <= W; x += 6) fx.lineTo(x, top(x))
    fx.lineTo(W, g.groundY + 2); fx.closePath(); fx.fill()
    fx.globalAlpha = ridge; fx.lineWidth = 5
    if (!apart) { fx.stroke(); return }
    fx.beginPath(); fx.moveTo(0, top(0))
    for (let x = 6; x <= W; x += 6) fx.lineTo(x, top(x))
    fx.stroke()
  }
  if (wants('far')) hill(g.horizon, sky * 0.22, 11, 0.03, 0.6, 0.45)
  if (wants('mid')) hill(g.horizon + sky * 0.1, sky * 0.16, 23, 0.04, 0.5, 0.55)
  if (wants('near')) hill(g.groundY - sky * 0.04, sky * 0.12, 37, 0.05, 0.42, 0.65)

  // Furrows across the left margin's near fields.
  if (wants('near')) {
    fx.globalAlpha = 0.3; fx.lineWidth = 3.5
    for (let i = 0; i < 6; i++) {
      const y = g.groundY - sky * 0.05 + i * 11 - 30
      fx.beginPath(); fx.moveTo(0, y + 26); fx.quadraticCurveTo(edge * 0.45, y, edge * 0.9, y + 16); fx.stroke()
    }
  }

  // A river from the far hills to the front of the left margin, catching the moon. It is cut out of what it runs
  // through: everything drawn so far by density, each hill's own layer apart.
  const river = new Path2D()
  river.moveTo(edge * 0.8, g.horizon + 6)
  river.bezierCurveTo(edge * 0.55, g.horizon + sky * 0.14, edge * 0.7, g.groundY - sky * 0.03, edge * 0.35, g.groundY + 20)
  river.quadraticCurveTo(edge * 0.12, g.groundY + 45, -10, H)
  if (!apart || only === 'far' || only === 'mid' || only === 'near') {
    fx.globalCompositeOperation = 'destination-out'
    for (const [w, a] of [[5, 1], [12, 0.6]] as const) { fx.lineWidth = w; fx.globalAlpha = a; fx.stroke(river) }
    fx.globalCompositeOperation = 'source-over'
  }
  if (ax !== null) { ax.globalAlpha = 0.7; ax.lineWidth = 5; ax.stroke(river) }
  if (wants('river')) { fx.globalAlpha = 0.22; fx.lineWidth = 4; fx.stroke(river) }

  // Pines on the left margin's far hills. Their draws are made whichever layer is drawn, so the grass keeps its own.
  for (let i = 0; i < 9; i++) {
    const x = edge * (0.15 + R() * 0.8), y = g.horizon + sky * (0.03 + R() * 0.12), h = 10 + R() * 14
    if (!wants('far')) continue
    fx.globalAlpha = 0.4; fx.beginPath(); fx.moveTo(x, y - h); fx.lineTo(x + h * 0.35, y); fx.lineTo(x - h * 0.35, y); fx.fill()
  }

  // The ground, fading toward the bottom, with grass along its edge.
  if (wants('ground')) {
    const grad = fx.createLinearGradient(0, g.groundY, 0, H)
    grad.addColorStop(0, 'rgba(0, 0, 0, 0.07)'); grad.addColorStop(0.4, 'rgba(0, 0, 0, 0.03)'); grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
    fx.globalAlpha = 1; fx.fillStyle = grad
    fx.beginPath(); fx.moveTo(0, g.groundY)
    for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x))
    fx.lineTo(W, H); fx.lineTo(0, H); fx.closePath(); fx.fill()
    fx.fillStyle = MASK; fx.globalAlpha = apart ? 0.95 : 0.6; fx.lineWidth = apart ? 7 : 5
    fx.beginPath(); fx.moveTo(0, g.groundY); for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x)); fx.stroke()
    fx.lineWidth = 3; fx.globalAlpha = 0.45
    for (let x = 4; x < W; x += 5 + R() * 9) {
      const h = 4 + R() * 9, y = g.groundY + Math.sin(x * 0.013) * 3
      fx.beginPath(); fx.moveTo(x, y + 2); fx.lineTo(x + (R() - 0.5) * 5, y - h); fx.stroke()
    }
  }

  if (wants('moon')) { if (ax !== null) drawMoon(fx, ax, g.moon); else drawMoonInk(fx, g.moon) }

  // Watcher's broad tree on the left, the bare one on the right, and the composer's two branches.
  if (wants('tree')) drawTree(fx, g.left, 101, true, [...g.spots.filter(spot => spot.kind === 'tree'), g.home])
  if (wants('bare')) drawTree(fx, g.right, 202, false, [])
  if (!wants('branch')) return
  for (const b of [g.branches.left, g.branches.right]) {
    const d = Math.sign(b.x1 - b.x0), w = Math.max(5, 7 * g.s)
    fx.globalAlpha = 0.8; fx.lineCap = 'round'; fx.lineWidth = w; strokeLimb(fx, b)
    // A twig off its end and a few leaves, so it reads as a branch and not a shelf.
    fx.lineWidth = Math.max(2.5, w * 0.4)
    fx.beginPath(); fx.moveTo(b.x1 - d * 10, limbY(b, b.x1 - d * 10)); fx.lineTo(b.x1 + d * 6, b.y1 - 16 * g.s); fx.stroke()
    fx.globalAlpha = 0.18
    for (const [dx, dy, r] of [[6, -18, 9], [-2, -10, 7], [14, -8, 6]] as const) { fx.beginPath(); fx.arc(b.x1 + d * dx * g.s, b.y1 + dy * g.s, r * g.s, 0, 7); fx.fill() }
  }
}

/** A tree: its trunk, a crown of forking branches, the limbs owls sit on, and with `leaves`, leaves kept off `clear`. */
export function drawTree(fx: Field, t: Tree, seed: number, leaves: boolean, clear: readonly { readonly x: number; readonly y: number }[]): void {
  const r = seeded(seed), dir = t.dir
  const w0 = t.h * 0.05
  const topX = t.x - dir * t.h * 0.03, topY = t.y - t.h * 0.6
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
  branch(topX, topY, t.h * 0.17, -Math.PI / 2 - dir * 0.18, w0 * 0.8, 0, max)
  branch(topX, topY + t.h * 0.03, t.h * 0.13, -Math.PI / 2 + dir * 0.7, w0 * 0.55, 1, max)
  branch(topX, topY + t.h * 0.06, t.h * 0.14, -Math.PI / 2 - dir * 1.0, w0 * 0.55, 1, max)
  // The limbs owls sit on: long and nearly level, each with a twig near its tip.
  for (const l of t.limbs) {
    fx.globalAlpha = 0.75; fx.lineWidth = w0 * 0.42; strokeLimb(fx, l)
    const d = Math.sign(l.x1 - l.x0)
    fx.lineWidth = Math.max(1, w0 * 0.16)
    fx.beginPath(); fx.moveTo(l.x1 - d * 14, limbY(l, l.x1 - d * 14)); fx.lineTo(l.x1 - d * 2, limbY(l, l.x1) - 16); fx.stroke()
  }
  if (leaves) {
    // Leaves at the crown's tips, kept off the spots where owls sit.
    for (const [x, y, len] of tips) {
      if (clear.some(spot => Math.hypot(x - spot.x, y - spot.y) < 46) || r() < 0.45) continue
      for (let k = 0; k < 2; k++) { fx.globalAlpha = 0.1; fx.beginPath(); fx.arc(x + (r() - 0.5) * len, y + (r() - 0.5) * len * 0.7, len * (0.45 + r() * 0.4), 0, 7); fx.fill() }
    }
    fx.globalCompositeOperation = 'destination-out'; fx.globalAlpha = 0.3
    for (const [x, y, len] of tips) { fx.beginPath(); fx.arc(x + (r() - 0.5) * len, y + (r() - 0.5) * len, len * 0.18, 0, 7); fx.fill() }
    fx.globalCompositeOperation = 'source-over'
  }
}

/** A tree's part of the pane: its crown, which spreads a little over half its height either way, and its limbs' reach. */
function treeBounds(t: Tree, g: SceneLayout): Box {
  const reach = t.h * 0.66
  let x0 = t.x - reach, x1 = t.x + reach
  for (const l of t.limbs) { x0 = Math.min(x0, l.x0 - 8, l.x1 - 8); x1 = Math.max(x1, l.x0 + 8, l.x1 + 8) }
  const top = Math.max(0, t.y - t.h * 1.25)
  x0 = Math.max(0, x0); x1 = Math.min(g.width, x1)
  return { x: x0, y: top, w: Math.max(0, x1 - x0), h: t.y + 6 - top }
}

/** Where each of the wood's layers draws (`SceneLayers.bounds`). */
function woodBounds(layer: string, g: SceneLayout): Box {
  const W = g.width, H = g.height, hills = Math.max(0, g.horizon - g.sky * 0.25 - 30)
  if (layer === 'moon') return { x: g.moon.x - g.moon.r * 2.6, y: g.moon.y - g.moon.r * 2.6, w: g.moon.r * 5.2, h: g.moon.r * 5.2 }
  if (layer === 'far' || layer === 'mid') return { x: 0, y: hills, w: W, h: g.groundY + 8 - hills }
  if (layer === 'near') return { x: 0, y: hills, w: W, h: g.groundY + 62 - hills }
  if (layer === 'river') return { x: 0, y: g.horizon - 4, w: Math.max(0, g.column.left), h: H - g.horizon + 4 }
  if (layer === 'ground') return { x: 0, y: g.groundY - 26, w: W, h: 42 }
  if (layer === 'tree') return treeBounds(g.left, g)
  if (layer === 'bare') return treeBounds(g.right, g)
  // The composer's two branches, either side of the column, with their twigs and leaves.
  const top = g.branches.left.y0 - 48 * g.s - 12
  return { x: 0, y: top, w: W, h: g.branches.left.y0 + 12 - top }
}

const WOOD: SceneLayers = {
  order: WOOD_LAYERS,
  tone: WOOD_TONE,
  draw: (layer, fx, layout) => { if ((WOOD_LAYERS as readonly string[]).includes(layer)) drawWood(fx, null, layout, layer as WoodLayer) },
  bounds: woodBounds,
}

export const NIGHT_WOOD: ScenePlace = { draw: (fx, ax, layout) => drawWood(fx, ax, layout, null), stars: 1, ambience: null, layers: WOOD }
