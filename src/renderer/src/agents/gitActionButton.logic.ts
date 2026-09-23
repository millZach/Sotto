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

export const HINT_UP_TO_DATE = 'Branch is up to date. No action needed.'
export const HINT_NOTHING_TO_PUSH = 'No local commits to push.'
export const HINT_DIVERGED = 'Branch has diverged from upstream. Rebase/merge first.'
export const HINT_DETACHED = 'Create and checkout a ref before pushing or opening a pull request.'

const openPullRequest = (status: GitStatus): boolean => status.pullRequest?.state === 'open'

/** The quick action for a status, T3's `getGitQuickAction`; null when the host has not read the folder yet. */
export function quickAction(status: GitStatus | undefined): GitQuickAction | null {
  if (!status) return null
  if (!status.isRepository) return { kind: 'init', label: 'Initialize Git' }
  const open = openPullRequest(status)
  if (status.dirty) {
    if (!status.hasRemote) return { kind: 'commit', label: 'Commit' }
    if (open || status.isDefaultBranch) return { kind: 'commit_push', label: 'Commit & push' }
    return { kind: 'commit_push_pr', label: 'Commit, push & PR' }
  }
  if (!status.branch) return { kind: 'commit', label: 'Commit', hint: HINT_DETACHED }
  if (!status.upstream) {
    if (!status.hasRemote) return { kind: 'publish', label: 'Publish repository' }
    // Without an upstream, ahead stands for the distance from the default branch (T3's rule, read by the host).
    if (status.ahead > 0) return open || status.isDefaultBranch ? { kind: 'push', label: 'Push' } : { kind: 'push_pr', label: 'Push & create PR' }
    if (open) return { kind: 'view_pr', label: 'View PR' }
    return { kind: 'push', label: 'Push', hint: HINT_NOTHING_TO_PUSH }
  }
  if (status.behind > 0 && status.ahead > 0) return { kind: 'sync', label: 'Sync ref', hint: HINT_DIVERGED }
  if (status.behind > 0) return { kind: 'pull', label: 'Pull' }
  if (status.ahead > 0) return open || status.isDefaultBranch ? { kind: 'push', label: 'Push' } : { kind: 'push_pr', label: 'Push & create PR' }
  if (open) return { kind: 'view_pr', label: 'View PR' }
  if (!status.isDefaultBranch && (status.aheadOfDefault ?? 0) > 0) return { kind: 'create_pr', label: 'Create PR' }
  return { kind: 'commit', label: 'Commit', hint: HINT_UP_TO_DATE }
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
  const push: GitMenuEntry = detached ? { id: 'push', label: 'Push', hint: HINT_DETACHED }
    : !status.hasRemote ? { id: 'push', label: 'Push', hint: 'Publish the repository first.' }
      : status.behind > 0 && status.ahead > 0 ? { id: 'push', label: 'Push', hint: HINT_DIVERGED }
        : status.ahead === 0 && status.upstream ? { id: 'push', label: 'Push', hint: HINT_NOTHING_TO_PUSH }
          : { id: 'push', label: 'Push' }
  const pullRequest: GitMenuEntry = open ? { id: 'view_pr', label: 'View PR' }
    : detached ? { id: 'create_pr', label: 'Create PR', hint: HINT_DETACHED }
      : !status.hasRemote ? { id: 'create_pr', label: 'Create PR', hint: 'Publish the repository first.' }
        : status.isDefaultBranch ? { id: 'create_pr', label: 'Create PR', hint: 'Commit on a new branch first: this is the default branch.' }
          : status.dirty ? { id: 'create_pr', label: 'Create PR', hint: 'Commit local changes before creating a PR.' }
            : { id: 'create_pr', label: 'Create PR' }
  return [
    { id: 'commit', label: 'Commit', ...(status.dirty ? {} : { hint: 'No changes to commit.' }) },
    push,
    pullRequest,
    ...(status.hasRemote ? [] : [{ id: 'publish' as const, label: 'Publish repository...' }]),
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
  return action === 'commit_push' ? 'Commit & push' : action === 'commit_push_pr' ? 'Commit, push & PR' : 'Commit'
}

/** T3 asks before a push or a pull request leaves the default branch, unless a feature branch is cut first. */
export function needsDefaultBranchConfirmation(status: GitStatus | undefined, action: GitStackedAction, featureBranch: boolean): boolean {
  return Boolean(status?.isDefaultBranch) && action !== 'commit' && !featureBranch
}

/** The confirmation's words: what is about to leave the default branch. */
export function defaultBranchQuestion(action: GitStackedAction, branch: string): { title: string; description: string; confirm: string } {
  const pr = action === 'create_pr' || action === 'commit_push_pr'
  return {
    title: 'Push to default ref?',
    description: `This ${pr ? 'creates a pull request' : 'pushes'} from ${branch}, the default branch. Push there, or check out a feature branch and continue on it.`,
    confirm: `Push to ${branch}`,
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
    return { tone: 'progress', title: progress.stage ?? 'Working...', ...(hook ? { detail: hook.output ? `${hook.name}: ${hook.output}` : `Running ${hook.name}...` } : {}) }
  }
  if (progress.status === 'failed') return { tone: 'error', title: 'Action failed', ...(progress.error ? { detail: progress.error } : {}) }
  const toast = progress.result?.toast
  if (!toast) return { tone: 'success', title: 'Done' }
  return { tone: 'success', title: toast.title, ...(toast.description ? { detail: toast.description } : {}), ...(toast.cta.kind === 'none' ? {} : { cta: toast.cta }) }
}

export const fileCount = (count: number): string => `${count} ${count === 1 ? 'file' : 'files'}`

/** `+12 −3`, or nothing for a file whose lines were not counted. */
export function lineCounts(file: Pick<GitChangedFile, 'insertions' | 'deletions'>): string | null {
  if (file.insertions === null || file.deletions === null) return null
  return `+${file.insertions} −${file.deletions}`
}

export const STATUS_LETTER: Record<GitChangedFile['status'], { readonly letter: string; readonly label: string }> = {
  modified: { letter: 'M', label: 'Modified' }, added: { letter: 'A', label: 'Added' }, deleted: { letter: 'D', label: 'Deleted' },
  renamed: { letter: 'R', label: 'Renamed' }, untracked: { letter: 'U', label: 'Untracked' }, conflicted: { letter: 'C', label: 'Conflicted' },
  'type-changed': { letter: 'T', label: 'Type changed' },
}
