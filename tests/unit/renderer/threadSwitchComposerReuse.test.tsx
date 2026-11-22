import React, { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, SCREENSHOT_WRONG_TYPE, type AgentCommand, type AgentHostSnapshot, type AgentState, type AgentThread } from '../../../src/shared/agents'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { SplitLayoutStore } from '../../../src/renderer/src/agents/splitLayout'
import type { PromptEditorElement } from '../../../src/renderer/src/agents/promptSelection'
import { agentContextFixture } from '../../fixtures/agentContext'
import { deferred } from '../../fixtures/deferred'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const composerLifecycle = vi.hoisted(() => ({ mounts: 0, updates: 0 }))
vi.mock('../../../src/renderer/src/agents/ThreadComposer', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/agents/ThreadComposer')>()
  return {
    ...actual,
    ThreadComposer: (props: Parameters<typeof actual.ThreadComposer>[0]) => (
      <Profiler
        id="composer"
        onRender={(_id, phase) => {
          if (phase === 'mount') composerLifecycle.mounts += 1
          else composerLifecycle.updates += 1
        }}
      >
        <actual.ThreadComposer {...props} />
      </Profiler>
    ),
  }
})

const NOW = Date.parse('2026-11-22T18:30:00Z')

function twoThreadState(): { state: AgentState; first: AgentThread; second: AgentThread } {
  const project = { id: 'project-0', title: 'Sotto', path: 'C:/workspace/sotto', providerId: 'claude' as const }
  const models: AgentHostSnapshot['models'] = [
    { id: 'claude:sonnet', name: 'Claude Sonnet', provider: 'Claude Code', providerId: 'claude', ready: true, supportsImages: true, defaultReasoningEffort: 'medium', reasoningEfforts: ['low', 'medium', 'high'] },
  ]
  const make = (id: string, title: string): AgentThread => ({
    id,
    title,
    projectId: project.id,
    providerId: 'claude',
    modelId: 'claude:sonnet',
    status: 'idle',
    updatedAt: new Date(NOW).toISOString(),
    messages: [{ id: `${id}-m1`, role: 'assistant', text: `History for ${title}`, createdAt: new Date(NOW).toISOString() }],
    requests: [],
    summary: { messageCount: 1, activityCount: 0, lastMessageAt: new Date(NOW).toISOString() },
  })
  const first = make('alpha', 'Alpha thread')
  const second = make('beta', 'Beta thread')
  const state: AgentState = {
    configuration: { ...defaultAgentConfiguration(), enabled: true },
    connection: 'connected',
    host: {
      ...EMPTY_AGENT_HOST,
      hostId: 'laptop',
      connected: true,
      capabilities: { ...EMPTY_AGENT_HOST.capabilities, threads: true, submit: true, steer: true, interrupt: true, configureThread: true, skills: true },
      projects: [project],
      models,
      threads: [first, second],
    },
    activeThreadId: first.id,
    activeProjectId: project.id,
    draft: '',
    draftThreadId: null,
    draftAttachments: [],
    draftRequestId: null,
    threadDrafts: [
      { threadId: first.id, draftId: 'draft-alpha', text: 'Draft on alpha', attachments: [], requestId: null, updatedAt: new Date(NOW).toISOString() },
      { threadId: second.id, draftId: 'draft-beta', text: 'Draft on beta', attachments: [], requestId: null, updatedAt: new Date(NOW).toISOString() },
    ],
    composing: false,
    globalLaneBusy: false,
    busyThreadIds: [],
    credentials: { reasoning: false, secure: false },
    reasoningAccounts: [],
    historyEnabled: true,
    notice: '',
    error: null,
  }
  return { state, first, second }
}

afterEach(() => {
  cleanup()
  composerLifecycle.mounts = 0
  composerLifecycle.updates = 0
  vi.restoreAllMocks()
})

describe('optimistic sidebar open and ThreadComposer reuse across switches (#2733)', () => {
  it('switches the displayed pane optimistically on sidebar click before select-thread resolves and keeps ThreadComposer mounted', async () => {
    const { state: initial, first, second } = twoThreadState()
    let state = initial
    const pendingSelect = deferred<AgentState>()
    const command = vi.fn(async (request: AgentCommand) => {
      if (request.type === 'select-thread' && request.threadId === second.id) return pendingSelect.promise
      return state
    })
    const store = new ThreadDraftStore(command)
    store.receive(state)
    vi.mocked(useAgents).mockImplementation(() => agentContextFixture(state, command, { threadDrafts: store }))

    const layoutStore = new SplitLayoutStore()
    const rendered = render(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />)

    expect(composerLifecycle.mounts).toBe(1)
    expect(document.querySelector('.thread-pane')?.getAttribute('data-thread-id')).toBe(first.id)
    expect(document.querySelector<PromptEditorElement>('.prompt-editor')?.dataset.promptText).toBe('Draft on alpha')

    // Expand the project folder and click Beta in the sidebar while select-thread is still unresolved.
    fireEvent.click(screen.getByRole('button', { name: /Sotto 2 threads/iu }))
    fireEvent.click(screen.getByRole('button', { name: 'Beta thread' }))

    // The pane and composer switch immediately without waiting for the engine round-trip or remounting ThreadComposer.
    expect(document.querySelector('.thread-pane')?.getAttribute('data-thread-id')).toBe(second.id)
    expect(document.querySelector<PromptEditorElement>('.prompt-editor')?.dataset.promptText).toBe('Draft on beta')
    expect(screen.getByText('History for Beta thread')).toBeVisible()
    expect(composerLifecycle.mounts).toBe(1)
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: second.id })

    // Once main confirms, state stays on Beta with still only 1 ThreadComposer mount.
    state = { ...state, activeThreadId: second.id }
    await act(async () => {
      pendingSelect.resolve(state)
      rendered.rerender(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />)
    })
    expect(document.querySelector('.thread-pane')?.getAttribute('data-thread-id')).toBe(second.id)
    expect(composerLifecycle.mounts).toBe(1)
  })

  it('reverts optimistic pending selection if main does not accept the switch on the next published state', async () => {
    const { state: initial, first, second } = twoThreadState()
    let state = initial
    const pendingSelect = deferred<AgentState>()
    const command = vi.fn(async (request: AgentCommand) => {
      if (request.type === 'select-thread' && request.threadId === second.id) return pendingSelect.promise
      return state
    })
    const store = new ThreadDraftStore(command)
    store.receive(state)
    vi.mocked(useAgents).mockImplementation(() => agentContextFixture(state, command, { threadDrafts: store }))

    const layoutStore = new SplitLayoutStore()
    const rendered = render(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />)

    fireEvent.click(screen.getByRole('button', { name: /Sotto 2 threads/iu }))
    fireEvent.click(screen.getByRole('button', { name: 'Beta thread' }))
    expect(document.querySelector('.thread-pane')?.getAttribute('data-thread-id')).toBe(second.id)

    // Main rejects / answers without changing activeThreadId, then a new state publishes.
    await act(async () => { pendingSelect.resolve(state) })
    state = { ...state, notice: 'Could not switch' }
    act(() => { rendered.rerender(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />) })

    await waitFor(() => expect(document.querySelector('.thread-pane')?.getAttribute('data-thread-id')).toBe(first.id))
    expect(composerLifecycle.mounts).toBe(1)
  })

  it('keeps ThreadComposer mounted across repeated switches while preserving each thread’s draft and resetting transient composer errors', async () => {
    const { state: initial, first, second } = twoThreadState()
    let state = initial
    const command = vi.fn(async (request: AgentCommand) => {
      if (request.type === 'select-thread') state = { ...state, activeThreadId: request.threadId }
      return state
    })
    const store = new ThreadDraftStore(command)
    store.receive(state)
    vi.mocked(useAgents).mockImplementation(() => agentContextFixture(state, command, { threadDrafts: store }))

    const layoutStore = new SplitLayoutStore()
    const rendered = render(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />)

    // Trigger a screenshot refusal on Alpha (wrong file type), then switch to Beta and verify the error clears.
    fireEvent.change(screen.getByLabelText('Screenshot files'), {
      target: { files: [new File(['hello'], 'notes.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByText(SCREENSHOT_WRONG_TYPE)).toBeVisible()

    for (let step = 0; step < 6; step++) {
      const target = step % 2 === 0 ? second : first
      state = { ...state, activeThreadId: target.id }
      act(() => { rendered.rerender(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />) })
      expect(document.querySelector<PromptEditorElement>('.prompt-editor')?.dataset.promptText).toBe(
        target.id === first.id ? 'Draft on alpha' : 'Draft on beta',
      )
      expect(screen.queryByText(SCREENSHOT_WRONG_TYPE)).not.toBeInTheDocument()
    }

    expect(composerLifecycle.mounts).toBe(1)
    expect(composerLifecycle.updates).toBeGreaterThanOrEqual(6)
  })
})
