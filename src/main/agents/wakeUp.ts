import { z } from 'zod'
import { babysitStarterSchema } from '../../shared/babysitting'
import { printable, type BabysitChange, type BabysitNews, type BabysitRemarkNews } from './babysitNews'

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

const url = z.string().max(2_048)
const line = z.string().max(500)
const changeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checks-failed'), checks: z.array(z.object({ name: line, status: z.enum(['failure', 'cancelled', 'action-required']), url: url.nullable() })).max(200) }),
  z.object({ kind: z.literal('checks-passed'), count: z.number().int().nonnegative(), required: z.boolean() }),
  z.object({ kind: z.literal('remarks'), remarks: z.array(z.object({ kind: z.enum(['comment', 'review', 'review-comment']), author: line.nullable(),
    review: z.enum(['approved', 'changes-requested', 'commented', 'dismissed']).nullable(), path: line.nullable(), url: url.nullable(), edited: z.boolean() })).max(1_200) }),
  z.object({ kind: z.literal('conflicting'), base: line }),
])
/**
 * The news a waiting wake-up holds, as the follow-up queue keeps it, so news that comes later folds into the same
 * message and a stop can take back the news of the pull request it ended (decision 8).
 */
export const babysitNewsSchema = z.object({
  pullRequest: z.object({ url, number: z.number().int().positive(), title: line.nullable() }),
  startedBy: babysitStarterSchema,
  head: z.string().max(100).nullable(),
  changes: z.array(changeSchema).max(8),
  ended: z.enum(['merged', 'closed', 'comment-limit', 'unreadable']).nullable(),
})

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
function pullRequestPart(news: BabysitNews, options: WakeUpOptions): string {
  const title = news.pullRequest.title === null ? '' : ` "${printable(news.pullRequest.title, 500)}"`
  const lines = news.changes.flatMap(changeLines)
  const shown = lines.slice(0, WAKE_UP_LINES_MAX).map(item => `- ${item}`)
  if (lines.length > shown.length) shown.push(`- And ${lines.length - shown.length} more; read the pull request with gh for the rest.`)
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
      `Sotto keeps babysitting ${going.length === 1 && ended.length === 0 ? 'it' : going.length === 1 ? `#${going[0]!.pullRequest.number}` : 'the others'} and will wake you again when it needs you, so you do not need to poll GitHub or wait.`,
      options.tool
        ? `When you no longer need it, and before you hand the work back to the user, call ${STOP_BABYSITTING_TOOL}.`
        : 'The user can stop it from the Pull request surface.',
    ] : [],
  ]
  return [opening, ...news.map(item => pullRequestPart(item, options)), closing.join(' ')].join('\n\n')
}
