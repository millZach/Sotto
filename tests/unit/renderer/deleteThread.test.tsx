import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentClientHost, AgentCommand, AgentState, AgentThread, ThreadDeletePreview, WorktreeReclaimPreview } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { offersThreadDelete } from '../../../src/renderer/src/agents/DeleteThread'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'
import { openPaneMenu, paneMenuItems } from '../../fixtures/renderer/paneMenu'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

/**
 * Delete thread… in a settled thread's pane menu (ADR-0140; Owl only): offered last, only on a thread settled on its own or
 * with its project, off with a reason for a paired host that cannot delete yet, and a dialog that asks main first.
 */
const THREAD = 'old-settled'
const HOST = '6f1c2a5e-7d3b-4c9a-9f10-2b7e4d1a0c11'
const at = (days: number): string => new Date(E2E_THREADS_NOW - days * 86_400_000).toISOString()

function settled(patch: Partial<AgentThread> = {}): AgentThread {
  return { id: THREAD, projectId: 'workshop', title: 'Move the cleanup rules', modelId: 'claude:sonnet', providerId: 'claude', status: 'idle', requests: [],
    messages: [{ id: 'first', role: 'user', text: 'Move the cleanup rules to Git & worktrees.', createdAt: at(41) }],
    activities: [], updatedAt: at(41), workspaceSettledAt: at(41), ...patch }
}

const worktree = (patch: Partial<WorktreeReclaimPreview> = {}): WorktreeReclaimPreview => ({
  path: 'C:/workshop/.worktrees/cleanup', branch: 'feat/cleanup-rules', dirty: false, ignored: [], repositories: [], items: [], untracked: [], ...patch,
})

function mount(threads: AgentThread[] = [settled()], options: { readonly owl?: boolean; readonly preview?: Omit<ThreadDeletePreview, 'threadId'>; readonly deleteError?: string
  readonly clientHosts?: AgentClientHost[]; readonly connections?: AgentState['connections'] } = {}) {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { owlFeatures: { 'clear-threads': options.owl !== false } },
    actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() } } as unknown as AppContextValue)
  const state = threadsStateFixture()
  state.host.threads = [...threads, ...state.host.threads]
  if (options.clientHosts) state.host.clientHosts = options.clientHosts
  if (options.connections) state.connections = options.connections
  state.activeThreadId = threads[0]!.id
  state.activeProjectId = 'workshop'
  const live = liveAgentState(state)
  const plain = live.command.getMockImplementation()!
  live.command.mockImplementation(async (request: AgentCommand) => {
    if (request.type === 'preview-delete-thread') return { ...live.state, error: null, threadDeletePreview: { threadId: request.threadId, kept: null, worktree: null, ...options.preview } }
    if (request.type === 'delete-thread') {
      if (options.deleteError) return { ...live.state, error: options.deleteError }
      return live.publish({ host: { ...live.state.host, threads: live.state.host.threads.filter(thread => thread.id !== request.threadId) }, activeThreadId: null, notice: 'Deleted “Move the cleanup rules”.' })
    }
    return plain(request)
  })
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={E2E_THREADS_NOW} />)
  return live
}

const pane = (): HTMLElement => screen.getByRole('heading', { level: 2, name: 'Move the cleanup rules' }).closest('.thread-pane') as HTMLElement
const sent = <T extends AgentCommand['type']>(live: ReturnType<typeof liveAgentState>, type: T): Extract<AgentCommand, { type: T }>[] =>
  live.command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: T }> => request.type === type)
const openDelete = (): void => { fireEvent.click(within(openPaneMenu(pane())).getByRole('menuitem', { name: 'Delete thread…' })) }

beforeEach(() => { vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalApp).mockReset() })
afterEach(() => { cleanup() })

describe('Delete thread… in the pane menu', () => {
  it('is the last item, after its own rule and in the error colour, for a settled thread', () => {
    mount()
    const menu = openPaneMenu(pane())
    expect(paneMenuItems(menu).at(-1)).toBe('Delete thread…')
    const item = within(menu).getByRole('menuitem', { name: 'Delete thread…' })
    expect(item).toHaveAttribute('data-tone', 'danger')
    expect(item).toBeEnabled()
    expect(item.previousElementSibling?.tagName).toBe('HR')
  })

  it('is offered for a thread settled with its project, and not for an unsettled one or with the Owl feature off', () => {
    mount([settled({ workspaceSettledAt: null })])
    expect(paneMenuItems(openPaneMenu(pane()))).not.toContain('Delete thread…')
    cleanup()
    mount([settled()], { owl: false })
    expect(paneMenuItems(openPaneMenu(pane()))).not.toContain('Delete thread…')
  })

  it('is off on a paired host that cannot delete yet, and says to update it by name', () => {
    const client = (threadDelete: boolean): AgentClientHost => ({ hostId: HOST, connected: true, models: [], capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      ...(threadDelete ? { threadDelete: true as const } : {}) })
    const remote = settled({ hostId: HOST, remoteHost: true })
    mount([remote], { clientHosts: [client(false)], connections: [{ hostId: HOST, name: 'forge', kind: 'remote', connected: true }] })
    const item = within(openPaneMenu(pane())).getByRole('menuitem', { name: 'Delete thread…. Update forge to delete its threads' })
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', 'Update forge to delete its threads')
    expect(offersThreadDelete([client(true)], remote)).toBe(true)
    expect(offersThreadDelete(undefined, remote)).toBe(false)
    expect(offersThreadDelete(undefined, settled())).toBe(true)
  })
})

describe('Delete “title”?', () => {
  it('asks main first, lists what goes and what stays, and deletes the thread', async () => {
    const live = mount([settled()], { preview: { kept: null, worktree: worktree() } })
    openDelete()
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Move the cleanup rules”?' })
    expect(sent(live, 'preview-delete-thread')).toEqual([{ type: 'preview-delete-thread', threadId: THREAD }])
    await waitFor(() => expect(dialog).toHaveTextContent('Its messages and activity leave Sotto and can’t be brought back.'))
    expect(dialog).toHaveTextContent('Removes the worktree folder it made. Its branch and commits stay.')
    expect(dialog).toHaveTextContent('Usage keeps its numbers. Claude keeps its own copy of the session.')
    // Focus starts on Cancel, as every confirmation here does.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sent(live, 'delete-thread')).toEqual([{ type: 'delete-thread', threadId: THREAD, confirmedIgnored: [], confirmedItems: [], confirmedRepositories: [] }])
    // The pane's thread is gone; the page says what happened.
    expect(screen.queryByRole('heading', { level: 2, name: 'Move the cleanup rules' })).toBeNull()
    expect(document.body).toHaveTextContent('Deleted “Move the cleanup rules”.')
  })

  it('says nothing about a folder for a thread without one of its own', async () => {
    mount()
    openDelete()
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog).toHaveTextContent('Its messages and activity leave Sotto'))
    expect(dialog).not.toHaveTextContent('worktree')
  })

  it('says why a kept thread stays and offers only Close', async () => {
    const live = mount([settled()], { preview: { kept: 'pull-request', worktree: null } })
    openDelete()
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog).toHaveTextContent('This thread can’t be deleted: pull request still open. Nothing was deleted.'))
    expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual(['Close'])
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(sent(live, 'delete-thread')).toEqual([])
  })

  it('names a worktree that cannot be removed in plain words', async () => {
    mount([settled()], { preview: { kept: 'worktree-error', worktree: worktree({ branch: undefined }) } })
    openDelete()
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog).toHaveTextContent('its worktree folder has no branch checked out; switch it to a branch first. Nothing was deleted.'))
  })

  it('lists ignored files and nested work to tick, and deletes only once they are ticked', async () => {
    const live = mount([settled()], { preview: { kept: null, worktree: worktree({ ignored: ['.env', 'scratch/'], items: [{ path: '.env', bytes: 200, fileCount: 1 }, { path: 'scratch/', bytes: 4096, fileCount: 3 }],
      repositories: [{ path: 'scratch/', changeCount: 2, kind: 'repository', unpushedCommitCount: 1 }] }) } })
    openDelete()
    const dialog = await screen.findByRole('dialog')
    const tick = await within(dialog).findByRole('checkbox', { name: /Delete these 2 ignored items with the folder, including the nested repository’s uncommitted work/u })
    const remove = within(dialog).getByRole('button', { name: 'Delete' })
    expect(remove).toBeDisabled()
    expect(dialog).toHaveTextContent('Nested repository · 2 uncommitted changes · 1 commit not on any remote')
    fireEvent.click(tick)
    expect(remove).toBeEnabled()
    fireEvent.click(remove)
    await waitFor(() => expect(sent(live, 'delete-thread')).toHaveLength(1))
    expect(sent(live, 'delete-thread')[0]).toEqual({ type: 'delete-thread', threadId: THREAD, confirmedIgnored: ['.env', 'scratch/'],
      confirmedItems: [{ path: '.env', fileCount: 1 }, { path: 'scratch/', fileCount: 3 }], confirmedRepositories: [{ path: 'scratch/', changeCount: 2, kind: 'repository', unpushedCommitCount: 1 }] })
  })

  it('shows a refusal in its own words and keeps the dialog open', async () => {
    mount([settled()], { deleteError: '“Move the cleanup rules” was not deleted: still working. Nothing was deleted.' })
    openDelete()
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('“Move the cleanup rules” was not deleted: still working. Nothing was deleted.')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
