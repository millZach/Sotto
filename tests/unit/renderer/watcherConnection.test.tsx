import React from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentBridge } from '../../../src/shared/agents'
import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { createBridge, createController } from '../../fixtures/renderer/appHarness'
import { agentThread, threadsStateFixture } from '../../fixtures/agentState'

const stateFixture = () => threadsStateFixture({ threads: [
  agentThread({ id: 'ordinary', title: 'Ordinary' }),
  agentThread({ id: 'watcher', kind: 'watcher', title: 'Saved Watcher' }),
  agentThread({ id: 'history', kind: 'watcher-history', title: 'Saved Watcher history' }),
], topLevel: { activeThreadId: 'watcher', draft: 'Saved Watcher prompt', draftThreadId: 'watcher' } })

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

describe('Watcher visibility at the renderer connection', () => {
  it('hides both kinds and their draft and refuses opening or observing them with the gate off', async () => {
    const state = stateFixture()
    const bridge: AgentBridge = { get: async () => state, onState: () => () => undefined,
      command: vi.fn(async () => state), threadDetail: vi.fn(async () => null) }
    const { result } = renderHook(() => useAgentConnection(bridge))
    await waitFor(() => expect(result.current.state?.host.threads.map(thread => thread.id)).toEqual(['ordinary']))
    expect(result.current.state).toMatchObject({ activeThreadId: null, draft: '', draftThreadId: null })
    expect(bridge.threadDetail).not.toHaveBeenCalled()
    for (const threadId of ['watcher', 'history']) {
      await act(async () => { expect(await result.current.command({ type: 'select-thread', threadId })).toBeNull() })
      await act(async () => { expect(await result.current.command({ type: 'start-thread-session', threadId })).toBeNull() })
    }
    expect(bridge.command).not.toHaveBeenCalled()
    await act(async () => { await result.current.command({ type: 'observe-threads', threadIds: ['watcher', 'ordinary', 'history'] }) })
    expect(bridge.command).toHaveBeenCalledWith({ type: 'observe-threads', threadIds: ['ordinary'] })
    expect(bridge.threadDetail).toHaveBeenCalledExactlyOnceWith('ordinary')
    expect(state.host.threads).toHaveLength(3)
    expect(state.draft).toBe('Saved Watcher prompt')
  })

  it('shows both kinds and reads the selected Watcher when main enables the gate', async () => {
    const state = stateFixture()
    const bridge: AgentBridge = { get: async () => state, onState: () => () => undefined,
      command: vi.fn(async () => state), threadDetail: vi.fn(async () => null) }
    const appBridge = createBridge({ getUpdateStatus: async () => ({ currentVersion: '0.1.37-owl.20261011.1',
      releaseTrack: 'owl', watcherEnabled: true, phase: { phase: 'unsupported' }, checkedAt: null }) })
    const { result } = renderHook(() => useAgentConnection(bridge), {
      wrapper: ({ children }) => <AppProvider bridge={appBridge} createController={createController}>{children}</AppProvider>,
    })
    await waitFor(() => expect(result.current.state?.host.threads).toHaveLength(3))
    expect(result.current.state).toBe(state)
    await waitFor(() => expect(bridge.threadDetail).toHaveBeenCalledWith('watcher'))
    await act(async () => { await result.current.command({ type: 'select-thread', threadId: 'history' }) })
    expect(bridge.command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'history' })
  })

  it('leaves an ordinary shell and command response unchanged', async () => {
    const state = threadsStateFixture({ threads: [agentThread({ id: 'ordinary' })], topLevel: { activeThreadId: 'ordinary' } })
    const bridge: AgentBridge = { get: async () => state, onState: () => () => undefined, command: vi.fn(async () => state) }
    const { result } = renderHook(() => useAgentConnection(bridge))
    await waitFor(() => expect(result.current.state).toBe(state))
    await act(async () => { expect(await result.current.command({ type: 'select-thread', threadId: 'ordinary' })).toBe(state) })
    expect(bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'select-thread', threadId: 'ordinary' })
  })
})
