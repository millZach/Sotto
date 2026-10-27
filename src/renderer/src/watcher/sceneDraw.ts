import { limbY, type Limb, type Moon } from './nightScene'

/**
 * The vector strokes every place of Watcher's night scene is drawn with, on the painter's offscreen fields. Only a
 * field's coverage is read, never its colour, so everything is drawn in one opaque ink at the alpha that sets how dense
 * its glyphs come out (`nightScenePainter.ts`).
 */

/** Only the offscreen fields' coverage is read, never their colour, so they are drawn in any opaque ink. */
export const MASK = 'black'

export type Field = CanvasRenderingContext2D
export type Pts = ReadonlyArray<readonly [number, number]>

export function strokeLimb(fx: Field, l: Limb): void {
  fx.beginPath(); fx.moveTo(l.x0, l.y0); fx.quadraticCurveTo((l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2 + l.sag, l.x1, l.y1); fx.stroke()
}

export function poly(fx: Field, pts: Pts): void {
  fx.beginPath(); fx.moveTo(pts[0]![0], pts[0]![1]); for (const p of pts.slice(1)) fx.lineTo(p[0], p[1]); fx.closePath(); fx.fill()
}

export function strokePts(fx: Field, pts: Pts): void {
  fx.beginPath(); pts.forEach((p, k) => k === 0 ? fx.moveTo(p[0], p[1]) : fx.lineTo(p[0], p[1])); fx.stroke()
}

export function ellipse(fx: Field, x: number, y: number, rx: number, ry: number, rot = 0): void {
  fx.beginPath(); fx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2); fx.fill()
}

/** Draws `draw` as a cut: what it covers is taken out of the field. */
export function cutOut(fx: Field, draw: () => void): void {
  fx.globalCompositeOperation = 'destination-out'; draw(); fx.globalCompositeOperation = 'source-over'
}

/** Points along a limb's curve, every `step` pixels or so, for a shape that follows it. */
export function alongLimb(l: Limb, step = 6): Array<readonly [number, number]> {
  const n = Math.max(2, Math.ceil(Math.abs(l.x1 - l.x0) / step)), out: Array<readonly [number, number]> = []
  for (let k = 0; k <= n; k++) { const x = l.x0 + (l.x1 - l.x0) * k / n; out.push([x, limbY(l, x)]) }
  return out
}

/** The moon with its rim and craters, and the accent's glow around it. `scale` draws it larger about the same centre. */
export function drawMoon(fx: Field, ax: Field, moon: Moon, scale = 1): void {
  const m = { x: moon.x, y: moon.y, r: moon.r * scale }
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
}
