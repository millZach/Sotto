import { z } from 'zod'

export const MAX_AGENT_ACTIVITIES = 2_000
export const MAX_ACTIVITY_TEXT = 65_536
const detail = z.string().max(MAX_ACTIVITY_TEXT)
export const agentActivitySchema = z.object({
  id: z.string(), turnId: z.string(), sequence: z.number().int().nonnegative(),
  afterMessageId: z.string().optional(),
  kind: z.enum(['turn', 'command', 'file-change', 'tool', 'reasoning', 'plan', 'subagent', 'status']),
  status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unknown']),
  title: detail, text: detail.optional(), command: detail.optional(), cwd: detail.optional(),
  output: detail.optional(), error: detail.optional(), exitCode: z.number().int().optional(),
  startedAt: z.string().datetime().optional(), completedAt: z.string().datetime().optional(),
  timingSource: z.enum(['provider', 'observed']).optional(), durationMs: z.number().nonnegative().optional(),
  changes: z.array(z.object({ path: detail, kind: detail, diff: detail.optional() })).max(200).optional(),
  /** Display identities only. These cannot address provider sessions or grant authority. */
  agents: z.array(z.object({ id: z.string(), status: detail, message: detail.optional() })).max(200).optional(),
  truncated: z.boolean().optional(),
})
export type AgentActivity = z.infer<typeof agentActivitySchema>

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
        return prior && terminalAgent(prior.status) && !terminalAgent(agent.status) ? prior : agent
      }) } : {}),
    } : { ...record, sequence: sequence++ })
  }
  const sorted = [...records.values()].sort((a, b) => a.sequence - b.sequence)
  const bounded = sorted.slice(-MAX_AGENT_ACTIVITIES)
  if (sorted.length > bounded.length && bounded[0]) bounded[0] = { ...bounded[0], truncated: true }
  return bounded
}
