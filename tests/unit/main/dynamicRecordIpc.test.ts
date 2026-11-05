// @vitest-environment node
// ADR-0191 decision 9: Settings reads its record and clears it from the main window alone, only while the Owl feature is on.
import { describe, expect, it, vi } from 'vitest'
import { registerDynamicRecordIpc } from '../../../src/main/agents/dynamicRecordIpc'
import { DYNAMIC_RECORD_CLEAR, DYNAMIC_RECORD_READ, type DynamicRecordRead } from '../../../src/shared/dynamicRecord'
import { ipcRegistry } from '../../fixtures/ipcHarness'

const line = { provider: 'codex', model: 'native:codex:model:gpt-6.1-sol', name: 'GPT-6.1 Sol', pieces: 3, finished: 2, moved: 1, tokens: 4_600 } as const

describe('its record in Settings', () => {
  it('registers nothing with the Owl feature off', () => {
    const { ipc, handlers, main } = ipcRegistry()
    registerDynamicRecordIpc(ipc, false, { load: async () => undefined, read: () => ({ models: [line] }), clear: async () => undefined }, () => [main])()
    expect(handlers.size).toBe(0)
  })

  it('reads and clears for the main window, refuses any other, and reads as empty where there is no record', async () => {
    const { ipc, handlers, main, mainEvent, widgetEvent } = ipcRegistry()
    let read: DynamicRecordRead = { models: [line] }
    const clear = vi.fn(async () => { read = { models: [] } })
    const load = vi.fn(async () => undefined)
    const close = registerDynamicRecordIpc(ipc, true, { load, read: () => read, clear }, () => [main])
    expect(await handlers.get(DYNAMIC_RECORD_READ)!(mainEvent)).toEqual({ models: [line] })
    await expect(Promise.resolve().then(() => handlers.get(DYNAMIC_RECORD_READ)!(widgetEvent))).rejects.toThrow('main Sotto window')
    await expect(Promise.resolve().then(() => handlers.get(DYNAMIC_RECORD_CLEAR)!(widgetEvent))).rejects.toThrow('main Sotto window')
    expect(clear).not.toHaveBeenCalled()
    expect(await handlers.get(DYNAMIC_RECORD_CLEAR)!(mainEvent)).toEqual({ models: [] })
    expect(clear).toHaveBeenCalledTimes(1)
    // Each answer waits for the saved record to be read.
    expect(load).toHaveBeenCalledTimes(2)
    close()
    expect(handlers.size).toBe(0)
    registerDynamicRecordIpc(ipc, true, undefined, () => [main])
    expect(await handlers.get(DYNAMIC_RECORD_READ)!(mainEvent)).toEqual({ models: [] })
    expect(await handlers.get(DYNAMIC_RECORD_CLEAR)!(mainEvent)).toEqual({ models: [] })
  })
})
