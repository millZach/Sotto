// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge, createSottoWidgetBridge, exposeRendererBridge } from '../../../src/preload'
import { USAGE_READ, USAGE_REFRESH, USAGE_CLEAR, USAGE_RENDERER_ARGUMENT } from '../../../src/shared/usageDashboard'

describe('Usage preload', () => {
  it('exists only on a gated main window and validates both sides of the bounded numeric bridge', async () => {
    const ipc = preloadElectron().ipcRenderer
    expect(createSottoBridge(ipc, 'win32').usage).toBeUndefined()
    expect(createSottoWidgetBridge(ipc, 'win32')).not.toHaveProperty('usage')
    const bridge = createSottoBridge(ipc, 'win32', false, true).usage!
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.keys(bridge).sort()).toEqual(['clear', 'read', 'refresh'])
    ipc.invoke.mockResolvedValue({ hosts: [] })
    expect(await bridge.read({ timeZone: 'UTC' })).toEqual({ hosts: [] })
    expect(ipc.invoke).toHaveBeenLastCalledWith(USAGE_READ, { timeZone: 'UTC' })
    await bridge.refresh({ providerIds: ['codex'] })
    expect(ipc.invoke).toHaveBeenLastCalledWith(USAGE_REFRESH, { providerIds: ['codex'] })
    ipc.invoke.mockResolvedValue([])
    expect(await bridge.clear({ hosts: [{ hostId: 'host', expectedRevision: 0 }] })).toEqual([])
    expect(ipc.invoke).toHaveBeenLastCalledWith(USAGE_CLEAR, { hosts: [{ hostId: 'host', expectedRevision: 0 }] })
    expect(() => bridge.read({ nativeId: 'private' } as never)).toThrow()
    expect(() => bridge.clear({ hosts: [{ hostId: 'host', expectedRevision: -1 }] })).toThrow()
    ipc.invoke.mockResolvedValue({ hosts: [{ hostId: 'host', status: 'ready', quotas: [], promptText: 'private' }] })
    await expect(bridge.read({})).rejects.toThrow()
  })
  it('uses the startup argument only for the main renderer role', () => {
    const exposeInMainWorld = vi.fn(), ipc = preloadElectron().ipcRenderer
    exposeRendererBridge({ exposeInMainWorld }, ipc, ['--sotto-renderer-role=main', USAGE_RENDERER_ARGUMENT])
    expect(exposeInMainWorld.mock.calls[0]?.[1]).toHaveProperty('usage')
    exposeInMainWorld.mockClear()
    exposeRendererBridge({ exposeInMainWorld }, ipc, ['--sotto-renderer-role=widget', USAGE_RENDERER_ARGUMENT])
    expect(exposeInMainWorld.mock.calls[0]?.[1]).not.toHaveProperty('usage')
  })
})
