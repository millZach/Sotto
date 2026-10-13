import { createHash } from 'node:crypto'
import type { AgentMessage } from '../../shared/agents'
import type { WatcherDisplayPrompt, WatcherRequest } from '../../shared/watcher'

/** Presentation evidence only. Native input, history and reconciliation keep the complete wire text. */
export function watcherDisplayPrompt(original: string, wire: string): WatcherDisplayPrompt {
  return { originalLength: original.length, wireDigest: createHash('sha256').update(wire).digest('hex') }
}

function originalText(text: string, proof: WatcherDisplayPrompt): string {
  const length = proof.originalLength
  if (!Number.isSafeInteger(length) || length < 0 || length > text.length) return text
  // A corrupt boundary cannot cut a UTF-16 surrogate pair in half.
  if (length > 0 && length < text.length && text.charCodeAt(length - 1) >= 0xD800 && text.charCodeAt(length - 1) <= 0xDBFF
    && text.charCodeAt(length) >= 0xDC00 && text.charCodeAt(length) <= 0xDFFF) return text
  if (createHash('sha256').update(text).digest('hex') !== proof.wireDigest) return text
  return text.slice(0, length)
}

type Proofs = Map<string, WatcherDisplayPrompt | null>
const ownerKey = (hostId: string, threadId: string): string => JSON.stringify([hostId, threadId])
const sameProof = (left: WatcherDisplayPrompt | null | undefined, right: WatcherDisplayPrompt | null | undefined): boolean =>
  left === right || Boolean(left && right && left.originalLength === right.originalLength && left.wireDigest === right.wireDigest)

/** Private to the coordinator. Metadata updates never copy history; read paths never scan its control archive. */
export class WatcherMessageDisplay {
  private index = new Map<string, Proofs>()
  private readonly cache = new Map<string, Map<string, { wire: string; proof: WatcherDisplayPrompt; text: string }>>()

  update(requests: readonly WatcherRequest[]): void {
    const next = new Map<string, Proofs>()
    for (const request of requests) {
      const key = ownerKey(request.watcher.hostId, request.watcher.threadId)
      let proofs = next.get(key)
      if (!proofs) { proofs = new Map(); next.set(key, proofs) }
      const remember = (messageId: string, proof: WatcherDisplayPrompt | undefined): void => {
        if (!proofs!.has(messageId)) { proofs!.set(messageId, proof ?? null); return }
        // Conflicting or unproved duplicate claims cannot establish an original boundary.
        if (!sameProof(proofs!.get(messageId), proof)) proofs!.set(messageId, null)
      }
      remember(request.rootUserMessageId, request.displayPrompt)
      for (const followup of request.userFollowups ?? []) if (followup.messageId !== undefined) remember(followup.messageId, followup.displayPrompt)
    }
    const unchanged = next.size === this.index.size && [...next].every(([key, proofs]) => {
      const previous = this.index.get(key)
      if (!previous || previous.size !== proofs.size) return false
      return [...proofs].every(([id, proof]) => previous.has(id) && sameProof(previous.get(id), proof))
    })
    if (unchanged) return
    this.index = next
    this.cache.clear()
  }

  /** The only text cache is the current presented window. Exact native edits and proof changes invalidate it. */
  project(hostId: string | undefined, threadId: string, messages: readonly AgentMessage[]): readonly AgentMessage[] {
    if (hostId === undefined) return messages
    const key = ownerKey(hostId, threadId), proofs = this.index.get(key)
    if (!proofs || !messages.some(message => message.role === 'user' && proofs.get(message.id))) {
      this.cache.delete(key)
      return messages
    }
    let cached = this.cache.get(key)
    if (!cached) { cached = new Map(); this.cache.set(key, cached) }
    const seen = new Set<string>()
    let projected: AgentMessage[] | undefined
    for (const [index, message] of messages.entries()) {
      const proof = message.role === 'user' ? proofs.get(message.id) : undefined
      if (!proof) continue
      seen.add(message.id)
      const previous = cached.get(message.id)
      const text = previous && previous.wire === message.text && sameProof(previous.proof, proof)
        ? previous.text : originalText(message.text, proof)
      cached.set(message.id, { wire: message.text, proof, text })
      if (text !== message.text) {
        projected ??= [...messages]
        projected[index] = { ...message, text }
      }
    }
    for (const id of cached.keys()) if (!seen.has(id)) cached.delete(id)
    return projected ?? messages
  }
}

/** Stateless projection for an isolated set of retained records; production uses the private shared index above. */
export function projectWatcherMessages(hostId: string | undefined, threadId: string, messages: readonly AgentMessage[],
  requests: readonly WatcherRequest[]): readonly AgentMessage[] {
  if (hostId === undefined || !messages.some(message => message.role === 'user') || !requests.some(request =>
    request.watcher.hostId === hostId && request.watcher.threadId === threadId && (request.displayPrompt !== undefined
      || request.userFollowups?.some(followup => followup.messageId !== undefined && followup.displayPrompt !== undefined)))) return messages
  const display = new WatcherMessageDisplay()
  display.update(requests)
  return display.project(hostId, threadId, messages)
}
