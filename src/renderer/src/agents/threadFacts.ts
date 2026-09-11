import type { AgentAssignment, AgentModel, AgentProject, AgentQueueItem, AgentState, AgentThread } from '../../../shared/agents'
import { isThreadClosed } from '../../../shared/threadActivity'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/** What the Threads page says a thread is doing; every value derives from Sotto's own state. */
export type ThreadRowState = 'needs' | 'working' | 'stopped' | 'done'

/** The badge tint for a provider; `other` is the neutral badge for a provider Sotto has no colour for. */
export type ProviderKey = 'claude' | 'codex' | 'grok' | 'other'

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
  readonly state: ThreadRowState
  readonly stateLabel: string
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
}

/** The badge tint for a provider name as the provider reports it (a model's `provider` field), never a model's display name. */
export function providerKey(provider: string): ProviderKey {
  return PROVIDER_KEYS[provider.trim().toLocaleLowerCase()] ?? 'other'
}

/** Sotto's badge glyph for an agent provider; an unknown provider gets its initial. */
export function providerGlyph(provider: string): string {
  const glyph = { claude: 'C', codex: '›_', grok: 'X', other: provider.trim().charAt(0).toLocaleUpperCase() }[providerKey(provider)]
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

function startOfDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.valueOf()
}

/** Group labels for finished threads: today, yesterday, then the weekday and date. */
export function dayLabel(at: number, now: number): string {
  const today = startOfDay(now)
  if (at >= today) return 'Finished today'
  if (at >= today - DAY_MS) return 'Yesterday'
  return new Date(at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

/** A clock for today, otherwise the weekday and clock, so "Started" reads right from any group. */
export function startedLabel(at: number, now: number): string {
  const clock = clockLabel(at)
  if (at >= startOfDay(now)) return clock
  if (at >= startOfDay(now) - DAY_MS) return `yesterday ${clock}`
  return `${new Date(at).toLocaleDateString(undefined, { weekday: 'long' })} ${clock}`
}

function originLabel(origin: AgentAssignment['origin']): string {
  return origin === 'voice' ? 'a voice prompt' : origin === 'typed' ? 'a typed prompt' : 'a prompt'
}

/** Why Sotto stopped managing, as the clause after "stopped": "at the follow-up limit", "because…", "after an error". */
export function stopReasonLabel(reason: AgentAssignment['stopReason']): string {
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

function describe(state: AgentState, thread: AgentThread, now: number): ThreadRow {
  const project = state.host.projects.find(entry => entry.id === thread.projectId)
  const model = state.host.models.find(entry => entry.id === thread.modelId)
  const assignment = state.assignments.find(entry => entry.threadId === thread.id)
  const provider = model?.provider ?? state.host.name
  const lastAssistant = thread.messages.findLast(entry => entry.role === 'assistant')
  const lastUser = thread.messages.findLast(entry => entry.role === 'user')
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
    ...thread.messages.map(message => parse(message.createdAt))]
    .reduce((latest, at) => Number.isFinite(at) && (!Number.isFinite(latest) || at > latest) ? at : latest, Number.NaN)

  let state_: ThreadRowState
  let stateLabel: string
  let sentence: string
  let sentenceFromUser = false
  if (closed) {
    state_ = 'done'
    stateLabel = Number.isFinite(parse(thread.archivedAt)) ? 'Archived' : 'Settled'
    sentence = lastAssistant?.text ?? 'This thread is closed. Its history is still available.'
  } else if (decision !== undefined || (blocked !== undefined && !stopped) || thread.status === 'error') {
    state_ = 'needs'
    stateLabel = thread.status === 'error' && decision === undefined && blocked === undefined ? 'Needs attention' : 'Waiting on you'
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

  return {
    thread, project, model, assignment, provider, providerKey: providerKey(provider), state: state_, stateLabel, request: decision, attention,
    sentence, activityAt,
    when: state_ === 'working' ? elapsedLabel(activityAt, now) : clockLabel(activityAt),
    facts: factsLine(assignment, model, provider, management, state.configuration.followupLimit, now),
    lastMessage, management,
  }
}

/** Every thread Sotto knows, described from its own state. */
export function describeThreads(state: AgentState, now: number): ThreadRow[] {
  return state.host.threads.map(thread => describe(state, thread, now))
}

/** A row matches when the query appears anywhere in it: title, project, provider, sentence, facts or your last message. */
export function matchesThreadQuery(row: ThreadRow, query: string): boolean {
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

/** Explicitly unsettled work and settled/archived history; unknown activity sorts last. */
export function groupThreads(rows: readonly ThreadRow[], _now?: number): ThreadGroup[] {
  // Retain the old clock argument for callers; lifecycle grouping does not use it.
  void _now
  const sorted = [...rows].sort((first, second) => {
    const firstAt = Number.isFinite(first.activityAt) ? first.activityAt : Number.NEGATIVE_INFINITY
    const secondAt = Number.isFinite(second.activityAt) ? second.activityAt : Number.NEGATIVE_INFINITY
    return (secondAt - firstAt) || first.thread.id.localeCompare(second.thread.id)
  })
  const unsettled = sorted.filter(row => !isThreadClosed(row.thread))
  const settled = sorted.filter(row => isThreadClosed(row.thread))
  const groups: ThreadGroup[] = []
  if (unsettled.length > 0) groups.push({ id: 'unsettled', label: 'Unsettled', tone: 'plain', rows: unsettled })
  if (settled.length > 0) groups.push({ id: 'settled', label: 'Settled', tone: 'plain', rows: settled })
  return groups
}

/**
 * The footer's one sentence on the Threads page and in the Agents room, from
 * the number of threads Sotto is looking after: "Sotto is looking after 3
 * threads. Say “Hey Sotto” to talk to any of them."
 */
export function lookingAfterSentence(count: number): string {
  if (count <= 0) return 'Nothing is running. Say “Hey Sotto” to start a thread.'
  if (count === 1) return 'Sotto is looking after 1 thread. Say “Hey Sotto” to talk to it.'
  return `Sotto is looking after ${count} threads. Say “Hey Sotto” to talk to any of them.`
}

/** "3 active, 11 this week": active is needs you plus running; this week is any activity in the last seven days. */
export function threadCounts(rows: readonly ThreadRow[], now: number): { readonly active: number; readonly week: number } {
  return {
    active: rows.filter(row => row.state === 'needs' || row.state === 'working').length,
    week: rows.filter(row => row.activityAt >= now - WEEK_MS).length,
  }
}
