import { describe, expect, it } from 'vitest'

import {
  DESIGN_CAPTURE_REQUIREMENTS,
  DESIGN_CAPTURE_THEME,
  DESIGN_CAPTURE_WIDGET_THEMES,
  designCaptureTupleKey,
} from '../../../scripts/design-capture-matrix.mjs'

describe('design capture matrix', () => {
  it('requires every dense surface at 100/125/150/200 in the one black theme, and the widget in both schemes', () => {
    const keys = new Set(DESIGN_CAPTURE_REQUIREMENTS.map(designCaptureTupleKey))
    for (const scalePercent of [100, 125, 150, 200]) {
      for (const state of ['onboarding-model', 'dictate-ready', 'history-populated', 'settings-full', 'help-full']) {
        expect(keys).toContain(`scale|${state}|${DESIGN_CAPTURE_THEME}|${scalePercent}|normal|none`)
      }
      for (const theme of DESIGN_CAPTURE_WIDGET_THEMES) {
        expect(keys).toContain(`scale|widget-listening|${theme}|${scalePercent}|normal|none`)
      }
    }
  })

  it('never asks the application for a light or dark capture', () => {
    for (const requirement of DESIGN_CAPTURE_REQUIREMENTS) {
      const widget = requirement.category === 'widget' || requirement.state === 'widget-listening'
      expect(requirement.theme).toBe(widget ? requirement.theme : DESIGN_CAPTURE_THEME)
      if (widget) expect(DESIGN_CAPTURE_WIDGET_THEMES).toContain(requirement.theme)
    }
  })

  it('requires normal/reduced motion contrast and five keyboard-focus targets', () => {
    const entries = DESIGN_CAPTURE_REQUIREMENTS
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'listening', motion: 'normal' }),
      expect.objectContaining({ state: 'listening-reduced-motion', motion: 'reduced' }),
    ]))
    for (const focusTarget of ['tab', 'navigation', 'input', 'switch', 'destructive']) {
      expect(entries).toContainEqual(expect.objectContaining({ focusTarget }))
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
        theme: expect.stringMatching(/^(black|light|dark)$/u),
        scalePercent: expect.any(Number),
        motion: expect.stringMatching(/^(normal|reduced)$/u),
        focusTarget: expect.stringMatching(/^(none|tab|navigation|input|switch|destructive)$/u),
        source: expect.stringMatching(/^(app-review|widget-baseline)$/u),
      })
    }
  })
})
