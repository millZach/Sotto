import { useCallback, useState } from 'react'
import type { GitPullRequestMergeMethod } from '../../../shared/gitPullRequests'
import { useMergeMethod } from '../state/gitSettings'

/**
 * The merge method the merge checklist offers first, and the way to change it. It starts where the Merge method
 * setting says (Settings → Git, #271): the method chosen there, or under Last selected the one picked last. A pick
 * beside Merge holds for this surface, and under Last selected it is saved as the one to start on next time, in
 * every window and after a restart; under a fixed default nothing is saved. The surface falls back to the first
 * method a repository allows when this one is not.
 */
export function usePullRequestMergeMethod(): readonly [GitPullRequestMergeMethod, (method: GitPullRequestMergeMethod) => void] {
  const { method, remember } = useMergeMethod()
  const [picked, setPicked] = useState<GitPullRequestMergeMethod | null>(null)
  const choose = useCallback((next: GitPullRequestMergeMethod): void => { setPicked(next); remember(next) }, [remember])
  return [picked ?? method, choose] as const
}
