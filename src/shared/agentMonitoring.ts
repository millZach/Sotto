import { z } from 'zod'

export const MAX_AGENT_MONITORS = 64
export const MAX_MONITOR_LABEL = 240
/** The same ceiling as watches: a workflow that fans out wider than this is still one "Working" readout. */
export const MAX_BACKGROUND_WORK = 64

const label = z.string().trim().min(1).max(MAX_MONITOR_LABEL).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value))

/** A live provider-confirmed watch. Neither activity history nor permission to act. */
export const agentMonitoringSchema = z.array(z.object({
  id: z.string().uuid(),
  label,
}).strict()).max(MAX_AGENT_MONITORS)

export type AgentMonitoringTask = z.infer<typeof agentMonitoringSchema>[number]

/**
 * What kind of agent work the provider confirmed. Sotto's own names, not a provider's task types, so the
 * renderer never learns a native discriminant: a workflow, a subagent, a teammate or a remote agent.
 */
export const backgroundWorkTypes = ['workflow', 'subagent', 'teammate', 'remote-agent'] as const
export type BackgroundWorkType = typeof backgroundWorkTypes[number]

/**
 * Background work: agent work started from this thread that the provider confirms is still running,
 * whether or not a turn is. Observation only, like a watch; never restored from history and grants nothing.
 */
export const agentBackgroundWorkSchema = z.array(z.object({
  id: z.string().uuid(),
  label,
  type: z.enum(backgroundWorkTypes),
}).strict()).max(MAX_BACKGROUND_WORK)

export type AgentBackgroundWork = z.infer<typeof agentBackgroundWorkSchema>[number]
