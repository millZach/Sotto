import { useSyncExternalStore } from 'react'
import type { AgentThread } from '../../../shared/agents'
import { bringBackTarget, type BringBack, type BringBackTarget } from '../../../shared/bringChangesBack'

/**
 * What the strip above a delegated, continued or forked thread's composer shows (#1030, pick B of the continue prototype,
 * in place): the offer to bring this thread's commits to its parent's branch, the merge-commit question, or the outcome,
 * each replacing the last where it stands. Everything here reads the records; Git runs only when the user presses.
 */

export type BringBackView =
  | { readonly kind: 'ready'; readonly found: BringBackTarget }
  | { readonly kind: 'uncommitted'; readonly found: BringBackTarget; readonly files: number }
  | { readonly kind: 'asks'; readonly found: BringBackTarget; readonly record: BringBack }
  | { readonly kind: 'outcome'; readonly found: BringBackTarget; readonly record: BringBack }

/** What the user put away in this window: outcomes by press, and the offer until the branch changes. Nothing of it is saved. */
export class BringBackDismissals {
  private readonly outcomes = new Set<string>()
  private readonly hidden = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  get version(): number { return this.revision }
  dismissed(actionId: string): boolean { return this.outcomes.has(actionId) }
  hiddenAt(threadId: string): string | undefined { return this.hidden.get(threadId) }
  /** An outcome or a question put away; a done outcome also hides the offer until the branch changes. */
  dismiss(actionId: string, hide?: { readonly threadId: string; readonly signature: string }): void {
    this.outcomes.add(actionId)
    if (hide) this.hidden.set(hide.threadId, hide.signature)
    this.changed()
  }
  /** The offer put away until this thread's branch changes. */
  hide(threadId: string, signature: string): void { this.hidden.set(threadId, signature); this.changed() }
  /** Forgets everything put away, as a new window would. */
  clear(): void { this.outcomes.clear(); this.hidden.clear(); this.changed() }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(): void { this.revision++; for (const listener of [...this.listeners]) listener() }
}
export const bringBackDismissals = new BringBackDismissals()

/** Re-renders when anything is put away, so every pane of a thread agrees. */
export function useBringBackDismissals(store: BringBackDismissals = bringBackDismissals): BringBackDismissals {
  useSyncExternalStore(listener => store.subscribe(listener), () => store.version, () => 0)
  return store
}

/**
 * The branch as its folder was last read, without the clock: a new commit, a commit of what was uncommitted or a branch
 * switch changes it, and the timer's read of an unchanged folder does not.
 */
export function branchSignature(thread: Pick<AgentThread, 'worktree'>): string {
  const git = thread.worktree?.git
  return JSON.stringify([thread.worktree?.branch ?? null, git?.branch ?? null, git?.ahead ?? null, git?.behind ?? null, git?.aheadOfDefault ?? null, git?.changedFiles ?? null, git?.dirty ?? null, git?.upstream ?? null])
}

/** What the strip shows for a thread now, or null for no strip. */
export function bringBackView(thread: AgentThread, threads: readonly AgentThread[], dismissals: Pick<BringBackDismissals, 'dismissed' | 'hiddenAt'>): BringBackView | null {
  const found = bringBackTarget(thread, threads)
  if (!found) return null
  const record = bringBackRecord(thread, found, threads)
  if (record && record.target === found.target && !dismissals.dismissed(record.actionId)) {
    return record.status === 'asks' ? { kind: 'asks', found, record } : { kind: 'outcome', found, record }
  }
  if (dismissals.hiddenAt(thread.id) === branchSignature(thread)) return null
  const git = thread.worktree?.git
  if (git?.dirty) return { kind: 'uncommitted', found, files: Math.max(1, git.changedFiles) }
  return { kind: 'ready', found }
}

/**
 * The last press's record for this thread: on its own record, or for a child on another machine, on the record of the
 * thread its commits went to, whose host ran Git, naming this thread.
 */
export function bringBackRecord(thread: AgentThread, found: BringBackTarget, threads: readonly AgentThread[]): BringBack | undefined {
  if (!found.away) return thread.bringBack
  const record = threads.find(item => item.id === found.parentId)?.broughtBack
  return record?.from === thread.id ? record : undefined
}

export const commitCount = (count: number): string => `${count} ${count === 1 ? 'commit' : 'commits'}`
export const fileCount = (count: number): string => `${count} ${count === 1 ? 'file' : 'files'}`
const short = (sha: string | undefined): string => (sha ?? '').slice(0, 7)

/**
 * Where the target is checked out, as a phrase: the folder the parent works in, and the machine it is on when that is not
 * this thread's own.
 */
function wherePhrase(place: 'project' | 'worktree' | 'none' | undefined, parentTitle: string, machine?: string): string {
  const on = machine ? ` on ${machine}` : ''
  return place === 'worktree' ? `in the worktree${on} where ${parentTitle} works` : `in the project folder${on}, where ${parentTitle} works`
}

/** The offer's words, before any Git has run: what this branch came from and where that branch is checked out. */
export function readyWords(found: BringBackTarget, parentTitle: string, machine?: string): { readonly lead: string; readonly rest: string } {
  return { lead: `${found.branch} was made from ${found.target}.`, rest: `${found.target} is checked out ${wherePhrase(found.where, parentTitle, machine)}.` }
}

/** The question's words: why Git can't fast-forward, and what the merge commit would do. */
export function questionWords(record: BringBack): { readonly title: string; readonly body: string } {
  const theirs = record.targetCommits ?? 0, ours = record.commits ?? 0
  return {
    title: `Make a merge commit on ${record.target}?`,
    body: `${record.target} has ${commitCount(theirs)} that ${record.branch} doesn’t, so Git can’t fast-forward. Sotto can make a merge commit on ${record.target} that brings in this branch’s ${commitCount(ours)}. Nothing is rebased or forced, and this worktree stays as it is.`,
  }
}

/** An outcome's words: what happened, whether anything changed, and what to do next. */
export interface OutcomeWords {
  readonly tone: 'ok' | 'error'
  readonly title: string
  readonly body: string
  /** Git's own words, shown as Git said them. */
  readonly gitSaid?: string | undefined
  /** Offers to open the thread it began from, where the next step is. */
  readonly openParent: boolean
  /** Offers to commit here first. */
  readonly commit: boolean
}
export function outcomeWords(record: BringBack, parentTitle: string, machine?: string): OutcomeWords {
  const { target, branch } = record
  if (record.status === 'done') {
    if (record.how === 'nothing') return { tone: 'ok', title: 'Nothing to bring back.', body: `${target} already has every commit on ${branch}.`, openParent: false, commit: false }
    const on = machine ? ` on ${machine}` : ''
    const seen = record.checkedOut === 'none' ? `No folder has ${target} checked out, so only the branch moved.`
      : `${parentTitle} works on ${target} ${record.checkedOut === 'worktree' ? 'in its worktree' : 'in the project folder'}${on} and sees them now.`
    if (record.how === 'merge-commit') {
      return { tone: 'ok', title: `Brought ${commitCount(record.commits ?? 0)} to ${target} with a merge commit.`,
        body: `Merge commit ${short(record.head)} on ${target}: “${record.subject ?? `Merge branch '${branch}' into ${target}`}”. ${seen}`, openParent: record.checkedOut !== 'none', commit: false }
    }
    return { tone: 'ok', title: `Brought ${commitCount(record.commits ?? 0)} to ${target}.`, body: `Git fast-forwarded ${target} to ${short(record.head)}; nothing else changed. ${seen}`, openParent: record.checkedOut !== 'none', commit: false }
  }
  const nothing = `Nothing was brought to ${target}.`
  switch (record.refusal) {
    case 'uncommitted': return { tone: 'error', title: nothing, body: `${branch} has uncommitted changes in ${fileCount(record.files ?? 1)}, and Sotto won’t bring back uncommitted work. Commit them first, then try again.`, openParent: false, commit: true }
    case 'target-uncommitted': {
      const place = record.checkedOut === 'worktree' ? `the worktree where ${parentTitle} works` : 'the project folder'
      return record.files !== undefined
        ? { tone: 'error', title: nothing, body: `${target} is checked out in ${place}, which has uncommitted changes in ${fileCount(record.files)}, so Sotto didn’t touch it. Commit or set them aside in ${parentTitle}, then try again.`, openParent: true, commit: false }
        : { tone: 'error', title: nothing, body: `${target} is checked out in ${place}, where a merge or rebase is in progress, so Sotto didn’t touch it. Finish it there, then try again.`, openParent: true, commit: false }
    }
    case 'conflict': return { tone: 'error', title: `${nothing.slice(0, -1)}, and ${target} is unchanged.`, body: `Git found a conflict, and Sotto doesn’t resolve conflicts. Ask this thread to merge ${target} into its branch and resolve it, then try again.${record.gitSaid ? ' Git said:' : ''}`, gitSaid: record.gitSaid, openParent: false, commit: false }
    case 'moved': return { tone: 'error', title: nothing, body: `${target} or ${branch} moved since Sotto looked, so nothing changed. Press Bring changes to ${target} again.`, gitSaid: record.gitSaid, openParent: false, commit: false }
    case 'detached': return { tone: 'error', title: nothing, body: `This worktree isn’t on ${branch} any more. Switch it back to its branch, then try again.`, openParent: false, commit: false }
    case 'parent-moved': return { tone: 'error', title: nothing, body: `${parentTitle} isn’t on ${target} any more, and Sotto doesn’t switch branches. Switch it back to ${target} there, then try again.`, openParent: true, commit: false }
    case 'snapshot': return { tone: 'error', title: nothing, body: `${branch} starts from a check’s snapshot of uncommitted changes, and Sotto won’t bring that back as a commit. Ask this thread to put its own commits on a branch made from ${target}, then try again.`, openParent: false, commit: false }
    case 'ignored': return { tone: 'error', title: nothing, body: record.message ?? `The folder where ${target} is checked out has an ignored file these commits would replace, so Sotto didn’t touch it. Move it aside, then try again.`, openParent: true, commit: false }
    case 'gone': return { tone: 'error', title: 'Nothing was brought back.', body: `Git has no branch named ${target} any more.`, openParent: false, commit: false }
    case 'busy': return { tone: 'error', title: nothing, body: record.message ?? 'Something else is using one of the folders. Try again in a moment.', openParent: false, commit: false }
    default: return { tone: 'error', title: `${nothing.slice(0, -1)}, and ${target} is unchanged.`, body: `${record.message ?? 'Git refused.'}${record.gitSaid ? ' Git said:' : ''}`, gitSaid: record.gitSaid, openParent: false, commit: false }
  }
}
