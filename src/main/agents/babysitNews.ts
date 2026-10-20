import { z } from 'zod'
import { agentBabysittingSchema, type AgentBabysitting, type BabysitStarter } from '../../shared/babysitting'
import { REMARKS_READ_MAX, type BabysitCheck, type BabysitRemark, type PullRequestFingerprint } from './githubBabysitReads'
import { pullRequestKey } from '../../shared/gitPullRequests'

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
  /** The checks failing on that head when it was last read, by name, each told once while it stays failing. */
  failedChecks: z.array(z.string().max(500)).max(LIST_MAX),
  /** Whether the required checks were passing when last read, which was told as they began to. */
  passed: z.boolean(),
  /** The checks that pass was of, so a required check that appears passed later is told; absent from records kept before. */
  passedGate: z.array(z.string().max(500)).max(LIST_MAX).optional(),
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
/** The part of a record clients are sent (decision 10): which pull request, who started it and since when, never what the thread was told. */
export const publishedBabysitting = (record: BabysitRecord): AgentBabysitting =>
  ({ url: record.url, number: record.number, startedBy: record.startedBy, startedAt: record.startedAt })

/**
 * Nothing told yet. Remarks count from the start's whole second, because GitHub dates them to the second: a remark
 * made in the second babysitting started is told rather than lost, even one made a moment before it.
 */
export const toldAtStart = (startedAt: string): BabysitTold =>
  ({ head: null, failedChecks: [], passed: false, passedGate: [], remarksThrough: wholeSecond(startedAt), remarkIds: [], conflicting: false, commentOnly: 0, failedReads: 0 })
const wholeSecond = (time: string): string => { const at = Date.parse(time); return Number.isFinite(at) ? new Date(Math.floor(at / 1000) * 1000).toISOString() : time }

/** A check that finished failed, was cancelled or needs someone: news as soon as it is, so a check that never finishes cannot hold it back. */
export type BabysitCheckNews = Pick<BabysitCheck, 'name' | 'url'> & { readonly status: 'failure' | 'cancelled' | 'action-required' }
/** A comment or review by someone other than the gh sign-in, without what it says (decision 7). */
export type BabysitRemarkNews = Omit<BabysitRemark, 'id' | 'createdAt' | 'editedAt' | 'bot'> & { readonly edited: boolean }
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
 * What GitHub kept answering when babysitting ended unreadable: the sign-in refused, the pull request not shown, no
 * answer in time (taken and then hung or dropped), or an answer that made no sense.
 */
export type BabysitUnreadable = 'sign-in' | 'not-found' | 'no-answer' | 'answer'

/**
 * What one thread is to be woken with about one pull request: structured, never worded. #824 words the wake-up from it.
 * Names, logins and paths are cut to a short line of printable characters; links are GitHub's, https only.
 */
export interface BabysitNews {
  /** The title is null when GitHub could not be read. */
  readonly pullRequest: { readonly url: string; readonly number: number; readonly title: string | null }
  /** Who started babysitting it, so the wake-up can say how to stop. */
  readonly startedBy: BabysitStarter
  /**
   * When the babysitting it is news of started, so a wake-up about to go can tell that babysitting from one started
   * again since. Absent from news queued before it was kept.
   */
  readonly startedAt?: string | undefined
  /** The head commit the news is about, when it was read. */
  readonly head: string | null
  readonly changes: readonly BabysitChange[]
  /** Set when this wake-up ends babysitting, with why; null when babysitting goes on. */
  readonly ended: BabysitEnding | null
  /** For an unreadable ending, what GitHub kept answering; absent from news queued before it was kept. */
  readonly unreadable?: BabysitUnreadable | undefined
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
  /** The checks the base branch's rules require by name, read with the checks; null when GitHub did not say. */
  readonly requiredChecks?: readonly string[] | null
  /** False when GitHub had more checks or rules than one read returns: failures are told, a pass is not. */
  readonly checksComplete?: boolean
  readonly remarks: readonly BabysitRemark[] | null
  /** The remarks that are a bot's notice that it could not run: told as read, and news to nobody. */
  readonly notices?: ReadonlySet<string>
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
 * The checks that must pass, as GitHub decides it can merge: each the rules require, which holds while GitHub has no
 * check of it yet (a job waiting on others), and any other GitHub flags required; where neither, every check. A rule is
 * met only by a check of its name that GitHub also flags required, so another app's check of the same name cannot pass
 * it. Each is named by its context in every case, so a gate read without the rules and then with them is one gate.
 */
export function gateOf(checks: readonly BabysitCheck[], ruled: readonly string[]): { readonly names: readonly string[]; readonly required: boolean; readonly passed: boolean } {
  const flagged = checks.filter(check => check.required && !ruled.includes(check.context))
  if (!ruled.length && !flagged.length) return { names: [...new Set(checks.map(check => check.context))], required: false, passed: checks.length > 0 && checks.every(isPassed) }
  const ruledPassed = ruled.every(context => { const named = checks.filter(check => check.context === context && check.required); return named.length > 0 && named.every(isPassed) })
  return { names: [...new Set([...ruled, ...flagged.map(check => check.context)])], required: true, passed: ruledPassed && flagged.every(isPassed) }
}

/**
 * The news in a read against what the thread was last told. A check is news as it begins to fail, and again if it
 * fails again after running once more; the gate is news as it begins to pass, and again after a rerun or a failure
 * took it back, or when a required check appears already passed. The gate is the checks the base branch's rules
 * require, those GitHub flags required, or every check where none is (`gateOf`). A new head starts both again and is
 * not news on its own. A remark is news when someone other than the gh sign-in wrote or edited it after the last one
 * told, unless it is a bot's notice that it could not run, which is told as read. A conflict is news once, and again
 * only after it stopped conflicting; GitHub's "unknown" while it computes after a push keeps what was known. News of
 * checks or a conflict resets the comment-only count.
 */
export function findNews(told: BabysitTold, reading: BabysitReading): BabysitFinding {
  const changes: BabysitChange[] = []
  const head = reading.head ?? reading.fingerprint.head
  const moved = head !== told.head
  let failedChecks = moved ? [] : told.failedChecks
  let passed = moved ? false : told.passed
  let passedGate = moved ? [] : told.passedGate ?? []
  if (reading.checks) {
    const failing = reading.checks.filter(isFailed)
    // A check running again leaves the list, so a rerun that fails again is told (T3's rule).
    const failed = failing.filter(check => !failedChecks.includes(check.name))
    if (failed.length) changes.push({ kind: 'checks-failed', checks: failed.map(check => ({ name: printable(check.name), status: check.status, url: check.url })) })
    failedChecks = [...new Set(failing.map(check => check.name))].slice(-LIST_MAX)
    const whole = gateOf(reading.checks, reading.requiredChecks ?? [])
    // Past what one read returns, a check left out may be one the gate needs.
    const gate = reading.checksComplete === false ? { ...whole, passed: false } : whole
    // A record kept before the gate's names were takes the gate as it is now, so it does not tell the pass again.
    const toldGate = passed && passedGate.length === 0 ? gate.names : passedGate
    const grew = gate.required && gate.names.some(name => !toldGate.includes(name))
    if (gate.passed && (!passed || grew)) changes.push({ kind: 'checks-passed', count: gate.names.length, required: gate.required })
    passed = gate.passed
    passedGate = gate.passed ? [...gate.names].slice(-LIST_MAX) : []
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
    const news = fresh.filter(remark => !reading.notices?.has(remark.id))
    if (news.length) {
      changes.push({ kind: 'remarks', remarks: news.map(remark => ({ kind: remark.kind, author: remark.author === null ? null : printable(remark.author, 100),
        review: remark.review, path: remark.path === null ? null : printable(remark.path, 300), url: remark.url, edited: remark.editedAt !== null })) })
    }
    if (fresh.length) {
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
    told: { head, failedChecks, passed, passedGate, remarksThrough, remarkIds, conflicting, commentOnly, failedReads: 0 },
    exhausted: commentsOnly && commentOnly >= COMMENT_ONLY_LIMIT,
  }
}

/**
 * A bot's notice that it could not review: it hit a usage or rate limit, its trial ended, its credits ran out, or the
 * change is too large for it (ADR-0061 decision 7). Each notice opens on what happened to the bot's own run, so each
 * phrase is matched where the words begin, never later in them: a review that says code misbehaves "once the rate limit
 * is exceeded" or "when the user's trial has ended" is still news. Only words as short as such notices count: Cursor's
 * Bugbot and Greptile's were a few sentences, a real review is longer.
 */
const NOTICE_MARKER = /<!--\s*BUGBOT_TOO_LARGE_TO_REVIEW\s*-->/u
/** Up to three words before the phrase: the bot's name, or a heading such as "[!WARNING]". */
const LEAD = String.raw`^(?:\S+\s+){0,3}`
const NOTICE_WORDS = [
  // Cursor's Bugbot: "Bugbot couldn't run - usage limit reached".
  new RegExp(`${LEAD}(?:couldn['’]?t|could not|cannot|can['’]t|was unable to|is unable to) (?:run|review)\\b\\W{0,5}(?:\\S+\\s+){0,3}(?:limit|quota)s? (?:was |has been )?(?:reached|hit|exceeded)\\b`, 'iu'),
  // A heading that says so: "Rate limit exceeded", "Usage limit reached".
  new RegExp(`${LEAD}(?:usage|spend|spending|billing|rate) limits? (?:was |has been )?(?:reached|hit|exceeded)\\b`, 'iu'),
  // Greptile: "Your trial has ended", "Your organization has used all 50 credits included in the free plan".
  /^your (?:free )?trial (?:has )?(?:ended|expired)\b/iu,
  /^your (?:organization|organisation|account|team|workspace) (?:has |have )?(?:used (?:all|up)|run out of|exhausted)\b.{0,40}\bcredits\b/iu,
  // Cursor's Bugbot: "This PR is too large for Bugbot to review".
  /^this (?:pr|pull request|change) is too large (?:for \S+ )?to review\b/iu,
]
const NOTICE_MAX = 2_000
export function couldNotRunNotice(words: string): boolean {
  // Quote and heading marks lead the lines of a notice laid out as a warning box; they are not words.
  const text = words.replace(/<!--[\s\S]*?-->/gu, ' ').replace(/<[^>]*>/gu, ' ').replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^[\s>#*_-]+/gmu, '').replace(/\s+/gu, ' ').trim()
  if (text.length > NOTICE_MAX) return false
  return NOTICE_MARKER.test(words) || (text.length > 0 && NOTICE_WORDS.some(pattern => pattern.test(text)))
}

/**
 * A waiting wake-up's news as it stands, given the head the thread's record was last read on: what it says of the
 * checks on a commit the branch has left goes, since the next read tells the new head's (decision 8). With nothing
 * left, the part goes with it. An ending always stands.
 */
export function stillCurrent(news: BabysitNews, head: string | null): BabysitNews | undefined {
  if (news.ended !== null || head === null || news.head === null || news.head === head) return news
  const changes = news.changes.filter(change => change.kind !== 'checks-failed' && change.kind !== 'checks-passed')
  if (changes.length === news.changes.length) return news
  return changes.length ? { ...news, changes } : undefined
}

/**
 * Whether a part of a wake-up may still go as it goes (ADR-0061 decisions 9 and 12). An agent's news never goes once the
 * switch is off, a last one included, since the switch ends what agents started and sends nothing. Otherwise a last
 * wake-up for an ending goes, and other news only while the babysitting it is of still stands: the same pull request,
 * starter and start.
 */
export function wakeUpPartDue(news: BabysitNews, standing: readonly AgentBabysitting[], agentToolOn: boolean): boolean {
  if (news.startedBy === 'agent' && !agentToolOn) return false
  if (news.ended !== null) return true
  const key = pullRequestKey(news.pullRequest.url)
  return standing.some(item => pullRequestKey(item.url) === key && item.startedBy === news.startedBy
    && (news.startedAt === undefined || item.startedAt === news.startedAt))
}
