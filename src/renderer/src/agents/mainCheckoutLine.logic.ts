import { useEffect, useState } from 'react'
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg, plural, t } from '@lingui/core/macro'
import type { MainCheckoutBridge, MainCheckoutChanges, ProjectMainCheckout } from '../../../shared/mainCheckout'
import { shownLocalCount } from '../state/interfaceNumbers'

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

const IN_PROGRESS_WORDS = {
  merge: msg`a merge is in progress`,
  rebase: msg`a rebase is in progress`,
  'cherry-pick': msg`a cherry-pick is in progress`,
  revert: msg`a revert is in progress`,
} as const satisfies Record<string, MessageDescriptor>

/** What stopped the update, in the line's words; null when nothing did. */
export function blockWords(line: ProjectMainCheckout): string | null {
  const blocked = line.blocked
  if (!blocked) return null
  switch (blocked.reason) {
    case 'changes': return t`local changes block the update`
    case 'untracked': return t`untracked files are in the way`
    case 'in-progress': return i18n._(IN_PROGRESS_WORDS[blocked.operation])
    case 'branch': {
      const branch = blocked.checkedOut
      return branch ? t`${branch} is checked out` : t`no branch is checked out`
    }
    case 'diverged': return plural(blocked.ahead, { one: 'a local commit blocks the update', other: `${{ commits: shownLocalCount(blocked.ahead) }} local commits block the update` })
  }
}

/** The press that lists what is in the way, or null where there is nothing to list (another branch is checked out). */
export function showLabel(line: ProjectMainCheckout): string | null {
  if (!line.blocked || line.blocked.reason === 'branch') return null
  return line.blocked.reason === 'diverged' ? t`Show commits` : t`Show changes`
}

/** "main is 1,320 behind". */
export function behindWords(line: ProjectMainCheckout): string {
  const branch = line.branch
  const behind = shownLocalCount(line.behind)
  return t({ message: `${branch} is ${behind} behind`, comment: '{branch} is a Git branch name, such as main; {behind} counts commits.' })
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
