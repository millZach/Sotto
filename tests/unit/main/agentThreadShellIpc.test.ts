// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ipcRegistry } from '../../fixtures/ipcHarness'
import { threadsStateFixture } from '../../fixtures/agentState'
import { AGENT_GET } from '../../../src/shared/agents'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:/fixture' } }))
import { registerAgentIpc } from '../../../src/main/agents/ipc'
import { AgentStateBroadcaster } from '../../../src/main/agents/agentStateBroadcast'

describe('desktop thread shell complete read', () => {
  it('resets only after a trusted main read and returns the unchanged complete shell', async () => {
    const registry = ipcRegistry(), state = threadsStateFixture()
    const resetThreadDelivery = vi.fn()
    const control = { get: () => state, shell: () => state, threadDetail: () => null, attachmentPreview: () => null }
    const cleanup = registerAgentIpc(registry.ipc, control, { command: async () => state }, () => [registry.main, registry.widget], { encodeReceipt: new AgentStateBroadcaster().encodeReceipt, resetThreadDelivery })
    try {
      await expect(registry.invoke(AGENT_GET, [], registry.event(registry.widget))).rejects.toThrow()
      expect(resetThreadDelivery).not.toHaveBeenCalled()
      await expect(registry.invoke(AGENT_GET, [], registry.event(registry.main))).resolves.toBe(state)
      expect(resetThreadDelivery).toHaveBeenCalledTimes(1)
    } finally { cleanup() }
  })
})
