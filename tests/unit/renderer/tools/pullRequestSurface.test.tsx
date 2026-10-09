import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PullRequestSurface } from '../../../../src/renderer/src/tools/PullRequestSurface'
import {
  canAutoMerge, checklist, checklistCount, checklistHeading, confirmationFor, limitedWords, linesLeft, mergedWhen, mergeEffect, mergeReady, resolveMergeMethod,
} from '../../../../src/renderer/src/tools/pullRequestSurface.logic'
import type { AgentCommand, AgentState, AgentThread } from '../../../../src/shared/agents'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../src/shared/settings'
import { useOptionalApp, type AppContextValue } from '../../../../src/renderer/src/state/AppContext'
import { usePullRequestMergeMethod } from '../../../../src/renderer/src/tools/usePullRequestMergeMethod'
import { BABYSIT_ENDINGS_DISMISSED_KEY } from '../../../../src/renderer/src/tools/babysitEndingsDismissed'
import { gitPullRequestDetailSchema, type GitPullRequestCheck, type GitPullRequestDetail, type GitPullRequestRead, type GitPullRequestReview } from '../../../../src/shared/gitPullRequests'

vi.mock('../../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(() => null),
}))
/** The app's settings as the Merge method setting sees them, and the save a pick beside Merge makes. */
function withSettings(settings: Partial<AppSettings>) {
  const updateSettings = vi.fn(async () => true)
  vi.mocked(useOptionalApp).mockReturnValue({ settings: { ...DEFAULT_SETTINGS, ...settings }, actions: { updateSettings } } as unknown as AppContextValue)
  return updateSettings
}

const URL = 'https://github.com/o/r/pull/74'
const check = (name: string, status: GitPullRequestCheck['status'], url: string | null = null, description: string | null = null): GitPullRequestCheck => ({ name, status, url, description })
const review = (author: string, state: GitPullRequestReview['state'], url: string | null = `${URL}#pullrequestreview-${author}`): GitPullRequestReview => ({ author, state, url })
function detail(change: Partial<GitPullRequestDetail> = {}): GitPullRequestDetail {
  return { number: 74, url: URL, title: 'Make the greeting friendlier', body: 'Says hello.\n\n- One change', state: 'open', draft: false, baseBranch: 'main', headBranch: 'feat/greeting',
    crossRepository: false, reviewDecision: 'approved', reviews: [review('mira', 'approved')], mergeable: 'mergeable', checks: [check('CI / build', 'success', 'https://github.com/o/r/actions/runs/1')], checksUnknown: false,
    mergeMethods: ['merge', 'squash', 'rebase'], autoMergeAllowed: true, autoMerge: null, mergedAt: null, behindBy: 0, canUpdateBranch: true, linked: null, branch: true, ...change }
}
const git = (change: Record<string, unknown> = {}) => ({ isRepository: true, branch: 'feat/greeting', upstream: 'origin/feat/greeting', hasRemote: true, defaultBranch: 'main', isDefaultBranch: false,
  dirty: false, changedFiles: 0, insertions: 0, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: 1, pullRequest: null, fetchedAt: null, readAt: '2026-09-23T00:00:00.000Z', ...change })
function thread(change: Partial<AgentThread> = {}): AgentThread {
  return { id: 'thread-1', projectId: 'project', title: 'Task', modelId: 'codex:model', status: 'idle', messages: [], requests: [],
    worktree: { mode: 'shared', status: 'ready', path: 'C:/app', branch: 'feat/greeting', git: git({ pullRequest: { number: 74, title: 'Make the greeting friendlier', url: URL, state: 'open', draft: false } }) },
    ...change } as AgentThread
}
function mount(options: { detail?: GitPullRequestRead | ((request: { reference?: string }) => GitPullRequestRead); thread?: AgentThread; result?: Partial<AgentState>; babysit?: { agent: string } } = {}) {
  const gitPullRequest = vi.fn(async (request: { threadId: string; reference?: string }) => typeof options.detail === 'function' ? options.detail(request) : options.detail === undefined ? detail() : options.detail)
  const openExternalLink = vi.fn(async () => ({ ok: true }))
  const writeText = vi.fn(async () => undefined)
  vi.stubGlobal('sotto', { agents: { gitPullRequest }, openExternalLink })
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => ({ notice: 'Pull request merged.', error: null, ...options.result }) as AgentState)
  const onStatus = vi.fn()
  const view = render(<PullRequestSurface thread={options.thread ?? thread()} command={command} onStatus={onStatus} babysit={options.babysit} />)
  return { ...view, command, gitPullRequest, openExternalLink, writeText, onStatus }
}
const sent = (command: ReturnType<typeof mount>['command']) => command.mock.calls.map(call => call[0])
const lines = () => within(screen.getByRole('list', { name: 'Merge checklist' })).getAllByRole('listitem')
const mergeButton = () => screen.getByRole('button', { name: 'Merge #74' })
async function opened() { await screen.findByRole('heading', { name: '#74 Make the greeting friendlier' }) }
async function menu(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: label }))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.mocked(useOptionalApp).mockReset().mockReturnValue(null) })

it('copies the pull request link through main when browser clipboard access is denied', async () => {
  const { writeText, onStatus } = mount()
  writeText.mockRejectedValue(new Error('Permission denied'))
  const deliverOutput = vi.fn(async () => 'copied')
  vi.stubGlobal('sotto', { ...window.sotto, deliverOutput })
  await opened()
  await menu('Copy link')
  await waitFor(() => expect(deliverOutput).toHaveBeenCalledWith({ text: URL, autoPaste: false, pasteDelayMs: 50 }))
  expect(writeText).not.toHaveBeenCalled()
  expect(onStatus).toHaveBeenCalledWith('Link copied')
})

describe('the merge checklist, read from the pull request', () => {
  const read = (change: Partial<GitPullRequestDetail>) => checklist(detail(change)).map(line => [line.label, line.tone, line.why, line.fix?.kind ?? null])
  it('lists five lines in the order a merge meets them, each done for a pull request ready to merge', () => {
    expect(read({})).toEqual([
      ['Checks passing', 'done', 'CI / build passed', null],
      ['Review approved', 'done', 'Approved by mira', null],
      ['Up to date with main', 'done', 'Has every commit on main', null],
      ['No conflicts', 'done', 'Merges cleanly into main', null],
      ['Ready for review', 'done', 'Not a draft', null],
    ])
    expect(mergeReady(detail(), checklist(detail()))).toBe(true)
    expect(checklistHeading(detail(), true)).toBe('Ready to merge')
  })
  it('gives each line that holds the merge back its one press: the failing check, the review, Update branch, Ready for review', () => {
    const draft = read({ draft: true, reviewDecision: 'review_required', reviews: [], checks: [check('Gates (Windows)', 'success'), check('Gates (macOS)', 'pending')], behindBy: 2 })
    expect(draft).toEqual([
      ['Checks passing', 'running', 'Gates (macOS) is still running', null],
      ['Review approved', 'todo', 'Reviewers wait until it is ready', null],
      ['Up to date with main', 'todo', '2 commits behind main', 'update-branch'],
      ['No conflicts', 'done', 'Merges cleanly into main', null],
      ['Ready for review', 'todo', 'Still a draft', 'ready'],
    ])
    const failing = checklist(detail({ reviewDecision: 'changes_requested', reviews: [review('mira', 'changes_requested')],
      checks: [check('Gates (Windows)', 'failure', 'https://github.com/o/r/actions/runs/9', '3 tests failed in tests/unit/main'), check('Notices', 'success')] }))
    expect(failing[0]).toMatchObject({ tone: 'failed', why: 'Gates (Windows) failed: 3 tests failed in tests/unit/main', fix: { kind: 'open-check', name: 'Gates (Windows)', url: 'https://github.com/o/r/actions/runs/9' } })
    expect(failing[1]).toMatchObject({ tone: 'failed', why: 'mira asked for changes', fix: { kind: 'open-review', author: 'mira', url: `${URL}#pullrequestreview-mira` } })
    expect(mergeReady(detail(), failing)).toBe(false)
    expect(linesLeft(failing)).toBe('2 lines left before this can merge.')
    expect(checklistHeading(detail(), false)).toBe('Before merging')
    expect(read({ checks: [check('a', 'cancelled'), check('b', 'failure')] })[0]).toEqual(['Checks passing', 'failed', 'a was cancelled, and 1 more', null])
    expect(read({ checks: [check('deploy', 'action-required', 'https://github.com/o/r/actions/runs/3')] })[0]).toEqual(['Checks passing', 'todo', 'deploy is waiting for approval on GitHub', 'open-check'])
    expect(read({ checks: [check('a', 'success'), check('b', 'skipped')] })[0]).toEqual(['Checks passing', 'done', '1 passed, 1 skipped', null])
    expect(read({ canUpdateBranch: false, behindBy: 1 })[2]).toEqual(['Up to date with main', 'todo', '1 commit behind main. GitHub does not let this account update it', null])
    expect(read({ mergeable: 'conflicting' })[3]).toEqual(['No conflicts', 'failed', 'Conflicts with main. Resolve them in the branch and push', null])
    expect(read({ mergeable: 'unknown' })[3]).toEqual(['No conflicts', 'running', 'GitHub is still checking. Refresh in a moment', null])
  })
  it('says what GitHub reports rather than an approval nobody gave: no checks, no review required, a base it could not compare', () => {
    const noted = checklist(detail({ checks: [], reviewDecision: null, reviews: [], behindBy: null }))
    expect(noted.map(line => [line.label, line.tone, line.why])).toEqual([
      ['No checks', 'done', 'GitHub reports none for this pull request'],
      ['No review required', 'done', 'This repository merges without one'],
      ['Up to date with main', 'unknown', 'GitHub could not compare it with main'],
      ['No conflicts', 'done', 'Merges cleanly into main'],
      ['Ready for review', 'done', 'Not a draft'],
    ])
    // A comparison GitHub could not make does not hold the merge back: nothing here could fix it, and GitHub decides on the press.
    expect(mergeReady(detail(), noted)).toBe(true)
    // The count says so beside "Ready to merge", rather than seeming to disagree with it.
    expect(checklistCount(noted)).toBe('4 of 5 done, 1 does not block')
    expect(checklistCount(checklist(detail()))).toBe('5 of 5 done')
    expect(checklistCount(checklist(detail({ draft: true })))).toBe('4 of 5 done')
    // Checks GitHub refused to show are not "No checks": the line says they could not be read, and is not counted as done.
    const refused = checklist(detail({ checks: [], checksUnknown: true }))
    expect([refused[0]!.label, refused[0]!.tone, refused[0]!.why]).toEqual(['Checks passing', 'unknown', 'GitHub did not let Sotto read the checks'])
    expect(checklistCount(refused)).toBe('4 of 5 done, 1 does not block')
    // A failing check GitHub did return is never hidden behind unknown, and still holds the merge back.
    const failing = checklist(detail({ checks: [check('lint', 'failure', 'https://github.com/o/r/actions/runs/2')], checksUnknown: true }))
    expect([failing[0]!.tone, failing[0]!.why]).toEqual(['failed', 'lint failed'])
    expect(mergeReady(detail(), failing)).toBe(false)
    // Every returned check passed, but not every check was read: unknown, not done.
    const passing = checklist(detail({ checks: [check('build', 'success')], checksUnknown: true }))
    expect([passing[0]!.tone, passing[0]!.why]).toEqual(['unknown', 'GitHub did not let Sotto read every check'])
    // Where no review is required, a request for changes still standing is said and linked, in whichever order it came,
    // and holds the merge back no more than GitHub does.
    const openAfter = checklist(detail({ reviewDecision: null, reviews: [review('mira', 'approved'), review('ola', 'changes_requested')] }))
    const openBefore = checklist(detail({ reviewDecision: null, reviews: [review('ola', 'changes_requested'), review('mira', 'approved')] }))
    for (const lines of [openAfter, openBefore]) {
      expect(lines[1]).toEqual({ id: 'review', label: 'Review approved', tone: 'open', why: 'Approved by mira. ola\'s request for changes is still open',
        fix: { kind: 'open-review', author: 'ola', url: `${URL}#pullrequestreview-ola` } })
      expect(mergeReady(detail(), lines)).toBe(true)
      expect(checklistCount(lines)).toBe('4 of 5 done, 1 does not block')
    }
    expect(checklist(detail({ reviewDecision: null, reviews: [review('ola', 'changes_requested'), review('sam', 'changes_requested')] }))[1])
      .toMatchObject({ label: 'Review', tone: 'open', why: 'sam and 1 more asked for changes. This repository does not require a review', fix: { author: 'sam' } })
  })
  it('reads a merged or closed pull request as settled, and offers auto-merge only where it can be armed', () => {
    const merged = detail({ state: 'merged', behindBy: 3, mergeable: 'unknown' })
    expect(checklist(merged).every(line => line.tone === 'done')).toBe(true)
    expect(mergeReady(merged, checklist(merged))).toBe(false)
    expect(checklistHeading(merged, false)).toBe('Merge checklist')
    const closed = checklist(detail({ state: 'closed', draft: true, behindBy: 1, mergeable: 'unknown' }))
    expect(closed.map(line => line.fix)).toEqual([null, null, null, null, null])
    expect(canAutoMerge(detail())).toBe(true)
    expect(canAutoMerge(detail({ draft: true }))).toBe(false)
    expect(canAutoMerge(detail({ autoMergeAllowed: false }))).toBe(false)
    expect(canAutoMerge(detail({ autoMerge: { method: 'squash' } }))).toBe(false)
  })
  it('picks the method chosen last where it is allowed, says what each leaves, and confirms in T3\'s words', () => {
    expect(resolveMergeMethod(['merge', 'squash'], 'squash')).toBe('squash')
    expect(resolveMergeMethod(['rebase'], 'squash')).toBe('rebase')
    expect(resolveMergeMethod(['merge', 'squash'], null)).toBe('merge')
    expect(mergeEffect('squash', 'main')).toBe('One commit on main')
    expect(mergeEffect('rebase', 'main')).toBe('Every commit, replayed onto main')
    expect(mergeEffect('merge', 'main')).toBe('Every commit, plus a merge commit')
    expect(confirmationFor('merge', 74, 'squash', 'main')).toEqual({ title: 'Merge pull request?', description: 'This merges #74 into main using squash and merge.', confirm: 'Squash and merge', danger: false })
    expect(confirmationFor('close', 74, 'merge')).toMatchObject({ title: 'Close pull request?', description: 'This closes #74 without merging it.', danger: true })
    expect(limitedWords('not a date')).toBe('GitHub is limiting requests from your gh sign-in. Nothing was lost. Refresh in a few minutes.')
    // The Link and Checkout dialogs have no Refresh button, so they do not name one.
    expect(limitedWords('not a date', 'try-again')).toBe('GitHub is limiting requests from your gh sign-in. Nothing was lost. Try again in a few minutes.')
    expect(limitedWords('2026-09-23T10:14:00Z', 'try-again', new Date('2026-09-23T10:00:00Z'))).toMatch(/Try again after .*\d/u)
    expect(mergedWhen(null)).toBeNull()
    expect(mergedWhen('not a date')).toBeNull()
    expect(mergedWhen('2026-09-23T10:14:00Z', new Date('2026-09-23T12:00:00Z'))).toMatch(/\d/u)
  })
})

describe('the Pull request surface', () => {
  it('shows the checklist and sends nothing from viewing', async () => {
    const { command, gitPullRequest } = mount()
    await opened()
    expect(gitPullRequest).toHaveBeenCalledWith({ threadId: 'thread-1' })
    expect(screen.getByText('Open', { selector: '.pr-surface__tag' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ready to merge 5 of 5 done' })).toBeInTheDocument()
    expect(lines().map(line => line.textContent)).toEqual([
      'Done: Checks passingCI / build passed', 'Done: Review approvedApproved by mira', 'Done: Up to date with mainHas every commit on main',
      'Done: No conflictsMerges cleanly into main', 'Done: Ready for reviewNot a draft'])
    expect(mergeButton()).not.toHaveAttribute('aria-disabled')
    expect(screen.getByText('Every commit, plus a merge commit.')).toBeInTheDocument()
    // The description folds below, closed until asked for.
    expect(screen.queryByText(/Says hello\./u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Description' }))
    expect(screen.getByRole('button', { name: 'Description' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/Says hello\./u)).toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
  })
  it('merges only after its confirmation, in the method chosen beside it, and saves it as the last selected', async () => {
    const save = withSettings({ defaultMergeMethod: 'last', lastMergeMethod: 'merge' })
    const { command, gitPullRequest } = mount()
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Merge method: Merge' }))
    const methods = screen.getByRole('menu', { name: 'Merge method' })
    expect(within(methods).getByRole('menuitemradio', { name: 'Merge' })).toHaveFocus()
    expect(within(methods).getAllByRole('menuitemradio').map(item => [item.getAttribute('aria-label'), item.getAttribute('aria-description'), item.getAttribute('aria-checked')])).toEqual([
      ['Merge', 'Every commit, plus a merge commit', 'true'], ['Squash and merge', 'One commit on main', 'false'], ['Rebase and merge', 'Every commit, replayed onto main', 'false']])
    fireEvent.keyDown(methods, { key: 'ArrowDown' })
    expect(within(methods).getByRole('menuitemradio', { name: 'Squash and merge' })).toHaveFocus()
    fireEvent.click(within(methods).getByRole('menuitemradio', { name: 'Squash and merge' }))
    expect(screen.queryByRole('menu', { name: 'Merge method' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Merge method: Squash and merge' })).toHaveFocus()
    expect(save).toHaveBeenCalledExactlyOnceWith({ lastMergeMethod: 'squash' })
    expect(localStorage.getItem('sotto.pullRequestMergeMethod')).toBeNull()
    expect(screen.getByText('One commit on main.')).toBeInTheDocument()
    fireEvent.click(mergeButton())
    const dialog = screen.getByRole('dialog', { name: 'Merge pull request?' })
    expect(dialog).toHaveTextContent('This merges #74 into main using squash and merge.')
    expect(command).not.toHaveBeenCalled()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Squash and merge' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'git-pull-request-action', threadId: 'thread-1', url: URL, action: 'merge', method: 'squash' }]))
    expect(await screen.findByText('Pull request merged.')).toHaveAttribute('role', 'status')
    await waitFor(() => expect(gitPullRequest).toHaveBeenCalledTimes(2)) // read again after the press
  })
  it('starts on the Merge method setting, and under a fixed default holds a pick without saving it', async () => {
    const save = withSettings({ defaultMergeMethod: 'rebase', lastMergeMethod: 'squash' })
    mount()
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Merge method: Rebase and merge' }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Merge method' })).getByRole('menuitemradio', { name: 'Squash and merge' }))
    expect(screen.getByRole('button', { name: 'Merge method: Squash and merge' })).toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
    cleanup()
    withSettings({ defaultMergeMethod: 'last', lastMergeMethod: 'squash' })
    mount()
    await opened()
    expect(screen.getByRole('button', { name: 'Merge method: Squash and merge' })).toBeInTheDocument()
    // A method this repository does not allow falls back to the first it does.
    cleanup()
    withSettings({ defaultMergeMethod: 'rebase' })
    mount({ detail: detail({ mergeMethods: ['merge', 'squash'] }) })
    await opened()
    expect(screen.getByRole('button', { name: 'Merge method: Merge' })).toBeInTheDocument()
  })
  it('holds a pick until the setting\'s method changes, then starts on the setting again', () => {
    withSettings({ defaultMergeMethod: 'merge' })
    const hook = renderHook(() => usePullRequestMergeMethod())
    expect(hook.result.current[0]).toBe('merge')
    act(() => hook.result.current[1]('squash'))
    expect(hook.result.current[0]).toBe('squash')
    hook.rerender()
    expect(hook.result.current[0]).toBe('squash')
    // The Merge method setting changes while the surface is open: the setting wins over the earlier pick.
    withSettings({ defaultMergeMethod: 'rebase' })
    hook.rerender()
    expect(hook.result.current[0]).toBe('rebase')
    act(() => hook.result.current[1]('merge'))
    expect(hook.result.current[0]).toBe('merge')
  })
  it('closes the method menu and the confirmation with Escape, sending nothing', async () => {
    const { command } = mount()
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Merge method: Merge' }))
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Merge method' }), { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Merge method' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Merge method: Merge' })).toHaveFocus()
    fireEvent.click(mergeButton())
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(command).not.toHaveBeenCalled()
  })
  it('keeps Merge disabled while a line holds it back, and offers Merge when ready instead', async () => {
    const { command, openExternalLink } = mount({ detail: detail({ reviewDecision: 'changes_requested', reviews: [review('mira', 'changes_requested')],
      checks: [check('Gates (Windows)', 'failure', 'https://github.com/o/r/actions/runs/9', '3 tests failed')] }) })
    await opened()
    expect(screen.getByRole('heading', { name: 'Before merging 3 of 5 done' })).toBeInTheDocument()
    expect(mergeButton()).toHaveAttribute('aria-disabled', 'true')
    expect(mergeButton()).toHaveAccessibleDescription('2 lines left before this can merge. Merge when ready')
    fireEvent.click(mergeButton())
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open Gates (Windows) on GitHub' }))
    expect(openExternalLink).toHaveBeenLastCalledWith('https://github.com/o/r/actions/runs/9')
    fireEvent.click(screen.getByRole('button', { name: 'Open mira\'s review on GitHub' }))
    expect(openExternalLink).toHaveBeenLastCalledWith(`${URL}#pullrequestreview-mira`)
    fireEvent.click(screen.getByRole('button', { name: 'Merge when ready' }))
    const dialog = screen.getByRole('dialog', { name: 'Enable auto-merge?' })
    expect(dialog).toHaveTextContent('This merges #74 using merge as soon as GitHub considers it ready, which may be immediately.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable auto-merge' }))
    await waitFor(() => expect(sent(command)).toEqual([expect.objectContaining({ action: 'enable-auto-merge', method: 'merge' })]))
  })
  it('leaves Merge when ready out where the repository does not allow auto-merge', async () => {
    mount({ detail: detail({ autoMergeAllowed: false, checks: [check('build', 'pending')] }) })
    await opened()
    expect(screen.getByText('1 line left before this can merge.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Merge when ready' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Merge when ready (auto-merge)' })).toBeNull()
  })
  it('fixes a line with its own press: Update branch and Ready for review, neither asking first', async () => {
    const { command } = mount({ detail: detail({ draft: true, behindBy: 2 }) })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Update branch' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'git-pull-request-action', threadId: 'thread-1', url: URL, action: 'update-branch' }]))
    await waitFor(() => expect(within(lines()[4]!).getByRole('button', { name: 'Ready for review' })).toBeEnabled())
    fireEvent.click(within(lines()[4]!).getByRole('button', { name: 'Ready for review' }))
    await waitFor(() => expect(sent(command)[1]).toEqual({ type: 'git-pull-request-action', threadId: 'thread-1', url: URL, action: 'ready' }))
  })
  it('shows an armed auto-merge, a closed and a merged pull request in place of Merge', async () => {
    const armed = mount({ detail: detail({ autoMerge: { method: 'squash' }, checks: [check('build', 'pending')] }) })
    expect(await screen.findByText('GitHub merges this with squash and merge when every line is done.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Merge #74' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Turn off auto-merge' }))
    await waitFor(() => expect(sent(armed.command)).toEqual([expect.objectContaining({ action: 'disable-auto-merge' })]))
    cleanup()
    const closed = mount({ detail: detail({ state: 'closed' }) })
    expect(await screen.findByText('Closed without merging')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^Merge checklist/u })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect(sent(closed.command)).toEqual([expect.objectContaining({ action: 'reopen' })]))
    cleanup()
    const merged = mount({ detail: detail({ state: 'merged', mergedAt: '2026-09-23T10:14:00Z' }) })
    await waitFor(() => expect(merged.container.querySelector('.pr-surface__finished strong')).toHaveTextContent('Merged into main'))
    expect(screen.queryByRole('button', { name: 'Merge #74' })).toBeNull()
  })
  it('holds the rest in ···: Convert to draft, Update with rebase and Close after their words, Copy link, Unlink', async () => {
    const { command, writeText, onStatus } = mount({ detail: detail({ behindBy: 1, linked: 'created' }) })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Convert to draft', 'Update with rebase', 'Merge when ready (auto-merge)', 'Copy link', 'Link pull request', 'Unlink from thread', 'Close pull request'])
    expect(screen.getByRole('menuitem', { name: 'Close pull request' })).toHaveAttribute('data-tone', 'danger')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL))
    expect(onStatus).toHaveBeenCalledWith('Link copied')
    await menu('Update with rebase')
    const rebase = screen.getByRole('dialog', { name: 'Update with rebase?' })
    expect(rebase).toHaveTextContent('This rebases the branch of #74 onto main on GitHub, rewriting its commits. A local copy of the branch will no longer match it')
    fireEvent.click(within(rebase).getByRole('button', { name: 'Update with rebase' }))
    await waitFor(() => expect(sent(command)).toEqual([expect.objectContaining({ action: 'update-branch', method: 'rebase' })]))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update branch' })).toBeEnabled())
    await menu('Convert to draft')
    await waitFor(() => expect(sent(command)[1]).toEqual(expect.objectContaining({ action: 'draft' })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update branch' })).toBeEnabled())
    await menu('Close pull request')
    const close = screen.getByRole('dialog', { name: 'Close pull request?' })
    fireEvent.click(within(close).getByRole('button', { name: 'Close pull request' }))
    await waitFor(() => expect(sent(command)[2]).toEqual({ type: 'git-pull-request-action', threadId: 'thread-1', url: URL, action: 'close' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update branch' })).toBeEnabled())
    await menu('Unlink from thread')
    await waitFor(() => expect(sent(command)[3]).toEqual({ type: 'git-unlink-pull-request', threadId: 'thread-1', url: URL }))
  })
  it('opens the pull request on GitHub from its top line, and says GitHub\'s refusal in the host\'s words', async () => {
    const { openExternalLink } = mount({ detail: detail({ draft: true }), result: { error: 'Could not mark this ready for review. GraphQL: Resource not accessible by integration', notice: null } as never })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Open on GitHub' }))
    expect(openExternalLink).toHaveBeenCalledWith(URL)
    fireEvent.click(within(lines()[4]!).getByRole('button', { name: 'Ready for review' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not mark this ready for review. GraphQL: Resource not accessible by integration')
  })
  it('says when there is nothing to merge yet, creates the pull request the way the Git action does, and links one', async () => {
    const { command } = mount({ detail: null, thread: thread({ worktree: { mode: 'shared', status: 'ready', path: 'C:/app', git: git() } as AgentThread['worktree'] }), result: { notice: 'Linked PR #42.' } })
    expect(await screen.findByRole('heading', { name: 'Nothing to merge yet' })).toBeInTheDocument()
    expect(screen.getByText(/has no pull request\./u)).toHaveTextContent('feat/greeting has no pull request. Once it has one, this lists what stands between it and main.')
    fireEvent.click(screen.getByRole('button', { name: 'Create PR' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'git-action', threadId: 'thread-1', actionId: expect.any(String), action: 'create_pr' }]))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create PR' })).not.toHaveAttribute('aria-disabled'))
    fireEvent.click(screen.getByRole('button', { name: 'Link pull request' }))
    const dialog = screen.getByRole('dialog', { name: 'Link pull request' })
    const field = within(dialog).getByRole('textbox', { name: 'Pull request' })
    expect(field).toHaveFocus()
    fireEvent.change(field, { target: { value: 'main' } })
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Use a pull request URL, 123, or #123.')
    fireEvent.change(field, { target: { value: '#42' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Link' }))
    await waitFor(() => expect(sent(command)[1]).toEqual({ type: 'git-link-pull-request', threadId: 'thread-1', reference: '#42' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('Linked PR #42.')).toBeInTheDocument()
  })
  it('holds Create PR back with the Git action\'s reason on the default branch', async () => {
    const { command } = mount({ detail: null, thread: thread({ worktree: { mode: 'shared', status: 'ready', path: 'C:/app', git: git({ branch: 'main', isDefaultBranch: true }) } as AgentThread['worktree'] }) })
    const create = await screen.findByRole('button', { name: 'Create PR' })
    expect(screen.getByText(/is the default branch\./u, { selector: 'p' })).toHaveTextContent('main is the default branch. Once this thread is on a branch with a pull request, this lists what stands between it and main.')
    expect(create).toHaveAttribute('aria-disabled', 'true')
    expect(create).toHaveAccessibleDescription('Commit on a new branch first: this is the default branch.')
    fireEvent.click(create)
    expect(command).not.toHaveBeenCalled()
  })
  it('reads once on opening, and not again when a link only brings its title up to date', async () => {
    const linked = (title: string) => thread({ pullRequests: [{ number: 74, url: URL, title, state: 'open', draft: false, source: 'created', linkedAt: '2026-09-23T00:00:00.000Z' }] })
    const { gitPullRequest, rerender } = mount({ thread: linked('Old title') })
    await opened()
    rerender(<PullRequestSurface thread={linked('Make the greeting friendlier')} command={vi.fn()} onStatus={vi.fn()} />)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(gitPullRequest).toHaveBeenCalledTimes(1)
  })
  it('folds the linked pull requests below, and opens one in the surface', async () => {
    const linked = thread({ pullRequests: [
      { number: 70, url: 'https://github.com/o/r/pull/70', title: 'Older work', state: 'merged', draft: false, source: 'linked', linkedAt: '2026-09-22T00:00:00.000Z' },
      { number: 74, url: URL, title: 'Make the greeting friendlier', state: 'open', draft: false, source: 'created', linkedAt: '2026-09-23T00:00:00.000Z' },
    ] })
    const { gitPullRequest } = mount({ thread: linked, detail: request => request.reference?.endsWith('/70')
      ? detail({ number: 70, url: 'https://github.com/o/r/pull/70', title: 'Older work', state: 'merged', linked: 'linked', branch: false }) : detail({ linked: 'created' }) })
    await opened()
    const fold = screen.getByRole('button', { name: 'Linked pull requests 2' })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(fold)
    const list = screen.getByRole('list', { name: 'Linked pull requests' })
    expect(within(list).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'PR #74, Open: Make the greeting friendlier. Created from this thread', 'PR #70, Merged: Older work. Linked by you'])
    fireEvent.click(within(list).getByRole('button', { name: /^PR #70/u }))
    expect(await screen.findByRole('heading', { name: '#70 Older work' })).toBeInTheDocument()
    expect(gitPullRequest).toHaveBeenLastCalledWith({ threadId: 'thread-1', reference: 'https://github.com/o/r/pull/70' })
    await waitFor(() => expect(screen.getByRole('heading', { name: '#70 Older work' })).toHaveFocus())
  })
  it('says a failed Refresh over the checklist it keeps, rather than showing it as fresh', async () => {
    let fail = false
    const { gitPullRequest } = mount({ detail: () => { if (fail) throw new Error('offline'); return detail() } })
    await opened()
    fail = true
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pull request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the pull request from GitHub. Check your gh sign-in and connection, then refresh. What shows below is from the last read.')
    expect(gitPullRequest).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('list', { name: 'Merge checklist' })).toBeInTheDocument()
  })
  it('says when GitHub limits the sign-in and when to refresh, over the checklist it keeps (#820)', async () => {
    const retryAt = new Date(Date.now() + 20 * 60_000).toISOString()
    let limited = false
    mount({ detail: () => limited ? { limited: { retryAt } } : detail() })
    await opened()
    limited = true
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pull request' }))
    const when = mergedWhen(retryAt)!
    expect(await screen.findByRole('alert')).toHaveTextContent(`GitHub is limiting requests from your gh sign-in until ${when}. Nothing was lost. Refresh after ${when}. What shows below is from the last read.`)
    expect(screen.getByRole('list', { name: 'Merge checklist' })).toBeInTheDocument()
  })
  it('puts focus back on the pull request when a press settles its line and takes its button away', async () => {
    let ready = false
    const { command } = mount({ detail: () => detail({ draft: !ready }) })
    command.mockImplementation(async () => { ready = true; return { notice: 'Marked ready for review.', error: null } as unknown as AgentState })
    await opened()
    const press = within(lines()[4]!).getByRole('button', { name: 'Ready for review' })
    press.focus()
    fireEvent.click(press)
    await waitFor(() => expect(within(lines()[4]!).queryByRole('button')).toBeNull())
    await waitFor(() => expect(screen.getByRole('heading', { name: '#74 Make the greeting friendlier' })).toHaveFocus())
  })
  it('keeps every press off until GitHub has been read again after one, so nothing is pressed twice over the old reading', async () => {
    let answer: ((value: GitPullRequestDetail) => void) | null = null
    let reads = 0
    const { command } = mount({ detail: (() => { reads += 1; return reads === 1 ? detail({ behindBy: 2 }) : new Promise<GitPullRequestDetail>(resolve => { answer = resolve }) }) as never })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Update branch' }))
    await waitFor(() => expect(reads).toBe(2))
    // The command has answered and the re-read is running: the old reading is still on screen, and none of it can be pressed.
    expect(sent(command)).toEqual([expect.objectContaining({ action: 'update-branch' })])
    expect(screen.getByRole('button', { name: 'Updating...' })).toBeDisabled()
    expect(mergeButton()).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Merge method: Merge' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Updating...' }))
    expect(command).toHaveBeenCalledTimes(1)
    answer!(detail())
    await waitFor(() => expect(mergeButton()).not.toHaveAttribute('aria-disabled'))
    expect(screen.queryByRole('button', { name: 'Update branch' })).toBeNull()
  })
  it('reads an open request for changes with nobody approving without claiming an approval', async () => {
    mount({ detail: detail({ reviewDecision: null, reviews: [review('ola', 'changes_requested')] }) })
    await opened()
    expect(lines()[1]).toHaveTextContent('Does not block: Reviewola asked for changes. This repository does not require a review')
    expect(lines()[1]).not.toHaveTextContent(/approved/iu)
    expect(within(lines()[1]!).getByRole('button', { name: "Open ola's review on GitHub" })).toBeInTheDocument()
  })
  it('shows the count in the done colour beside Ready to merge, a line that does not block included', async () => {
    mount({ detail: detail({ behindBy: null }) })
    await opened()
    const heading = screen.getByRole('heading', { name: 'Ready to merge 4 of 5 done, 1 does not block' })
    expect(heading.querySelector('small')).toHaveAttribute('data-tone', 'done')
    expect(mergeButton()).not.toHaveAttribute('aria-disabled')
  })
  it('reads a paired host on an earlier build, which names no reviewer and no merge time', () => {
    const earlier: Record<string, unknown> = { ...detail() }
    delete earlier.reviews; delete earlier.mergedAt
    expect(gitPullRequestDetailSchema.parse(earlier)).toMatchObject({ reviews: [], mergedAt: null })
  })
})

it('explains how to recover when copying the pull request link fails', async () => {
  const { onStatus, openExternalLink } = mount()
  vi.stubGlobal('sotto', { ...window.sotto, deliverOutput: vi.fn(async () => 'failed') })
  await opened()
  await menu('Copy link')
  await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Could not copy the link. Open on GitHub and copy the address from your browser.'))
  fireEvent.click(screen.getByRole('button', { name: 'Open on GitHub' }))
  expect(openExternalLink).toHaveBeenCalledWith(URL)
})

describe('babysitting the pull request shown (ADR-0061, variant C)', () => {
  const startedAt = new Date(Date.now() - 60_000).toISOString()
  const babysat = (startedBy: 'agent' | 'user') => thread({ babysitting: [{ url: URL, number: 74, startedBy, startedAt }] })
  it('offers Babysit pull request in the ··· menu, after the merge items, and says it started in passing', async () => {
    const { command, onStatus } = mount({ babysit: { agent: 'Claude Code' }, result: { notice: 'Babysitting PR #74.' } })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Convert to draft', 'Merge when ready (auto-merge)', 'Babysit pull request', 'Copy link', 'Link pull request', 'Close pull request'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Babysit pull request' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'babysit-pull-request', threadId: 'thread-1', url: URL }]))
    // The docked line says it once it comes; nothing above the checklist holds it down meanwhile.
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Babysitting #74'))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('docks the line above Merge while it babysits, and stops it with Stop', async () => {
    const { command, onStatus } = mount({ babysit: { agent: 'Claude Code' }, thread: babysat('agent'), result: { notice: 'Stopped babysitting PR #74.' } })
    await opened()
    const line = screen.getByRole('group', { name: /^Babysitting since / })
    expect(line).toHaveTextContent('Started by Claude Code. Sotto sends this thread a wake-up when #74 needs it.')
    // Docked under the checklist, before Merge in the reading order.
    expect(line.compareDocumentPosition(mergeButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Babysit pull request' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    const stop = within(line).getByRole('button', { name: 'Stop babysitting #74' })
    stop.focus()
    fireEvent.click(stop)
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'stop-babysitting', threadId: 'thread-1', url: URL }]))
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Stopped babysitting #74'))
    // Focus moves on to ···, where Babysit pull request will be, without waiting for the line to go.
    await waitFor(() => expect(screen.getByRole('button', { name: 'More pull request actions' })).toHaveFocus())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says the host’s refusal in its own words', async () => {
    mount({ babysit: { agent: 'Codex' }, result: { error: 'Link this pull request to the thread first. Nothing was started.' } })
    await opened()
    await menu('Babysit pull request')
    expect(await screen.findByRole('alert')).toHaveTextContent('Link this pull request to the thread first. Nothing was started.')
  })

  it('keeps focus on a refused Stop and says why in its line, not above the checklist', async () => {
    const { command, onStatus } = mount({ babysit: { agent: 'Codex' }, thread: babysat('user'), result: { error: 'Sotto could not save that babysitting stopped. It goes on.' } })
    await opened()
    const line = screen.getByRole('group', { name: /^Babysitting since / })
    const stop = within(line).getByRole('button', { name: 'Stop babysitting #74' })
    stop.focus()
    fireEvent.click(stop)
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'stop-babysitting', threadId: 'thread-1', url: URL }]))
    expect(await within(line).findByRole('alert')).toHaveTextContent('Sotto could not save that babysitting stopped. It goes on.')
    // Said once, beside the Stop it answers; focus never left Stop, and it presses again once the host has answered.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    await waitFor(() => expect(stop).not.toHaveAttribute('aria-disabled'))
    expect(stop).toHaveFocus()
    expect(onStatus).not.toHaveBeenCalled()
  })

  it('holds Stop while a press is under way without taking focus from it', async () => {
    let answer!: (state: AgentState) => void
    const { command } = mount({ babysit: { agent: 'Codex' }, thread: babysat('user') })
    command.mockImplementation(() => new Promise(resolve => { answer = resolve }))
    await opened()
    const stop = screen.getByRole('button', { name: 'Stop babysitting #74' })
    stop.focus()
    fireEvent.click(stop)
    await waitFor(() => expect(stop).toHaveAttribute('aria-disabled', 'true'))
    expect(stop).toHaveTextContent('Stopping...')
    expect(stop).toHaveFocus()
    fireEvent.click(stop)
    expect(command).toHaveBeenCalledTimes(1)
    await act(async () => { answer({ notice: 'Stopped.', error: null } as AgentState) })
  })

  it('leaves focus where the user moved it while a slow Stop was under way', async () => {
    let answer!: (state: AgentState) => void
    const { command, onStatus } = mount({ babysit: { agent: 'Codex' }, thread: babysat('user') })
    command.mockImplementation(() => new Promise(resolve => { answer = resolve }))
    await opened()
    const stop = screen.getByRole('button', { name: 'Stop babysitting #74' })
    stop.focus()
    fireEvent.click(stop)
    await waitFor(() => expect(stop).toHaveAttribute('aria-disabled', 'true'))
    // The user goes on to the composer, outside the surface, before the host answers.
    const composer = document.createElement('textarea')
    composer.setAttribute('aria-label', 'Message')
    document.body.append(composer)
    try {
      composer.focus()
      await act(async () => { answer({ notice: 'Stopped babysitting PR #74.', error: null } as AgentState) })
      await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Stopped babysitting #74'))
      await act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(undefined))) })
      expect(composer).toHaveFocus()
    } finally { composer.remove() }
  })

  it('marks each linked pull request the thread babysits in Linked pull requests', async () => {
    const other = 'https://github.com/o/r/pull/76'
    mount({ babysit: { agent: 'Claude Code' }, thread: thread({
      pullRequests: [{ number: 76, url: other, title: 'Mention the greeting in the README', state: 'open', draft: false, source: 'linked', linkedAt: '2026-09-23T00:00:00.000Z' }],
      // Babysitting records the address as GitHub gave it; the mark matches it whatever its case.
      babysitting: [{ url: 'https://github.com/O/R/pull/76', number: 76, startedBy: 'agent', startedAt }],
    }) })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Linked pull requests 2' }))
    const list = screen.getByRole('list', { name: 'Linked pull requests' })
    expect(within(list).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'PR #74, Open: Make the greeting friendlier. This branch', 'PR #76, Open: Mention the greeting in the README. Linked by you. Babysitting'])
    const [branchRow, linkedRow] = within(list).getAllByRole('listitem')
    expect(linkedRow!.querySelector('.pr-surface__link-babysat')).toHaveTextContent(/^Babysitting$/u)
    expect(branchRow!.querySelector('.pr-surface__link-babysat')).toBeNull()
  })

  it('offers nothing where the host cannot babysit, still showing what the thread babysits', async () => {
    mount({ thread: babysat('user') })
    await opened()
    expect(screen.getByRole('group', { name: /^Babysitting since / })).toHaveTextContent('Started by you.')
    fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Babysit pull request' })).toBeNull()
  })

  it('keeps focus on the line when babysitting ends on its own while Stop has it', async () => {
    const view = mount({ babysit: { agent: 'Claude Code' }, thread: babysat('user') })
    await opened()
    const stop = within(screen.getByRole('group', { name: /^Babysitting since / })).getByRole('button', { name: 'Stop babysitting #74' })
    stop.focus()
    const ended = thread({ babysitEnded: [{ url: URL, number: 74, reason: 'comment-limit', endedAt: new Date().toISOString() }] })
    view.rerender(<PullRequestSurface thread={ended} command={view.command} onStatus={view.onStatus} babysit={{ agent: 'Claude Code' }} />)
    const line = await screen.findByRole('group', { name: 'Not babysitting' })
    expect(document.activeElement).not.toBe(document.body)
    expect(line.contains(document.activeElement)).toBe(true)
  })

  it('lets Stop end babysitting a pull request that merged before the next pass saw it', async () => {
    const { command } = mount({ babysit: { agent: 'Codex' }, thread: babysat('agent'), detail: detail({ state: 'merged', mergedAt: new Date().toISOString() }) })
    await opened()
    const line = screen.getByRole('group', { name: /^Babysitting since / })
    fireEvent.click(within(line).getByRole('button', { name: 'Stop babysitting #74' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'stop-babysitting', threadId: 'thread-1', url: URL }]))
  })

  it('says babysitting ended and why under a merged pull request, and offers nothing to start', async () => {
    const endedAt = new Date().toISOString()
    mount({ babysit: { agent: 'Claude Code' }, thread: thread({ babysitEnded: [{ url: URL, number: 74, reason: 'merged', endedAt }] }), detail: detail({ state: 'merged', mergedAt: endedAt }) })
    await opened()
    expect(screen.getByRole('group', { name: 'Babysitting ended' })).toHaveTextContent(/Ended at .+, after #74 merged\./u)
    fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Babysit pull request' })).toBeNull()
  })

  it('puts a read ending away with Dismiss, for good in this window, until a later ending replaces it', async () => {
    localStorage.removeItem(BABYSIT_ENDINGS_DISMISSED_KEY)
    const ending = (endedAt: string) => thread({ babysitEnded: [{ url: URL, number: 74, reason: 'comment-limit', endedAt }] })
    const first = new Date(Date.now() - 3_600_000).toISOString()
    const view = mount({ babysit: { agent: 'Claude Code' }, thread: ending(first) })
    await opened()
    const line = screen.getByRole('group', { name: 'Not babysitting' })
    expect(line).toHaveTextContent('Babysit pull request is under More pull request actions.')
    expect(line).not.toHaveTextContent('···')
    const dismiss = within(line).getByRole('button', { name: 'Dismiss why babysitting #74 ended' })
    dismiss.focus()
    fireEvent.click(dismiss)
    expect(screen.queryByRole('group', { name: 'Not babysitting' })).toBeNull()
    // Focus waits on ···, where Babysit pull request is; nothing was sent to the host.
    await waitFor(() => expect(screen.getByRole('button', { name: 'More pull request actions' })).toHaveFocus())
    expect(view.command).not.toHaveBeenCalled()
    // Opened again, the ending stays put away; a later ending of the same pull request is shown.
    view.unmount()
    mount({ babysit: { agent: 'Claude Code' }, thread: ending(first) })
    await opened()
    expect(screen.queryByRole('group', { name: 'Not babysitting' })).toBeNull()
    cleanup()
    mount({ babysit: { agent: 'Claude Code' }, thread: ending(new Date().toISOString()) })
    await opened()
    expect(screen.getByRole('group', { name: 'Not babysitting' })).toBeInTheDocument()
  })
})
