import type { AgentHostSnapshot, AgentThread } from '../../shared/agents'
import { startHandoverPrefix } from '../../shared/threadStarts'
import type { StartHandoverSent } from './host'
import { handoverPrefixProof, splitHandover } from './watcherHandover'

/**
 * The handover a thread that began from another goes with on its first message (#1028), ahead of the user's words in the
 * same message, as Watcher's goes after a provider change (ADR-0073). Sotto keeps which characters were the handover (a
 * length and its digest) on the thread's own record, and every user-facing copy shows the two apart by that record,
 * never by the words.
 */

/** What goes ahead of the user's words, and the record that tells the two apart afterwards. */
export function startHandoverSend(text: string, messageId: string): { prefix: string; sent: StartHandoverSent } {
  const prefix = startHandoverPrefix(text)
  return { prefix, sent: { messageId, ...handoverPrefixProof(prefix) } }
}

/**
 * Each thread as shown, by the thread it was shown from: the coordinator hands the same thread object on while nothing in
 * it changed, so an update that changed nothing here builds nothing, and each list of threads is shown once.
 */
const shownThreads = new WeakMap<AgentThread, { readonly from: AgentThread['providerId']; readonly shown: AgentThread }>()
const shownLists = new WeakMap<readonly AgentThread[], readonly AgentThread[]>()

function shownThread(thread: AgentThread, from: AgentThread['providerId']): AgentThread {
  const sent = thread.startedFrom?.handover?.sent
  const counts = thread.startedFrom?.handover?.counts
  if (!sent || !counts || !thread.messages.length) return thread
  const cached = shownThreads.get(thread)
  if (cached && cached.from === from) return cached.shown
  const index = thread.messages.findIndex(message => message.id === sent.messageId && message.role === 'user' && !message.handover)
  const message = index < 0 || !from ? undefined : thread.messages[index]!
  const split = message ? splitHandover(message, { ...sent, provider: from!, counts }) : undefined
  let shown = thread
  if (split && split !== message) {
    const messages = thread.messages.slice()
    messages[index] = split
    shown = { ...thread, messages }
  }
  shownThreads.set(thread, { from, shown })
  return shown
}

/**
 * Threads that began from another as everything user-facing shows them: the first message that went with a handover is
 * the user's words, with the handover beside them, from the provider it came from. Only the message the thread's record
 * names is looked at, and only its recorded characters, checked against their digest, come off. A snapshot with no such
 * thread is handed back as it is. `origin` finds the thread one began from, for a snapshot that holds only the threads
 * that changed (#925); without it, the snapshot's own threads are looked in.
 */
export function startHandoversShown(snapshot: AgentHostSnapshot, origin?: (threadId: string) => AgentThread | undefined): AgentHostSnapshot {
  const cached = shownLists.get(snapshot.threads)
  if (cached) return cached === snapshot.threads ? snapshot : { ...snapshot, threads: cached as AgentThread[] }
  if (!snapshot.threads.some(thread => thread.startedFrom?.handover?.sent !== undefined)) { shownLists.set(snapshot.threads, snapshot.threads); return snapshot }
  const from = origin ?? ((threadId: string) => snapshot.threads.find(item => item.id === threadId))
  let changed = false
  const threads = snapshot.threads.map(thread => {
    const begun = thread.startedFrom?.threadId
    const shown = shownThread(thread, (begun === undefined ? undefined : from(begun))?.providerId ?? thread.providerId)
    if (shown !== thread) changed = true
    return shown
  })
  const list = changed ? threads : snapshot.threads
  shownLists.set(snapshot.threads, list)
  return changed ? { ...snapshot, threads } : snapshot
}
