import { describe, expect, it } from 'vitest'

import {
  DESIGN_CAPTURE_ACCENTS,
  DESIGN_CAPTURE_APP_THEMES,
  DESIGN_CAPTURE_MINIMUM_WIDTH,
  DESIGN_CAPTURE_REQUIREMENTS,
  DESIGN_CAPTURE_THEME,
  DESIGN_CAPTURE_WIDGET_THEMES,
  designCaptureTupleKey,
} from '../../../scripts/design-capture-matrix.mjs'
import { ACCENTS } from '../../../src/shared/settings'

describe('design capture matrix', () => {
  it('requires every dense surface at 100/125/150/200 in the dark default, dictate and settings in light, and the widget in both schemes', () => {
    const keys = new Set(DESIGN_CAPTURE_REQUIREMENTS.map(designCaptureTupleKey))
    expect(DESIGN_CAPTURE_THEME).toBe('dark')
    for (const scalePercent of [100, 125, 150, 200]) {
      for (const state of ['onboarding-model', 'dictate-ready', 'history-populated', 'settings-full', 'help-full']) {
        expect(keys).toContain(`scale|${state}|${DESIGN_CAPTURE_THEME}|${scalePercent}|normal|none`)
      }
      for (const state of ['dictate-ready', 'settings-full']) {
        expect(keys).toContain(`scale|${state}|light|${scalePercent}|normal|none`)
      }
      for (const theme of DESIGN_CAPTURE_WIDGET_THEMES) {
        expect(keys).toContain(`scale|widget-listening|${theme}|${scalePercent}|normal|none`)
      }
    }
  })

  it('gives the application only its resolved dark or light room, and the widget only the emulated system scheme', () => {
    expect([...DESIGN_CAPTURE_APP_THEMES]).toEqual(['dark', 'light'])
    for (const requirement of DESIGN_CAPTURE_REQUIREMENTS) {
      const widget = requirement.category === 'widget' || requirement.state === 'widget-listening'
      if (widget) expect(DESIGN_CAPTURE_WIDGET_THEMES).toContain(requirement.theme)
      else expect(DESIGN_CAPTURE_APP_THEMES).toContain(requirement.theme)
    }
  })

  it('repeats each surface family, focus target, reduced motion and the Appearance section in the light room', () => {
    const keys = new Set(DESIGN_CAPTURE_REQUIREMENTS.map(designCaptureTupleKey))
    for (const [category, state] of [
      ['onboarding', 'openrouter-key'], ['dictate', 'ready'], ['dictate', 'listening'], ['dictate', 'error'], ['agents', 'overview'],
      ['history', 'populated-feedback'], ['settings', 'providers'], ['settings', 'capture'], ['settings', 'validation-error'],
      ['settings', 'appearance'], ['help', 'overview'],
    ]) expect(keys, `${category} ${state}`).toContain(`${category}|${state}|light|100|normal|none`)
    expect(keys).toContain('settings|appearance|dark|100|normal|none')
    expect(keys).toContain('dictate|listening-reduced-motion|light|100|reduced|none')
    for (const focusTarget of ['tab', 'navigation', 'input', 'switch', 'destructive']) {
      expect(DESIGN_CAPTURE_REQUIREMENTS.filter(requirement => requirement.focusTarget === focusTarget).map(requirement => requirement.theme).sort()).toEqual(['dark', 'light'])
    }
  })

  it('captures every accent the settings offer in both rooms, System in both rooms, and the minimum width in both rooms', () => {
    expect([...DESIGN_CAPTURE_ACCENTS]).toEqual([...ACCENTS])
    const keys = new Set(DESIGN_CAPTURE_REQUIREMENTS.map(designCaptureTupleKey))
    for (const theme of ['dark', 'light']) {
      // Teal is the default every other application tuple already shows.
      for (const accent of ACCENTS.filter(candidate => candidate !== 'teal')) expect(keys).toContain(`appearance|accent-${accent}|${theme}|100|normal|none`)
      expect(keys).toContain(`appearance|system-settings|${theme}|100|normal|none`)
      for (const state of ['dictate-ready', 'agents-overview', 'settings-full']) expect(keys).toContain(`width|${state}-${DESIGN_CAPTURE_MINIMUM_WIDTH}|${theme}|100|normal|none`)
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
        category: expect.stringMatching(/^(onboarding|dictate|agents|history|settings|help|threads|scale|widget|appearance|width)$/u),
        state: expect.any(String),
        theme: expect.stringMatching(/^(light|dark)$/u),
        scalePercent: expect.any(Number),
        motion: expect.stringMatching(/^(normal|reduced)$/u),
        focusTarget: expect.stringMatching(/^(none|tab|navigation|input|switch|destructive)$/u),
        source: expect.stringMatching(/^(app-review|widget-baseline)$/u),
      })
    }
  })
})
