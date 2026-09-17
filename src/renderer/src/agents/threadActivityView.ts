import type { AgentActivity } from '../../../shared/agentActivity'
import type { AgentMessage, AgentThread } from '../../../shared/agents'
import { formatTokenCount } from '../../../shared/threadUsage'

/**
 * Where a thread's activity records sit in its transcript and how they read. Provider neutral:
 * any adapter that writes `AgentThread.activities` gets the same placement and wording.
 */

export interface ActivityGroup {
  /** Stable while records are upserted: turn, anchor and the group's first observed record. */
  readonly key: string
  readonly turnId: string
  /** The message the group follows; null when it trails the conversation. */
  readonly anchorMessageId: string | null
  /** Tool, command, file, reasoning, plan, subagent and status records in first-observed order. */
  readonly records: readonly AgentActivity[]
  /** The turn's lifecycle record, carried by the turn's first group only. */
  readonly turn?: AgentActivity
}

export interface ActivityPlacement {
  readonly after: ReadonlyMap<string, readonly ActivityGroup[]>
  /** Follows the last message: records with no anchor Sotto can show. */
  readonly trailing: readonly ActivityGroup[]
}

const EMPTY: ActivityPlacement = { after: new Map(), trailing: [] }

/** The provider's turn lifecycle, as opposed to a status notice such as a retry. */
export function isTurnRecord(record: AgentActivity): boolean {
  return record.kind === 'turn'
}

const bySequence = (a: AgentActivity, b: AgentActivity): number => a.sequence - b.sequence

/**
 * Puts each record after the message it followed when the provider produced it. A record without
 * a known anchor joins the nearest anchored record of its own turn (earlier first); a turn with no
 * anchor at all trails the conversation. Records anchored above the rendered page stay hidden until
 * the reader shows earlier messages. Messages are never moved, renamed or duplicated.
 */
export function placeActivities(
  messages: readonly AgentMessage[],
  rendered: readonly AgentMessage[],
  activities: readonly AgentActivity[] | undefined,
  historyLoading = false,
): ActivityPlacement {
  if (!activities?.length) return EMPTY
  const known = new Set(messages.map(message => message.id))
  const order = new Map(messages.map((message, index) => [message.id, index]))
  const visible = new Set(rendered.map(message => message.id))
  const sorted = [...activities].sort(bySequence)

  const anchors = new Map<AgentActivity, string | null>()
  const lastByTurn = new Map<string, string>()
  for (const record of sorted) {
    const own = record.afterMessageId !== undefined && known.has(record.afterMessageId) ? record.afterMessageId : undefined
    const anchor = own ?? lastByTurn.get(record.turnId)
    if (anchor !== undefined) { lastByTurn.set(record.turnId, anchor); anchors.set(record, anchor) }
  }
  const nextByTurn = new Map<string, string>()
  for (const record of [...sorted].reverse()) {
    const anchor = anchors.get(record)
    if (anchor) nextByTurn.set(record.turnId, anchor)
    else anchors.set(record, nextByTurn.get(record.turnId) ?? null)
  }

  interface Draft { key: string; turnId: string; anchorMessageId: string | null; records: AgentActivity[]; turn?: AgentActivity; first: number; boundary?: boolean }
  const drafts = new Map<string, Draft>()
  for (const record of sorted) {
    const anchor = anchors.get(record) ?? null
    // A compaction is a boundary in the conversation, so it keeps a place of its own instead of joining the work of a turn.
    const id = record.kind === 'compaction' ? `compaction ${record.id}` : `${record.turnId} ${anchor ?? ''}`
    let draft = drafts.get(id)
    if (!draft) {
      draft = { key: `${record.turnId}:${anchor ?? 'end'}:${record.sequence}`, turnId: record.turnId, anchorMessageId: anchor, records: [], first: record.sequence,
        ...(record.kind === 'compaction' ? { boundary: true } : {}) }
      drafts.set(id, draft)
    }
    if (isTurnRecord(record)) draft.turn ??= record
    else draft.records.push(record)
  }

  // The lifecycle heads whichever of the turn's groups with work reads first in the transcript.
  const position = (draft: Draft): number => draft.anchorMessageId === null ? Number.POSITIVE_INFINITY : order.get(draft.anchorMessageId) ?? Number.POSITIVE_INFINITY
  const byTurn = new Map<string, Draft[]>()
  for (const draft of drafts.values()) byTurn.set(draft.turnId, [...byTurn.get(draft.turnId) ?? [], draft])
  for (const group of byTurn.values()) {
    const turn = group.find(draft => draft.turn)?.turn
    if (!turn) continue
    for (const draft of group) delete draft.turn
    const reading = [...group].sort((a, b) => position(a) - position(b) || a.first - b.first)
    ;(reading.find(draft => draft.records.length && !draft.boundary) ?? reading.find(draft => !draft.boundary) ?? reading[0]!).turn = turn
  }

  const after = new Map<string, ActivityGroup[]>()
  const trailing: ActivityGroup[] = []
  for (const draft of [...drafts.values()].sort((a, b) => a.first - b.first)) {
    if (!shouldShow(draft)) continue
    const group: ActivityGroup = { key: draft.key, turnId: draft.turnId, anchorMessageId: draft.anchorMessageId, records: draft.records, ...(draft.turn ? { turn: draft.turn } : {}) }
    if (draft.anchorMessageId === null) { if (!historyLoading) trailing.push(group) }
    else if (visible.has(draft.anchorMessageId)) after.set(draft.anchorMessageId, [...after.get(draft.anchorMessageId) ?? [], group])
  }
  return { after, trailing }
}

/** A lone lifecycle record is shown only when it says something the answer does not: the turn stopped or failed. The live row covers a running turn. */
function shouldShow(group: { records: readonly AgentActivity[]; turn?: AgentActivity }): boolean {
  if (group.records.length) return true
  const status = group.turn?.status
  return status === 'failed' || status === 'interrupted'
}

/**
 * The turn still in progress: its lifecycle record while the thread says it is running. A turn restored from a
 * provider's own history carries no record of Sotto's watching, so the turn's user message stands in for it and
 * the line reads without a clock rather than not at all.
 */
export function liveTurnId(thread: Pick<AgentThread, 'status' | 'activities' | 'messages'>): string | null {
  if (thread.status !== 'running') return null
  const turns = (thread.activities ?? []).filter(record => isTurnRecord(record) && record.status === 'running').sort(bySequence)
  return turns.at(-1)?.turnId ?? thread.messages.findLast(message => message.role === 'user')?.id ?? null
}

/** The most recent record of the live turn that is still running: the current action. */
export function currentAction(thread: Pick<AgentThread, 'activities'>, turnId: string): AgentActivity | undefined {
  return (thread.activities ?? []).filter(record => record.turnId === turnId && !isTurnRecord(record) && record.status === 'running').sort(bySequence).at(-1)
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** Native duration when reported, otherwise the recorded start and completion; undefined when neither exists. */
function recordDuration(record: Pick<AgentActivity, 'durationMs' | 'startedAt' | 'completedAt'>): number | undefined {
  if (record.durationMs !== undefined) return record.durationMs
  const start = record.startedAt ? Date.parse(record.startedAt) : Number.NaN
  const end = record.completedAt ? Date.parse(record.completedAt) : Number.NaN
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined
}

/**
 * Where the shown duration came from. `timingSource` describes the start time, so an observed start
 * with a native duration still reads as the provider's figure; Sotto's own figure is the span between
 * the times it recorded.
 */
export function timingNote(record: AgentActivity, provider: string): string {
  if (record.status === 'running') return ''
  const duration = recordDuration(record)
  if (duration === undefined) return 'Time not recorded'
  if (record.timingSource === 'provider') return `Reported by ${provider}`
  const span = record.startedAt && record.completedAt ? recordDuration({ startedAt: record.startedAt, completedAt: record.completedAt }) : undefined
  return record.timingSource === 'observed' && span !== undefined && (record.durationMs === undefined || record.durationMs === span) ? 'Timed by Sotto' : `Reported by ${provider}`
}

const firstLine = (value: string | undefined): string => (value ?? '').split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? ''
/** A one-line preview reads as words: heading marks, emphasis and code ticks belong to the Markdown, not the text. */
const plainLine = (value: string | undefined): string => firstLine(value).replace(/^#{1,6}\s+/u, '').replace(/(\*\*|__)(.+?)\1/gu, '$2').replace(/`([^`]+)`/gu, '$1')
const oneLine = (value: string): string => value.replace(/\s+/gu, ' ').trim()
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** "spawnAgent" and "wait_agents" read as words; anything else stays as the provider named it. */
function toolName(title: string): string {
  if (!/^[a-z][A-Za-z0-9]*(?:_[a-z0-9]+)*$/u.test(title) || !/[A-Z_]/u.test(title)) return title
  const words = title.replace(/_/gu, ' ').replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export interface ActivityLabel {
  /** Plain words before the subject, such as "Edited". */
  readonly lead: string
  readonly subject: string
  /** Commands and paths are set in the code face. */
  readonly mono: boolean
  /** A short preview after the subject, such as a search query or the first line of a summary. */
  readonly preview: string
}

/** An open multi-file change lists every file below, so its row names the count instead of repeating the first path. */
export function openActivityLabel(record: AgentActivity): ActivityLabel {
  const changes = record.changes ?? []
  return record.kind === 'file-change' && changes.length > 1
    ? { lead: 'Changed', subject: plural(changes.length, 'file', 'files'), mono: false, preview: '' }
    : { ...activityLabel(record), preview: '' }
}

/**
 * Native tool input the provider reported as JSON (Claude tool_use input, Grok rawInput). Null when the text is
 * prose or not an object: previews and details then use the text as written.
 */
export function activityInput(record: Pick<AgentActivity, 'kind' | 'text'>): Record<string, unknown> | null {
  if (record.kind === 'reasoning' || record.kind === 'plan' || record.kind === 'status' || record.kind === 'turn') return null
  const text = record.text?.trim()
  if (!text?.startsWith('{') || !text.endsWith('}')) return null
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

/** The input fields that say what a tool acted on, most specific first. */
const PREVIEW_KEYS = ['file_path', 'notebook_path', 'pattern', 'query', 'url', 'path', 'skill', 'description', 'prompt', 'command', 'name'] as const
const PREVIEW_LIMIT = 140

function inputPreview(input: Record<string, unknown> | null): string {
  if (input === null) return ''
  for (const key of PREVIEW_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      const line = oneLine(value)
      return line.length > PREVIEW_LIMIT ? `${line.slice(0, PREVIEW_LIMIT - 1)}…` : line
    }
  }
  return ''
}

const CHANGE_VERBS: Record<string, string> = {
  add: 'Created', create: 'Created', delete: 'Deleted', update: 'Edited', edit: 'Edited', move: 'Moved',
  Write: 'Wrote', Edit: 'Edited', MultiEdit: 'Edited', NotebookEdit: 'Edited',
}
/** Codex, Claude and Grok name the same changes differently; an unrecognized kind is shown as reported. */
export const changeVerb = (kind: string): string => CHANGE_VERBS[kind] ?? kind

const BEFORE = '--- before\n'
const AFTER = '\n+++ after\n'
const prefixed = (text: string, sign: '-' | '+'): string[] => text === '' ? [] : text.replace(/\n$/u, '').split('\n').map(line => `${sign}${line}`)

/**
 * A readable diff for a reported change. Unified diffs pass through. Claude and Grok report an edit as its
 * whole before and after text, which reads as removed then added lines: what was replaced, not a line-matched diff.
 */
export function displayDiff(diff: string): string {
  if (!diff.startsWith(BEFORE)) return diff
  // An empty before text puts the after marker straight after the before marker.
  const split = diff.startsWith(`${BEFORE}${AFTER.slice(1)}`) ? BEFORE.length - 1 : diff.indexOf(AFTER, BEFORE.length)
  if (split < 0) return diff
  const before = diff.slice(BEFORE.length, Math.max(BEFORE.length, split))
  const after = diff.slice(split + AFTER.length)
  return [...prefixed(before, '-'), ...prefixed(after, '+')].join('\n')
}

export type ActivityChange = NonNullable<AgentActivity['changes']>[number]

const editPair = (edit: unknown): { old: string; next: string } | null => {
  if (edit === null || typeof edit !== 'object') return null
  const { old_string: old, new_string: next } = edit as Record<string, unknown>
  return typeof old === 'string' && typeof next === 'string' ? { old, next } : null
}

/** Reported changes, with the content Claude's Write and MultiEdit carried in their input when no diff came with them. */
export function activityChanges(record: AgentActivity): readonly ActivityChange[] {
  const changes = record.changes ?? []
  if (record.kind !== 'file-change' || changes.length !== 1 || changes[0]!.diff) return changes
  const input = activityInput(record)
  const change = changes[0]!
  if (typeof input?.content === 'string') return [{ ...change, diff: prefixed(input.content, '+').join('\n') }]
  if (Array.isArray(input?.edits)) {
    const hunks = input.edits.map(editPair).flatMap(pair => pair ? [[...prefixed(pair.old, '-'), ...prefixed(pair.next, '+')].join('\n')] : [])
    if (hunks.length) return [{ ...change, diff: hunks.join('\n@@\n') }]
  }
  return changes
}

/** What a tool was given, when it says more than the command or diff the row already shows. */
export function inputDetail(record: AgentActivity): string {
  const input = activityInput(record)
  if (input === null) return ''
  if (record.kind === 'command') return typeof input.description === 'string' ? input.description : ''
  if (record.kind === 'file-change') return ''
  return JSON.stringify(input, null, 2)
}

/** What a compaction reclaimed, naming only the sides the provider actually reported. */
export function compactionSummary(record: AgentActivity): string {
  const before = record.context?.before, after = record.context?.after
  if (before !== undefined && after !== undefined) return `${formatTokenCount(before)} → ${formatTokenCount(after)} tokens`
  if (after !== undefined) return `now ${formatTokenCount(after)} tokens`
  if (before !== undefined) return `was ${formatTokenCount(before)} tokens`
  return ''
}

/** A compaction standing on its own, which the transcript draws as a boundary rather than as a card of work. */
export function compactionOf(group: ActivityGroup): AgentActivity | undefined {
  const only = group.records.length === 1 ? group.records[0] : undefined
  return only?.kind === 'compaction' ? only : undefined
}

export function activityLabel(record: AgentActivity): ActivityLabel {
  switch (record.kind) {
    case 'command':
      return record.command ? { lead: '', subject: oneLine(record.command), mono: true, preview: '' } : { lead: '', subject: record.title, mono: false, preview: '' }
    case 'file-change': {
      const changes = record.changes ?? []
      if (!changes.length) return { lead: '', subject: record.title, mono: false, preview: '' }
      const verbs = new Set(changes.map(change => changeVerb(change.kind)))
      const only = verbs.size === 1 ? [...verbs][0]! : ''
      const lead = ['Created', 'Deleted', 'Wrote', 'Moved'].includes(only) ? only : 'Edited'
      return { lead, subject: changes[0]!.path, mono: true, preview: changes.length > 1 ? `and ${plural(changes.length - 1, 'more file', 'more files')}` : '' }
    }
    case 'subagent': {
      const input = activityInput(record)
      const described = typeof input?.description === 'string' && input.description.trim() ? oneLine(input.description) : ''
      return { lead: '', subject: described || toolName(record.title), mono: false,
        preview: record.agents?.length ? plural(record.agents.length, 'agent', 'agents') : input ? '' : plainLine(record.text) }
    }
    case 'plan': {
      const steps = record.steps ?? []
      return { lead: '', subject: record.title, mono: false,
        preview: steps.length ? `${steps.filter(step => step.status === 'completed').length} of ${steps.length} done` : plainLine(record.text) }
    }
    case 'compaction':
      return { lead: '', subject: record.title, mono: false, preview: compactionSummary(record) }
    case 'status':
      return { lead: '', subject: record.title, mono: false, preview: plainLine(record.error ?? record.text) }
    default: {
      const input = activityInput(record)
      return { lead: '', subject: record.kind === 'tool' ? toolName(record.title) : record.title, mono: false, preview: input ? inputPreview(input) : plainLine(record.text) }
    }
  }
}

export interface ActivityNode {
  readonly record: AgentActivity
  readonly children: readonly ActivityNode[]
}

/**
 * Work a subagent or tool did on behalf of another record sits under that record. A child whose parent is not in
 * the same list (another anchor, or trimmed) stays where it is, so nothing reported is hidden; so do records in a
 * parent cycle.
 */
export function nestActivities(records: readonly AgentActivity[]): readonly ActivityNode[] {
  const ids = new Set(records.map(record => record.id))
  const hasParent = (record: AgentActivity): boolean => record.parentId !== undefined && record.parentId !== record.id && ids.has(record.parentId)
  const children = new Map<string, AgentActivity[]>()
  for (const record of records) if (hasParent(record)) children.set(record.parentId!, [...children.get(record.parentId!) ?? [], record])
  const placed = new Set<string>()
  const build = (record: AgentActivity): ActivityNode => {
    placed.add(record.id)
    return { record, children: (children.get(record.id) ?? []).filter(child => !placed.has(child.id)).map(build) }
  }
  const roots = records.filter(record => !hasParent(record)).map(build)
  for (const record of records) if (!placed.has(record.id)) roots.push(build(record))
  return roots
}

/** The one fact beside a row. Running rows add their clock separately. */
export function statusText(record: AgentActivity, connected: boolean): string {
  switch (record.status) {
    case 'running': return connected ? 'Running' : 'Last seen running'
    case 'failed': return record.exitCode !== undefined && record.exitCode !== 0 ? `Exit ${record.exitCode}` : 'Failed'
    case 'interrupted': return 'Stopped'
    case 'unknown': return 'Outcome unknown'
    default: {
      const duration = recordDuration(record)
      return duration === undefined ? '' : formatDuration(duration)
    }
  }
}

const AGENT_STATUS: Record<string, string> = {
  pendingInit: 'Starting', running: 'Running', active: 'Running', completed: 'Completed', errored: 'Failed', failed: 'Failed',
  shutdown: 'Closed', notFound: 'Not found', interrupted: 'Stopped', unknown: 'Unknown',
}
export const agentStatusLabel = (status: string): string => AGENT_STATUS[status] ?? status

/** "Ran 3 commands, changed 2 files": counts of what the provider reported, nothing estimated. */
export function groupSummary(records: readonly AgentActivity[]): string {
  const count = (kind: AgentActivity['kind']): AgentActivity[] => records.filter(record => record.kind === kind)
  const files = new Set(count('file-change').flatMap(record => record.changes?.length ? record.changes.map(change => change.path) : [record.id]))
  const parts = [
    count('command').length ? `ran ${plural(count('command').length, 'command', 'commands')}` : '',
    files.size ? `changed ${plural(files.size, 'file', 'files')}` : '',
    count('tool').length ? `used ${plural(count('tool').length, 'tool', 'tools')}` : '',
    count('subagent').length ? plural(count('subagent').length, 'agent action', 'agent actions') : '',
    count('plan').length ? 'updated the plan' : '',
    count('reasoning').length ? plural(count('reasoning').length, 'reasoning summary', 'reasoning summaries') : '',
    count('status').length ? plural(count('status').length, 'notice', 'notices') : '',
    count('compaction').length ? 'compacted the context' : '',
  ].filter(Boolean)
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export interface TurnChange {
  readonly path: string
  /** How the file was first touched: a file created then edited still reads as created. */
  readonly verb: string
  /** Every diff reported for the path, in the order they happened. */
  readonly diffs: readonly string[]
}

/** Every file a turn changed, first touched first, so a finished turn can say what it left behind. */
export function turnChanges(groups: readonly ActivityGroup[]): readonly TurnChange[] {
  const files = new Map<string, { path: string; verb: string; diffs: string[] }>()
  const records = groups.flatMap(group => [...group.records]).sort(bySequence)
  for (const record of records) {
    if (record.kind !== 'file-change') continue
    for (const change of activityChanges(record)) {
      const file = files.get(change.path) ?? { path: change.path, verb: changeVerb(change.kind), diffs: [] }
      if (change.diff && !file.diffs.includes(change.diff)) file.diffs.push(change.diff)
      files.set(change.path, file)
    }
  }
  return [...files.values()]
}

/** The header of a settled group: how the turn ended and, when recorded, how long it took. */
export function turnHeadline(turn: AgentActivity | undefined, threadRunning: boolean): string {
  if (!turn) return ''
  const duration = recordDuration(turn)
  const took = duration === undefined ? '' : formatDuration(duration)
  switch (turn.status) {
    case 'completed': return took ? `Worked for ${took}` : 'Worked'
    case 'failed': return took ? `Failed after ${took}` : 'Failed'
    case 'interrupted': return took ? `Stopped after ${took}` : 'Stopped'
    case 'running': return threadRunning ? 'Working' : 'Last seen working'
    default: return 'Outcome unknown'
  }
}

/** Longest run of backticks in the text plus one, so provider output cannot close its own fence. */
export function fenced(text: string, info: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map(match => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${info}\n${text.replace(/\n$/u, '')}\n${fence}`
}

/** One turn of the transcript: the user's message, when the page shows it, and every message after it until the next. */
export interface TranscriptTurn {
  readonly key: string
  readonly user?: AgentMessage
  readonly replies: readonly AgentMessage[]
}

/** Splits rendered messages at each user message. Messages before the first one (a page that starts mid-turn) form their own turn. */
export function splitTurns(messages: readonly AgentMessage[]): TranscriptTurn[] {
  const turns: { key: string; user?: AgentMessage; replies: AgentMessage[] }[] = []
  for (const message of messages) {
    if (message.role === 'user') turns.push({ key: message.id, user: message, replies: [] })
    else if (turns.length) turns.at(-1)!.replies.push(message)
    else turns.push({ key: `before:${message.id}`, replies: [message] })
  }
  return turns
}

/**
 * The line a finished turn folds its work under. A lifecycle record's outcome and duration win; without one (Claude
 * and Grok report none), the turn ran from the user's message to the latest moment recorded for it.
 */
export function workHeadline(turn: AgentActivity | undefined, threadRunning: boolean, startedAt: string | undefined, moments: readonly (string | undefined)[]): string {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN
  const end = Math.max(...moments.map(moment => moment ? Date.parse(moment) : Number.NaN).filter(Number.isFinite))
  const spanned = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : undefined
  const durationMs = (turn ? recordDuration(turn) : undefined) ?? spanned
  return turnHeadline({ ...turn, status: turn?.status ?? 'completed', ...(durationMs === undefined ? {} : { durationMs }) } as AgentActivity, threadRunning)
}
