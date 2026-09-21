import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }))
import { createSottoBridge, createSottoWidgetBridge } from '../../../src/preload'
import { SUBAGENTS_PAGE, SUBAGENTS_CHANGED, EMPTY_SUBAGENT_SUMMARY, type SubagentPageRequest } from '../../../src/shared/subagents'

describe('subagent preload contract', () => {
  it('exposes typed observational reads only to the main window and validates incoming events', async () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    const bridge = createSottoBridge(ipc, 'win32').subagents!
    expect(Object.keys(bridge).sort()).toEqual(['assignments', 'onChanged', 'page'])
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(createSottoWidgetBridge(ipc, 'win32')).not.toHaveProperty('subagents')
    const page = { threadId: 'thread', revision: 1, rows: [], summary: EMPTY_SUBAGENT_SUMMARY }
    ipc.invoke.mockResolvedValue(page)
    expect(await bridge.page({ threadId: 'thread' })).toEqual(page)
    expect(ipc.invoke).toHaveBeenCalledWith(SUBAGENTS_PAGE, { threadId: 'thread' })
    expect(() => bridge.page({ threadId: 'thread', limit: 5000 } as SubagentPageRequest)).toThrow()
    const listener = vi.fn(), unsubscribe = bridge.onChanged(listener)
    expect(ipc.on).toHaveBeenCalledWith(SUBAGENTS_CHANGED, expect.any(Function))
    const receive = ipc.on.mock.calls.find(call => call[0] === SUBAGENTS_CHANGED)![1] as (event: unknown, payload: unknown) => void
    receive({}, page); expect(listener).toHaveBeenCalledWith(page)
    receive({}, { ...page, revision: -1 }); expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe(); expect(ipc.removeListener).toHaveBeenCalledOnce()
  })
})
