import { describe, expect, it, vi } from 'vitest'
import { registerSubagentIpc } from '../../../src/main/agents/subagentIpc'
import { SUBAGENTS_PAGE, SUBAGENTS_ASSIGNMENTS, EMPTY_SUBAGENT_SUMMARY } from '../../../src/shared/subagents'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'

describe('agent roster IPC boundary', () => {
  it('accepts only trusted main-frame, bounded read requests and disposes its subscription', async () => {
    const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
    const ipc: IpcMainAdapter = { handle: (channel, handler) => { handlers.set(channel, handler) }, removeHandler: channel => { handlers.delete(channel) } }
    const url = 'file:///main.html', mainFrame = { parent: null, url }
    const sender: TrustedIpcSender = { role: 'main', url, webContents: { mainFrame, getURL: () => url, isDestroyed: () => false } }
    const event: IpcInvocationEvent = { sender: sender.webContents, senderFrame: mainFrame }
    const unsubscribe = vi.fn()
    const host = { subagentPage: vi.fn().mockResolvedValue({ threadId: 'thread', revision: 0, rows: [], summary: EMPTY_SUBAGENT_SUMMARY }), subagentAssignments: vi.fn().mockResolvedValue({ threadId: 'thread', agentId: 'agent', assignments: [] }), subscribeSubagents: vi.fn().mockReturnValue(unsubscribe) }
    const close = registerSubagentIpc(ipc, host, () => [sender], vi.fn())
    for (const channel of [SUBAGENTS_PAGE, SUBAGENTS_ASSIGNMENTS]) {
      const request = channel === SUBAGENTS_PAGE ? { threadId: 'thread' } : { threadId: 'thread', agentId: 'agent' }
      await handlers.get(channel)!(event, request)
      for (const invalid of [{ ...request, before: -1 }, { ...request, limit: 5000 }, { ...request, providerSessionId: 'native' }]) expect(() => handlers.get(channel)!(event, invalid)).toThrow()
      expect(() => handlers.get(channel)!(event, request, 'extra')).toThrow()
      for (const senderFrame of [null, { parent: {}, url }, { parent: null, url }]) expect(() => handlers.get(channel)!({ ...event, senderFrame }, request)).toThrow('main Sotto window')
    }
    expect(host.subagentPage).toHaveBeenCalledTimes(1)
    expect(host.subagentAssignments).toHaveBeenCalledTimes(1)
    close(); expect(handlers.size).toBe(0); expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
