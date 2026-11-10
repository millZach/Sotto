// PROTOTYPE, throwaway. The night wood of placeNightWood.ts, stroke for stroke, but each part drawn on the layer it
// belongs to, far to near, so the painter can let what is in front hide what is behind and draw far things fainter.
// The random draws are made in the same order as the real place, so every pine and blade of grass stands where it does.
import { groundAt, limbY, seeded, smooth, type SceneLayout } from '@w/nightScene'
import { drawTree } from '@w/placeNightWood'
import { drawMoon, MASK, strokeLimb, type Field } from '@w/sceneDraw'

/** The wood's layers, the farthest first. */
export const WOOD_LAYERS = ['moon', 'far', 'mid', 'near', 'river', 'ground', 'bare', 'tree', 'branch'] as const
export type WoodLayer = typeof WOOD_LAYERS[number]

/** How strong each layer's ink is drawn when depth shows: the moon brightest, the far hills faintest. */
export const LAYER_TONE: Record<WoodLayer, number> = { moon: 1.3, far: 0.5, mid: 0.64, near: 0.78, river: 0.9, ground: 0.92, bare: 0.9, tree: 1.08, branch: 1.08 }

/**
 * Draws the wood, each part on its layer's field. `apart` is for depth: a hill is then stroked along its ridge only, not
 * round its foot, where the ground in front of it hides it, and the ground's edge is drawn as strong as the hills' feet
 * and its own line were together.
 */
export function drawWoodLayers(target: (layer: WoodLayer) => Field, ax: Field, g: SceneLayout, apart: boolean): void {
  const W = g.width, H = g.height, sky = g.sky, edge = g.column.left - 14
  const R = seeded(7)
  // Far, middle and near hills, each with its ridgeline.
  const hill = (fx: Field, base: number, amp: number, seed: number, alpha: number, fade: number, ridge: number): void => {
    const r = seeded(seed), ph = [r() * 6, r() * 6, r() * 6] as const
    fx.globalAlpha = alpha; fx.beginPath(); fx.moveTo(0, g.groundY + 2)
    for (let x = 0; x <= W; x += 6) {
      const k = x / W
      const lift = (1 - smooth(0.25, fade, k) * 0.75) * amp
      fx.lineTo(x, base - lift * (0.55 + 0.25 * Math.sin(k * 7 + ph[0]) + 0.15 * Math.sin(k * 17 + ph[1]) + 0.05 * Math.sin(k * 41 + ph[2])))
    }
    fx.lineTo(W, g.groundY + 2); fx.closePath(); fx.fill()
    fx.globalAlpha = ridge; fx.lineWidth = 5
    if (!apart) { fx.stroke(); return }
    fx.beginPath()
    for (let x = 0; x <= W; x += 6) {
      const k = x / W
      const lift = (1 - smooth(0.25, fade, k) * 0.75) * amp
      const y = base - lift * (0.55 + 0.25 * Math.sin(k * 7 + ph[0]) + 0.15 * Math.sin(k * 17 + ph[1]) + 0.05 * Math.sin(k * 41 + ph[2]))
      if (x === 0) fx.moveTo(x, y); else fx.lineTo(x, y)
    }
    fx.stroke()
  }
  hill(target('far'), g.horizon, sky * 0.22, 11, 0.03, 0.6, 0.45)
  hill(target('mid'), g.horizon + sky * 0.1, sky * 0.16, 23, 0.04, 0.5, 0.55)
  hill(target('near'), g.groundY - sky * 0.04, sky * 0.12, 37, 0.05, 0.42, 0.65)

  // Furrows across the left margin's near fields.
  let fx = target('near')
  fx.globalAlpha = 0.3; fx.lineWidth = 3.5
  for (let i = 0; i < 6; i++) {
    const y = g.groundY - sky * 0.05 + i * 11 - 30
    fx.beginPath(); fx.moveTo(0, y + 26); fx.quadraticCurveTo(edge * 0.45, y, edge * 0.9, y + 16); fx.stroke()
  }

  // The river, cut out of the hills it runs through, with its own faint line and the moon's light on it.
  const river = new Path2D()
  river.moveTo(edge * 0.8, g.horizon + 6)
  river.bezierCurveTo(edge * 0.55, g.horizon + sky * 0.14, edge * 0.7, g.groundY - sky * 0.03, edge * 0.35, g.groundY + 20)
  river.quadraticCurveTo(edge * 0.12, g.groundY + 45, -10, H)
  for (const layer of ['far', 'mid', 'near'] as const) {
    fx = target(layer)
    fx.globalCompositeOperation = 'destination-out'
    for (const [w, a] of [[5, 1], [12, 0.6]] as const) { fx.lineWidth = w; fx.globalAlpha = a; fx.stroke(river) }
    fx.globalCompositeOperation = 'source-over'
  }
  ax.globalAlpha = 0.7; ax.lineWidth = 5; ax.stroke(river)
  fx = target('river')
  fx.globalAlpha = 0.22; fx.lineWidth = 4; fx.stroke(river)

  // Pines on the left margin's far hills.
  fx = target('far')
  for (let i = 0; i < 9; i++) {
    const x = edge * (0.15 + R() * 0.8), y = g.horizon + sky * (0.03 + R() * 0.12), h = 10 + R() * 14
    fx.globalAlpha = 0.4; fx.beginPath(); fx.moveTo(x, y - h); fx.lineTo(x + h * 0.35, y); fx.lineTo(x - h * 0.35, y); fx.fill()
  }

  // The ground, fading toward the bottom, with grass along its edge.
  fx = target('ground')
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

  drawMoon(target('moon'), ax, g.moon)

  // Watcher's broad tree on the left, the bare one on the right, and the composer's two branches.
  const spots = [...g.spots.filter(spot => spot.kind === 'tree'), g.home]
  drawTree(target('tree'), g.left, 101, true, spots)
  drawTree(target('bare'), g.right, 202, false, [])
  fx = target('branch')
  for (const b of [g.branches.left, g.branches.right]) {
    const d = Math.sign(b.x1 - b.x0), w = Math.max(5, 7 * g.s)
    fx.globalAlpha = 0.8; fx.lineCap = 'round'; fx.lineWidth = w; strokeLimb(fx, b)
    fx.lineWidth = Math.max(2.5, w * 0.4)
    fx.beginPath(); fx.moveTo(b.x1 - d * 10, limbY(b, b.x1 - d * 10)); fx.lineTo(b.x1 + d * 6, b.y1 - 16 * g.s); fx.stroke()
    fx.globalAlpha = 0.18
    for (const [dx, dy, r] of [[6, -18, 9], [-2, -10, 7], [14, -8, 6]] as const) { fx.beginPath(); fx.arc(b.x1 + d * dx * g.s, b.y1 + dy * g.s, r * g.s, 0, 7); fx.fill() }
  }
}
