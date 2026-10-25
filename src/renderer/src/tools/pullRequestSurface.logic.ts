import { plural, t } from '@lingui/core/macro'
import { shownCount } from '../state/interfaceNumbers'
import { GIT_PULL_REQUEST_MERGE_METHOD_LABELS, type GitPullRequestAction, type GitPullRequestCheck, type GitPullRequestDetail, type GitPullRequestLinkSource, type GitPullRequestMergeMethod } from '../../../shared/gitPullRequests'

type Detail = Pick<GitPullRequestDetail, 'state' | 'draft' | 'checks' | 'checksUnknown' | 'reviewDecision' | 'reviews' | 'mergeable' | 'behindBy' | 'canUpdateBranch' | 'baseBranch' | 'url'>

/**
 * How a line of the merge checklist stands: done, failed (something must change), running (GitHub is still
 * working it out), to do (a step someone has to take), unknown (GitHub could not say, which does not hold the
 * merge back, since nothing here could fix it), or open (something worth seeing that GitHub does not require,
 * such as a request for changes where the repository asks for no review, which does not hold it back either).
 */
export type LineTone = 'done' | 'failed' | 'running' | 'todo' | 'unknown' | 'open'
/** The one press that fixes a line: a link to the failing check or the review on GitHub, or the step itself. */
export type LineFix =
  | { readonly kind: 'open-check'; readonly name: string; readonly url: string }
  | { readonly kind: 'open-review'; readonly author: string | null; readonly url: string }
  | { readonly kind: 'update-branch' }
  | { readonly kind: 'ready' }
export interface ChecklistLine {
  readonly id: 'checks' | 'review' | 'up-to-date' | 'conflicts' | 'ready'
  readonly label: string
  readonly tone: LineTone
  /** Why the line stands as it does, in a short sentence. */
  readonly why: string
  readonly fix: LineFix | null
}

const FAILED: ReadonlySet<GitPullRequestCheck['status']> = new Set(['failure', 'cancelled'])
function checksLine(checks: readonly GitPullRequestCheck[], unknown: boolean): ChecklistLine {
  const line = { id: 'checks', label: t`Checks passing` } as const
  // Refused checks are not no checks: the line says they could not be read, and is not counted as done.
  if (unknown && checks.length === 0) return { ...line, tone: 'unknown', why: t`GitHub did not let Sotto read the checks`, fix: null }
  if (checks.length === 0) return { ...line, label: t`No checks`, tone: 'done', why: t`GitHub reports none for this pull request`, fix: null }
  const failed = checks.filter(check => FAILED.has(check.status))
  const first = failed[0]
  if (first) {
    const name = first.name, more = failed.length - 1, description = first.description
    const why = first.status === 'cancelled'
      ? more > 0 ? plural(more, { other: `${name} was cancelled, and # more` }) : description ? t`${name} was cancelled: ${description}` : t`${name} was cancelled`
      : more > 0 ? plural(more, { other: `${name} failed, and # more` }) : description ? t`${name} failed: ${description}` : t`${name} failed`
    return { ...line, tone: 'failed', why, fix: first.url ? { kind: 'open-check', name: first.name, url: first.url } : null }
  }
  const waiting = checks.find(check => check.status === 'action-required')
  if (waiting) {
    const name = waiting.name
    return { ...line, tone: 'todo', why: t`${name} is waiting for approval on GitHub`, fix: waiting.url ? { kind: 'open-check', name: waiting.name, url: waiting.url } : null }
  }
  const running = checks.filter(check => check.status === 'pending')
  if (running.length > 0) {
    const name = running[0]!.name, more = running.length - 1
    return { ...line, tone: 'running', why: more === 0 ? t`${name} is still running` : plural(more, { other: `${name} and # more are still running` }), fix: null }
  }
  // Some checks read, some refused: what the read checks hold back is said above; with nothing held back, the line is unknown, not done.
  if (unknown) return { ...line, tone: 'unknown', why: t`GitHub did not let Sotto read every check`, fix: null }
  const passed = checks.filter(check => check.status === 'success').length
  const skipped = checks.length - passed, total = checks.length, name = checks[0]!.name
  const why = passed < checks.length ? t`${passed} passed, ${skipped} skipped` : checks.length === 1 ? t`${name} passed` : t`All ${total} passed`
  return { ...line, tone: 'done', why, fix: null }
}

function reviewLine(detail: Detail): ChecklistLine {
  const line = { id: 'review', label: t`Review approved` } as const
  // GitHub lists the reviews oldest first (the connection's own order), so the later of two is the one that stands.
  const latest = (state: 'approved' | 'changes_requested') => [...detail.reviews].reverse().find(review => review.state === state)
  const approved = latest('approved'), changes = latest('changes_requested')
  const approver = approved?.author ?? '', author = changes?.author ?? ''
  const askedForChanges = (): ChecklistLine => ({ ...line, tone: 'failed', why: changes ? t`${author} asked for changes` : t`Changes were asked for`,
    fix: { kind: 'open-review', author: changes?.author ?? null, url: changes?.url ?? detail.url } })
  switch (detail.reviewDecision) {
    case 'approved': return { ...line, tone: 'done', why: approved ? t`Approved by ${approver}` : t({ message: 'Approved', comment: 'A pull request\'s review approved it.' }), fix: null }
    case 'changes_requested': return askedForChanges()
    case 'review_required': return { ...line, tone: 'todo', fix: null,
      why: detail.draft ? t`Reviewers wait until it is ready` : detail.reviews.length === 0 ? t`Nobody has reviewed it yet` : t`It still needs an approving review` }
    default: {
      // The repository requires no review, so GitHub merges whatever the reviews say. A request for changes a reviewer
      // has not taken back is still said, with its review a press away, in whatever order it came; it does not hold
      // the merge back, since GitHub does not.
      if (changes) {
        const others = detail.reviews.filter(review => review.state === 'changes_requested').length - 1
        // With nobody approving, the label claims no approval: it is read before the reason, as "Does not block: Review".
        return { ...line, label: approved ? line.label : t({ message: 'Review', comment: 'A line of the merge checklist: the pull request\'s review.' }), tone: 'open', fix: { kind: 'open-review', author: changes.author, url: changes.url ?? detail.url },
          why: approved
            ? others > 0 ? plural(others, { other: `Approved by ${approver}. Requests for changes from ${author} and # more are still open` }) : t`Approved by ${approver}. ${author}'s request for changes is still open`
            : others > 0 ? plural(others, { other: `${author} and # more asked for changes. This repository does not require a review` }) : t`${author} asked for changes. This repository does not require a review` }
      }
      return approved ? { ...line, tone: 'done', why: t`Approved by ${approver}`, fix: null }
        : { ...line, label: t`No review required`, tone: 'done', why: t`This repository merges without one`, fix: null }
    }
  }
}

function upToDateLine(detail: Detail): ChecklistLine {
  const base = detail.baseBranch
  const line = { id: 'up-to-date', label: t({ message: `Up to date with ${base}`, comment: '{base} is a Git branch name, as in main.' }) } as const
  if (detail.state === 'merged') return { ...line, tone: 'done', why: t`Merged into ${base}`, fix: null }
  if (detail.behindBy === null) return { ...line, tone: 'unknown', why: t`GitHub could not compare it with ${base}`, fix: null }
  if (detail.behindBy === 0) return { ...line, tone: 'done', why: t`Has every commit on ${base}`, fix: null }
  // The count in the interface language, and in English as it always read: a plural's own # would group its digits.
  const behindBy = detail.behindBy, commits = shownCount(behindBy)
  const behind = plural(behindBy, { one: `${commits} commit behind ${base}`, other: `${commits} commits behind ${base}` })
  if (detail.state !== 'open') return { ...line, tone: 'todo', why: behind, fix: null }
  return detail.canUpdateBranch ? { ...line, tone: 'todo', why: behind, fix: { kind: 'update-branch' } }
    : { ...line, tone: 'todo', why: plural(behindBy, { one: `${commits} commit behind ${base}. GitHub does not let this account update it`, other: `${commits} commits behind ${base}. GitHub does not let this account update it` }), fix: null }
}

function conflictsLine(detail: Detail): ChecklistLine {
  const base = detail.baseBranch
  const line = { id: 'conflicts', label: t`No conflicts` } as const
  if (detail.state === 'merged') return { ...line, tone: 'done', why: t`Merged without conflicts`, fix: null }
  if (detail.mergeable === 'conflicting') return { ...line, tone: 'failed', why: t`Conflicts with ${base}. Resolve them in the branch and push`, fix: null }
  if (detail.mergeable === 'mergeable') return { ...line, tone: 'done', why: t`Merges cleanly into ${base}`, fix: null }
  return detail.state === 'open' ? { ...line, tone: 'running', why: t`GitHub is still checking. Refresh in a moment`, fix: null }
    : { ...line, tone: 'unknown', why: t`GitHub checks again if it is reopened`, fix: null }
}

function readyLine(detail: Detail): ChecklistLine {
  const line = { id: 'ready', label: t`Ready for review` } as const
  if (!detail.draft) return { ...line, tone: 'done', why: t`Not a draft`, fix: null }
  return { ...line, tone: 'todo', why: t`Still a draft`, fix: detail.state === 'open' ? { kind: 'ready' } : null }
}

/**
 * The merge checklist, the Pull request surface's whole reading of a pull request: five lines in the order a
 * merge meets them (checks, review, the base, conflicts, draft), each done or saying what holds it back, with the
 * one press that fixes it where there is one.
 */
export function checklist(detail: Detail): ChecklistLine[] {
  return [checksLine(detail.checks, detail.checksUnknown), reviewLine(detail), upToDateLine(detail), conflictsLine(detail), readyLine(detail)]
}
/** A line that holds the merge back. An unknown one does not: GitHub decides when the merge is pressed. */
export const holdsBack = (line: ChecklistLine): boolean => line.tone === 'failed' || line.tone === 'running' || line.tone === 'todo'

/** Merge is enabled only for an open pull request with no armed auto-merge, a method to merge with and no line holding it back. */
export function mergeReady(detail: Pick<GitPullRequestDetail, 'state' | 'autoMerge' | 'mergeMethods'>, lines: readonly ChecklistLine[]): boolean {
  return detail.state === 'open' && detail.autoMerge === null && detail.mergeMethods.length > 0 && !lines.some(holdsBack)
}
/** Merge when ready, GitHub's auto-merge: for an open pull request that is not a draft, where the repository allows it. */
export function canAutoMerge(detail: Pick<GitPullRequestDetail, 'state' | 'draft' | 'autoMerge' | 'autoMergeAllowed' | 'mergeMethods'>): boolean {
  return detail.state === 'open' && !detail.draft && detail.autoMerge === null && detail.autoMergeAllowed && detail.mergeMethods.length > 0
}
/** The checklist's heading: settled for a merged or closed pull request, else whether any line still holds the merge back. */
export function checklistHeading(detail: Pick<GitPullRequestDetail, 'state'>, clear: boolean): string {
  return detail.state !== 'open' ? t`Merge checklist` : clear ? t`Ready to merge` : t`Before merging`
}
/**
 * The count beside the heading, agreeing with it: the lines done, and any that are not done but do not hold the
 * merge back (a base GitHub could not compare), so "Ready to merge" never sits beside a count that seems to disagree.
 */
export function checklistCount(lines: readonly ChecklistLine[]): string {
  const done = lines.filter(line => line.tone === 'done').length
  const aside = lines.filter(line => line.tone !== 'done' && !holdsBack(line)).length
  const total = lines.length
  return aside > 0 ? plural(aside, { one: `${done} of ${total} done, # does not block`, other: `${done} of ${total} done, # do not block` }) : t`${done} of ${total} done`
}
export function linesLeft(lines: readonly ChecklistLine[]): string {
  const left = lines.filter(holdsBack).length
  return plural(left, { one: '# line left before this can merge.', other: '# lines left before this can merge.' })
}

/** T3's order for the method a merge uses: the one chosen last, when this repository allows it, then the first it allows. */
export function resolveMergeMethod(allowed: readonly GitPullRequestMergeMethod[], preferred: GitPullRequestMergeMethod | null): GitPullRequestMergeMethod {
  return preferred && allowed.includes(preferred) ? preferred : allowed[0] ?? 'merge'
}
export const mergeLabel = (method: GitPullRequestMergeMethod): string => GIT_PULL_REQUEST_MERGE_METHOD_LABELS[method]
/** The method's short name on the button beside Merge. */
export const MERGE_METHOD_SHORT: Readonly<Record<GitPullRequestMergeMethod, string>> = {
  get merge() { return t({ message: 'Merge commit', comment: 'A way to merge a pull request: with a merge commit.' }) },
  get squash() { return t({ message: 'Squash', comment: 'A way to merge a pull request: squashed into one commit.' }) },
  get rebase() { return t({ message: 'Rebase', comment: 'A way to merge a pull request: its commits rebased onto the base.' }) },
}
/** What the method leaves on the base branch, said under Merge and in the method menu. */
export function mergeEffect(method: GitPullRequestMergeMethod, base: string): string {
  return method === 'squash' ? t`One commit on ${base}` : method === 'rebase' ? t`Every commit, replayed onto ${base}` : t`Every commit, plus a merge commit`
}

export function stateLabel(detail: Pick<GitPullRequestDetail, 'state' | 'draft'>): string {
  if (detail.state === 'merged') return t({ message: 'Merged', comment: 'A pull request\'s state.' })
  if (detail.state === 'closed') return t({ message: 'Closed', comment: 'A pull request\'s state.' })
  return detail.draft ? t({ message: 'Draft', comment: 'A pull request\'s state.' }) : t({ message: 'Open', context: 'pull request state', comment: 'A pull request\'s state: open, not merged or closed.' })
}
export const LINK_SOURCE: Readonly<Record<GitPullRequestLinkSource, string>> = {
  get created() { return t`Created from this thread` },
  get linked() { return t`Linked by you` },
  get checkout() { return t`Checked out from the branch picker` },
}

/** When a pull request merged, as a time today or a date and time before; null when GitHub gave nothing readable. */
export function mergedWhen(iso: string | null, now = new Date()): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return at.toDateString() === now.toDateString() ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/**
 * A read GitHub's rate limit held back (#820): what happened, that nothing was lost, and when to ask again, in this
 * window's clock. `again` names how: the surface has a Refresh button, the Link and Checkout dialogs do not.
 */
export function limitedWords(retryAt: string, again: 'refresh' | 'try-again' = 'refresh', now = new Date()): string {
  const when = mergedWhen(retryAt, now)
  if (again === 'refresh') {
    return when ? t({ message: `GitHub is limiting requests from your gh sign-in until ${when}. Nothing was lost. Refresh after ${when}.`, comment: '{when} is a time, or a date and time.' })
      : t`GitHub is limiting requests from your gh sign-in. Nothing was lost. Refresh in a few minutes.`
  }
  return when ? t({ message: `GitHub is limiting requests from your gh sign-in until ${when}. Nothing was lost. Try again after ${when}.`, comment: '{when} is a time, or a date and time.' })
    : t`GitHub is limiting requests from your gh sign-in. Nothing was lost. Try again in a few minutes.`
}

/**
 * The presses that ask first, in T3's words: the merge, turning on auto-merge, closing, and Update with rebase,
 * which rewrites the branch's commits on GitHub so a local copy of it no longer matches.
 */
export type ConfirmedAction = Extract<GitPullRequestAction, 'merge' | 'enable-auto-merge' | 'close'> | 'update-with-rebase'
export function confirmationFor(action: ConfirmedAction, number: number, method: GitPullRequestMergeMethod, baseBranch?: string): { title: string; description: string; confirm: string; danger: boolean } {
  const label = mergeLabel(method)
  // The method's name inside a sentence, as GitHub's own label lower-cased ("squash and merge").
  const how = label.toLowerCase()
  const base = baseBranch
  switch (action) {
    case 'update-with-rebase': return { title: t`Update with rebase?`, description: base !== undefined
      ? t({ message: `This rebases the branch of #${number} onto ${base} on GitHub, rewriting its commits. A local copy of the branch will no longer match it: pull, or check it out again, before pushing to it.`, comment: '{number} is the pull request\'s number; {base} is a Git branch name.' })
      : t({ message: `This rebases the branch of #${number} onto its base on GitHub, rewriting its commits. A local copy of the branch will no longer match it: pull, or check it out again, before pushing to it.`, comment: '{number} is the pull request\'s number.' }), confirm: t`Update with rebase`, danger: false }
    case 'merge': return { title: t`Merge pull request?`, description: base !== undefined
      ? t({ message: `This merges #${number} into ${base} using ${how}.`, comment: '{base} is a Git branch name; {how} is the merge method, as in "squash and merge".' })
      : t({ message: `This merges #${number} into its base using ${how}.`, comment: '{how} is the merge method, as in "squash and merge".' }), confirm: label, danger: false }
    case 'enable-auto-merge': return { title: t`Enable auto-merge?`, description: t({ message: `This merges #${number} using ${how} as soon as GitHub considers it ready, which may be immediately.`, comment: '{how} is the merge method, as in "squash and merge".' }), confirm: t`Enable auto-merge`, danger: false }
    case 'close': return { title: t`Close pull request?`, description: t`This closes #${number} without merging it.`, confirm: t`Close pull request`, danger: true }
  }
}
