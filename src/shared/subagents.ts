import { z } from 'zod'
import { MAX_SUBAGENT_STEPS, subagentStepSchema, workflowProgressSchema } from './agentActivity'

export const SUBAGENTS_PAGE = 'sotto:subagents:page'
export const SUBAGENTS_ASSIGNMENTS = 'sotto:subagents:assignments'
export const SUBAGENTS_CHANGED = 'sotto:subagents:changed'
export const SUBAGENT_PAGE_SIZE = 50
export const SUBAGENT_ASSIGNMENT_PAGE_SIZE = 10
const id = z.string().min(1).max(512)
export const subagentPageRequestSchema = z.object({ threadId: id, before: z.number().int().positive().optional() }).strict()
export const subagentAssignmentsRequestSchema = z.object({ threadId: id, agentId: id, before: z.number().int().positive().optional() }).strict()
export type SubagentPageRequest = z.infer<typeof subagentPageRequestSchema>
export type SubagentAssignmentsRequest = z.infer<typeof subagentAssignmentsRequestSchema>
export const subagentStatusSchema = z.enum(['running', 'completed', 'failed', 'interrupted', 'unknown'])
/** Normalize reported lifecycle names before either freshness checks or retained status counts. */
export function observedSubagentStatus(status: string): z.infer<typeof subagentStatusSchema> {
  switch (status.toLowerCase()) {
    case 'running': case 'working': case 'in_progress': case 'inprogress': case 'pending': case 'pendinginit': case 'initializing': case 'starting': case 'waiting': return 'running'
    case 'completed': case 'done': case 'finished': return 'completed'
    case 'failed': case 'errored': case 'error': case 'declined': case 'notfound': return 'failed'
    case 'interrupted': case 'shutdown': case 'closed': case 'cancelled': case 'canceled': return 'interrupted'
    default: return 'unknown'
  }
}
export const subagentRowSchema = z.object({
  id, parentId: id.optional(), sequence: z.number().int().positive(), revision: z.number().int().nonnegative(),
  assignmentId: id, assignmentCount: z.number().int().positive(),
  title: z.string().max(240), description: z.string().max(400), model: z.string().max(512).optional(),
  status: subagentStatusSchema, startedAt: z.string().optional(), completedAt: z.string().optional(),
  lastObservedAt: z.string(), durationMs: z.number().nonnegative().optional(),
  /** A workflow's row stands for the run; its agents are rows of their own under it and it is not counted as one. */
  kind: z.literal('workflow').optional(), progress: workflowProgressSchema.optional(),
  /** Total observed steps on the current assignment, and the active/latest step while working. */
  stepCount: z.number().int().nonnegative().optional(),
  currentStep: subagentStepSchema.optional(),
})
export type SubagentRow = z.infer<typeof subagentRowSchema>
export const subagentSummarySchema = z.object({ total: z.number().int().nonnegative(), working: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), interrupted: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() })
export type SubagentSummary = z.infer<typeof subagentSummarySchema>
export const EMPTY_SUBAGENT_SUMMARY: SubagentSummary = { total: 0, working: 0, completed: 0, failed: 0, interrupted: 0, unknown: 0 }
export const subagentPageSchema = z.object({ threadId: id, revision: z.number().int().nonnegative(), rows: z.array(subagentRowSchema), summary: subagentSummarySchema, before: z.number().int().positive().optional() })
export type SubagentPage = z.infer<typeof subagentPageSchema>
export const subagentAssignmentSchema = z.object({
  id, sequence: z.number().int().positive(), title: z.string(), status: subagentStatusSchema,
  prompt: z.string().optional(), result: z.string().optional(), model: z.string().optional(),
  startedAt: z.string().optional(), completedAt: z.string().optional(), durationMs: z.number().nonnegative().optional(),
  steps: z.array(subagentStepSchema).max(MAX_SUBAGENT_STEPS).optional(),
  stepCount: z.number().int().nonnegative().optional(),
})
export type SubagentAssignment = z.infer<typeof subagentAssignmentSchema>
export const subagentAssignmentsPageSchema = z.object({ threadId: id, agentId: id, assignments: z.array(subagentAssignmentSchema), before: z.number().int().positive().optional() })
export type SubagentAssignmentsPage = z.infer<typeof subagentAssignmentsPageSchema>
/** Bounded current-row updates only. Prompts, results and older assignments are requested separately. */
export const subagentChangeSchema = z.object({ threadId: id, revision: z.number().int().nonnegative(), rows: z.array(subagentRowSchema), summary: subagentSummarySchema, reset: z.boolean().optional() })
export type SubagentChange = z.infer<typeof subagentChangeSchema>
export interface SubagentsBridge {
  page(request: SubagentPageRequest): Promise<SubagentPage>
  assignments(request: SubagentAssignmentsRequest): Promise<SubagentAssignmentsPage>
  onChanged(listener: (change: SubagentChange) => void): () => void
}

/** Claude Code's model aliases, which a launch may name before the agent's resolved model is known. */
const MODEL_ALIAS = /^(opus|sonnet|haiku)(\[1m\])?$/u
/**
 * The models a workflow's agents ran on, once each in the order first seen. An alias such as `opus` is left out
 * once a resolved name of the same family (`claude-opus-5-5[1m]`) is in the list, so one model is never named twice.
 */
export function distinctModels(models: readonly (string | undefined)[]): string[] {
  const named = [...new Set(models.filter((model): model is string => !!model))]
  return named.filter(model => {
    const alias = MODEL_ALIAS.exec(model)
    return !alias || !named.some(other => other !== model && other.startsWith(`claude-${alias[1]}-`))
  })
}
