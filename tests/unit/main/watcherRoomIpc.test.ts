// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createIpcHarness } from '../../fixtures/ipcHarness'
import { registerIpc } from '../../../src/main/ipc/registerIpc'
import { WATCHER_GET, WATCHER_OPEN, WATCHER_PREPARE_STOP_ALL, WATCHER_STOP_ALL, WATCHER_SET_LIMIT, WATCHER_SET_PERMISSION, WATCHER_WATCH_THREAD, WATCHER_UNWATCH_THREAD } from '../../../src/shared/watcherRoom'

it('registers no Watcher channels in stable and allows only the trusted main sender when enabled', async () => {
  const f = createIpcHarness(), channels = [WATCHER_GET, WATCHER_OPEN, WATCHER_PREPARE_STOP_ALL, WATCHER_STOP_ALL, WATCHER_SET_LIMIT, WATCHER_SET_PERMISSION, WATCHER_WATCH_THREAD, WATCHER_UNWATCH_THREAD]
  expect(channels.every(channel => !f.ipc.handlers.has(channel))).toBe(true)
  f.cleanup()
  const refused = { status: 'refused' as const, code: 'NOT_CURRENT_WATCHER' as const, message: 'Open Watcher.', retryable: false }
  const watcher = { get: vi.fn(async () => refused), open: vi.fn(async () => refused), prepareStopAll: vi.fn(async () => refused), stopAll: vi.fn(async () => refused), setLimit: vi.fn(async () => refused), setPermission: vi.fn(async () => refused), watchThread: vi.fn(async () => refused), unwatchThread: vi.fn(async () => refused) }
  const cleanup = registerIpc(f.ipc, { settings: f.settings, history: f.history, startup: f.startup, hotkeys: f.hotkeys,
    app: f.app, trustedSenders: () => [{ role: 'main', webContents: f.trustedContents, url: f.trustedUrl }], watcher })
  try {
    expect(channels.every(channel => f.ipc.handlers.has(channel))).toBe(true)
    await expect(f.ipc.invoke(WATCHER_GET)).resolves.toEqual(refused)
    await expect(f.ipc.invoke(WATCHER_OPEN, { provider: 'codex', modelId: 'model', approved: true })).rejects.toThrow()
    await expect(f.ipc.invokeArgs(WATCHER_GET, [], { sender: { ...f.trustedContents }, senderFrame: f.trustedEvent.senderFrame })).rejects.toThrow()
    expect(watcher.open).not.toHaveBeenCalled()
    expect(watcher.get).toHaveBeenCalledTimes(1)
    await expect(f.ipc.invoke(WATCHER_SET_PERMISSION, { runtimeMode: 'full-access' })).resolves.toEqual(refused)
    await expect(f.ipc.invoke(WATCHER_SET_PERMISSION, { runtimeMode: 'always' })).rejects.toThrow()
    const target = { hostId: '11111111-1111-4111-8111-111111111111', threadId: 'worker' }
    await expect(f.ipc.invoke(WATCHER_WATCH_THREAD, { target })).resolves.toEqual(refused)
    await expect(f.ipc.invoke(WATCHER_UNWATCH_THREAD, { target })).resolves.toEqual(refused)
    await expect(f.ipc.invoke(WATCHER_WATCH_THREAD, { target, approved: true })).rejects.toThrow()
    expect(watcher.watchThread).toHaveBeenCalledTimes(1)
  } finally { cleanup() }
})
