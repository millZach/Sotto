import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }))
import { createSottoBridge } from '../../../src/preload'
import { AGENT_COMMAND, AGENT_STATE, EMPTY_AGENT_HOST, defaultAgentConfiguration, type AgentCommand, type AgentState } from '../../../src/shared/agents'

const state: AgentState = {
  configuration: defaultAgentConfiguration(), connection: 'disconnected',
  host: { ...EMPTY_AGENT_HOST,
    projects: [{ id: 'project', title: 'Project', path: 'D:/project', workspaceSettledAt: '2026-09-12T12:00:00.000Z' }],
    threads: [{ id: 'thread', projectId: 'project', title: 'Task', modelId: 'model', status: 'idle', messages: [], requests: [], nativeSessionStarted: false, workspaceSettledAt: null }] },
  assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null,
  composing: false, pendingRequest: '', busy: false, notice: '', error: null,
  speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
  credentials: { reasoning: false, grokSpeech: false, secure: false }, reasoningAccounts: [],
  membership: { status: 'free', label: 'Free', expiresAt: null },
}

describe('workspace preload contract', () => {
  it('passes settlement commands and preserves organization/native-start metadata in replies and events', async () => {
    const ipc = { invoke: vi.fn().mockResolvedValue(state), on: vi.fn(), removeListener: vi.fn() }
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
    handler({}, { ...state, host: { ...state.host, projects: [{ ...state.host.projects[0], workspaceSettledAt: 'invalid' }] } })
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    expect(ipc.removeListener).toHaveBeenCalledWith(AGENT_STATE, handler)
  })
})
