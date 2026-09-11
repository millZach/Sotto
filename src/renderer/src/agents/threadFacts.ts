import type { AgentAssignment, AgentModel, AgentProject, AgentQueueItem, AgentState, AgentThread } from '../../../shared/agents'

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

/** What the Threads page says a thread is doing; every value derives from Sotto's own state. */
export type ThreadRowState = 'needs' | 'working' | 'stopped' | 'done'

export interface ThreadLastMessage {
  readonly who: string
  readonly at: number
  readonly text: string
}

export interface ThreadRow {
  readonly thread: AgentThread
  readonly project: AgentProject | undefined
  readonly model: AgentModel | undefined
  readonly assignment: AgentAssignment | undefined
  /** Badge and "Claude, in workshop": the model's provider name, or the host when the model is unknown. */
  readonly provider: string
  readonly state: ThreadRowState
  readonly stateLabel: string
  /** The queue item waiting on a decision, when the row carries one inline. */
  readonly request: AgentQueueItem | undefined
  /** One sentence of what is happening now. */
  readonly sentence: string
  /** The instant used for ordering, day grouping and the clock beside the row. */
  readonly activityAt: number
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

const parse = (value: string | undefined): number => {
  if (value === undefined || value === '') return Number.NaN
  return Date.parse(value)
}

/** Sotto's badge glyph for an agent provider; unknown providers get their initial. */
export function providerGlyph(provider: string): string {
  const key = provider.trim().toLocaleLowerCase()
  if (key.startsWith('claude') || key.startsWith('anthropic')) return 'C'
  if (key.startsWith('codex') || key.startsWith('openai') || key.startsWith('chatgpt') || key.startsWith('gpt')) return '›_'
  if (key.startsWith('grok') || key.startsWith('xai')) return 'X'
  return (key[0] ?? '?').toLocaleUpperCase()
}

export function clockLabel(at: number): string {
  const date = new Date(at)
  if (!Number.isFinite(date.valueOf())) return ''
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLocaleLowerCase()
}

/** "4 min", "2 h", "3 d": how long a working thread has been at it. */
export function elapsedLabel(since: number, now: number): string {
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

/** The facts line under an open row: how it started, who is managing, follow-ups, the model. */
export function threadFacts(row: ThreadRow, followupLimit: number, now: number): { readonly lead: string; readonly rest: string } {
  const { assignment, model } = row
  const startedAt = parse(assignment?.startedAt)
  const lead = assignment !== undefined && Number.isFinite(startedAt)
    ? `Started ${startedLabel(startedAt, now)} from ${originLabel(assignment.origin)}.`
    : ''
  const parts: string[] = []
  if (assignment === undefined) parts.push('Sotto is not managing this thread.')
  else {
    const used = `${assignment.followups} of ${followupLimit} follow-ups used`
    if (row.management === 'stopped') {
      parts.push(assignment.stopReason === 'limit'
        ? `Sotto stopped it at the follow-up limit, ${used}.`
        : assignment.stopReason === 'repeat'
          ? `Sotto stopped it because the same failure kept repeating, ${used}.`
          : `Sotto stopped it after an error, ${used}.`)
    } else if (row.management === 'manual') parts.push(`You are managing it directly and Sotto is watching, ${used}.`)
    else if (row.management === 'paused') parts.push(`Managing is paused, ${used}.`)
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
  const last = thread.messages.at(-1)
  const lastAssistant = thread.messages.findLast(entry => entry.role === 'assistant')
  const lastUser = thread.messages.findLast(entry => entry.role === 'user')
  const decision = state.queue.find(item => item.threadId === thread.id && (item.kind === 'question' || item.kind === 'permission'))
  const blocked = state.queue.find(item => item.threadId === thread.id && item.kind === 'blocked')
  const stopped = assignment !== undefined && assignment.stopReason !== 'none'
  const management: ThreadRow['management'] = assignment === undefined ? 'none'
    : stopped ? 'stopped'
      : assignment.mode === 'manual' ? 'manual'
        : assignment.paused ? 'paused' : 'managed'
  const lastAt = parse(last?.createdAt)
  const stoppedAt = parse(assignment?.stoppedAt)
  const startedAt = parse(assignment?.startedAt)
  const activityAt = [lastAt, stoppedAt, startedAt].find(Number.isFinite) ?? now

  const lastMessage: ThreadLastMessage | undefined = last === undefined ? undefined : {
    who: last.role === 'user' ? (assignment?.ownMessageIds.includes(last.id) ? 'Sotto' : 'You') : provider,
    at: Number.isFinite(lastAt) ? lastAt : activityAt,
    text: last.text,
  }

  let state_: ThreadRowState
  let stateLabel: string
  let sentence: string
  if (decision !== undefined || (blocked !== undefined && !stopped) || thread.status === 'error') {
    state_ = 'needs'
    stateLabel = thread.status === 'error' && decision === undefined && blocked === undefined ? 'Needs attention' : 'Waiting on you'
    sentence = decision !== undefined
      ? (lastAssistant?.text ?? decision.text)
      : blocked !== undefined ? blocked.text : (lastAssistant?.text ?? 'The agent reported an error. Open the transcript to see what happened.')
  } else if (stopped) {
    state_ = 'stopped'
    stateLabel = 'Stopped'
    sentence = assignment.stopReason === 'limit'
      ? `Stopped after ${assignment.followups} follow-ups without finishing. ${lastAssistant?.text ?? ''}`.trim()
      : assignment.stopReason === 'repeat'
        ? `Stopped because the same failure kept repeating. ${lastAssistant?.text ?? ''}`.trim()
        : `Stopped after an error. ${blocked?.text ?? lastAssistant?.text ?? ''}`.trim()
  } else if (thread.status === 'running') {
    state_ = 'working'
    stateLabel = 'Working'
    sentence = lastAssistant !== undefined && (lastUser === undefined || parse(lastAssistant.createdAt) >= parse(lastUser.createdAt))
      ? lastAssistant.text
      : lastUser !== undefined ? `Working on “${lastUser.text}”.` : 'Working on your prompt.'
  } else {
    state_ = 'done'
    stateLabel = management === 'paused' ? 'Paused' : 'Done'
    sentence = lastAssistant?.text ?? (lastUser !== undefined ? `Waiting to start on “${lastUser.text}”.` : 'Ready for your next prompt.')
  }

  return { thread, project, model, assignment, provider, state: state_, stateLabel, request: decision, sentence, activityAt, lastMessage, management }
}

/** Every thread Sotto knows, described from its own state. */
export function describeThreads(state: AgentState, now: number): ThreadRow[] {
  return state.host.threads.map(thread => describe(state, thread, now))
}

/** A row matches when the query appears in its title, project, provider or current sentence. */
export function matchesThreadQuery(row: ThreadRow, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return true
  return [row.thread.title, row.project?.title ?? '', row.provider, row.sentence]
    .some(field => field.toLocaleLowerCase().includes(needle))
}

/** Needs you, Running, then finished threads by day, newest first inside each group. */
export function groupThreads(rows: readonly ThreadRow[], now: number): ThreadGroup[] {
  const sorted = [...rows].sort((first, second) => second.activityAt - first.activityAt)
  const needs = sorted.filter(row => row.state === 'needs')
  const running = sorted.filter(row => row.state === 'working')
  const groups: ThreadGroup[] = []
  if (needs.length > 0) groups.push({ id: 'needs', label: 'Needs you', tone: 'needs', rows: needs })
  if (running.length > 0) groups.push({ id: 'running', label: 'Running', tone: 'plain', rows: running })
  for (const row of sorted) {
    if (row.state === 'needs' || row.state === 'working') continue
    const label = dayLabel(row.activityAt, now)
    const group = groups.at(-1)
    if (group !== undefined && group.id === `day:${label}`) groups[groups.length - 1] = { ...group, rows: [...group.rows, row] }
    else groups.push({ id: `day:${label}`, label, tone: 'plain', rows: [row] })
  }
  return groups
}

/** "3 active, 11 this week": active is needs you plus running; this week is any activity in the last seven days. */
export function threadCounts(rows: readonly ThreadRow[], now: number): { readonly active: number; readonly week: number } {
  return {
    active: rows.filter(row => row.state === 'needs' || row.state === 'working').length,
    week: rows.filter(row => row.activityAt >= now - WEEK_MS).length,
  }
}
