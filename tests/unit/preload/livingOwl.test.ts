// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { preloadElectron } from '../../fixtures/preloadElectron'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { exposeRendererBridge } from '../../../src/preload'
import { LIVING_OWL_RENDERER_ARGUMENT } from '../../../src/shared/contracts'

describe('The living owl preload (ADR-0178)', () => {
  it('tells only the widget, and only when main passed the argument', () => {
    const exposeInMainWorld = vi.fn(), ipc = preloadElectron().ipcRenderer
    exposeRendererBridge({ exposeInMainWorld }, ipc, ['--sotto-renderer-role=widget', LIVING_OWL_RENDERER_ARGUMENT])
    expect(exposeInMainWorld.mock.calls[0]?.[1]).toHaveProperty('livingOwl', true)
    exposeInMainWorld.mockClear()
    exposeRendererBridge({ exposeInMainWorld }, ipc, ['--sotto-renderer-role=widget'])
    expect(exposeInMainWorld.mock.calls[0]?.[1]).not.toHaveProperty('livingOwl')
    exposeInMainWorld.mockClear()
    exposeRendererBridge({ exposeInMainWorld }, ipc, ['--sotto-renderer-role=main', LIVING_OWL_RENDERER_ARGUMENT])
    expect(exposeInMainWorld.mock.calls[0]?.[1]).not.toHaveProperty('livingOwl')
  })
})
