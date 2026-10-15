// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { WATCHER_OPEN, WATCHER_SET_LIMIT, WATCHER_SET_PERMISSION, WATCHER_WATCH_THREAD, WATCHER_UNWATCH_THREAD } from '../../../src/shared/watcherRoom'

it('offers the private Watcher bridge only behind the main renderer gate and validates inputs and results', async () => {
  const ipc = preloadElectron().ipcRenderer
  expect(createSottoBridge(ipc, 'win32').watcher).toBeUndefined()
  expect('watcher' in createSottoWidgetBridge(ipc, 'win32')).toBe(false)
  const bridge = createSottoBridge(ipc, 'win32', false, true).watcher!
  const refused = { status: 'refused', code: 'THREAD_BUSY', message: 'Wait for Watcher.', retryable: true }
  ipc.invoke.mockResolvedValue(refused)
  await expect(bridge.open({ provider: 'codex', modelId: 'model', reasoningEffort: 'low' })).resolves.toEqual(refused)
  expect(ipc.invoke).toHaveBeenLastCalledWith(WATCHER_OPEN, { provider: 'codex', modelId: 'model', reasoningEffort: 'low' })
  await bridge.setLimit({ limit: 2 })
  expect(ipc.invoke).toHaveBeenLastCalledWith(WATCHER_SET_LIMIT, { limit: 2 })
  expect(() => bridge.setLimit({ limit: 9 })).toThrow()
  await bridge.setPermission!({ runtimeMode: 'full-access' })
  expect(ipc.invoke).toHaveBeenLastCalledWith(WATCHER_SET_PERMISSION, { runtimeMode: 'full-access' })
  expect(() => bridge.setPermission!({ runtimeMode: 'always' as 'full-access' })).toThrow()
  const target = { hostId: randomUUID(), threadId: 'worker' }
  await bridge.watchThread!({ target })
  expect(ipc.invoke).toHaveBeenLastCalledWith(WATCHER_WATCH_THREAD, { target })
  await bridge.unwatchThread!({ target })
  expect(ipc.invoke).toHaveBeenLastCalledWith(WATCHER_UNWATCH_THREAD, { target })
  expect(() => bridge.open({ provider: 'devin', modelId: 'model' } as never)).toThrow()
  expect(() => bridge.stopAll({ confirmationId: randomUUID(), approved: true } as never)).toThrow()
  ipc.invoke.mockResolvedValue({ status: 'ok' })
  await expect(bridge.get()).rejects.toThrow()
})
