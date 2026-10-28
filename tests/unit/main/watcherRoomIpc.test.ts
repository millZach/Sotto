// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createIpcHarness } from '../../fixtures/ipcHarness'
import { registerIpc } from '../../../src/main/ipc/registerIpc'
import { WATCHER_GET, WATCHER_OPEN, WATCHER_PREPARE_STOP_ALL, WATCHER_STOP_ALL, WATCHER_SET_PERMISSION, WATCHER_WATCH_THREAD, WATCHER_UNWATCH_THREAD,
  WATCHER_READ_HANDOVER, WATCHER_CONTINUE_HANDOVER, WATCHER_DISMISS_HANDOVER, WATCHER_START_NEW } from '../../../src/shared/watcherRoom'

it('registers no Watcher channels in stable and allows only the trusted main sender when enabled', async () => {
  const f = createIpcHarness(), channels = [WATCHER_GET, WATCHER_OPEN, WATCHER_PREPARE_STOP_ALL, WATCHER_STOP_ALL, WATCHER_SET_PERMISSION, WATCHER_WATCH_THREAD, WATCHER_UNWATCH_THREAD,
    WATCHER_READ_HANDOVER, WATCHER_CONTINUE_HANDOVER, WATCHER_DISMISS_HANDOVER, WATCHER_START_NEW]
  expect(channels.every(channel => !f.ipc.handlers.has(channel))).toBe(true)
  f.cleanup()
  const refused = { status: 'refused' as const, code: 'NOT_CURRENT_WATCHER' as const, message: 'Open Watcher.', retryable: false }
  const watcher = { get: vi.fn(async () => refused), open: vi.fn(async () => refused), prepareStopAll: vi.fn(async () => refused), stopAll: vi.fn(async () => refused), setPermission: vi.fn(async () => refused), watchThread: vi.fn(async () => refused), unwatchThread: vi.fn(async () => refused),
    readHandover: vi.fn(async () => refused), continueWithHandover: vi.fn(async () => refused), dismissHandover: vi.fn(async () => refused), startNew: vi.fn(async () => refused) }
  const cleanup = registerIpc(f.ipc, { settings: f.settings, history: f.history, startup: f.startup, hotkeys: f.hotkeys,
    app: f.app, trustedSenders: () => [{ role: 'main', webContents: f.trustedContents, url: f.trustedUrl }], watcher })
  try {
    expect(channels.every(channel => f.ipc.handlers.has(channel))).toBe(true)
    // The Threads in flight limit is gone (#1183), and with it the channel that set it.
    expect(f.ipc.handlers.has('sotto:watcher:set-limit')).toBe(false)
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
    // The handover: continuing names a draft and nothing else; reading and putting it away take nothing.
    await expect(f.ipc.invoke(WATCHER_READ_HANDOVER)).resolves.toEqual(refused)
    await expect(f.ipc.invoke(WATCHER_DISMISS_HANDOVER)).resolves.toEqual(refused)
    const draftId = '22222222-2222-4222-8222-222222222222'
    await expect(f.ipc.invoke(WATCHER_CONTINUE_HANDOVER, { draftId })).resolves.toEqual(refused)
    await expect(f.ipc.invoke(WATCHER_CONTINUE_HANDOVER, { draftId, text: 'An instruction' })).rejects.toThrow()
    await expect(f.ipc.invoke(WATCHER_CONTINUE_HANDOVER, { draftId: 'not-a-draft' })).rejects.toThrow()
    expect(watcher.continueWithHandover).toHaveBeenCalledTimes(1)
    expect(watcher.continueWithHandover).toHaveBeenCalledWith({ draftId })
    // New Watcher takes nothing: main reads the provider, model, effort and permissions from the current Watcher itself.
    await expect(f.ipc.invoke(WATCHER_START_NEW)).resolves.toEqual(refused)
    await expect(f.ipc.invoke(WATCHER_START_NEW, { provider: 'claude', modelId: 'model' })).rejects.toThrow()
    expect(watcher.startNew).toHaveBeenCalledTimes(1)
  } finally { cleanup() }
})
