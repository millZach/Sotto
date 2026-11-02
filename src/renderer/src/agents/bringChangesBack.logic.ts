import { plural, t } from '@lingui/core/macro'
import { useSyncExternalStore } from 'react'
import type { AgentThread } from '../../../shared/agents'
import { bringBackTarget, type BringBack, type BringBackTarget } from '../../../shared/bringChangesBack'
import { ltr, own } from '../components/isolated'
import { ON_HOLD } from './checkoutHold'
import { shownWords } from './interfaceWords'

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

/** What the strip shows for a thread now, or null for no strip. `desktop` is this computer's host ID, as bringBackTarget takes it. */
export function bringBackView(thread: AgentThread, threads: readonly AgentThread[], dismissals: Pick<BringBackDismissals, 'dismissed' | 'hiddenAt'>, desktop?: string): BringBackView | null {
  // Nothing shows while the thread's turn runs: its branch is still moving, and a press would only be refused.
  if (thread.status === 'running') return null
  const found = bringBackTarget(thread, threads, desktop)
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

/** "3 commits", in the reader's language. */
export const commitCount = (count: number): string => plural(count, { one: '# commit', other: '# commits' })
/** "2 files", in the reader's language. */
export const fileCount = (count: number): string => plural(count, { one: '# file', other: '# files' })
const short = (sha: string | undefined): string => ltr((sha ?? '').slice(0, 7))

/**
 * Where the target is checked out, as a sentence: the folder the parent works in, and the machine it is on when that is
 * not this thread's own. Each case is its own message, so a translation never stitches a sentence from pieces.
 */
function whereSentence(branchName: string, place: 'project' | 'worktree' | 'none' | undefined, title: string, machineName?: string): string {
  const target = ltr(branchName), parentTitle = own(title), machine = machineName === undefined ? undefined : own(machineName)
  if (place === 'worktree') return machine ? t`${target} is checked out in the worktree on ${machine} where ${parentTitle} works.` : t`${target} is checked out in the worktree where ${parentTitle} works.`
  return machine ? t`${target} is checked out in the project folder on ${machine}, where ${parentTitle} works.` : t`${target} is checked out in the project folder, where ${parentTitle} works.`
}

/** The press's name, "Bring changes to main", with the branch kept left to right. */
export function bringWords(targetName: string): string {
  const target = ltr(targetName)
  return t`Bring changes to ${target}`
}

/** The offer's words, before any Git has run: what this branch came from and where that branch is checked out. */
export function readyWords(found: BringBackTarget, parentTitle: string, machine?: string): { readonly lead: string; readonly rest: string } {
  const branch = ltr(found.branch), target = ltr(found.target)
  return { lead: t`${branch} was made from ${target}.`, rest: whereSentence(found.target, found.where, parentTitle, machine) }
}

/** The question's words: why Git can't fast-forward, and what the merge commit would do. */
export function questionWords(record: BringBack): { readonly title: string; readonly body: string } {
  const target = ltr(record.target), branch = ltr(record.branch)
  const theirs = commitCount(record.targetCommits ?? 0), ours = commitCount(record.commits ?? 0)
  return {
    title: t`Make a merge commit on ${target}?`,
    body: t`${target} has ${theirs} that ${branch} doesn’t, so Git can’t fast-forward. Sotto can make a merge commit on ${target} that brings in this branch’s ${ours}. Nothing is rebased or forced, and this worktree stays as it is.`,
  }
}

/** An outcome's words: what happened, whether anything changed, and what to do next. */
export interface OutcomeWords {
  /**
   * `held`: refused because another thread's work holds the folder where the target is checked out (#1866), which is no
   * failure. The record's `heldBy` names that thread, and the strip offers to open it.
   */
  readonly tone: 'ok' | 'error' | 'held'
  readonly title: string
  readonly body: string
  /** Git's own words, shown as Git said them. */
  readonly gitSaid?: string | undefined
  /** Offers to open the thread it began from, where the next step is. */
  readonly openParent: boolean
  /** Offers to commit here first. */
  readonly commit: boolean
}
/** Where the thread it began from sees the commits now, as a sentence of its own. */
function seenSentence(record: BringBack, title: string, machineName?: string): string {
  const target = ltr(record.target), parentTitle = own(title), machine = machineName === undefined ? undefined : own(machineName)
  if (record.checkedOut === 'none') return t`No folder has ${target} checked out, so only the branch moved.`
  if (record.checkedOut === 'worktree') return machine ? t`${parentTitle} works on ${target} in its worktree on ${machine} and sees them now.` : t`${parentTitle} works on ${target} in its worktree and sees them now.`
  return machine ? t`${parentTitle} works on ${target} in the project folder on ${machine} and sees them now.` : t`${parentTitle} works on ${target} in the project folder and sees them now.`
}
/**
 * The words for a record a host wrote. Sotto's own sentences are messages; a host's own sentence (`message`, for a busy
 * folder, an ignored file or Git refusing) and Git's words (`gitSaid`) stay as the host wrote them, in English, until host
 * protocol carries a code for them (ADR-0123).
 */
export function outcomeWords(record: BringBack, title: string, machine?: string): OutcomeWords {
  const target = ltr(record.target), branch = ltr(record.branch), parentTitle = own(title)
  if (record.status === 'done') {
    if (record.how === 'nothing') return { tone: 'ok', title: t`Nothing to bring back.`, body: t`${target} already has every commit on ${branch}.`, openParent: false, commit: false }
    const seen = seenSentence(record, title, machine), commits = commitCount(record.commits ?? 0), head = short(record.head)
    if (record.how === 'merge-commit') {
      const subject = own(record.subject ?? `Merge branch '${record.branch}' into ${record.target}`)
      return { tone: 'ok', title: t`Brought ${commits} to ${target} with a merge commit.`,
        body: `${t`Merge commit ${head} on ${target}: “${subject}”.`} ${seen}`, openParent: record.checkedOut !== 'none', commit: false }
    }
    return { tone: 'ok', title: t`Brought ${commits} to ${target}.`, body: `${t`Git fast-forwarded ${target} to ${head}; nothing else changed.`} ${seen}`, openParent: record.checkedOut !== 'none', commit: false }
  }
  const nothing = t`Nothing was brought to ${target}.`
  const unchanged = t`Nothing was brought to ${target}, and ${target} is unchanged.`
  const gitSaid = record.gitSaid ? ` ${t`Git said:`}` : ''
  switch (record.refusal) {
    case 'uncommitted': {
      const files = fileCount(record.files ?? 1)
      return { tone: 'error', title: nothing, body: t`${branch} has uncommitted changes in ${files}, and Sotto won’t bring back uncommitted work. Commit them first, then try again.`, openParent: false, commit: true }
    }
    case 'target-uncommitted': {
      if (record.files === undefined) {
        return { tone: 'error', title: nothing, openParent: true, commit: false, body: record.checkedOut === 'worktree'
          ? t`${target} is checked out in the worktree where ${parentTitle} works, where a merge or rebase is in progress, so Sotto didn’t touch it. Finish it there, then try again.`
          : t`${target} is checked out in the project folder, where a merge or rebase is in progress, so Sotto didn’t touch it. Finish it there, then try again.` }
      }
      const files = fileCount(record.files)
      return { tone: 'error', title: nothing, openParent: true, commit: false, body: record.checkedOut === 'worktree'
        ? t`${target} is checked out in the worktree where ${parentTitle} works, which has uncommitted changes in ${files}, so Sotto didn’t touch it. Commit or set them aside in ${parentTitle}, then try again.`
        : t`${target} is checked out in the project folder, which has uncommitted changes in ${files}, so Sotto didn’t touch it. Commit or set them aside in ${parentTitle}, then try again.` }
    }
    case 'conflict': return { tone: 'error', title: unchanged, body: `${t`Git found a conflict, and Sotto doesn’t resolve conflicts. Ask this thread to merge ${target} into its branch and resolve it, then try again.`}${gitSaid}`, gitSaid: record.gitSaid, openParent: false, commit: false }
    case 'moved': return { tone: 'error', title: nothing, body: t`${target} or ${branch} moved since Sotto looked, so nothing changed. Press Bring changes to ${target} again.`, gitSaid: record.gitSaid, openParent: false, commit: false }
    case 'detached': return { tone: 'error', title: nothing, body: t`This worktree isn’t on ${branch} any more. Switch it back to its branch, then try again.`, openParent: false, commit: false }
    case 'parent-moved': return { tone: 'error', title: nothing, body: t`${parentTitle} isn’t on ${target} any more, and Sotto doesn’t switch branches. Switch it back to ${target} there, then try again.`, openParent: true, commit: false }
    case 'snapshot': return { tone: 'error', title: nothing, body: t`${branch} starts from a check’s snapshot of uncommitted changes, and Sotto won’t bring that back as a commit. Ask this thread to put its own commits on a branch made from ${target}, then try again.`, openParent: false, commit: false }
    case 'ignored': return { tone: 'error', title: nothing, body: record.message ?? t`The folder where ${target} is checked out has an ignored file these commits would replace, so Sotto didn’t touch it. Move it aside, then try again.`, openParent: true, commit: false }
    case 'gone': return { tone: 'error', title: t`Nothing was brought back.`, body: t`Git has no branch named ${target} any more.`, openParent: false, commit: false }
    case 'busy': {
      const body = record.message ?? t`Something else is using one of the folders. Try again in a moment.`
      // Another thread's work holds the folder: a hold, worded as the Git action's is, in the host's words with that thread (#1866).
      // An older host names no thread, and a Git action or Sotto holding the folder names none; those keep these words.
      if (record.heldBy !== undefined) return { tone: 'held', title: shownWords(ON_HOLD), body, openParent: false, commit: false }
      return { tone: 'error', title: nothing, body, openParent: false, commit: false }
    }
    default: return { tone: 'error', title: unchanged, body: `${record.message ?? t`Git refused.`}${gitSaid}`, gitSaid: record.gitSaid, openParent: false, commit: false }
  }
}
