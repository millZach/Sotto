import { describe, expect, it, vi } from 'vitest'
import { registerSubagentIpc } from '../../../src/main/agents/subagentIpc'
import { SUBAGENTS_PAGE, SUBAGENTS_ASSIGNMENTS, EMPTY_SUBAGENT_SUMMARY } from '../../../src/shared/subagents'
import type { IpcInvocationEvent } from '../../../src/main/ipc/registerIpc'
import { ipcRegistry } from '../../fixtures/ipcHarness'

describe('agent roster IPC boundary', () => {
  it('accepts only trusted main-frame, bounded read requests and disposes its subscription', async () => {
    const registry = ipcRegistry()
    const { ipc, handlers } = registry
    const { main: sender } = registry
    const { url } = sender
    const { mainFrame } = sender.webContents
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
  it('reads a paired host\'s thread on that host, and never from this computer (ADR-0025, October 5 amendment)', async () => {
    const registry = ipcRegistry()
    const { ipc, handlers } = registry
    const { main: sender } = registry

    const { mainFrame } = sender.webContents
    const event: IpcInvocationEvent = { sender: sender.webContents, senderFrame: mainFrame }
    const host = { subagentPage: vi.fn(), subagentAssignments: vi.fn(), subscribeSubagents: vi.fn().mockReturnValue(() => undefined) }
    const threadId = 'host:22222222-2222-4222-8222-222222222222:thread'
    const hosted = { subagentPage: vi.fn().mockResolvedValue({ threadId, revision: 0, rows: [], summary: EMPTY_SUBAGENT_SUMMARY }), subagentAssignments: vi.fn().mockResolvedValue({ threadId, agentId: 'agent', assignments: [] }) }
    const close = registerSubagentIpc(ipc, host, () => [sender], vi.fn(), hosted)
    await expect(handlers.get(SUBAGENTS_PAGE)!(event, { threadId })).resolves.toMatchObject({ threadId })
    await expect(handlers.get(SUBAGENTS_ASSIGNMENTS)!(event, { threadId, agentId: 'agent' })).resolves.toMatchObject({ threadId, agentId: 'agent' })
    expect(hosted.subagentPage).toHaveBeenCalledWith({ threadId }); expect(hosted.subagentAssignments).toHaveBeenCalledWith({ threadId, agentId: 'agent' })
    expect(host.subagentPage).not.toHaveBeenCalled(); expect(host.subagentAssignments).not.toHaveBeenCalled()
    close()
    // Without the router, a paired host's thread is refused in words rather than looked up here.
    const bare = registerSubagentIpc(ipc, host, () => [sender], vi.fn())
    expect(() => handlers.get(SUBAGENTS_PAGE)!(event, { threadId })).toThrow('Agents cannot reach the host machine from this window.')
    expect(host.subagentPage).not.toHaveBeenCalled()
    bare()
  })
})
