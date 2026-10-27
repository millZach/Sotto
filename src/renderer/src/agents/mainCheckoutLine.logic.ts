import { useEffect, useState } from 'react'
import type { MessageDescriptor } from '@lingui/core'
import { msg, t } from '@lingui/core/macro'
import type { MainCheckoutBridge, MainCheckoutChanges, ProjectMainCheckout } from '../../../shared/mainCheckout'

/** Every project's line, by local project ID, as main last said; empty without the bridge (ADR-0142). */
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

/** What is in progress, as the line says it. */
export const IN_PROGRESS_WORDS = {
  merge: msg`a merge is in progress`,
  rebase: msg`a rebase is in progress`,
  'cherry-pick': msg`a cherry-pick is in progress`,
  revert: msg`a revert is in progress`,
} as const satisfies Record<string, MessageDescriptor>

/** The press that lists what is in the way, or null where there is nothing to list (another branch is checked out). */
export function showLabel(line: ProjectMainCheckout): string | null {
  if (!line.blocked || line.blocked.reason === 'branch') return null
  return line.blocked.reason === 'diverged' ? t`Show commits` : t`Show changes`
}

/** The kind of each listed item, as the list shows it beside the path or commit. */
export const CHANGE_KIND_WORDS: Record<MainCheckoutChanges['items'][number]['kind'], MessageDescriptor> = {
  modified: msg({ message: 'modified', comment: 'A file with local changes' }),
  added: msg({ message: 'added', comment: 'A file added locally' }),
  deleted: msg({ message: 'deleted', comment: 'A file deleted locally' }),
  renamed: msg({ message: 'renamed', comment: 'A file renamed locally' }),
  conflict: msg({ message: 'conflict', comment: 'A file with a merge conflict' }),
  untracked: msg({ message: 'untracked', comment: 'A file Git does not track' }),
  commit: msg({ message: 'commit', comment: 'A commit only this computer has' }),
}
