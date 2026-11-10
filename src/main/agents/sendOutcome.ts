import type { AgentDelivery, AgentFollowup, AgentState } from '../../shared/agents'

type SendState = Pick<AgentState, 'deliveries' | 'deliveredDrafts' | 'followups' | 'error'>
export interface SendOutcome {
  status: 'accepted' | 'uncertain' | 'queued' | 'failed' | 'unconfirmed'
  delivery: AgentDelivery | undefined
  queue: AgentFollowup | undefined
}

/** Delivery evidence belongs to one thread and draft. A receipt for queue admission proves no delivery. */
export function sendOutcome(result: SendState | undefined, threadId: string, draftId: string): SendOutcome {
  const delivery = result?.deliveries?.find(item => item.threadId === threadId && item.draftId === draftId)
  const queue = result?.followups?.find(item => item.threadId === threadId && item.draftId === draftId)
  const evidence = { delivery, queue }
  if (delivery?.status === 'accepted' || result?.deliveredDrafts?.some(item => item.threadId === threadId && item.draftId === draftId)) return { ...evidence, status: 'accepted' }
  if (delivery?.status === 'uncertain' || delivery?.status === 'submitting') return { ...evidence, status: 'uncertain' }
  if (delivery?.status === 'failed') return { ...evidence, status: 'failed' }
  if (queue?.status === 'uncertain' || queue?.status === 'dispatching') return { ...evidence, status: 'uncertain' }
  if (queue?.status === 'failed') return { ...evidence, status: 'failed' }
  if (queue || delivery?.status === 'queued') return { ...evidence, status: 'queued' }
  return { ...evidence, status: result?.error ? 'failed' : 'unconfirmed' }
}
