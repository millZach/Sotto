import { z } from 'zod'

export const MAX_AGENT_MONITORS = 64
export const MAX_MONITOR_LABEL = 240

/** A live provider-confirmed watch. Neither activity history nor permission to act. */
export const agentMonitoringSchema = z.array(z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(MAX_MONITOR_LABEL).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value)),
}).strict()).max(MAX_AGENT_MONITORS)

export type AgentMonitoringTask = z.infer<typeof agentMonitoringSchema>[number]
