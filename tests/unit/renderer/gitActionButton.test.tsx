import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitActionButton } from '../../../src/renderer/src/agents/GitActionButton'
import { commitLabel, defaultBranchQuestion, HINT_DETACHED, HINT_DIVERGED, HINT_NOTHING_TO_PUSH, HINT_UP_TO_DATE, lineCounts, menuEntries, needsDefaultBranchConfirmation, noticeFor, quickAction, stackedFor } from '../../../src/renderer/src/agents/gitActionButton.logic'
import type { AgentCommand, AgentState, AgentThread } from '../../../src/shared/agents'
import type { GitActionProgress } from '../../../src/shared/gitActions'
import type { GitChangedFiles } from '../../../src/shared/gitChangedFiles'
import type { GitStatus } from '../../../src/shared/gitStatus'

const project = { id: 'project', title: 'App', path: 'C:/Users/zache/Projects/app' }
const clean: GitStatus = { isRepository: true, branch: 'feat/x', upstream: 'origin/feat/x', hasRemote: true, defaultBranch: 'main', isDefaultBranch: false, dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: 0, pullRequest: null, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z' }
const pr = { number: 12, title: 'Ship it', url: 'https://github.com/o/r/pull/12', state: 'open' as const, draft: false }
const status = (over: Partial<GitStatus> = {}): GitStatus => ({ ...clean, ...over })
function thread(git: GitStatus | undefined, over: Partial<AgentThread> = {}): AgentThread {
  return { id: 'thread-1', projectId: project.id, title: 'Task', modelId: 'codex:model', status: 'idle', messages: [], requests: [], nativeSessionStarted: true,
    worktree: { mode: 'shared', status: 'ready', path: project.path, repositoryRoot: project.path, branch: git?.branch ?? 'main', ...(git ? { git } : {}) }, ...over } as AgentThread
}
const state = (current: AgentThread, extra: Partial<AgentState> = {}): AgentState => ({ connection: 'connected', error: null, notice: null, activeThreadId: current.id, host: { projects: [project], threads: [current] }, ...extra } as unknown as AgentState)
const files = (listed: GitChangedFiles['files'] = [{ path: 'src/app.ts', status: 'modified', insertions: 4, deletions: 1 }, { path: 'docs/new.md', status: 'untracked', insertions: 2, deletions: 0 }, { path: 'logo.png', status: 'modified', insertions: null, deletions: null }]): GitChangedFiles => ({ isRepository: true, files: listed, truncated: false })
function mount(current: AgentThread, options: { command?: (request: AgentCommand) => Promise<AgentState | null>; changed?: GitChangedFiles; openExternalLink?: ReturnType<typeof vi.fn>; explained?: ReturnType<typeof vi.fn> } = {}) {
  const gitChangedFiles = vi.fn(async () => options.changed ?? files())
  vi.stubGlobal('sotto', { agents: { gitChangedFiles }, openExternalLink: options.openExternalLink ?? vi.fn() })
  const command = vi.fn(options.command ?? (async () => state(current)))
  const view = render(<GitActionButton thread={current} command={command} noticeSlot={null} onExplainedError={options.explained} />)
  return { ...view, command, gitChangedFiles, rerender: (next: AgentThread) => view.rerender(<GitActionButton thread={next} command={command} noticeSlot={null} onExplainedError={options.explained} />) }
}
/** The header's own button, apart from the notice's, whose labels can match. */
const quick = (): HTMLButtonElement => { const button = document.querySelector<HTMLButtonElement>('.git-action__quick'); if (!button) throw new Error('No Git action button.'); return button }
const sent = (command: ReturnType<typeof vi.fn>) => command.mock.calls.map(([request]) => request as AgentCommand)
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('the quick action, T3\'s table', () => {
  it.each<[string, Partial<GitStatus>, string, string | undefined]>([
    ['dirty, no remote', { dirty: true, hasRemote: false, upstream: null }, 'Commit', undefined],
    ['dirty, detached HEAD', { dirty: true, branch: null, upstream: null }, 'Commit', undefined],
    ['dirty, open PR', { dirty: true, pullRequest: pr }, 'Commit & push', undefined],
    ['dirty, on the default branch', { dirty: true, branch: 'main', isDefaultBranch: true, upstream: 'origin/main' }, 'Commit & push', undefined],
    ['dirty, otherwise', { dirty: true }, 'Commit, push & PR', undefined],
    ['clean, no upstream, no remote', { upstream: null, hasRemote: false }, 'Publish repository', undefined],
    ['clean, no upstream, not ahead', { upstream: null, ahead: 0 }, 'Push', HINT_NOTHING_TO_PUSH],
    ['clean, no upstream, not ahead, open PR', { upstream: null, ahead: 0, pullRequest: pr }, 'View PR', undefined],
    ['clean, no upstream, ahead', { upstream: null, ahead: 2, aheadOfDefault: 2 }, 'Push & create PR', undefined],
    ['clean, no upstream, ahead, open PR', { upstream: null, ahead: 2, aheadOfDefault: 2, pullRequest: pr }, 'Push', undefined],
    ['behind', { behind: 3 }, 'Pull', undefined],
    ['diverged', { behind: 3, ahead: 1 }, 'Sync ref', HINT_DIVERGED],
    ['ahead', { ahead: 1 }, 'Push & create PR', undefined],
    ['ahead, open PR', { ahead: 1, pullRequest: pr }, 'Push', undefined],
    ['ahead on the default branch', { ahead: 1, branch: 'main', isDefaultBranch: true, upstream: 'origin/main' }, 'Push', undefined],
    ['open PR', { pullRequest: pr }, 'View PR', undefined],
    ['ahead of the default branch', { aheadOfDefault: 2 }, 'Create PR', undefined],
    ['detached HEAD', { branch: null }, 'Commit', HINT_DETACHED],
    ['current', {}, 'Commit', HINT_UP_TO_DATE],
    ['not a repository', { isRepository: false, branch: null, hasRemote: false, upstream: null }, 'Initialize Git', undefined],
  ])('%s → %s', (_name, over, label, hint) => {
    const action = quickAction(status(over))
    expect(action?.label).toBe(label)
    expect(action?.hint).toBe(hint)
  })
  it('gives nothing before the host has read the folder, and maps each press to the host\'s stacked action', () => {
    expect(quickAction(undefined)).toBeNull()
    expect(stackedFor('commit')).toBe('commit'); expect(stackedFor('commit_push')).toBe('commit_push'); expect(stackedFor('commit_push_pr')).toBe('commit_push_pr')
    expect(stackedFor('push')).toBe('push'); expect(stackedFor('push_pr')).toBe('create_pr'); expect(stackedFor('create_pr')).toBe('create_pr')
    expect(stackedFor('pull')).toBeNull(); expect(stackedFor('view_pr')).toBeNull(); expect(stackedFor('publish')).toBeNull(); expect(stackedFor('init')).toBeNull()
    expect(commitLabel('commit')).toBe('Commit'); expect(commitLabel('commit_push')).toBe('Commit & push'); expect(commitLabel('commit_push_pr')).toBe('Commit, push & PR')
  })
  it('lists every menu entry, disabled with its reason rather than left out', () => {
    expect(menuEntries(status({ dirty: true }))).toEqual([{ id: 'commit', label: 'Commit' }, { id: 'push', label: 'Push', hint: HINT_NOTHING_TO_PUSH }, { id: 'create_pr', label: 'Create PR', hint: 'Commit local changes before creating a PR.' }])
    expect(menuEntries(status({ ahead: 1, pullRequest: pr }))).toEqual([{ id: 'commit', label: 'Commit', hint: 'No changes to commit.' }, { id: 'push', label: 'Push' }, { id: 'view_pr', label: 'View PR' }])
    expect(menuEntries(status({ hasRemote: false, upstream: null }))).toEqual([{ id: 'commit', label: 'Commit', hint: 'No changes to commit.' }, { id: 'push', label: 'Push', hint: 'Publish the repository first.' }, { id: 'create_pr', label: 'Create PR', hint: 'Publish the repository first.' }, { id: 'publish', label: 'Publish repository...' }])
    expect(menuEntries(status({ branch: 'main', isDefaultBranch: true, upstream: 'origin/main', aheadOfDefault: null })).map(entry => entry.hint)).toEqual(['No changes to commit.', HINT_NOTHING_TO_PUSH, 'Commit on a new branch first: this is the default branch.'])
    expect(menuEntries(status({ isRepository: false }))).toEqual([])
    expect(menuEntries(undefined)).toEqual([])
  })
  it('asks before a push or pull request leaves the default branch, unless a feature branch is cut first', () => {
    const main = status({ branch: 'main', isDefaultBranch: true, upstream: 'origin/main' })
    expect(needsDefaultBranchConfirmation(main, 'commit', false)).toBe(false)
    expect(needsDefaultBranchConfirmation(main, 'commit_push', false)).toBe(true)
    expect(needsDefaultBranchConfirmation(main, 'push', true)).toBe(false)
    expect(needsDefaultBranchConfirmation(status(), 'create_pr', false)).toBe(false)
    expect(defaultBranchQuestion('create_pr', 'main')).toEqual({ title: 'Push to default ref?', description: 'This creates a pull request from main, the default branch. Push there, or check out a feature branch and continue on it.', confirm: 'Push to main' })
  })
  it('reads the notice from the record: the stage and hook while running, the toast after, the failure in the host\'s words', () => {
    const base: GitActionProgress = { actionId: 'a', action: 'commit_push', status: 'running', phases: ['commit', 'push'], phase: 'commit', stage: 'Committing...', hook: null, startedAt: 't', finishedAt: null, result: null, error: null }
    expect(noticeFor(base)).toEqual({ tone: 'progress', title: 'Committing...' })
    expect(noticeFor({ ...base, hook: { name: 'pre-commit', output: 'lint ok' } })).toEqual({ tone: 'progress', title: 'Committing...', detail: 'pre-commit: lint ok' })
    expect(noticeFor({ ...base, hook: { name: 'pre-commit', output: null } })).toEqual({ tone: 'progress', title: 'Committing...', detail: 'Running pre-commit...' })
    expect(noticeFor({ ...base, status: 'failed', error: 'Push failed. rejected' })).toEqual({ tone: 'error', title: 'Action failed', detail: 'Push failed. rejected' })
    const result = { action: 'commit' as const, branch: { status: 'skipped_not_requested' as const }, commit: { status: 'created' as const, sha: 'abc1234def', subject: 'Fix it' }, push: { status: 'skipped_not_requested' as const }, pr: { status: 'skipped_not_requested' as const }, toast: { title: 'Committed abc1234', description: 'Fix it', cta: { kind: 'run_action' as const, label: 'Push', action: 'push' as const } } }
    expect(noticeFor({ ...base, status: 'done', result })).toEqual({ tone: 'success', title: 'Committed abc1234', detail: 'Fix it', cta: { kind: 'run_action', label: 'Push', action: 'push' } })
    expect(lineCounts({ insertions: 12, deletions: 3 })).toBe('+12 \u22123'); expect(lineCounts({ insertions: null, deletions: null })).toBeNull()
  })
})

describe('the Git action in the pane header', () => {
  it('says what a press does, runs Push at once with a fresh action ID, and names why it is disabled', async () => {
    const { command, rerender } = mount(thread(status({ ahead: 1, pullRequest: pr })))
    expect(quick()).toHaveTextContent('Push')
    fireEvent.click(quick())
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(sent(command)[0]).toMatchObject({ type: 'git-action', threadId: 'thread-1', action: 'push' })
    expect((sent(command)[0] as { actionId: string }).actionId).toMatch(/^[0-9a-f-]{36}$/u)
    rerender(thread(status()))
    const disabled = quick()
    expect(disabled).toHaveAttribute('aria-disabled', 'true'); expect(disabled).toHaveAttribute('title', HINT_UP_TO_DATE)
    expect(disabled).toHaveAccessibleName(expect.stringContaining(HINT_UP_TO_DATE))
    fireEvent.click(disabled)
    expect(command).toHaveBeenCalledTimes(1)
  })
  it('draws nothing before the host has read the folder, and Initialize Git for a folder without one', async () => {
    const { command, rerender } = mount(thread(undefined))
    expect(screen.queryByRole('button')).toBeNull()
    rerender(thread(status({ isRepository: false, branch: null, hasRemote: false, upstream: null })))
    expect(screen.queryByRole('button', { name: 'More Git actions' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Git' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'git-init', threadId: 'thread-1' }]))
  })
  it('opens the commit dialog with the files and their counts, leaves a file out in Edit, and commits the rest with the typed message', async () => {
    const { command, gitChangedFiles } = mount(thread(status({ dirty: true })))
    expect(quick()).toHaveTextContent('Commit, push & PR')
    fireEvent.click(quick())
    const dialog = await screen.findByRole('dialog', { name: 'Commit changes' })
    expect(gitChangedFiles).toHaveBeenCalledWith({ threadId: 'thread-1' })
    await within(dialog).findByText('3 files')
    expect(within(dialog).getByText('feat/x')).toBeInTheDocument()
    expect(within(dialog).queryByText('Default branch')).toBeNull()
    const list = within(dialog).getByRole('list', { name: 'Changed files' })
    expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Msrc/app.ts+4 \u22121', 'Udocs/new.md+2 \u22120', 'Mlogo.png'])
    expect(within(dialog).getByRole('textbox', { name: 'Commit message (optional)' })).toHaveFocus()
    expect(within(dialog).getByRole('textbox', { name: 'Commit message (optional)' })).toHaveAttribute('placeholder', 'Leave empty to auto-generate')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Include logo.png' }))
    expect(within(dialog).getByText('2 files of 3')).toBeInTheDocument()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Commit message (optional)' }), { target: { value: '  Tidy the app  ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit, push & PR' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(sent(command)[0]).toMatchObject({ type: 'git-action', action: 'commit_push_pr', commitMessage: 'Tidy the app', filePaths: ['src/app.ts', 'docs/new.md'] })
    expect(sent(command)[0]).not.toHaveProperty('featureBranch')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('commits on a new branch from the dialog, sends no message when the field is empty, and refuses to commit nothing', async () => {
    const { command } = mount(thread(status({ dirty: true, hasRemote: false, upstream: null })), { changed: files([{ path: 'a.txt', status: 'added', insertions: 1, deletions: 0 }]) })
    fireEvent.click(quick())
    const dialog = await screen.findByRole('dialog', { name: 'Commit changes' })
    await within(dialog).findByText('1 file')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Include a.txt' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit on new branch' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose at least one file to commit.')
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Include a.txt' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit on new branch' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(sent(command)[0]).toMatchObject({ type: 'git-action', action: 'commit', featureBranch: true })
    expect(sent(command)[0]).not.toHaveProperty('commitMessage'); expect(sent(command)[0]).not.toHaveProperty('filePaths')
  })
  it('closes the dialog on Escape and gives focus back, and says when there is nothing to commit', async () => {
    const { command } = mount(thread(status()), { changed: files([]) })
    fireEvent.click(screen.getByRole('button', { name: 'More Git actions' }))
    const menu = screen.getByRole('menu', { name: 'More Git actions' })
    expect(within(menu).getAllByRole('menuitem').map(item => [item.textContent, (item as HTMLButtonElement).disabled])).toEqual([['Commit. No changes to commit.', true], [`Push. ${HINT_NOTHING_TO_PUSH}`, true], ['Create PR', false]])
    fireEvent.keyDown(menu, { key: 'Escape' })
    const more = screen.getByRole('button', { name: 'More Git actions' })
    expect(more).toHaveFocus()
    // A thread with nothing to commit still opens the dialog from a status that is stale by the time the host answers.
    const dirty = mount(thread(status({ dirty: true })), { changed: files([]) })
    fireEvent.click(dirty.container.querySelector('.git-action__quick')!)
    const dialog = await screen.findByRole('dialog', { name: 'Commit changes' })
    await within(dialog).findByText('No changes to commit.')
    expect(within(dialog).getByRole('button', { name: 'Commit, push & PR' })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(command).not.toHaveBeenCalled()
  })
  it('asks before pushing from the default branch: Abort sends nothing, Push to main confirms, the feature branch reruns with one', async () => {
    const main = status({ branch: 'main', isDefaultBranch: true, upstream: 'origin/main', ahead: 1 })
    const { command } = mount(thread(main))
    expect(quick()).toHaveTextContent('Push')
    fireEvent.click(quick())
    let dialog = await screen.findByRole('dialog', { name: 'Push to default ref?' })
    expect(within(dialog).getByRole('button', { name: 'Abort' })).toHaveFocus()
    expect(dialog).toHaveTextContent('This pushes from main, the default branch.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abort' }))
    expect(screen.queryByRole('dialog')).toBeNull(); expect(command).not.toHaveBeenCalled()
    fireEvent.click(quick())
    dialog = await screen.findByRole('dialog', { name: 'Push to default ref?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Push to main' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1))
    expect(sent(command)[0]).toMatchObject({ type: 'git-action', action: 'push', allowDefaultBranch: true })
    fireEvent.click(quick())
    dialog = await screen.findByRole('dialog', { name: 'Push to default ref?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check out feature branch & continue' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    expect(sent(command)[1]).toMatchObject({ type: 'git-action', action: 'push', featureBranch: true })
    expect(sent(command)[1]).not.toHaveProperty('allowDefaultBranch')
  })
  it('asks the same after the commit dialog when the commit will push from the default branch, and not for a plain commit', async () => {
    const main = status({ branch: 'main', isDefaultBranch: true, upstream: 'origin/main', dirty: true })
    const { command } = mount(thread(main))
    fireEvent.click(quick())
    let dialog = await screen.findByRole('dialog', { name: 'Commit changes' })
    expect(within(dialog).getByText('Default branch')).toBeInTheDocument()
    await within(dialog).findByText('3 files')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit & push' }))
    dialog = await screen.findByRole('dialog', { name: 'Push to default ref?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Push to main' }))
    await waitFor(() => expect(sent(command)[0]).toMatchObject({ action: 'commit_push', allowDefaultBranch: true }))
    fireEvent.click(screen.getByRole('button', { name: 'More Git actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Commit' }))
    dialog = await screen.findByRole('dialog', { name: 'Commit changes' })
    await within(dialog).findByText('3 files')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit', exact: true }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    expect(sent(command)[1]).toMatchObject({ action: 'commit' }); expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('pulls, shows the host\'s sentence, and lets it be dismissed', async () => {
    const current = thread(status({ behind: 2 }))
    const { command } = mount(current, { command: async () => state(current, { notice: 'Pulled. Updated feat/x from origin/feat/x.' }) })
    expect(quick()).toHaveTextContent('Pull')
    fireEvent.click(quick())
    expect(await screen.findByRole('status')).toHaveTextContent('Pulled. Updated feat/x from origin/feat/x.')
    expect(sent(command)).toEqual([{ type: 'git-pull', threadId: 'thread-1' }])
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the Git notice' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('opens the pull request for View PR, and the browser for the notice\'s View PR', async () => {
    const openExternalLink = vi.fn()
    const done: GitActionProgress = { actionId: 'a', action: 'create_pr', status: 'done', phases: ['pr'], phase: null, stage: null, hook: null, startedAt: 't', finishedAt: 't', error: null,
      result: { action: 'create_pr', branch: { status: 'skipped_not_requested' }, commit: { status: 'skipped_not_requested' }, push: { status: 'skipped_not_requested' }, pr: { status: 'created', number: 12, url: pr.url }, toast: { title: 'Created PR #12', cta: { kind: 'open_pr', label: 'View PR', url: pr.url } } } }
    mount(thread(status({ pullRequest: pr }), { gitAction: done }), { openExternalLink })
    fireEvent.click(quick())
    expect(openExternalLink).toHaveBeenCalledWith(pr.url)
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent('Created PR #12')
    fireEvent.click(within(notice).getByRole('button', { name: 'View PR' }))
    expect(openExternalLink).toHaveBeenCalledTimes(2)
  })
  it('shows the stage and the hook while the action runs, then the toast whose Push runs the next step', async () => {
    const running: GitActionProgress = { actionId: 'a', action: 'commit', status: 'running', phases: ['commit'], phase: 'commit', stage: 'Committing...', hook: { name: 'pre-commit', output: 'eslint .' }, startedAt: 't', finishedAt: null, result: null, error: null }
    const { command, rerender } = mount(thread(status({ dirty: true }), { gitAction: running }))
    expect(screen.getByRole('status')).toHaveTextContent('Committing... pre-commit: eslint .')
    expect(quick()).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Dismiss the Git notice' })).toBeNull()
    const done: GitActionProgress = { ...running, status: 'done', phase: null, stage: null, hook: null, finishedAt: 't', result: { action: 'commit', branch: { status: 'skipped_not_requested' }, commit: { status: 'created', sha: 'abc1234def', subject: 'Fix it' }, push: { status: 'skipped_not_requested' }, pr: { status: 'skipped_not_requested' }, toast: { title: 'Committed abc1234', description: 'Fix it', cta: { kind: 'run_action', label: 'Push', action: 'push' } } } }
    rerender(thread(status({ ahead: 1 }), { gitAction: done }))
    expect(screen.getByRole('status')).toHaveTextContent('Committed abc1234 Fix it')
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Push' }))
    await waitFor(() => expect(sent(command)[0]).toMatchObject({ type: 'git-action', action: 'push' }))
  })
  it('shows a failed action once, in the host\'s words, and tells the pane so its error line stays quiet', async () => {
    const explained = vi.fn()
    const failed: GitActionProgress = { actionId: 'a', action: 'push', status: 'failed', phases: ['push'], phase: null, stage: null, hook: null, startedAt: 't', finishedAt: 't', result: null, error: 'Push failed. rejected' }
    mount(thread(status({ ahead: 1 }), { gitAction: failed }), { explained })
    expect(screen.getByRole('alert')).toHaveTextContent('Action failed Push failed. rejected')
    expect(explained).toHaveBeenLastCalledWith('Push failed. rejected')
    fireEvent.keyDown(screen.getByRole('alert'), { key: 'Escape' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(explained).toHaveBeenLastCalledWith(null)
    // A refusal the host did not write onto the record (the lane was busy) is the command's own error.
    const busy = thread(status({ ahead: 1 }))
    cleanup()
    const view = mount(busy, { command: async () => state(busy, { error: 'Git action in progress.' }), explained })
    fireEvent.click(view.container.querySelector('.git-action__quick')!)
    expect(await screen.findByRole('alert')).toHaveTextContent('Action failed Git action in progress.')
    expect(explained).toHaveBeenLastCalledWith('Git action in progress.')
  })
  it('publishes to GitHub from the dialog after checking the name', async () => {
    const current = thread(status({ hasRemote: false, upstream: null }))
    const { command } = mount(current, { command: async () => state(current, { notice: 'Repository published at https://github.com/o/r.' }) })
    expect(quick()).toHaveTextContent('Publish repository')
    fireEvent.click(quick())
    const dialog = await screen.findByRole('dialog', { name: 'Publish repository' })
    const field = within(dialog).getByRole('textbox', { name: 'Repository' })
    expect(field).toHaveFocus()
    fireEvent.change(field, { target: { value: 'not a name' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Name the repository as owner/name.')
    fireEvent.change(field, { target: { value: 'o/r' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Public' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'git-publish', threadId: 'thread-1', repository: 'o/r', visibility: 'public' }]))
    expect(await screen.findByRole('status')).toHaveTextContent('Repository published at https://github.com/o/r.')
  })
  it('runs one command at a time from the header', async () => {
    let release!: () => void
    const current = thread(status({ ahead: 1, pullRequest: pr }))
    const { command } = mount(current, { command: () => new Promise(resolve => { release = () => resolve(state(current)) }) })
    fireEvent.click(quick())
    await waitFor(() => expect(quick()).toBeDisabled())
    fireEvent.click(quick())
    expect(command).toHaveBeenCalledTimes(1)
    await act(async () => { release() })
    await waitFor(() => expect(quick()).toBeEnabled())
  })
})
