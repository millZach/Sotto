import { createHash } from 'node:crypto'
import { deferred } from '../../../fixtures/deferred'
import { threadsStateFixture } from '../../../fixtures/agentState'
import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PullRequestSurface } from '../../../../src/renderer/src/tools/PullRequestSurface'
import {
  canAutoMerge, checklist, checklistCount, checklistHeading, checkNameParts, type ChecklistLine, checksInOrder, checksOnGitHub, checksSummary, checkTime, checkWord, confirmationFor, descriptionPreview, fileOnGitHub, filesByFolder, footCut, filesByWeight, limitedWords, linesInOrder, listMatches, listReviewWord, mergedWhen, mergeEffect, mergeReady, mergeWaitsFor, pathParts, resolveMergeMethod,
} from '../../../../src/renderer/src/tools/pullRequestSurface.logic'
import type { AgentCommand, AgentState, AgentThread } from '../../../../src/shared/agents'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../src/shared/settings'
import { useOptionalApp, type AppContextValue } from '../../../../src/renderer/src/state/AppContext'
import { usePullRequestMergeMethod } from '../../../../src/renderer/src/tools/usePullRequestMergeMethod'
import { BABYSIT_ENDINGS_DISMISSED_KEY } from '../../../../src/renderer/src/tools/babysitEndingsDismissed'
import { gitPullRequestDetailSchema, type GitPullRequestCheck, type GitPullRequestDetail, type GitPullRequestListItem, type GitPullRequestRead, type GitPullRequestReview } from '../../../../src/shared/gitPullRequests'

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
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => threadsStateFixture({ cloneOverrides: false,
    host: { projects: [], threads: [], models: [] },
    topLevel: { activeThreadId: null, activeProjectId: null, notice: 'Pull request merged.', ...options.result } , ...options.result}))
  const onStatus = vi.fn()
  const view = render(<PullRequestSurface thread={options.thread ?? thread()} command={command} onStatus={onStatus} babysit={options.babysit} />)
  return { ...view, command, gitPullRequest, openExternalLink, writeText, onStatus }
}
const sent = (command: ReturnType<typeof mount>['command']) => command.mock.calls.map(call => call[0])
const lines = () => within(screen.getByRole('list', { name: 'Merge checklist' })).getAllByRole('listitem')
const lineOf = (words: RegExp) => lines().find(line => words.test(line.textContent ?? ''))!
/** Merge under either of its names: "Merge #74", or "Can't merge #74 yet" while something blocks it. */
const mergeButton = () => screen.getByRole('button', { name: /^(?:Can't merge|Merge) #74/u })
async function opened() { await screen.findByRole('heading', { name: '#74 Make the greeting friendlier' }) }
async function menu(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: label }))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.mocked(useOptionalApp).mockReset().mockReturnValue(null) })
/** Restarting stopped threads on (ADR-0144), which takes babysitting away. */
function restartStoppedOn(): void {
  vi.mocked(useOptionalApp).mockReturnValue({ settings: DEFAULT_SETTINGS, actions: { updateSettings: vi.fn(async () => true) },
    update: { owlFeatures: { 'restart-stopped-threads': true } } } as unknown as AppContextValue)
}

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
      ['Checks passed', 'done', 'CI / build passed', null],
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
      ['1 check running', 'running', 'Gates (macOS) is still running', null],
      ['Needs a review', 'todo', 'Reviewers wait until it is ready', null],
      ['Behind main', 'todo', '2 commits behind main', 'update-branch'],
      ['No conflicts', 'done', 'Merges cleanly into main', null],
      ['Still a draft', 'todo', 'Mark it ready for review when the work is done', 'ready'],
    ])
    const failing = checklist(detail({ reviewDecision: 'changes_requested', reviews: [review('mira', 'changes_requested')],
      checks: [check('Gates (Windows)', 'failure', 'https://github.com/o/r/actions/runs/9', '3 tests failed in tests/unit/main'), check('Notices', 'success')] }))
    expect(failing[0]).toMatchObject({ tone: 'failed', why: 'Gates (Windows) failed: 3 tests failed in tests/unit/main', fix: { kind: 'open-check', name: 'Gates (Windows)', url: 'https://github.com/o/r/actions/runs/9' } })
    expect(failing[1]).toMatchObject({ tone: 'failed', why: 'mira asked for changes', fix: { kind: 'open-review', author: 'mira', url: `${URL}#pullrequestreview-mira` } })
    expect(mergeReady(detail(), failing)).toBe(false)
    expect(mergeWaitsFor(failing)).toBe('You can merge once the failing check passes and someone approves it.')
    expect(checklistHeading(detail(), false)).toBe('Before merging')
    expect(read({ checks: [check('a', 'cancelled'), check('b', 'failure')] })[0]).toEqual(['2 checks failed', 'failed', 'a was cancelled, and 1 more', null])
    expect(read({ checks: [check('deploy', 'action-required', 'https://github.com/o/r/actions/runs/3')] })[0]).toEqual(['1 check needs approval', 'todo', 'deploy is waiting for approval on GitHub', 'open-check'])
    expect(read({ checks: [check('a', 'success'), check('b', 'skipped')] })[0]).toEqual(['Checks passed', 'done', '1 passed, 1 skipped', null])
    expect(read({ canUpdateBranch: false, behindBy: 1 })[2]).toEqual(['Behind main', 'todo', '1 commit behind main. GitHub does not let this account update it', null])
    // English writes a long way behind as it always has, without grouping its digits.
    expect(read({ behindBy: 1_000 })[2]).toEqual(['Behind main', 'todo', '1000 commits behind main', 'update-branch'])
    expect(read({ mergeable: 'conflicting' })[3]).toEqual(['Conflicts with main', 'failed', 'Resolve them in the branch and push', null])
    expect(read({ mergeable: 'unknown' })[3]).toEqual(['Checking for conflicts', 'running', 'GitHub is still checking. Refresh in a moment', null])
  })
  it('says what GitHub reports rather than an approval nobody gave: no checks, no review required, a base it could not compare', () => {
    const noted = checklist(detail({ checks: [], reviewDecision: null, reviews: [], behindBy: null }))
    expect(noted.map(line => [line.label, line.tone, line.why])).toEqual([
      ['No checks', 'done', 'GitHub reports none for this pull request'],
      ['No review required', 'done', 'This repository merges without one'],
      ['Not compared with main', 'unknown', 'GitHub could not compare it with main'],
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
    expect([refused[0]!.label, refused[0]!.tone, refused[0]!.why]).toEqual(['Checks could not be read', 'unknown', 'GitHub did not let Sotto read the checks'])
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
      .toMatchObject({ label: 'Changes requested', tone: 'open', why: 'sam and 1 more asked for changes. This repository does not require a review', fix: { author: 'sam' } })
  })
  // A line's label is what a reader takes in first, so it says how the line stands in every state the surface can show,
  // never the state it is waiting for: "Checks passing" over failed checks is what this holds against.
  describe('labels each line with how it stands', () => {
    const label = (change: Partial<GitPullRequestDetail>, id: ChecklistLine['id']): string => checklist(detail(change)).find(line => line.id === id)!.label
    const checks = (...statuses: GitPullRequestCheck['status'][]): Partial<GitPullRequestDetail> => ({ checks: statuses.map((status, index) => check(`c${index}`, status)) })
    it.each<[string, Partial<GitPullRequestDetail>, string]>([
      ['one failed', checks('failure', 'success'), '1 check failed'],
      ['two failed and one running', checks('failure', 'failure', 'pending', 'success'), '2 checks failed'],
      ['one failed and one cancelled, counted as the Checks fold counts them', checks('cancelled', 'failure'), '2 checks failed'],
      ['only cancelled', checks('cancelled', 'cancelled'), '2 checks cancelled'],
      ['waiting for approval', checks('action-required', 'success'), '1 check needs approval'],
      ['running', checks('pending', 'pending', 'success'), '2 checks running'],
      ['passing', checks('success', 'success'), 'Checks passed'],
      ['passing with some skipped', checks('success', 'skipped'), 'Checks passed'],
      ['all skipped', checks('skipped', 'neutral'), 'Checks skipped'],
      ['none', { checks: [] }, 'No checks'],
      ['none readable', { checks: [], checksUnknown: true }, 'Checks could not be read'],
      ['some unreadable', { ...checks('success'), checksUnknown: true }, 'Some checks could not be read'],
    ])('checks: %s', (_, change, expected) => {
      expect(label(change, 'checks')).toBe(expected)
      expect(label(change, 'checks')).not.toBe('Checks passing')
    })
    it.each<[string, Partial<GitPullRequestDetail>, string]>([
      ['approved', { reviewDecision: 'approved', reviews: [review('mira', 'approved')] }, 'Review approved'],
      ['changes requested', { reviewDecision: 'changes_requested', reviews: [review('mira', 'changes_requested')] }, 'Changes requested'],
      ['required, nobody has reviewed', { reviewDecision: 'review_required', reviews: [] }, 'Needs a review'],
      ['required, approved but not enough', { reviewDecision: 'review_required', reviews: [review('mira', 'approved')] }, 'Needs a review'],
      ['required, on a draft', { reviewDecision: 'review_required', reviews: [], draft: true }, 'Needs a review'],
      ['required, on a closed pull request', { reviewDecision: 'review_required', reviews: [], state: 'closed' }, 'Not approved'],
      ['not required, nobody has reviewed', { reviewDecision: null, reviews: [] }, 'No review required'],
      ['not required, approved', { reviewDecision: null, reviews: [review('mira', 'approved')] }, 'Review approved'],
      ['not required, changes requested', { reviewDecision: null, reviews: [review('ola', 'changes_requested')] }, 'Changes requested'],
    ])('review: %s', (_, change, expected) => expect(label(change, 'review')).toBe(expected))
    it('keeps a review nobody gave apart from one nobody needs', () => {
      expect(label({ reviewDecision: 'review_required', reviews: [] }, 'review')).not.toBe(label({ reviewDecision: null, reviews: [] }, 'review'))
    })
    it.each<[string, Partial<GitPullRequestDetail>, ChecklistLine['id'], string]>([
      ['up to date', { behindBy: 0 }, 'up-to-date', 'Up to date with main'],
      ['behind', { behindBy: 3 }, 'up-to-date', 'Behind main'],
      ['behind, closed', { behindBy: 3, state: 'closed' }, 'up-to-date', 'Behind main'],
      ['not compared', { behindBy: null }, 'up-to-date', 'Not compared with main'],
      ['merged', { state: 'merged', behindBy: 3 }, 'up-to-date', 'Up to date with main'],
      ['conflicts', { mergeable: 'conflicting' }, 'conflicts', 'Conflicts with main'],
      ['no conflicts', { mergeable: 'mergeable' }, 'conflicts', 'No conflicts'],
      ['still checking', { mergeable: 'unknown' }, 'conflicts', 'Checking for conflicts'],
      ['not checked, closed', { mergeable: 'unknown', state: 'closed' }, 'conflicts', 'Conflicts not checked'],
      ['merged, conflicts unknown', { mergeable: 'unknown', state: 'merged' }, 'conflicts', 'No conflicts'],
      ['ready', { draft: false }, 'ready', 'Ready for review'],
      ['draft', { draft: true }, 'ready', 'Still a draft'],
      ['draft, closed', { draft: true, state: 'closed' }, 'ready', 'Still a draft'],
    ])('%s', (_, change, id, expected) => expect(label(change, id)).toBe(expected))
    it('keeps every label true with auto-merge armed, and on a merged pull request', () => {
      const armed = checklist(detail({ autoMerge: { method: 'squash' }, ...checks('pending', 'success'), reviewDecision: 'review_required', reviews: [] }))
      expect(armed.map(line => line.label)).toEqual(['1 check running', 'Needs a review', 'Up to date with main', 'No conflicts', 'Ready for review'])
      const merged = checklist(detail({ state: 'merged', ...checks('success', 'success') }))
      expect(merged.map(line => line.label)).toEqual(['Checks passed', 'Review approved', 'Up to date with main', 'No conflicts', 'Ready for review'])
    })
    it('names the draft line\'s press for what it does, not for the line', async () => {
      mount({ detail: detail({ draft: true }) })
      await opened()
      const line = screen.getByText('Still a draft').closest('li')!
      expect(within(line).getByRole('button', { name: 'Ready for review' })).toBeInTheDocument()
    })
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
      'Done: CI / build passed', 'Done: Approved by mira', 'Done: Up to date with main. Has every commit on main',
      'Done: No conflicts. Merges cleanly into main', 'Done: Not a draft'])
    expect(mergeButton()).not.toHaveAttribute('aria-disabled')
    expect(screen.getByText('Every commit, plus a merge commit.')).toBeInTheDocument()
    // The description folds below, closed until asked for.
    expect(screen.queryByText(/One change/u)).toBeNull()
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
    expect(mergeButton()).toHaveAccessibleName('Can\'t merge #74 yet')
    expect(mergeButton()).toHaveAccessibleDescription('You can merge once the failing check passes and someone approves it. Merge when ready')
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
  it('leads with what blocks the merge, and gives the lines that are done one quiet row', async () => {
    mount({ detail: detail({ draft: true, behindBy: 2, mergeable: 'conflicting', reviewDecision: 'approved', reviews: [review('mira', 'approved')], checks: [check('build', 'pending')] }) })
    await opened()
    const words = lines().map(line => line.textContent)
    expect(words[0]).toMatch(/^Failing: Conflicts with main/u)
    expect(words.slice(1, 3).map(line => line?.split(':')[0])).toEqual(['To do', 'To do'])
    expect(words[3]).toMatch(/^Waiting: 1 check running/u)
    expect(words[4]).toBe('Done: Approved by mira')
    expect(mergeButton()).toHaveAccessibleName('Can\'t merge #74 yet')
    expect(screen.getByText(/^You can merge once its conflicts with main are resolved, it is up to date with main, it is marked ready for review, and the running check finishes\./u)).toBeInTheDocument()
  })
  it('keeps Merge as it is while a read holds a ready pull request, so a Refresh does not flash it blocked', async () => {
    let answer: ((read: GitPullRequestRead) => void) | undefined
    let reads = 0
    mount({ detail: (() => { reads++; return reads === 1 ? detail() : new Promise<GitPullRequestRead>(resolve => { answer = resolve }) }) as never })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pull request' }))
    await waitFor(() => expect(mergeButton()).toHaveAttribute('aria-disabled', 'true'))
    expect(mergeButton()).toHaveAccessibleName('Merge #74')
    expect(mergeButton()).not.toHaveAttribute('data-blocked')
    answer!(detail())
    await waitFor(() => expect(mergeButton()).not.toHaveAttribute('aria-disabled'))
  })
  it('leaves Merge when ready out where the repository does not allow auto-merge', async () => {
    mount({ detail: detail({ autoMergeAllowed: false, checks: [check('build', 'pending')] }) })
    await opened()
    expect(screen.getByText('You can merge once the running check finishes.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Merge when ready' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Merge when ready (auto-merge)' })).toBeNull()
  })
  it('fixes a line with its own press: Update branch and Ready for review, neither asking first', async () => {
    const { command } = mount({ detail: detail({ draft: true, behindBy: 2 }) })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Update branch' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'git-pull-request-action', threadId: 'thread-1', url: URL, action: 'update-branch' }]))
    await waitFor(() => expect(within(lineOf(/Ready for review|Not a draft/u)).getByRole('button', { name: 'Ready for review' })).toBeEnabled())
    fireEvent.click(within(lineOf(/Ready for review|Not a draft/u)).getByRole('button', { name: 'Ready for review' }))
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
    // An ended pull request says so before its checklist.
    expect(merged.container.querySelector('.pr-surface__finished')!.compareDocumentPosition(lines()[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
    fireEvent.click(within(lineOf(/Ready for review|Not a draft/u)).getByRole('button', { name: 'Ready for review' }))
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
    // The top line names the pull request by its number, the thread's own too, since a narrow header can drop it.
    const strip = (): HTMLElement => document.querySelector<HTMLElement>('.pr-surface__top .pr-surface__lead')!
    expect(strip()).toHaveTextContent(/^#74\s*Open$/u)
    const fold = screen.getByRole('button', { name: 'Linked pull requests 2' })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(fold)
    const list = screen.getByRole('list', { name: 'Linked pull requests' })
    expect(within(list).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'PR #74, Open: Make the greeting friendlier. Created from this thread', 'PR #70, Merged: Older work. Linked by you'])
    fireEvent.click(within(list).getByRole('button', { name: /^PR #70/u }))
    expect(await screen.findByRole('heading', { name: '#70 Older work' })).toBeInTheDocument()
    // So does another one.
    expect(strip()).toHaveTextContent(/^#70\s*Merged$/u)
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
    command.mockImplementation(async () => { ready = true; return threadsStateFixture({ cloneOverrides: false,
    host: { projects: [], threads: [], models: [] },
    topLevel: { activeThreadId: null, activeProjectId: null, notice: 'Marked ready for review.' } }) })
    await opened()
    const press = within(lineOf(/Ready for review|Not a draft/u)).getByRole('button', { name: 'Ready for review' })
    press.focus()
    fireEvent.click(press)
    await waitFor(() => expect(within(lineOf(/Ready for review|Not a draft/u)).queryByRole('button')).toBeNull())
    await waitFor(() => expect(screen.getByRole('heading', { name: '#74 Make the greeting friendlier' })).toHaveFocus())
  })
  it('keeps every press off until GitHub has been read again after one, so nothing is pressed twice over the old reading', async () => {
    let answer: ((value: GitPullRequestDetail) => void) | null = null
    let reads = 0
    const { command } = mount({ detail: (() => { reads += 1; return reads === 1 ? detail({ behindBy: 2 }) : (() => { const pending = deferred<GitPullRequestDetail>(); answer = pending.resolve; return pending.promise })() }) as never })
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
  it('names the reading it shows when it presses, never one a Refresh overtook, so a paired host binds the merge to it (#1691)', async () => {
    const [opening, stale, shown] = ['1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d', '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e', '3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f']
    const pending: Array<(value: GitPullRequestDetail) => void> = []
    let reads = 0
    const { command } = mount({ detail: (() => { reads += 1; if (reads === 1) return detail({ readId: opening })
      const read = deferred<GitPullRequestDetail>(); pending.push(read.resolve); return read.promise }) as unknown as () => GitPullRequestRead })
    await opened()
    // Two Refreshes in flight; the second is answered first, and the first, answered after it, is thrown away.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pull request' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh pull request' }))
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => { pending[1]!(detail({ readId: shown })) })
    await act(async () => { pending[0]!(detail({ readId: stale })) })
    await waitFor(() => expect(mergeButton()).not.toHaveAttribute('aria-disabled'))
    fireEvent.click(mergeButton())
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Merge pull request?' })).getByRole('button', { name: 'Merge' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'git-pull-request-action', threadId: 'thread-1', url: URL, action: 'merge', method: 'merge', readId: shown }]))
  })
  it('reads an open request for changes with nobody approving without claiming an approval', async () => {
    mount({ detail: detail({ reviewDecision: null, reviews: [review('ola', 'changes_requested')] }) })
    await opened()
    expect(lineOf(/^Does not block/u)).toHaveTextContent('Does not block: Changes requestedola asked for changes. This repository does not require a review')
    expect(lineOf(/^Does not block/u)).not.toHaveTextContent(/approved/iu)
    expect(within(lineOf(/^Does not block/u)!).getByRole('button', { name: "Open ola's review on GitHub" })).toBeInTheDocument()
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
    command.mockImplementation(() => { const pending = deferred<AgentState>(); answer = pending.resolve; return pending.promise })
    await opened()
    const stop = screen.getByRole('button', { name: 'Stop babysitting #74' })
    stop.focus()
    fireEvent.click(stop)
    await waitFor(() => expect(stop).toHaveAttribute('aria-disabled', 'true'))
    expect(stop).toHaveTextContent('Stopping...')
    expect(stop).toHaveFocus()
    fireEvent.click(stop)
    expect(command).toHaveBeenCalledTimes(1)
    await act(async () => { answer(threadsStateFixture({ cloneOverrides: false,
    host: { projects: [], threads: [], models: [] },
    topLevel: { activeThreadId: null, activeProjectId: null, notice: 'Stopped.' } })) })
  })

  it('leaves focus where the user moved it while a slow Stop was under way', async () => {
    let answer!: (state: AgentState) => void
    const { command, onStatus } = mount({ babysit: { agent: 'Codex' }, thread: babysat('user') })
    command.mockImplementation(() => { const pending = deferred<AgentState>(); answer = pending.resolve; return pending.promise })
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
      await act(async () => { answer(threadsStateFixture({ cloneOverrides: false,
    host: { projects: [], threads: [], models: [] },
    topLevel: { activeThreadId: null, activeProjectId: null, notice: 'Stopped babysitting PR #74.' } })) })
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

  it('shows no babysitting at all while restarting stopped threads is on (ADR-0144; Owl only)', async () => {
    restartStoppedOn()
    const other = 'https://github.com/o/r/pull/76'
    mount({ babysit: { agent: 'Claude Code' }, thread: thread({
      pullRequests: [{ number: 76, url: other, title: 'Mention the greeting in the README', state: 'open', draft: false, source: 'linked', linkedAt: '2026-09-23T00:00:00.000Z' }],
      babysitting: [{ url: URL, number: 74, startedBy: 'agent', startedAt }, { url: other, number: 76, startedBy: 'agent', startedAt }],
    }) })
    await opened()
    expect(screen.queryByRole('group', { name: /babysitting/iu })).toBeNull()
    expect(document.querySelector('.pr-surface__babysit')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Babysit pull request' })).toBeNull()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Linked pull requests 2' }))
    expect(document.querySelector('.pr-surface__link-babysat')).toBeNull()
    expect(screen.getByRole('list', { name: 'Linked pull requests' })).not.toHaveTextContent('Babysitting')
  })

  it('shows no ending of babysitting while restarting stopped threads is on', async () => {
    restartStoppedOn()
    mount({ babysit: { agent: 'Claude Code' }, thread: thread({ babysitEnded: [{ url: URL, number: 74, reason: 'comment-limit', endedAt: new Date().toISOString() }] }) })
    await opened()
    expect(screen.queryByRole('group', { name: 'Not babysitting' })).toBeNull()
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

describe('the drill-in under the merge checklist', () => {
  const FAILED = 'https://github.com/o/r/actions/runs/2'
  const timed = (name: string, status: GitPullRequestCheck['status'], url: string | null, minutes: number | null): GitPullRequestCheck => ({ name, status, url, description: null,
    startedAt: minutes === null ? null : '2026-09-23T10:00:00.000Z', completedAt: minutes === null || status === 'pending' ? null : new Date(Date.parse('2026-09-23T10:00:00.000Z') + minutes * 60_000).toISOString() })
  it('folds every check below Merge, closed even when one failed, and the checklist stays as it was', async () => {
    const { openExternalLink, command } = mount({ detail: detail({ checks: [timed('CI / build', 'success', 'https://github.com/o/r/actions/runs/1', 4), timed('CI / lint', 'failure', FAILED, 2), timed('CI / e2e', 'pending', null, null)] }) })
    await opened()
    expect(screen.queryByRole('list', { name: 'Checks' })).toBeNull()
    expect(within(lines()[0]!).getByRole('button', { name: 'Open CI / lint on GitHub' })).toBeInTheDocument()
    expect(mergeButton()).toHaveAttribute('aria-disabled', 'true')
    const fold = screen.getByRole('button', { name: 'Checks 1 failed 1 running 1 passed' })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(fold)
    const list = screen.getByRole('list', { name: 'Checks' })
    // What failed first, what passed folded; a check with nowhere to open has no press.
    expect(within(list).getAllByRole('listitem').map(row => row.textContent)).toEqual(['CI / lintFailed2m 0s', 'CI / e2eQueued'])
    expect(within(list).getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 passed' }))
    expect(within(list).getByText('build')).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('button', { name: 'Open CI / lint on GitHub. Failed, 2m 0s' }))
    expect(openExternalLink).toHaveBeenCalledWith(FAILED)
    fireEvent.click(screen.getByRole('button', { name: 'Open all checks on GitHub' }))
    expect(openExternalLink).toHaveBeenCalledWith('https://github.com/o/r/pull/74/checks')
    expect(command).not.toHaveBeenCalled()
  })
  it('has no Checks fold where GitHub reports none', async () => {
    mount({ detail: detail({ checks: [] }) })
    await opened()
    expect(screen.queryByRole('button', { name: /^Checks/u })).toBeNull()
  })
  it('lists the changed files, the most changed first, each opening on GitHub', async () => {
    const onReview = vi.fn()
    const openExternalLink = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('sotto', { agents: { gitPullRequest: vi.fn(async () => detail({ additions: 12, deletions: 3, changedFiles: 2, files: [{ path: 'src/a.ts', additions: 1, deletions: 1 }, { path: 'src/deep/b.ts', additions: 11, deletions: 2 }] })) }, openExternalLink })
    render(<PullRequestSurface thread={thread()} command={vi.fn()} onStatus={vi.fn()} onReviewChanges={onReview} />)
    await opened()
    const fold = screen.getByRole('button', { name: /^Changed files 2/u })
    expect(fold).toHaveTextContent('+12')
    // The totals are GitHub's, whitespace changes counted, and say so where Changes says its own leave those out.
    expect(fold.querySelector('.pr-surface__counts')).toHaveAttribute('title', '12 lines added, 3 removed, counting whitespace changes, as GitHub does.')
    fireEvent.click(fold)
    const list = screen.getByRole('list', { name: 'Changed files' })
    expect(within(list).getAllByRole('button').map(row => row.getAttribute('aria-label'))).toEqual(['Open src/deep/b.ts on GitHub. 11 added, 2 removed', 'Open src/a.ts on GitHub. 1 added, 1 removed'])
    fireEvent.click(within(list).getAllByRole('button')[0]!)
    await waitFor(() => expect(openExternalLink).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/github\.com\/o\/r\/pull\/74\/files#diff-[0-9a-f]{64}$/u)))
    fireEvent.click(screen.getByRole('button', { name: 'Review in Changes' }))
    // Against the branch the pull request merges into.
    expect(onReview).toHaveBeenCalledExactlyOnceWith('main')
  })
  it('lists the changed files under their folders, the folder that changed most first, each folder with its lines', async () => {
    mount({ detail: detail({ changedFiles: 4, files: [{ path: 'README.md', additions: 1, deletions: 0 }, { path: 'src/a.ts', additions: 2, deletions: 1 }, { path: 'tests/a.test.ts', additions: 30, deletions: 0 }, { path: 'src/b.ts', additions: 5, deletions: 0 }] }) })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: /^Changed files 4/u }))
    const list = screen.getByRole('list', { name: 'Changed files' })
    // The files at the top first, under no folder; then each folder by how much it changed, its files the most changed first.
    const sides = (element: Element): string => [...element.querySelectorAll('[data-side]')].map(side => side.textContent).join(' ').trim()
    expect([...list.querySelectorAll('.pr-surface__files-folder')].map(folder => `${folder.querySelector('bdi')?.textContent} ${sides(folder)}`)).toEqual(['tests/ +30', 'src/ +7 −1'])
    expect(within(screen.getByRole('list', { name: 'src/' })).getAllByRole('button').map(row => `${row.querySelector('bdi')?.textContent} ${sides(row)}`)).toEqual(['b.ts +5', 'a.ts +2 −1'])
    expect(within(list).getAllByRole('button').map(row => row.getAttribute('title'))).toEqual(['README.md', 'tests/a.test.ts', 'src/b.ts', 'src/a.ts'])
  })
  it('says how many it does not list, and hides the fold from a host that did not read the files', async () => {
    mount({ detail: detail({ changedFiles: 240, files: [{ path: 'a.ts', additions: 1, deletions: 0 }] }) })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: /^Changed files 240/u }))
    expect(screen.getByText('Showing the 1 first of 240 files.')).toBeInTheDocument()
    cleanup()
    mount()
    await opened()
    expect(screen.queryByRole('button', { name: /^Changed files/u })).toBeNull()
  })
  const listed = (number: number, title: string, change: Partial<GitPullRequestListItem> = {}): GitPullRequestListItem => ({ number, title, url: `https://github.com/o/r/pull/${number}`, draft: false, author: 'mira', headBranch: `feat/${number}`, updatedAt: '2026-09-23T10:00:00.000Z', additions: 5, deletions: 1, changedFiles: 2, checks: 'passed', reviewDecision: null, ...change })
  it('reads the repository\'s open pull requests only when its fold opens, and searches them here', async () => {
    const { gitPullRequest } = mount()
    const gitPullRequestList = vi.fn(async () => ({ repository: 'o/r', total: 3, pullRequests: [listed(74, 'Make the greeting friendlier', { reviewDecision: 'changes_requested' }), listed(80, 'Fix the socket flake', { checks: 'failing', author: 'drake' }), listed(81, 'Draft the plan', { draft: true, checks: 'none' })] }))
    vi.stubGlobal('sotto', { agents: { gitPullRequest, gitPullRequestList }, openExternalLink: vi.fn() })
    await opened()
    expect(gitPullRequestList).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open pull requests' }))
    const list = await screen.findByRole('list', { name: 'Open pull requests' })
    expect(gitPullRequestList).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread-1' })
    expect(within(list).getAllByRole('button')).toHaveLength(3)
    expect(within(list).getByRole('button', { name: /^Show #74:/u })).toHaveAttribute('aria-current', 'true')
    expect(within(list).getByRole('button', { name: /^Show #80: Fix the socket flake\. A check failed\./u })).toBeInTheDocument()
    // Each row says how it stands in words beside each mark, so a passed check's tick is never read as an approval.
    expect([...list.querySelectorAll('.pr-surface__open-state')].map(state => state.textContent)).toEqual(['Checks passedChanges requested', 'A check failed', 'No checksDraft'])
    fireEvent.change(screen.getByRole('searchbox', { name: /^Search open pull requests/u }), { target: { value: 'drake' } })
    expect(within(list).getAllByRole('button')).toHaveLength(1)
    fireEvent.change(screen.getByRole('searchbox', { name: /^Search open pull requests/u }), { target: { value: 'nothing like it' } })
    expect(screen.getByText('No open pull request matches that search.')).toBeInTheDocument()
    expect(gitPullRequestList).toHaveBeenCalledOnce()
  })
  it('folds an open fold on an Escape nothing inside it answered, back to its heading, after the search field clears first', async () => {
    const { gitPullRequest } = mount()
    const gitPullRequestList = vi.fn(async () => ({ repository: 'o/r', total: 1, pullRequests: [listed(74, 'Make the greeting friendlier')] }))
    vi.stubGlobal('sotto', { agents: { gitPullRequest, gitPullRequestList }, openExternalLink: vi.fn() })
    await opened()
    const heading = screen.getByRole('button', { name: 'Open pull requests' })
    fireEvent.click(heading)
    await screen.findByRole('list', { name: 'Open pull requests' })
    const search = screen.getByRole('searchbox', { name: /^Search open pull requests/u })
    fireEvent.change(search, { target: { value: 'greeting' } })
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveValue('')
    expect(heading).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(heading).toHaveAttribute('aria-expanded', 'false')
    expect(heading).toHaveFocus()
    expect(screen.queryByRole('list', { name: 'Open pull requests' })).toBeNull()
    // This pull request's own folds answer Escape the same way.
    const description = screen.getByRole('button', { name: /^Description/u })
    if (description.getAttribute('aria-expanded') !== 'true') fireEvent.click(description)
    expect(description).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(document.getElementById(description.getAttribute('aria-controls')!)!, { key: 'Escape' })
    expect(description).toHaveAttribute('aria-expanded', 'false')
    expect(description).toHaveFocus()
  })
  it('says so when GitHub holds the list back or the project has no remote, and keeps the rows it has', async () => {
    const { gitPullRequest } = mount()
    const gitPullRequestList = vi.fn<() => Promise<unknown>>(async () => ({ repository: 'o/r', total: 1, pullRequests: [listed(74, 'Make the greeting friendlier')] }))
    vi.stubGlobal('sotto', { agents: { gitPullRequest, gitPullRequestList }, openExternalLink: vi.fn() })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: /^Open pull requests/u }))
    await screen.findByRole('list', { name: 'Open pull requests' })
    gitPullRequestList.mockResolvedValueOnce({ limited: { retryAt: '2099-01-01T00:00:00.000Z' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh open pull requests' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/GitHub is limiting requests/u)
    expect(screen.getByRole('list', { name: 'Open pull requests' })).toBeInTheDocument()
    gitPullRequestList.mockResolvedValueOnce(null)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh open pull requests' }))
    expect(await screen.findByText(/has no GitHub remote/u)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Open pull requests' })).toBeNull()
  })
  it('reads one the thread does not know with nothing to press but linking it, and goes back to its own', async () => {
    const other = 'https://github.com/o/r/pull/80'
    const { gitPullRequest, command } = mount({ detail: request => request.reference === other
      ? detail({ number: 80, url: other, title: 'Fix the socket flake', branch: false, linked: null, behindBy: 2 }) : detail() })
    const gitPullRequestList = vi.fn(async () => ({ repository: 'o/r', total: 1, pullRequests: [listed(80, 'Fix the socket flake')] }))
    vi.stubGlobal('sotto', { agents: { gitPullRequest, gitPullRequestList }, openExternalLink: vi.fn() })
    await opened()
    fireEvent.click(screen.getByRole('button', { name: /^Open pull requests/u }))
    fireEvent.click(await screen.findByRole('button', { name: /^Show #80:/u }))
    await screen.findByRole('heading', { name: '#80 Fix the socket flake' })
    expect(screen.queryByRole('button', { name: 'Merge #80' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Update branch' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More pull request actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Close pull request' })).toBeNull()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Link to this thread' }))
    await waitFor(() => expect(sent(command)).toEqual([{ type: 'git-link-pull-request', threadId: 'thread-1', reference: other }]))
    fireEvent.click(screen.getByRole('button', { name: 'Back to #74' }))
    await opened()
    expect(mergeButton()).toBeInTheDocument()
  })
  it('says what a closed fold holds on its head, and leaves the head\'s name as what a press opens', async () => {
    mount({ detail: detail({ body: '## What changed\n\n- Says **hello** to whoever `reviews` this.', checks: [check('a', 'success'), check('b', 'skipped')] }) })
    await opened()
    const description = screen.getByRole('button', { name: 'Description' })
    expect(description).toHaveTextContent('Says hello to whoever reviews this.')
    fireEvent.click(description)
    expect(description.querySelector('.pr-surface__fold-preview')).toBeNull()
    expect(screen.getByRole('button', { name: 'Checks 1 passed 1 skipped' })).toHaveAttribute('aria-expanded', 'false')
  })
  it('shows the first of what the closed folds hold under their heads, most needed first, only while the body has room for it', async () => {
    // A body as tall as `room`, holding 400 pixels, 60 more for each peek and 10 for each file a peek lists, so a count of peeks either fits or scrolls.
    let room = 0
    const holds = (body: HTMLElement): number => 400 + 60 * body.querySelectorAll('.pr-surface__peek, .pr-surface__fold-preview[data-whole]').length
      + 10 * body.querySelectorAll('.pr-surface__peek[data-of="files"] .pr-surface__peek-row:not([data-more])').length
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('pr-surface__body') ? room : 0 })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('pr-surface__body') ? holds(this) : 0 })
    const files = [{ path: 'src/a.ts', additions: 1, deletions: 1 }, { path: 'src/deep/b.ts', additions: 11, deletions: 2 }, { path: 'c.ts', additions: 3, deletions: 0 }, { path: 'd.ts', additions: 1, deletions: 0 }]
    const read = detail({ body: 'The greeting now says hello. It used to say nothing at all.\nIt waits for a name.\n\n- And a list.', files, changedFiles: 4,
      checks: [check('CI / build', 'failure'), check('CI / lint', 'pending'), check('test', 'success')] })
    const peeks = (): string[] => [...document.querySelectorAll('.pr-surface__peek')].map(peek => peek.textContent ?? '')
    const description = (): string => screen.getByRole('button', { name: 'Description' }).querySelector('.pr-surface__fold-preview')?.textContent ?? ''
    // Not laid out: no room, so the heads say only what they always did.
    const first = mount({ detail: read })
    await opened()
    expect(peeks()).toEqual([])
    expect(description()).toBe('The greeting now says hello.')
    first.unmount()
    // Room for two: the checks that still stand, then the description's whole first paragraph; the files wait.
    room = 530
    mount({ detail: read })
    await opened()
    expect(peeks()).toHaveLength(1)
    expect(peeks()[0]).toContain('CI /buildFailed')
    expect(peeks()[0]).toContain('CI /lintQueued')
    expect(peeks()[0]).not.toContain('test')
    expect(description()).toBe('The greeting now says hello. It used to say nothing at all. It waits for a name.')
    // The heads' names stay what a press opens, and a peek is only for the eye.
    expect(screen.getByRole('button', { name: 'Checks 1 failed 1 running 1 passed' })).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelector('.pr-surface__peek')).toHaveAttribute('aria-hidden', 'true')
    // An open fold holds the count, so the heads above it do not move; its own peek gives way to what it holds.
    fireEvent.click(screen.getByRole('button', { name: /^Checks/u }))
    expect(peeks()).toEqual([])
    expect(description()).toBe('The greeting now says hello. It used to say nothing at all. It waits for a name.')
    fireEvent.click(screen.getByRole('button', { name: /^Checks/u }))
    cleanup()
    // Room for three: the three most changed files too, the most changed first.
    room = 610
    mount({ detail: read })
    await opened()
    expect(peeks()).toHaveLength(2)
    expect(peeks()[1]).toMatch(/^src\/deep\/b\.ts.*c\.ts.*src\/a\.ts/u)
    expect(peeks()[1]).not.toContain('d.ts')
    // Its last line says how many more the fold holds, so three never read as the whole list.
    expect(peeks()[1]).toMatch(/1 more file$/u)
    cleanup()
    // Room to spare after every peek: more of the files, and with every file shown, no line says more.
    room = 1000
    mount({ detail: read })
    await opened()
    expect(peeks()[1]).toContain('d.ts')
    expect(peeks()[1]).not.toContain('more')
    cleanup()
    // GitHub's count wins over the files it listed: four listed of thirty, so the line counts the twenty-six not shown.
    mount({ detail: { ...read, changedFiles: 30 } })
    await opened()
    expect(peeks()[1]).toMatch(/26 more files$/u)
  })
  it('previews the linked pull requests under their closed fold only while the body has room, and never the open ones', async () => {
    // As above: 400 pixels and 60 more for each peek.
    let room = 0
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('pr-surface__body') ? room : 0 })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('pr-surface__body') ? 400 + 60 * this.querySelectorAll('.pr-surface__peek').length : 0 })
    const linkedThread = thread({ pullRequests: [{ number: 76, url: 'https://github.com/o/r/pull/76', title: 'Mention the greeting in the README', state: 'merged', draft: false, source: 'linked', linkedAt: '2026-09-23T00:00:00.000Z' }] })
    const read = detail({ files: [{ path: 'src/a.ts', additions: 1, deletions: 1 }], changedFiles: 1 })
    const linkedPeek = (): Element | null => document.querySelector('.pr-surface__peek[data-of="links"]')
    // Room for the files' peek alone: Linked says its count and nothing more.
    room = 470
    mount({ detail: read, thread: linkedThread })
    await opened()
    expect(document.querySelector('.pr-surface__peek[data-of="files"]')).not.toBeNull()
    expect(linkedPeek()).toBeNull()
    cleanup()
    // Room for both: each linked pull request's number, title and state, for the eye only, leaving out #74, which the
    // surface already shows as its heading (Zach's choice of November 7, 2026).
    room = 1000
    mount({ detail: read, thread: linkedThread })
    await opened()
    expect([...linkedPeek()!.querySelectorAll('.pr-surface__peek-row')].map(row => row.textContent)).toEqual(['#76Mention the greeting in the READMEMerged'])
    expect(linkedPeek()).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('button', { name: 'Linked pull requests 2' })).toHaveAttribute('aria-expanded', 'false')
    // Open pull requests is read only on a press, so its closed fold previews nothing.
    expect(screen.getByRole('button', { name: 'Open pull requests' }).querySelector('.pr-surface__peek')).toBeNull()
    // Opened, the fold's list takes the peek's place, the shown one included.
    fireEvent.click(screen.getByRole('button', { name: 'Linked pull requests 2' }))
    expect(linkedPeek()).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Linked pull requests' })).getAllByRole('button')).toHaveLength(2)
    cleanup()
    // With only the shown pull request linked, the closed head says its count alone, however much room there is.
    mount({ detail: read })
    await opened()
    expect(screen.getByRole('button', { name: 'Linked pull requests 1' })).toHaveAttribute('aria-expanded', 'false')
    expect(linkedPeek()).toBeNull()
  })
  it('holds the peeks through a resize while a fold is open, and fits them again once every fold is closed', async () => {
    // As above: 400 pixels, 60 more for each peek and 10 for each file a peek lists.
    let room = 1000
    const holds = (body: HTMLElement): number => 400 + 60 * body.querySelectorAll('.pr-surface__peek, .pr-surface__fold-preview[data-whole]').length
      + 10 * body.querySelectorAll('.pr-surface__peek[data-of="files"] .pr-surface__peek-row:not([data-more])').length
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('pr-surface__body') ? room : 0 })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('pr-surface__body') ? holds(this) : 0 })
    const resized: (() => void)[] = []
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized.push(callback) } observe(): void {} disconnect(): void {} })
    const files = [{ path: 'src/a.ts', additions: 1, deletions: 1 }, { path: 'src/deep/b.ts', additions: 11, deletions: 2 }, { path: 'c.ts', additions: 3, deletions: 0 }, { path: 'd.ts', additions: 1, deletions: 0 }]
    mount({ detail: detail({ body: 'The greeting now says hello. It used to say nothing at all.\nIt waits for a name.\n\n- And a list.', files, changedFiles: 4,
      checks: [check('CI / build', 'failure'), check('CI / lint', 'pending'), check('test', 'success')] }) })
    await opened()
    const filesPeek = (): string => document.querySelector('.pr-surface__peek[data-of="files"]')?.textContent ?? ''
    expect(filesPeek()).toContain('d.ts')
    fireEvent.click(screen.getByRole('button', { name: /^Checks/u }))
    // Shrunk with Checks open: the counts hold (ADR-0027, November 5), so the heads above the open fold do not move.
    room = 530
    act(() => { for (const callback of resized) callback() })
    expect(filesPeek()).toContain('d.ts')
    // Closed again, the peeks fit the smaller window: the files' peek goes.
    fireEvent.click(screen.getByRole('button', { name: /^Checks/u }))
    act(() => { for (const callback of resized) callback() })
    expect(filesPeek()).toBe('')
    // Grown with every fold closed, it comes back.
    room = 1000
    act(() => { for (const callback of resized) callback() })
    expect(filesPeek()).toContain('d.ts')
  })
  it('works out what the closed folds and the open list say', () => {
    expect(checksSummary([check('a', 'failure'), check('b', 'cancelled'), check('c', 'pending'), check('d', 'action-required'), check('e', 'success'), check('f', 'neutral')])).toEqual([
      { tone: 'failed', words: '2 failed' }, { tone: 'waiting', words: '1 need approval' }, { tone: 'waiting', words: '1 running' }, { tone: 'settled', words: '1 passed' }, { tone: 'settled', words: '1 skipped' }])
    expect(descriptionPreview('')).toBe('')
    expect(descriptionPreview('<!-- a template\nits second line -->\n# Title\n---\n![shot](a.png)\n1. [The link](https://x.test) and __more__')).toBe('The link and more')
    expect(descriptionPreview('```sh\nnpm test\n```\n> - [x] Quoted')).toBe('Quoted')
    // A whole first sentence, so a narrow panel ends the preview on the pull request's own stop rather than cutting it.
    expect(descriptionPreview('The thread store now writes on a worker thread. Main reads it and hands the worker every write.')).toBe('The thread store now writes on a worker thread.')
    expect(descriptionPreview('Fix v2. The store keeps its order. Then it stops.')).toBe('Fix v2. The store keeps its order.')
    expect(descriptionPreview('Reads the file at src/main/index.ts on start and writes nothing')).toBe('Reads the file at src/main/index.ts on start and writes nothing')
    // Its whole first paragraph, for a panel with room: up to a blank line, a heading, a fence or the list's next item.
    expect(descriptionPreview('## What\n\nThe store writes on a worker now. Main reads it\nin order.\n\nA second paragraph.', true)).toBe('The store writes on a worker now. Main reads it in order.')
    expect(descriptionPreview('- [x] The first item, which **says** it all.\n- The second item.', true)).toBe('The first item, which says it all.')
    expect(descriptionPreview('Before the fence it ends here.\n```\ncode\n```', true)).toBe('Before the fence it ends here.')
    expect(listReviewWord('approved')).toBe('Approved')
    expect(listReviewWord('changes_requested')).toBe('Changes requested')
    expect(listReviewWord('review_required')).toBeNull()
    expect(listReviewWord(null)).toBeNull()
    const lines = checklist(detail({ behindBy: null, draft: true, checks: [check('a', 'failure')] }))
    expect(linesInOrder(lines).map(line => line.tone)).toEqual(['failed', 'todo', 'unknown', 'done', 'done'])
    expect(lines.map(line => line.id)).toEqual(['checks', 'review', 'up-to-date', 'conflicts', 'ready'])
  })
  it('works out the order, the addresses and the matches the folds use', () => {
    expect(checksOnGitHub('https://github.com/o/r/pull/74/?x=1')).toBe('https://github.com/o/r/pull/74/checks')
    const { standing, settled } = checksInOrder([check('a', 'success'), check('b', 'pending'), check('c', 'skipped'), check('d', 'failure'), check('e', 'cancelled'), check('f', 'action-required')])
    expect(standing.map(item => item.name)).toEqual(['d', 'e', 'f', 'b'])
    expect(settled.map(item => item.name)).toEqual(['a', 'c'])
    expect(checkWord({ status: 'pending', startedAt: null })).toBe('Queued')
    expect(checkWord({ status: 'pending', startedAt: '2026-09-23T10:00:00.000Z' })).toBe('Running')
    expect(checkTime({ startedAt: '2026-09-23T10:00:00.000Z', completedAt: '2026-09-23T10:04:12.000Z' })).toBe('4m 12s')
    expect(checkTime({ startedAt: '2026-09-23T10:00:00.000Z', completedAt: null }, Date.parse('2026-09-23T10:00:30.000Z'))).toBe('30s')
    expect(checkTime({ startedAt: null, completedAt: null })).toBeNull()
    expect(checkTime({})).toBeNull()
    expect(checkNameParts('CI / Test / shard 1')).toEqual({ group: 'CI', own: 'Test / shard 1' })
    expect(checkNameParts('deploy/preview')).toEqual({ group: null, own: 'deploy/preview' })
    expect(filesByWeight([{ path: 'b', additions: 1, deletions: 1 }, { path: 'a', additions: 1, deletions: 1 }, { path: 'c', additions: 9, deletions: 0 }]).map(file => file.path)).toEqual(['c', 'a', 'b'])
    const folders = filesByFolder([{ path: 'b/x', additions: 1, deletions: 1 }, { path: 'a/y', additions: 2, deletions: 0 }, { path: 'top', additions: 1, deletions: 0 }, { path: 'c/z', additions: 9, deletions: 4 }, { path: 'c/w', additions: 0, deletions: 1 }])
    expect(folders.map(folder => [folder.folder, folder.files.map(file => file.path), folder.additions, folder.deletions])).toEqual([['', ['top'], 1, 0], ['c/', ['c/z', 'c/w'], 9, 5], ['a/', ['a/y'], 2, 0], ['b/', ['b/x'], 1, 1]])
    expect(pathParts('src/main/x.ts')).toEqual({ folder: 'src/main/', name: 'x.ts' })
    expect(pathParts('x.ts')).toEqual({ folder: '', name: 'x.ts' })
    const item = { number: 74, title: 'Make it friendlier', author: 'mira', headBranch: 'feat/hello' }
    for (const query of ['', '#74', '74', 'FRIEND', 'mira', 'feat/hello']) expect(listMatches(item, query)).toBe(true)
    expect(listMatches(item, 'drake')).toBe(false)
  })
  it('anchors a file on GitHub by the SHA-256 of its path', async () => {
    await expect(fileOnGitHub('https://github.com/o/r/pull/74/?x=1', 'a.txt')).resolves.toBe(`https://github.com/o/r/pull/74/files#diff-${createHash('sha256').update('a.txt').digest('hex')}`)
  })
})

describe('the surface\'s foot, which ends on a whole row', () => {
  const row = (top: number, bottom: number, padTop = 9, padBottom = 9, line = 18) => ({ top, bottom, padTop, padBottom, line })
  it('stops at the top of the row the foot would cut, dissolving over its top space', () => {
    expect(footCut([row(700, 756), row(756, 812)], 790)).toEqual({ at: 756, soft: 9 })
  })
  it('lets the innermost row decide, so a fold head\'s peek gives way a row at a time', () => {
    expect(footCut([row(600, 820, 10, 10), row(760, 780, 0, 0), row(783, 803, 0, 0)], 790)).toEqual({ at: 783, soft: 4 })
  })
  it('cuts nothing where the foot falls in space: between rows, or in a row\'s bottom padding', () => {
    expect(footCut([row(700, 756), row(760, 816)], 758)).toEqual({ at: 758, soft: 0 })
    expect(footCut([row(700, 756)], 750)).toEqual({ at: 750, soft: 0 })
  })
  it('gives a tall paragraph way at its last whole line', () => {
    expect(footCut([row(500, 700, 0, 0, 22)], 620)).toEqual({ at: 610, soft: 4 })
  })
})
