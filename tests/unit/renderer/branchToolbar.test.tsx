import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BranchToolbar } from '../../../src/renderer/src/agents/BranchToolbar'
import { branchLabel, chordClaimed, chordMatches, createRefName, offersCreate, parseAccelerator, pickOutcome, pullRequestTitle, refBadges, switchFailure, toolbarApplies, workspaceLabel, workspaceLocked, workspaceOptions, type ToolbarThread } from '../../../src/renderer/src/agents/branchToolbar.logic'
import type { ThreadRow } from '../../../src/renderer/src/agents/threadFacts'
import { defaultAgentConfiguration, type AgentCommand, type AgentState, type AgentThread } from '../../../src/shared/agents'
import type { GitRef, GitRefsPage } from '../../../src/shared/gitRefs'
import type { GitStatus } from '../../../src/shared/gitStatus'

const project = { id: 'project', title: 'App', path: 'C:/Users/zache/Projects/app' }
const git: GitStatus = { isRepository: true, branch: 'main', upstream: 'origin/main', hasRemote: true, defaultBranch: 'main', isDefaultBranch: true, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' }
function thread(overrides: Partial<AgentThread> = {}): AgentThread {
  return { id: 'thread-1', projectId: project.id, title: 'Task', modelId: 'codex:model', status: 'idle', messages: [], requests: [], nativeSessionStarted: false,
    worktree: { mode: 'shared', status: 'ready', path: project.path, repositoryRoot: project.path, branch: 'main', git }, ...overrides } as AgentThread
}
const ref = (name: string, extra: Partial<GitRef> = {}): GitRef => ({ name, current: false, isDefault: false, worktreePath: null, ...extra })
const page = (refs: GitRef[], extra: Partial<GitRefsPage> = {}): GitRefsPage => ({ refs, isRepository: true, hasRemote: true, nextCursor: null, total: refs.length, ...extra })
function state(threads: AgentThread[]): AgentState {
  return { configuration: defaultAgentConfiguration(), connection: 'connected', error: null, activeThreadId: threads[0]?.id ?? null,
    host: { connected: true, name: 'Codex', version: 'test', capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true }, projects: [project], threads, models: [] } } as unknown as AgentState
}
function row(current: AgentThread): ThreadRow { return { thread: current, project, provider: 'Codex', providerId: 'codex', connected: true } as unknown as ThreadRow }
function mount(current: AgentThread, options: { refs?: (request: { query?: string; cursor?: number }) => GitRefsPage; others?: AgentThread[]; command?: (request: AgentCommand) => Promise<AgentState | null>; focused?: boolean; openExternalLink?: ReturnType<typeof vi.fn> } = {}) {
  const gitRefs = vi.fn(async (request: { threadId: string; query?: string; cursor?: number; limit?: number; refresh?: boolean }) => options.refs ? options.refs(request) : page([ref('main', { current: true, isDefault: true }), ref('feature'), ref('origin/remote-only', { remote: 'origin' })]))
  vi.stubGlobal('sotto', { agents: { gitRefs }, ...(options.openExternalLink ? { openExternalLink: options.openExternalLink } : {}) })
  const command = vi.fn(options.command ?? (async () => state([current])))
  const all = [current, ...(options.others ?? [])]
  const view = render(<BranchToolbar row={row(current)} state={state(all)} command={command} focused={options.focused ?? true} />)
  return { ...view, command, gitRefs, rerender: (next: AgentThread) => view.rerender(<BranchToolbar row={row(next)} state={state([next, ...(options.others ?? [])])} command={command} focused={options.focused ?? true} />) }
}
async function openPicker() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Branch' }))
  await screen.findByRole('listbox', { name: 'Refs' })
  await waitFor(() => expect(screen.getByRole('listbox', { name: 'Refs' }).querySelectorAll('[role="option"]').length).toBeGreaterThan(0))
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('branch toolbar logic', () => {
  it('applies to a repository or a worktree still to be made, and locks the workspace once the thread has started', () => {
    expect(toolbarApplies(thread())).toBe(true)
    expect(toolbarApplies(thread({ worktree: { mode: 'shared', status: 'ready', path: project.path, git: { ...git, isRepository: false } } }))).toBe(false)
    expect(toolbarApplies(thread({ worktree: { mode: 'independent', status: 'pending' } }))).toBe(true)
    expect(toolbarApplies(thread({ worktree: { mode: 'independent', status: 'error', error: 'No commit' } }))).toBe(false)
    expect(toolbarApplies(thread({ worktree: undefined }))).toBe(false)
    expect(workspaceLocked(thread())).toBe(false)
    expect(workspaceLocked(thread({ nativeSessionStarted: true }))).toBe(true)
    expect(workspaceLocked(thread({ messages: [{ id: 'm', role: 'user', text: 'Hi', createdAt: '2026-09-23T00:00:00.000Z' }] }))).toBe(true)
    expect(workspaceLocked(thread({ worktree: { mode: 'independent', status: 'ready', path: 'C:/wt', branch: 'sotto/abc' } }))).toBe(true)
  })
  it('names the workspace and offers the checkout, a new worktree and other threads worktrees of the same project', () => {
    expect(workspaceLabel(thread())).toBe('Current checkout')
    expect(workspaceLabel(thread({ worktree: { mode: 'independent', status: 'pending' } }))).toBe('New worktree')
    expect(workspaceLabel(thread({ worktree: { mode: 'independent', status: 'ready', path: 'C:/wt', branch: 'feat/x' } }))).toBe('Current worktree')
    expect(workspaceLabel(thread({ worktree: { mode: 'independent', status: 'pending', existingWorktreePath: 'C:/other', baseBranch: 'feat/y' } }))).toBe('Previous worktree (feat/y)')
    const others: ToolbarThread[] = [
      thread({ id: 'a', worktree: { mode: 'independent', status: 'ready', path: 'C:/wt/a', branch: 'feat/a' } }),
      thread({ id: 'b', worktree: { mode: 'independent', status: 'ready', path: 'C:\\wt\\a\\', branch: 'feat/a' } }), // the same folder, spelled differently
      thread({ id: 'c', worktree: { mode: 'independent', status: 'ready', path: 'C:/wt/c', branch: 'feat/c', reclaimedAt: '2026-09-23T00:00:00.000Z' } }),
      thread({ id: 'd', projectId: 'elsewhere', worktree: { mode: 'independent', status: 'ready', path: 'C:/wt/d', branch: 'feat/d' } }),
      thread({ id: 'e', worktree: { mode: 'shared', status: 'ready', path: project.path } }),
    ]
    expect(workspaceOptions(thread(), others).map(option => option.label)).toEqual(['Current checkout', 'New worktree', 'Previous worktree (feat/a)'])
  })
  it('labels the picker with the branch, Select ref when detached, and the base a new worktree starts from', () => {
    expect(branchLabel(thread())).toBe('main')
    expect(branchLabel(thread({ worktree: { mode: 'shared', status: 'ready', path: project.path, git: { ...git, branch: null } } }))).toBe('Select ref')
    expect(branchLabel(thread({ worktree: { mode: 'independent', status: 'pending', baseBranch: 'develop' } }))).toBe('From origin/develop')
    expect(branchLabel(thread({ worktree: { mode: 'independent', status: 'pending', baseBranch: 'develop', startFromOrigin: false } }))).toBe('From develop')
    expect(branchLabel(thread({ worktree: { mode: 'independent', status: 'pending', git: { ...git, branch: 'main' } } }))).toBe('From origin/main')
  })
  it('decides what a pick does before anything is sent', () => {
    expect(pickOutcome(ref('feature'), thread())).toEqual({ kind: 'switch', ref: 'feature' })
    expect(pickOutcome(ref('origin/x', { remote: 'origin' }), thread())).toEqual({ kind: 'switch', ref: 'origin/x' })
    expect(pickOutcome(ref('main', { current: true }), thread())).toMatchObject({ kind: 'refuse' })
    expect(pickOutcome(ref('feature', { worktreePath: 'C:/wt' }), thread())).toEqual({ kind: 'repoint', path: 'C:/wt' })
    expect(pickOutcome(ref('feature', { worktreePath: 'C:/wt' }), thread({ nativeSessionStarted: true }))).toMatchObject({ kind: 'refuse', reason: expect.stringContaining('another worktree') })
    const draft = thread({ worktree: { mode: 'independent', status: 'pending', startFromOrigin: false } })
    expect(pickOutcome(ref('release'), draft)).toEqual({ kind: 'record-base', baseBranch: 'release', startFromOrigin: false })
    expect(pickOutcome(ref('origin/release', { remote: 'origin' }), draft)).toEqual({ kind: 'record-base', baseBranch: 'release', startFromOrigin: true })
  })
  it('offers Create new ref for a name nothing lists, dashes for whitespace, and never for a bad name', () => {
    expect(createRefName('  fix login  bug ')).toBe('fix-login-bug')
    expect(offersCreate('fix login', [ref('main')])).toBe(true)
    expect(offersCreate('MAIN', [ref('main')])).toBe(false)
    expect(offersCreate('remote-only', [ref('origin/remote-only', { remote: 'origin' })])).toBe(false)
    expect(offersCreate('', [])).toBe(false)
    expect(offersCreate('-flag', [])).toBe(false)
    expect(offersCreate('a..b', [])).toBe(false)
  })
  it('reads badges, the pull request tooltip and the failure line', () => {
    expect(refBadges(ref('main', { current: true, isDefault: true, worktreePath: 'C:/wt' }))).toEqual(['current', 'worktree', 'default'])
    expect(refBadges(ref('origin/main', { remote: 'origin', isDefault: true }))).toEqual(['remote', 'default'])
    expect(pullRequestTitle({ number: 12, title: 'Ship it', url: 'https://github.com/o/r/pull/12', state: 'open', draft: false })).toBe('PR #12 - Open: Ship it')
    expect(switchFailure('error: Your local changes would be overwritten')).toBe('Failed to switch ref. error: Your local changes would be overwritten')
    expect(switchFailure('Failed to switch ref. pathspec did not match')).toBe('Failed to switch ref. pathspec did not match')
    expect(switchFailure(null)).toBe('Failed to switch ref.')
  })
  it('claims a chord only when the dictation hotkey does not already mean the same keys', () => {
    expect(parseAccelerator('CommandOrControl+Shift+Space', 'win32')).toEqual({ key: ' ', ctrl: true, shift: true, alt: false, meta: false })
    expect(parseAccelerator('CommandOrControl+Shift+G', 'darwin')).toEqual({ key: 'g', ctrl: false, shift: true, alt: false, meta: true })
    expect(chordClaimed('mod+shift+g', 'CommandOrControl+Shift+Space', 'win32')).toBe(true)
    expect(chordClaimed('mod+shift+g', 'CommandOrControl+Shift+G', 'win32')).toBe(false)
    expect(chordClaimed('mod+shift+g', 'Control+Shift+G', 'darwin')).toBe(true) // Command, not Control, is mod on macOS
    expect(chordClaimed('mod+shift+g', 'Command+Shift+G', 'darwin')).toBe(false)
    expect(chordClaimed('mod+shift+g', undefined, 'win32')).toBe(true)
    expect(chordMatches({ key: 'G', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, 'mod+shift+g', 'win32')).toBe(true)
    expect(chordMatches({ key: 'G', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }, 'mod+shift+g', 'darwin')).toBe(false)
    expect(chordMatches({ key: 'g', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }, 'mod+shift+g', 'win32')).toBe(false)
  })
})

describe('BranchToolbar', () => {
  it('shows nothing for a folder that is not a repository', () => {
    mount(thread({ worktree: { mode: 'shared', status: 'ready', path: project.path, git: { ...git, isRepository: false } } }))
    expect(screen.queryByRole('group', { name: 'Branch toolbar' })).toBeNull()
  })
  it('reads Run on and Workspace as static text once the thread has started, and keeps the picker', () => {
    mount(thread({ nativeSessionStarted: true, remoteHost: true, hostLabel: 'Build box', worktree: { mode: 'independent', status: 'ready', path: 'C:/wt', branch: 'feat/x', git: { ...git, branch: 'feat/x' } } }))
    const toolbar = screen.getByRole('group', { name: 'Branch toolbar' })
    expect(toolbar).toHaveTextContent('Run on Build box')
    expect(toolbar).toHaveTextContent('Workspace Current worktree')
    expect(screen.queryByRole('combobox', { name: 'Workspace' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('feat/x')
  })
  it('lets a draft choose its workspace, another thread worktree included, without creating anything', async () => {
    const other = thread({ id: 'other', nativeSessionStarted: true, worktree: { mode: 'independent', status: 'ready', path: 'C:/wt/other', branch: 'feat/other' } })
    const { command } = mount(thread(), { others: [other] })
    expect(screen.getByRole('group', { name: 'Branch toolbar' })).toHaveTextContent('Run on This device')
    const chip = screen.getByRole('combobox', { name: 'Workspace' })
    expect(chip).toHaveTextContent('Current checkout')
    fireEvent.click(chip)
    const list = screen.getByRole('listbox', { name: 'Workspace' })
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual(['Current checkout', 'New worktree', 'Previous worktree (feat/other)'])
    expect(within(list).getByRole('option', { name: 'Current checkout' })).toHaveFocus()
    fireEvent.click(within(list).getByRole('option', { name: 'New worktree' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread-working-copy', threadId: 'thread-1', workingCopy: 'independent', startFromOrigin: true }))
    expect(chip).toHaveFocus()
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('option', { name: 'Previous worktree (feat/other)' }))
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ type: 'configure-thread-working-copy', threadId: 'thread-1', workingCopy: 'independent', existingWorktreePath: 'C:/wt/other' }))
    fireEvent.click(chip)
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Workspace' }), { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Workspace' })).toBeNull()
    expect(chip).toHaveFocus()
  })
  it('lists refs with their badges, searches through the host, and switches on a pick', async () => {
    const refs = vi.fn((request: { query?: string }) => request.query ? page([ref('feature')]) : page([ref('main', { current: true, isDefault: true }), ref('feature'), ref('origin/remote-only', { remote: 'origin' })]))
    const { command, gitRefs } = mount(thread(), { refs })
    await openPicker()
    expect(gitRefs).toHaveBeenCalledWith({ threadId: 'thread-1', limit: 60, refresh: true })
    expect(screen.getByLabelText('Search refs')).toHaveFocus()
    const options = screen.getAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual(['maincurrentdefault', 'feature', 'origin/remote-onlyremote'])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.change(screen.getByLabelText('Search refs'), { target: { value: 'feat' } })
    await waitFor(() => expect(gitRefs).toHaveBeenLastCalledWith({ threadId: 'thread-1', query: 'feat', limit: 60 }))
    // A query nothing matches exactly also offers to create it; Enter takes the first listed ref.
    await waitFor(() => expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['feature', 'Create new ref “feat”']))
    fireEvent.keyDown(screen.getByLabelText('Search refs'), { key: 'Enter' })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'git-switch-branch', threadId: 'thread-1', ref: 'feature' }))
    expect(screen.queryByRole('listbox', { name: 'Refs' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveFocus()
  })
  it('shows Git refusal under the row in T3 words and keeps the picker usable', async () => {
    const { command } = mount(thread(), { command: async () => ({ ...state([thread()]), error: 'Failed to switch ref. error: Your local changes would be overwritten by checkout.' }) })
    await openPicker()
    fireEvent.click(screen.getByRole('option', { name: /feature/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to switch ref. error: Your local changes would be overwritten by checkout.')
    expect(command).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('combobox', { name: 'Branch' })).not.toBeDisabled()
  })
  it('re-points a draft at the worktree a branch is already checked out in, and refuses that for a started thread', async () => {
    const refs = () => page([ref('feat/busy', { worktreePath: 'C:/wt/busy' })])
    const { command, rerender } = mount(thread(), { refs })
    await openPicker()
    expect(screen.getByRole('option', { name: /feat\/busy/ })).toHaveTextContent('worktree')
    fireEvent.click(screen.getByRole('option', { name: /feat\/busy/ }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread-working-copy', threadId: 'thread-1', workingCopy: 'independent', existingWorktreePath: 'C:/wt/busy' }))
    rerender(thread({ nativeSessionStarted: true }))
    await openPicker()
    fireEvent.click(screen.getByRole('option', { name: /feat\/busy/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('feat/busy is checked out in another worktree. Start a new thread there to work on it.')
    expect(command).toHaveBeenCalledTimes(1)
  })
  it('offers to create a ref nothing matches and creates it from HEAD', async () => {
    const refs = (request: { query?: string }) => request.query ? page([]) : page([ref('main', { current: true })])
    const { command } = mount(thread(), { refs })
    await openPicker()
    fireEvent.change(screen.getByLabelText('Search refs'), { target: { value: 'fix login' } })
    const create = await screen.findByRole('option', { name: 'Create new ref “fix-login”' })
    fireEvent.click(create)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'git-switch-branch', threadId: 'thread-1', ref: 'fix-login', create: true }))
  })
  it('records the base for a worktree not made yet, with Start from origin, and does not create branches for it', async () => {
    const draft = thread({ worktree: { mode: 'independent', status: 'pending', startFromOrigin: true } })
    const refs = (request: { query?: string }) => request.query ? page([]) : page([ref('main', { current: true, isDefault: true }), ref('release'), ref('origin/hotfix', { remote: 'origin' })])
    const { command } = mount(draft, { refs })
    expect(screen.getByRole('combobox', { name: 'Branch' })).toHaveTextContent('From origin/main')
    await openPicker()
    const toggle = screen.getByRole('switch', { name: /Start from origin/ })
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread-working-copy', threadId: 'thread-1', workingCopy: 'independent', startFromOrigin: false }))
    fireEvent.click(screen.getByRole('option', { name: /origin\/hotfix/ }))
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ type: 'configure-thread-working-copy', threadId: 'thread-1', workingCopy: 'independent', baseBranch: 'hotfix', startFromOrigin: true }))
    await openPicker()
    fireEvent.change(screen.getByLabelText('Search refs'), { target: { value: 'brand-new' } })
    await waitFor(() => expect(screen.getByText('No refs match.')).toBeInTheDocument())
    expect(screen.queryByRole('option', { name: /Create new ref/ })).toBeNull()
  })
  it('pages on Show more and copies a name on right-click', async () => {
    const refs = (request: { cursor?: number }) => request.cursor ? page([ref('later')], { total: 2 }) : page([ref('main', { current: true })], { nextCursor: 1, total: 2 })
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { gitRefs } = mount(thread(), { refs })
    await openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    await waitFor(() => expect(gitRefs).toHaveBeenLastCalledWith({ threadId: 'thread-1', cursor: 1, limit: 60 }))
    await waitFor(() => expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['maincurrent', 'later']))
    fireEvent.contextMenu(screen.getByRole('option', { name: /later/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('later'))
    expect(await screen.findByRole('status')).toHaveTextContent('Copied later.')
  })
  it('shows the pull request badge with its title and opens it through the bridge', () => {
    const openExternalLink = vi.fn(async () => ({ ok: true }))
    mount(thread({ worktree: { mode: 'shared', status: 'ready', path: project.path, branch: 'feat/x', git: { ...git, branch: 'feat/x', pullRequest: { number: 12, title: 'Ship it', url: 'https://github.com/o/r/pull/12', state: 'open', draft: false } } } }), { openExternalLink })
    const badge = screen.getByRole('button', { name: 'Open PR #12 - Open: Ship it' })
    expect(badge).toHaveTextContent('#12')
    expect(badge).toHaveAttribute('title', 'PR #12 - Open: Ship it')
    fireEvent.click(badge)
    expect(openExternalLink).toHaveBeenCalledWith('https://github.com/o/r/pull/12')
  })
  it('answers its shortcuts only for the focused pane', async () => {
    const other = thread({ id: 'other', nativeSessionStarted: true, worktree: { mode: 'independent', status: 'ready', path: 'C:/wt/other', branch: 'feat/other' } })
    const { command, rerender } = mount(thread(), { others: [other], focused: true })
    fireEvent.keyDown(window, { key: 'g', ctrlKey: true, shiftKey: true })
    await screen.findByRole('listbox', { name: 'Refs' })
    fireEvent.keyDown(screen.getByLabelText('Search refs'), { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Refs' })).toBeNull()
    fireEvent.keyDown(window, { key: 'x', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('listbox', { name: 'Workspace' })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Workspace' }), { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread-working-copy', threadId: 'thread-1', workingCopy: 'independent', existingWorktreePath: 'C:/wt/other' }))
    cleanup()
    const unfocused = mount(thread(), { others: [other], focused: false })
    fireEvent.keyDown(window, { key: 'g', ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole('listbox', { name: 'Refs' })).toBeNull()
    expect(unfocused.command).not.toHaveBeenCalled()
    void rerender
  })
  it('says when branches cannot be read and when a folder has none', async () => {
    const { rerender } = mount(thread(), { refs: () => page([], { isRepository: false, hasRemote: false }) })
    await act(async () => { fireEvent.click(screen.getByRole('combobox', { name: 'Branch' })) })
    expect(await screen.findByText('This folder is not a Git repository.')).toBeInTheDocument()
    void rerender
  })
})
