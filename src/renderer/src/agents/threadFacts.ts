import { hostForThread, PROVIDER_LABELS, isThreadProviderConnected, threadSummaryOf, type AgentAssignment, type AgentModel, type AgentProject, type AgentQueueItem, type AgentState, type AgentThread, type ProviderId } from '../../../shared/agents'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../../shared/threadActivity'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/** What the Threads page says a thread is doing; every value derives from Sotto's own state. */
export type ThreadRowState = 'needs' | 'working' | 'stopped' | 'done'

/** The badge tint for a provider; `other` is the neutral badge for a provider Sotto has no colour for. */
export type ProviderKey = 'claude' | 'codex' | 'grok' | 'devin' | 'other'

export interface ThreadLastMessage {
  readonly who: string
  readonly at: number
  readonly text: string
}

export interface ThreadFactsLine {
  /** "Started 12:32 pm from a voice prompt." or empty when the assignment has no start time. */
  readonly lead: string
  readonly rest: string
}

export interface ThreadRow {
  readonly thread: AgentThread
  readonly project: AgentProject | undefined
  readonly model: AgentModel | undefined
  readonly assignment: AgentAssignment | undefined
  /** "Claude, in workshop": the model's provider name, or the connected provider when the model is unknown. */
  readonly provider: string
  readonly providerKey: ProviderKey
  /** The thread's native provider when Sotto can tell; undefined for an unrecognized provider. */
  readonly providerId: ProviderId | undefined
  /** Whether the thread's own provider is connected; history stays readable either way. */
  readonly connected: boolean
  /** Why the row sits in Settled: its project, its own choice, or the provider closed it. Null when open. */
  readonly settledBy: 'project' | 'thread' | 'provider' | null
  readonly state: ThreadRowState
  readonly stateLabel: string
  /** What a row that needs you is waiting for: a permission to allow or deny, or a question to answer. */
  readonly waitingFor: 'approval' | 'question' | null
  /** The queue item waiting on a decision, when the row carries one inline. */
  readonly request: AgentQueueItem | undefined
  /** In the attention queue: a pending request or any queue entry. Search never hides these rows. */
  readonly attention: boolean
  /** One sentence of what is happening now. */
  readonly sentence: string
  /** Last known activity for ordering and the row clock; NaN when unknown. */
  readonly activityAt: number
  /** Beside the state: how long a working thread has been at it, otherwise the clock of its last activity. */
  readonly when: string
  /** When the run on screen started, for the sidebar's live clock; NaN when the thread is not working. */
  readonly workingSince: number
  /** The facts line under an open row: how it started, who is managing, follow-ups, the model. */
  readonly facts: ThreadFactsLine
  /** Your side of the thread, shown under an open row; the sentence already carries the provider's. */
  readonly lastMessage: ThreadLastMessage | undefined
  /** Whether the thread is managing/managed and what the detail's buttons should offer. */
  readonly management: 'none' | 'managed' | 'paused' | 'manual' | 'stopped'
}

export interface ThreadGroup {
  readonly id: string
  readonly label: string
  readonly tone: 'needs' | 'plain'
  readonly rows: readonly ThreadRow[]
}

const parse = (value: string | null | undefined): number => {
  if (value == null || value === '') return Number.NaN
  return Date.parse(value)
}

const PROVIDER_KEYS: Readonly<Record<string, ProviderKey>> = {
  claude: 'claude', anthropic: 'claude',
  codex: 'codex', openai: 'codex', chatgpt: 'codex',
  grok: 'grok', xai: 'grok',
  devin: 'devin', cognition: 'devin',
}

/** The badge tint for a provider name as the provider reports it (a model's `provider` field), never a model's display name. */
export function providerKey(provider: string): ProviderKey {
  return PROVIDER_KEYS[provider.trim().toLocaleLowerCase()] ?? 'other'
}

/** Sotto's badge glyph for an agent provider; an unknown provider gets its initial. */
export function providerGlyph(provider: string): string {
  const glyph = { claude: 'C', codex: '›_', grok: 'X', devin: 'D', other: provider.trim().charAt(0).toLocaleUpperCase() }[providerKey(provider)]
  return glyph === '' ? '?' : glyph
}

export function clockLabel(at: number): string {
  const date = new Date(at)
  if (!Number.isFinite(date.valueOf())) return ''
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLocaleLowerCase()
}

/** "4 min", "2 h", "3 d": how long a working thread has been at it. */
export function elapsedLabel(since: number, now: number): string {
  if (!Number.isFinite(since) || !Number.isFinite(now)) return ''
  const minutes = Math.max(0, Math.floor((now - since) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/** "12s", "4m 05s", "2h 07m": a working thread's clock, counted in whole seconds so it can tick. */
export function workingLabel(since: number, now: number): string {
  if (!Number.isFinite(since) || !Number.isFinite(now)) return ''
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d`
}

function startOfDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.valueOf()
}

/** A clock for today, otherwise the weekday and clock, so "Started" reads right from any group. */
function startedLabel(at: number, now: number): string {
  const clock = clockLabel(at)
  if (at >= startOfDay(now)) return clock
  if (at >= startOfDay(now) - DAY_MS) return `yesterday ${clock}`
  return `${new Date(at).toLocaleDateString(undefined, { weekday: 'long' })} ${clock}`
}

function originLabel(origin: AgentAssignment['origin']): string {
  return origin === 'voice' ? 'a voice prompt' : origin === 'typed' ? 'a typed prompt' : 'a prompt'
}

/** Why Sotto stopped managing, as the clause after "stopped": "at the follow-up limit", "because…", "after an error". */
function stopReasonLabel(reason: AgentAssignment['stopReason']): string {
  return reason === 'limit' ? 'at the follow-up limit'
    : reason === 'repeat' ? 'because the same failure kept repeating'
      : 'after an error'
}

function factsLine(assignment: AgentAssignment | undefined, model: AgentModel | undefined, provider: string,
  management: ThreadRow['management'], followupLimit: number, now: number): ThreadFactsLine {
  const startedAt = parse(assignment?.startedAt)
  const lead = assignment !== undefined && Number.isFinite(startedAt)
    ? `Started ${startedLabel(startedAt, now)} from ${originLabel(assignment.origin)}.`
    : ''
  const parts: string[] = []
  if (assignment === undefined) parts.push('Sotto is not managing this thread.')
  else {
    const used = `${assignment.followups} of ${followupLimit} follow-ups used`
    if (management === 'stopped') parts.push(`Sotto stopped it ${stopReasonLabel(assignment.stopReason)}, ${used}.`)
    else if (management === 'manual') parts.push(`You took over in ${provider}; Sotto is watching, ${used}.`)
    else if (management === 'paused') parts.push(`Managing is paused, ${used}.`)
    else parts.push(`Sotto is managing it, ${used}.`)
  }
  if (model !== undefined) parts.push(`${model.name} from ${model.provider}.`)
  return { lead, rest: parts.join(' ') }
}

/** When the run on screen began: the provider's running turn if it reported one, otherwise your last prompt. */
function runStartedAt(thread: AgentThread, lastUserAt: number, activityAt: number): number {
  // The shell stream carries the running turn's start in the summary; a full state still has the record.
  const started = parse(threadSummaryOf(thread).runningTurnStartedAt)
  return Number.isFinite(started) ? started : Number.isFinite(lastUserAt) ? lastUserAt : activityAt
}

function describe(state: AgentState, thread: AgentThread, now: number): ThreadRow {
  const project = state.host.projects.find(entry => entry.id === thread.projectId)
  const model = hostForThread(state.host, thread).models.find(entry => entry.id === thread.modelId)
  const assignment = state.assignments.find(entry => entry.threadId === thread.id)
  const provider = model?.provider ?? (thread.providerId ? PROVIDER_LABELS[thread.providerId] : state.host.name)
  // A row's history facts come from the thread's summary: the shell stream carries it in place of the
  // messages, and a thread whose messages did arrive derives exactly the same thing.
  const { lastAssistant, lastUser, lastMessageAt } = threadSummaryOf(thread)
  const closed = isThreadClosed(thread)
  const decision = closed ? undefined : state.queue.find(item => item.threadId === thread.id && (item.kind === 'question' || item.kind === 'permission'))
  const blocked = state.queue.find(item => item.threadId === thread.id && item.kind === 'blocked')
  const attention = !closed && (thread.requests.length > 0 || state.queue.some(item => item.threadId === thread.id))
  // Once you take over, Sotto's earlier stop is history: manual outranks stopped.
  const management: ThreadRow['management'] = assignment === undefined ? 'none'
    : assignment.mode === 'manual' ? 'manual'
      : assignment.stopReason !== 'none' ? 'stopped'
        : assignment.paused ? 'paused' : 'managed'
  const stopped = assignment !== undefined && management === 'stopped'
  const stoppedAt = parse(assignment?.stoppedAt)
  const startedAt = parse(assignment?.startedAt)
  const activityAt = [parse(thread.updatedAt), parse(thread.settledAt), parse(thread.archivedAt), stoppedAt, startedAt,
    parse(lastMessageAt)]
    .reduce((latest, at) => Number.isFinite(at) && (!Number.isFinite(latest) || at > latest) ? at : latest, Number.NaN)

  let state_: ThreadRowState
  let stateLabel: string
  let sentence: string
  let sentenceFromUser = false
  let waitingFor: ThreadRow['waitingFor'] = null
  if (closed) {
    state_ = 'done'
    stateLabel = Number.isFinite(parse(thread.archivedAt)) ? 'Archived' : 'Settled'
    sentence = lastAssistant?.text ?? 'This thread is closed. Its history is still available.'
  } else if (decision !== undefined || (blocked !== undefined && !stopped) || thread.status === 'error') {
    state_ = 'needs'
    // A permission holds the agent still until you allow or deny it, so it outranks a question here as it does in the composer.
    const kinds = [decision?.kind, ...thread.requests.map(request => request.kind)]
    waitingFor = kinds.includes('permission') ? 'approval' : kinds.includes('question') ? 'question' : null
    stateLabel = waitingFor === 'approval' ? 'Needs your approval' : waitingFor === 'question' ? 'Needs your answer'
      : thread.status === 'error' && decision === undefined && blocked === undefined ? 'Needs attention' : 'Waiting on you'
    sentence = decision !== undefined
      ? (lastAssistant?.text ?? decision.text)
      : blocked !== undefined ? blocked.text : (lastAssistant?.text ?? 'The agent reported an error. Open the transcript to see what happened.')
  } else if (stopped) {
    state_ = 'stopped'
    stateLabel = 'Stopped'
    const detail = assignment.stopReason === 'error' ? blocked?.text ?? lastAssistant?.text : lastAssistant?.text
    sentence = `Stopped ${stopReasonLabel(assignment.stopReason)}. ${detail ?? ''}`.trim()
  } else if (thread.status === 'running') {
    state_ = 'working'
    stateLabel = 'Working'
    if (lastAssistant !== undefined && (lastUser === undefined || parse(lastAssistant.createdAt) >= parse(lastUser.createdAt))) sentence = lastAssistant.text
    else if (lastUser !== undefined) { sentence = `Working on “${lastUser.text}”.`; sentenceFromUser = true }
    else sentence = 'Working on your prompt.'
  } else {
    state_ = 'done'
    stateLabel = management === 'paused' ? 'Paused' : 'Done'
    if (lastAssistant !== undefined) sentence = lastAssistant.text
    else if (lastUser !== undefined) { sentence = `Waiting to start on “${lastUser.text}”.`; sentenceFromUser = true }
    else sentence = 'Ready for your next prompt.'
  }

  // The card never repeats the sentence: it shows your latest prompt, or nothing.
  const lastUserAt = parse(lastUser?.createdAt)
  const lastMessage: ThreadLastMessage | undefined = lastUser === undefined || sentenceFromUser ? undefined : {
    who: assignment?.ownMessageIds.includes(lastUser.id) ? 'Sotto' : 'You',
    at: Number.isFinite(lastUserAt) ? lastUserAt : activityAt,
    text: lastUser.text,
  }

  const workingSince = state_ === 'working' ? runStartedAt(thread, lastUserAt, activityAt) : Number.NaN
  const key = providerKey(provider)
  const settledBy: ThreadRow['settledBy'] = isWorkspaceThreadSettled({ workspaceSettledAt: null }, project) ? 'project'
    : isWorkspaceThreadSettled(thread) ? 'thread' : closed ? 'provider' : null
  return {
    thread, project, model, assignment, provider, providerKey: key, state: state_, stateLabel, waitingFor, request: decision, attention,
    providerId: thread.providerId ?? model?.providerId ?? (key === 'other' ? undefined : key),
    connected: isThreadProviderConnected(state.host, thread), settledBy,
    sentence, activityAt,
    when: state_ === 'working' ? workingLabel(workingSince, now) : clockLabel(activityAt), workingSince,
    facts: factsLine(assignment, model, provider, management, state.configuration.followupLimit, now),
    lastMessage, management,
  }
}

/** Every thread Sotto knows, described from its own state. */
export function describeThreads(state: AgentState, now: number): ThreadRow[] {
  return state.host.threads.map(thread => describe(state, thread, now))
}

/** A row matches when the query appears anywhere in it: title, project, provider, sentence, facts or your last message. */
function matchesThreadQuery(row: ThreadRow, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return true
  return [row.thread.title, row.project?.title ?? '', row.provider, row.sentence, row.facts.lead, row.facts.rest, row.lastMessage?.text ?? '']
    .some(field => field.toLocaleLowerCase().includes(needle))
}

/**
 * The rows a search leaves on the page. `matching` is what the query found;
 * `listed` adds the attention queue, which stays visible whatever you type.
 */
export function listThreads(rows: readonly ThreadRow[], query: string): { readonly matching: ThreadRow[]; readonly listed: ThreadRow[] } {
  const matching = rows.filter(row => matchesThreadQuery(row, query))
  return { matching, listed: rows.filter(row => row.attention || matching.includes(row)) }
}

/** Open work and Settled history (workspace-settled, provider-settled or archived); unknown activity sorts last. */
export function groupThreads(rows: readonly ThreadRow[], _now?: number): ThreadGroup[] {
  // Retain the old clock argument for callers; lifecycle grouping does not use it.
  void _now
  const sorted = [...rows].sort((first, second) => {
    const firstAt = Number.isFinite(first.activityAt) ? first.activityAt : Number.NEGATIVE_INFINITY
    const secondAt = Number.isFinite(second.activityAt) ? second.activityAt : Number.NEGATIVE_INFINITY
    return (secondAt - firstAt) || first.thread.id.localeCompare(second.thread.id)
  })
  const unsettled = sorted.filter(row => row.settledBy === null)
  const settled = sorted.filter(row => row.settledBy !== null)
  const groups: ThreadGroup[] = []
  if (unsettled.length > 0) groups.push({ id: 'unsettled', label: 'Unsettled', tone: 'plain', rows: unsettled })
  if (settled.length > 0) groups.push({ id: 'settled', label: 'Settled', tone: 'plain', rows: settled })
  return groups
}

/** "3 active, 11 this week": active is needs you plus running; this week is any activity in the last seven days. */
export function threadCounts(rows: readonly ThreadRow[], now: number): { readonly active: number; readonly week: number } {
  return {
    active: rows.filter(row => row.state === 'needs' || row.state === 'working').length,
    week: rows.filter(row => row.activityAt >= now - WEEK_MS).length,
  }
}

/** One project folder in the sidebar: a Sotto project ID and the threads listed beneath it. */
export interface ProjectFolder {
  /** The Sotto project ID; a thread whose project is unknown keeps its own project ID. */
  readonly id: string
  readonly project: AgentProject | undefined
  readonly title: string
  /** The whole project was settled; its folder sits in Settled with every thread. */
  readonly settled: boolean
  readonly rows: readonly ThreadRow[]
  readonly working: number
  readonly needs: number
  readonly activityAt: number
}

export interface WorkspaceOrganization {
  readonly open: readonly ProjectFolder[]
  readonly settled: readonly ProjectFolder[]
  /** Rows the query found, before attention rows are added back. */
  readonly matching: number
}

const byActivity = (first: { readonly activityAt: number; readonly id: string }, second: { readonly activityAt: number; readonly id: string }): number => {
  const firstAt = Number.isFinite(first.activityAt) ? first.activityAt : Number.NEGATIVE_INFINITY
  const secondAt = Number.isFinite(second.activityAt) ? second.activityAt : Number.NEGATIVE_INFINITY
  return (secondAt - firstAt) || first.id.localeCompare(second.id)
}

function folder(id: string, project: AgentProject | undefined, rows: readonly ThreadRow[], settled: boolean): ProjectFolder {
  const sorted = [...rows].sort((first, second) => byActivity({ activityAt: first.activityAt, id: first.thread.id }, { activityAt: second.activityAt, id: second.thread.id }))
  return {
    id, project, title: project?.title ?? rows[0]?.provider ?? 'Project', settled, rows: sorted,
    working: rows.filter(row => row.state === 'working').length,
    needs: rows.filter(row => row.state === 'needs').length,
    activityAt: rows.reduce((latest, row) => Number.isFinite(row.activityAt) && (!Number.isFinite(latest) || row.activityAt > latest) ? row.activityAt : latest, Number.NaN),
  }
}

/**
 * Project folders for the sidebar. Open folders hold each unsettled project's open threads;
 * Settled holds whole settled projects plus individually settled threads under their own project.
 * A search keeps attention rows and projects whose name matches; without a search an open project
 * with no threads yet (or the selected project) still shows so a thread can be started there.
 */
export function organizeWorkspace(state: AgentState, rows: readonly ThreadRow[], query: string, activeProjectId: string | null = null): WorkspaceOrganization {
  const { matching, listed } = listThreads(rows, query)
  const needle = query.trim().toLocaleLowerCase()
  const projectMatches = (project: AgentProject): boolean => needle !== '' && `${project.title} ${project.path}`.toLocaleLowerCase().includes(needle)
  const projects = new Map(state.host.projects.map(project => [project.id, project]))
  const threadsByProject = new Map<string, ThreadRow[]>()
  for (const row of rows) threadsByProject.set(row.thread.projectId, [...threadsByProject.get(row.thread.projectId) ?? [], row])
  const ids = new Set([...projects.keys(), ...threadsByProject.keys()])
  const open: ProjectFolder[] = []
  const settled: ProjectFolder[] = []
  for (const id of ids) {
    const project = projects.get(id)
    const all = threadsByProject.get(id) ?? []
    const nameMatch = project !== undefined && projectMatches(project)
    const shown = nameMatch ? all : all.filter(row => listed.includes(row))
    if (isWorkspaceThreadSettled({ workspaceSettledAt: null }, project)) {
      if (shown.length || nameMatch || (needle === '' && all.length === 0)) settled.push(folder(id, project, shown, true))
      continue
    }
    const openRows = shown.filter(row => row.settledBy === null)
    const settledRows = shown.filter(row => row.settledBy !== null)
    const emptyOpen = needle === '' && (all.length === 0 || id === activeProjectId) && openRows.length === 0
    if (openRows.length || emptyOpen || (nameMatch && !settledRows.length)) open.push(folder(id, project, openRows, false))
    if (settledRows.length) settled.push(folder(id, project, settledRows, false))
  }
  const ordered = (folders: ProjectFolder[]): ProjectFolder[] => folders.sort((first, second) => byActivity(first, second))
  return { open: ordered(open), settled: ordered(settled), matching: matching.length }
}
