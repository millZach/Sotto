/** Pure pixel painting: the component owns timing, theming and lifecycle. */
export interface FurnaceFrame {
  position: number
  heat: number
  count: number
  elapsed: number | null
  now: number
  moving: boolean
}

export const furnaceEase = (value: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, value)), 3)
export const furnaceGold = (elapsed: number | null): number => elapsed === null ? 0 : furnaceEase((elapsed - 1.9) / .95)
export type FurnaceColor = 'track' | 'fill' | 'gold' | 'highlight' | 'shadow' | 'fire' | 'warm' | 'core'

export function paintFurnace(ctx: CanvasRenderingContext2D, width: number, height: number, colors: Record<FurnaceColor, string>, frame: FurnaceFrame): void {
  const clamp = (value: number): number => Math.min(1, Math.max(0, value))
  const { elapsed, heat, now, moving } = frame
  const t = elapsed ?? 0
  const melt = elapsed === null ? 0 : furnaceEase((t - .85) / 1.05)
  const spread = elapsed === null ? 0 : furnaceEase((t - 1.7) / 1.15)
  const left = 8, right = width - 8, trackWidth = right - left, bar = height - 18, center = width / 2, base = bar - 26
  const rect = (x: number, y: number, w: number, h: number, color: FurnaceColor): void => {
    ctx.fillStyle = colors[color]
    ctx.fillRect(x, y, w, h)
  }
  const pixel = (x: number, y: number, w: number, h: number, color: FurnaceColor): void => rect(Math.round(x), Math.round(y), Math.round(w), Math.round(h), color)
  ctx.clearRect(0, 0, width, height)
  rect(left, bar - 3, trackWidth, 6, 'track')
  rect(left, bar - 3, Math.max(3, trackWidth * frame.position / Math.max(1, frame.count - 1)), 6, 'fill')
  for (let i = 0; i < frame.count; i++) pixel(left + trackWidth * i / Math.max(1, frame.count - 1) - 1, bar + 8, 2, 3, 'track')

  const flameSize = elapsed === null ? heat * 65 : 78 * (.4 + .6 * furnaceEase(t / .5))
  const fade = elapsed === null ? 1 : 1 - clamp((t - 1.75) / .7)
  const tick = moving ? Math.floor(now / 80) : 0
  const rows = Math.floor(flameSize / 3)
  ctx.globalAlpha = fade
  for (let y = 0; y < rows; y++) for (let col = 0; col < 17; col++) {
    const f = y / rows, mid = 8 + Math.sin(f * 9 + tick * .48) * (1.2 + f * 2), half = 7 * (1 - f) + .25
    if (Math.abs(col - mid) < half + Math.sin(col * 1.9 + tick * .65 + y * .5) * .8) {
      const inner = Math.abs(col - mid) / (half + 1)
      pixel(center + (col - 8) * 3, base - 7 - y * 3, 3, 3, f < .35 && inner < .45 ? 'core' : inner < .63 ? 'warm' : 'fire')
    }
  }
  ctx.globalAlpha = 1
  if (melt < 1) for (const [dx, dy] of [[-15, 0], [7, 0], [-23, -6], [0, -6], [19, -5], [-10, -12], [12, -12], [1, -18]] as const) {
    ctx.save()
    ctx.translate(Math.round(center + dx * (1 + melt * .18)), Math.round(base + dy * (1 - melt)))
    ctx.scale(1, Math.max(.12, 1 - melt * .88))
    pixel(-8, -4, 16, 7, 'shadow'); pixel(-10, -2, 20, 3, 'shadow')
    pixel(-8, -5, 16, 5, 'gold'); pixel(-5, -6, 10, 2, 'highlight')
    pixel(-6, -4, 3, 2, 'highlight'); pixel(3, -3, 4, 2, 'shadow')
    ctx.restore()
  }
  if (melt > 0 && spread < 1) {
    pixel(center - 29, base, 58, 4, 'gold')
    rect(center - 9, base + 3, 5, (bar - base) * clamp(melt * 1.4), 'gold')
    rect(center + 9, base + 3, 3, (bar - base) * melt, 'highlight')
  }
  if (spread > 0) {
    const start = center + (left - center) * spread, end = center + (right - center) * spread
    rect(start, bar - 4, end - start, 8, 'gold')
    rect(start, bar - 4, end - start, 2, 'highlight')
    rect(start, bar + 2, end - start, 2, 'shadow')
    if (t > 2.9 && t < 3.5 && moving) rect(left + trackWidth * clamp((t - 2.9) / .6), bar - 4, 5, 8, 'highlight')
  }
  if (moving && heat > .15 && spread < 1) for (let i = 0; i < Math.ceil(heat * 10); i++) {
    const p = (now / 1700 + i * .173) % 1, y = base - 8 - p * (height - 35)
    if (y > 5 && p > .15 && p < .8) {
      ctx.globalAlpha = (1 - p) * .75
      pixel(center + Math.sin(i * 9.3 + p * 3) * (12 + heat * 18), y, 2, 2, i % 2 ? 'highlight' : 'fire')
    }
  }
  ctx.globalAlpha = 1
}
