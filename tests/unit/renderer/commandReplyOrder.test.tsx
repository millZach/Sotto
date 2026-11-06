import { threadsStateFixture } from '../../fixtures/agentState'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { wrapAgentBridge } from '../../../src/renderer/src/agents/agentStateCatalogs'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentModel, type AgentState, type AgentThread, type AgentThreadDetailUpdate, type AgentWireBridge } from '../../../src/shared/agents'

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/**
 * `run` as the window runs it, outside `act()`: nothing flushes React's work for it, so what `run` reads is what React had
 * committed by then, as it is for a caller in the app.
 */
async function outsideAct<T>(run: () => Promise<T>): Promise<T> {
  const was = actEnvironment.IS_REACT_ACT_ENVIRONMENT
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
  try { return await run() } finally { if (was === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT; else actEnvironment.IS_REACT_ACT_ENVIRONMENT = was }
}

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
  let detail: ((update: AgentThreadDetailUpdate) => void) | null = null
  const withChanges = vi.fn()
  const bridge = {
    get: vi.fn(async () => initial),
    command: vi.fn(),
    commandWithChangedThreadRecords: withChanges,
    onState: (listener: (raw: unknown) => void) => { broadcast = listener; return () => { broadcast = null } },
    threadDetail: vi.fn(async () => null),
    onThreadDetail: (listener: (update: AgentThreadDetailUpdate) => void) => { detail = listener; return () => { detail = null } },
  } as unknown as AgentWireBridge
  return { bridge: wrapAgentBridge(bridge), raw: bridge, withChanges, emit: (raw: unknown) => broadcast?.(raw),
    emitDetail: (update: AgentThreadDetailUpdate) => detail?.(update) }
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

  it('draws a reply main numbered after the broadcast its command sent before the command answers', async () => {
    const { result, withChanges, emit } = await connect()
    const renamed = fullState([thread('workshop', 'Renamed'), thread('docs')])
    withChanges.mockImplementation(async () => {
      // The command's own broadcast arrives first, measured from broadcast 1; the reply is measured from it.
      emit(wire(renamed, { revision: 2, base: 1, changed: [renamed.host.threads[0]!] }))
      // The reply's own fields are what its caller acts on, so it is the reply that must land, not only the broadcast.
      return wire({ ...renamed, notice: 'From the reply' }, { revision: 3, base: 2, changed: [] })
    })
    // Read in the command's own continuation, as a caller that acts on the page does, before anything else lets React run.
    const seen = await outsideAct(() => result.current.command({ type: 'select-thread', threadId: 'workshop' })
      .then(() => ({ title: result.current.state?.host.threads[0]!.title, notice: result.current.state?.notice })))
    expect(seen).toEqual({ title: 'Renamed', notice: 'From the reply' })
  })

  it('drops a reply a newer broadcast passed, and draws that broadcast in its place before the command answers', async () => {
    const { result, withChanges, emit } = await connect()
    const replied = fullState([thread('workshop', 'Replied'), thread('docs')])
    const later = fullState([thread('workshop', 'Later'), thread('docs')])
    withChanges.mockImplementation(async () => {
      const reply = wire(replied, { revision: 2, base: 1, changed: [replied.host.threads[0]!] })
      // Main sent a newer broadcast after it encoded the reply, and it crossed first.
      emit(wire(later, { revision: 3, base: 1, changed: [later.host.threads[0]!] }))
      return reply
    })
    const seen = await outsideAct(() => result.current.command({ type: 'select-thread', threadId: 'workshop' })
      .then(() => result.current.state?.host.threads[0]!.title))
    expect(seen).toBe('Later')
  })

  it('draws a newer broadcast a thread detail already handed to a transition when it drops the older reply', async () => {
    const { result, withChanges, emit, emitDetail } = await connect()
    const replied = fullState([thread('workshop', 'Replied'), thread('docs')])
    const later = fullState([thread('workshop', 'Later'), thread('docs')])
    withChanges.mockImplementation(async () => {
      const reply = wire(replied, { revision: 2, base: 1, changed: [replied.host.threads[0]!] })
      emit(wire(later, { revision: 3, base: 1, changed: [later.host.threads[0]!] }))
      // The detail that follows the broadcast commits it as a transition, so no shell is held when the reply arrives.
      emitDetail({ threadId: 'workshop', revision: 1, messages: [] })
      return reply
    })
    const seen = await outsideAct(() => result.current.command({ type: 'select-thread', threadId: 'workshop' })
      .then(() => result.current.state?.host.threads[0]!.title))
    expect(seen).toBe('Later')
  })

  it('draws a reply to a command asked after a recovery read that answers with the state from before it', async () => {
    const { result, withChanges, emit, raw } = await connect()
    const before = fullState([thread('workshop', 'Before'), thread('docs')])
    const renamed = fullState([thread('workshop', 'Renamed'), thread('docs')])
    // A broadcast measured from one this window never held sends it to read the whole state; main answers later.
    let answer: (state: AgentState) => void = () => undefined
    vi.mocked(raw.get).mockImplementationOnce(() => new Promise<AgentState>(resolve => { answer = resolve }))
    act(() => emit(wire(before, { revision: 2, base: 7, changed: [] })))
    withChanges.mockImplementation(async () => {
      // The read was asked before the command, so it holds the state from before the command, and lands while it runs.
      answer(before)
      await new Promise(resolve => setTimeout(resolve, 0))
      return wire({ ...renamed, notice: 'From the reply' }, { revision: 4, base: null, changed: renamed.host.threads })
    })
    const seen = await outsideAct(() => result.current.command({ type: 'select-thread', threadId: 'workshop' })
      .then(() => ({ title: result.current.state?.host.threads[0]!.title, notice: result.current.state?.notice })))
    expect(seen).toEqual({ title: 'Renamed', notice: 'From the reply' })
  })
})
