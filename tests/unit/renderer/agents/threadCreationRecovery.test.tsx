import { setPromptText, promptText } from '../helpers/promptEditor'
import { deferred } from '../../../fixtures/deferred'
import { connection, connectionStores, NOW, renderThreads, stateFixture } from '../../../fixtures/renderer/threadsViewHarness'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { useAgents } from '../../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../../src/renderer/src/agents/ThreadsView'
import { draftThreads } from '../../../../src/renderer/src/agents/draftThreads'
import { type AgentCommand, type AgentState } from '../../../../src/shared/agents'
import { handleOf } from '../../../fixtures/stagedImages'

describe('a thread created without a round trip', () => {
  afterEach(() => draftThreads.reset())

  /** Press the pen on the workshop project row: no dialog, the thread opens on defaults at once (issue #347). */
  function createThread(): void {
    fireEvent.click(screen.getByRole('button', { name: 'New thread in workshop' }))
  }
  const createRequest = (command: { mock: { calls: unknown[][] } }): (AgentCommand & { threadId?: string }) | undefined =>
    command.mock.calls.map(([request]) => request as AgentCommand).find(request => request.type === 'create-thread') as (AgentCommand & { threadId?: string }) | undefined

  it('shows the pane and its composer before main answers, and keeps a draft typed meanwhile', async () => {
    const state = stateFixture()
    const { promise: creating, resolve: settle } = deferred<AgentState>()
    const command = vi.fn(async (...args: unknown[]) => {
      const request = args[0] as AgentCommand
      return request.type === 'create-thread' ? creating : state
    })
    const observed: string[][] = []
    const view = (): React.ReactElement => <ThreadsView now={NOW} onPaneThreadsChange={ids => observed.push([...ids])} />
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    const { rerender } = render(view())
    createThread()
    // Nothing is typed and no dialog opens: the thread is on screen, named and focused, before main answers.
    expect(screen.queryByRole('dialog', { name: 'New thread' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible())
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeEnabled()
    const request = await waitFor(() => { const found = createRequest(command); expect(found).toBeDefined(); return found! })
    expect(request).toMatchObject({ type: 'create-thread', projectId: 'workshop', title: 'New thread', titleSource: 'default', threadId: expect.any(String) })
    const threadId = request.threadId!
    setPromptText(screen.getByRole('textbox', { name: 'Prompt' }), 'Start on the failing test.')
    const arrived: AgentState['host']['threads'][number] = { id: threadId, projectId: 'workshop', title: 'New thread', modelId: 'claude:sonnet',
      status: 'idle', messages: [], requests: [], nativeSessionStarted: false, worktree: { mode: 'independent', status: 'ready', path: 'C:/workshop-1' } }
    const published: AgentState = { ...state, activeThreadId: threadId, host: { ...state.host, threads: [...state.host.threads, arrived] } }
    // Until main has the thread, naming it to main would say nothing, so the panes reported exclude it.
    expect(observed.flat()).not.toContain(threadId)
    await act(async () => { settle(published) })
    vi.mocked(useAgents).mockReturnValue(connection(published, command))
    rerender(view())
    // Main's own record replaces the local one; the thread is listed once and the draft is untouched.
    await waitFor(() => expect(draftThreads.get()).toEqual([]))
    rerender(view())
    expect(observed.at(-1)).toEqual([threadId])
    expect(within(screen.getByRole('region', { name: 'Projects' })).getAllByRole('button', { name: 'New thread' })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible()
    expect(promptText(screen.getByRole('textbox', { name: 'Prompt' }))).toBe('Start on the failing test.')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the refusal in the sidebar and takes the thread away again without repeating the creation', async () => {
    const state = stateFixture()
    const command = vi.fn(async (...args: unknown[]) => {
      const request = args[0] as AgentCommand
      return request.type === 'create-thread' ? { ...state, error: 'Send or clear your draft before creating another thread.' } : state
    })
    renderThreads(state, command)
    createThread()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible())
    expect(screen.queryByRole('dialog', { name: 'New thread' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Send or clear your draft before creating another thread.'))
    expect(screen.getByRole('alert')).not.toHaveTextContent('are kept')
    expect(screen.queryByRole('heading', { name: 'New thread' })).not.toBeInTheDocument()
    expect(draftThreads.get()).toEqual([])
    // The selection returns to the thread that had it, and creation is never repeated on its own.
    expect(screen.getByRole('heading', { name: 'Visual gate flake' })).toBeVisible()
    expect(command.mock.calls.filter(([request]) => (request as AgentCommand).type === 'create-thread')).toHaveLength(1)
  })

  it.each(['unsent', 'sent', 'sent with newer typing', 'sent with overflow', 'sent after navigation', 'sent into reused thread'])('recovers the %s prompt and staged images after creation is refused', async mode => {
    const state = stateFixture()
    const { promise: refusing, resolve: settle } = deferred<AgentState>()
    let creations = 0
    const command = vi.fn(async (...args: unknown[]) => {
      const request = args[0] as AgentCommand
      return request.type === 'create-thread' && ++creations === 1 ? refusing : state
    })
    const view = renderThreads(state, command)
    createThread()
    await screen.findByRole('heading', { name: 'New thread' })
    const firstId = createRequest(command)!.threadId!
    const newThread = draftThreads.get().find(thread => thread.id === firstId)!
    const store = connectionStores.get(command)!
    const image = handleOf(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'recover-image', 'recover.png')
    const images = mode === 'sent with overflow' ? Array.from({ length: 8 }, (_, index) => ({ ...image, id: `recover-${index}`, name: `recover-${index}.png` })) : [image]
    act(() => store.edit(firstId, { text: 'Keep this prompt.', attachments: images }))
    if (mode !== 'unsent') fireEvent.click(screen.getByRole('button', { name: 'Send prompt' }))
    if (mode === 'sent with newer typing' || mode === 'sent with overflow') {
      act(() => store.edit(firstId, { text: 'And this next thought.', attachments: [{ ...image, id: 'newer-image', name: 'newer.png' }] }))
    }
    await act(async () => { settle({ ...state, error: 'That model is unavailable.' }) })
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('That model is unavailable. Your prompt and screenshots are kept. Open New thread in workshop to get them back.')
    expect(screen.queryByRole('heading', { name: 'New thread' })).not.toBeInTheDocument()
    if (mode === 'sent after navigation') { view.unmount(); renderThreads(state, command) }
    if (mode === 'sent into reused thread') {
      const reusedState: AgentState = { ...state, activeThreadId: 'reusable', host: { ...state.host, threads: [...state.host.threads, { ...newThread, id: 'reusable', titleSource: 'default' }] } }
      act(() => store.edit('reusable', { text: 'Already here.' }))
      vi.mocked(useAgents).mockReturnValue(connection(reusedState, command))
      view.rerender(<ThreadsView now={NOW} />)
    }
    createThread()
    await screen.findByRole('heading', { name: 'New thread' })
    const requests = command.mock.calls.map(([request]) => request as AgentCommand).filter(request => request.type === 'create-thread')
    const nextId = mode === 'sent into reused thread' ? 'reusable' : (requests[1] as Extract<AgentCommand, { type: 'create-thread' }>).threadId!
    expect(requests).toHaveLength(mode === 'sent into reused thread' ? 1 : 2)
    expect(store.draft(nextId).text).toBe(mode === 'sent with newer typing' ? 'Keep this prompt.\n\nAnd this next thought.' : mode === 'sent into reused thread' ? 'Keep this prompt.\n\nAlready here.' : 'Keep this prompt.')
    expect(store.draft(nextId).attachments.map(attachment => attachment.name)).toEqual(mode === 'sent with newer typing' ? ['recover.png', 'newer.png'] : images.map(image => image.name))
    if (mode === 'sent with overflow') {
      expect(screen.getAllByRole('status').some(status => status.textContent === 'Not sent')).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Restore prompt' }))
      expect(promptText(screen.getByRole('textbox', { name: 'Prompt' }))).toBe('And this next thought.')
      expect(store.draft(nextId).attachments.map(attachment => attachment.name)).toEqual(['newer.png'])
      fireEvent.click(screen.getByRole('button', { name: 'Restore prompt' }))
      expect(promptText(screen.getByRole('textbox', { name: 'Prompt' }))).toBe('Keep this prompt.')
      expect(store.draft(nextId).attachments).toEqual(images)
    }
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send' }))
  })

  it('does not recover a sent prompt when published creation precedes a lost command reply', async () => {
    const state = stateFixture()
    const { promise: creating, resolve: settle } = deferred<AgentState | null>()
    const command = vi.fn(async (...args: unknown[]) => (args[0] as AgentCommand).type === 'create-thread' ? creating : state)
    vi.mocked(useAgents).mockReturnValue(connection(state, command))
    const { rerender } = render(<ThreadsView now={NOW} />)
    createThread()
    await screen.findByRole('heading', { name: 'New thread' })
    const threadId = createRequest(command)!.threadId!
    const arrived = { ...draftThreads.get()[0]!, nativeSessionStarted: true }
    const published = { ...state, activeThreadId: threadId, host: { ...state.host, threads: [...state.host.threads, arrived] } }
    const connected = connection(published, command)
    vi.mocked(useAgents).mockReturnValue(connected)
    rerender(<ThreadsView now={NOW} />)
    await waitFor(() => expect(draftThreads.get()).toEqual([]))
    connected.threadDrafts.edit(threadId, { text: 'Already sent to the live thread.' })
    connected.threadDrafts.submit(threadId, NOW)
    await act(async () => { settle(null) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    connected.threadDrafts.restoreRefusedCreation('another-thread', 'workshop')
    expect(connected.threadDrafts.draft('another-thread').text).toBe('')
  })

  it.each([false, true])('keeps a screenshot whose staging finishes after refusal (after reopening: %s)', async reopenFirst => {
    const state = stateFixture()
    state.host.models.forEach(model => { model.supportsImages = true })
    const { promise: creating, resolve: refuse } = deferred<AgentState>()
    let creations = 0
    const command = vi.fn(async (...args: unknown[]) => (args[0] as AgentCommand).type === 'create-thread' && ++creations === 1 ? creating : state)
    let finishStaging: (handle: ReturnType<typeof handleOf>) => void = () => undefined
    const stageAttachment = vi.fn(() => { const pending = deferred<ReturnType<typeof handleOf>>(); finishStaging = pending.resolve; return pending.promise })
    vi.stubGlobal('sotto', { agents: { stageAttachment } })
    onTestFinished(() => { vi.unstubAllGlobals() })
    renderThreads(state, command)
    createThread()
    await screen.findByRole('heading', { name: 'New thread' })
    setPromptText(screen.getByRole('textbox', { name: 'Prompt' }), 'Keep the pending screenshot.')
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [new File([bytes], 'late.png', { type: 'image/png' })] } })
    await waitFor(() => expect(stageAttachment).toHaveBeenCalledOnce())
    await act(async () => { refuse({ ...state, error: 'That model is unavailable.' }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Your prompt and screenshots are kept. Open New thread in workshop to get them back.')
    await screen.findByRole('alert')
    if (reopenFirst) {
      createThread()
      await screen.findByRole('heading', { name: 'New thread' })
      expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    }
    await act(async () => { finishStaging(handleOf(bytes, 'late', 'late.png')) })
    if (!reopenFirst) { createThread(); await screen.findByRole('heading', { name: 'New thread' }) }
    await waitFor(() => expect(screen.getByRole('img', { name: 'late.png' })).toBeVisible())
    expect(promptText(screen.getByRole('textbox', { name: 'Prompt' }))).toBe('Keep the pending screenshot.')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled())
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send' }))
  })

  it('carries text typed before a refusal to the next new thread opened in the same project', async () => {
    const state = stateFixture()
    const { promise: refusing, resolve: settle } = deferred<AgentState>()
    let creations = 0
    const command = vi.fn(async (...args: unknown[]) => {
      const request = args[0] as AgentCommand
      if (request.type !== 'create-thread') return state
      creations += 1
      return creations === 1 ? refusing : state
    })
    renderThreads(state, command)
    createThread()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible())
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBeEnabled()
    setPromptText(screen.getByRole('textbox', { name: 'Prompt' }), 'Do not lose this.')
    await act(async () => { settle({ ...state, error: 'Send or clear your draft before creating another thread.' }) })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Send or clear your draft before creating another thread.'))
    expect(screen.queryByRole('heading', { name: 'New thread' })).not.toBeInTheDocument()
    // The refused draft's own pane is gone, but its text opens with the project's next new thread.
    createThread()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New thread' })).toBeVisible())
    expect(promptText(screen.getByRole('textbox', { name: 'Prompt' }))).toBe('Do not lose this.')
  })
})
