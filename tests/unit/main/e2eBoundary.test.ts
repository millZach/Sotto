import { describe, expect, it } from 'vitest'

import {
  createE2EGlobalShortcuts,
  isTrustedMainE2ESender,
  resolveE2EConfiguration,
} from '../../../src/main/e2e/e2eBoundary'
import { parseWindowsAccelerator } from '../../../src/shared/accelerator'
import { E2E_CONFLICTING_HOTKEY, e2eScenarioSchema } from '../../../src/shared/e2e'

describe('development-only E2E admission', () => {
  it('rejects the boundary in packaged builds', () => {
    for (const scenario of e2eScenarioSchema.options) {
      expect(resolveE2EConfiguration(true, {
        TALKTYPE_E2E: '1',
        TALKTYPE_E2E_SCENARIO: scenario,
        TALKTYPE_E2E_USER_DATA: 'C:\\temp\\talktype-e2e',
      })).toBeNull()
    }
  })

  it.each([
    {},
    { TALKTYPE_E2E: '1' },
    { TALKTYPE_E2E: '1', TALKTYPE_E2E_SCENARIO: 'unknown', TALKTYPE_E2E_USER_DATA: 'C:\\temp\\talktype-e2e' },
    { TALKTYPE_E2E: '1', TALKTYPE_E2E_SCENARIO: 'success', TALKTYPE_E2E_USER_DATA: 'relative-path' },
  ])('rejects incomplete or invalid development input %#', (environment) => {
    expect(resolveE2EConfiguration(false, environment)).toBeNull()
  })

  it('admits a validated non-packaged profile', () => {
    expect(resolveE2EConfiguration(false, {
      TALKTYPE_E2E: '1',
      TALKTYPE_E2E_SCENARIO: 'paste-failure',
      TALKTYPE_E2E_USER_DATA: 'C:\\temp\\talktype-e2e',
    })).toEqual({ scenario: 'paste-failure', userDataPath: 'C:\\temp\\talktype-e2e' })
  })

  it('admits the deterministic processing capture only in a non-packaged app', () => {
    for (const scenario of ['design-permission', 'design-processing']) {
      expect(resolveE2EConfiguration(false, {
        TALKTYPE_E2E: '1',
        TALKTYPE_E2E_SCENARIO: scenario,
        TALKTYPE_E2E_USER_DATA: 'C:\\temp\\talktype-e2e',
      })).toEqual({ scenario, userDataPath: 'C:\\temp\\talktype-e2e' })
    }
  })

  it('accepts only the exact trusted main renderer sender', () => {
    const main = {}
    const widget = {}
    const renderers = [
      { role: 'main', webContents: main },
      { role: 'widget', webContents: widget },
    ]
    expect(isTrustedMainE2ESender(main, renderers)).toBe(true)
    expect(isTrustedMainE2ESender(widget, renderers)).toBe(false)
    expect(isTrustedMainE2ESender({}, renderers)).toBe(false)
    expect(isTrustedMainE2ESender(main, [{ role: 'widget', webContents: main }])).toBe(false)
  })

  it('preserves the registered shortcut when a friendly Windows spelling conflicts', () => {
    const shortcuts = createE2EGlobalShortcuts('hotkey-conflict')
    const previous = 'CommandOrControl+Shift+Space'
    const callback = () => undefined
    const candidate = parseWindowsAccelerator(E2E_CONFLICTING_HOTKEY)

    expect(shortcuts.register(previous, callback)).toBe(true)
    expect(candidate).toBe('CommandOrControl+Alt+9')
    expect(shortcuts.register(candidate!, callback)).toBe(false)
    expect(shortcuts.isRegistered?.(previous)).toBe(true)
  })
})
