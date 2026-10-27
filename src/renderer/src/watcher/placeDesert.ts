import { clamp, groundAt, lerp, seeded, type Limb, type SceneLayout, type Tree } from './nightScene'
import { wrap, type Ambience, type ScenePlace } from './scenePlace'
import { alongLimb, cutOut, drawMoon, ellipse, MASK, poly, strokePts, type Field } from './sceneDraw'

/**
 * Desert (ADR-0148): mesas on the horizon, dunes with smooth backs and sharp crests, sand where the night wood has its
 * ground, two tall saguaros where its trees stand, their arms where its limbs are and turning up at the ends, and a
 * small arm out of each side of the composer. The moon is drawn larger, about the same centre, its glow the accent.
 * Sand drifts low over the dunes.
 */

/** How much larger than the night wood's the desert's moon is drawn. */
export const DESERT_MOON = 1.6

const frac = (x: number): number => x - Math.floor(x)

function drawDesert(fx: Field, ax: Field, g: SceneLayout): void {
  const W = g.width, H = g.height, sky = g.sky, R = seeded(83), edge = g.column.left - 14

  drawMoon(fx, ax, g.moon, DESERT_MOON)

  // Mesas on the horizon, flat-topped, cut out of the sky behind them.
  const mesa = (x0: number, x1: number, h: number): void => {
    const y = g.horizon + sky * 0.04, pts: Array<readonly [number, number]> = [[x0, y], [x0 + (x1 - x0) * 0.14, y - h], [x1 - (x1 - x0) * 0.16, y - h], [x1, y]]
    for (const field of [fx, ax]) cutOut(field, () => { field.globalAlpha = 1; poly(field, pts) })
    fx.globalAlpha = 0.09; poly(fx, pts); fx.globalAlpha = 0.58; fx.lineWidth = 4; strokePts(fx, pts)
  }
  mesa(edge * 0.05, edge * 0.6, sky * 0.1)
  mesa(W * 0.44, W * 0.56, sky * 0.05)
  mesa(g.column.right + (W - g.column.right) * 0.55, W + 30, sky * 0.07)

  // Dunes, far to near: smooth windward backs and sharp crests.
  const dune = (base: number, amp: number, period: number, ph: number, alpha: number, ridge: number): void => {
    const pts: Array<readonly [number, number]> = []
    for (let x = 0; x <= W + 8; x += 8) { const u = frac(x / period + ph); pts.push([x, base - amp * (u < 0.7 ? Math.sin(u / 0.7 * Math.PI / 2) : Math.cos((u - 0.7) / 0.3 * Math.PI / 2))]) }
    fx.globalAlpha = alpha; poly(fx, [...pts, [W + 8, g.groundY + 2], [0, g.groundY + 2]])
    fx.globalAlpha = ridge; fx.lineWidth = 4.5; strokePts(fx, pts)
  }
  dune(g.horizon + sky * 0.12, sky * 0.07, Math.max(120, W * 0.3), 0.2, 0.03, 0.42)
  dune(g.groundY - sky * 0.08, sky * 0.08, Math.max(140, W * 0.42), 0.55, 0.04, 0.55)

  // Small far saguaros on the left margin's dunes.
  for (let i = 0; i < 6; i++) {
    const x = edge * (0.1 + R() * 0.85), y = g.horizon + sky * (0.13 + R() * 0.06), h = 9 + R() * 12
    fx.globalAlpha = 0.5; fx.lineWidth = 2.5; strokePts(fx, [[x, y], [x, y - h]])
    fx.lineWidth = 2; strokePts(fx, [[x, y - h * 0.45], [x - h * 0.3, y - h * 0.45], [x - h * 0.3, y - h * 0.75]])
    if (R() > 0.4) strokePts(fx, [[x, y - h * 0.6], [x + h * 0.28, y - h * 0.6], [x + h * 0.28, y - h * 0.85]])
  }

  // The sand where the night wood's ground is, wind ripples under it, and a few stones.
  const ground: Array<readonly [number, number]> = []
  for (let x = 0; x <= W; x += 8) ground.push([x, groundAt(g, x)])
  const grad = fx.createLinearGradient(0, g.groundY, 0, H)
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.08)'); grad.addColorStop(1, 'rgba(0, 0, 0, 0.02)')
  fx.globalAlpha = 1; fx.fillStyle = grad; poly(fx, [...ground, [W, H], [0, H]]); fx.fillStyle = MASK
  fx.globalAlpha = 0.6; fx.lineWidth = 5; strokePts(fx, ground)
  fx.globalAlpha = 0.24; fx.lineWidth = 2
  for (let y = g.groundY + 12; y < H; y += 9) {
    for (let x = -R() * 30; x < W; ) { const len = 20 + R() * 50; strokePts(fx, [[x, y + Math.sin(x * 0.05) * 2], [x + len * 0.5, y - 2], [x + len, y + Math.sin((x + len) * 0.05) * 2]]); x += len + 10 + R() * 30 }
  }
  for (let i = 0; i < 7; i++) { const x = R() * W, y = groundAt(g, x) + 6 + R() * 10; fx.globalAlpha = 0.45; ellipse(fx, x, y, 3 + R() * 4, 2 + R() * 2) }

  saguaro(fx, g.left, g.s)
  saguaro(fx, g.right, g.s)
  for (const b of [g.branches.left, g.branches.right]) arm(fx, b, Math.max(5, 7 * g.s), 14 * g.s + 6)
}

/** A saguaro where a night wood tree stands: a ribbed column with rounded ends, and its limbs as arms. */
function saguaro(fx: Field, t: Tree, s: number): void {
  const w = clamp(t.h * 0.06, 8, 26), top = t.y - t.h * 0.88
  fx.globalAlpha = 0.66; fx.lineCap = 'round'; fx.lineWidth = w; strokePts(fx, [[t.x, t.y], [t.x, top + w / 2]]); fx.lineCap = 'butt'
  cutOut(fx, () => {
    fx.globalAlpha = 0.35; fx.lineWidth = 1.4
    for (const k of [-0.22, 0.18]) strokePts(fx, [[t.x + w * k, t.y], [t.x + w * k, top + w]])
  })
  for (const l of t.limbs) arm(fx, l, w * 0.62, clamp(t.h * 0.14, 16, 80) * Math.min(1, s))
}

/** An arm along a limb, its top where an owl's feet go, turning up at its end, with spines along it. */
function arm(fx: Field, l: Limb, w: number, rise: number): void {
  const drop = w * 0.4, pts = alongLimb(l).map(([x, y]) => [x, y + drop] as const)
  const end = pts[pts.length - 1]!
  fx.globalAlpha = 0.68; fx.lineCap = 'round'; fx.lineJoin = 'round'; fx.lineWidth = w
  strokePts(fx, [...pts, [end[0], end[1] - rise]])
  fx.lineCap = 'butt'; fx.lineJoin = 'miter'
  cutOut(fx, () => { fx.globalAlpha = 0.3; fx.lineWidth = 1.2; strokePts(fx, pts.map(([x, y]) => [x, y + w * 0.15] as const)) })
  fx.globalAlpha = 0.4; fx.lineWidth = 1.2
  for (let k = 2; k < pts.length - 1; k += 3) { const [x, y] = pts[k]!; strokePts(fx, [[x, y + w / 2], [x + 1, y + w / 2 + 4]]) }
}

/** How many grains drift at once: a fixed number, whatever the room's size, history or threads. */
const GRAINS = 44

function sandAmbience(g: SceneLayout): Ambience {
  const R = seeded(29), low = g.horizon + g.sky * 0.15
  const grains = Array.from({ length: GRAINS }, () => ({ x0: R() * g.width, y0: lerp(low, g.height - 4, R() ** 0.7), v: 40 + R() * 70, ph: R() }))
  return {
    steps: 8,
    most: GRAINS,
    cells(t, emit) {
      for (const p of grains) {
        const a = Math.sin(Math.PI * frac(t * 0.33 + p.ph))
        if (a < 0.2) continue
        emit(wrap(p.x0 + p.v * t, g.width + 20) - 10, p.y0 + Math.sin(t * 2 + p.ph * 6) * 3, a > 0.7 ? '·' : '.', false, 0.22 + 0.32 * a, false)
      }
    },
  }
}

export const DESERT: ScenePlace = { draw: drawDesert, stars: 1.35, ambience: sandAmbience }
