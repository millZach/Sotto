import { hostForThread, PROVIDER_LABELS, type AgentHostSnapshot, type AgentThread } from '../../../shared/agents'
import { delegatedThreadsBelow, DELEGATION_WORK_TITLES, type DelegatedView, type DelegationOutcome, type DelegationView } from '../../../shared/delegation'
import { resolveModel } from '../../../shared/modelCatalog'
import type { SubagentRow, SubagentSummary } from '../../../shared/subagents'
import { isThreadClosed, isThreadTurnRunning } from '../../../shared/threadActivity'
import { effortLabel } from '../agents/EffortPicker'
import type { AgentConnection } from '../agents/AgentContext'
import { clockLabel } from '../agents/threadFacts'
import { toolsPanelStore, type ToolsPanelStore } from './toolsPanelStore'

/**
 * Delegated threads in Tools › Agents (ADR-0081, as Zach settled it on October 17, 2026, variant B of the roster
 * prototype): a thread's delegated threads are listed with its provider's own subagents, newest start first, rather than
 * in the sidebar. Unlike a subagent, each is a Sotto thread, so a row can open it. Everything here comes from what the
 * window already holds: the snapshot's threads and the delegation reads (`delegations.ts`), never a delegated thread's
 * reply.
 */

/** What a delegated thread waits on the user for: a permission ahead of a question, as a sidebar row says it. */
export function threadWaitingFor(thread: Pick<AgentThread, 'requests' | 'settledAt' | 'settledOverride' | 'archivedAt'>): 'approval' | 'question' | null {
  if (!thread.requests.length || isThreadClosed(thread)) return null
  return thread.requests.some(request => request.kind === 'permission') ? 'approval' : thread.requests.some(request => request.kind === 'question') ? 'question' : null
}

/**
 * The delegated threads below a thread, both levels, that wait on the user and that are working otherwise: what the
 * Tools toggle and the Agents tab mark, from the snapshot alone.
 */
export function delegatedBelow(threads: readonly AgentThread[], threadId: string): { readonly needs: number; readonly working: number } {
  const below = new Set(delegatedThreadsBelow(threads, threadId))
  let needs = 0, working = 0
  if (below.size) for (const thread of threads) {
    if (!below.has(thread.id)) continue
    if (threadWaitingFor(thread) !== null) needs++
    else if (isThreadTurnRunning(thread)) working++
  }
  return { needs, working }
}

/** A delegated thread's word on its roster row: Needs you while it waits on the user, otherwise its delegation's outcome. */
export type DelegatedRowStatus = 'needs' | DelegationOutcome

export interface DelegatedRosterRow {
  readonly thread: AgentThread
  /** 1 under the roster's own thread, 2 under one of its delegated threads. */
  readonly level: 1 | 2
  /** The thread that delegated to it, by its title, where it is not the roster's own thread. */
  readonly delegatedBy: string | undefined
  /** Its newest brief's delegation, once the window has read it. */
  readonly newest: DelegatedView | undefined
  /** When the brief that started it was sent; NaN until the delegation record says. */
  readonly startedAt: number
  /** When its newest outcome was reached, for a finished row's time; NaN while it works or when the record does not say. */
  readonly endedAt: number
  readonly waitingFor: 'approval' | 'question' | null
  /** Undefined only before the window has read the delegation: nothing is guessed. */
  readonly status: DelegatedRowStatus | undefined
  /** The newest brief whose words the window holds: the thread's messages, or the excerpt of its newest message to it. */
  readonly brief: string | undefined
  /** Provider · kind of work · model · effort · start time, each only where it is known. */
  readonly meta: readonly string[]
  readonly provider: string | undefined
}

const time = (iso: string | undefined): number => iso === undefined ? Number.NaN : Date.parse(iso)

/** The words of the newest brief the window holds, from the delegated thread's own history. */
function briefOf(thread: AgentThread, views: readonly DelegatedView[]): string | undefined {
  const lastUser = thread.summary?.lastUser
  for (const view of [...views].reverse()) {
    const message = thread.messages.find(item => item.id === view.briefMessageId)
    if (message) return message.text
    if (lastUser?.id === view.briefMessageId) return lastUser.text
  }
  return undefined
}

function rowOf(thread: AgentThread, level: 1 | 2, delegatedBy: string | undefined, made: readonly DelegationView[], host: AgentHostSnapshot): DelegatedRosterRow {
  const views = made.filter((view): view is DelegatedView => view.outcome !== 'refused' && view.thread === thread.id)
  const newest = views.at(-1)
  const start = views.find(view => view.action === 'start') ?? views[0]
  const startedAt = time(start?.createdAt)
  const waitingFor = threadWaitingFor(thread)
  const working = newest?.outcome === 'working' || newest?.outcome === 'background'
  const provider = thread.providerId ? PROVIDER_LABELS[thread.providerId] : undefined
  const model = resolveModel(hostForThread(host, thread).models, thread.modelId)?.name
  const meta = [provider, start ? DELEGATION_WORK_TITLES[start.work] : undefined, model, thread.reasoningEffort ? effortLabel(thread.reasoningEffort) : undefined,
    Number.isFinite(startedAt) ? clockLabel(startedAt) : undefined].filter((fact): fact is string => fact !== undefined && fact !== '')
  return { thread, level, delegatedBy, newest, startedAt, endedAt: working ? Number.NaN : time(newest?.outcomeAt), waitingFor,
    status: waitingFor !== null ? 'needs' : newest?.outcome, brief: briefOf(thread, views), meta, provider }
}

const newestFirst = (first: { readonly startedAt: number }, second: { readonly startedAt: number }): number => {
  const a = Number.isFinite(first.startedAt) ? first.startedAt : Number.NEGATIVE_INFINITY
  const b = Number.isFinite(second.startedAt) ? second.startedAt : Number.NEGATIVE_INFINITY
  return b - a
}

/**
 * The delegated threads below `ownerId`, two levels, each first-level one followed by its own, newest start first. `made`
 * holds what each delegating thread delegated, by its ID: the owner's and each first-level thread's.
 */
export function delegatedRoster(ownerId: string, threads: readonly AgentThread[], made: ReadonlyMap<string, { readonly made: readonly DelegationView[] }>, host: AgentHostSnapshot): DelegatedRosterRow[][] {
  const children = new Map<string, AgentThread[]>()
  for (const thread of threads) if (thread.delegatedBy !== undefined && thread.delegatedBy !== thread.id) children.set(thread.delegatedBy, [...children.get(thread.delegatedBy) ?? [], thread])
  const first = (children.get(ownerId) ?? []).filter(thread => thread.id !== ownerId)
  const firstIds = new Set(first.map(thread => thread.id))
  return first.map(thread => rowOf(thread, 1, undefined, made.get(ownerId)?.made ?? [], host)).sort(newestFirst).map(row => [row,
    ...(children.get(row.thread.id) ?? []).filter(child => child.id !== ownerId && !firstIds.has(child.id))
      .map(child => rowOf(child, 2, row.thread.title, made.get(row.thread.id)?.made ?? [], host)).sort(newestFirst)])
}

/** The first-level delegated threads that delegated in turn: whose delegations the roster also reads. */
export function delegatingBelow(ownerId: string, threads: readonly Pick<AgentThread, 'id' | 'delegatedBy'>[]): string[] {
  const first = new Set(threads.filter(thread => thread.delegatedBy === ownerId && thread.id !== ownerId).map(thread => thread.id))
  return [...new Set(threads.filter(thread => thread.delegatedBy !== undefined && first.has(thread.delegatedBy)).map(thread => thread.delegatedBy!))]
}

/** One entry of the mixed roster: a subagent with the agents under it, or a delegated thread with its own. */
export type RosterBlock =
  | { readonly kind: 'agents'; readonly startedAt: number; readonly rows: readonly { readonly row: SubagentRow; readonly depth: number }[] }
  | { readonly kind: 'threads'; readonly startedAt: number; readonly rows: readonly DelegatedRosterRow[] }

/**
 * The provider's agents and the delegated threads in one list, newest start first (variant B). Each subagent keeps the
 * agents reported under it, and each delegated thread its own delegated threads. An agent whose start was not reported
 * goes by when it was last seen.
 */
export function mixedRoster(agents: readonly { readonly row: SubagentRow; readonly depth: number }[], threads: readonly DelegatedRosterRow[][]): RosterBlock[] {
  const blocks: RosterBlock[] = []
  for (const entry of agents) {
    const last = blocks.at(-1)
    if (entry.depth > 0 && last?.kind === 'agents') { blocks[blocks.length - 1] = { ...last, rows: [...last.rows, entry] }; continue }
    const started = time(entry.row.startedAt)
    blocks.push({ kind: 'agents', startedAt: Number.isFinite(started) ? started : time(entry.row.lastObservedAt), rows: [entry] })
  }
  for (const family of threads) if (family[0]) blocks.push({ kind: 'threads', startedAt: family[0].startedAt, rows: family })
  return blocks.map((block, index) => ({ block, index })).sort((first, second) => newestFirst(first.block, second.block) || first.index - second.index).map(({ block }) => block)
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * The roster's line of chrome while it lists delegated threads: "4 delegated threads · 2 agents", and beside it what
 * needs the user and what is working, delegated threads and agents together ("1 needs you · 2 working").
 */
export function rosterCounts(rows: readonly DelegatedRosterRow[], summary: Pick<SubagentSummary, 'total' | 'working' | 'unknown'>): { readonly title: string; readonly detail: string | null } {
  const needs = rows.filter(row => row.status === 'needs').length
  const working = rows.filter(row => row.status === 'working' || row.status === 'background').length + summary.working
  const title = [plural(rows.length, 'delegated thread'), ...summary.total ? [plural(summary.total, 'agent')] : []].join(' · ')
  const detail = [needs ? `${needs} needs you` : '', working ? `${working} working` : ''].filter(Boolean).join(' · ')
  return { title, detail: detail || (summary.unknown ? 'Activity not confirmed' : 'None working') }
}

/** What a delegated thread's open control says and does, by whether it waits on the user and whether it is in the pane. */
export function openAction(row: Pick<DelegatedRosterRow, 'thread' | 'waitingFor'>, shown: boolean): { readonly kind: 'shown' } | { readonly kind: 'open' | 'answer'; readonly label: string; readonly name: string } {
  if (shown) return { kind: 'shown' }
  const title = row.thread.title
  return row.waitingFor !== null ? { kind: 'answer', label: 'Open to answer', name: `Open ${title} to answer its request` } : { kind: 'open', label: 'Open as thread', name: `Open ${title} as a thread` }
}

/**
 * Opens a delegated thread in the pane, as its roster row or its card in the transcript asks, and keeps Tools on the
 * thread it was opened from (`from`), pinned, so the next one is a press away. Tools is pinned only while it is open: a
 * closed panel's pin would be news the next time it opens.
 */
export function openDelegatedThread(command: AgentConnection['command'], threadId: string, from: string, store: ToolsPanelStore = toolsPanelStore): void {
  if (store.getSnapshot().open) store.pin(from)
  void command({ type: 'select-thread', threadId })
}
