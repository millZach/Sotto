// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { registerLocalAppsIpc, registerPhonesIpc } from '../../../src/main/phones/ipc'

import { PHONES_COMMAND, PHONES_GET, type PhonesState } from '../../../src/shared/phones'
import { LOCAL_APPS_GET, type LocalAppsState } from '../../../src/shared/localApps'
import { ipcRegistry } from '../../fixtures/ipcHarness'

function harness() {
  const registry = ipcRegistry({ mainUrl: 'app://sotto/index.html', widgetUrl: 'app://sotto/widget.html' })
  const { ipc, handlers, mainEvent: main, widgetEvent: widget } = registry
  const trusted = registry.trustedSenders()
  return { ipc, handlers, main, widget, trusted }
}

it('answers the Phones page in the main window only, and parses every command', async () => {
  const { ipc, handlers, main, widget, trusted } = harness()
  const state = { phase: 'on', code: { code: 'K7MX3QPD', expiresAt: '2026-09-26T12:05:00.000Z' } } as unknown as PhonesState
  const phones = { get: vi.fn(() => state), command: vi.fn(async () => state), subscribe: vi.fn(() => () => undefined) }
  const cleanup = registerPhonesIpc(ipc, phones, () => trusted, () => undefined)
  expect(handlers.get(PHONES_GET)!(main)).toBe(state)
  expect(() => handlers.get(PHONES_GET)!(widget)).toThrow('Open Phones in the main Sotto window.')
  expect(() => handlers.get(PHONES_COMMAND)!(widget, { type: 'show-code' })).toThrow('Open Phones in the main Sotto window.')
  await handlers.get(PHONES_COMMAND)!(main, { type: 'show-code' })
  expect(phones.command).toHaveBeenCalledWith({ type: 'show-code' })
  // Pairing lets a phone answer, so the window has no Can answer to send.
  expect(() => handlers.get(PHONES_COMMAND)!(main, { type: 'set-can-answer', clientId: 'phone', allowed: true })).toThrow()
  expect(() => handlers.get(PHONES_COMMAND)!(main, { type: 'open-url', url: 'https://example.com' })).toThrow()
  cleanup()
  expect(handlers.size).toBe(0)
})

it('answers Let apps on this computer connect in the main window only, and publishes each change (ADR-0180)', () => {
  const { ipc, handlers, main, widget, trusted } = harness()
  const state: LocalAppsState = { phase: 'on', localHostRunning: true }
  let told: ((next: LocalAppsState) => void) | undefined
  const localApps = { get: vi.fn(() => state), subscribe: vi.fn((listener: (next: LocalAppsState) => void) => { told = listener; return () => { told = undefined } }) }
  const publish = vi.fn()
  const cleanup = registerLocalAppsIpc(ipc, localApps, () => trusted, publish)
  expect(handlers.get(LOCAL_APPS_GET)!(main)).toBe(state)
  expect(() => handlers.get(LOCAL_APPS_GET)!(widget)).toThrow('Open Settings in the main Sotto window.')
  expect(() => handlers.get(LOCAL_APPS_GET)!(main, 'extra')).toThrow()
  told!({ phase: 'failed', localHostRunning: true })
  expect(publish).toHaveBeenCalledWith({ phase: 'failed', localHostRunning: true })
  cleanup()
  expect(handlers.size).toBe(0)
  expect(told).toBeUndefined()
})
