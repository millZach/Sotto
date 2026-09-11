import type { AgentQueueItem, AgentThread } from './agents'
import { isThreadClosed } from './threadActivity'

/** Presentation acknowledgement follows the item's meaning, not queue membership/order. */
export function attentionItemKey(item: AgentQueueItem): string {
  return JSON.stringify([item.id, item.threadId, item.kind, item.requestId ?? null, item.text])
}

export function isLiveAttention(item: AgentQueueItem, threads: readonly AgentThread[]): boolean {
  const thread = threads.find(thread => thread.id === item.threadId)
  if (!thread || isThreadClosed(thread)) return false
  return item.requestId !== undefined
    ? thread.requests.some(request => request.id === item.requestId)
    : thread.status !== 'running' && Date.parse(item.createdAt) > Date.now() - 7 * 86_400_000
}
