import { clamp, groundAt, lerp, limbY, seeded, smooth, type Limb, type Point, type SceneLayout, type Tree } from './nightScene'
import { wrap, type Ambience, type ScenePlace } from './scenePlace'
import { cutOut, drawMoon, ellipse, MASK, poly, strokeLimb, strokePts, type Field } from './sceneDraw'

/**
 * Snowfield (ADR-0148): snow-capped mountains far off, a snowfield where the night wood has its ground, and two
 * snow-laden pines where its trees stand, each with long boughs where the limbs are, and a bough out of each side of
 * the composer. The northern lights hang in the sky in the accent, with the moon's glow. Snow falls.
 */

function drawSnowfield(fx: Field, ax: Field, g: SceneLayout): void {
  const W = g.width, H = g.height, sky = g.sky, R = seeded(41), edge = g.column.left - 14

  drawAurora(fx, ax, g)

  // Far mountains, their peaks heavier where the snow lies.
  const peaks: Array<readonly [number, number]> = []
  for (let x = -40; x < W + 80; x += 60 + R() * 90) peaks.push([x, g.horizon - sky * (0.06 + R() * 0.16)])
  const outline: Array<readonly [number, number]> = []
  for (let k = 0; k < peaks.length - 1; k++) { const a = peaks[k]!, b = peaks[k + 1]!; outline.push(a, [(a[0] + b[0]) / 2, g.horizon + sky * 0.02 - R() * sky * 0.05]) }
  fx.globalAlpha = 0.04; poly(fx, [[-40, g.groundY], ...outline, [W + 80, g.groundY]])
  fx.globalAlpha = 0.48; fx.lineWidth = 4; strokePts(fx, outline)
  for (const [x, y] of peaks) { const h = (g.horizon - y) * 0.38; fx.globalAlpha = 0.2; poly(fx, [[x, y], [x + h * 0.9, y + h], [x + h * 0.3, y + h * 0.75], [x - h * 0.2, y + h * 1.05], [x - h * 0.9, y + h]]) }

  // A rolling snowfield between the mountains and the ground, with small pines along it in the left margin.
  const roll = (base: number, amp: number, seed: number, alpha: number, ridge: number): void => {
    const r = seeded(seed), ph = r() * 6
    fx.globalAlpha = alpha; fx.beginPath(); fx.moveTo(0, g.groundY + 2)
    const pts: Array<readonly [number, number]> = []
    for (let x = 0; x <= W; x += 6) pts.push([x, base - amp * (0.5 + 0.35 * Math.sin(x / W * 5 + ph) + 0.15 * Math.sin(x / W * 13 + ph * 2))])
    for (const [x, y] of pts) fx.lineTo(x, y)
    fx.lineTo(W, g.groundY + 2); fx.closePath(); fx.fill()
    fx.globalAlpha = ridge; fx.lineWidth = 4; strokePts(fx, pts)
  }
  roll(g.horizon + sky * 0.12, sky * 0.08, 61, 0.03, 0.42)
  roll(g.groundY - sky * 0.05, sky * 0.07, 67, 0.04, 0.5)
  for (let i = 0; i < 8; i++) {
    const x = edge * (0.12 + R() * 0.82), y = g.horizon + sky * (0.06 + R() * 0.1), h = 10 + R() * 14
    fx.globalAlpha = 0.42; poly(fx, [[x, y - h], [x + h * 0.32, y], [x - h * 0.32, y]])
    cutOut(fx, () => { fx.globalAlpha = 0.5; fx.lineWidth = 1.5; strokePts(fx, [[x - h * 0.2, y - h * 0.35], [x + h * 0.2, y - h * 0.35]]) })
  }

  // The snowfield's edge where the night wood's ground is, soft drifts under it.
  const ground: Array<readonly [number, number]> = []
  for (let x = 0; x <= W; x += 8) ground.push([x, groundAt(g, x)])
  const grad = fx.createLinearGradient(0, g.groundY, 0, H)
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.08)'); grad.addColorStop(1, 'rgba(0, 0, 0, 0.01)')
  fx.globalAlpha = 1; fx.fillStyle = grad; poly(fx, [...ground, [W, H], [0, H]]); fx.fillStyle = MASK
  fx.globalAlpha = 0.6; fx.lineWidth = 4.5; strokePts(fx, ground)
  fx.globalAlpha = 0.26; fx.lineWidth = 2.5
  for (let k = 1; k < 4; k++) {
    const d: Array<readonly [number, number]> = []
    for (let x = 0; x <= W; x += 10) d.push([x, g.groundY + k * (H - g.groundY) / 4 + Math.sin(x * 0.02 + k * 2) * 3])
    strokePts(fx, d)
  }

  drawMoon(fx, ax, g.moon)

  const clear = [...g.spots.filter(spot => spot.kind === 'tree' || spot.kind === 'limb'), g.home, g.visit]
  drawPine(fx, g.left, 0.2, clear, g.s)
  drawPine(fx, g.right, 0.15, clear, g.s)
  for (const b of [g.branches.left, g.branches.right]) bough(fx, b, Math.max(4, 6 * g.s), g.s)
}

/** The northern lights: curtains of light hanging from a slowly waving line across the upper sky, kept off the moon. */
function drawAurora(fx: Field, ax: Field, g: SceneLayout): void {
  const base = g.header + g.sky * 0.1, amp = g.sky * 0.035, m = g.moon
  for (let x = 0; x <= g.width; x += 4) {
    const top = base + Math.sin(x * 0.006 + 0.8) * amp + Math.sin(x * 0.017 + 1.3) * amp * 0.6
    const bright = 0.5 + 0.5 * Math.sin(x * 0.045 + Math.sin(x * 0.011) * 2.2)
    if (bright < 0.25) continue
    const len = g.sky * (0.06 + 0.1 * bright)
    fx.globalAlpha = 0.3 * bright; fx.lineWidth = 3; strokePts(fx, [[x, top], [x, top + len]])
    ax.globalAlpha = 0.9; ax.lineWidth = 3; strokePts(ax, [[x, top], [x, top + len]])
  }
  for (const field of [fx, ax]) cutOut(field, () => { field.globalAlpha = 1; ellipse(field, m.x, m.y, m.r * 1.5, m.r * 1.5) })
}

/**
 * A snow-laden pine where a night wood tree stands: a straight trunk, tiers of needles narrowing to its tip with snow
 * lying along each, and its limbs as long boughs owls sit on. The needles are kept off every place an owl sits.
 */
function drawPine(fx: Field, t: Tree, spread: number, clear: readonly Point[], s: number): void {
  const top = t.y - t.h, foot = t.y - t.h * 0.28, trunk = clamp(t.h * 0.022, 3, 10)
  fx.globalAlpha = 0.8; poly(fx, [[t.x - trunk, t.y], [t.x + trunk, t.y], [t.x + trunk * 0.3, top], [t.x - trunk * 0.3, top]])
  const tiers = 6
  for (let k = 0; k < tiers; k++) {
    const u = k / (tiers - 1), y0 = lerp(top, foot - t.h * 0.12, u), y1 = y0 + t.h * (0.12 + 0.05 * u)
    const half = t.h * lerp(0.04, spread, u)
    const tier: Array<readonly [number, number]> = [[t.x, y0], [t.x + half, y1], [t.x + half * 0.45, y1 - t.h * 0.02], [t.x, y1 + t.h * 0.01], [t.x - half * 0.45, y1 - t.h * 0.02], [t.x - half, y1]]
    fx.globalAlpha = 0.2; poly(fx, tier)
    fx.globalAlpha = 0.55; fx.lineWidth = 3; strokePts(fx, [[t.x - half, y1], [t.x, y0], [t.x + half, y1]])
    // Snow along the tier's lower edge.
    cutOut(fx, () => { fx.globalAlpha = 0.45; fx.lineWidth = 2.5; strokePts(fx, [[t.x - half * 0.9, y1 - 4], [t.x - half * 0.4, y1 - t.h * 0.02 - 4], [t.x, y1 + t.h * 0.01 - 4], [t.x + half * 0.4, y1 - t.h * 0.02 - 4], [t.x + half * 0.9, y1 - 4]]) })
  }
  // Room round every owl, so each reads against the dark between the needles.
  cutOut(fx, () => { fx.globalAlpha = 1; for (const spot of clear) ellipse(fx, spot.x, spot.y - 18 * s, 24 * s + 6, 26 * s + 8) })
  for (const l of t.limbs) bough(fx, l, Math.max(3, t.h * 0.011), s)
}

/** A bough an owl sits on: the branch, snow lying along its top, and needles hanging under it. */
function bough(fx: Field, l: Limb, w: number, s: number): void {
  const d = Math.sign(l.x1 - l.x0)
  fx.globalAlpha = 0.78; fx.lineCap = 'round'; fx.lineWidth = w; strokeLimb(fx, l); fx.lineCap = 'butt'
  fx.globalAlpha = 0.3; fx.lineWidth = 2.5; strokeLimb(fx, { ...l, y0: l.y0 - w * 0.6 - 1, y1: l.y1 - w * 0.6 - 1 })
  fx.globalAlpha = 0.42; fx.lineWidth = 2
  const len = Math.abs(l.x1 - l.x0)
  for (let k = 10; k < len - 4; k += 9) {
    const x = l.x0 + d * k, y = limbY(l, x) + w * 0.4, droop = lerp(5, 9, smooth(0, len, k)) * Math.max(1, s)
    strokePts(fx, [[x, y], [x + d * 3, y + droop]])
  }
  fx.globalAlpha = 0.3; ellipse(fx, l.x1, limbY(l, l.x1) - w * 0.4, 6 * s, 3.5 * s)
}

/** How many flakes fall at once: a fixed number, whatever the room's size, history or threads. */
const FLAKES = 56

function snowAmbience(g: SceneLayout): Ambience {
  const R = seeded(31), span = Math.max(1, g.height - g.header)
  const flakes = Array.from({ length: FLAKES }, () => ({ x0: R() * g.width, y0: R() * span, v: 14 + R() * 18, amp: 6 + R() * 14, ph: R() * 6.28, size: R() }))
  return {
    steps: 8,
    most: FLAKES,
    cells(t, emit) {
      for (const f of flakes) {
        const y = g.header + wrap(f.y0 + f.v * t, span), x = wrap(f.x0 + Math.sin(t * 0.7 + f.ph) * f.amp + 6 * t, g.width)
        emit(x, y, f.size > 0.78 ? '*' : f.size > 0.4 ? '·' : '.', false, 0.32 + 0.45 * f.size, false)
      }
    },
  }
}

export const SNOWFIELD: ScenePlace = { draw: drawSnowfield, stars: 1.2, ambience: snowAmbience }
