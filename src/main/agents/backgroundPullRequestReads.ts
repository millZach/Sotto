import { homedir } from 'node:os'
import { z } from 'zod'
import { isRateLimitAnswer, isSignInRefusal, isUnreachableAnswer, refusalReading, type GitHubRateLimit, type GitHubRateLimitReading } from './github'
import { pullRequestObservation, type DetailAnswer, type PullRequestFingerprint } from './githubBabysitReads'
import { gateOf } from './babysitNews'
import type { RunGitCommand } from './gitStatus'
import type { PullRequestObservation } from './watcherEvidence'

/**
 * What every background read of a pull request shares, whoever it reads for: babysitting's (ADR-0061) and, with Restart
 * stopped threads on, Watcher's (ADR-0144). How gh is asked and its answer told apart, when checks are read again, and
 * what one read tells Watcher. Electron-free, as both readers run on the desktop and on a headless host.
 */

/** How often a pass runs (ADR-0061 decision 13). */
export const PULL_REQUEST_PASS_MS = 2 * 60_000
/** How long a pull request with review threads goes before its remarks are read anyway, and refused checks are asked again (decision 13). */
export const REMARKS_REREAD_MS = 30 * 60_000
/**
 * Refused checks are asked for again next pass, and after this many refusals in a row only when the status moves or
 * every REMARKS_REREAD_MS: a sign-in that may never read a pull request's checks, such as a fine-grained token without
 * checks access, would otherwise cost a checks read every pass for as long as the pull request is read.
 */
export const REFUSED_CHECKS_BEFORE_BACK_OFF = 3
/** Sotto links pull requests from github.com only (ADR-0027), so that is the host every read asks. */
export const PULL_REQUEST_HOST = 'github.com'
const READ_TIMEOUT_MS = 30_000

/** A read GitHub answered with a failure, by what it answered: the sign-in refused, or anything else. */
export type FailedRead = 'failed-sign-in' | 'failed-no-answer' | 'failed'
export const isFailedRead = (answer: unknown): answer is FailedRead => answer === 'failed-sign-in' || answer === 'failed-no-answer' || answer === 'failed'
/** GitHub took the request and then hung or dropped it: no answer, which counts, as a GitHub that keeps hanging should end it. */
const NO_ANSWER = /did not finish in time|context deadline exceeded|unexpected EOF|: EOF\b|connection reset|forcibly closed|\bi\/o timeout\b/iu
const failureOf = (message: string): FailedRead => isSignInRefusal(message) ? 'failed-sign-in' : NO_ANSWER.test(message) ? 'failed-no-answer' : 'failed'

/** What gh printed before it failed, read as an answer when it is one; null otherwise. */
function partialAnswer<T>(error: unknown, read: (text: string) => T): T | null {
  const stdout = error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : ''
  if (!stdout.trim()) return null
  try { return read(stdout) } catch { return null }
}

/** How a reader asks gh: its command, the process's one rate limit, and what it does when GitHub pauses it or is out of reach. */
export interface PullRequestAsker {
  readonly run: RunGitCommand
  readonly rateLimit: GitHubRateLimit
  readonly limited: () => void
  readonly unreachable: () => void
}

/**
 * gh's answer, or what it was: a rate-limit refusal pauses the host and is `limited`, gh not reaching GitHub at all is
 * `unreachable` and skips the pass, and anything else is a failed read of the kind GitHub's answer says.
 * Only gh's own error is read for the rate limit: an answer that failed to parse names its fields, `rateLimit` among
 * them. GitHub can answer a query and refuse a part of it, one pull request it cannot find among 25 say; gh then fails
 * with what it did read on its output, and that answer stands, so one pull request gone does not fail the rest.
 */
export async function askPullRequests<T extends { readonly rateLimit?: GitHubRateLimitReading | null | undefined }>(asker: PullRequestAsker, args: readonly string[],
  read: (text: string) => T, viewer?: (answer: T) => string | null): Promise<T | 'limited' | 'unreachable' | FailedRead> {
  const asked = asker.rateLimit.asking()
  let answer: T
  try { answer = read(await asker.run(homedir(), 'gh', ['api', 'graphql', ...args], { timeoutMs: READ_TIMEOUT_MS })) }
  catch (error) {
    const message = error instanceof Error && !(error instanceof z.ZodError) && !(error instanceof SyntaxError) ? error.message : ''
    if (isRateLimitAnswer(message)) {
      asker.rateLimit.limited(PULL_REQUEST_HOST, message, refusalReading(error))
      asker.limited()
      return 'limited'
    }
    if (isUnreachableAnswer(message)) { asker.unreachable(); return 'unreachable' }
    const partial = partialAnswer(error, read)
    if (!partial) return failureOf(message)
    answer = partial
  }
  asker.rateLimit.answered(PULL_REQUEST_HOST, asked, answer.rateLimit, viewer?.(answer) ?? null)
  return answer
}

/** What the last read of a pull request's checks left: the status they were read against, and the refusals' back-off. */
export interface ChecksRead {
  /** The fingerprint's status its checks were read against; empty when the checks still need reading. */
  readonly status: string
  /** Checks reads in a row GitHub refused, and when refused checks are next asked for once they are backed off. */
  readonly refusedChecks: number
  readonly checksDueAt: number | null
}

/**
 * Whether this pass reads the checks: on a first look, when the status moved, while a check is still running, and once
 * refused checks are due again. A running check is read every pass, except while refused checks are backed off: then a
 * status move or the half-hourly retry reads them, so a check that runs for hours behind a refusal costs no more than a finished one.
 */
export function checksDue(last: ChecksRead | undefined, firstLook: boolean, fingerprint: PullRequestFingerprint, now: number): boolean {
  if (firstLook || !last) return true
  const backedOff = last.refusedChecks >= REFUSED_CHECKS_BEFORE_BACK_OFF
  return last.status !== fingerprint.status || (fingerprint.checksRunning && !backedOff) || (last.checksDueAt !== null && now >= last.checksDueAt)
}

/**
 * What a pass leaves of the checks. Checks asked for and not read (a check refused, or the head moved under the read) are
 * asked again next pass, and once refused REFUSED_CHECKS_BEFORE_BACK_OFF times in a row, when the status moves or every REMARKS_REREAD_MS.
 */
export function checksAfter(last: ChecksRead | undefined, asked: boolean, detail: DetailAnswer | null, fingerprint: PullRequestFingerprint, now: number): ChecksRead {
  const read = asked ? detail?.checks != null : true
  const refusedChecks = !asked ? last?.refusedChecks ?? 0 : read ? 0 : (last?.refusedChecks ?? 0) + 1
  const backOff = !read && refusedChecks >= REFUSED_CHECKS_BEFORE_BACK_OFF
  return {
    status: read || backOff ? fingerprint.status : '',
    refusedChecks,
    checksDueAt: !asked ? last?.checksDueAt ?? null : backOff ? now + REMARKS_REREAD_MS : null,
  }
}

/**
 * What one read of an open pull request tells Watcher (#1190): its state, conflict, remarks fingerprint and checks, and
 * whether the checks the base branch requires passed, from the same gate babysitting tells a thread by.
 */
export function openPullRequestObservation(fingerprint: PullRequestFingerprint, detail: DetailAnswer | null, now: number,
  previous: PullRequestObservation | undefined, checksAsked: boolean): PullRequestObservation {
  const required = detail?.checks && detail.head === fingerprint.head && fingerprint.head !== null
    ? { requiredPassed: detail.checksComplete !== false && gateOf(detail.checks, detail.requiredChecks ?? []).passed } : {}
  return { ...pullRequestObservation(fingerprint, detail, new Date(now).toISOString(), previous, checksAsked), ...required }
}
