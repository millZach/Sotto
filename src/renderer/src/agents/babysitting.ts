import type { AgentClientHost, AgentFollowup, AgentMessage, AgentThread } from '../../../shared/agents'
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

/**
 * Why babysitting ended, as the surface says it. The time is when babysitting ended, which is when a pass noticed: a
 * merge or a close can be minutes before it, or hours when the computer slept, so the sentence never puts the time on
 * the merge, which GitHub's own card above it dates.
 */
export function endedWords(ended: Pick<AgentBabysitEnded, 'number' | 'reason' | 'endedAt'>, now = new Date()): string {
  const at = babysitAt(ended.endedAt, now)
  // "Ended at 3:07 pm, after …", or "Ended after …" when the time cannot be read.
  const lead = at ? `Ended ${at},` : 'Ended'
  const words: Record<BabysitEndedReason, string> = {
    merged: `${lead} after #${ended.number} merged.`,
    closed: `${lead} after #${ended.number} was closed.`,
    'comment-limit': `${lead} after ten wake-ups in a row brought only comments.`,
    unreadable: `${at ? `Ended ${at}` : 'Ended'}. Sotto could not read #${ended.number} from GitHub for about 16 minutes.`,
    'switched-off': `${lead} when Let agents babysit pull requests was turned off in Settings.`,
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
  /**
   * Babysit pull request is in the ··· menu, so the ended line can say where to start again. It names the menu as the
   * button's accessible name and title do, never by its glyph, which a screen reader reads as dots.
   */
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
    ? { kind: 'ended', title: 'Not babysitting', detail: offered ? `${words} Babysit pull request is under More pull request actions.` : words }
    : { kind: 'ended', title: 'Babysitting ended', detail: words }
}

/**
 * The pose's readout: the pull request's number and title over "Babysitting since 2:02 pm" (`since` is the time, empty
 * when it cannot be read), and every one by name on hover.
 */
export interface BabysitReadout { readonly label: string; readonly since: string; readonly title: string }
export function babysitReadout(thread: Pick<AgentThread, 'babysitting' | 'pullRequests' | 'worktree'>, now = new Date()): BabysitReadout | undefined {
  const babysat = thread.babysitting ?? []
  const first = babysat[0]
  if (!first) return undefined
  const known = [...thread.pullRequests ?? [], ...thread.worktree?.git?.pullRequest ? [thread.worktree.git.pullRequest] : []]
  const named = (item: AgentBabysitting): string => {
    const title = known.find(link => samePullRequest(link.url, item.url))?.title
    return title ? `#${item.number} ${title}` : `#${item.number}`
  }
  return {
    label: [named(first), ...babysat.slice(1).map(item => `#${item.number}`)].join(', '),
    since: babysitClock(first.startedAt, now),
    title: babysat.map(named).join('\n'),
  }
}

/** A message babysitting sent, told by the host's own mark (ADR-0061 decision 8), never by what it says. */
export const isWakeUpMessage = (message: Pick<AgentMessage, 'role' | 'wakeUp'>): boolean => message.role === 'user' && message.wakeUp === true
/** Who a short transcript says sent a message: Sotto for a wake-up, as the thread's own transcript does, else You or the agent. */
export const messageSpeaker = (message: Pick<AgentMessage, 'role' | 'wakeUp'>): 'Sotto' | 'You' | 'Agent' =>
  isWakeUpMessage(message) ? 'Sotto' : message.role === 'user' ? 'You' : 'Agent'
/** Sotto's wake-up waiting in the follow-up queue: removable, never editable, moved or steered. */
export const isWakeUpFollowup = (item: Pick<AgentFollowup, 'wakeUp'>): boolean => item.wakeUp === true

const URL_IN_TEXT = /https?:\/\/[^\s<>]+/gu
const MARKDOWN_PUNCTUATION = /[!-/:-@[-`{-~]/gu
/**
 * A wake-up's text as Markdown that draws it exactly as the provider received it: every punctuation mark escaped so
 * nothing in a check's name or a login becomes formatting, each line break kept, and each link a link.
 */
export function wakeUpMarkdown(text: string): string {
  return text.split('\n').map(line => {
    let out = '', from = 0
    for (const match of line.matchAll(URL_IN_TEXT)) {
      out += line.slice(from, match.index).replace(MARKDOWN_PUNCTUATION, '\\$&') + `<${match[0]}>`
      from = match.index + match[0].length
    }
    return out + line.slice(from).replace(MARKDOWN_PUNCTUATION, '\\$&')
  }).reduce((joined, line, index, lines) => index === 0 ? line
    // A line inside a paragraph keeps its break; a blank line still parts paragraphs.
    : joined + (lines[index - 1] !== '' && line !== '' ? '\\\n' : '\n') + line, '')
}
