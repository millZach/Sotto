import type { AgentHostSnapshot, AgentMessage, AgentThread } from '../../shared/agents'

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const HEAD = `(?:^|\\n\\n)\\[Sotto Watcher request: ${UUID}\\. Local host: ${UUID}\\. `
/**
 * The line Sotto puts after a Watcher message's words, ending the message on its own paragraph: the routing footer
 * main appends to every user Send, which also lists every project ID. Only this exact Sotto-made line matches; nothing
 * else in a message is read.
 */
const SOTTO_LINES = [
  new RegExp(`${HEAD}Use this requestId for sotto_threads mutations\\. Known project IDs: [^\\n]*\\. Call list_projects for choices\\.\\]$`, 'u'),
]

/** A Watcher message as the user typed it, without the line Sotto put after it. */
export function watcherTextAsTyped(text: string): string {
  for (const line of SOTTO_LINES) {
    const match = line.exec(text)
    if (match) return text.slice(0, match.index)
  }
  return text
}

/**
 * Each message already shown as typed, so a snapshot taken again from the coordinator's own state never loses a second
 * line, and the shown copy of each provider message, so a message the provider hands over again is read once.
 */
const shownAsTyped = new WeakSet<AgentMessage>()
const shownCopies = new WeakMap<AgentMessage, { readonly text: string; readonly shown: AgentMessage }>()
const footed = (message: AgentMessage): boolean => message.role === 'user' && !shownAsTyped.has(message) && message.text.includes('[Sotto Watcher request: ')
const isWatcherConversation = (thread: AgentThread): boolean => thread.kind === 'watcher' || thread.kind === 'watcher-history'
function asTyped(message: AgentMessage): AgentMessage {
  const cached = shownCopies.get(message)
  if (cached?.text === message.text) return cached.shown
  const text = watcherTextAsTyped(message.text)
  const shown = text === message.text ? message : { ...message, text }
  if (shown !== message) shownAsTyped.add(shown)
  shownCopies.set(message, { text: message.text, shown })
  return shown
}

/**
 * Every user-facing copy of a Watcher conversation (its pane, Copy, the phone) comes from the coordinator's snapshot,
 * so Sotto's line is taken off there, once, and only from user messages in Watcher's own threads. The provider's
 * history keeps what it was sent.
 */
export function watcherMessagesAsTyped(snapshot: AgentHostSnapshot): AgentHostSnapshot {
  if (!snapshot.threads.some(thread => isWatcherConversation(thread) && thread.messages.some(footed))) return snapshot
  return { ...snapshot, threads: snapshot.threads.map(thread => isWatcherConversation(thread) && thread.messages.some(footed)
    ? { ...thread, messages: thread.messages.map(message => footed(message) ? asTyped(message) : message) } : thread) }
}
