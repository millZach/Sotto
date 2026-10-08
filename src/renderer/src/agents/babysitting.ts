import type { AgentClientHost, AgentThread } from '../../../shared/agents'
import type { AgentBabysitEnded, AgentBabysitting, BabysitEndedReason } from '../../../shared/babysitting'
import { GITHUB_PULL_REQUEST_URL } from '../../../shared/gitPullRequests'

/**
 * What the window says about babysitting (ADR-0061, variant C): the Pull request surface's line, the sidebar row's
 * state word, the creature's pose above the composer, and a wake-up in the thread and in its follow-up queue. Every
 * claim here is read from what the thread's host published, never from a message's text.
 */

/** One pull request's address as one key, so a link and a record of the same pull request match whatever their case. */
export function pullRequestKeyOf(url: string): string | null {
  const match = GITHUB_PULL_REQUEST_URL.exec(url)
  return match ? `${match[1]}/${match[2]}#${Number(match[3])}`.toLowerCase() : null
}
const samePullRequest = (left: string, right: string): boolean => {
  const key = pullRequestKeyOf(left)
  return key !== null && key === pullRequestKeyOf(right)
}

/** What the thread babysits of this pull request, if anything. */
export function babysittingOf(thread: Pick<AgentThread, 'babysitting'>, url: string): AgentBabysitting | undefined {
  return thread.babysitting?.find(item => samePullRequest(item.url, url))
}
/** Why babysitting this pull request last ended on its own, if it did and has not started again. */
export function babysitEndedOf(thread: Pick<AgentThread, 'babysitting' | 'babysitEnded'>, url: string): AgentBabysitEnded | undefined {
  return babysittingOf(thread, url) ? undefined : thread.babysitEnded?.find(item => samePullRequest(item.url, url))
}

/**
 * Whether the user may start babysitting on this thread's host: this computer, or a paired host that lists the
 * `pull-request-babysit` feature, which the desktop marks on the host's `clientHosts` entry (ADR-0061 decision 11). A
 * window shown no host list is this computer's own.
 */
export function offersBabysitting(clientHosts: readonly Pick<AgentClientHost, 'hostId' | 'pullRequestBabysit'>[] | undefined,
  thread: Pick<AgentThread, 'hostId' | 'remoteHost'>): boolean {
  const host = clientHosts?.find(item => item.hostId === thread.hostId)
  return host ? host.pullRequestBabysit === true : thread.remoteHost !== true
}

/** Pull request numbers as a reader says them: "#74", "#74 and #76", "#74, #76 and #78". */
export function pullRequestNumbers(numbers: readonly number[]): string {
  const named = numbers.map(number => `#${number}`)
  return named.length <= 1 ? named.join('') : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
}

/** The sidebar row's state word for a thread that babysits, where it would say Done: "Babysitting #74". */
export function babysittingWord(thread: Pick<AgentThread, 'babysitting'>): string | undefined {
  const numbers = (thread.babysitting ?? []).map(item => item.number)
  if (numbers.length === 0) return undefined
  return numbers.length > 2 ? `Babysitting ${numbers.length} pull requests` : `Babysitting ${pullRequestNumbers(numbers)}`
}

const time = (at: Date): string => at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLocaleLowerCase()
const day = (at: Date): string => at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
/** A moment as "2:02 pm" today, or "Oct 7, 2:02 pm" before; empty when it cannot be read. */
export function babysitClock(iso: string, now = new Date()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toDateString() === now.toDateString() ? time(at) : `${day(at)}, ${time(at)}`
}
/** "at 4:05 pm" today, or "on Oct 7 at 4:05 pm" before; empty when it cannot be read. */
function babysitAt(iso: string, now: Date): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return at.toDateString() === now.toDateString() ? `at ${time(at)}` : `on ${day(at)} at ${time(at)}`
}

/** Why babysitting ended, as the surface says it. */
export function endedWords(ended: Pick<AgentBabysitEnded, 'number' | 'reason' | 'endedAt'>, now = new Date()): string {
  const at = babysitAt(ended.endedAt, now)
  const when = at ? ` ${at}` : ''
  const words: Record<BabysitEndedReason, string> = {
    merged: `Ended when #${ended.number} merged${when}.`,
    closed: `Ended when #${ended.number} was closed${when}.`,
    'comment-limit': `Ended${when}, after ten wake-ups in a row brought only comments.`,
    unreadable: `Ended${when}. Sotto could not read #${ended.number} from GitHub for about 16 minutes.`,
    'switched-off': `Ended${when}, when Let agents babysit pull requests was turned off in Settings.`,
  }
  return words[ended.reason]
}

/**
 * The line docked under the merge checklist, above Merge (variant C): while it babysits, since when, who started it and
 * what Sotto does, with Stop; once it ended on its own, that it did and why. Null when there is nothing to say.
 */
export type BabysitLine =
  | { readonly kind: 'babysitting'; readonly title: string; readonly detail: string; readonly stop: string }
  | { readonly kind: 'ended'; readonly title: string; readonly detail: string }
  | null
export function babysitLine(options: {
  readonly thread: Pick<AgentThread, 'babysitting' | 'babysitEnded'>
  readonly pullRequest: { readonly url: string; readonly number: number; readonly state: 'open' | 'closed' | 'merged' }
  /** The thread's provider, as the transcript names it, who started it when the agent did. */
  readonly agent: string
  /** Babysit pull request is in the ··· menu, so the ended line can say where to start again. */
  readonly offered: boolean
  readonly now?: Date
}): BabysitLine {
  const { thread, pullRequest, agent, offered, now = new Date() } = options
  const current = babysittingOf(thread, pullRequest.url)
  if (current) {
    const since = babysitClock(current.startedAt, now)
    return { kind: 'babysitting', title: since ? `Babysitting since ${since}` : 'Babysitting',
      detail: `${current.startedBy === 'user' ? 'Started by you' : `Started by ${agent}`}. Sotto sends this thread a wake-up when #${pullRequest.number} needs it.`,
      stop: `Stop babysitting #${pullRequest.number}` }
  }
  const ended = babysitEndedOf(thread, pullRequest.url)
  if (!ended) return null
  const words = endedWords(ended, now)
  return pullRequest.state === 'open'
    ? { kind: 'ended', title: 'Not babysitting', detail: offered ? `${words} Babysit pull request is in the ··· menu.` : words }
    : { kind: 'ended', title: 'Babysitting ended', detail: words }
}
