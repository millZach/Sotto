import React, { Profiler, useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultAgentConfiguration, EMPTY_AGENT_HOST, RESTORE_BRANCH_NEEDS_CONFIRMATION, SCREENSHOT_WRONG_TYPE,
  type AgentAttachmentHandle, type AgentAttachmentStageRequest, type AgentCommand, type AgentHostSnapshot, type AgentState, type AgentThread,
} from '../../../src/shared/agents'
import type { FileListing, FilesBridge, FilesResult } from '../../../src/shared/files'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { useFilePicker } from '../../../src/renderer/src/agents/FilePicker'
import { ReplyAttachContext, type ReplyAttachSlot } from '../../../src/renderer/src/agents/replyAttach'
import { ScreenshotInput } from '../../../src/renderer/src/agents/ScreenshotInput'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore, type ScreenshotReadPort } from '../../../src/renderer/src/agents/threadDraftStore'
import { SplitLayoutStore } from '../../../src/renderer/src/agents/splitLayout'
import type { PromptEditorElement } from '../../../src/renderer/src/agents/promptSelection'
import { agentContextFixture } from '../../fixtures/agentContext'
import { deferred } from '../../fixtures/deferred'
import { handleOf } from '../../fixtures/stagedImages'

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
  vi.unstubAllGlobals()
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

  it('reverts optimistic pending selection immediately when select-thread returns null or rejects without a follow-up publication', async () => {
    const { state: initial, first, second } = twoThreadState()
    const pendingNull = deferred<AgentState | null>()
    const pendingReject = deferred<AgentState | null>()
    let calls = 0
    const command = vi.fn(async (request: AgentCommand) => {
      if (request.type === 'select-thread' && request.threadId === second.id) {
        calls += 1
        return calls === 1 ? pendingNull.promise : pendingReject.promise
      }
      return initial
    })
    const store = new ThreadDraftStore(command)
    store.receive(initial)
    vi.mocked(useAgents).mockImplementation(() => agentContextFixture(initial, command, { threadDrafts: store }))

    const layoutStore = new SplitLayoutStore()
    render(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />)
    fireEvent.click(screen.getByRole('button', { name: /Sotto 2 threads/iu }))

    // First click: command resolves to null with NO follow-up state publication.
    fireEvent.click(screen.getByRole('button', { name: 'Beta thread' }))
    expect(document.querySelector('.thread-pane')?.getAttribute('data-thread-id')).toBe(second.id)
    await act(async () => { pendingNull.resolve(null) })
    await waitFor(() => expect(document.querySelector('.thread-pane')?.getAttribute('data-thread-id')).toBe(first.id))

    // Second click: command rejects with NO follow-up state publication.
    fireEvent.click(screen.getByRole('button', { name: 'Beta thread' }))
    expect(document.querySelector('.thread-pane')?.getAttribute('data-thread-id')).toBe(second.id)
    await act(async () => { pendingReject.reject(new Error('bridge lost')); await Promise.resolve() })
    await waitFor(() => expect(document.querySelector('.thread-pane')?.getAttribute('data-thread-id')).toBe(first.id))
    expect(composerLifecycle.mounts).toBe(1)
  })

  it('does not carry branch-restore confirmations, Git action results/locks, or follow-up arrival announcements across thread switches', async () => {
    const { state: base, first, second } = twoThreadState()
    const sharedWorktree = (sentBranch: string) => ({
      mode: 'shared' as const,
      status: 'ready' as const,
      path: 'C:/workspace/sotto',
      repositoryRoot: 'C:/workspace/sotto',
      branch: 'other-branch',
      sentBranch,
      dirty: false,
      git: {
        isRepository: true,
        branch: 'other-branch',
        upstream: 'origin/other-branch',
        hasRemote: true,
        defaultBranch: 'main',
        isDefaultBranch: false,
        dirty: false,
        changedFiles: 0,
        insertions: 0,
        deletions: 0,
        ahead: 0,
        behind: 2,
        aheadOfDefault: 0,
        pullRequest: null,
        fetchedAt: null,
        readAt: new Date(NOW).toISOString(),
      },
    })
    const alpha: AgentThread = { ...first, worktree: sharedWorktree('feat/alpha') }
    const beta: AgentThread = { ...second, worktree: sharedWorktree('feat/beta') }
    let state: AgentState = {
      ...base,
      host: { ...base.host, threads: [alpha, beta] },
      followups: [
        { id: 'f-alpha', threadId: alpha.id, draftId: 'df-a', text: 'Alpha queued words', attachments: [], createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), status: 'queued' },
        { id: 'f-beta', threadId: beta.id, draftId: 'df-b', text: 'Beta queued words', attachments: [], createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), status: 'queued' },
      ],
    }

    const restoreGate = deferred<AgentState>()
    const gitGate = deferred<AgentState>()
    const gitActionThreads: string[] = []
    const command = vi.fn(async (request: AgentCommand) => {
      if (request.type === 'restore-thread-branch') return restoreGate.promise
      if (request.type === 'git-pull') {
        gitActionThreads.push(request.threadId)
        if (request.threadId === alpha.id) return gitGate.promise
        return state
      }
      return state
    })
    const store = new ThreadDraftStore(command)
    store.receive(state)
    vi.mocked(useAgents).mockImplementation(() => agentContextFixture(state, command, { threadDrafts: store }))

    const layoutStore = new SplitLayoutStore()
    const rendered = render(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />)

    // Start both a branch restore and a Git Pull on Alpha.
    fireEvent.click(screen.getByRole('button', { name: 'Restore branch feat/alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pull' }))
    expect(gitActionThreads).toEqual([alpha.id])

    // Switch to Beta while both commands on Alpha are still in flight.
    state = { ...state, activeThreadId: beta.id }
    act(() => { rendered.rerender(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />) })

    // Resolve Alpha's branch restore with confirmation-required and Alpha's Pull as succeeded.
    await act(async () => {
      restoreGate.resolve({ ...state, error: RESTORE_BRANCH_NEEDS_CONFIRMATION })
      gitGate.resolve({ ...state, notice: 'Pulled from origin' })
    })

    // Beta must NOT show Alpha's confirmation dialog or Pull notice, must NOT announce Beta's existing follow-up as newly queued,
    // and Beta's own Pull button must NOT be blocked by Alpha's flight lock.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Pulled from origin')).not.toBeInTheDocument()
    expect(screen.queryByText(/Queued:\s*Beta queued words/u)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pull' }))
    expect(gitActionThreads).toEqual([alpha.id, beta.id])
    expect(composerLifecycle.mounts).toBe(1)
  })

  it('keeps popup photos staged across target and errorScope changes when reads has no addLate, and routes post-switch markup Add to the origin thread', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const stageGate = deferred<AgentAttachmentHandle>()
    const stageCalls: AgentAttachmentStageRequest[] = []
    vi.stubGlobal('sotto', {
      agents: {
        stageAttachment: vi.fn((request: AgentAttachmentStageRequest) => {
          stageCalls.push(request)
          if (stageCalls.length === 1) return stageGate.promise
          return Promise.resolve(handleOf(request.bytes, `staged-${stageCalls.length}`, request.name, request.mimeType))
        }),
      },
    })

    // Part 1: Popup ScreenshotInput (reads without addLate) preserves in-flight staging across errorScope and target changes.
    const popupChange = vi.fn()
    const popupReads: ScreenshotReadPort = { pending: false, problem: null, begin: vi.fn(() => () => undefined) }
    const popup = render(
      <ScreenshotInput target="alpha" errorScope={0} attachments={[]} onChange={popupChange} reads={popupReads} disabled={false} supported>
        <textarea aria-label="Popup prompt" />
      </ScreenshotInput>,
    )
    fireEvent.change(screen.getByLabelText('Screenshot files'), {
      target: { files: [new File([pngBytes], 'popup.png', { type: 'image/png' })] },
    })
    expect(screen.getByText('Adding screenshots...')).toBeVisible()

    // Re-showing the popup changes errorScope; busy guard stays active.
    popup.rerender(
      <ScreenshotInput target="alpha" errorScope={1} attachments={[]} onChange={popupChange} reads={popupReads} disabled={false} supported>
        <textarea aria-label="Popup prompt" />
      </ScreenshotInput>,
    )
    expect(screen.getByText('Adding screenshots...')).toBeVisible()

    // Moving the popup target ("Ask Watcher") mid-read must still deliver the staged photo to popupChange.
    popup.rerender(
      <ScreenshotInput target={null} errorScope={1} attachments={[]} onChange={popupChange} reads={popupReads} disabled={false} supported>
        <textarea aria-label="Popup prompt" />
      </ScreenshotInput>,
    )
    const popupHandle = handleOf(pngBytes, 'staged-popup', 'popup.png', 'image/png')
    await act(async () => { stageGate.resolve(popupHandle) })
    await waitFor(() => expect(popupChange).toHaveBeenCalledWith([popupHandle]))
    popup.unmount()

    // Part 2: Markup editor Add resolving after switching from Alpha to Beta routes to Alpha's addLate, never Beta's draft.
    const slot: ReplyAttachSlot = { current: null }
    const readsA: ScreenshotReadPort = { pending: false, problem: null, begin: vi.fn(() => () => undefined), addLate: vi.fn() }
    const readsB: ScreenshotReadPort = { pending: false, problem: null, begin: vi.fn(() => () => undefined), addLate: vi.fn() }
    const changeB = vi.fn()
    const composer = render(
      <ReplyAttachContext.Provider value={slot}>
        <ScreenshotInput target="alpha" attachments={[]} onChange={vi.fn()} reads={readsA} disabled={false} supported>
          <textarea aria-label="Composer prompt" />
        </ScreenshotInput>
      </ReplyAttachContext.Provider>,
    )
    const entryA = slot.current!
    expect(entryA).not.toBeNull()

    composer.rerender(
      <ReplyAttachContext.Provider value={slot}>
        <ScreenshotInput target="beta" attachments={[]} onChange={changeB} reads={readsB} disabled={false} supported>
          <textarea aria-label="Composer prompt" />
        </ScreenshotInput>
      </ReplyAttachContext.Provider>,
    )

    await act(async () => {
      await entryA.add([new File([pngBytes], 'marked.png', { type: 'image/png' })])
    })
    expect(stageCalls.at(-1)?.threadId).toBe('alpha')
    expect(readsA.addLate).toHaveBeenCalledWith([expect.objectContaining({ name: 'marked.png' })], null)
    expect(readsB.addLate).not.toHaveBeenCalled()
    expect(changeB).not.toHaveBeenCalled()
  })

  it('drops stale FilePicker folder listings from an earlier thread so they never overwrite the active thread catalog', async () => {
    const listA = deferred<FilesResult<FileListing>>()
    const list = vi.fn(async ({ threadId }: { threadId: string; path: string }): Promise<FilesResult<FileListing>> => {
      if (threadId === 'alpha') return listA.promise
      return {
        ok: true,
        value: {
          workspace: { threadId: 'beta', projectId: 'project-0', workingDirectory: 'C:/workspace/sotto', workspaceId: 'ws-beta' },
          path: '',
          entries: [{ name: 'beta.ts', path: 'beta.ts', kind: 'file' }],
          truncated: false,
        },
      }
    })
    const bridge = { list } as unknown as FilesBridge

    function PickerHarness({ threadId }: { readonly threadId: string }) {
      const [text] = useState('@')
      const model = useFilePicker({ threadId, bridge, enabled: true, text })
      const track = model.track
      useEffect(() => { track({ selectionStart: 1, selectionEnd: 1 } as never) }, [threadId, track])
      return <output data-testid="files">{model.options.map(entry => entry.path).join(',')}</output>
    }

    const view = render(<PickerHarness threadId="alpha" />)
    await waitFor(() => expect(list).toHaveBeenCalledWith({ threadId: 'alpha', path: '' }))

    view.rerender(<PickerHarness threadId="beta" />)
    await waitFor(() => expect(screen.getByTestId('files')).toHaveTextContent('beta.ts'))
    const betaCallsBefore = list.mock.calls.filter(([arg]) => arg.threadId === 'beta').length

    // Resolving Alpha's stale listing must not replace Beta's catalog or trigger a repeat fetch for Beta.
    await act(async () => {
      listA.resolve({
        ok: true,
        value: {
          workspace: { threadId: 'alpha', projectId: 'project-0', workingDirectory: 'C:/workspace/sotto', workspaceId: 'ws-alpha' },
          path: '',
          entries: [{ name: 'alpha.ts', path: 'alpha.ts', kind: 'file' }],
          truncated: false,
        },
      })
    })
    expect(screen.getByTestId('files')).toHaveTextContent('beta.ts')
    expect(list.mock.calls.filter(([arg]) => arg.threadId === 'beta').length).toBe(betaCallsBefore)
  })
})
