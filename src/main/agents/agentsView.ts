import type { AgentThread } from '../../shared/agents'
import { HOST_DELEGATED_THREADS_MAX, HOST_DELEGATION_BRIEF_EXCERPT, hostThreadDelegationsSchema, type HostDelegatedThread, type HostThreadDelegations } from '../../shared/agentsView'
import type { DelegatedView, DelegationView } from '../../shared/delegation'

/** Delegation's own record as the iPhone's read asks it: every row's views and briefs, each read once, from those threads' part of the record only. */
export interface DelegationReads {
  viewsOf(threadIds: readonly string[]): ReadonlyMap<string, { readonly made: readonly DelegationView[]; readonly received: readonly DelegatedView[] }>
  briefsOf(threadIds: readonly string[]): ReadonlyMap<string, string>
}

type Views = ReturnType<DelegationReads['viewsOf']>

/**
 * The iPhone's read of a thread's delegated threads (ADR-0103): each thread below `threadId` that its `delegatedBy` link
 * names, both levels, as the desktop's Tools › Agents finds them (`delegatedRoster.ts`), with what delegation's own record
 * knows of it. Its start is only ever the brief that started it, read from the delegating thread's delegations or, where
 * that read no longer holds it, from the thread's own record of the briefs it was sent. Never a reply. The record is read
 * once for every row's views and once for their briefs, so a read costs the same however many rows it shows.
 */
export function threadDelegations(delegation: DelegationReads, threads: readonly Pick<AgentThread, 'id' | 'delegatedBy'>[], threadId: string): HostThreadDelegations {
  const children = new Map<string, string[]>()
  for (const thread of threads) {
    if (thread.delegatedBy === undefined || thread.delegatedBy === thread.id) continue
    const list = children.get(thread.delegatedBy)
    if (list) list.push(thread.id); else children.set(thread.delegatedBy, [thread.id])
  }
  const first = (children.get(threadId) ?? []).filter(id => id !== threadId)
  const firstIds = new Set(first)
  const candidates: { readonly thread: string; readonly by: string }[] = []
  for (const thread of first) {
    candidates.push({ thread, by: threadId })
    for (const child of children.get(thread) ?? []) if (child !== threadId && !firstIds.has(child)) candidates.push({ thread: child, by: thread })
  }
  if (candidates.length === 0) return hostThreadDelegationsSchema.parse({ threadId, threads: [] })
  const views = delegation.viewsOf([threadId, ...candidates.map(candidate => candidate.thread)])
  const rows: HostDelegatedThread[] = []
  for (const { thread, by } of candidates) {
    if (rows.length >= HOST_DELEGATED_THREADS_MAX) break
    const row = rowOf(thread, by, views)
    if (row) rows.push(row)
  }
  const briefs = delegation.briefsOf(rows.map(row => row.thread))
  const shown = rows.map(row => { const brief = briefs.get(row.thread); return brief ? { ...row, brief: briefExcerpt(brief) } : row })
  return hostThreadDelegationsSchema.parse({ threadId, threads: shown })
}

const time = (iso: string): number => Date.parse(iso)

/** The start of a brief, never cutting a character in two: a lone half of one would not read on the iPhone. */
export function briefExcerpt(text: string): string {
  if (text.length <= HOST_DELEGATION_BRIEF_EXCERPT) return text
  const last = text.charCodeAt(HOST_DELEGATION_BRIEF_EXCERPT - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? HOST_DELEGATION_BRIEF_EXCERPT - 1 : HOST_DELEGATION_BRIEF_EXCERPT)
}

function rowOf(thread: string, by: string, views: Views): HostDelegatedThread | undefined {
  const known = new Map<string, DelegatedView>()
  for (const view of views.get(by)?.made ?? []) if (view.outcome !== 'refused' && view.thread === thread) known.set(view.id, view)
  // Main returns every open delegation but only the newest finished ones: an old start is in the thread's own record.
  if (![...known.values()].some(view => view.action === 'start')) {
    for (const view of views.get(thread)?.received ?? []) if (!known.has(view.id)) known.set(view.id, view)
  }
  const sorted = [...known.values()].sort((one, other) => time(one.createdAt) - time(other.createdAt))
  const newest = sorted.at(-1)
  if (!newest) return undefined
  const start = sorted.find(view => view.action === 'start')
  const finished = newest.outcome !== 'working' && newest.outcome !== 'background'
  return {
    thread, by, work: start?.work ?? newest.work, outcome: newest.outcome,
    ...newest.unknownWhy ? { unknownWhy: newest.unknownWhy } : {},
    ...start ? { startedAt: start.createdAt } : {},
    ...finished && newest.outcomeAt ? { outcomeAt: newest.outcomeAt } : {},
    waiting: newest.waiting,
  }
}
