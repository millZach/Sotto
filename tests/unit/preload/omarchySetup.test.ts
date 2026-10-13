// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { OMARCHY_SETUP_GET, OMARCHY_SETUP_COMMAND } from '../../../src/shared/omarchySetup'
import { setupState } from '../../fixtures/renderer/omarchySetup'

it('exposes setup only to Linux main and validates both sides of the bridge', async () => {
  const ipc = preloadElectron().ipcRenderer
  for (const platform of ['win32', 'darwin'] as const) {
    expect(createSottoBridge(ipc, platform).omarchySetup).toBeUndefined()
  }
  expect('omarchySetup' in createSottoWidgetBridge(ipc, 'linux')).toBe(false)
  const bridge = createSottoBridge(ipc, 'linux').omarchySetup!
  ipc.invoke.mockResolvedValue(setupState())
  await bridge.get()
  expect(ipc.invoke).toHaveBeenLastCalledWith(OMARCHY_SETUP_GET)
  const command = { type: 'setup' as const, pieces: ['keys' as const], keys: 'give' as const }
  await bridge.command(command)
  expect(ipc.invoke).toHaveBeenLastCalledWith(OMARCHY_SETUP_COMMAND, command)
  expect(() => bridge.command({ ...command, approved: true } as never)).toThrow()
  ipc.invoke.mockResolvedValue({ arbitrary: true })
  await expect(bridge.get()).rejects.toThrow()
})
