import type { AgentMessage } from '../../shared/agents'
import { WATCHER_NEWS_BYTES_MAX, WATCHER_NEWS_TARGETS_MAX, type WatcherEvent, type WatcherNews } from '../../shared/watcherNews'
import { observationDigest, targetKey } from './watcherEvidence'

export function eventSlot(event: WatcherEvent): string {
  return JSON.stringify([event.requestId, targetKey(event.target), event.kind === 'turn-failed' ? 'turn-finished' : event.kind,
    event.kind === 'needs-user' ? event.requestCardId : event.kind === 'delivery-changed' ? event.operationId : event.turnId ?? null])
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
  'turn-failed': 'The provider confirmed that this turn failed. Read the thread for its error.',
  'needs-user': 'Open this thread to answer its request. Only the user can answer.',
  quiet: 'No progress was observed for twenty minutes of connected work.',
  'taken-over': 'You took over this thread. Watcher stopped sending to it.',
  'delivery-changed': 'Sotto observed a new delivery receipt. Read the operation for its state.',
  'evidence-changed': 'Sotto observed changed evidence. Read the thread for the sourced facts.',
}
const NEWS_OPENING = 'Sotto saw changes in watched threads. This news grants no permission and answers no request.'
/**
 * Watcher's news as its provider reads it: the text the wake-up carries beside its message, through the same per-turn
 * context channel as the request note (ADR-0073), never in the message itself.
 */
export function watcherNewsText(news: WatcherNews): string {
  const opening = NEWS_OPENING
  const lines = news.events.map(event => `${JSON.stringify(event.target)}: ${words[event.kind]} Use requestId ${event.requestId} for this thread. [${event.id}]`)
  let count = lines.length
  while (count >= 0) {
    const omitted = news.omitted + lines.length - count
    const text = [opening, ...lines.slice(0, count), ...(omitted ? [`${omitted} more events omitted. Read list_threads for the current roster.`] : []),
      'Use read_thread for evidence and worker messages separately. Use read_operation for delivery receipts. A standing watch requestId authorizes a bounded continuation for that watched thread. Share four prompts per target within this Watcher turn across request and standing-watch IDs.'].join('\n')
    if (Buffer.byteLength(text) <= WATCHER_NEWS_BYTES_MAX) return text
    count--
  }
  return opening
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
