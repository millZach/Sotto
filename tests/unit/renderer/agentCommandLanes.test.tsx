import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import type { AgentHostCommand } from '../../../src/main/agents/host'
import { useAgentConnection, type AgentConnection } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadOptions } from '../../../src/renderer/src/agents/ThreadOptions'
import { threadSettingsStore } from '../../../src/renderer/src/agents/threadSettings'
import type { AgentBridge, AgentCommand, AgentState } from '../../../src/shared/agents'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'
import { agentBridgeFor } from '../../fixtures/agentBridge'

afterEach(() => { cleanup(); vi.restoreAllMocks(); threadSettingsStore.clear() })

const label = (request: AgentCommand): string => `${request.type}:${'threadId' in request ? request.threadId : ''}`

/**
 * The window over a real coordinator, with a bridge that records each command as it reaches main and can
 * hold one command's reply open after main has answered it: the window is still waiting, main is not.
 */
async function laneFixture(holdReply: (request: AgentCommand) => boolean = () => false) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-window-lanes-'))
  const host = new E2EAgentHost()
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  const control = new AgentControl({ schedule: immediatePublishScheduler, directory: root, host, credentials, reasoner: e2eAgentReasoner,
    membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
  await credentials.load(); await control.start(); await control.command({ type: 'connect' })
  let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  const arrived: string[] = [], answered: string[] = []
  const inner = agentBridgeFor(control)
  const bridge: AgentBridge = { ...inner, command: async request => {
    arrived.push(label(request))
    const state = await inner.command(request)
    answered.push(label(request))
    if (holdReply(request)) await gate
    return state
  } }
  return { control, host, bridge, arrived, answered, release, async close() {
    release()
    cleanup(); control.dispose(); await control.privacyChanged()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-window-lanes-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  } }
}

describe('thread commands in the window', () => {
  it('sends another thread’s settings, answer and Stop while one thread’s settings reply is still held', async () => {
    const f = await laneFixture(request => request.type === 'configure-thread' && request.threadId === 'docs')
    let held: Promise<AgentState | null> | undefined
    try {
      const { result } = renderHook(() => useAgentConnection(f.bridge))
      await waitFor(() => expect(result.current.state).not.toBeNull())
      act(() => { held = result.current.command({ type: 'configure-thread', threadId: 'docs', runtimeMode: 'full-access' }) })
      await waitFor(() => expect(f.arrived).toContain('configure-thread:docs'))
      let settled = false
      void held!.then(() => { settled = true })
      const others = [
        result.current.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' }),
        result.current.command({ type: 'answer', threadId: 'workshop', requestId: 'request-1', answer: 'Yes' }),
        result.current.command({ type: 'interrupt', threadId: 'workshop' }),
      ]
      // All three reach main at once, in the order they were made, and main answers each of them.
      expect(f.arrived).toEqual(['configure-thread:docs', 'configure-thread:workshop', 'answer:workshop', 'interrupt:workshop'])
      await act(async () => { await Promise.all(others) })
      expect(settled).toBe(false)
      expect(f.control.get().host.threads.find(thread => thread.id === 'workshop')?.runtimeMode).toBe('full-access')
      await act(async () => { f.release(); await held })
      expect(settled).toBe(true)
    } finally { await act(async () => { f.release(); await held }); await f.close() }
  })

  it('keeps one thread’s settings ahead of a send made straight after them, in the window and in main', async () => {
    const f = await laneFixture()
    const executed: string[] = []
    let proceed!: () => void
    const provider = new Promise<void>(done => { proceed = done })
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementation(async (command: AgentHostCommand) => {
      executed.push(command.type)
      if (command.type === 'configure-thread') await provider
      return execute(command)
    })
    let configuring: Promise<AgentState | null> | undefined, sending: Promise<AgentState | null> | undefined
    try {
      const { result } = renderHook(() => useAgentConnection(f.bridge))
      await waitFor(() => expect(result.current.state).not.toBeNull())
      act(() => {
        configuring = result.current.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' })
        sending = result.current.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'After the settings' })
      })
      expect(f.arrived).toEqual(['configure-thread:workshop', 'manual-send:workshop'])
      await waitFor(() => expect(executed).toEqual(['configure-thread']))
      // The send waits in the thread's lane behind the settings it followed.
      await new Promise(done => { setImmediate(done) })
      expect(executed).toEqual(['configure-thread'])
      await act(async () => { proceed(); await configuring; await sending })
      expect(executed).toEqual(['configure-thread', 'send'])
      const workshop = f.control.get().host.threads.find(thread => thread.id === 'workshop')
      expect(workshop?.runtimeMode).toBe('full-access')
      expect(f.control.get().deliveries).toContainEqual(expect.objectContaining({ threadId: 'workshop', status: 'accepted' }))
    } finally { await act(async () => { proceed(); await configuring; await sending }); await f.close() }
  })

  it('runs a prompt sent while a permission press is pending on the settings the press asked for, with no wait in the window', async () => {
    const f = await laneFixture()
    const executed: string[] = []
    let proceed!: () => void
    const provider = new Promise<void>(done => { proceed = done })
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementation(async (command: AgentHostCommand) => {
      // What the provider holds for the thread when each command reaches it: a send is labelled with its mode.
      const mode = (await f.host.snapshot()).threads.find(thread => thread.id === 'workshop')?.runtimeMode ?? 'provider default'
      executed.push(command.type === 'send' ? `send on ${mode}` : command.type)
      if (command.type === 'configure-thread') await provider
      return execute(command)
    })
    let connection!: AgentConnection
    function Chips(): React.ReactElement | null {
      connection = useAgentConnection(f.bridge)
      const thread = connection.state?.host.threads.find(item => item.id === 'workshop')
      return connection.state && thread ? <ThreadOptions thread={thread} state={connection.state} command={connection.command} /> : null
    }
    let sending: Promise<AgentState | null> | undefined
    try {
      render(<Chips />)
      const chip = await screen.findByRole('combobox', { name: 'Thread permissions' })
      fireEvent.click(chip)
      fireEvent.click(screen.getByRole('option', { name: 'Full access' }))
      expect(chip).toHaveAttribute('data-pending', 'true')
      // The prompt goes the moment it is sent: the window holds nothing back behind the pending press.
      act(() => { sending = connection.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'After the press' }) })
      expect(f.arrived).toEqual(['configure-thread:workshop', 'manual-send:workshop'])
      await waitFor(() => expect(executed).toEqual(['configure-thread']))
      // Main's thread lane keeps the send behind the settings it followed.
      await new Promise(done => { setImmediate(done) })
      expect(executed).toEqual(['configure-thread'])
      expect(chip).toHaveAttribute('data-pending', 'true')
      await act(async () => { proceed(); await sending })
      expect(executed).toEqual(['configure-thread', 'send on full-access'])
      await waitFor(() => expect(chip).not.toHaveAttribute('data-pending'))
      expect(chip).toHaveTextContent('Full access')
    } finally { await act(async () => { proceed(); await sending }); await f.close() }
  })

  it('never lets a held reply to a thread command paint over state main published after it', async () => {
    const f = await laneFixture(request => request.type === 'configure-thread' && request.threadId === 'workshop')
    let held: Promise<AgentState | null> | undefined
    const mode = (state: AgentState | null, threadId: string) => state?.host.threads.find(thread => thread.id === threadId)?.runtimeMode
    try {
      const { result } = renderHook(() => useAgentConnection(f.bridge))
      await waitFor(() => expect(result.current.state).not.toBeNull())
      const before = mode(result.current.state, 'docs')
      expect(before).not.toBe('full-access')
      act(() => { held = result.current.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'full-access' }) })
      await waitFor(() => expect(f.answered).toEqual(['configure-thread:workshop']))
      // Main has answered Workshop, so its reply predates this change to Docs; the window gets it after.
      await act(async () => { await result.current.command({ type: 'configure-thread', threadId: 'docs', runtimeMode: 'full-access' }) })
      await waitFor(() => expect(mode(result.current.state, 'docs')).toBe('full-access'))
      await act(async () => { f.release(); await held })
      expect(mode(result.current.state, 'docs')).toBe('full-access')
      expect(mode(result.current.state, 'workshop')).toBe('full-access')
    } finally { await act(async () => { f.release(); await held }); await f.close() }
  })

  it('still holds global commands behind one another', async () => {
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    const arrived: string[] = []
    const bridge: AgentBridge = { get: () => new Promise<AgentState>(() => undefined), onState: () => () => undefined, command: async request => {
      arrived.push(label(request))
      if (request.type === 'assign') await gate
      throw new Error('Not answered in this test')
    } }
    const { result } = renderHook(() => useAgentConnection(bridge))
    const held = result.current.command({ type: 'assign', threadId: 'docs' })
    await waitFor(() => expect(arrived).toEqual(['assign:docs']))
    const behind = result.current.command({ type: 'settle-project', projectId: 'project' })
    const beside = result.current.command({ type: 'compact-thread', threadId: 'workshop' })
    await act(async () => { await beside })
    // A command main keeps global still waits for the reply to the one before it; a thread's own does not.
    expect(arrived).toEqual(['assign:docs', 'compact-thread:workshop'])
    await act(async () => { release(); await held; await behind })
    expect(arrived).toEqual(['assign:docs', 'compact-thread:workshop', 'settle-project:'])
  })
})
