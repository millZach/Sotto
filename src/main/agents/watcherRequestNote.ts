import type { AgentHostSnapshot, AgentMessage, AgentThread } from '../../shared/agents'
import type { WatcherRequest } from '../../shared/watcher'

/**
 * Watcher's request note: the one thing a user Send to Watcher tells it besides what the user typed, namely the Watcher
 * request that message started and which host is this computer. It travels beside the user's message through the
 * provider's own context channel for that turn (`watcherRequestNote` on a send), never in the user's text, and names no
 * projects: Watcher calls list_projects when it needs one.
 */
export function watcherRequestNote(requestId: string, hostId: string): string {
  return `Sotto Watcher request: ${requestId}. Local host: ${hostId}. Use this requestId for sotto_threads changes made for this message.`
}

/**
 * The note as one bracketed line after the user's words, for Grok Build alone: its prompt has no other model-visible
 * channel. The snapshot below takes this exact line off again, so no one is shown it.
 */
export const watcherRequestLine = (note: string): string => `\n\n[${note}]`

/** The Watcher request a user message started or continued: the only messages Sotto ever added a line to. */
export interface WatcherMessageRequest { readonly requestId: string; readonly hostId: string }
export type WatcherMessageRequests = (threadId: string, messageId: string) => WatcherMessageRequest | undefined

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
/** One project ID as main listed it: no spaces, commas or brackets. */
const PROJECT = '[^\\s,\\[\\]]+'

/**
 * A Watcher message as the user typed it. Sotto put a line after the user's words in two cases only, both naming the
 * message's own request: the routing footer main appended before the request note existed (which also listed project
 * IDs), and Grok Build's request line. Only that exact line, for that request, comes off; any other text, including a
 * note or footer the user typed themselves, stays.
 */
export function watcherTextAsTyped(text: string, request: WatcherMessageRequest): string {
  const line = watcherRequestLine(watcherRequestNote(request.requestId, request.hostId))
  if (text.endsWith(line)) return text.slice(0, -line.length)
  if (text === line.slice(2)) return ''
  const footer = new RegExp(`(?:^|\\n\\n)\\[Sotto Watcher request: ${escape(request.requestId)}\\. Local host: ${escape(request.hostId)}\\. `
    + `Use this requestId for sotto_threads mutations\\. Known project IDs: (?:${PROJECT}(?:, ${PROJECT})*)?\\. Call list_projects for choices\\.\\]$`, 'u')
  const match = footer.exec(text)
  return match ? text.slice(0, match.index) : text
}

/**
 * Each unproven user message's request, from the Watcher record's request roots and continuations. A message with a
 * display proof is left to the proof alone (`WatcherMessageDisplay`): it was either sent with the old footer and its
 * exact boundary recorded, or sent as typed, so nothing in it is ever searched for a line.
 */
export function watcherMessageRequests(requests: readonly WatcherRequest[]): WatcherMessageRequests {
  let index = requestIndexes.get(requests)
  if (!index) {
    index = new Map()
    for (const request of requests) {
      const value = { requestId: request.id, hostId: request.watcher.hostId }
      const unproven = [...request.displayPrompt === undefined ? [request.rootUserMessageId] : [],
        ...(request.userFollowups ?? []).flatMap(item => item.messageId && item.displayPrompt === undefined ? [item.messageId] : [])]
      for (const messageId of unproven) index.set(`${request.watcher.threadId}\n${messageId}`, value)
    }
    requestIndexes.set(requests, index)
  }
  const found = index
  return (threadId, messageId) => found.get(`${threadId}\n${messageId}`)
}
const requestIndexes = new WeakMap<readonly WatcherRequest[], Map<string, WatcherMessageRequest>>()

/**
 * Each message already shown as typed, so a snapshot taken again from the coordinator's own state never loses a second
 * line, and the shown copy of each provider message, so a message the provider hands over again is read once.
 */
const shownAsTyped = new WeakSet<AgentMessage>()
const shownCopies = new WeakMap<AgentMessage, { readonly text: string; readonly requestId: string; readonly shown: AgentMessage }>()
const footed = (message: AgentMessage): boolean => message.role === 'user' && !shownAsTyped.has(message) && message.text.includes('[Sotto Watcher request: ')
const isWatcherConversation = (thread: AgentThread): boolean => thread.kind === 'watcher' || thread.kind === 'watcher-history'
function asTyped(message: AgentMessage, request: WatcherMessageRequest): AgentMessage {
  const cached = shownCopies.get(message)
  if (cached?.text === message.text && cached.requestId === request.requestId) return cached.shown
  const text = watcherTextAsTyped(message.text, request)
  const shown = text === message.text ? message : { ...message, text }
  if (shown !== message) shownAsTyped.add(shown)
  shownCopies.set(message, { text: message.text, requestId: request.requestId, shown })
  return shown
}

/**
 * Every user-facing copy of a Watcher conversation (its pane, Copy, the phone) comes from the coordinator's snapshot,
 * so Sotto's line is taken off there, once, and only from a user message in Watcher's own threads that started or
 * continued a Watcher request. The provider's history keeps what it was sent.
 */
export function watcherMessagesAsTyped(snapshot: AgentHostSnapshot, requestOf: WatcherMessageRequests): AgentHostSnapshot {
  const shown = (thread: AgentThread, message: AgentMessage): AgentMessage => {
    if (!footed(message)) return message
    const request = requestOf(thread.id, message.id)
    return request ? asTyped(message, request) : message
  }
  if (!snapshot.threads.some(thread => isWatcherConversation(thread) && thread.messages.some(message => shown(thread, message) !== message))) return snapshot
  return { ...snapshot, threads: snapshot.threads.map(thread => {
    if (!isWatcherConversation(thread)) return thread
    const messages = thread.messages.map(message => shown(thread, message))
    return messages.every((message, index) => message === thread.messages[index]) ? thread : { ...thread, messages }
  }) }
}
