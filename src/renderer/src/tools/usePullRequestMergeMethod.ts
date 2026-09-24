import { useCallback, useSyncExternalStore } from 'react'
import { gitPullRequestMergeMethodSchema, type GitPullRequestMergeMethod } from '../../../shared/gitPullRequests'

const KEY = 'sotto.pullRequestMergeMethod'
const listeners = new Set<() => void>()
function storage(): Storage | null { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }
function read(): GitPullRequestMergeMethod | null {
  const parsed = gitPullRequestMergeMethodSchema.safeParse(storage()?.getItem(KEY))
  return parsed.success ? parsed.data : null
}
function subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }

/**
 * The merge method the Pull request surface offers first, and the way to change it: the one last chosen on this
 * computer, as T3 remembers it, or null before any choice. The surface falls back to the first method a
 * repository allows. This hook is the one place that knows where the choice is kept, so the Default merge method
 * setting (#271) replaces what is inside it and nothing else.
 */
export function usePullRequestMergeMethod(): readonly [GitPullRequestMergeMethod | null, (method: GitPullRequestMergeMethod) => void] {
  const method = useSyncExternalStore(subscribe, read, read)
  const choose = useCallback((next: GitPullRequestMergeMethod): void => {
    try { storage()?.setItem(KEY, next) } catch { /* Storage refused (private mode): the first allowed method stays the one offered. */ }
    for (const listener of listeners) listener()
  }, [])
  return [method, choose] as const
}
