import { useCallback, useState } from 'react'
import type { GitPullRequestMergeMethod } from '../../../shared/gitPullRequests'
import { useMergeMethod } from '../state/gitSettings'

/**
 * The merge method the merge checklist offers first, and the way to change it. It starts where the Merge method
 * setting says (Settings → Git, #271): the method chosen there, or under Last selected the one picked last. A pick
 * beside Merge holds for this surface until the setting's method changes, the way Changes yields to its settings;
 * under Last selected the pick is saved as the one to start on next time, in every window and after a restart, and
 * under a fixed default nothing is saved. The surface falls back to the first method a repository allows when this
 * one is not.
 */
export function usePullRequestMergeMethod(): readonly [GitPullRequestMergeMethod, (method: GitPullRequestMergeMethod) => void] {
  const { method, remember } = useMergeMethod()
  const [picked, setPicked] = useState<GitPullRequestMergeMethod | null>(null)
  // The setting's method as last seen: when it changes (in Settings, or a pick saved from another window), the setting wins.
  const [seen, setSeen] = useState(method)
  if (seen !== method) { setSeen(method); setPicked(null) }
  const choose = useCallback((next: GitPullRequestMergeMethod): void => { setPicked(next); remember(next) }, [remember])
  return [picked ?? method, choose] as const
}
