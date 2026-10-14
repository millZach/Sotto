import type { AgentHostSnapshot, AgentMessage, AgentThread } from '../../shared/agents'

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

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const HEAD = `(?:^|\\n\\n)\\[Sotto Watcher request: ${UUID}\\. Local host: ${UUID}\\. `
/**
 * The two lines Sotto ever put after a Watcher message's words, each ending the message on its own paragraph: the
 * routing footer main appended to every user Send before the request note existed, which also listed every project ID,
 * and Grok Build's request line. Only these exact Sotto-made lines match; nothing else in a message is read.
 */
const SOTTO_LINES = [
  new RegExp(`${HEAD}Use this requestId for sotto_threads mutations\\. Known project IDs: [^\\n]*\\. Call list_projects for choices\\.\\]$`, 'u'),
  new RegExp(`${HEAD}Use this requestId for sotto_threads changes made for this message\\.\\]$`, 'u'),
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
