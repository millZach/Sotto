import { preloadElectron } from '../../fixtures/preloadElectron'
import { threadsStateFixture } from '../../fixtures/agentState'
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => {
  const { preloadElectron } = await import('../../fixtures/preloadElectron')
  return preloadElectron()
})
import { createSottoBridge } from '../../../src/preload'
import { AGENT_COMMAND, AGENT_STATE, EMPTY_AGENT_HOST, defaultAgentConfiguration, type AgentCommand, type AgentState } from '../../../src/shared/agents'

const state: AgentState = threadsStateFixture({
  configuration: defaultAgentConfiguration(), host: EMPTY_AGENT_HOST,
  projects: [{ id: 'project', title: 'Project', path: 'D:/project', workspaceSettledAt: '2026-09-12T12:00:00.000Z' }],
  threads: [{ id: 'thread', projectId: 'project', title: 'Task', modelId: 'model', status: 'idle', messages: [], requests: [], nativeSessionStarted: false, workspaceSettledAt: null }],
  topLevel: { connection: 'disconnected', assignments: [], queue: [], activeThreadId: null, activeProjectId: null,
    threadDrafts: undefined, deliveries: undefined, deliveredDrafts: undefined,
    credentials: { reasoning: false, grokSpeech: false, secure: false } },
})

describe('workspace preload contract', () => {
  it('passes settlement commands and preserves organization/native-start metadata in replies and events', async () => {
    // A command answers with a receipt, its catalog named by revision (issue #323).
    const receipt = { ...state, host: { ...state.host, models: { revision: 1, omitted: true } } }
    const ipc = ({ ...preloadElectron().ipcRenderer, invoke: vi.fn().mockResolvedValue(receipt) })
    const bridge = createSottoBridge(ipc, 'win32').agents!
    for (const command of [
      { type: 'settle-thread', threadId: 'thread' }, { type: 'restore-thread', threadId: 'thread' },
      { type: 'settle-project', projectId: 'project' }, { type: 'restore-project', projectId: 'project' },
    ] as const) {
      const result = await bridge.command(command)
      expect(ipc.invoke).toHaveBeenLastCalledWith(AGENT_COMMAND, command)
      expect(result.host.projects[0]?.workspaceSettledAt).toBe('2026-09-12T12:00:00.000Z')
      expect(result.host.threads[0]).toMatchObject({ nativeSessionStarted: false, workspaceSettledAt: null })
    }
    expect(() => bridge.command({ type: 'settle-thread', threadId: 'thread', delete: true } as unknown as AgentCommand)).toThrow()
    const listener = vi.fn(); const unsubscribe = bridge.onState(listener)
    const handler = ipc.on.mock.calls.find(([channel]) => channel === AGENT_STATE)![1] as (event: unknown, ...args: unknown[]) => void
    handler({}, state)
    expect(listener.mock.calls[0]![0].host.threads[0]).toMatchObject({ nativeSessionStarted: false, workspaceSettledAt: null })
    // The state channel carries Sotto's own state from Sotto's own main process, so it is passed
    // through on a structural guard alone: only a payload that is not a state at all is dropped.
    handler({}, { ...state, host: { ...state.host, projects: [{ ...state.host.projects[0], workspaceSettledAt: 'invalid' }] } })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls[1]![0].host.projects[0].workspaceSettledAt).toBe('invalid')
    for (const payload of [null, 'state', 42, { configuration: state.configuration }]) handler({}, payload)
    handler({}, state, state)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    expect(ipc.removeListener).toHaveBeenCalledWith(AGENT_STATE, handler)
  })
})
