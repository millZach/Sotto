import { expect, type Locator } from '@playwright/test'

export interface PaintedBounds { left: number; right: number; top: number; bottom: number; frames: number; mirrored: number; outermost: string[] }

/**
 * What the creature paints, not its fixed 80 x 64 box: every shape under the facing group (the svg's first `g`, which carries
 * the mirror and every prop), relative to the svg's rect. Sampled once per painted frame for `ms`; the extremes win.
 */
export function paintedBounds(monitor: Locator, ms: number, displace?: string): Promise<PaintedBounds> {
  return monitor.evaluate(async (element, { ms, displace }) => {
    const svg = element.querySelector('svg.thread-monitor__creature')!
    const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity, frames: 0, mirrored: 0, outermost: [] as string[] }
    const sample = (): void => {
      const facing = svg.querySelector('g')!
      const box = svg.getBoundingClientRect()
      // The union of the shapes that paint, each with every transform above it (the mirror included). Not the group's own
      // rect: an empty placeholder path (`M0 0h0v0z`) paints nothing yet still stretches it to its transformed origin.
      const extent = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
      for (const shape of facing.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line')) {
        const r = shape.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        const at = { left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top }
        extent.left = Math.min(extent.left, at.left)
        extent.right = Math.max(extent.right, at.right)
        extent.top = Math.min(extent.top, at.top)
        extent.bottom = Math.max(extent.bottom, at.bottom)
        // Name the shapes that leave the box, with the transforms that put them there, so a failure says what to fix.
        if (at.left < -1 || at.right > 81 || at.top < -1 || at.bottom > 65) {
          const chain: string[] = []
          for (let node: Element | null = shape; node && node !== svg; node = node.parentElement) chain.push(node.getAttribute('transform') ?? '')
          const note = `${shape.getAttribute('class')} d=${shape.getAttribute('d')} transforms=${chain.join('|')}`
          if (!bounds.outermost.includes(note) && bounds.outermost.length < 6) bounds.outermost.push(note)
        }
      }
      bounds.left = Math.min(bounds.left, extent.left)
      bounds.right = Math.max(bounds.right, extent.right)
      bounds.top = Math.min(bounds.top, extent.top)
      bounds.bottom = Math.max(bounds.bottom, extent.bottom)
      bounds.frames++
      if ((facing.getAttribute('transform') ?? '').includes('scale(-1')) bounds.mirrored++
    }
    if (displace === undefined) sample()
    else {
      // Proof the check bites: the displacement is applied, measured and undone inside one task, before the frame loop can
      // repaint the facing group. Reduced motion's global one-millisecond transition would hold the old transform for that
      // task, so the group's transition is off while it is measured.
      const facing = svg.querySelector('g')!
      const original = facing.getAttribute('transform')
      facing.style.transition = 'none'
      facing.setAttribute('transform', displace)
      sample()
      if (original === null) facing.removeAttribute('transform')
      else facing.setAttribute('transform', original)
      facing.getBoundingClientRect()
      facing.style.removeProperty('transition')
    }
    const began = performance.now()
    await new Promise<void>(resolve => {
      const next = (): void => {
        sample()
        if (performance.now() - began < ms) requestAnimationFrame(next)
        else resolve()
      }
      if (ms > 0) requestAnimationFrame(next)
      else resolve()
    })
    return bounds
  }, { ms, displace })
}

/** Every sampled frame of the drawing stays inside the creature's 80 x 64 CSS-pixel box. */
export async function expectPaintedInside(monitor: Locator, ms = 0): Promise<PaintedBounds> {
  const bounds = await paintedBounds(monitor, ms)
  const detail = JSON.stringify(bounds)
  expect(bounds.left, detail).toBeGreaterThanOrEqual(-1)
  expect(bounds.right, detail).toBeLessThanOrEqual(81)
  expect(bounds.top, detail).toBeGreaterThanOrEqual(-1)
  expect(bounds.bottom, detail).toBeLessThanOrEqual(65)
  return bounds
}
