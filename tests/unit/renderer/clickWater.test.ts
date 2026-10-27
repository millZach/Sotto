import { describe, expect, it } from 'vitest'

import { ClickWater, GLYPH_ALPHA, LIFE_S, STEP_HZ } from '../../../src/renderer/src/components/clickWater'

/** A seeded stand-in for Math.random, so the water is the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function stamps(water: ClickWater): Array<{ digit: 0 | 1; x: number; y: number; alpha: number }> {
  const out: Array<{ digit: 0 | 1; x: number; y: number; alpha: number }> = []
  water.draw((digit, x, y, alpha) => out.push({ digit, x, y, alpha }))
  return out
}

const steps = (water: ClickWater, seconds: number): void => { for (let n = 0; n < seconds * STEP_HZ; n++) water.step() }

describe('the click effect water', () => {
  it('is calm and draws nothing until a press', () => {
    const water = new ClickWater(800, 600, seeded(1))
    expect(water.calm).toBe(true)
    steps(water, 0.5)
    expect(stamps(water)).toEqual([])
  })

  it('a press sends waves out from the pointer, drawn as 0s and 1s no stronger than the cap', () => {
    const water = new ClickWater(800, 600, seeded(2))
    water.press(400, 300)
    expect(water.calm).toBe(false)
    expect(water.heightAt(400, 300)).not.toBe(0)
    expect(water.heightAt(400, 450)).toBe(0)
    steps(water, 0.6)
    // The waves have reached well past the drops, which land within 58 px of the press.
    const drawn = stamps(water)
    expect(drawn.length).toBeGreaterThan(50)
    expect(Math.max(...drawn.map(glyph => Math.hypot(glyph.x - 400, glyph.y - 300)))).toBeGreaterThan(100)
    expect(drawn.every(glyph => glyph.digit === 0 || glyph.digit === 1)).toBe(true)
    expect(Math.max(...drawn.map(glyph => glyph.alpha))).toBeLessThanOrEqual(GLYPH_ALPHA)
  })

  it('dies away on its own, and then draws nothing', () => {
    const water = new ClickWater(800, 600, seeded(3))
    water.press(200, 150)
    steps(water, 1)
    expect(water.calm).toBe(false)
    let seconds = 1
    while (!water.calm && seconds < LIFE_S * 3) { steps(water, 0.5); seconds += 0.5 }
    expect(water.calm).toBe(true)
    expect(stamps(water)).toEqual([])
  })

  it('keeps the same work per step however many presses land, and keeps its waves inside the window', () => {
    const water = new ClickWater(640, 400, seeded(4))
    for (let n = 0; n < 40; n++) water.press((n * 97) % 640, (n * 53) % 400)
    // Presses on the very edge and outside the window only reach the water inside it.
    water.press(0, 0)
    water.press(-50, 900)
    steps(water, 0.5)
    const drawn = stamps(water)
    expect(drawn.length).toBeLessThanOrEqual(Math.ceil(640 / 7) * Math.ceil(400 / 13))
    expect(drawn.every(glyph => Number.isFinite(glyph.x) && Number.isFinite(glyph.y) && Number.isFinite(glyph.alpha))).toBe(true)
  })

  it('stills at once when cleared', () => {
    const water = new ClickWater(400, 300, seeded(5))
    water.press(100, 100)
    steps(water, 0.3)
    water.clear()
    expect(water.calm).toBe(true)
    expect(stamps(water)).toEqual([])
  })
})
