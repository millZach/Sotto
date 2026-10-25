import { hostForThread, PROVIDER_LABELS, type AgentHostSnapshot, type AgentState, type AgentThread } from '../../../shared/agents'
import { delegatedThreadsBelow, DELEGATION_WORK_TITLES, type DelegatedView, type DelegationOutcome, type DelegationView } from '../../../shared/delegation'
import { resolveModel } from '../../../shared/modelCatalog'
import type { SubagentRow, SubagentSummary } from '../../../shared/subagents'
import { isThreadClosed, isThreadTurnRunning } from '../../../shared/threadActivity'
import { failureUnseen } from '../../../shared/threadFailures'
import { effortLabel } from '../agents/EffortPicker'
import type { AgentConnection } from '../agents/AgentContext'
import { clockLabel } from '../agents/threadFacts'
import { toolsPanelStore, type ToolsPanelStore } from './toolsPanelStore'
import { plural as pluralMessage, t } from '@lingui/core/macro'

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
 * Whether a delegated thread needs the user, as its sidebar row would say: a permission or a question waiting, or its
 * provider reporting an error no client has shown yet (Needs attention, ADR-0092). A closed thread needs nothing.
 */
export function threadNeedsYou(thread: Pick<AgentThread, 'requests' | 'status' | 'failureSeen' | 'settledAt' | 'settledOverride' | 'archivedAt'>): boolean {
  return threadWaitingFor(thread) !== null || failureUnseen(thread)
}

/**
 * The delegated threads below a thread, both levels, that need the user and that are working otherwise: what the
 * Tools toggle and the Agents tab mark, from the snapshot alone.
 */
export function delegatedBelow(threads: readonly AgentThread[], threadId: string): { readonly needs: number; readonly working: number } {
  const below = new Set(delegatedThreadsBelow(threads, threadId))
  let needs = 0, working = 0
  if (below.size) for (const thread of threads) {
    if (!below.has(thread.id)) continue
    if (threadNeedsYou(thread)) needs++
    else if (isThreadTurnRunning(thread)) working++
  }
  return { needs, working }
}

/**
 * A delegated thread's word on its roster row: Needs you while it waits on the user or reports an error, otherwise its
 * delegation's outcome.
 */
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
  /**
   * Undefined before the window has read the delegation, and for an idle thread on another host, whose delegation this
   * computer cannot read: nothing is guessed.
   */
  readonly status: DelegatedRowStatus | undefined
  /** Finished while no window showed it (ADR-0046): the row says Just finished, as a sidebar row would, until it is opened. */
  readonly finished: boolean
  /** The newest brief whose words the window holds: the thread's messages, or the excerpt of its newest message to it. */
  readonly brief: string | undefined
  /** Provider · kind of work · model · effort · start time, each only where it is known. */
  readonly meta: readonly string[]
  readonly provider: string | undefined
  /** The machine it runs on, by name, and whether Sotto is connected to it now (#1310). */
  readonly machine: RosterMachine
  /**
   * Its machine is not connected, so what the row says is as Sotto last read it there (#1310): its last outcome, greyed, never
   * guessed as Unknown. `asOf` is when that read stood, when known; NaN otherwise.
   */
  readonly lastRead: boolean
  readonly asOf: number
  /** Its start on another machine began at Ask for approval because that machine held it there (#1310). */
  readonly held: DelegatedView['held']
}

/** A machine a delegated thread runs on, as Tools › Agents names it (#1310). */
export interface RosterMachine {
  readonly hostId: string | undefined
  readonly name: string
  readonly remote: boolean
  readonly connected: boolean
}
/** Every thread on this computer, as a roster without Work across machines sees them all. */
export const THIS_COMPUTER: RosterMachine = {
  hostId: undefined, remote: false, connected: true,
  // Read when shown, so it is in the interface language of the moment (ADR-0123).
  get name() { return t`This computer` },
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

/**
 * What the window has read of a thread's delegations: the ones it made and the briefs it was sent. For a thread on another
 * machine (#1310), when what it holds is as Sotto last read it there, its machine not connected now (`lastReadAt`), or why
 * Sotto could not read it at all (`unread`).
 */
export interface DelegationReadOf {
  readonly made: readonly DelegationView[]; readonly received: readonly DelegatedView[]
  readonly lastReadAt?: number | undefined; readonly unread?: 'older-host' | 'not-connected' | undefined
}
/** The reads the window holds, by thread ID; a thread not read yet has no entry. */
export type DelegationReads = ReadonlyMap<string, DelegationReadOf>

const delegatedViewsOf = (threadId: string, made: readonly DelegationView[]): DelegatedView[] =>
  made.filter((view): view is DelegatedView => view.outcome !== 'refused' && view.thread === threadId)

/**
 * One delegated thread's row, from what its delegating thread's read holds of it and, where that read no longer holds
 * the brief that started it (main returns every open delegation but only the newest finished ones), from the thread's
 * own read of the briefs it was sent. Its start is only ever the brief that started it, never a later send's. Once both
 * reads have answered and neither holds anything of it, its outcome is unknown, never guessed.
 */
function rowOf(thread: AgentThread, level: 1 | 2, delegatedBy: string | undefined, parent: DelegationReadOf | undefined, own: DelegationReadOf | undefined, host: AgentHostSnapshot,
  machine: RosterMachine): DelegatedRosterRow {
  const known = new Map(delegatedViewsOf(thread.id, parent?.made ?? []).map(view => [view.id, view] as const))
  for (const view of own?.received ?? []) if (!known.has(view.id)) known.set(view.id, view)
  const views = [...known.values()].sort((first, second) => time(first.createdAt) - time(second.createdAt))
  const newest = views.at(-1)
  const start = views.find(view => view.action === 'start')
  const startedAt = time(start?.createdAt)
  const waitingFor = threadWaitingFor(thread)
  const working = newest?.outcome === 'working' || newest?.outcome === 'background'
  const provider = thread.providerId ? PROVIDER_LABELS[thread.providerId] : undefined
  const model = resolveModel(hostForThread(host, thread).models, thread.modelId)?.name
  const work = start?.work ?? newest?.work
  const meta = [provider, work ? DELEGATION_WORK_TITLES[work] : undefined, model, thread.reasoningEffort ? effortLabel(thread.reasoningEffort) : undefined,
    Number.isFinite(startedAt) ? clockLabel(startedAt) : undefined].filter((fact): fact is string => fact !== undefined && fact !== '')
  // A thread on another host keeps its delegation on that host. Where this computer cannot read it there (no Work across
  // machines, an older host, a host away with nothing read, or a read not answered yet), what the snapshot says of it
  // stands in, Working while its turn runs, and nothing at all otherwise. Where both reads answered from that host's own
  // record and neither holds it, as once its ended records are trimmed, its outcome is unknown, as on this computer.
  const readThere = machine.remote && parent !== undefined && own !== undefined && parent.unread === undefined && own.unread === undefined
  const remote = thread.remoteHost === true && newest === undefined && !readThere
  const outcome = remote ? (isThreadTurnRunning(thread) ? 'working' : undefined)
    : newest?.outcome ?? (parent !== undefined && own !== undefined ? 'unknown' : undefined)
  const status = threadNeedsYou(thread) ? 'needs' : outcome
  // What Sotto holds of a thread on another machine is as it last read it there whenever main says so (`lastReadAt`), a
  // failed read on a connection still up included, and whenever that machine is not connected: greyed, never current.
  const markedAt = parent?.lastReadAt ?? own?.lastReadAt
  const lastRead = machine.remote && (!machine.connected || markedAt !== undefined)
  const asOf = lastRead ? markedAt ?? Number.NaN : Number.NaN
  return { thread, level, delegatedBy, newest, startedAt, endedAt: working ? Number.NaN : time(newest?.outcomeAt), waitingFor,
    status, finished: !lastRead && thread.finishedUnread === true && status !== 'needs' && status !== 'working' && status !== 'background',
    brief: briefOf(thread, views), meta, provider, machine, lastRead, asOf, held: start?.held }
}

const newestFirst = (first: { readonly startedAt: number }, second: { readonly startedAt: number }): number => {
  const a = Number.isFinite(first.startedAt) ? first.startedAt : Number.NEGATIVE_INFINITY
  const b = Number.isFinite(second.startedAt) ? second.startedAt : Number.NEGATIVE_INFINITY
  return b - a
}

/**
 * The delegated threads below `ownerId`, two levels, each first-level one followed by its own, newest start first. `reads`
 * holds the window's reads by thread: the owner's and each first-level thread's that delegated, and a delegated thread's
 * own where its delegating thread's read no longer holds the brief that started it (`threadsMissingStarts`).
 */
export function delegatedRoster(ownerId: string, threads: readonly AgentThread[], reads: DelegationReads, host: AgentHostSnapshot,
  machineOf: (thread: AgentThread) => RosterMachine = () => THIS_COMPUTER): DelegatedRosterRow[][] {
  return families(ownerId, threads).map(({ thread, below }) => ({ row: rowOf(thread, 1, undefined, reads.get(ownerId), reads.get(thread.id), host, machineOf(thread)), below }))
    .sort((first, second) => newestFirst(first.row, second.row))
    .map(({ row, below }) => [row, ...below.map(child => rowOf(child, 2, row.thread.title, reads.get(row.thread.id), reads.get(child.id), host, machineOf(child))).sort(newestFirst)])
}

/**
 * The machine a thread runs on, as the window names its hosts: This computer for its own, a paired host by its name, and
 * whether the window is connected to it now (#1310).
 */
export function rosterMachine(connections: AgentState['connections'], thread: Pick<AgentThread, 'hostId' | 'remoteHost' | 'hostLabel' | 'clientConnected' | 'clientReconnecting'>): RosterMachine {
  if (thread.remoteHost !== true) return { ...THIS_COMPUTER, hostId: thread.hostId }
  const listed = connections?.find(item => item.hostId === thread.hostId)
  return { hostId: thread.hostId, name: listed?.name ?? thread.hostLabel ?? t`Remote host`, remote: true,
    connected: (listed?.connected ?? thread.clientConnected !== false) && thread.clientReconnecting !== true }
}

/** One machine's part of a roster grouped by machine (variant B of the remote roster prototype, #1310). */
export interface RosterMachineGroup {
  readonly machine: RosterMachine
  readonly families: readonly DelegatedRosterRow[][]
  /** Whether this is the delegating thread's own machine, whose provider's agents are listed with it. */
  readonly own: boolean
  /** Sotto could not read these threads' delegations there: that machine's Sotto does not offer them. */
  readonly olderHost: boolean
}

/**
 * The roster grouped under a heading per machine (Zach's pick, variant B, October 23, 2026, #1310), or null where it is
 * not: only with Work across machines on, and only when the delegating thread or one of its delegated threads runs on
 * another machine than this computer, so a roster of this computer's threads alone keeps its single list. The delegating
 * thread's own machine comes first, then the others by name. `ownerRead` is the delegating thread's own read.
 */
export function rosterByMachine(owner: RosterMachine, families: readonly DelegatedRosterRow[][], reads: DelegationReads, ownerRead: DelegationReadOf | undefined,
  crossMachine: boolean): RosterMachineGroup[] | null {
  if (!crossMachine || !owner.remote && families.every(family => family.every(row => !row.machine.remote))) return null
  const keyOf = (machine: RosterMachine): string => machine.remote ? machine.hostId ?? machine.name : ''
  const ownKey = keyOf(owner)
  const groups = new Map<string, { machine: RosterMachine; families: DelegatedRosterRow[][] }>([[ownKey, { machine: owner, families: [] }]])
  for (const family of families) {
    const first = family[0]
    if (!first) continue
    // Before #1316 a delegated thread runs where the thread that delegated to it runs, so a family stays together.
    const key = keyOf(first.machine)
    const group = groups.get(key) ?? { machine: first.machine, families: [] }
    group.families.push(family)
    groups.set(key, group)
  }
  const olderHost = (key: string, group: { readonly families: readonly DelegatedRosterRow[][] }): boolean => (key === ownKey && ownerRead?.unread === 'older-host')
    || group.families.some(family => family.some(row => reads.get(row.thread.id)?.unread === 'older-host'))
  return [...groups.entries()].sort(([first, a], [second, b]) => first === ownKey ? -1 : second === ownKey ? 1 : a.machine.name.localeCompare(b.machine.name))
    .map(([key, group]) => ({ machine: group.machine, families: group.families, own: key === ownKey, olderHost: group.machine.remote && olderHost(key, group) }))
}

/**
 * A machine's heading count: "5 threads · 2 agents · 1 working", without what is working while it is not connected
 * (variant B). The agents are the delegating thread's provider's own, on its own machine.
 */
export function machineCount(group: Pick<RosterMachineGroup, 'machine' | 'families'>, agents: Pick<SubagentSummary, 'total' | 'working'> | undefined): string {
  const rows = group.families.flat()
  const working = rows.filter(row => !row.lastRead && (row.status === 'working' || row.status === 'background')).length + (agents?.working ?? 0)
  const threads = rows.length, agentCount = agents?.total ?? 0
  // Each count is a plural message, so `#` is the number written in the reader's own digits (the translation glossary).
  return [pluralMessage(threads, { one: '# thread', other: '# threads' }), ...agentCount ? [pluralMessage(agentCount, { one: '# agent', other: '# agents' })] : [],
    ...group.machine.connected && working ? [pluralMessage(working, { one: '# working', other: '# working' })] : []].join(' · ')
}

function families(ownerId: string, threads: readonly AgentThread[]): { readonly thread: AgentThread; readonly below: readonly AgentThread[] }[] {
  const children = new Map<string, AgentThread[]>()
  for (const thread of threads) if (thread.delegatedBy !== undefined && thread.delegatedBy !== thread.id) children.set(thread.delegatedBy, [...children.get(thread.delegatedBy) ?? [], thread])
  const first = (children.get(ownerId) ?? []).filter(thread => thread.id !== ownerId)
  const firstIds = new Set(first.map(thread => thread.id))
  return first.map(thread => ({ thread, below: (children.get(thread.id) ?? []).filter(child => child.id !== ownerId && !firstIds.has(child.id)) }))
}

/**
 * The delegated threads whose delegating thread's read has answered without the brief that started them: their own read
 * of the briefs they were sent is asked for too, and only theirs.
 */
export function threadsMissingStarts(ownerId: string, threads: readonly AgentThread[], reads: DelegationReads): string[] {
  const missing = (thread: AgentThread, parent: string): boolean => {
    const made = reads.get(parent)?.made
    return made !== undefined && !delegatedViewsOf(thread.id, made).some(view => view.action === 'start')
  }
  return families(ownerId, threads).flatMap(({ thread, below }) => [...missing(thread, ownerId) ? [thread.id] : [], ...below.filter(child => missing(child, thread.id)).map(child => child.id)])
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
  // A row whose machine is not connected is only as Sotto last read it, so it is not counted as working now (#1310).
  const working = rows.filter(row => !row.lastRead && (row.status === 'working' || row.status === 'background')).length + summary.working
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
