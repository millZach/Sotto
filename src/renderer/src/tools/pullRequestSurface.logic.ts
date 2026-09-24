import { GIT_PULL_REQUEST_MERGE_METHOD_LABELS, gitPullRequestMergeMethodSchema, type GitPullRequestAction, type GitPullRequestCheck, type GitPullRequestDetail, type GitPullRequestLinkSource, type GitPullRequestMergeMethod } from '../../../shared/gitPullRequests'

/**
 * The one control the surface leads with, as T3 chooses it (`resolvePullRequestPrimaryControl`): nothing to
 * press for a merged or closed pull request, conflicts to resolve first, Ready for review on a draft, the armed
 * auto-merge, Auto-merge while checks have not passed, and otherwise the merge in the chosen method.
 */
export type PrimaryControl = 'merged' | 'closed' | 'resolve' | 'ready' | 'auto-merge-armed' | 'enable-auto-merge' | 'merge' | null
export function primaryControl(detail: Pick<GitPullRequestDetail, 'state' | 'draft' | 'mergeable' | 'checks' | 'autoMerge' | 'mergeMethods'>): PrimaryControl {
  if (detail.state === 'merged') return 'merged'
  if (detail.state === 'closed') return 'closed'
  if (detail.mergeable === 'conflicting') return 'resolve'
  if (detail.draft) return 'ready'
  if (detail.autoMerge) return 'auto-merge-armed'
  if (detail.mergeMethods.length === 0) return null
  const checks = checksState(detail.checks)
  if (checks !== null && checks !== 'passing') return 'enable-auto-merge'
  return 'merge'
}

/** T3's order for the method a merge uses: the one chosen here, then the one last chosen, then the first allowed. */
export function resolveMergeMethod(allowed: readonly GitPullRequestMergeMethod[], chosen: GitPullRequestMergeMethod | null, remembered: GitPullRequestMergeMethod | null): GitPullRequestMergeMethod {
  for (const method of [chosen, remembered]) if (method && allowed.includes(method)) return method
  return allowed[0] ?? 'merge'
}
export const mergeLabel = (method: GitPullRequestMergeMethod): string => GIT_PULL_REQUEST_MERGE_METHOD_LABELS[method]

const MERGE_METHOD_KEY = 'sotto.pullRequestMergeMethod'
function storage(): Storage | null { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }
/**
 * The merge method last chosen on this computer, as T3 remembers it. A Default merge method setting is its own
 * ticket (#271); until then the window keeps the choice itself, and a repository that does not allow it falls
 * back to the first method it does.
 */
export function rememberedMergeMethod(): GitPullRequestMergeMethod | null {
  const parsed = gitPullRequestMergeMethodSchema.safeParse(storage()?.getItem(MERGE_METHOD_KEY))
  return parsed.success ? parsed.data : null
}
export function rememberMergeMethod(method: GitPullRequestMergeMethod): void {
  try { storage()?.setItem(MERGE_METHOD_KEY, method) } catch { /* Private mode: the choice still holds for this surface. */ }
}

export type ChecksState = 'passing' | 'failing' | 'pending'
/** How the checks stand together; null when GitHub reported none. */
export function checksState(checks: readonly GitPullRequestCheck[]): ChecksState | null {
  if (checks.length === 0) return null
  if (checks.some(check => check.status === 'failure' || check.status === 'cancelled')) return 'failing'
  if (checks.some(check => check.status === 'pending' || check.status === 'action-required')) return 'pending'
  return 'passing'
}
/** T3's one line for the checks. */
export function summarizeChecks(checks: readonly GitPullRequestCheck[]): string {
  if (checks.length === 0) return 'No checks reported'
  const failed = checks.filter(check => check.status === 'failure' || check.status === 'cancelled').length
  const waiting = checks.filter(check => check.status === 'action-required').length
  const pending = checks.filter(check => check.status === 'pending').length
  const passed = checks.filter(check => check.status === 'success').length
  if (failed > 0) return `${failed} of ${checks.length} failing`
  if (waiting > 0) return `${waiting} ${waiting === 1 ? 'check' : 'checks'} awaiting action`
  if (pending > 0) return `${pending} of ${checks.length} running`
  return passed === checks.length ? 'All checks passed' : `${passed} of ${checks.length} passing`
}
export const CHECK_STATUS: Record<GitPullRequestCheck['status'], string> = {
  success: 'Passed', failure: 'Failed', cancelled: 'Cancelled', pending: 'Running', 'action-required': 'Awaiting action', skipped: 'Skipped', neutral: 'Neutral',
}
export function reviewLabel(decision: GitPullRequestDetail['reviewDecision']): string {
  return decision === 'approved' ? 'Approved' : decision === 'changes_requested' ? 'Changes requested' : decision === 'review_required' ? 'Review required' : 'No review decision'
}
export function stateLabel(detail: Pick<GitPullRequestDetail, 'state' | 'draft'>): string {
  if (detail.state === 'merged') return 'Merged'
  if (detail.state === 'closed') return 'Closed'
  return detail.draft ? 'Draft' : 'Open'
}
export const LINK_SOURCE: Record<GitPullRequestLinkSource, string> = { created: 'Created from this thread', linked: 'Linked by you', checkout: 'Checked out from the branch picker' }

/** The presses that ask first, in T3's words: the merge, turning on auto-merge, and closing. */
export type ConfirmedAction = Extract<GitPullRequestAction, 'merge' | 'enable-auto-merge' | 'close'>
export function confirmationFor(action: ConfirmedAction, number: number, method: GitPullRequestMergeMethod): { title: string; description: string; confirm: string; danger: boolean } {
  const label = mergeLabel(method)
  switch (action) {
    case 'merge': return { title: 'Merge pull request?', description: `This merges #${number} using ${label.toLowerCase()}.`, confirm: label, danger: false }
    case 'enable-auto-merge': return { title: 'Enable auto-merge?', description: `This merges #${number} using ${label.toLowerCase()} as soon as GitHub considers it ready, which may be immediately.`, confirm: 'Enable auto-merge', danger: false }
    case 'close': return { title: 'Close pull request?', description: `This closes #${number} without merging it.`, confirm: 'Close pull request', danger: true }
  }
}

/** Whether the branch has fallen behind its base far enough that T3 offers Update branch. */
export const isStale = (detail: Pick<GitPullRequestDetail, 'state' | 'behindBy'>): boolean => detail.state === 'open' && (detail.behindBy ?? 0) > 0
