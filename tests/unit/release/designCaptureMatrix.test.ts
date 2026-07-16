import { describe, expect, it } from 'vitest'

import { DESIGN_CAPTURE_REQUIREMENTS, designCaptureTupleKey } from '../../../scripts/design-capture-matrix.mjs'

describe('design capture matrix', () => {
  it('requires every dense surface at 100/125/150/200 in both themes', () => {
    const keys = new Set(DESIGN_CAPTURE_REQUIREMENTS.map(designCaptureTupleKey))
    for (const theme of ['light', 'dark']) {
      for (const scalePercent of [100, 125, 150, 200]) {
        for (const [category, state] of [
          ['scale', 'onboarding-model'],
          ['scale', 'home-ready'],
          ['scale', 'history-populated'],
          ['scale', 'settings-full'],
          ['scale', 'help-full'],
          ['scale', 'widget-listening'],
        ]) {
          expect(keys).toContain(`${category}|${state}|${theme}|${scalePercent}|normal|none`)
        }
      }
    }
  })

  it('requires normal/reduced motion contrast and four keyboard-focus targets per theme', () => {
    const entries = DESIGN_CAPTURE_REQUIREMENTS
    for (const theme of ['light', 'dark']) {
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ theme, state: 'listening', motion: 'normal' }),
        expect.objectContaining({ theme, state: 'listening-reduced-motion', motion: 'reduced' }),
      ]))
      for (const focusTarget of ['navigation', 'input', 'switch', 'destructive']) {
        expect(entries).toContainEqual(expect.objectContaining({ theme, focusTarget }))
      }
    }
  })

  it('contains unique explicit tuples with no optional presentation metadata', () => {
    const keys = DESIGN_CAPTURE_REQUIREMENTS.map(designCaptureTupleKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const requirement of DESIGN_CAPTURE_REQUIREMENTS) {
      expect(requirement).toMatchObject({
        id: expect.any(String),
        category: expect.any(String),
        state: expect.any(String),
        theme: expect.stringMatching(/^(light|dark)$/u),
        scalePercent: expect.any(Number),
        motion: expect.stringMatching(/^(normal|reduced)$/u),
        focusTarget: expect.stringMatching(/^(none|navigation|input|switch|destructive)$/u),
        source: expect.stringMatching(/^(app-review|widget-baseline)$/u),
      })
    }
  })
})
