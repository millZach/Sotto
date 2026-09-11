import { useState } from 'react'
import type { AgentCommand, AgentQueueItem, AgentState } from '../../../shared/agents'
import { attentionItemKey, isLiveAttention } from '../../../shared/agentAttention'

export interface AttentionReview {
  readonly items: AgentQueueItem[]
  readonly show: boolean
  readonly dismiss: () => void
  readonly reopen: () => void
  readonly next: () => Promise<void>
}

/** Mount in AgentProvider so navigating between rooms does not forget presentation. */
export function useAttentionReview(state: AgentState | null, command: (command: AgentCommand) => Promise<AgentState | null>, stopSpeech: () => void): AttentionReview {
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(() => new Set())
  const items = (state?.queue.filter(item => isLiveAttention(item, state.host.threads)) ?? [])
  const acknowledge = (entries: readonly AgentQueueItem[]): void => {
    setReviewed(previous => new Set([...previous, ...entries.map(attentionItemKey)]))
  }
  return {
    items,
    show: state?.connection === 'connected' && items.some(item => !reviewed.has(attentionItemKey(item))),
    dismiss: () => { stopSpeech(); acknowledge(items) },
    reopen: () => { setReviewed(new Set()) },
    next: async () => {
      stopSpeech()
      const current = items.find(item => item.threadId === state?.activeThreadId) ?? items[0]
      const next = items.find(item => item !== current && !reviewed.has(attentionItemKey(item)))
      if (!next) { acknowledge(items); return }
      const result = await command({ type: 'select-attention', itemId: next.id })
      if (result && !result.error && current) acknowledge([current])
    },
  }
}
