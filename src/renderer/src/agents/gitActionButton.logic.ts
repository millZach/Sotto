import { plural, t } from '@lingui/core/macro'

import type { GitActionProgress, GitStackedAction } from '../../../shared/gitActions'
import type { GitChangedFile } from '../../../shared/gitChangedFiles'
import type { GitStatus } from '../../../shared/gitStatus'

/**
 * T3 Code's Git action, decided from the status alone (ADR-0027): what the button says, what a press
 * does, and why it is disabled when it is. Pure, so the table test reads the same as T3's.
 */
export type GitQuickKind = 'commit' | 'commit_push' | 'commit_push_pr' | 'push' | 'push_pr' | 'pull' | 'create_pr' | 'view_pr' | 'publish' | 'sync' | 'init'

export interface GitQuickAction {
  readonly kind: GitQuickKind
  readonly label: string
  /** Why a press does nothing, in T3's words; absent when the action runs. */
  readonly hint?: string
}

/** T3's hints in English, as its table reads them; the button shows each in the interface language (below). */
export const HINT_UP_TO_DATE = 'Branch is up to date. No action needed.'
export const HINT_NOTHING_TO_PUSH = 'No local commits to push.'
export const HINT_DIVERGED = 'Branch has diverged from upstream. Rebase/merge first.'
export const HINT_DETACHED = 'Create and checkout a ref before pushing or opening a pull request.'
const upToDate = (): string => t`Branch is up to date. No action needed.`
const nothingToPush = (): string => t`No local commits to push.`
const diverged = (): string => t`Branch has diverged from upstream. Rebase/merge first.`
const detachedHint = (): string => t`Create and checkout a ref before pushing or opening a pull request.`
const publishFirst = (): string => t`Publish the repository first.`
const commitWord = (): string => t({ message: 'Commit', comment: 'A Git action: commit the changes.' })
const pushWord = (): string => t({ message: 'Push', comment: 'A Git action: push commits to the remote.' })
const commitPushWord = (): string => t`Commit & push`
const commitPushPrWord = (): string => t`Commit, push & PR`
const pushPrWord = (): string => t`Push & create PR`
const viewPrWord = (): string => t`View PR`
const createPrWord = (): string => t`Create PR`

const openPullRequest = (status: GitStatus): boolean => status.pullRequest?.state === 'open'

/** The quick action for a status, T3's `getGitQuickAction`; null when the host has not read the folder yet. */
export function quickAction(status: GitStatus | undefined): GitQuickAction | null {
  if (!status) return null
  if (!status.isRepository) return { kind: 'init', label: t`Initialize Git` }
  const open = openPullRequest(status)
  if (status.dirty) {
    // A detached HEAD can take a commit, not a push: the host refuses to push from it, so the press offers only what runs.
    if (!status.hasRemote || !status.branch) return { kind: 'commit', label: commitWord() }
    if (open || status.isDefaultBranch) return { kind: 'commit_push', label: commitPushWord() }
    return { kind: 'commit_push_pr', label: commitPushPrWord() }
  }
  if (!status.branch) return { kind: 'commit', label: commitWord(), hint: detachedHint() }
  if (!status.upstream) {
    if (!status.hasRemote) return { kind: 'publish', label: t`Publish repository` }
    // Without an upstream, ahead stands for the distance from the default branch (T3's rule, read by the host).
    if (status.ahead > 0) return open || status.isDefaultBranch ? { kind: 'push', label: pushWord() } : { kind: 'push_pr', label: pushPrWord() }
    if (open) return { kind: 'view_pr', label: viewPrWord() }
    return { kind: 'push', label: pushWord(), hint: nothingToPush() }
  }
  if (status.behind > 0 && status.ahead > 0) return { kind: 'sync', label: t`Sync ref`, hint: diverged() }
  if (status.behind > 0) return { kind: 'pull', label: t({ message: 'Pull', comment: 'A Git action: pull commits from the remote.' }) }
  if (status.ahead > 0) return open || status.isDefaultBranch ? { kind: 'push', label: pushWord() } : { kind: 'push_pr', label: pushPrWord() }
  if (open) return { kind: 'view_pr', label: viewPrWord() }
  if (!status.isDefaultBranch && (status.aheadOfDefault ?? 0) > 0) return { kind: 'create_pr', label: createPrWord() }
  return { kind: 'commit', label: commitWord(), hint: upToDate() }
}

export interface GitMenuEntry {
  readonly id: 'commit' | 'push' | 'create_pr' | 'view_pr' | 'publish'
  readonly label: string
  readonly hint?: string
}

/** The chevron menu: every action, each disabled with its reason rather than left out, so the menu keeps its shape. */
export function menuEntries(status: GitStatus | undefined): GitMenuEntry[] {
  if (!status?.isRepository) return []
  const open = openPullRequest(status)
  const detached = !status.branch
  const push: GitMenuEntry = detached ? { id: 'push', label: pushWord(), hint: detachedHint() }
    : !status.hasRemote ? { id: 'push', label: pushWord(), hint: publishFirst() }
      : status.behind > 0 && status.ahead > 0 ? { id: 'push', label: pushWord(), hint: diverged() }
        : status.ahead === 0 && status.upstream ? { id: 'push', label: pushWord(), hint: nothingToPush() }
          : { id: 'push', label: pushWord() }
  const pullRequest: GitMenuEntry = open ? { id: 'view_pr', label: viewPrWord() }
    : detached ? { id: 'create_pr', label: createPrWord(), hint: detachedHint() }
      : !status.hasRemote ? { id: 'create_pr', label: createPrWord(), hint: publishFirst() }
        : status.isDefaultBranch ? { id: 'create_pr', label: createPrWord(), hint: t`Commit on a new branch first: this is the default branch.` }
          : status.dirty ? { id: 'create_pr', label: createPrWord(), hint: t`Commit local changes before creating a PR.` }
            : { id: 'create_pr', label: createPrWord() }
  return [
    { id: 'commit', label: commitWord(), ...(status.dirty ? {} : { hint: t`No changes to commit.` }) },
    push,
    pullRequest,
    ...(status.hasRemote ? [] : [{ id: 'publish' as const, label: t`Publish repository...` }]),
  ]
}

/** The host's stacked action a quick action or menu entry runs; null for the ones that open something or nothing. */
export function stackedFor(kind: GitQuickKind | GitMenuEntry['id']): GitStackedAction | null {
  switch (kind) {
    case 'commit': return 'commit'
    case 'commit_push': return 'commit_push'
    case 'commit_push_pr': return 'commit_push_pr'
    case 'push': return 'push'
    case 'push_pr': case 'create_pr': return 'create_pr'
    default: return null
  }
}

export const commits = (action: GitStackedAction): boolean => action === 'commit' || action === 'commit_push' || action === 'commit_push_pr'

/** The dialog's primary button says what the press does, all of it. */
export function commitLabel(action: GitStackedAction): string {
  return action === 'commit_push' ? commitPushWord() : action === 'commit_push_pr' ? commitPushPrWord() : commitWord()
}

/** T3 asks before a push or a pull request leaves the default branch, unless a feature branch is cut first. */
export function needsDefaultBranchConfirmation(status: GitStatus | undefined, action: GitStackedAction, featureBranch: boolean): boolean {
  return Boolean(status?.isDefaultBranch) && action !== 'commit' && !featureBranch
}

/** The confirmation's words: what is about to leave the default branch. */
export function defaultBranchQuestion(action: GitStackedAction, branch: string): { title: string; description: string; confirm: string } {
  const pr = action === 'create_pr' || action === 'commit_push_pr'
  return {
    title: t`Push to default ref?`,
    description: pr
      ? t({ message: `This creates a pull request from ${branch}, the default branch. Push there, or check out a feature branch and continue on it.`, comment: '{branch} is a Git branch name.' })
      : t({ message: `This pushes from ${branch}, the default branch. Push there, or check out a feature branch and continue on it.`, comment: '{branch} is a Git branch name.' }),
    confirm: t({ message: `Push to ${branch}`, comment: '{branch} is a Git branch name.' }),
  }
}

export interface GitNotice {
  readonly tone: 'progress' | 'success' | 'error'
  readonly title: string
  readonly detail?: string
  readonly cta?: { readonly kind: 'open_pr'; readonly label: string; readonly url: string } | { readonly kind: 'run_action'; readonly label: string; readonly action: GitStackedAction }
}

/** One notice for the action as it runs and once it is over, in T3's words, from the record the host keeps. */
export function noticeFor(progress: GitActionProgress): GitNotice {
  if (progress.status === 'running') {
    const hook = progress.hook
    const name = hook?.name
    return { tone: 'progress', title: progress.stage ?? t`Working...`, ...(hook ? { detail: hook.output ? `${hook.name}: ${hook.output}` : t({ message: `Running ${name}...`, comment: '{name} is a Git hook\'s name, such as pre-commit.' }) } : {}) }
  }
  if (progress.status === 'failed') return { tone: 'error', title: t`Action failed`, ...(progress.error ? { detail: progress.error } : {}) }
  const toast = progress.result?.toast
  if (!toast) return { tone: 'success', title: t({ message: 'Done', comment: 'A Git action finished.' }) }
  return { tone: 'success', title: toast.title, ...(toast.description ? { detail: toast.description } : {}), ...(toast.cta.kind === 'none' ? {} : { cta: toast.cta }) }
}

export const fileCount = (count: number): string => plural(count, { one: '# file', other: '# files' })

/** `+12 −3`, or nothing for a file whose lines were not counted. */
export function lineCounts(file: Pick<GitChangedFile, 'insertions' | 'deletions'>): string | null {
  if (file.insertions === null || file.deletions === null) return null
  return `+${file.insertions} −${file.deletions}`
}

/** Git's letter for a changed file, and its name in the interface language, read when shown. */
export const STATUS_LETTER: Record<GitChangedFile['status'], { readonly letter: string; readonly label: string }> = {
  modified: { letter: 'M', get label() { return t({ message: 'Modified', comment: 'A changed file\'s Git status.' }) } },
  added: { letter: 'A', get label() { return t({ message: 'Added', comment: 'A changed file\'s Git status.' }) } },
  deleted: { letter: 'D', get label() { return t({ message: 'Deleted', comment: 'A changed file\'s Git status.' }) } },
  renamed: { letter: 'R', get label() { return t({ message: 'Renamed', comment: 'A changed file\'s Git status.' }) } },
  untracked: { letter: 'U', get label() { return t({ message: 'Untracked', comment: 'A changed file\'s Git status.' }) } },
  conflicted: { letter: 'C', get label() { return t({ message: 'Conflicted', comment: 'A changed file\'s Git status.' }) } },
  'type-changed': { letter: 'T', get label() { return t({ message: 'Type changed', comment: 'A changed file\'s Git status.' }) } },
}
