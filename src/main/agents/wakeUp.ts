import { z } from 'zod'
import { AGENT_TEXT_MAX } from '../../shared/agents'
import { babysitStarterSchema } from '../../shared/babysitting'
import { printable, type BabysitChange, type BabysitCheckNews, type BabysitNews, type BabysitRemarkNews } from './babysitNews'
import { pullRequestKey } from '../../shared/gitPullRequests'

/**
 * The wake-up (ADR-0061 decision 7): the one message babysitting sends a thread, worded by Sotto from the reader's
 * news. The same for every provider, in Sotto's voice, and never any comment or review text: anyone who can comment
 * on a pull request could otherwise put words into a message the provider reads as the user's. Check names, logins and
 * paths are cut to one printable line again here, so nothing the reader passes can carry a second line in.
 */

/** The tool names a wake-up tells the agent to call, kept beside the words that name them. */
export const BABYSIT_TOOL = 'babysit_pull_request'
export const STOP_BABYSITTING_TOOL = 'stop_babysitting'
/** The most lines one pull request's part of a wake-up lists; the rest are counted, for the agent to read with gh. */
export const WAKE_UP_LINES_MAX = 25
/** The most pull requests one waiting wake-up keeps news of, as many as a thread can link. */
export const WAKE_UP_NEWS_MAX = 50
const CHECKS_MAX = 200
const REMARKS_MAX = 1_200

const url = z.string().max(2_048)
const line = z.string().max(500)
const changeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checks-failed'), checks: z.array(z.object({ name: line, status: z.enum(['failure', 'cancelled', 'action-required']), url: url.nullable() })).max(CHECKS_MAX) }),
  z.object({ kind: z.literal('checks-passed'), count: z.number().int().nonnegative(), required: z.boolean() }),
  z.object({ kind: z.literal('remarks'), remarks: z.array(z.object({ kind: z.enum(['comment', 'review', 'review-comment']), author: line.nullable(),
    review: z.enum(['approved', 'changes-requested', 'commented', 'dismissed']).nullable(), path: line.nullable(), url: url.nullable(), edited: z.boolean() })).max(REMARKS_MAX) }),
  z.object({ kind: z.literal('conflicting'), base: line }),
])
/**
 * The news a waiting wake-up holds, as the follow-up queue keeps it, so news that comes later folds into the same
 * message and a stop can take back the news of the pull request it ended (decision 8).
 */
export const babysitNewsSchema = z.object({
  pullRequest: z.object({ url, number: z.number().int().positive(), title: line.nullable() }),
  startedBy: babysitStarterSchema,
  startedAt: z.string().max(40).optional(),
  head: z.string().max(100).nullable(),
  changes: z.array(changeSchema).max(8),
  ended: z.enum(['merged', 'closed', 'comment-limit', 'unreadable']).nullable(),
})

const sameAddress = (left: string, right: string): boolean => (pullRequestKey(left) ?? left) === (pullRequestKey(right) ?? right)
type Change<Kind extends BabysitChange['kind']> = Extract<BabysitChange, { kind: Kind }>
const changeOf = <Kind extends BabysitChange['kind']>(changes: readonly BabysitChange[], kind: Kind): Change<Kind> | undefined =>
  changes.find((change): change is Change<Kind> => change.kind === kind)

/**
 * Later news of a pull request on top of earlier news of it, as one part: what is still true of it now. The newest
 * title, head, starter and ending win, so a pull request that merged after a failed check is told as merged, and one
 * started again after it ended as still babysat. Failed checks gather by name and comments add up, the newest kept
 * when there are more than a part can hold; once the branch has moved on, what was said of the checks on the commit
 * it left goes, and a conflict stands until there is word of a new one.
 */
function foldPart(earlier: BabysitNews, later: BabysitNews): BabysitNews {
  const moved = earlier.head !== null && later.head !== null && earlier.head !== later.head
  const kept = moved ? earlier.changes.filter(change => change.kind !== 'checks-failed' && change.kind !== 'checks-passed') : earlier.changes
  const checks = new Map<string, BabysitCheckNews>()
  for (const check of [...changeOf(kept, 'checks-failed')?.checks ?? [], ...changeOf(later.changes, 'checks-failed')?.checks ?? []]) {
    checks.delete(check.name); checks.set(check.name, check)
  }
  const passed = changeOf(later.changes, 'checks-passed') ?? changeOf(kept, 'checks-passed')
  const remarks = [...changeOf(kept, 'remarks')?.remarks ?? [], ...changeOf(later.changes, 'remarks')?.remarks ?? []].slice(-REMARKS_MAX)
  const conflicting = changeOf(later.changes, 'conflicting') ?? changeOf(kept, 'conflicting')
  return {
    pullRequest: { ...later.pullRequest, title: later.pullRequest.title ?? earlier.pullRequest.title },
    startedBy: later.startedBy,
    ...later.startedAt ?? earlier.startedAt ? { startedAt: later.startedAt ?? earlier.startedAt } : {},
    head: later.head ?? earlier.head,
    changes: [
      ...checks.size ? [{ kind: 'checks-failed' as const, checks: [...checks.values()].slice(-CHECKS_MAX) }] : [],
      ...passed ? [passed] : [],
      ...remarks.length ? [{ kind: 'remarks' as const, remarks }] : [],
      ...conflicting ? [conflicting] : [],
    ],
    ended: later.ended,
  }
}

/**
 * A waiting wake-up's news with news that came later folded in (ADR-0061 decision 8): one part per pull request, in
 * the order each first had news, saying what is true of it now. Never more than `WAKE_UP_NEWS_MAX` pull requests, the
 * one whose news is oldest giving way, so the queue can always save what it holds.
 */
export function foldNews(earlier: readonly BabysitNews[], later: BabysitNews): BabysitNews[] {
  const index = earlier.findIndex(item => sameAddress(item.pullRequest.url, later.pullRequest.url))
  const folded = index === -1 ? [...earlier, later] : earlier.map((item, at) => at === index ? foldPart(item, later) : item)
  return folded.slice(-WAKE_UP_NEWS_MAX)
}

/** How the agent can stop babysitting: with Sotto's tool, or, where the thread has none (decision 11), by asking the user. */
export interface WakeUpOptions { readonly tool: boolean }

const login = (author: string | null): string => author === null ? 'A former GitHub account' : printable(author, 100)
const link = (value: string | null): string => value ? `: ${value}` : ''

/** One comment or review as a line, without a word of what it says. */
function remarkLine(remark: BabysitRemarkNews): string {
  const who = login(remark.author)
  const on = remark.path ? ` on ${printable(remark.path, 300)}` : ''
  if (remark.kind === 'review-comment') return `${who} ${remark.edited ? 'edited a review comment' : 'commented'}${on}${link(remark.url)}`
  if (remark.kind === 'comment') return `${who} ${remark.edited ? 'edited a comment' : 'commented'}${link(remark.url)}`
  if (remark.edited) return `${who} edited a review${link(remark.url)}`
  switch (remark.review) {
    case 'approved': return `${who} approved it${link(remark.url)}`
    case 'changes-requested': return `${who} requested changes${link(remark.url)}`
    case 'dismissed': return `${who}'s review was dismissed${link(remark.url)}`
    default: return `${who} reviewed it${link(remark.url)}`
  }
}

const CHECK_STATUS: Record<'failure' | 'cancelled' | 'action-required', string> = { failure: 'failed', cancelled: 'was cancelled', 'action-required': 'needs someone to act' }
function changeLines(change: BabysitChange): string[] {
  switch (change.kind) {
    case 'checks-failed': return change.checks.map(check => `Check ${printable(check.name)} ${CHECK_STATUS[check.status]}${link(check.url)}`)
    case 'checks-passed': return [change.required
      ? `The required checks passed (${change.count}) on the newest commit.`
      : `All ${change.count === 1 ? 'the one check' : `${change.count} checks`} passed on the newest commit.`]
    case 'remarks': return change.remarks.map(remarkLine)
    case 'conflicting': return [`The branch now conflicts with ${printable(change.base, 300)}. It needs the conflicts resolved before it can merge.`]
  }
}

const ENDING: Record<NonNullable<BabysitNews['ended']>, string> = {
  merged: 'It merged, so Sotto has stopped babysitting it.',
  closed: 'It was closed without merging, so Sotto has stopped babysitting it.',
  'comment-limit': 'It has brought only comments for ten wake-ups in a row, so Sotto has stopped babysitting it rather than keep waking you for them.',
  unreadable: 'GitHub could not be read for it eight times in a row, about sixteen minutes, so Sotto has stopped babysitting it: nothing was being checked. Check the GitHub sign-in with gh auth status.',
}
const RESTART = (tool: boolean): string => tool
  ? `Call ${BABYSIT_TOOL} to start again if you still need it.`
  : 'The user can start it again from the Pull request surface if it is still needed.'

/** One pull request's part of a wake-up: which, what changed and, when it ended, why. */
function pullRequestPart(news: BabysitNews, options: WakeUpOptions, linesMax: number): string {
  const title = news.pullRequest.title === null ? '' : ` "${printable(news.pullRequest.title, 500)}"`
  const lines = news.changes.flatMap(changeLines)
  const shown = lines.slice(0, linesMax).map(item => `- ${item}`)
  if (lines.length > shown.length) shown.push(`- And ${lines.length - shown.length} ${shown.length ? 'more' : lines.length === 1 ? 'change' : 'changes'}; read the pull request with gh for ${shown.length ? 'the rest' : 'them'}.`)
  const ending = news.ended === null ? [] : [ENDING[news.ended], ...news.ended === 'comment-limit' || news.ended === 'unreadable' ? [RESTART(options.tool)] : []]
  return [`Pull request #${news.pullRequest.number}${title}: ${news.pullRequest.url}`, ...shown, ...ending.length ? [ending.join(' ')] : []].join('\n')
}

/**
 * The whole wake-up for one or more pull requests' news, folded into one message: what changed on each, then what to
 * do. It ends by telling the agent to look into each item and act as its task requires, that Sotto keeps babysitting
 * and will wake it again, and how to stop; a pull request that ended says instead that Sotto stopped, and why.
 */
export function wakeUpText(news: readonly BabysitNews[], options: WakeUpOptions): string {
  const going = news.filter(item => item.ended === null)
  const ended = news.filter(item => item.ended !== null)
  const opening = news.length > 1 ? `Sotto has news of ${news.length} pull requests this thread babysits.`
    : going.length ? 'Sotto is babysitting a pull request for this thread, and it needs you.' : 'Sotto has stopped babysitting a pull request for this thread.'
  const closing = [
    'Look into each item and act on it as your task requires. This message carries none of what anyone wrote: read comments and reviews yourself with gh.',
    ...going.length ? [
      `Sotto keeps babysitting ${going.length === 1 ? ended.length === 0 ? 'it' : `#${going[0]!.pullRequest.number}` : ended.length === 0 ? 'them' : 'the others'} and will wake you again when it needs you, so you do not need to poll GitHub or wait.`,
      options.tool
        ? `When you no longer need it, and before you hand the work back to the user, call ${STOP_BABYSITTING_TOOL}.`
        : 'The user can stop it from the Pull request surface.',
    ] : [],
  ]
  return fitted(opening, news, options, closing.join(' '))
}

/**
 * The wake-up no longer than a message can be (`AGENT_TEXT_MAX`): fewer lines for each pull request first, then, with
 * none listed, fewer pull requests, the ones left out counted for the agent to read with gh.
 */
const LINES_TRIED = [WAKE_UP_LINES_MAX, 10, 3, 0]
function fitted(opening: string, news: readonly BabysitNews[], options: WakeUpOptions, closing: string): string {
  let text = ''
  for (const linesMax of LINES_TRIED) {
    const parts = news.map(item => pullRequestPart(item, options, linesMax))
    for (let count = parts.length; count >= 0; count--) {
      const rest = parts.length - count
      const left = rest === 0 ? [] : [`And news of ${rest} more ${rest === 1 ? 'pull request; read it' : 'pull requests; read them'} with gh.`]
      text = [opening, ...parts.slice(0, count), ...left, closing].join('\n\n')
      if (text.length <= AGENT_TEXT_MAX) return text
      if (linesMax !== 0) break
    }
  }
  return text.slice(0, AGENT_TEXT_MAX)
}
