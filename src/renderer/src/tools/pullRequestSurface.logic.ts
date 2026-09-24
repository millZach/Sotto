import { GIT_PULL_REQUEST_MERGE_METHOD_LABELS, type GitPullRequestAction, type GitPullRequestCheck, type GitPullRequestDetail, type GitPullRequestLinkSource, type GitPullRequestMergeMethod } from '../../../shared/gitPullRequests'

type Detail = Pick<GitPullRequestDetail, 'state' | 'draft' | 'checks' | 'reviewDecision' | 'reviews' | 'mergeable' | 'behindBy' | 'canUpdateBranch' | 'baseBranch' | 'url'>

/**
 * How a line of the merge checklist stands: done, failed (something must change), running (GitHub is still
 * working it out), to do (a step someone has to take), or unknown (GitHub could not say, which does not hold
 * the merge back, since nothing here could fix it).
 */
export type LineTone = 'done' | 'failed' | 'running' | 'todo' | 'unknown'
/** The one press that fixes a line: a link to the failing check or the review on GitHub, or the step itself. */
export type LineFix =
  | { readonly kind: 'open-check'; readonly name: string; readonly url: string }
  | { readonly kind: 'open-review'; readonly author: string | null; readonly url: string }
  | { readonly kind: 'update-branch' }
  | { readonly kind: 'ready' }
export interface ChecklistLine {
  readonly id: 'checks' | 'review' | 'up-to-date' | 'conflicts' | 'ready'
  readonly label: string
  readonly tone: LineTone
  /** Why the line stands as it does, in a short sentence. */
  readonly why: string
  readonly fix: LineFix | null
}

const FAILED: ReadonlySet<GitPullRequestCheck['status']> = new Set(['failure', 'cancelled'])
const plural = (count: number, one: string, many: string): string => count === 1 ? one : many

function checksLine(checks: readonly GitPullRequestCheck[]): ChecklistLine {
  const line = { id: 'checks', label: 'Checks passing' } as const
  if (checks.length === 0) return { ...line, label: 'No checks', tone: 'done', why: 'GitHub reports none for this pull request', fix: null }
  const failed = checks.filter(check => FAILED.has(check.status))
  const first = failed[0]
  if (first) {
    const what = first.status === 'cancelled' ? `${first.name} was cancelled` : `${first.name} failed`
    const why = failed.length > 1 ? `${what}, and ${failed.length - 1} more` : first.description ? `${what}: ${first.description}` : what
    return { ...line, tone: 'failed', why, fix: first.url ? { kind: 'open-check', name: first.name, url: first.url } : null }
  }
  const waiting = checks.find(check => check.status === 'action-required')
  if (waiting) return { ...line, tone: 'todo', why: `${waiting.name} is waiting for approval on GitHub`, fix: waiting.url ? { kind: 'open-check', name: waiting.name, url: waiting.url } : null }
  const running = checks.filter(check => check.status === 'pending')
  if (running.length > 0) return { ...line, tone: 'running', why: running.length === 1 ? `${running[0]!.name} is still running` : `${running[0]!.name} and ${running.length - 1} more are still running`, fix: null }
  const passed = checks.filter(check => check.status === 'success').length
  const why = passed < checks.length ? `${passed} passed, ${checks.length - passed} skipped` : checks.length === 1 ? `${checks[0]!.name} passed` : `All ${checks.length} passed`
  return { ...line, tone: 'done', why, fix: null }
}

function reviewLine(detail: Detail): ChecklistLine {
  const line = { id: 'review', label: 'Review approved' } as const
  const latest = (state: 'approved' | 'changes_requested') => [...detail.reviews].reverse().find(review => review.state === state)
  const approved = latest('approved'), changes = latest('changes_requested')
  const askedForChanges = (): ChecklistLine => ({ ...line, tone: 'failed', why: changes ? `${changes.author} asked for changes` : 'Changes were asked for',
    fix: { kind: 'open-review', author: changes?.author ?? null, url: changes?.url ?? detail.url } })
  switch (detail.reviewDecision) {
    case 'approved': return { ...line, tone: 'done', why: approved ? `Approved by ${approved.author}` : 'Approved', fix: null }
    case 'changes_requested': return askedForChanges()
    case 'review_required': return { ...line, tone: 'todo', fix: null,
      why: detail.draft ? 'Reviewers wait until it is ready' : detail.reviews.length === 0 ? 'Nobody has reviewed it yet' : 'It still needs an approving review' }
    default:
      // The repository requires no review: a request for changes still holds it back; otherwise there is nothing to wait for.
      if (changes && (!approved || detail.reviews.lastIndexOf(changes) > detail.reviews.lastIndexOf(approved))) return askedForChanges()
      return approved ? { ...line, tone: 'done', why: `Approved by ${approved.author}`, fix: null }
        : { ...line, label: 'No review required', tone: 'done', why: 'This repository merges without one', fix: null }
  }
}

function upToDateLine(detail: Detail): ChecklistLine {
  const line = { id: 'up-to-date', label: `Up to date with ${detail.baseBranch}` } as const
  if (detail.state === 'merged') return { ...line, tone: 'done', why: `Merged into ${detail.baseBranch}`, fix: null }
  if (detail.behindBy === null) return { ...line, tone: 'unknown', why: `GitHub could not compare it with ${detail.baseBranch}`, fix: null }
  if (detail.behindBy === 0) return { ...line, tone: 'done', why: `Has every commit on ${detail.baseBranch}`, fix: null }
  const behind = `${detail.behindBy} ${plural(detail.behindBy, 'commit', 'commits')} behind ${detail.baseBranch}`
  if (detail.state !== 'open') return { ...line, tone: 'todo', why: behind, fix: null }
  return detail.canUpdateBranch ? { ...line, tone: 'todo', why: behind, fix: { kind: 'update-branch' } }
    : { ...line, tone: 'todo', why: `${behind}. GitHub does not let this account update it`, fix: null }
}

function conflictsLine(detail: Detail): ChecklistLine {
  const line = { id: 'conflicts', label: 'No conflicts' } as const
  if (detail.state === 'merged') return { ...line, tone: 'done', why: 'Merged without conflicts', fix: null }
  if (detail.mergeable === 'conflicting') return { ...line, tone: 'failed', why: `Conflicts with ${detail.baseBranch}. Resolve them in the branch and push`, fix: null }
  if (detail.mergeable === 'mergeable') return { ...line, tone: 'done', why: `Merges cleanly into ${detail.baseBranch}`, fix: null }
  return detail.state === 'open' ? { ...line, tone: 'running', why: 'GitHub is still checking. Refresh in a moment', fix: null }
    : { ...line, tone: 'unknown', why: 'GitHub checks again if it is reopened', fix: null }
}

function readyLine(detail: Detail): ChecklistLine {
  const line = { id: 'ready', label: 'Ready for review' } as const
  if (!detail.draft) return { ...line, tone: 'done', why: 'Not a draft', fix: null }
  return { ...line, tone: 'todo', why: 'Still a draft', fix: detail.state === 'open' ? { kind: 'ready' } : null }
}

/**
 * The merge checklist, the Pull request surface's whole reading of a pull request: five lines in the order a
 * merge meets them (checks, review, the base, conflicts, draft), each done or saying what holds it back, with the
 * one press that fixes it where there is one.
 */
export function checklist(detail: Detail): ChecklistLine[] {
  return [checksLine(detail.checks), reviewLine(detail), upToDateLine(detail), conflictsLine(detail), readyLine(detail)]
}
/** A line that holds the merge back. An unknown one does not: GitHub decides when the merge is pressed. */
export const holdsBack = (line: ChecklistLine): boolean => line.tone === 'failed' || line.tone === 'running' || line.tone === 'todo'

/** Merge is enabled only for an open pull request with no armed auto-merge, a method to merge with and no line holding it back. */
export function mergeReady(detail: Pick<GitPullRequestDetail, 'state' | 'autoMerge' | 'mergeMethods'>, lines: readonly ChecklistLine[]): boolean {
  return detail.state === 'open' && detail.autoMerge === null && detail.mergeMethods.length > 0 && !lines.some(holdsBack)
}
/** Merge when ready, GitHub's auto-merge: for an open pull request that is not a draft, where the repository allows it. */
export function canAutoMerge(detail: Pick<GitPullRequestDetail, 'state' | 'draft' | 'autoMerge' | 'autoMergeAllowed' | 'mergeMethods'>): boolean {
  return detail.state === 'open' && !detail.draft && detail.autoMerge === null && detail.autoMergeAllowed && detail.mergeMethods.length > 0
}
export function checklistHeading(detail: Pick<GitPullRequestDetail, 'state'>, ready: boolean): string {
  return detail.state !== 'open' ? 'Merge checklist' : ready ? 'Ready to merge' : 'Before merging'
}
export function linesLeft(lines: readonly ChecklistLine[]): string {
  const left = lines.filter(holdsBack).length
  return `${left} ${plural(left, 'line', 'lines')} left before this can merge.`
}

/** T3's order for the method a merge uses: the one chosen last, when this repository allows it, then the first it allows. */
export function resolveMergeMethod(allowed: readonly GitPullRequestMergeMethod[], preferred: GitPullRequestMergeMethod | null): GitPullRequestMergeMethod {
  return preferred && allowed.includes(preferred) ? preferred : allowed[0] ?? 'merge'
}
export const mergeLabel = (method: GitPullRequestMergeMethod): string => GIT_PULL_REQUEST_MERGE_METHOD_LABELS[method]
/** The method's short name on the button beside Merge. */
export const MERGE_METHOD_SHORT: Record<GitPullRequestMergeMethod, string> = { merge: 'Merge commit', squash: 'Squash', rebase: 'Rebase' }
/** What the method leaves on the base branch, said under Merge and in the method menu. */
export function mergeEffect(method: GitPullRequestMergeMethod, base: string): string {
  return method === 'squash' ? `One commit on ${base}` : method === 'rebase' ? `Every commit, replayed onto ${base}` : 'Every commit, plus a merge commit'
}

export function stateLabel(detail: Pick<GitPullRequestDetail, 'state' | 'draft'>): string {
  if (detail.state === 'merged') return 'Merged'
  if (detail.state === 'closed') return 'Closed'
  return detail.draft ? 'Draft' : 'Open'
}
export const LINK_SOURCE: Record<GitPullRequestLinkSource, string> = { created: 'Created from this thread', linked: 'Linked by you', checkout: 'Checked out from the branch picker' }

/** When a pull request merged, as a time today or a date and time before; null when GitHub gave nothing readable. */
export function mergedWhen(iso: string | null, now = new Date()): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return at.toDateString() === now.toDateString() ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/**
 * The presses that ask first, in T3's words: the merge, turning on auto-merge, closing, and Update with rebase,
 * which rewrites the branch's commits on GitHub so a local copy of it no longer matches.
 */
export type ConfirmedAction = Extract<GitPullRequestAction, 'merge' | 'enable-auto-merge' | 'close'> | 'update-with-rebase'
export function confirmationFor(action: ConfirmedAction, number: number, method: GitPullRequestMergeMethod, baseBranch = 'its base'): { title: string; description: string; confirm: string; danger: boolean } {
  const label = mergeLabel(method)
  switch (action) {
    case 'update-with-rebase': return { title: 'Update with rebase?', description: `This rebases the branch of #${number} onto ${baseBranch} on GitHub, rewriting its commits. A local copy of the branch will no longer match it: pull, or check it out again, before pushing to it.`, confirm: 'Update with rebase', danger: false }
    case 'merge': return { title: 'Merge pull request?', description: `This merges #${number} into ${baseBranch} using ${label.toLowerCase()}.`, confirm: label, danger: false }
    case 'enable-auto-merge': return { title: 'Enable auto-merge?', description: `This merges #${number} using ${label.toLowerCase()} as soon as GitHub considers it ready, which may be immediately.`, confirm: 'Enable auto-merge', danger: false }
    case 'close': return { title: 'Close pull request?', description: `This closes #${number} without merging it.`, confirm: 'Close pull request', danger: true }
  }
}
