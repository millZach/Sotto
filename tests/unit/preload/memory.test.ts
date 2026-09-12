import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }))
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { MEMORY_CHANGED, MEMORY_COMMAND, MEMORY_GET, type MemoryCommand } from '../../../src/shared/memory'

describe('memory preload bridge', () => {
  it('exposes validated memory only to main and validates replies and events', async () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    const memory = createSottoBridge(ipc, 'win32').memory!
    expect('memory' in createSottoWidgetBridge(ipc, 'win32')).toBe(false)
    const snapshot = { available: true, questionnaireCompletedAt: null, memories: [], policies: [] }
    ipc.invoke.mockResolvedValue(snapshot)
    await expect(memory.get()).resolves.toEqual(snapshot)
    expect(ipc.invoke).toHaveBeenLastCalledWith(MEMORY_GET)
    await expect(memory.command({ type: 'delete', id: 'id' })).resolves.toEqual(snapshot)
    expect(ipc.invoke).toHaveBeenLastCalledWith(MEMORY_COMMAND, { type: 'delete', id: 'id' })
    expect(() => memory.command({ type: 'grant' } as unknown as MemoryCommand)).toThrow()
    ipc.invoke.mockResolvedValueOnce({ available: true })
    await expect(memory.get()).rejects.toThrow()
    const listener = vi.fn(), unsubscribe = memory.onChanged(listener)
    const handler = ipc.on.mock.calls.find(([channel]) => channel === MEMORY_CHANGED)![1] as (event: unknown, ...args: unknown[]) => void
    handler({}, snapshot)
    handler({}, { available: true })
    handler({}, snapshot, 'extra')
    expect(listener).toHaveBeenCalledExactlyOnceWith(snapshot)
    unsubscribe(); unsubscribe()
    expect(ipc.removeListener).toHaveBeenCalledExactlyOnceWith(MEMORY_CHANGED, handler)
  })
})
