// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoBridge, exposeRendererBridge } from '../../../src/preload'
import { WATCHER_MACHINES_RENDERER_ARGUMENT, WATCHER_READ_MACHINES, WATCHER_RENDERER_ARGUMENT } from '../../../src/shared/watcherRoom'

describe('The machines read in the preload (#1032, Owl cross-machine-work)', () => {
  it('exists only where main turned Watcher and Work across machines on, and checks what main answers', async () => {
    const ipc = preloadElectron().ipcRenderer
    expect(createSottoBridge(ipc, 'win32', true).watcher?.readMachines).toBeUndefined()
    expect(createSottoBridge(ipc, 'win32', false, false, false, false, false, false, false, false, true).watcher).toBeUndefined()
    const bridge = createSottoBridge(ipc, 'win32', true, false, false, false, false, false, false, false, true).watcher!
    const answer = { status: 'ok', observedAt: '2026-10-23T12:40:00.000Z', machines: [] }
    ipc.invoke.mockResolvedValue(answer)
    await expect(bridge.readMachines!()).resolves.toEqual(answer)
    expect(ipc.invoke).toHaveBeenLastCalledWith(WATCHER_READ_MACHINES)
    ipc.invoke.mockResolvedValue({ status: 'ok', machines: 'forge' })
    await expect(bridge.readMachines!()).rejects.toThrow()
  })

  it('reads the startup argument for the main window only', () => {
    const exposeInMainWorld = vi.fn(), ipc = preloadElectron().ipcRenderer
    exposeRendererBridge({ exposeInMainWorld }, ipc, ['--sotto-renderer-role=main', WATCHER_RENDERER_ARGUMENT, WATCHER_MACHINES_RENDERER_ARGUMENT])
    expect(exposeInMainWorld.mock.calls[0]![1].watcher.readMachines).toBeTypeOf('function')
    exposeInMainWorld.mockClear()
    exposeRendererBridge({ exposeInMainWorld }, ipc, ['--sotto-renderer-role=main', WATCHER_RENDERER_ARGUMENT])
    expect(exposeInMainWorld.mock.calls[0]![1].watcher.readMachines).toBeUndefined()
  })
})
