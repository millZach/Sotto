import { createAgentControl } from '../../fixtures/agentControlFixture'
import { testCredentials } from '../../fixtures/testCredentials'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { pendingSettingsStore } from '../../../src/renderer/src/agents/pendingSettings'
import type { AgentBridge } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { agentBridgeFor } from '../../fixtures/agentBridge'

afterEach(() => { cleanup(); vi.restoreAllMocks(); pendingSettingsStore.clear() })

describe('the window asking for a thread\'s history (#996)', () => {
  it('asks once the command that shows or selects the thread has gone to main', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-window-asks-'))
    const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host: new E2EAgentHost(), credentials: await testCredentials(root, { mode: 'unavailable' }), reasoner: e2eAgentReasoner })
    try {
      await control.start(); await control.command({ type: 'connect' })
      const [first, second] = control.shell().host.threads.filter(thread => (thread.summary?.messageCount ?? 0) > 0).map(thread => thread.id)
      // Main hears, in order, each command and each ask: a remote thread already being observed is answered from the copy
      // the observation brings, and one asked for first is read from its host as well.
      const heard: string[] = []
      const inner = agentBridgeFor(control)
      const bridge: AgentBridge = { ...inner,
        command: request => { heard.push(request.type); return inner.command(request) },
        threadDetail: threadId => { heard.push(`ask ${threadId}`); return inner.threadDetail!(threadId) } }
      const { result } = renderHook(() => useAgentConnection(bridge))
      await waitFor(() => expect(result.current.state).not.toBeNull())
      heard.length = 0
      await act(async () => { await result.current.command({ type: 'observe-threads', threadIds: [first!] }) })
      expect(heard.slice(0, 2)).toEqual(['observe-threads', `ask ${first}`])
      heard.length = 0
      await act(async () => { await result.current.command({ type: 'select-thread', threadId: second! }) })
      expect(heard.slice(0, 2)).toEqual(['select-thread', `ask ${second}`])
    } finally {
      cleanup(); control.dispose(); await control.privacyChanged()
      if (dirname(resolve(root)) === resolve(tmpdir()) && root.includes('sotto-window-asks-')) await rm(root, { recursive: true, force: true })
    }
  })
})
