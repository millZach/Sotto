import type { GitPullRequestCheck } from '../../shared/gitPullRequests'

/** A head with no readable checks is unknown, never a passing check set. */
export function summarizePullRequestChecks(head: string | null | undefined,
  checks: readonly Pick<GitPullRequestCheck, 'status'>[] | null | undefined, unknown = false): 'unknown' | 'failed' | 'pending' | 'passed' {
  if (!head || unknown || !checks?.length) return 'unknown'
  if (checks.some(check => ['failure', 'cancelled', 'action-required'].includes(check.status))) return 'failed'
  return checks.some(check => check.status === 'pending') ? 'pending' : 'passed'
}
