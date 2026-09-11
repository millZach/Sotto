import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { useAgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import type { AgentBridge, AgentState } from '../../../src/shared/agents'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('thread navigation through the real renderer connection and controller', () => {
  it.each(['refresh', 'reasoning'] as const)('renders authoritative cached selection while %s is still pending', async pending => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-navigation-connection-'))
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-navigation-connection-')) throw new Error('Unexpected fixture directory')
    const host = new E2EAgentHost()
    const observeThreads = vi.fn<(ids: string[]) => void>()
    const execute = vi.spyOn(host, 'execute')
    const reasoner = { ...e2eAgentReasoner, intent: vi.fn(e2eAgentReasoner.intent) }
    const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
    const control = new AgentControl({ directory: root, host: Object.assign(host, { observeThreads }), credentials, reasoner,
      membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
    let release!: () => void
    let operation: Promise<AgentState | null> | undefined
    let selection: Promise<AgentState | null> | undefined
    const gate = new Promise<void>(done => { release = done })
    try {
      await credentials.load(); await control.start(); await control.command({ type: 'connect' })
      await control.command({ type: 'select-thread', threadId: 'workshop' })
      if (pending === 'refresh') await control.command({ type: 'compose', text: 'Bound to A' })
      const cached = control.get()
      const bridge: AgentBridge = { get: async () => control.get(), onState: listener => control.subscribe(listener), command: vi.fn(command => control.command(command)) }
      const { result } = renderHook(() => {
        const connection = useAgentConnection(bridge)
        return { ...connection, title: connection.state?.host.threads.find(thread => thread.id === connection.state?.activeThreadId)?.title }
      })
      await waitFor(() => expect(result.current.title).toBe('Workshop'))
      if (pending === 'refresh') vi.spyOn(host, 'snapshot').mockImplementationOnce(async () => { await gate; return cached.host })
      else reasoner.intent.mockImplementationOnce(async () => { await gate; return { type: 'compose', threadId: 'workshop', text: 'For A' } })
      act(() => { operation = result.current.command(pending === 'refresh' ? { type: 'refresh' } : { type: 'utterance', text: 'Prepare my request' }) })
      await waitFor(() => expect(result.current.state?.busy).toBe(true))
      act(() => { selection = result.current.command({ type: 'select-thread', threadId: 'docs' }) })
      await waitFor(() => expect(result.current.title).toBe('Docs'))
      expect(result.current.state?.busy).toBe(true)
      expect(observeThreads).toHaveBeenLastCalledWith(['docs'])
      expect(execute).not.toHaveBeenCalled()
      expect(result.current.state?.assignments).toEqual([])
      if (pending === 'refresh') expect(result.current.state).toMatchObject({ draft: 'Bound to A', draftThreadId: 'workshop' })
      await act(async () => { release(); await operation; await selection })
      expect(result.current.title).toBe('Docs')
      expect(result.current.state?.draftThreadId).toBe('workshop')
      await act(async () => { await result.current.command({ type: 'send' }) })
      expect(execute).not.toHaveBeenCalled()
      expect(result.current.state?.error).toMatch(/Assign/)
    } finally {
      await act(async () => { release(); await operation; await selection })
      cleanup(); control.dispose()
      await control.privacyChanged()
      await rm(root, { recursive: true, force: true })
    }
  })
})
