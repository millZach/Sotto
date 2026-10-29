import { describe, expect, it } from 'vitest'
import { LARDO_FRAMES, LARDO_LETTERS, LARDO_MINI_ROWS, lardoPaths, type LardoFrame } from '../../../src/renderer/src/agents/lardoSprite'

const frames = Object.keys(LARDO_FRAMES) as LardoFrame[]

describe('Lardo sprite', () => {
  it.each(frames)('%s fills the creature grid with letters the stylesheet colours', frame => {
    const rows = LARDO_FRAMES[frame]
    expect(rows).toHaveLength(32)
    for (const row of rows) {
      expect(row).toHaveLength(40)
      expect(row).toMatch(new RegExp(`^[.${LARDO_LETTERS.join('')}]+$`, 'u'))
    }
  })

  it.each(frames)('%s stands on the floor, so a pose swaps without him hopping', frame => {
    const rows = LARDO_FRAMES[frame]
    expect(rows[31]).toMatch(/[^.]/u)
    // His feet are outlined in ink on the floor row, and no frame draws below it.
    expect(rows[31]).toContain('k')
  })

  it('wears posing trunks in every frame', () => {
    for (const frame of frames) expect(LARDO_FRAMES[frame].join('')).toContain('t')
  })

  it('flushes only in his tantrum', () => {
    const tantrum = new Set<LardoFrame>(['rip', 'lift', 'hurl', 'mostMuscularAngry'])
    for (const frame of frames) expect(LARDO_FRAMES[frame].join('').includes('r'), frame).toBe(tantrum.has(frame))
  })

  it('builds one path per letter, and an empty one for a letter a frame does not use', () => {
    const paths = lardoPaths('frontDoubleBiceps')
    expect(Object.keys(paths).sort()).toEqual([...LARDO_LETTERS].sort())
    expect(paths.s).toMatch(/^M\d/u)
    expect(paths.r).toBe('M0 0h0v0z')
    expect(lardoPaths('frontDoubleBiceps')).toBe(paths)
  })

  it('draws the small Lardo on a 12 × 10 grid in two steps', () => {
    expect(LARDO_MINI_ROWS).toHaveLength(2)
    for (const rows of LARDO_MINI_ROWS) {
      expect(rows).toHaveLength(10)
      for (const row of rows) expect(row).toMatch(/^[.kst]{12}$/u)
    }
  })
})
