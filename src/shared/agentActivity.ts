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
  truncated: z.boolean().optional(),
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

/** Native snapshots are upserts, not new log entries. Keep first-observed order and anchors. */
export function mergeAgentActivities(previous: readonly AgentActivity[] = [], incoming: readonly AgentActivity[] = []): AgentActivity[] {
  const records = new Map(previous.map(record => [record.id, record]))
  let sequence = previous.reduce((next, record) => Math.max(next, record.sequence + 1), 0)
  for (const record of incoming) {
    const old = records.get(record.id)
    if (old && isTerminalActivity(old.status) && !isTerminalActivity(record.status)) continue
    records.set(record.id, old ? { ...old, ...record, sequence: old.sequence,
      ...(old.afterMessageId ? { afterMessageId: old.afterMessageId } : {}),
      ...(old.startedAt ? { startedAt: old.startedAt, timingSource: old.timingSource } : {}),
      ...(old.completedAt && isTerminalActivity(old.status) ? { completedAt: old.completedAt } : {}),
      ...(record.agents ? { agents: record.agents.map(agent => {
        const prior = old.agents?.find(candidate => candidate.id === agent.id)
        if (prior && prior.assignmentId === agent.assignmentId && terminalAgent(prior.status) && !terminalAgent(agent.status)) return prior
        // A new assignment of the same agent starts clean: the earlier one's result and times stay with it.
        return prior && prior.assignmentId !== undefined && agent.assignmentId !== undefined && prior.assignmentId !== agent.assignmentId ? agent : { ...prior, ...agent }
      }) } : {}),
    } : { ...record, sequence: sequence++ })
  }
  const sorted = [...records.values()].sort((a, b) => a.sequence - b.sequence)
  const bounded = sorted.slice(-MAX_AGENT_ACTIVITIES)
  if (sorted.length > bounded.length && bounded[0]) bounded[0] = { ...bounded[0], truncated: true }
  return bounded
}
