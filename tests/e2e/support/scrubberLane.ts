import type { Page } from '@playwright/test'

/**
 * Every background the message scrubber's lane paints in `pane`, in words: the lane and everything in it but the card a
 * tick opens. Empty when the lane is clear, so its ticks float over what is under it (the user's ask on October 24, 2026).
 */
export async function laneBackgrounds(page: Page, pane: string): Promise<string[]> {
  return page.evaluate(pane => {
    const lane = document.querySelector(`${pane} .message-scrubber`)
    if (lane === null) return ['no lane']
    const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const alpha = (css: string): number => { pixel.clearRect(0, 0, 1, 1); pixel.fillStyle = 'rgba(0, 0, 0, 0)'; pixel.fillStyle = css; pixel.fillRect(0, 0, 1, 1); return pixel.getImageData(0, 0, 1, 1).data[3]! }
    const found: string[] = []
    for (const node of [lane, ...lane.querySelectorAll('*')]) {
      if (node.closest('.message-scrubber__card') !== null) continue
      const style = getComputedStyle(node)
      if (alpha(style.backgroundColor) > 0 || style.backgroundImage !== 'none') found.push(`${node.tagName.toLowerCase()}.${node.className} ${style.backgroundColor} ${style.backgroundImage}`)
    }
    return found
  }, pane)
}

/**
 * The lowest contrast of the lane's ticks against what lies right beside them on screen: each tick's line, at its
 * strongest row, against the
 * pixels one and a half and two and a half CSS pixels past its edge, above and below, that are not another tick's or the card's, read from a capture, so the scene's glyphs, the room and any glow
 * the tick carries all count as they show. Ticks are marks, not words: 3:1.
 */
export async function tickContrast(page: Page, pane: string, capture: Buffer, decode: (png: Buffer) => Promise<{ data: Buffer; width: number; height: number; channels: number }>): Promise<{ worst: number; room: number; ticks: number }> {
  const ticks = await page.evaluate(pane => [...document.querySelectorAll(`${pane} .message-scrubber__tick`)].map(tick => {
    const before = getComputedStyle(tick, '::before'), box = tick.getBoundingClientRect(), lane = tick.closest('.message-scrubber')!.getBoundingClientRect()
    const width = parseFloat(before.width), gap = parseFloat(before.right), card = document.querySelector('.message-scrubber__card')?.getBoundingClientRect()
    return { y: box.top + box.height / 2, half: parseFloat(before.height) / 2, x0: lane.right - gap - width, x1: lane.right - gap, scale: devicePixelRatio,
      card: card === undefined ? null : { left: card.left, right: card.right, top: card.top, bottom: card.bottom } }
  }).filter(tick => tick.y > 0 && tick.y < innerHeight), pane)
  // The faintest tick over the bare room, with the lane's and the tick's own opacity: what the lane shows with no scene.
  const room = await page.evaluate(pane => {
    const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const rgba = (css: string): number[] => { pixel.clearRect(0, 0, 1, 1); pixel.fillStyle = 'rgba(0, 0, 0, 0)'; pixel.fillStyle = css; pixel.fillRect(0, 0, 1, 1); const d = pixel.getImageData(0, 0, 1, 1).data; return [d[0]!, d[1]!, d[2]!, d[3]! / 255] }
    const lin = (c: number): number => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
    const lum = (c: number[]): number => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!)
    let surface = [0, 0, 0]
    for (let node: Element | null = document.querySelector(pane); node !== null; node = node.parentElement) { const c = rgba(getComputedStyle(node).backgroundColor); if (c[3]! > 0) { surface = c.slice(0, 3); break } }
    let worst = Number.POSITIVE_INFINITY
    const laneOpacity = Number(getComputedStyle(document.querySelector(`${pane} .message-scrubber`)!).opacity)
    for (const tick of document.querySelectorAll(`${pane} .message-scrubber__tick`)) {
      const before = getComputedStyle(tick, '::before'), colour = rgba(before.backgroundColor)
      const a = colour[3]! * Number(before.opacity) * laneOpacity
      const shown = surface.map((c, k) => c + (colour[k]! - c) * a)
      const x = lum(shown), y = lum(surface)
      worst = Math.min(worst, (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05))
    }
    return worst
  }, pane)
  const image = await decode(capture)
  const at = (x: number, y: number): number[] => { const i = (Math.round(y) * image.width + Math.round(x)) * image.channels; return [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!] }
  const lin = (c: number): number => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const lum = (c: number[]): number => 0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!)
  const ratio = (a: number[], b: number[]): number => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  let worst = Number.POSITIVE_INFINITY
  for (const tick of ticks) {
    const s = tick.scale
    for (let x = tick.x0 + 1; x < tick.x1 - 1; x += 1) {
      // The line's own rows, at whole device pixels: a two-pixel line on a half pixel covers one row whole and two by half.
      const rows: number[][] = []
      for (let device = Math.floor((tick.y - tick.half) * s); device <= Math.ceil((tick.y + tick.half) * s); device++) rows.push(at(x * s, device))
      // A row that is another tick's own line is that tick, not what lies beside this one.
      for (const dy of [-1, 1].flatMap(sign => [1.5, 2.5].map(step => sign * (tick.half + step)))) {
        if (ticks.some(other => other !== tick && Math.abs(other.y - (tick.y + dy)) <= other.half + 1)) continue
        const card = tick.card
        if (card !== null && x >= card.left && x <= card.right && tick.y + dy >= card.top && tick.y + dy <= card.bottom) continue
        const beside = at(x * s, (tick.y + dy) * s)
        worst = Math.min(worst, Math.max(...rows.map(row => ratio(row, beside))))
      }
    }
  }
  return { worst: Math.round(worst * 100) / 100, room: Math.round(room * 100) / 100, ticks: ticks.length }
}
