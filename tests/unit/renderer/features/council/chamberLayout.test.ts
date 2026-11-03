import { describe, expect, it } from 'vitest'
import { chamberLayout, figureBox } from '../../../../../src/renderer/src/features/council/chamberLayout'
import { COUNCIL_LAYOUTS } from '../../../../../src/shared/council'

/**
 * The chamber's room at the three window sizes the design is checked at: the long table over the record, as wide as the
 * room, and the half circle and round table beside it at 1600 and 1280, under the room's header and strip. At the 820 by
 * 560 minimum every layout sits over the record.
 */
const ROOMS = {
  1600: { 'long-table': [1340, 480], 'half-circle': [940, 900], 'round-table': [940, 900] },
  1280: { 'long-table': [1020, 380], 'half-circle': [620, 700], 'round-table': [620, 700] },
  820: { 'long-table': [560, 250], 'half-circle': [560, 250], 'round-table': [560, 250] },
} as const

describe.each(Object.entries(ROOMS))('the chamber at a %s-wide window', (_window, rooms) => {
  it.each(COUNCIL_LAYOUTS.flatMap(layout => [2, 3, 4, 5].map(count => [layout, count] as const)))('%s seats %i panelists inside the room, each on its own place', (layout, count) => {
    const [width, height] = rooms[layout]
    const g = chamberLayout(layout, width, height, count)
    expect(g.panelists.map(figure => figure.key)).toEqual(['A', 'B', 'C', 'D', 'E'].slice(0, count))
    expect(g.chair).toMatchObject({ key: 'chair', chair: true })
    for (const figure of [...g.panelists, g.chair]) {
      const box = figureBox(figure)
      // Every head is in the room, and nearly every figure; the round table's near side shows its backs cut by the frame.
      const head = { x: figure.x, y: figure.y - 80 * figure.s }
      expect(head.x).toBeGreaterThan(0); expect(head.x).toBeLessThan(width)
      expect(head.y).toBeGreaterThan(0); expect(head.y).toBeLessThan(height)
      const shown = (Math.min(width, box.x + box.w) - Math.max(0, box.x)) * (Math.min(height, box.y + box.h) - Math.max(0, box.y))
      expect(shown / (box.w * box.h)).toBeGreaterThan(figure.back ? 0.5 : 0.85)
      expect(figure.s).toBeGreaterThanOrEqual(0.5)
    }
    // No two figures stand in each other's place.
    const all = [...g.panelists, g.chair]
    for (const one of all) for (const other of all) if (one !== other) expect(Math.hypot(one.x - other.x, one.y - other.y)).toBeGreaterThan(40 * Math.min(one.s, other.s))
  })
})

describe('where the chair sits', () => {
  it('raises the chair at the long table’s centre, with the panelists alternating either side by letter', () => {
    const g = chamberLayout('long-table', 1200, 420, 4)
    expect(g.chair.x).toBe(600)
    expect(g.chair.s).toBeGreaterThan(g.panelists[0]!.s)
    const [a, b, c, d] = g.panelists
    expect(a!.x).toBeLessThan(600); expect(b!.x).toBeGreaterThan(600)
    expect(c!.x).toBeLessThan(a!.x); expect(d!.x).toBeGreaterThan(b!.x)
  })

  it('puts the chair at the back of the half circle, drawn first', () => {
    const g = chamberLayout('half-circle', 900, 700, 3)
    expect(g.chair.depth).toBe(1)
    expect(g.panelists.every(figure => figure.depth < 1 && figure.y > g.chair.y)).toBe(true)
  })

  it('raises the chair at the round table’s far side and turns the near side’s backs to the user', () => {
    const g = chamberLayout('round-table', 900, 700, 3)
    expect(g.chair.back).toBe(false)
    expect(g.chair.y).toBeLessThan(Math.min(...g.panelists.map(figure => figure.y)))
    expect(g.panelists.filter(figure => figure.back).map(figure => figure.key)).toEqual(['B'])
  })

  it.each([2, 3, 4, 5])('never hides one of %i panelists behind the round table: the near half sits with its back to the user', count => {
    const g = chamberLayout('round-table', 900, 700, count)
    if (g.layout !== 'round-table') throw new Error('not a round table')
    for (const figure of g.panelists) expect(figure.back || figure.y <= g.cy + 8 * figure.s).toBe(true)
  })
})
