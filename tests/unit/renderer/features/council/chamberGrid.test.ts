import { describe, expect, it } from 'vitest'
import { bubbleShape, drawBubble, GlyphGrid, overlaps, placeBubble, wrapWords, type CellRect } from '../../../../../src/renderer/src/features/council/chamberGrid'
import { chamberLayout } from '../../../../../src/renderer/src/features/council/chamberLayout'

describe('bubbles find room', () => {
  it('moves a second speaker’s bubble clear of the first, side by side', () => {
    const taken: CellRect[] = []
    const first = placeBubble(40, 20, 24, 5, 'up', 120, 40, taken)
    taken.push(first)
    const second = placeBubble(44, 20, 24, 5, 'up', 120, 40, taken)
    expect(overlaps(first, second)).toBe(false)
  })

  it('keeps every speaker of a full long table clear of each other and of the plates', () => {
    const g = chamberLayout('long-table', 1020, 380, 5)
    const cols = Math.floor(1020 / 7), rows = Math.floor(380 / 12)
    const taken: CellRect[] = [...g.panelists, g.chair].map(figure => ({ l: Math.round(figure.plate.x / 7) - 8, t: Math.round(figure.plate.y / 12), w: 16, h: 3 }))
    const plates = taken.length
    for (const figure of [...g.panelists, g.chair]) {
      const shape = bubbleShape('After 0.2, behind a reader that reads both formats, and import each thread when it opens.', 'Opus 5.5', true, figure.maxCols, '')
      taken.push(placeBubble(Math.round(figure.bubble.x / 7), Math.round(figure.bubble.y / 12), shape.w, shape.h, figure.bubble.side, cols, rows, taken))
    }
    const bubbles = taken.slice(plates)
    for (const box of bubbles) {
      expect(box.l).toBeGreaterThanOrEqual(0); expect(box.l + box.w).toBeLessThanOrEqual(cols)
      expect(box.t).toBeGreaterThanOrEqual(0); expect(box.t + box.h).toBeLessThanOrEqual(rows)
    }
    // Six speakers at once on a 1280 window's table, the chair's high bubble last: each finds a place of its own.
    bubbles.forEach((box, k) => taken.forEach((other, j) => { if (j !== plates + k) expect(overlaps(box, other)).toBe(false) }))
  })

  it('stays inside the grid when there is no clear place at all', () => {
    const taken = [{ l: 0, t: 0, w: 30, h: 12 }]
    const box = placeBubble(10, 6, 20, 5, 'up', 30, 12, taken)
    expect(box.l).toBeGreaterThanOrEqual(0); expect(box.l + box.w).toBeLessThanOrEqual(30)
    expect(box.t).toBeGreaterThanOrEqual(0); expect(box.t + box.h).toBeLessThanOrEqual(12)
  })
})

describe('what a bubble holds', () => {
  it('breaks a path longer than a line across lines rather than past the edge', () => {
    const lines = wrapWords('Read src/renderer/src/features/council/CouncilChamber.tsx', 20)
    expect(lines.every(line => line.length <= 20)).toBe(true)
    expect(lines.join('')).toBe('Readsrc/renderer/src/features/council/CouncilChamber.tsx'.replace('Read', 'Read '))
  })

  it('keeps a speech bubble’s newest three lines and a thought’s first two, with its title on the edge', () => {
    const say = bubbleShape('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 'Opus 5.5', true, 18, '')
    expect(say.lines.length).toBe(3)
    expect(say.lines.at(-1)).toContain('sixteen')
    const think = bubbleShape('Reading src/renderer/src/features/council/CouncilChamber.tsx and its tests', 'Grok 4.7', false, 18, '...')
    expect(think.lines.length).toBeLessThanOrEqual(2)
    const grid = new GlyphGrid(40, 10)
    drawBubble(grid, { l: 2, t: 1, w: say.w, h: say.h }, say, true, { c: 8, r: 8 })
    expect(String.fromCharCode(grid.code[1 * 40 + 2]!)).toBe('╭')
    const top = Array.from({ length: say.w }, (_, c) => String.fromCharCode(grid.code[1 * 40 + 2 + c]!)).join('')
    expect(top).toContain('Opus 5.5')
  })
})
