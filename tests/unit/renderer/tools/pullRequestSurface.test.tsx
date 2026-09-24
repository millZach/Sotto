import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PullRequestSurface } from '../../../../src/renderer/src/tools/PullRequestSurface'
import { checksState, confirmationFor, primaryControl, rememberedMergeMethod, resolveMergeMethod, summarizeChecks } from '../../../../src/renderer/src/tools/pullRequestSurface.logic'
import type { AgentCommand, AgentState, AgentThread } from '../../../../src/shared/agents'
import type { GitPullRequestCheck, GitPullRequestDetail } from '../../../../src/shared/gitPullRequests'

const URL = 'https://github.com/o/r/pull/74'
const check = (name: string, status: GitPullRequestCheck['status'], url: string | null = null): GitPullRequestCheck => ({ name, status, url, description: null })
function detail(change: Partial<GitPullRequestDetail> = {}): GitPullRequestDetail {
  return { number: 74, url: URL, title: 'Make the greeting friendlier', body: 'Says hello.\n\n- One change', state: 'open', draft: false, baseBranch: 'main', headBranch: 'feat/greeting',
    crossRepository: false, reviewDecision: 'approved', mergeable: 'mergeable', checks: [check('CI / build', 'success', 'https://github.com/o/r/actions/runs/1')], mergeMethods: ['merge', 'squash', 'rebase'],
    autoMerge: null, behindBy: 0, canUpdateBranch: true, linked: null, branch: true, ...change }
}
function thread(change: Partial<AgentThread> = {}): AgentThread {
  return { id: 'thread-1', projectId: 'project', title: 'Task', modelId: 'codex:model', status: 'idle', messages: [], requests: [],
    worktree: { mode: 'shared', status: 'ready', path: 'C:/app', branch: 'feat/greeting', git: { isRepository: true, branch: 'feat/greeting', upstream: 'origin/feat/greeting', hasRemote: true, defaultBranch: 'main', isDefaultBranch: false,
      dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: 1, pullRequest: { number: 74, title: 'Make the greeting friendlier', url: URL, state: 'open', draft: false }, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' } },
    ...change } as AgentThread
}
function mount(options: { detail?: GitPullRequestDetail | null | ((request: { reference?: string }) => GitPullRequestDetail | null); thread?: AgentThread; result?: Partial<AgentState> } = {}) {
  const gitPullRequest = vi.fn(async (request: { threadId: string; reference?: string }) => typeof options.detail === 'function' ? options.detail(request) : options.detail === undefined ? detail() : options.detail)
  const openExternalLink = vi.fn(async () => ({ ok: true }))
  const writeText = vi.fn(async () => undefined)
  vi.stubGlobal('sotto', { agents: { gitPullRequest }, openExternalLink })
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => ({ notice: 'Pull request merged.', error: null, ...options.result }) as AgentState)
  const onStatus = vi.fn()
  const view = render(<PullRequestSurface thread={options.thread ?? thread()} command={command} onStatus={onStatus} />)
  return { ...view, command, gitPullRequest, openExternalLink, writeText, onStatus }
}
const sent = (command: ReturnType<typeof mount>['command']) => command.mock.calls.map(call => call[0])
async function menu(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: label }))
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('pull request surface logic, T3\'s rules', () => {
  it('leads with one control for each state', () => {
    const base = detail()
    expect(primaryControl({ ...base, state: 'merged' })).toBe('merged')
    expect(primaryControl({ ...base, state: 'closed' })).toBe('closed')
    expect(primaryControl({ ...base, mergeable: 'conflicting', draft: true })).toBe('resolve')
    expect(primaryControl({ ...base, draft: true })).toBe('ready')
    expect(primaryControl({ ...base, autoMerge: { method: 'squash' } })).toBe('auto-merge-armed')
    expect(primaryControl({ ...base, checks: [check('a', 'failure')] })).toBe('enable-auto-merge')
    expect(primaryControl({ ...base, checks: [check('a', 'pending')] })).toBe('enable-auto-merge')
    expect(primaryControl({ ...base, checks: [] })).toBe('merge')
    expect(primaryControl({ ...base, mergeMethods: [] })).toBeNull()
  })
  it('sums the checks in T3\'s words and picks the method chosen, then remembered, then allowed', () => {
    expect(summarizeChecks([])).toBe('No checks reported')
    expect(summarizeChecks([check('a', 'success'), check('b', 'failure')])).toBe('1 of 2 failing')
    expect(summarizeChecks([check('a', 'success'), check('b', 'pending')])).toBe('1 of 2 running')
    expect(summarizeChecks([check('a', 'action-required')])).toBe('1 check awaiting action')
    expect(summarizeChecks([check('a', 'success'), check('b', 'skipped')])).toBe('1 of 2 passing')
    expect(summarizeChecks([check('a', 'success')])).toBe('All checks passed')
    expect(checksState([check('a', 'skipped')])).toBe('passing')
    expect(resolveMergeMethod(['merge', 'squash'], null, 'squash')).toBe('squash')
    expect(resolveMergeMethod(['merge', 'squash'], 'merge', 'squash')).toBe('merge')
    expect(resolveMergeMethod(['rebase'], null, 'squash')).toBe('rebase')
    expect(confirmationFor('merge', 74, 'squash')).toEqual({ title: 'Merge pull request?', description: 'This merges #74 using squash and merge.', confirm: 'Squash and merge', danger: false })
    expect(confirmationFor('close', 74, 'merge')).toMatchObject({ title: 'Close pull request?', description: 'This closes #74 without merging it.', danger: true })
  })
})

describe('the Pull request surface', () => {
  it('shows the description, each named check and the review, and sends nothing from viewing', async () => {
    const { command, gitPullRequest, openExternalLink } = mount({ detail: detail({ checks: [check('CI / build', 'success', 'https://github.com/o/r/actions/runs/1'), check('lint', 'failure')], mergeMethods: ['merge'] }) })
    expect(await screen.findByRole('heading', { name: 'Make the greeting friendlier' })).toBeInTheDocument()
    expect(gitPullRequest).toHaveBeenCalledWith({ threadId: 'thread-1' })
    expect(screen.getByText('PR #74')).toBeInTheDocument()
    expect(screen.getByText('Approved')).toBeInTheDocument()
    expect(screen.getByText('This branch')).toBeInTheDocument()
    const checks = screen.getByRole('list', { name: 'Checks' })
    expect(within(checks).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Passed: CI / buildPassed', 'Failed: lintFailed'])
    expect(screen.getByText('1 of 2 failing')).toBeInTheDocument()
    expect(screen.getByText(/Says hello\./u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'CI / build' }))
    expect(openExternalLink).toHaveBeenCalledWith('https://github.com/o/r/actions/runs/1')
    expect(command).not.toHaveBeenCalled()
  })
  it('merges only after T3\'s confirmation, in the method chosen, and remembers the method', async () => {
    const { command, gitPullRequest } = mount({ detail: detail({ checks: [] }) })
    await screen.findByRole('heading', { name: 'Make the greeting friendlier' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Merge method' }), { target: { value: 'squash' } })
    expect(rememberedMergeMethod()).toBe('squash')
    fireEvent.click(screen.getByRole('button', { name: 'Squash and merge' }))
    const dialog = screen.getByRole('dialog', { name: 'Merge pull request?' })
    expect(dialog).toHaveTextContent('This merges #74 using squash and merge.')
    expect(command).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Squash and merge' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'git-pull-request-action', threadId: 'thread-1', url: URL, action: 'merge', method: 'squash' }]))
    expect(await screen.findByText('Pull request merged.')).toHaveAttribute('role', 'status')
    await waitFor(() => expect(gitPullRequest).toHaveBeenCalledTimes(2)) // read again after the press
  })
  it('cancels a merge without sending anything, from the keyboard too', async () => {
    const { command } = mount({ detail: detail({ checks: [] }) })
    await screen.findByRole('heading', { name: 'Make the greeting friendlier' })
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(command).not.toHaveBeenCalled()
  })
  it('offers Auto-merge while checks run, confirms it, and offers Merge now beside it', async () => {
    const { command } = mount({ detail: detail({ checks: [check('build', 'pending')] }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Auto-merge (merge)' }))
    const dialog = screen.getByRole('dialog', { name: 'Enable auto-merge?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable auto-merge' }))
    await waitFor(() => expect(sent(command)).toEqual([expect.objectContaining({ action: 'enable-auto-merge', method: 'merge' })]))
    await menu('Merge now')
    expect(screen.getByRole('dialog', { name: 'Merge pull request?' })).toBeInTheDocument()
  })
  it('turns an armed auto-merge off, marks a draft ready, and reopens a closed one, each without a confirmation', async () => {
    const armed = mount({ detail: detail({ autoMerge: { method: 'squash' } }) })
    expect(await screen.findByText(/Auto-merge is on \(squash and merge\)/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Disable auto-merge' }))
    await waitFor(() => expect(sent(armed.command)).toEqual([expect.objectContaining({ action: 'disable-auto-merge' })]))
    cleanup()
    const draft = mount({ detail: detail({ draft: true }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Ready for review' }))
    await waitFor(() => expect(sent(draft.command)).toEqual([expect.objectContaining({ action: 'ready' })]))
    cleanup()
    const closed = mount({ detail: detail({ state: 'closed' }) })
    expect(await screen.findByText('Closed without merging.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen pull request' }))
    await waitFor(() => expect(sent(closed.command)).toEqual([expect.objectContaining({ action: 'reopen' })]))
  })
  it('offers Update branch and Update with rebase while the branch is behind its base', async () => {
    const { command } = mount({ detail: detail({ behindBy: 3 }) })
    expect(await screen.findByText(/This branch is 3 commits behind/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Update with rebase' }))
    await waitFor(() => expect(sent(command)).toEqual([expect.objectContaining({ action: 'update-branch', method: 'rebase' })]))
    fireEvent.click(screen.getByRole('button', { name: 'Update branch' }))
    await waitFor(() => expect(sent(command)[1]).toEqual({ type: 'git-pull-request-action', threadId: 'thread-1', url: URL, action: 'update-branch' }))
  })
  it('holds the rest in its menu: Open on GitHub, Copy link, Convert to draft and Close pull request after its confirmation', async () => {
    const { command, openExternalLink, writeText, onStatus } = mount()
    await screen.findByRole('heading', { name: 'Make the greeting friendlier' })
    await menu('Open on GitHub')
    expect(openExternalLink).toHaveBeenCalledWith(URL)
    await menu('Copy link')
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL))
    expect(onStatus).toHaveBeenCalledWith('Link copied')
    await menu('Convert to draft')
    await waitFor(() => expect(sent(command)).toEqual([expect.objectContaining({ action: 'draft' })]))
    await menu('Close pull request')
    const dialog = screen.getByRole('dialog', { name: 'Close pull request?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close pull request' }))
    await waitFor(() => expect(sent(command)[1]).toEqual({ type: 'git-pull-request-action', threadId: 'thread-1', url: URL, action: 'close' }))
  })
  it('says GitHub\'s refusal in the host\'s words', async () => {
    mount({ detail: detail({ draft: true }), result: { error: 'Could not mark this ready for review. GraphQL: Resource not accessible by integration', notice: null } as never })
    fireEvent.click(await screen.findByRole('button', { name: 'Ready for review' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not mark this ready for review. GraphQL: Resource not accessible by integration')
  })
  it('says when there is no pull request, and links one by URL or number', async () => {
    const { command } = mount({ detail: null, thread: thread({ worktree: { mode: 'shared', status: 'ready', path: 'C:/app' } }), result: { notice: 'Linked PR #42.' } })
    expect(await screen.findByText('This branch has no pull request.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Link pull request' }))
    const dialog = screen.getByRole('dialog', { name: 'Link pull request' })
    const field = within(dialog).getByRole('textbox', { name: 'Pull request' })
    expect(field).toHaveFocus()
    fireEvent.change(field, { target: { value: 'main' } })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Use a pull request URL, 123, or #123.')
    fireEvent.change(field, { target: { value: '#42' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Link' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'git-link-pull-request', threadId: 'thread-1', reference: '#42' }]))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Linked PR #42.')).toBeInTheDocument()
  })
  it('lists the linked pull requests, opens one in the surface and unlinks another', async () => {
    const linked = thread({ pullRequests: [
      { number: 70, url: 'https://github.com/o/r/pull/70', title: 'Older work', state: 'merged', draft: false, source: 'linked', linkedAt: '2026-09-22T00:00:00.000Z' },
      { number: 74, url: URL, title: 'Make the greeting friendlier', state: 'open', draft: false, source: 'created', linkedAt: '2026-09-23T00:00:00.000Z' },
    ] })
    const { command, gitPullRequest } = mount({ thread: linked, detail: request => request.reference?.endsWith('/70') ? detail({ number: 70, url: 'https://github.com/o/r/pull/70', title: 'Older work', state: 'merged', linked: 'linked', branch: false }) : detail({ linked: 'created' }) })
    await screen.findByRole('heading', { name: 'Make the greeting friendlier' })
    fireEvent.click(screen.getByRole('button', { name: /Linked pull requests/u }))
    const list = screen.getByRole('list', { name: 'Linked pull requests' })
    expect(within(list).getAllByRole('button', { name: /^PR #/u }).map(button => button.getAttribute('aria-label'))).toEqual([
      'PR #74, Open: Make the greeting friendlier. Created from this thread', 'PR #70, Merged: Older work. Linked by you'])
    expect(screen.getByRole('button', { name: 'Back' })).toHaveFocus()
    fireEvent.click(within(list).getByRole('button', { name: 'Unlink PR #74 from this thread' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'git-unlink-pull-request', threadId: 'thread-1', url: URL }]))
    fireEvent.click(within(list).getByRole('button', { name: /^PR #70/u }))
    expect(await screen.findByRole('heading', { name: 'Older work' })).toBeInTheDocument()
    expect(gitPullRequest).toHaveBeenLastCalledWith({ threadId: 'thread-1', reference: 'https://github.com/o/r/pull/70' })
    expect(screen.getByText('Merged.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Linked pull requests/u })).toHaveFocus()
  })
})
