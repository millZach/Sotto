import { createHash } from 'node:crypto'
import type { AgentHostSnapshot, AgentMessage, AgentThread } from '../../shared/agents'
import { startHandoverPrefix } from '../../shared/threadStarts'
import type { StartHandoverSent } from './host'

/**
 * The handover a thread that began from another goes with on its first message (#1028), ahead of the user's words in the
 * same message, as Watcher's goes after a provider change (ADR-0073). Sotto keeps which characters were the handover (a
 * length and its digest) on the thread's own record, and every user-facing copy shows the two apart by that record,
 * never by the words.
 */

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** What goes ahead of the user's words, and the record that tells the two apart afterwards. */
export function startHandoverSend(text: string, messageId: string): { prefix: string; sent: StartHandoverSent } {
  const prefix = startHandoverPrefix(text)
  return { prefix, sent: { messageId, prefixLength: prefix.length, prefixDigest: sha256(prefix) } }
}

/** The handover a sent message begins with, when its words still match the record; otherwise the message is shown whole. */
function split(thread: AgentThread, message: AgentMessage, sent: StartHandoverSent, from: AgentThread['providerId']): AgentMessage {
  const length = sent.prefixLength
  if (!Number.isSafeInteger(length) || length <= 0 || length > message.text.length) return message
  const prefix = message.text.slice(0, length)
  if (sha256(prefix) !== sent.prefixDigest) return message
  const counts = thread.startedFrom?.handover?.counts
  return { ...message, text: message.text.slice(length),
    ...(counts && from ? { handover: { text: prefix.trimEnd(), provider: from, counts } } : {}) }
}

/** Each provider message shown once per record, so a snapshot taken again reuses the split it made. */
const shownCopies = new WeakMap<AgentMessage, { readonly text: string; readonly sent: StartHandoverSent; readonly shown: AgentMessage }>()

/**
 * Threads that began from another as everything user-facing shows them: the first message that went with a handover is
 * the user's words, with the handover beside them. Only the message the thread's record names is looked at, and only its
 * recorded characters, checked against their digest, come off. A snapshot with no such thread is handed back as it is.
 */
export function startHandoversShown(snapshot: AgentHostSnapshot): AgentHostSnapshot {
  if (!snapshot.threads.some(thread => thread.startedFrom?.handover?.sent !== undefined)) return snapshot
  const shown = (thread: AgentThread, message: AgentMessage): AgentMessage => {
    const sent = thread.startedFrom?.handover?.sent
    if (!sent || message.role !== 'user' || message.id !== sent.messageId || message.handover) return message
    const cached = shownCopies.get(message)
    if (cached?.sent.prefixDigest === sent.prefixDigest && cached.sent.prefixLength === sent.prefixLength && cached.text === message.text) return cached.shown
    // The provider the handover came from: its source thread's, or this thread's own when the source is not listed.
    const from = snapshot.threads.find(item => item.id === thread.startedFrom?.threadId)?.providerId ?? thread.providerId
    const result = split(thread, message, sent, from)
    shownCopies.set(message, { text: message.text, sent, shown: result })
    return result
  }
  let changed = false
  const threads = snapshot.threads.map(thread => {
    if (thread.startedFrom?.handover?.sent === undefined || !thread.messages.length) return thread
    const messages = thread.messages.map(message => shown(thread, message))
    if (messages.every((message, index) => message === thread.messages[index])) return thread
    changed = true
    return { ...thread, messages }
  })
  return changed ? { ...snapshot, threads } : snapshot
}
