// @vitest-environment node
// ADR-0191 decision 9: the main window reaches its record only while the `dynamic-threads` Owl feature is on.
import { describe, expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { exposeRendererBridge } from '../../../src/preload'
import { DYNAMIC_RECORD_CLEAR, DYNAMIC_RECORD_READ, DYNAMIC_RECORD_RENDERER_ARGUMENT, type DynamicRecordBridge } from '../../../src/shared/dynamicRecord'

const exposed = (arguments_: string[]): Record<string, unknown> => {
  const exposeInMainWorld = vi.fn()
  exposeRendererBridge({ exposeInMainWorld }, preloadElectron().ipcRenderer, arguments_)
  return exposeInMainWorld.mock.calls[0]?.[1] as Record<string, unknown>
}

describe('its record\'s bridge', () => {
  it('exists only on a main window started with the feature on, and checks what main answers', async () => {
    expect(exposed(['--sotto-renderer-role=main'])).not.toHaveProperty('dynamicRecord')
    expect(exposed(['--sotto-renderer-role=widget', DYNAMIC_RECORD_RENDERER_ARGUMENT])).not.toHaveProperty('dynamicRecord')
    const ipc = preloadElectron().ipcRenderer
    const exposeInMainWorld = vi.fn()
    exposeRendererBridge({ exposeInMainWorld }, ipc, ['--sotto-renderer-role=main', DYNAMIC_RECORD_RENDERER_ARGUMENT])
    const bridge = (exposeInMainWorld.mock.calls[0]?.[1] as { dynamicRecord: DynamicRecordBridge }).dynamicRecord
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.keys(bridge).sort()).toEqual(['clear', 'read'])
    ipc.invoke.mockResolvedValue({ models: [] })
    expect(await bridge.read()).toEqual({ models: [] })
    expect(ipc.invoke).toHaveBeenLastCalledWith(DYNAMIC_RECORD_READ)
    expect(await bridge.clear()).toEqual({ models: [] })
    expect(ipc.invoke).toHaveBeenLastCalledWith(DYNAMIC_RECORD_CLEAR)
    // Words main should never send are refused.
    ipc.invoke.mockResolvedValue({ models: [{ provider: 'codex', model: 'm', name: 'Sol', pieces: 1, finished: 1, moved: 0, tokens: 3, brief: 'private' }] })
    await expect(bridge.read()).rejects.toThrow()
  })
})
