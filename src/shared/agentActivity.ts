import { z } from 'zod'

export const MAX_AGENT_ACTIVITIES = 2_000
export const MAX_ACTIVITY_TEXT = 65_536
const detail = z.string().max(MAX_ACTIVITY_TEXT)
const count = z.number().int().nonnegative()
/**
 * How far a workflow's agents have got, counted where the provider reports them. `total` includes the agents still
 * waiting for a place to start (`queued`); those have no row of their own until they start.
 */
export const workflowProgressSchema = z.object({ total: count, working: count, completed: count, failed: count, interrupted: count, queued: count.optional() })
export type WorkflowProgress = z.infer<typeof workflowProgressSchema>
/**
 * How one of the user's own model servers let a turn down (ADR-0124, October 24 amendment): it did not answer after
 * OpenCode's tries, did not start answering within OpenCode's five minutes, turned down its key, no longer has the model,
 * or the thread is longer than the model takes.
 */
export const ownServerTurnFailures = ['unreachable', 'timeout', 'key-refused', 'model-gone', 'too-long'] as const
export type OwnServerTurnFailure = typeof ownServerTurnFailures[number]
/**
 * A turn on one of the user's own model servers, as its words need it: the server's and the model's names, and the
 * address's host and port. While OpenCode tries the server again, the try it is on and how many it makes; once the turn
 * failed, how the server let it down. Display words only; nothing here reaches the server.
 */
export const ownServerTurnSchema = z.object({
  name: z.string().max(80), model: z.string().max(200), host: z.string().max(400),
  attempt: count.max(1_000).optional(), attempts: count.max(1_000).optional(),
  failure: z.enum(ownServerTurnFailures).optional(),
})
export type OwnServerTurn = z.infer<typeof ownServerTurnSchema>
export const agentActivitySchema = z.object({
  id: z.string(), turnId: z.string(), sequence: z.number().int().nonnegative(),
  afterMessageId: z.string().optional(),
  /** Observational parent activity, never a routable provider/thread identity. */
  parentId: z.string().optional(),
  kind: z.enum(['turn', 'command', 'file-change', 'tool', 'reasoning', 'plan', 'subagent', 'status', 'compaction']),
  status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unknown']),
  title: detail, text: detail.optional(), command: detail.optional(), cwd: detail.optional(),
  output: detail.optional(), error: detail.optional(), exitCode: z.number().int().optional(),
  startedAt: z.string().datetime().optional(), completedAt: z.string().datetime().optional(),
  timingSource: z.enum(['provider', 'observed']).optional(), durationMs: z.number().nonnegative().optional(),
  changes: z.array(z.object({ path: detail, kind: detail, diff: detail.optional() })).max(200).optional(),
  /** A plan exactly as the provider last reported it, so it reads as a checklist rather than lines of text. */
  steps: z.array(z.object({ text: detail, status: z.enum(['pending', 'running', 'completed']) })).max(200).optional(),
  /** Context size in tokens either side of a compaction, as the provider reported it or as the ledger bracketed it. */
  context: z.object({ before: z.number().int().nonnegative().optional(), after: z.number().int().nonnegative().optional() }).optional(),
  /** Display identities only. These cannot address provider sessions or grant authority. */
  agents: z.array(z.object({
    id: z.string(), status: detail, message: detail.optional(),
    /** A workflow runs agents of its own, observed as children whose `parentId` is the workflow's id. */
    kind: z.literal('workflow').optional(),
    progress: workflowProgressSchema.optional(),
    /** Stable observational assignment and parent identities, never provider addresses. */
    assignmentId: z.string().optional(), parentId: z.string().optional(),
    /** Hashed identity aliases for adapter point lookups; never routable native addresses. */
    aliasIds: z.array(z.string().max(128)).max(8).optional(),
    title: detail.optional(), description: detail.optional(), prompt: detail.optional(), model: detail.optional(),
    startedAt: z.string().datetime().optional(), completedAt: z.string().datetime().optional(),
    observedAt: z.string().datetime().optional(),
    timingSource: z.enum(['provider', 'observed']).optional(), durationMs: z.number().nonnegative().optional(),
  })).max(200).optional(),
  /** Its native task ended or its identity was reassigned; retained history rejects later lifecycle events. */
  taskUpdatesExcluded: z.boolean().optional(),
  /** An interrupted turn a steer ended: the provider cut the step it was on so the steer could run next (ADR-0075). */
  steered: z.boolean().optional(),
  /** A turn record's own server (ADR-0124): set only on a turn whose model is one of the user's own model servers. */
  ownServer: ownServerTurnSchema.optional(),
  truncated: z.boolean().optional(),
  /**
   * Bodies the host sent cut, whose whole is still on the host (ADR-0025, October 18 amendment): each one's whole size in
   * UTF-8 bytes, a diff's by the index of its change. Only a desktop that accepts `activity-bodies` is sent it, and only on
   * a record from a remote host; it reads the whole record with `activity-body` when the row opens. Not `truncated`,
   * which says details were not kept anywhere.
   */
  cut: z.object({
    output: count.optional(), text: count.optional(),
    diffs: z.array(z.object({ index: count.max(199), bytes: count })).max(200).optional(),
  }).optional(),
})
export type AgentActivity = z.infer<typeof agentActivitySchema>
export type ObservedAgent = NonNullable<AgentActivity['agents']>[number]

/** Adapter lookup caches retain identity and small metadata; task/result content lives in the bounded activity window and roster store. */
export function compactAgentIdentity(agent: ObservedAgent): ObservedAgent {
  return {
    id: agent.id, status: agent.status,
    ...(agent.kind !== undefined ? { kind: agent.kind } : {}),
    ...(agent.assignmentId !== undefined ? { assignmentId: agent.assignmentId } : {}),
    ...(agent.parentId !== undefined ? { parentId: agent.parentId } : {}),
    ...(agent.aliasIds !== undefined ? { aliasIds: agent.aliasIds.slice(0, 8).map(id => id.slice(0, 128)) } : {}),
    ...(agent.title !== undefined ? { title: agent.title.slice(0, 240) } : {}),
    ...(agent.model !== undefined ? { model: agent.model.slice(0, 512) } : {}),
    ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
    ...(agent.completedAt !== undefined ? { completedAt: agent.completedAt } : {}),
    ...(agent.observedAt !== undefined ? { observedAt: agent.observedAt } : {}),
    ...(agent.timingSource !== undefined ? { timingSource: agent.timingSource } : {}),
    ...(agent.durationMs !== undefined ? { durationMs: agent.durationMs } : {}),
  }
}


export type PlanStep = NonNullable<AgentActivity['steps']>[number]

/** Codex, Claude and Grok name the same three plan states differently; anything else has not started. */
export function planSteps(steps: readonly { text: unknown; status: unknown }[]): PlanStep[] {
  const state = (value: unknown): PlanStep['status'] =>
    value === 'completed' || value === 'done' ? 'completed' : value === 'in_progress' || value === 'running' || value === 'active' ? 'running' : 'pending'
  // A step is one line of a checklist, so it is bounded far below a record's detail budget.
  return steps.flatMap(step => typeof step.text === 'string' && step.text.trim()
    ? [{ text: step.text.slice(0, 1_000), status: state(step.status) }] : []).slice(0, 200)
}

/**
 * The title of a reasoning record that holds a provider's thinking as it streams: Claude's thinking blocks and
 * Grok's and Devin's thought chunks. Codex's reasoning summaries are the same kind of record under their own title,
 * and both are drawn by the same row.
 */
export const THINKING_TITLE = 'Thinking'
/** The title of a Codex reasoning summary record. */
export const REASONING_SUMMARY_TITLE = 'Reasoning summary'
/**
 * A Codex reasoning summary with no words: Codex reports one for every step a model that keeps its reasoning to itself
 * takes, and it has nothing to show. Sotto keeps none; an earlier Sotto saved them, and they go when activity is next
 * merged. Thinking without words is different: it still shows, as the row that says the model thought.
 */
export const wordlessReasoningSummary = (record: AgentActivity): boolean =>
  record.kind === 'reasoning' && record.title === REASONING_SUMMARY_TITLE && !record.text?.trim()

/**
 * Thinking text as a record keeps it. It grows as it streams and stops at the record's detail budget, marked as cut,
 * the way any other detail is. Empty thinking (redacted, or a model that sends none) keeps no text at all.
 */
export function thinkingText(text: string): Pick<AgentActivity, 'text' | 'truncated'> {
  if (!text) return {}
  return text.length > MAX_ACTIVITY_TEXT ? { text: text.slice(0, MAX_ACTIVITY_TEXT), truncated: true } : { text }
}

export function isTerminalActivity(status: AgentActivity['status']): boolean {
  return status !== 'running' && status !== 'unknown'
}

const terminalAgent = (status: string): boolean => ['completed', 'failed', 'errored', 'interrupted', 'shutdown', 'notFound'].includes(status)

/** One upsert of a record that exists, or undefined when a running update would reopen a record that already finished. */
function mergedActivity(old: AgentActivity, record: AgentActivity): AgentActivity | undefined {
  if (isTerminalActivity(old.status) && !isTerminalActivity(record.status)) return undefined
  return { ...old, ...record, sequence: old.sequence,
    ...(old.afterMessageId ? { afterMessageId: old.afterMessageId } : {}),
    ...(old.startedAt ? { startedAt: old.startedAt, timingSource: old.timingSource } : {}),
    ...(old.completedAt && isTerminalActivity(old.status) ? { completedAt: old.completedAt } : {}),
    ...(record.agents ? { agents: record.agents.map(agent => {
      const prior = old.agents?.find(candidate => candidate.id === agent.id)
      if (prior && prior.assignmentId === agent.assignmentId && terminalAgent(prior.status) && !terminalAgent(agent.status)) return prior
      // A new assignment of the same agent starts clean: the earlier one's result and times stay with it.
      return prior && prior.assignmentId !== undefined && agent.assignmentId !== undefined && prior.assignmentId !== agent.assignmentId ? agent : { ...prior, ...agent }
    }) } : {}),
  }
}

/** The record with this id, as `records.find` would return it. The id is built once rather than once per record compared. */
export function findAgentActivity(records: readonly AgentActivity[], id: string): AgentActivity | undefined {
  return records.find(record => record.id === id)
}

/**
 * Native snapshots are upserts, not new log entries. Keep first-observed order and anchors.
 *
 * With `same`, a merge whose bounded result leaves every record as `same` judges it returns `previous` itself, so a frame
 * that changed nothing tells no cache that reuses a thread's records by identity that everything changed.
 *
 * Every Claude, Codex, Grok and Devin event runs this on Electron main against a window of up to `MAX_AGENT_ACTIVITIES`
 * records, so it reads that window once and does no more than it must: it keeps no state between calls, and sorts only
 * a list that is out of sequence order. A thread that had run a thousand subagents once spent about a millisecond per
 * subagent here and in the scans beside it, when every merge built a map of the window, reduced it and sorted it.
 */
export function mergeAgentActivities(previous: readonly AgentActivity[] = [], incoming: readonly AgentActivity[] = [], same?: (next: AgentActivity, old: AgentActivity) => boolean): AgentActivity[] {
  // One pass: where each id sits, the sequence a new record takes, and whether the list is already in sequence order.
  const positions = new Map<string, number>()
  let sequence = 0, ordered = true, last = Number.NEGATIVE_INFINITY
  for (let position = 0; position < previous.length; position++) {
    const record = previous[position]!
    // A list with an id twice keeps that id once, where it first sat; the full merge below does exactly that.
    const id = record.id
    if (positions.has(id)) return mergeAll(previous, incoming, same)
    positions.set(id, position)
    const order = record.sequence
    if (order < last) ordered = false
    last = order; sequence = Math.max(sequence, order + 1)
  }
  const records = previous.slice()
  for (const record of incoming) {
    const position = positions.get(record.id)
    if (position === undefined) { positions.set(record.id, records.length); records.push({ ...record, sequence: sequence++ }); continue }
    const merged = mergedActivity(records[position]!, record)
    if (merged) records[position] = merged
  }
  // New records take sequences past every held one, so a list in order stays in order. `sort` is stable, as the full merge relies on.
  return bounded(ordered ? records : records.sort((a, b) => a.sequence - b.sequence), previous, same)
}

/** The merge for a list holding an id more than once: the last record with it, in the place of the first. */
function mergeAll(previous: readonly AgentActivity[], incoming: readonly AgentActivity[], same: ((next: AgentActivity, old: AgentActivity) => boolean) | undefined): AgentActivity[] {
  const records = new Map(previous.map(record => [record.id, record]))
  let sequence = previous.reduce((next, record) => Math.max(next, record.sequence + 1), 0)
  for (const record of incoming) {
    const old = records.get(record.id)
    if (!old) { records.set(record.id, { ...record, sequence: sequence++ }); continue }
    const merged = mergedActivity(old, record)
    if (merged) records.set(record.id, merged)
  }
  return bounded([...records.values()].sort((a, b) => a.sequence - b.sequence), previous, same)
}

/** The newest `MAX_AGENT_ACTIVITIES` of a merge in sequence order, the first marked cut when older ones went; or `previous` as `same` allows. */
function bounded(sorted: AgentActivity[], previous: readonly AgentActivity[], same: ((next: AgentActivity, old: AgentActivity) => boolean) | undefined): AgentActivity[] {
  const kept = sorted.length > MAX_AGENT_ACTIVITIES ? sorted.slice(-MAX_AGENT_ACTIVITIES) : sorted
  if (sorted.length > kept.length && kept[0]) kept[0] = { ...kept[0], truncated: true }
  return same && unchanged(previous, kept, same) ? previous as AgentActivity[] : kept
}

function unchanged(previous: readonly AgentActivity[], merged: readonly AgentActivity[], same: (next: AgentActivity, old: AgentActivity) => boolean): boolean {
  if (merged.length !== previous.length) return false
  for (const [position, record] of merged.entries()) if (record !== previous[position] && !same(record, previous[position]!)) return false
  return true
}
