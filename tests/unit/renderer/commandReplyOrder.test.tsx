import { threadsStateFixture } from '../../fixtures/agentState'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { wrapAgentBridge } from '../../../src/renderer/src/agents/agentStateCatalogs'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentModel, type AgentState, type AgentThread, type AgentWireBridge } from '../../../src/shared/agents'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const thread = (id: string, title = id): AgentThread => ({ id, title, projectId: 'project', modelId: 'claude:test', status: 'idle', messages: [], requests: [] })
const models: AgentModel[] = [{ id: 'claude:test', provider: 'Claude Code', providerId: 'claude', name: 'test', ready: true }]

function fullState(threads: AgentThread[]): AgentState {
  return threadsStateFixture({ cloneOverrides: false,
    configuration: { ...defaultAgentConfiguration(), enabled: true },
    host: { ...EMPTY_AGENT_HOST, connected: true, models, threads },
    topLevel: { activeThreadId: null, activeProjectId: null, draftAttachments: [], credentials: { reasoning: false, secure: false }, historyEnabled: true } })
}

/** A broadcast or a command receipt as it crosses: threads as changed thread records, the catalog named by its revision. */
function wire(state: AgentState, threads: { revision: number; base: number | null; changed: AgentThread[] }, first = false): unknown {
  return { ...state, host: { ...state.host, models: first ? { revision: 1, models } : { revision: 1, omitted: true }, threads } }
}

/** The preload's bridge as the page meets it: broadcasts handed in by the test, a command answered with changed thread records. */
function page(initial: AgentState) {
  let broadcast: ((raw: unknown) => void) | null = null
  const withChanges = vi.fn()
  const bridge = {
    get: vi.fn(async () => initial),
    command: vi.fn(),
    commandWithChangedThreadRecords: withChanges,
    onState: (listener: (raw: unknown) => void) => { broadcast = listener; return () => { broadcast = null } },
    threadDetail: vi.fn(async () => null),
    onThreadDetail: () => () => undefined,
  } as unknown as AgentWireBridge
  return { bridge: wrapAgentBridge(bridge), withChanges, emit: (raw: unknown) => broadcast?.(raw) }
}

/**
 * Main sends a command's own broadcast just before its reply, so the broadcast nearly always reaches the window while the
 * command is still out. The window used to drop the reply then, and the broadcast waited for its frame, so a caller that
 * read the state after the command read the state from before it (#306). Main numbers the two from one counter, which
 * orders them.
 */
describe('a command reply a broadcast reached the window ahead of (#306)', () => {
  async function connect() {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    // The frame a held shell waits for never comes on its own: what the caller reads is what the command committed.
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    const initial = fullState([thread('workshop'), thread('docs')])
    const wired = page(initial)
    const hook = renderHook(() => useAgentConnection(wired.bridge))
    await waitFor(() => expect(hook.result.current.state).not.toBeNull())
    // The first broadcast lists every record; it waits for its frame, which the next shell or a command commits.
    act(() => wired.emit(wire(initial, { revision: 1, base: null, changed: initial.host.threads }, true)))
    return { ...wired, result: hook.result }
  }

  it('commits a reply main numbered after the broadcast its command sent, before the caller reads the state', async () => {
    const { result, withChanges, emit } = await connect()
    const renamed = fullState([thread('workshop', 'Renamed'), thread('docs')])
    withChanges.mockImplementation(async () => {
      // The command's own broadcast arrives first, measured from broadcast 1; the reply is measured from it.
      emit(wire(renamed, { revision: 2, base: 1, changed: [renamed.host.threads[0]!] }))
      // The reply's own fields are what its caller acts on, so it is the reply that must land, not only the broadcast.
      return wire({ ...renamed, notice: 'From the reply' }, { revision: 3, base: 2, changed: [] })
    })
    await act(async () => { await result.current.command({ type: 'select-thread', threadId: 'workshop' }) })
    expect(result.current.state?.host.threads[0]!.title).toBe('Renamed')
    expect(result.current.state?.notice).toBe('From the reply')
  })

  it('drops a reply a newer broadcast passed, and commits that broadcast in its place', async () => {
    const { result, withChanges, emit } = await connect()
    const replied = fullState([thread('workshop', 'Replied'), thread('docs')])
    const later = fullState([thread('workshop', 'Later'), thread('docs')])
    withChanges.mockImplementation(async () => {
      const reply = wire(replied, { revision: 2, base: 1, changed: [replied.host.threads[0]!] })
      // Main sent a newer broadcast after it encoded the reply, and it crossed first.
      emit(wire(later, { revision: 3, base: 1, changed: [later.host.threads[0]!] }))
      return reply
    })
    await act(async () => { await result.current.command({ type: 'select-thread', threadId: 'workshop' }) })
    expect(result.current.state?.host.threads[0]!.title).toBe('Later')
  })
})
