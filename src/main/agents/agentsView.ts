import type { AgentThread } from '../../shared/agents'
import { HOST_DELEGATED_THREADS_MAX, HOST_DELEGATION_BRIEF_EXCERPT, hostThreadDelegationsSchema, type HostDelegatedThread, type HostThreadDelegations } from '../../shared/agentsView'
import type { DelegatedView } from '../../shared/delegation'
import type { DelegationViews } from './delegationIpc'

/**
 * The iPhone's read of a thread's delegated threads (ADR-0103): each thread below `threadId` that its `delegatedBy` link
 * names, both levels, as the desktop's Tools › Agents finds them (`delegatedRoster.ts`), with what delegation's own record
 * knows of it. Its start is only ever the brief that started it, read from the delegating thread's delegations or, where
 * that read no longer holds it, from the thread's own record of the briefs it was sent. Never a reply.
 */
export function threadDelegations(delegation: Pick<DelegationViews, 'views' | 'brief'>, threads: readonly Pick<AgentThread, 'id' | 'delegatedBy'>[], threadId: string): HostThreadDelegations {
  const children = new Map<string, string[]>()
  for (const thread of threads) {
    if (thread.delegatedBy === undefined || thread.delegatedBy === thread.id) continue
    const list = children.get(thread.delegatedBy)
    if (list) list.push(thread.id); else children.set(thread.delegatedBy, [thread.id])
  }
  const first = (children.get(threadId) ?? []).filter(id => id !== threadId)
  const firstIds = new Set(first)
  // Each thread's record is read once, however many rows ask for it.
  const read = new Map<string, ReturnType<DelegationViews['views']>>()
  const viewsOf = (id: string): ReturnType<DelegationViews['views']> => {
    let views = read.get(id)
    if (!views) { views = delegation.views(id); read.set(id, views) }
    return views
  }
  const rows: HostDelegatedThread[] = []
  const add = (thread: string, by: string): void => {
    if (rows.length >= HOST_DELEGATED_THREADS_MAX) return
    const row = rowOf(thread, by, viewsOf, delegation.brief(thread))
    if (row) rows.push(row)
  }
  for (const thread of first) {
    add(thread, threadId)
    for (const child of children.get(thread) ?? []) if (child !== threadId && !firstIds.has(child)) add(child, thread)
  }
  return hostThreadDelegationsSchema.parse({ threadId, threads: rows })
}

const time = (iso: string): number => Date.parse(iso)

/** The start of a brief, never cutting a character in two: a lone half of one would not read on the iPhone. */
export function briefExcerpt(text: string): string {
  if (text.length <= HOST_DELEGATION_BRIEF_EXCERPT) return text
  const last = text.charCodeAt(HOST_DELEGATION_BRIEF_EXCERPT - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? HOST_DELEGATION_BRIEF_EXCERPT - 1 : HOST_DELEGATION_BRIEF_EXCERPT)
}

function rowOf(thread: string, by: string, viewsOf: (id: string) => ReturnType<DelegationViews['views']>, brief: string | undefined): HostDelegatedThread | undefined {
  const known = new Map<string, DelegatedView>()
  for (const view of viewsOf(by).made) if (view.outcome !== 'refused' && view.thread === thread) known.set(view.id, view)
  // Main returns every open delegation but only the newest finished ones: an old start is in the thread's own record.
  if (![...known.values()].some(view => view.action === 'start')) {
    for (const view of viewsOf(thread).received) if (!known.has(view.id)) known.set(view.id, view)
  }
  const views = [...known.values()].sort((one, other) => time(one.createdAt) - time(other.createdAt))
  const newest = views.at(-1)
  if (!newest) return undefined
  const start = views.find(view => view.action === 'start')
  const finished = newest.outcome !== 'working' && newest.outcome !== 'background'
  return {
    thread, by, work: start?.work ?? newest.work, outcome: newest.outcome,
    ...newest.unknownWhy ? { unknownWhy: newest.unknownWhy } : {},
    ...start ? { startedAt: start.createdAt } : {},
    ...finished && newest.outcomeAt ? { outcomeAt: newest.outcomeAt } : {},
    waiting: newest.waiting,
    ...brief ? { brief: briefExcerpt(brief) } : {},
  }
}
