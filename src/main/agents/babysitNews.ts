import { z } from 'zod'
import { agentBabysittingSchema, type BabysitStarter } from '../../shared/babysitting'
import { REMARKS_READ_MAX, type BabysitCheck, type BabysitRemark, type PullRequestFingerprint } from './githubBabysitReads'

/**
 * What babysitting finds (ADR-0061 decision 6): the news in a read of a pull request, against what one thread was last
 * told. Pure: the reader reads, this compares, and the reader records the result only once the news is handed over.
 */

/** Wake-ups in a row that bring only comments before babysitting ends, so a chatty bot cannot loop an agent (decision 9). */
export const COMMENT_ONLY_LIMIT = 10
/** Passes in a row that fail to read the pull request, rate limits not counted, before babysitting ends (decision 9). */
export const FAILED_READ_LIMIT = 8

const LIST_MAX = 200
/**
 * What a thread was last told about one pull request (decision 10), kept on the thread's record in the host's
 * `workspace.json`. Remarks are told up to `remarksThrough`, GitHub's time of the newest one reported (its edit, or
 * when it went out), with the IDs reported at that very second, since GitHub's times are whole seconds; an edit moves a
 * remark past it, so an edited one is news again. It starts at the time babysitting started. The IDs are kept up to as
 * many as one detail read can return, since a review's comments on code all go out in the second it is submitted: keep
 * fewer and a read that sees them all again tells the ones dropped a second time.
 */
export const babysitToldSchema = z.object({
  /** The head commit the checks below are about; null before the first read. */
  head: z.string().max(100).nullable(),
  /** The checks reported failed on that head, by name. */
  failedChecks: z.array(z.string().max(500)).max(LIST_MAX),
  /** Whether the required checks passing was reported on that head. */
  passed: z.boolean(),
  remarksThrough: z.string().max(64),
  remarkIds: z.array(z.string().max(200)).max(REMARKS_READ_MAX),
  /** Whether the branch conflicting was reported, and it has not stopped conflicting since. */
  conflicting: z.boolean(),
  /** Wake-ups in a row that brought only comments. */
  commentOnly: z.number().int().nonnegative(),
  /** Passes in a row that failed to read the pull request, rate limits not counted. */
  failedReads: z.number().int().nonnegative(),
}).strict()
export type BabysitTold = z.infer<typeof babysitToldSchema>
/** A pull request a thread babysits, as the host keeps it: what clients see, and what the thread was last told. */
export const babysitRecordSchema = agentBabysittingSchema.extend({ told: babysitToldSchema }).strict()
export type BabysitRecord = z.infer<typeof babysitRecordSchema>

/**
 * Nothing told yet. Remarks count from the start's whole second, because GitHub dates them to the second: a remark
 * made in the second babysitting started is told rather than lost, even one made a moment before it.
 */
export const toldAtStart = (startedAt: string): BabysitTold =>
  ({ head: null, failedChecks: [], passed: false, remarksThrough: wholeSecond(startedAt), remarkIds: [], conflicting: false, commentOnly: 0, failedReads: 0 })
const wholeSecond = (time: string): string => { const at = Date.parse(time); return Number.isFinite(at) ? new Date(Math.floor(at / 1000) * 1000).toISOString() : time }

/** A check that finished failed, was cancelled or needs someone: news as soon as it is, so a check that never finishes cannot hold it back. */
export type BabysitCheckNews = Pick<BabysitCheck, 'name' | 'url'> & { readonly status: 'failure' | 'cancelled' | 'action-required' }
/** A comment or review by someone other than the gh sign-in, without what it says (decision 7). */
export type BabysitRemarkNews = Omit<BabysitRemark, 'id' | 'createdAt' | 'editedAt'> & { readonly edited: boolean }
/** One change worth a wake-up (decision 6). */
export type BabysitChange =
  | { readonly kind: 'checks-failed'; readonly checks: readonly BabysitCheckNews[] }
  /** The required checks passed, or every check where none is required. */
  | { readonly kind: 'checks-passed'; readonly count: number; readonly required: boolean }
  | { readonly kind: 'remarks'; readonly remarks: readonly BabysitRemarkNews[] }
  /** The branch began to conflict with its base. */
  | { readonly kind: 'conflicting'; readonly base: string }
/** Why babysitting ended on its own, which the last wake-up says (decision 9). */
export type BabysitEnding = 'merged' | 'closed' | 'comment-limit' | 'unreadable'

/**
 * What one thread is to be woken with about one pull request: structured, never worded. #824 words the wake-up from it.
 * Names, logins and paths are cut to a short line of printable characters; links are GitHub's, https only.
 */
export interface BabysitNews {
  /** The title is null when GitHub could not be read. */
  readonly pullRequest: { readonly url: string; readonly number: number; readonly title: string | null }
  /** Who started babysitting it, so the wake-up can say how to stop. */
  readonly startedBy: BabysitStarter
  /** The head commit the news is about, when it was read. */
  readonly head: string | null
  readonly changes: readonly BabysitChange[]
  /** Set when this wake-up ends babysitting, with why; null when babysitting goes on. */
  readonly ended: BabysitEnding | null
}

/** A line of printable characters at most `max` long: a name or login cannot carry a second line into a wake-up. */
export function printable(text: string, max = 200): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is taken out.
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const isFailed = (check: BabysitCheck): check is BabysitCheck & { status: BabysitCheckNews['status'] } =>
  check.status === 'failure' || check.status === 'cancelled' || check.status === 'action-required'
const isPassed = (check: BabysitCheck): boolean => check.status === 'success' || check.status === 'skipped' || check.status === 'neutral'

/** What one read of a pull request saw: the fingerprint always; the checks and remarks only when they were read this pass. */
export interface BabysitReading {
  readonly fingerprint: PullRequestFingerprint
  readonly head: string | null
  readonly checks: readonly BabysitCheck[] | null
  readonly remarks: readonly BabysitRemark[] | null
  /** The gh sign-in's login on the host: its own remarks are the user's and the agent's, and wake nobody. */
  readonly viewer: string | null
}
export interface BabysitFinding {
  readonly changes: readonly BabysitChange[]
  /** What to record once the news is handed over, or at once when there is none. */
  readonly told: BabysitTold
  /** Ten comment-only wake-ups in a row: this one says babysitting stopped. */
  readonly exhausted: boolean
}

/**
 * The news in a read against what the thread was last told. Checks are news once per head commit: each failure once,
 * and the gate passing once, the gate being the required checks or every check where none is required. A new head
 * starts both again and is not news on its own. A remark is news when someone other than the gh sign-in wrote or edited
 * it after the last one told. A conflict is news once, and again only after it stopped conflicting; GitHub's "unknown"
 * while it computes after a push keeps what was known. News of checks or a conflict resets the comment-only count.
 */
export function findNews(told: BabysitTold, reading: BabysitReading): BabysitFinding {
  const changes: BabysitChange[] = []
  const head = reading.head ?? reading.fingerprint.head
  const moved = head !== told.head
  let failedChecks = moved ? [] : told.failedChecks
  let passed = moved ? false : told.passed
  if (reading.checks) {
    const failed = reading.checks.filter(isFailed).filter(check => !failedChecks.includes(check.name))
    if (failed.length) changes.push({ kind: 'checks-failed', checks: failed.map(check => ({ name: printable(check.name), status: check.status, url: check.url })) })
    failedChecks = [...failedChecks, ...failed.map(check => check.name)].slice(-LIST_MAX)
    const required = reading.checks.filter(check => check.required)
    const gate = required.length ? required : reading.checks
    if (!passed && gate.length > 0 && gate.every(isPassed)) {
      changes.push({ kind: 'checks-passed', count: gate.length, required: required.length > 0 })
      passed = true
    }
  }

  let remarksThrough = told.remarksThrough, remarkIds = told.remarkIds
  if (reading.remarks) {
    const own = reading.viewer?.toLowerCase() ?? null
    const through = Date.parse(told.remarksThrough)
    const at = (remark: BabysitRemark): number => Date.parse(remark.editedAt ?? remark.createdAt)
    const fresh = reading.remarks.filter(remark => {
      const time = at(remark)
      if (!Number.isFinite(time)) return false
      if (time < through || (time === through && told.remarkIds.includes(remark.id))) return false
      return own === null || remark.author?.toLowerCase() !== own
    }).sort((left, right) => at(left) - at(right))
    if (fresh.length) {
      changes.push({ kind: 'remarks', remarks: fresh.map(remark => ({ kind: remark.kind, author: remark.author === null ? null : printable(remark.author, 100),
        review: remark.review, path: remark.path === null ? null : printable(remark.path, 300), url: remark.url, edited: remark.editedAt !== null })) })
      const latest = at(fresh.at(-1)!)
      const atLatest = fresh.filter(remark => at(remark) === latest).map(remark => remark.id)
      remarksThrough = new Date(latest).toISOString()
      remarkIds = (latest === through ? [...told.remarkIds, ...atLatest] : atLatest).slice(-REMARKS_READ_MAX)
    }
  }

  const mergeable = reading.fingerprint.mergeable
  if (mergeable === 'conflicting' && !told.conflicting) changes.push({ kind: 'conflicting', base: printable(reading.fingerprint.base, 300) })
  const conflicting = mergeable === 'unknown' ? told.conflicting : mergeable === 'conflicting'

  const commentsOnly = changes.length > 0 && changes.every(change => change.kind === 'remarks')
  const progress = changes.some(change => change.kind !== 'remarks')
  const commentOnly = progress ? 0 : told.commentOnly + (commentsOnly ? 1 : 0)
  return {
    changes,
    told: { head, failedChecks, passed, remarksThrough, remarkIds, conflicting, commentOnly, failedReads: 0 },
    exhausted: commentsOnly && commentOnly >= COMMENT_ONLY_LIMIT,
  }
}
