import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentControl } from '../../../src/main/agents/control'
import { AgentCredentials } from '../../../src/main/agents/credentials'
import { E2EAgentHost, e2eAgentReasoner } from '../../../src/main/e2e/agentEffects'
import { AgentProvider, useAgentConnection, useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { sendThreadRevision } from '../../../src/renderer/src/agents/ThreadComposer'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import type { AgentBridge, AgentState } from '../../../src/shared/agents'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function draftFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-navigation-drafts-'))
  const host = new E2EAgentHost()
  const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
  const control = new AgentControl({ directory: root, host, credentials, reasoner: e2eAgentReasoner,
    membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
  await credentials.load(); await control.start(); await control.command({ type: 'connect' })
  const bridge: AgentBridge = { get: async () => control.get(), onState: listener => control.subscribe(listener), command: request => control.command(request) }
  return { control, host, bridge, disk: async () => JSON.parse(await readFile(join(root, 'agents.json'), 'utf8')),
    async close() {
      cleanup(); control.dispose(); await control.privacyChanged()
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-navigation-drafts-')) throw new Error('Unexpected fixture directory')
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('thread draft recovery through the real connection and disk', () => {
  it('keeps the controller busy guard when manual admission bypasses the renderer queue', async () => {
    const f = await draftFixture()
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    let refreshing: Promise<AgentState | null> | undefined, sending: Promise<void> | undefined
    const execute = vi.spyOn(f.host, 'execute')
    const snapshot = f.control.get().host
    vi.spyOn(f.host, 'snapshot').mockImplementationOnce(async () => { await gate; return snapshot })
    try {
      const { result } = renderHook(() => useAgentConnection(f.bridge))
      await waitFor(() => expect(result.current.state).not.toBeNull())
      act(() => { refreshing = result.current.command({ type: 'refresh' }) })
      await waitFor(() => expect(f.control.get().busy).toBe(true))
      const store = result.current.threadDrafts
      const row = describeThreads(f.control.get(), Date.now()).find(item => item.thread.id === 'workshop')!
      act(() => {
        store.edit('workshop', { text: 'Clicked before busy state painted' })
        sending = sendThreadRevision(store, row, result.current.command, 1)
        store.edit('workshop', { text: 'Keep editing while busy' }); store.flush('workshop')
      })
      await waitFor(() => expect(store.snapshot('workshop').save).toBe('saved'))
      await act(async () => { release(); await refreshing; await sending })
      expect(f.control.get().deliveries).toContainEqual(expect.objectContaining({ status: 'failed' }))
      expect(f.control.get().error).toMatch(/Another action is still in progress/)
      expect(execute).not.toHaveBeenCalled()
      expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ text: 'Keep editing while busy' }))
    } finally { await act(async () => { release(); await refreshing; await sending }); await f.close() }
  })

  it('reconciles durable uncertain delivery through a fresh workspace without resending or using the current draft', async () => {
    const f = await draftFixture()
    const original = f.host.execute.bind(f.host)
    const execute = vi.spyOn(f.host, 'execute').mockResolvedValue({ accepted: false, uncertain: true })
    try {
      const oldId = randomUUID(), newId = randomUUID()
      await f.control.command({ type: 'manual-send', threadId: 'workshop', draftId: oldId, text: 'Original unconfirmed prompt' })
      await f.control.command({ type: 'save-thread-draft', threadId: 'workshop', draftId: newId, text: 'Independent newer draft' })
      await f.control.command({ type: 'select-thread', threadId: 'workshop' })
      expect((await f.disk()).deliveries).toContainEqual(expect.objectContaining({ draftId: oldId, status: 'uncertain' }))
      vi.stubGlobal('sotto', { agents: f.bridge })
      render(<AgentProvider settings={null} dictation={{ status: 'idle' }}><ThreadsView onOpenAgents={() => undefined} /></AgentProvider>)
      const check = await screen.findByRole('button', { name: 'Check again' })
      expect(screen.getByLabelText('Pending message')).not.toHaveTextContent('Original unconfirmed prompt')
      expect(screen.getByLabelText('Pending message')).not.toHaveTextContent('Independent newer draft')
      fireEvent.click(check)
      await waitFor(() => expect(f.control.get().busy).toBe(false))
      expect(f.control.get().deliveries).toContainEqual(expect.objectContaining({ draftId: oldId, status: 'uncertain' }))
      expect(execute).toHaveBeenCalledTimes(1)
      // The provider finally reports the exact original command, independently
      // of the composer. Its authoritative echo resolves the retained outbox.
      await act(async () => { await original(execute.mock.calls[0]![0]) })
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument())
      expect(screen.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Independent newer draft')
      await f.control.privacyChanged()
      expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ draftId: newId, text: 'Independent newer draft' }))
      expect(execute).toHaveBeenCalledTimes(1)
    } finally { await f.close() }
  })

  it('admits a send before newer edits while an earlier renderer IPC reply is still held', async () => {
    const f = await draftFixture()
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    let waiting = false, previous: Promise<AgentState | null> | undefined, sending: Promise<void> | undefined
    const execute = vi.spyOn(f.host, 'execute')
    const bridge: AgentBridge = { ...f.bridge, command: async request => {
      const state = await f.control.command(request)
      if (request.type === 'select-project') { waiting = true; await gate }
      return state
    } }
    try {
      const { result } = renderHook(() => useAgentConnection(bridge))
      await waitFor(() => expect(result.current.state).not.toBeNull())
      act(() => { previous = result.current.command({ type: 'select-project', projectId: f.control.get().host.projects[0]!.id }) })
      await waitFor(() => expect(waiting).toBe(true))
      expect(f.control.get()).toMatchObject({ busy: false, error: null })
      const store = result.current.threadDrafts
      const row = describeThreads(f.control.get(), Date.now()).find(item => item.thread.id === 'workshop')!
      act(() => {
        store.edit('workshop', { text: 'Send revision A' })
        sending = sendThreadRevision(store, row, result.current.command, 1)
      })
      // Admission is synchronous even though the earlier bridge reply is held.
      expect(f.control.get().deliveries).toContainEqual(expect.objectContaining({ threadId: 'workshop', status: 'queued' }))
      act(() => { store.edit('workshop', { text: 'Keep newer revision B' }); store.flush('workshop') })
      await waitFor(() => expect(store.snapshot('workshop').save).toBe('saved'))
      await act(async () => { release(); await previous; await sending })
      expect(execute.mock.calls.filter(([request]) => request.type === 'send')).toEqual([[expect.objectContaining({ text: 'Send revision A' })]])
      expect(store.draft('workshop').text).toBe('Keep newer revision B')
      expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: 'workshop', text: 'Keep newer revision B' }))
      expect(f.control.get().assignments).toEqual([])
    } finally { await act(async () => { release(); await previous; await sending }); await f.close() }
  })

  it.each(['pending', 'failed'] as const)('retains %s save durability through actual Threads unmount/remount and retries to disk', async stage => {
    const f = await draftFixture()
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    let writing = false
    const image = { id: 'retained-image', name: 'pixel.png', mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ0AAAAASUVORK5CYII=' }
    let controls!: ReturnType<typeof useAgents>
    function Observer() { controls = useAgents(); return null }
    const page = (shown: boolean) => <AgentProvider settings={null} dictation={{ status: 'idle' }}><Observer />{shown ? <ThreadsView onOpenAgents={() => undefined} /> : null}</AgentProvider>
    let spy: ReturnType<typeof vi.spyOn> | undefined
    try {
      await f.control.command({ type: 'select-thread', threadId: 'workshop' })
      vi.stubGlobal('sotto', { agents: f.bridge })
      const view = render(page(true))
      await screen.findByRole('textbox', { name: 'Prompt', exact: true })
      const store = controls.threadDrafts
      const original = AtomicJsonStore.prototype.write
      spy = vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(async function(this: AtomicJsonStore<unknown>, value) {
        if ((value as AgentState).threadDrafts?.some(item => item.text === 'Keep this unsaved draft')) {
          writing = true; await gate; throw new Error('Injected disk failure')
        }
        return original.call(this, value)
      })
      fireEvent.change(screen.getByRole('textbox', { name: 'Prompt', exact: true }), { target: { value: 'Keep this unsaved draft' } })
      act(() => { store.edit('workshop', { attachments: [image] }); store.flush('workshop') })
      await waitFor(() => expect(writing).toBe(true))
      expect((await f.disk()).threadDrafts).toEqual([])
      if (stage === 'failed') {
        release()
        await waitFor(() => expect(store.snapshot('workshop').save).toBe('unsaved'))
      }
      view.rerender(page(false))
      // Unrelated state can echo the in-memory draft while the page is absent.
      await act(async () => { await controls.command({ type: 'voice-state', status: 'off', error: null }) })
      view.rerender(page(true))
      expect(controls.threadDrafts).toBe(store)
      expect(screen.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('Keep this unsaved draft')
      expect(screen.getByRole('img', { name: 'pixel.png' })).toBeVisible()
      if (stage === 'pending') {
        expect(screen.getByText('Saving draft…')).toBeVisible()
        release()
      }
      await screen.findByRole('button', { name: 'Save again' })
      expect((await f.disk()).threadDrafts).toEqual([])
      spy.mockRestore()
      fireEvent.click(screen.getByRole('button', { name: 'Save again' }))
      await screen.findByText('Draft saved')
      expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: 'workshop', text: 'Keep this unsaved draft', attachments: [image] }))
    } finally { release(); spy?.mockRestore(); await f.close() }
  })

  it('isolates draft state and late IPC completions when the connection changes profiles', async () => {
    const f = await draftFixture()
    let finish!: (state: AgentState) => void
    const oldBridge: AgentBridge = { ...f.bridge, command: () => new Promise(done => { finish = done }) }
    const { result, rerender } = renderHook(({ bridge }) => useAgentConnection(bridge), { initialProps: { bridge: oldBridge } })
    try {
      await waitFor(() => expect(result.current.state).not.toBeNull())
      const oldStore = result.current.threadDrafts
      act(() => { oldStore.edit('workshop', { text: 'Private old profile draft' }); oldStore.flush('workshop') })
      const nextState = { ...f.control.get(), threadDrafts: [] }
      const nextBridge: AgentBridge = { get: async () => nextState, onState: () => () => undefined, command: vi.fn(async () => nextState) }
      rerender({ bridge: nextBridge })
      await waitFor(() => expect(result.current.state).toBe(nextState))
      expect(result.current.threadDrafts).not.toBe(oldStore)
      await act(async () => { finish({ ...nextState, error: 'Old save failed', threadDrafts: [{ threadId: 'workshop', ...oldStore.draft('workshop'), updatedAt: new Date().toISOString() }] }) })
      expect(oldStore.snapshot('workshop').save).toBe('unsaved')
      expect(result.current.threadDrafts.draft('workshop').text).toBe('')
      expect(result.current.state).toBe(nextState)
      expect(result.current.error).toBeNull()
      expect(nextBridge.command).not.toHaveBeenCalled()
    } finally { await f.close() }
  })
})

describe('thread navigation through the real renderer connection and controller', () => {
  it('persists a newer draft while a different thread waits for provider acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-navigation-connection-'))
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-navigation-connection-')) throw new Error('Unexpected fixture directory')
    const host = new E2EAgentHost()
    const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: value => Buffer.from(value), decryptString: value => value.toString() })
    const control = new AgentControl({ directory: root, host, credentials, reasoner: e2eAgentReasoner,
      membership: { status: async () => ({ status: 'beta', label: 'Test', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Test', expiresAt: null }) } })
    let release!: () => void
    const gate = new Promise<void>(done => { release = done })
    let sending: Promise<AgentState | null> | undefined
    let saving: Promise<AgentState | null> | undefined
    try {
      await credentials.load(); await control.start(); await control.command({ type: 'connect' })
      const execute = host.execute.bind(host)
      vi.spyOn(host, 'execute').mockImplementation(async command => { if (command.type === 'send') await gate; return execute(command) })
      const bridge: AgentBridge = { get: async () => control.get(), onState: listener => control.subscribe(listener), command: command => control.command(command) }
      const { result } = renderHook(() => useAgentConnection(bridge))
      await waitFor(() => expect(result.current.state).not.toBeNull())
      act(() => { sending = result.current.command({ type: 'manual-send', threadId: 'workshop', draftId: randomUUID(), text: 'Pending provider acknowledgement.' }) })
      await waitFor(() => expect(result.current.state?.deliveries?.at(-1)?.status).toBe('submitting'))
      const revision = randomUUID()
      act(() => { saving = result.current.command({ type: 'save-thread-draft', threadId: 'docs', draftId: revision, text: 'Continue drafting while Workshop sends.' }) })
      await waitFor(() => expect(control.get().threadDrafts).toEqual(expect.arrayContaining([
        expect.objectContaining({ threadId: 'docs', draftId: revision, text: 'Continue drafting while Workshop sends.' }),
      ])))
      await act(async () => { await saving })
      expect(control.get().deliveries?.at(-1)?.status).toBe('submitting')
      await act(async () => { release(); await sending })
      expect(control.get().threadDrafts?.find(draft => draft.threadId === 'docs')?.text).toBe('Continue drafting while Workshop sends.')
    } finally {
      await act(async () => { release(); await sending; await saving })
      cleanup(); control.dispose(); await control.privacyChanged()
      await rm(root, { recursive: true, force: true })
    }
  })

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
