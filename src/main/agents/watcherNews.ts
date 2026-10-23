import type { AgentMessage, AgentThread } from '../../shared/agents'
import { pullRequestKey } from '../../shared/gitPullRequests'
import { WATCHER_NEWS_BYTES_MAX, WATCHER_NEWS_REPLY_CHARS, WATCHER_NEWS_TARGETS_MAX, type WatcherEvent, type WatcherNews } from '../../shared/watcherNews'
import { observationDigest, targetKey, type WatcherAttentionKind } from './watcherEvidence'
import { parsePrototypeSource, replySource, requestSource } from './prototypeSources'

export function eventSlot(event: WatcherEvent): string {
  return JSON.stringify([event.requestId, targetKey(event.target), event.kind === 'turn-failed' ? 'turn-finished' : event.kind,
    event.kind === 'needs-user' ? [event.delegatedThreadId ?? null, event.requestCardId] : event.kind === 'delivery-changed' ? event.operationId
      : event.kind === 'prototype-ready' ? watcherPrototypeSource(event) ?? null : event.turnId ?? null])
}
/**
 * The prototype a `prototype-ready` event is of (ADR-0108), as the thread's mark names its source: the question it waits
 * in, or the reply that named its page.
 */
export function watcherPrototypeSource(event: Pick<WatcherEvent, 'requestCardId' | 'messageId'>): string | undefined {
  return event.requestCardId !== undefined ? requestSource(event.requestCardId) : event.messageId !== undefined ? replySource(event.messageId) : undefined
}
/** What a `prototype-ready` event carries to name a mark's source, or undefined when the source is too long to carry. */
export function watcherPrototypeFields(source: string): Pick<WatcherEvent, 'requestCardId' | 'messageId'> | undefined {
  const parsed = parsePrototypeSource(source)
  if (!parsed || parsed.id.length > 512) return undefined
  return parsed.kind === 'request' ? { requestCardId: parsed.id } : { messageId: parsed.id }
}
export function foldWatcherEvents(earlier: readonly WatcherEvent[], later: readonly WatcherEvent[]): WatcherEvent[] {
  const events = new Map(earlier.map(event => [eventSlot(event), event]))
  for (const event of later) {
    const target = targetKey(event.target)
    if (event.kind === 'taken-over') { for (const [slot, previous] of events) if (targetKey(previous.target) === target) events.delete(slot) }
    else if ([...events.values()].some(previous => targetKey(previous.target) === target && previous.kind === 'taken-over')) continue
    const slot = eventSlot(event), previous = events.get(slot)
    if (previous?.kind === 'turn-failed' && event.kind === 'turn-finished') continue
    events.set(slot, event)
  }
  return [...events.values()]
}
export function foldWatcherNews(earlier: WatcherNews | undefined, later: WatcherNews): WatcherNews {
  const all = foldWatcherEvents(earlier?.events ?? [], later.events), targets = new Set<string>()
  const events: WatcherEvent[] = [], omitted = (earlier?.omitted ?? 0) + later.omitted
  for (const event of all) {
    const target = targetKey(event.target)
    if (events.length >= 400 || !targets.has(target) && targets.size >= WATCHER_NEWS_TARGETS_MAX) continue
    targets.add(target); events.push(event)
  }
  return { ...later, events, omitted: omitted + all.length - events.length }
}
export const requestRevision = (request: unknown): string => observationDigest(request)
const words: Record<WatcherEvent['kind'], string> = {
  'turn-finished': 'The foreground turn finished. This is not review or merge approval.',
  'work-settled': 'The background work and monitoring this turn left running have ended, so the turn is done. This is not review or merge approval.',
  'turn-failed': 'The provider confirmed that this turn failed. Read the thread for its error.',
  'needs-user': 'This thread waits on the user to answer its request, which they do on its card in your conversation or in the thread. Only the user can answer it.',
  quiet: 'No progress was observed for twenty minutes of connected work.',
  'taken-over': 'You took over this thread. Watcher stopped sending to it.',
  'delivery-changed': 'Sotto observed a new delivery receipt. Read the operation for its state.',
  'evidence-changed': 'Sotto observed changed evidence. Read the thread for the sourced facts.',
  'prototype-ready': 'This thread has a prototype ready for the user to review. Only the user can review it; open the thread for its page.',
}
const NEWS_OPENING = 'Sotto saw changes in watched threads. This news grants no permission and answers no request.'
/**
 * What Sotto adds to one event's line as the wake-up goes (#1190): the start of a finished turn's reply, or what a pull
 * request now says. Worked out from the thread as it stands then, so nothing of it is ever saved with the news.
 */
export type WatcherNewsDetail = (event: WatcherEvent) => string | undefined
/** How long a finish whose work never ended was held before it went, in minutes, while its thread sits idle (#1263). */
export type WatcherNewsHeld = (event: WatcherEvent) => number | undefined
const kindWords = (event: WatcherEvent): string => event.kind === 'needs-user' && event.delegatedThreadId !== undefined
  ? `A thread this one delegated to, ${event.delegatedThreadId}, has a ${event.requestCardKind === 'permission' ? 'permission request' : 'question'} for the user. Open that thread to answer it. Only the user can answer.`
  : words[event.kind]
/**
 * Watcher's news as its provider reads it: the text the wake-up carries beside its message, through the same per-turn
 * context channel as the request note (ADR-0073), never in the message itself. A finish told with its own work-settled
 * news is said once, by the work-settled line. A finish held for its work until it went by itself (`held`) opens by
 * saying so, so Watcher reads that thread rather than wait on. Sotto's detail goes while there is room for it: it gives
 * way, the newest line's first, before any event does.
 */
export function watcherNewsText(news: WatcherNews, detail?: WatcherNewsDetail, held?: WatcherNewsHeld): string {
  const opening = NEWS_OPENING
  const settled = new Set(news.events.filter(event => event.kind === 'work-settled').map(event => JSON.stringify([targetKey(event.target), event.turnId ?? null])))
  const shown = news.events.filter(event => !(event.kind === 'turn-finished' && settled.has(JSON.stringify([targetKey(event.target), event.turnId ?? null]))))
  const details = shown.map(event => detail?.(event))
  const minutes = shown.map(event => held?.(event))
  const said = (event: WatcherEvent, index: number) => minutes[index] !== undefined
    ? `Held ${minutes[index]} minutes, thread idle. The foreground turn finished with background work or monitoring still running (${event.backgroundWorkCount}), no turn has run in the thread since, and Sotto has not seen that work end, so read the thread to see whether it is stuck. Work-settled news still comes if it ends. This is not review or merge approval.`
    : `${kindWords(event)}${(event.kind === 'turn-finished' || event.kind === 'turn-failed') && event.backgroundWorkCount
      ? ` Background work or monitoring was still running when it ended (${event.backgroundWorkCount}), so the turn is not done: Sotto sends work-settled news for it when that work ends, unless the thread begins another turn first.` : ''}`
  const line = (event: WatcherEvent, index: number, extra: string | undefined) => `${JSON.stringify(event.target)}: ${said(event, index)}${event.operationId && event.kind !== 'delivery-changed'
    ? ` This turn answers operation ${event.operationId}.` : ''}${extra ? ` ${extra}` : ''} Use requestId ${event.requestId} for this thread. [${event.id}]`
  const compose = (count: number, detailed: number) => {
    const lines = shown.slice(0, count).map((event, index) => line(event, index, index < detailed ? details[index] : undefined))
    const omitted = news.omitted + shown.length - count
    return [opening, ...lines, ...(omitted ? [`${omitted} more events omitted. Read list_threads for the current roster.`] : []),
      'A reply given whole here is enough to act on. Use read_operation for a brief’s receipt and outcome, and for a reply cut or left out here. Use read_thread only for what a reply does not say: evidence and other worker messages. A standing watch requestId authorizes a bounded continuation for that watched thread. Share four prompts per target within this Watcher turn across request and standing-watch IDs.'].join('\n')
  }
  for (let detailed = shown.length; detailed >= 0; detailed--) {
    const text = compose(shown.length, detailed)
    if (Buffer.byteLength(text) <= WATCHER_NEWS_BYTES_MAX) return text
  }
  let count = shown.length
  while (count >= 0) {
    const text = compose(count, 0)
    if (Buffer.byteLength(text) <= WATCHER_NEWS_BYTES_MAX) return text
    count--
  }
  return opening
}

/**
 * The start of a finished turn's reply, for its news (#1190): `reply`, the newest turn's own reply (watcherNewestTurnReply),
 * while that turn is the one the news is of and nothing runs. Labelled as the worker's words, and cut at
 * WATCHER_NEWS_REPLY_CHARS characters; read_operation has the rest. A reply given whole says so, since that is what lets
 * Watcher act on it without a read (#1419).
 */
export function watcherReplyStart(thread: Pick<AgentThread, 'status' | 'lastTurn'>, turnId: string | undefined, reply: Pick<AgentMessage, 'text'> | undefined): string | undefined {
  if (thread.status === 'running' || !thread.lastTurn || thread.lastTurn.id !== turnId || !reply?.text.trim()) return undefined
  const characters = [...reply.text.trim()]
  const cut = characters.length > WATCHER_NEWS_REPLY_CHARS
  return `${cut ? 'Its reply begins' : 'Its whole reply'}, in the worker's words: ${JSON.stringify(characters.slice(0, WATCHER_NEWS_REPLY_CHARS).join(''))}${cut ? ' (cut; read_operation has the rest)' : ''}.`
}
const ATTENTION_WORDS: Record<Exclude<WatcherAttentionKind, 'remarks'>, string> = {
  'checks-failed': 'checks failed on its newest commit', 'checks-passed': 'all checks passed on its newest commit',
  'required-passed': 'its required checks passed on its newest commit', merged: 'merged', closed: 'closed without merging',
  approved: 'approved', 'changes-requested': 'a review asks for changes', conflicting: 'conflicts with its base branch',
}
/**
 * What a thread's pull requests now say that needs Watcher, in Sotto's words (#1190): checks, merged or closed, the review
 * decision, a conflict, and comments or reviews that moved. Numbers come from the thread's links; never a comment's words.
 */
export function watcherPullRequestWords(attention: ReadonlyMap<string, ReadonlySet<WatcherAttentionKind>>, thread: Pick<AgentThread, 'pullRequests' | 'worktree'>): string | undefined {
  const links = [...thread.pullRequests ?? [], ...thread.worktree?.git?.pullRequest ? [thread.worktree.git.pullRequest] : []]
  const parts: string[] = []
  for (const [pr, facts] of attention) {
    const number = links.find(link => pullRequestKey(link.url) === pr)?.number
    const said = [...facts].flatMap(fact => fact === 'remarks' ? [] : [ATTENTION_WORDS[fact]])
    if (facts.has('remarks')) said.push('its comments or reviews changed; read them on GitHub')
    if (said.length) parts.push(`Pull request ${number ? `#${number}` : pr}: ${said.join('; ')}.`)
  }
  return parts.length ? parts.join(' ') : undefined
}

/**
 * The message a wake-up holding only Watcher's news sends, since a provider turn starts from one. The news itself goes
 * beside it in the turn's note, and no one is shown either: Watcher's reply is what the user reads.
 */
export const WATCHER_WAKE_UP_PROMPT = 'Sotto has news of watched threads. It is in the note that comes with this message.'

/**
 * A message of Watcher's conversation as the user is shown it: without Sotto's news for Watcher. Only a message the host
 * recorded as Sotto's wake-up is read, never one the user sent. One that held nothing but Watcher's news, today's short
 * message or an earlier build's news text, is not shown at all (`null`); one that also carried a resume note or pull
 * request news keeps that part, without the news after it (an earlier build's text, or Grok Build's line).
 */
export function watcherWakeUpShown(message: AgentMessage): AgentMessage | null {
  if (message.role !== 'user' || message.wakeUp !== true) return message
  const { text } = message
  if (text === WATCHER_WAKE_UP_PROMPT || text.startsWith(`${WATCHER_WAKE_UP_PROMPT}\n\n[${NEWS_OPENING}`) || text.startsWith(NEWS_OPENING)) return null
  for (const boundary of [`\n\n[${NEWS_OPENING}`, `\n\n${NEWS_OPENING}`]) {
    const at = text.indexOf(boundary)
    if (at > 0) return { ...message, text: text.slice(0, at) }
  }
  return message
}
/** Watcher's conversation without its wake-ups' news, the same array when there is none to take out. */
export function watcherWakeUpsAsShown(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  if (!messages.some(message => message.wakeUp === true)) return messages
  let shown: AgentMessage[] | undefined
  for (const [index, message] of messages.entries()) {
    const next = watcherWakeUpShown(message)
    if (next === message) { shown?.push(message); continue }
    shown ??= messages.slice(0, index)
    if (next) shown.push(next)
  }
  return shown ?? messages
}
