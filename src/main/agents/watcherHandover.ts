import { createHash } from 'node:crypto'
import type { AgentHostSnapshot, AgentMessage, AgentThread, HandoverCounts } from '../../shared/agents'
import type { WatcherHandoverProvenance, WatcherIdentity, WatcherRequest } from '../../shared/watcher'
import type { HandoverSummary } from './handover'
import { projectWatcherMessages } from './watcherMessageDisplay'
import { watcherMessageRequests, watcherTextAsTyped } from './watcherRequestNote'

/**
 * Watcher's handover after a provider change (ADR-0073). When the user chooses to continue, the new Watcher's first
 * message carries a handover of the last one ahead of the user's words, in the same message, so no turn is spent on it.
 * Sotto records which characters were the handover (a length and its digest) on the request that message started, and
 * every user-facing copy shows the two apart by that record, never by the words.
 */

/** The line after the handover that says where the user's own message begins. */
export const HANDOVER_CLOSE = '[End of the handover. The user’s message to Watcher follows.]'

/** What goes ahead of the user's words: the handover, then the line that closes it. */
export function handoverPrefix(text: string): string {
  return `${text}\n\n${HANDOVER_CLOSE}\n\n`
}

/** A handover's summary as counts, the only part of it that is kept or shown beside its words. */
export function handoverCounts(summary: HandoverSummary): HandoverCounts {
  return { total: summary.total, carried: summary.carried.length, tooLong: summary.tooLong.length, notCarried: summary.notCarried,
    images: summary.images, files: summary.files, visuals: summary.visuals, toolRecords: summary.toolRecords,
    historyKept: summary.historyKept, answered: summary.answered }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export function watcherHandoverProvenance(prefix: string, source: WatcherIdentity, counts: HandoverCounts): WatcherHandoverProvenance {
  return { prefixLength: prefix.length, prefixDigest: sha256(prefix), source: source.target, provider: source.provider, counts }
}

/** The handover a sent message begins with, when its words still match the record; otherwise the message is shown whole. */
function split(message: AgentMessage, proof: WatcherHandoverProvenance): AgentMessage {
  const length = proof.prefixLength
  if (!Number.isSafeInteger(length) || length <= 0 || length > message.text.length) return message
  const prefix = message.text.slice(0, length)
  if (sha256(prefix) !== proof.prefixDigest) return message
  return { ...message, text: message.text.slice(length), handover: { text: prefix.trimEnd(), provider: proof.provider, counts: proof.counts } }
}

type Proofs = ReadonlyMap<string, WatcherHandoverProvenance>
const proofIndexes = new WeakMap<readonly WatcherRequest[], Proofs>()
function proofsOf(requests: readonly WatcherRequest[]): Proofs {
  let index = proofIndexes.get(requests)
  if (!index) {
    const built = new Map<string, WatcherHandoverProvenance>()
    for (const request of requests) if (request.handover) built.set(`${request.watcher.threadId}\n${request.rootUserMessageId}`, request.handover)
    proofIndexes.set(requests, index = built)
  }
  return index
}

/** Each provider message shown once per record, so a snapshot taken again reuses the split it made. */
const shownCopies = new WeakMap<AgentMessage, { readonly text: string; readonly proof: WatcherHandoverProvenance; readonly shown: AgentMessage }>()
const isWatcherConversation = (thread: AgentThread): boolean => thread.kind === 'watcher' || thread.kind === 'watcher-history'

/**
 * Watcher's conversations as everything user-facing shows them: a first message that carried a handover is the user's
 * words, with the handover beside them. Only a user message that started a Watcher request recorded with a handover is
 * looked at, and only its recorded characters, checked against their digest, come off.
 */
export function watcherHandoversShown(snapshot: AgentHostSnapshot, requests: readonly WatcherRequest[]): AgentHostSnapshot {
  const proofs = proofsOf(requests)
  if (proofs.size === 0) return snapshot
  const shown = (thread: AgentThread, message: AgentMessage): AgentMessage => {
    if (message.role !== 'user' || message.handover) return message
    const proof = proofs.get(`${thread.id}\n${message.id}`)
    if (!proof) return message
    const cached = shownCopies.get(message)
    if (cached?.proof === proof && cached.text === message.text) return cached.shown
    const result = split(message, proof)
    shownCopies.set(message, { text: message.text, proof, shown: result })
    return result
  }
  if (!snapshot.threads.some(thread => isWatcherConversation(thread) && thread.messages.some(message => shown(thread, message) !== message))) return snapshot
  return { ...snapshot, threads: snapshot.threads.map(thread => {
    if (!isWatcherConversation(thread)) return thread
    const messages = thread.messages.map(message => shown(thread, message))
    return messages.every((message, index) => message === thread.messages[index]) ? thread : { ...thread, messages }
  }) }
}

/**
 * One message of an earlier Watcher conversation as its pane shows it, for a handover of that conversation: without a
 * handover it carried itself, without a line Sotto put after the user's words, and cut at its display proof. A handover
 * of a handover would only repeat an older conversation, so the newer one carries the user's words alone.
 */
export function watcherMessageAsShown(hostId: string, threadId: string, message: AgentMessage, requests: readonly WatcherRequest[]): AgentMessage {
  if (message.role !== 'user') return message
  const proof = proofsOf(requests).get(`${threadId}\n${message.id}`)
  let shown = proof ? split(message, proof) : message
  if (shown.handover) { const { handover: _handover, ...words } = shown; void _handover; shown = words }
  const request = watcherMessageRequests(requests)(threadId, shown.id)
  if (request) { const text = watcherTextAsTyped(shown.text, request); if (text !== shown.text) shown = { ...shown, text } }
  return projectWatcherMessages(hostId, threadId, [shown], requests)[0] ?? shown
}
