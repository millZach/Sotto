import React from 'react'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentBridge, type AgentState } from '../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { AgentProvider, useAgentConnection, useAgents } from '../../../src/renderer/src/agents/AgentContext'
import type { AgentVoiceDependencies } from '../../../src/renderer/src/agents/voiceSession'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { useAttentionReview } from '../../../src/renderer/src/agents/attentionReview'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

const external = vi.hoisted(() => ({ dependencies: null as AgentVoiceDependencies | null }))
vi.mock('../../../src/renderer/src/e2e/agentVoiceEffects', () => ({ createE2EAgentVoiceEffects: () => external.dependencies }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function stateFixture(): AgentState {
  return { configuration: { ...defaultAgentConfiguration(), enabled: true, speak: true }, connection: 'connected', host: structuredClone(EMPTY_AGENT_HOST), assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 }, credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [], membership: { status: 'beta', label: 'Test', expiresAt: null } }
}

describe('speech interruption from the renderer', () => {
  it('keeps Review Next, reopen, legacy Next and spoken permission targets aligned through the real controller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-review-context-'))
    const host = new E2EAgentHost()
    const execute = vi.spyOn(host, 'execute')
    const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: value => value.toString() })
    const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner, membership: {
      status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }),
    } })
    try {
      await credentials.load(); await control.start(); await control.command({ type: 'connect' })
      await control.command({ type: 'assign', threadId: 'workshop' })
      for (const requestId of ['a', 'b']) host.event({ type: 'permission', threadId: 'workshop', requestId, text: `Request ${requestId}` })
      const { result } = renderHook(() => {
        const [state, setState] = React.useState(control.get())
        React.useEffect(() => control.subscribe(setState), [])
        return useAttentionReview(state, command => control.command(command), vi.fn())
      })
      await act(async () => { await result.current.next() })
      expect(result.current.items[0]?.requestId).toBe('b')
      await act(async () => { await control.command({ type: 'next' }) })
      expect(result.current.items[0]?.requestId).toBe('a')
      await act(async () => { await result.current.next() })
      expect(result.current.items[0]?.requestId).toBe('b')
      expect(result.current.show).toBe(true)
      expect(execute).not.toHaveBeenCalled()
      await act(async () => { await control.command({ type: 'utterance', text: 'allow' }) })
      expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'answer', requestId: 'b', approved: true }))
      expect(result.current.items[0]?.requestId).toBe('a')
      act(() => result.current.reopen())
      await act(async () => { host.event({ type: 'permission', threadId: 'workshop', requestId: 'c', text: 'Request c' }) })
      await act(async () => { await control.command({ type: 'next' }) })
      expect(result.current.items[0]?.requestId).toBe('c')
      await act(async () => { await control.command({ type: 'utterance', text: 'deny' }) })
      expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'answer', requestId: 'c', approved: false }))
    } finally { cleanup(); control.dispose(); await rm(root, { recursive: true, force: true }) }
  })
  it('retains dismissed item content across a room remount and queue removal, but shows changed attention', async () => {
    let state = stateFixture()
    state.host.threads = [{ id: 'thread', title: 'Thread', projectId: 'project', modelId: 'model', status: 'idle', messages: [], requests: [
      { id: 'allow', kind: 'permission', text: 'Allow?', options: [] }, { id: 'question', kind: 'question', text: 'Choose?', options: [] },
    ] }]
    state.queue = state.host.threads[0]!.requests.map(request => ({ id: request.id, threadId: 'thread', requestId: request.id, kind: request.kind, text: request.text, createdAt: '2026-09-11T00:00:00Z', deferred: false }))
    let receive!: (state: AgentState) => void
    const command = vi.fn<AgentBridge['command']>(async () => state)
    vi.stubGlobal('sotto', { agents: { get: async () => state, onState: (listener: typeof receive) => { receive = listener; return () => undefined }, command } })
    let controls!: ReturnType<typeof useAgents>
    function Room() { controls = useAgents(); return null }
    const view = (room: boolean) => <AgentProvider settings={null} dictation={{ status: 'idle' }}>{room ? <Room /> : null}</AgentProvider>
    const rendered = render(view(true))
    await waitFor(() => expect(controls.state).not.toBeNull())
    expect(controls.attention.show).toBe(true)
    act(() => controls.attention.dismiss())
    rendered.rerender(view(false)); rendered.rerender(view(true))
    expect(controls.attention.show).toBe(false)
    await act(async () => { state = { ...state, queue: state.queue.slice(0, 1) }; receive(state) })
    expect(controls.attention.show).toBe(false)
    expect(controls.state?.host.threads[0]?.requests).toHaveLength(2)
    expect(command.mock.calls.every(([request]) => (request as { type: string }).type === 'voice' || (request as { type: string }).type === 'voice-state')).toBe(true)
    await act(async () => { state = { ...state, queue: state.queue.map(item => ({ ...item, text: 'New permission details' })) }; receive(state) })
    expect(controls.attention.show).toBe(true)
    act(() => controls.attention.reopen())
    await act(async () => { await controls.attention.next() })
    expect(controls.attention.show).toBe(false)
    expect(controls.state?.host.threads[0]?.requests).toHaveLength(2)
    await act(async () => { state = { ...state, host: { ...state.host, threads: state.host.threads.map(thread => ({ ...thread, archivedAt: '2026-09-11T01:00:00Z' })) } }; receive(state) })
    expect(controls.attention.items).toEqual([])
    expect(controls.attention.show).toBe(false)
  })

  it('reviews two requests on the same thread independently without removing either request', async () => {
    const state = stateFixture()
    state.activeThreadId = 'thread'
    state.host.threads = [{ id: 'thread', title: 'Thread', projectId: 'project', modelId: 'model', status: 'idle', messages: [], requests: [
      { id: 'a', kind: 'permission', text: 'First?', options: [] }, { id: 'b', kind: 'permission', text: 'Second?', options: [] },
    ] }]
    state.queue = state.host.threads[0]!.requests.map(request => ({ id: request.id, threadId: 'thread', requestId: request.id, kind: request.kind, text: request.text, createdAt: '2026-09-11T00:00:00Z', deferred: false }))
    const command = vi.fn<AgentBridge['command']>(async request => {
      if (request.type === 'select-attention') state.queue = [...state.queue].sort((a, b) => Number(b.id === request.itemId) - Number(a.id === request.itemId))
      return structuredClone(state)
    })
    vi.stubGlobal('sotto', { agents: { get: async () => state, onState: () => () => undefined, command } })
    let controls!: ReturnType<typeof useAgents>
    function Room() { controls = useAgents(); return null }
    render(<AgentProvider settings={null} dictation={{ status: 'idle' }}><Room /></AgentProvider>)
    // The provider paints the cached shell first and replaces it with the live state the bridge answers
    // with, so the review only means anything once this thread's own queue has arrived.
    await waitFor(() => expect(controls.attention.items.map(item => item.id)).toEqual(['a', 'b']))
    await act(async () => { await controls.attention.next() })
    expect(controls.attention.items[0]?.id).toBe('b')
    expect(controls.attention.show).toBe(true)
    await act(async () => { await controls.attention.next() })
    expect(controls.attention.show).toBe(false)
    expect(state.queue).toHaveLength(2)
    expect(state.host.threads[0]?.requests).toHaveLength(2)
    expect(command.mock.calls.some(([request]) => request.type === 'answer')).toBe(false)
  })

  it.each([
    { type: 'voice', action: 'stop-speaking' },
    { type: 'configure', patch: { speak: false } },
    { type: 'configure', patch: { speak: true } },
  ] as const)('delivers immediate audio control %j while a normal command is pending', async request => {
    const state = stateFixture()
    let release!: (state: AgentState) => void
    const pending = new Promise<AgentState>(resolve => { release = resolve })
    const command = vi.fn<AgentBridge['command']>(request => request.type === 'connect' ? pending : Promise.resolve(state))
    const bridge: AgentBridge = { get: async () => state, onState: () => () => undefined, command }
    const { result } = renderHook(() => useAgentConnection(bridge))
    let connecting!: Promise<AgentState | null>
    try {
      act(() => { connecting = result.current.command({ type: 'connect' }) })
      await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'connect' }))
      act(() => { void result.current.command(request) })
      await waitFor(() => expect(command).toHaveBeenCalledWith(request))
    } finally { await act(async () => { release(state); await connecting }) }
  })

  it('replaces old narration, stops locally, and cancels speech when replies are disabled', async () => {
    let state = stateFixture()
    let receive!: (state: AgentState) => void
    let finish: (() => void) | undefined
    const speak = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve }) })
    const stop = vi.fn(() => { finish?.(); finish = undefined })
    external.dependencies = {
      createWakeDetector: () => ({ load: async () => undefined, detect: async () => ({ detected: false, endSeconds: 0 }), dispose() {} }),
      createCapture: () => ({ start: async () => undefined, stop: async () => undefined, setSuppressed() {} }),
      createTranscriber: () => ({ load: async () => undefined, transcribe: async () => ({ text: '', language: 'en' }), cancel() {}, dispose() {} }),
      speech: { speak, stop }, createId: () => 'test', setTimer: (callback, delay) => setTimeout(callback, delay), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    }
    vi.stubGlobal('sottoE2E', {})
    vi.stubGlobal('sotto', { agents: { get: async () => state, onState: (listener: typeof receive) => { receive = listener; return () => undefined }, command: async () => state } })
    let controls!: ReturnType<typeof useAgents>
    function Controls() { controls = useAgents(); return null }
    render(<AgentProvider settings={{ ...DEFAULT_SETTINGS, onboardingComplete: true }} dictation={{ status: 'idle' }}><Controls /></AgentProvider>)
    await waitFor(() => expect(controls.state).not.toBeNull())
    async function announce(id: number, text: string) { await act(async () => { state = { ...state, speech: { id, text } }; receive(state) }) }
    await announce(1, 'First update')
    await waitFor(() => expect(speak).toHaveBeenCalledWith('First update'))
    await announce(2, 'Second update')
    await waitFor(() => expect(speak).toHaveBeenCalledWith('Second update'))
    const stops = stop.mock.calls.length
    act(() => controls.stopSpeech())
    expect(stop.mock.calls.length).toBeGreaterThan(stops)
    expect(controls.voice.status).not.toBe('speaking')
    await announce(3, 'Third update')
    await waitFor(() => expect(speak).toHaveBeenCalledWith('Third update'))
    const beforeMute = stop.mock.calls.length
    await act(async () => { state = { ...state, configuration: { ...state.configuration, speak: false } }; receive(state) })
    expect(stop.mock.calls.length).toBeGreaterThan(beforeMute)
  })
})
