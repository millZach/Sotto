import { useEffect, useState } from 'react'
import type { MainCheckoutBridge, ProjectMainCheckout } from '../../../shared/mainCheckout'

/** Every project's line, by local project ID, as main last said; empty without the bridge (ADR-0140). */
export function useMainCheckoutLines(bridge: MainCheckoutBridge | undefined = window.sotto?.mainCheckout): ReadonlyMap<string, ProjectMainCheckout> {
  const [lines, setLines] = useState<ReadonlyMap<string, ProjectMainCheckout>>(() => new Map())
  useEffect(() => {
    if (!bridge) return
    let current = true
    const take = (projects: readonly ProjectMainCheckout[]): void => { if (current) setLines(new Map(projects.map(line => [line.projectId, line]))) }
    void bridge.read().then(state => take(state.projects), () => undefined)
    const off = bridge.onChanged(state => take(state.projects))
    return () => { current = false; off() }
  }, [bridge])
  return lines
}

const IN_PROGRESS_WORDS = { merge: 'a merge', rebase: 'a rebase', 'cherry-pick': 'a cherry-pick', revert: 'a revert' } as const

/** What stopped the update, in the line's words; null when nothing did. */
export function blockWords(line: ProjectMainCheckout): string | null {
  const blocked = line.blocked
  if (!blocked) return null
  switch (blocked.reason) {
    case 'changes': return 'local changes block the update'
    case 'untracked': return 'untracked files are in the way'
    case 'in-progress': return `${IN_PROGRESS_WORDS[blocked.operation]} is in progress`
    case 'branch': return blocked.checkedOut ? `${blocked.checkedOut} is checked out` : 'no branch is checked out'
    case 'diverged': return `${blocked.ahead === 1 ? 'a local commit blocks' : `${blocked.ahead.toLocaleString()} local commits block`} the update`
  }
}

/** The press that lists what is in the way, or null where there is nothing to list (another branch is checked out). */
export function showLabel(line: ProjectMainCheckout): string | null {
  if (!line.blocked || line.blocked.reason === 'branch') return null
  return line.blocked.reason === 'diverged' ? 'Show commits' : 'Show changes'
}

/** "main is 1,320 behind". */
export function behindWords(line: ProjectMainCheckout): string {
  return `${line.branch} is ${line.behind.toLocaleString()} behind`
}

