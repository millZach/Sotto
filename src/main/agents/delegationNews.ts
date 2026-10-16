import { DELEGATION_NEWS_MAX, READ_DELEGATION_TOOL, type DelegationNews } from '../../shared/delegation'
import type { WatcherOutcome } from '../../shared/watcher'

/**
 * Later news of a thread's delegations folded into a waiting wake-up's (ADR-0081 decision 7): one item per delegation,
 * the newest outcome winning, in the order each first had news. Never more than `DELEGATION_NEWS_MAX`, the oldest giving way.
 */
export function foldDelegationNews(earlier: DelegationNews | undefined, later: DelegationNews): DelegationNews {
  const items = new Map((earlier?.items ?? []).map(item => [item.delegationId, item]))
  for (const item of later.items) items.set(item.delegationId, item)
  return { source: 'delegation', items: [...items.values()].slice(-DELEGATION_NEWS_MAX) }
}

const SAYS: Record<WatcherOutcome, string> = {
  working: 'is still working on it.',
  background: 'ended its turn with background work or monitoring still running, so it is not done. Sotto sends news again when that work ends.',
  answered: `answered. Call ${READ_DELEGATION_TOOL} with this delegation for its reply.`,
  failed: `failed. Call ${READ_DELEGATION_TOOL} with this delegation, and read the thread for its error, before sending again.`,
  stopped: 'was stopped before it answered. Nothing more will come of it.',
  paused: 'is paused: the user\'s own turn in that thread holds it. Delegated sends to it wait until that turn ends.',
  unknown: 'cannot be proved either way, as after a restart mid-turn. Do not assume it answered, and do not send it again without reading it.',
}

/**
 * The wake-up's words for a thread's delegations: identities and outcomes only, never what a delegated thread wrote,
 * which the delegating thread reads with `read_delegation` when it asks.
 */
export function delegationNewsText(news: DelegationNews): string {
  return ['Sotto has news of work this thread delegated. It carries none of the delegated threads\' words, and it approves nothing.',
    ...news.items.map(item => `- Delegation ${item.delegationId} to thread ${item.threadId}${item.turnMessageId ? ` (turn ${item.turnMessageId})` : ''} ${SAYS[item.outcome]}`),
  ].join('\n')
}
