import { describe, expect, it } from 'vitest'
import { OWL_EASEL_TILE_ROWS, owlEaselFrame, owlEaselProgress } from '../../../src/renderer/src/agents/owlEasel'

const painted = (text: string): number => text.replace(/[\s\n]/gu, '').length

describe('the owl at the easel (ADR-0170)', () => {
  it('draws two layers the same size as the tile\'s grid', () => {
    const frame = owlEaselFrame(35, OWL_EASEL_TILE_ROWS, 0.5, 1)
    for (const layer of [frame.paint, frame.sketch]) {
      const lines = layer.split('\n')
      expect(lines).toHaveLength(OWL_EASEL_TILE_ROWS)
      expect(new Set(lines.map(line => line.length))).toEqual(new Set([35]))
    }
  })

  it('paints more of the picture as it goes, and the owl stands by the easel with its eyes open while still', () => {
    expect(painted(owlEaselFrame(35, 14, 0, 0).paint)).toBe(0)
    expect(painted(owlEaselFrame(35, 14, 0.3, 0).paint)).toBeLessThan(painted(owlEaselFrame(35, 14, 0.9, 0).paint))
    const still = owlEaselFrame(35, 14, 0.5, 0).sketch
    expect(still).toContain('(OvO)')
    expect(still).toContain('+---')
    expect(owlEaselFrame(35, 14, 0.5, 3.3).sketch).toContain('(-v-)')
  })

  it('slows as it goes and never finishes on its own: the picture landing ends it', () => {
    const at = [0, 5, 15, 30, 120, 6000].map(seconds => owlEaselProgress(seconds))
    expect(at[0]).toBe(0)
    for (let index = 1; index < at.length; index += 1) expect(at[index]).toBeGreaterThanOrEqual(at[index - 1]!)
    expect(Math.max(...at)).toBeLessThan(1)
  })
})
