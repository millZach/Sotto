// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge, createSottoWidgetBridge, exposeRendererBridge } from '../../../src/preload'
import { DESKTOP_NOTIFICATIONS_RENDERER_ARGUMENT, NOTIFICATION_OPENED, NOTIFICATION_TEST } from '../../../src/shared/desktopNotifications'

describe('Notifications preload (ADR-0117)', () => {
  it('exists only where main turned notifications on, never on the widget, and asks main for a validated test', async () => {
    const ipc = preloadElectron().ipcRenderer
    expect(createSottoBridge(ipc, 'darwin').notifications).toBeUndefined()
    expect(createSottoWidgetBridge(ipc, 'darwin')).not.toHaveProperty('notifications')
    const bridge = createSottoBridge(ipc, 'darwin', false, false, false, false, false, false, false, true).notifications!
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.keys(bridge).sort()).toEqual(['onOpened', 'test'])
    ipc.invoke.mockResolvedValue('shown')
    await expect(bridge.test()).resolves.toBe('shown')
    expect(ipc.invoke).toHaveBeenLastCalledWith(NOTIFICATION_TEST)
    // What main answers is checked: only the three results the window knows how to say.
    ipc.invoke.mockResolvedValue('maybe')
    await expect(bridge.test()).rejects.toThrow()
  })

  it('tells the window when a notification was pressed, and stops when the window stops listening', () => {
    const ipc = preloadElectron().ipcRenderer
    const bridge = createSottoBridge(ipc, 'darwin', false, false, false, false, false, false, false, true).notifications!
    const listener = vi.fn()
    const stop = bridge.onOpened(listener)
    const handler = ipc.on.mock.calls.find(([channel]) => channel === NOTIFICATION_OPENED)![1] as (event: unknown, value: unknown) => void
    handler({}, { page: 'threads' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith({ page: 'threads' })
    handler({}, { page: 'watcher', notice: 'This notification is for Watcher.' })
    expect(listener).toHaveBeenLastCalledWith({ page: 'watcher', notice: 'This notification is for Watcher.' })
    // Only a known destination and optional explanation cross this boundary.
    handler({}, { page: 'settings' })
    handler({}, { threadId: 'private' })
    handler({}, null)
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    expect(ipc.removeListener).toHaveBeenCalledWith(NOTIFICATION_OPENED, expect.any(Function))
  })

  it('uses the startup argument only for the main renderer role', () => {
    const exposeInMainWorld = vi.fn(), ipc = preloadElectron().ipcRenderer
    exposeRendererBridge({ exposeInMainWorld }, ipc, ['--sotto-renderer-role=main', DESKTOP_NOTIFICATIONS_RENDERER_ARGUMENT])
    expect(exposeInMainWorld.mock.calls[0]?.[1]).toHaveProperty('notifications')
    exposeInMainWorld.mockClear()
    exposeRendererBridge({ exposeInMainWorld }, ipc, ['--sotto-renderer-role=main'])
    expect(exposeInMainWorld.mock.calls[0]?.[1]).not.toHaveProperty('notifications')
    exposeInMainWorld.mockClear()
    exposeRendererBridge({ exposeInMainWorld }, ipc, ['--sotto-renderer-role=widget', DESKTOP_NOTIFICATIONS_RENDERER_ARGUMENT])
    expect(exposeInMainWorld.mock.calls[0]?.[1]).not.toHaveProperty('notifications')
  })
})
