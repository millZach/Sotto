// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import {
  createE2EGlobalShortcuts,
  failE2EOnUncaughtException,
  isTrustedMainE2ESender,
  resolveE2EConfiguration,
} from '../../../src/main/e2e/e2eBoundary'
import { parseAccelerator } from '../../../src/shared/accelerator'
import { E2E_CONFLICTING_HOTKEY, E2E_UNCAUGHT_EXIT_CODE, e2eScenarioSchema } from '../../../src/shared/e2e'

const e2eUserData = process.platform === 'win32' ? 'C:\\temp\\sotto-e2e' : '/tmp/sotto-e2e'

describe('development-only E2E admission', () => {
  it('rejects the boundary in packaged builds', () => {
    for (const scenario of e2eScenarioSchema.options) {
      expect(resolveE2EConfiguration(true, {
        SOTTO_E2E: '1',
        SOTTO_E2E_SCENARIO: scenario,
        SOTTO_E2E_USER_DATA: e2eUserData,
      })).toBeNull()
    }
  })

  it.each([
    {},
    { SOTTO_E2E: '1' },
    { SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'unknown', SOTTO_E2E_USER_DATA: 'C:\\temp\\sotto-e2e' },
    { SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: 'success', SOTTO_E2E_USER_DATA: 'relative-path' },
  ])('rejects incomplete or invalid development input %#', (environment) => {
    expect(resolveE2EConfiguration(false, environment)).toBeNull()
  })

  it('admits a validated non-packaged profile', () => {
    expect(resolveE2EConfiguration(false, {
      SOTTO_E2E: '1',
      SOTTO_E2E_SCENARIO: 'paste-failure',
      SOTTO_E2E_USER_DATA: e2eUserData,
    })).toEqual({ scenario: 'paste-failure', userDataPath: e2eUserData })
  })

  it('admits the deterministic processing capture only in a non-packaged app', () => {
    for (const scenario of ['design-permission', 'design-processing']) {
      expect(resolveE2EConfiguration(false, {
        SOTTO_E2E: '1',
        SOTTO_E2E_SCENARIO: scenario,
        SOTTO_E2E_USER_DATA: e2eUserData,
      })).toEqual({ scenario, userDataPath: e2eUserData })
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
    const candidate = parseAccelerator(E2E_CONFLICTING_HOTKEY, 'win32')

    expect(shortcuts.register(previous, callback)).toBe(true)
    expect(candidate).toBe('CommandOrControl+Alt+9')
    expect(shortcuts.register(candidate!, callback)).toBe(false)
    expect(shortcuts.isRegistered?.(previous)).toBe(true)
  })

  it('treats one chord in any order or spelling as one shortcut, like Electron', () => {
    const shortcuts = createE2EGlobalShortcuts('hotkey-conflict')
    const callback = vi.fn()
    expect(shortcuts.register('Shift+CommandOrControl+Space', callback)).toBe(true)
    expect(shortcuts.register('CommandOrControl+Shift+Space', callback)).toBe(false)
    expect(shortcuts.trigger('ctrl+space+shift')).toBe(true)
    expect(shortcuts.register('Alt+Ctrl+9', callback)).toBe(false)
    shortcuts.unregister('Space+Shift+CommandOrControl')
    expect(shortcuts.isRegistered?.('CommandOrControl+Shift+Space')).toBe(false)
  })
})

describe('an uncaught exception in an e2e-launched main (#1577)', () => {
  it('writes where the error was thrown to stderr and exits, so no native box is shown', () => {
    const listeners: ((error: unknown) => void)[] = []
    const written: string[] = []
    const exits: number[] = []
    failE2EOnUncaughtException({ on: (_event, listener) => listeners.push(listener) }, text => written.push(text), code => exits.push(code))
    expect(listeners).toHaveLength(1)
    const error = new TypeError('Object has been destroyed')
    error.stack = 'TypeError: Object has been destroyed\n    at Timeout.eval [as _onTimeout] (eval at evaluate (:303:30), <anonymous>:9:42)\n    at listOnTimeout (node:internal/timers:685:17)'
    listeners[0]!(error)
    expect(written.join('')).toBe('[Sotto] e2e-uncaught-exception TypeError\n  at Timeout.eval [as _onTimeout] (eval at evaluate (:303:30), <anonymous>:9:42)\n  at listOnTimeout (node:internal/timers:685:17)\n')
    expect(exits).toEqual([E2E_UNCAUGHT_EXIT_CODE])
  })

  it('never writes what the error says, which can carry what a thread said', () => {
    const listeners: ((error: unknown) => void)[] = []
    const written: string[] = []
    failE2EOnUncaughtException({ on: (_event, listener) => listeners.push(listener) }, text => written.push(text), () => undefined)
    listeners[0]!(new Error('the words of a private prompt'))
    listeners[0]!('the words of a private prompt')
    expect(written.join('')).not.toContain('private prompt')
    expect(written[1]).toBe('[Sotto] e2e-uncaught-exception string\n')
  })

  it('still exits when writing the error fails', () => {
    const listeners: ((error: unknown) => void)[] = []
    const exits: number[] = []
    failE2EOnUncaughtException({ on: (_event, listener) => listeners.push(listener) }, () => { throw new Error('stderr closed') }, code => exits.push(code))
    expect(() => listeners[0]!('thrown text')).toThrow('stderr closed')
    expect(exits).toEqual([E2E_UNCAUGHT_EXIT_CODE])
  })
})
