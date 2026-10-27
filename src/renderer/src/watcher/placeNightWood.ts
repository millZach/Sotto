import { groundAt, limbY, seeded, smooth, type SceneLayout, type Tree } from './nightScene'
import type { ScenePlace } from './scenePlace'
import { drawMoon, MASK, strokeLimb, type Field } from './sceneDraw'

/**
 * The night wood, Watcher's first place and the default (Zach's pick on October 21, 2026): far, middle and near hills
 * with a river catching the moon, pines on the far hills, grass along the ground, Watcher's broad tree on the left, a
 * bare one on the right and a branch out of each side of the composer. Hills and ground run the room's width; the
 * column's cells take its share when the glyphs are drawn.
 */
function drawNightWood(fx: Field, ax: Field, g: SceneLayout): void {
  const W = g.width, H = g.height, sky = g.sky, edge = g.column.left - 14
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

  // Furrows across the left margin's near fields.
  fx.globalAlpha = 0.3; fx.lineWidth = 3.5
  for (let i = 0; i < 6; i++) {
    const y = g.groundY - sky * 0.05 + i * 11 - 30
    fx.beginPath(); fx.moveTo(0, y + 26); fx.quadraticCurveTo(edge * 0.45, y, edge * 0.9, y + 16); fx.stroke()
  }

  // A river from the far hills to the front of the left margin, catching the moon.
  const river = new Path2D()
  river.moveTo(edge * 0.8, g.horizon + 6)
  river.bezierCurveTo(edge * 0.55, g.horizon + sky * 0.14, edge * 0.7, g.groundY - sky * 0.03, edge * 0.35, g.groundY + 20)
  river.quadraticCurveTo(edge * 0.12, g.groundY + 45, -10, H)
  fx.globalCompositeOperation = 'destination-out'
  for (const [w, a] of [[5, 1], [12, 0.6]] as const) { fx.lineWidth = w; fx.globalAlpha = a; fx.stroke(river) }
  fx.globalCompositeOperation = 'source-over'
  ax.globalAlpha = 0.7; ax.lineWidth = 5; ax.stroke(river)
  fx.globalAlpha = 0.22; fx.lineWidth = 4; fx.stroke(river)

  // Pines on the left margin's far hills.
  for (let i = 0; i < 9; i++) {
    const x = edge * (0.15 + R() * 0.8), y = g.horizon + sky * (0.03 + R() * 0.12), h = 10 + R() * 14
    fx.globalAlpha = 0.4; fx.beginPath(); fx.moveTo(x, y - h); fx.lineTo(x + h * 0.35, y); fx.lineTo(x - h * 0.35, y); fx.fill()
  }

  // The ground, fading toward the bottom, with grass along its edge.
  const grad = fx.createLinearGradient(0, g.groundY, 0, H)
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.07)'); grad.addColorStop(0.4, 'rgba(0, 0, 0, 0.03)'); grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
  fx.globalAlpha = 1; fx.fillStyle = grad
  fx.beginPath(); fx.moveTo(0, g.groundY)
  for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x))
  fx.lineTo(W, H); fx.lineTo(0, H); fx.closePath(); fx.fill()
  fx.fillStyle = MASK; fx.globalAlpha = 0.6; fx.lineWidth = 5
  fx.beginPath(); fx.moveTo(0, g.groundY); for (let x = 0; x <= W; x += 10) fx.lineTo(x, groundAt(g, x)); fx.stroke()
  fx.lineWidth = 3; fx.globalAlpha = 0.45
  for (let x = 4; x < W; x += 5 + R() * 9) {
    const h = 4 + R() * 9, y = g.groundY + Math.sin(x * 0.013) * 3
    fx.beginPath(); fx.moveTo(x, y + 2); fx.lineTo(x + (R() - 0.5) * 5, y - h); fx.stroke()
  }

  drawMoon(fx, ax, g.moon)

  // Watcher's broad tree on the left, the bare one on the right, and the composer's two branches.
  const spots = [...g.spots.filter(spot => spot.kind === 'tree'), g.home]
  drawTree(fx, g.left, 101, true, spots)
  drawTree(fx, g.right, 202, false, [])
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

export const NIGHT_WOOD: ScenePlace = { draw: drawNightWood, stars: 1, ambience: null }
