import { clamp, COLUMN_GAP, groundAt, lerp, limbY, seeded, type Limb, type SceneLayout, type Tree } from './nightScene'
import { wrap, type Ambience, type ScenePlace } from './scenePlace'
import { alongLimb, cutOut, drawMoon, ellipse, MASK, poly, strokeLimb, strokePts, type Field } from './sceneDraw'

/**
 * Harbour (ADR-0148): the sea under the moon, a stone quay where the night wood has its ground, a ship moored at the
 * quay whose mast and yards stand where Watcher's tree and its limbs do, a lighthouse where the bare tree stands, with
 * a rope from its tower to a signal pole where that tree's long limb is, and a spar with a lantern out of each side of
 * the composer. The accent is the light: the lamp, the lanterns, the masthead light and the moon's path on the water.
 * The lamp's beam sweeps the right margin, and the moon's path glitters.
 */

/** Where the sea meets the sky. */
const seaLevel = (g: SceneLayout): number => g.horizon + g.sky * 0.06
/** The lighthouse's half-width at its foot. */
const towerWidth = (t: Tree): number => clamp(t.h * 0.055, 7, 22)
/** The lighthouse's lamp, the centre its beam sweeps from. */
export function harbourLamp(g: SceneLayout): { readonly x: number; readonly y: number } {
  const t = g.right, bw = towerWidth(t)
  return { x: t.x, y: t.y - t.h * 0.92 - 4 - bw * 0.55 }
}

function drawHarbour(fx: Field, ax: Field, g: SceneLayout): void {
  const W = g.width, H = g.height, R = seeded(19), seaY = seaLevel(g), edge = g.column.left - 14

  // A low headland far off on the left, and a smaller one on the right, against the sea's horizon.
  const headland = (x0: number, x1: number, rise: number): void => {
    const pts: Array<readonly [number, number]> = []
    for (let x = x0; x <= x1; x += 6) { const k = (x - x0) / (x1 - x0); pts.push([x, seaY - rise * Math.sin(Math.PI * k) ** 0.7 * (0.75 + 0.25 * Math.sin(x * 0.05))]) }
    fx.globalAlpha = 0.05; poly(fx, [...pts, [x1, seaY]]); fx.globalAlpha = 0.5; fx.lineWidth = 4; strokePts(fx, pts)
  }
  headland(-20, edge * 0.7, g.sky * 0.07)
  headland(W - Math.max(60, (W - g.column.right) * 0.45), W + 20, g.sky * 0.04)
  fx.globalAlpha = 0.55; fx.lineWidth = 3; strokePts(fx, [[0, seaY], [W, seaY]])

  // The sea in broken rows that thicken toward the quay, and on under it.
  for (let y = seaY + 9; y < H + 8; y += 8 + (y - seaY) * 0.05) {
    const k = clamp((y - seaY) / Math.max(1, g.groundY - seaY), 0, 1)
    fx.globalAlpha = 0.18 + 0.24 * k; fx.lineWidth = 2.4 + 2.2 * k
    for (let x = -R() * 40; x < W; ) {
      const len = 18 + R() * 60, yy = y + Math.sin(x * 0.04 + y) * 1.5
      strokePts(fx, [[x, yy], [x + len * 0.5, yy - 1.2], [x + len, yy]])
      x += len + 6 + R() * 26
    }
  }

  // The moon's path on the water, in the accent, from the horizon to the quay.
  const m = g.moon
  for (let y = seaY + 4; y < g.groundY - 4; y += 6) {
    const k = (y - seaY) / Math.max(1, g.groundY - seaY), w = m.r * (0.4 + k * 1.4) * (0.5 + R() * 0.7)
    ax.globalAlpha = 0.85; ax.lineWidth = 3.5; strokePts(ax, [[m.x - w, y], [m.x + w, y]])
    fx.globalAlpha = 0.3; fx.lineWidth = 3; strokePts(fx, [[m.x - w, y], [m.x + w, y]])
  }
  drawMoon(fx, ax, m)

  drawShip(fx, ax, g)
  drawLighthouse(fx, ax, g)

  // The quay: its top edge where the night wood's ground is, its stone face under it, and the water at its foot.
  const face = Math.max(10, g.sky * 0.03)
  fx.fillStyle = MASK; fx.globalAlpha = 0.32; fx.beginPath(); fx.moveTo(0, g.groundY)
  for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x))
  for (let x = W; x >= 0; x -= 10) fx.lineTo(x, groundAt(g, x) + face)
  fx.closePath(); fx.fill()
  cutOut(fx, () => {
    fx.globalAlpha = 0.6; fx.lineWidth = 1.6
    for (let x = 12 + R() * 10; x < W; x += 24 + R() * 10) { const y = groundAt(g, x); strokePts(fx, [[x, y + 4], [x, y + face - 1]]) }
  })
  fx.globalAlpha = 0.7; fx.lineWidth = 5
  fx.beginPath(); fx.moveTo(0, g.groundY); for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x)); fx.stroke()

  // A spar out of each side of the composer, with a lantern hanging from its end.
  for (const b of [g.branches.left, g.branches.right]) {
    const d = Math.sign(b.x1 - b.x0), w = Math.max(4, 6 * g.s)
    fx.globalAlpha = 0.8; fx.lineCap = 'round'; fx.lineWidth = w; strokeLimb(fx, b)
    fx.lineCap = 'butt'
    const lx = b.x1 - d * 4 * g.s, top = limbY(b, lx), drop = 9 * g.s, lw = 5 * g.s, lh = 8 * g.s
    fx.globalAlpha = 0.5; fx.lineWidth = 1.6; strokePts(fx, [[lx, top], [lx, top + drop]])
    fx.globalAlpha = 0.55; fx.fillRect(lx - lw / 2, top + drop, lw, lh)
    ax.globalAlpha = 1; ax.fillRect(lx - lw / 2, top + drop, lw, lh)
  }
}

/** The ship at the quay: hull, mast, the yards the night wood's limbs become, furled sails, rigging and its lights. */
function drawShip(fx: Field, ax: Field, g: SceneLayout): void {
  const t = g.left, mastW = clamp(t.h * 0.016, 3, 8), top = t.y - t.h * 0.98
  const gunwale = g.groundY - Math.max(12, g.sky * 0.045)
  const stern = t.x - t.h * 0.24, bow = Math.min(g.column.left - COLUMN_GAP - 10, t.x + t.h * 0.3)
  // The hull, its bow raised toward the room, behind the quay.
  fx.globalAlpha = 0.42
  poly(fx, [[stern, gunwale + 3], [lerp(stern, bow, 0.6), gunwale], [bow, gunwale - Math.max(6, g.sky * 0.02)], [bow - 8, g.groundY + 2], [stern, g.groundY + 2]])
  fx.globalAlpha = 0.75; fx.lineWidth = 3.5
  strokePts(fx, [[stern, gunwale + 3], [lerp(stern, bow, 0.6), gunwale], [bow, gunwale - Math.max(6, g.sky * 0.02)]])
  // The mast, thinner above the highest yard.
  const highest = Math.min(...t.limbs.map(l => Math.min(l.y0, l.y1)))
  fx.globalAlpha = 0.82; fx.lineWidth = mastW; strokePts(fx, [[t.x, gunwale], [t.x, highest]])
  fx.lineWidth = Math.max(2, mastW * 0.55); strokePts(fx, [[t.x, highest], [t.x, top]])
  // A crow's nest under the topmast.
  const nest = lerp(highest, top, 0.35), nw = Math.max(6, mastW * 2.2)
  fx.globalAlpha = 0.6; poly(fx, [[t.x - nw, nest - 5], [t.x + nw, nest - 5], [t.x + nw * 0.7, nest + 4], [t.x - nw * 0.7, nest + 4]])
  // A pennant at the masthead, and its light in the accent.
  fx.globalAlpha = 0.5; poly(fx, [[t.x, top + 2], [t.x + t.dir * Math.max(14, t.h * 0.05), top + 6], [t.x, top + 10]])
  ellipse(ax, t.x, top - 2, 3, 3); fx.globalAlpha = 0.5; ellipse(fx, t.x, top - 2, 3, 3)
  // The yards, where the night wood's limbs are, each crossing the mast; a furled sail under each.
  for (const l of t.limbs) {
    const d = Math.sign(l.x1 - l.x0), back = (l.x1 - l.x0) * -0.35
    const yard: Limb = { ...l, x0: l.x0 + back, y0: l.y0 - (l.y1 - l.y0) * 0.35 }
    fx.globalAlpha = 0.8; fx.lineCap = 'round'; fx.lineWidth = Math.max(3.5, t.h * 0.011); strokeLimb(fx, yard); fx.lineCap = 'butt'
    const sail = alongLimb(yard).map(([x, y]) => [x, y + 3] as const)
    fx.globalAlpha = 0.28; poly(fx, [...sail, ...sail.slice().reverse().map(([x, y]) => [x, y + Math.max(4, t.h * 0.012)] as const)])
    // The lifts, from the masthead to the yard's ends.
    fx.globalAlpha = 0.28; fx.lineWidth = 1.5
    strokePts(fx, [[t.x, top + 8], [l.x1 - d * 3, limbY(l, l.x1)]])
  }
  // The shrouds, from under the lowest yard to the hull.
  const lowest = Math.max(...t.limbs.map(l => l.y0))
  fx.globalAlpha = 0.3; fx.lineWidth = 1.5
  strokePts(fx, [[t.x, lowest - 4], [stern + 10, gunwale + 3]]); strokePts(fx, [[t.x, lowest - 4], [lerp(t.x, bow, 0.7), gunwale]])
}

/** The lighthouse on its rock where the bare tree stands, and the rope from its tower to a signal pole by the column. */
function drawLighthouse(fx: Field, ax: Field, g: SceneLayout): void {
  const t = g.right, bw = towerWidth(t), base = g.groundY + 2, topY = t.y - t.h * 0.92
  fx.globalAlpha = 0.5; ellipse(fx, t.x, base, bw * 2.4, 8 + bw * 0.4)
  fx.globalAlpha = 0.56; poly(fx, [[t.x - bw, base], [t.x + bw, base], [t.x + bw * 0.62, topY], [t.x - bw * 0.62, topY]])
  // Two bands taken out of the tower, so it reads as striped.
  cutOut(fx, () => { fx.globalAlpha = 0.5; for (const k of [0.2, 0.6]) fx.fillRect(t.x - bw * 1.2, lerp(base, topY, k + 0.2), bw * 2.4, (base - topY) * 0.12) })
  // The gallery, the lamp room in the accent, and the roof.
  fx.globalAlpha = 0.95; fx.fillRect(t.x - bw * 0.95, topY - 4, bw * 1.9, 5)
  fx.globalAlpha = 0.35; fx.fillRect(t.x - bw * 0.48, topY - 4 - bw * 1.1, bw * 0.96, bw * 1.1)
  ax.globalAlpha = 1; ax.fillRect(t.x - bw * 0.48, topY - 4 - bw * 1.1, bw * 0.96, bw * 1.1)
  fx.globalAlpha = 0.9; poly(fx, [[t.x - bw * 0.7, topY - 4 - bw * 1.1], [t.x + bw * 0.7, topY - 4 - bw * 1.1], [t.x, topY - 4 - bw * 1.9]])
  // The rope where the night wood's long limb is, and the pole it is tied to, flying a flag away from the column.
  for (const l of t.limbs) {
    const d = Math.sign(l.x1 - l.x0)
    fx.globalAlpha = 0.78; fx.lineWidth = Math.max(2.5, t.h * 0.007); strokeLimb(fx, l)
    const poleTop = l.y1 - Math.max(18, t.h * 0.06)
    fx.globalAlpha = 0.85; fx.lineWidth = Math.max(3, t.h * 0.01); strokePts(fx, [[l.x1, g.groundY], [l.x1, poleTop]])
    fx.globalAlpha = 0.5; poly(fx, [[l.x1, poleTop], [l.x1 - d * Math.max(12, t.h * 0.04), poleTop + 5], [l.x1, poleTop + 10]])
  }
}

/** The beam's reach from the lamp, its spread either side of its line, and the most glyphs it and the glitter draw. */
const BEAM = { spread: 0.1, turn: 0.45, most: 140 } as const
const GLINTS = 40

function harbourAmbience(g: SceneLayout): Ambience {
  const lamp = harbourLamp(g), seaY = seaLevel(g), m = g.moon, R = seeded(53)
  const right = g.width - lamp.x, left = Math.max(0, lamp.x - g.column.right - COLUMN_GAP)
  // Glints on the moon's path, fixed places that light in turn.
  const glints: Array<{ readonly x: number; readonly y: number; readonly phase: number; readonly kind: number }> = []
  for (let k = 0; k < GLINTS; k++) {
    const y = lerp(seaY + 6, g.groundY - 8, R() ** 0.8), w = m.r * (0.4 + (y - seaY) / Math.max(1, g.groundY - seaY) * 1.4)
    glints.push({ x: m.x + (R() * 2 - 1) * w, y, phase: Math.floor(R() * 5), kind: R() })
  }
  return {
    steps: 8,
    most: BEAM.most + GLINTS + 5,
    cells(t, emit) {
      // The beam turns with the lamp: long when it points across the margin, short toward the room, where it stops
      // before the column, and the lamp flashes as it points out of the picture.
      const th = t * BEAM.turn + 2.2, cs = Math.cos(th), side = cs >= 0 ? 1 : -1
      const reach = Math.abs(cs) * (side > 0 ? right : left)
      let drawn = 0
      if (reach > 16) {
        for (let dx = 10; dx <= reach && drawn < BEAM.most; dx += 7) {
          const half = Math.max(6, dx * BEAM.spread), yc = lamp.y - dx * 0.09
          for (let dy = -half; dy <= half && drawn < BEAM.most; dy += 12) {
            const off = dy / half, s = 0.75 * (1 - dx / (reach + 1)) ** 0.8 * (1 - off * off) * Math.min(1, Math.abs(cs) * 1.6)
            if (s < 0.1) continue
            emit(lamp.x + side * dx, yc + dy, s > 0.5 ? '=' : s > 0.32 ? '-' : s > 0.2 ? ':' : '·', true, 0.2 + 0.7 * s, false)
            drawn++
          }
        }
      }
      const flash = Math.max(0, 1 - Math.abs(cs) * 3)
      if (flash > 0.05) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0]] as const) emit(lamp.x + dx * 7, lamp.y + dy * 12, Math.abs(dx) > 1 ? '·' : '*', true, 0.3 + 0.6 * flash, false)
      // A fifth of the moon's glints at a time, in turn.
      const step = Math.floor(t * 2.4)
      for (const glint of glints) {
        if (wrap(glint.phase + step, 5) !== 0) continue
        emit(glint.x, glint.y, glint.kind > 0.6 ? '∘' : glint.kind > 0.3 ? '·' : '-', true, 0.5 + 0.3 * glint.kind, true)
      }
    },
  }
}

export const HARBOUR: ScenePlace = {
  draw: drawHarbour,
  stars: 1,
  ambience: harbourAmbience,
}
