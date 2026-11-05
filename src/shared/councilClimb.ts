import { z } from 'zod'
import { councilEvidenceSourceSchema, councilFrozenEvidenceSchema } from './councilEvidence'

export const COUNCIL_CLIMB = 'sotto:council:climb'
const id = z.string().min(1).max(512)
const words = z.string().trim().min(1).max(20_000)
const number = z.number().finite()
export const climbSeatSchema = z.object({ modelId: id, reasoningEffort: z.string().max(64).nullable() }).strict()
export const climbCriterionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/u), name: z.string().min(1).max(200), rubric: words,
  kind: z.enum(['goal', 'guardrail']), direction: z.enum(['higher', 'lower']), min: number, max: number,
  target: z.enum(['relative', 'absolute', 'reference']), threshold: number, tolerance: number.nonnegative(), meaningfulGain: number.positive(),
}).strict().refine(value => value.min < value.max, 'The score range must increase.').refine(value => value.target !== 'absolute' || value.threshold >= value.min && value.threshold <= value.max, 'An absolute target must fit the score range.')
export const climbSpecSchema = z.object({
  goal: words, constraints: z.string().max(20_000), source: councilEvidenceSourceSchema,
  reference: councilEvidenceSourceSchema.optional(), criteria: z.array(climbCriterionSchema).min(1).max(12),
  judges: z.array(climbSeatSchema).length(3), chair: climbSeatSchema,
  attempts: z.number().int().min(1).max(100).nullable(), modelTurns: z.number().int().min(5).max(1_000).nullable(),
}).strict().superRefine((spec, ctx) => {
  if (!spec.criteria.some(criterion => criterion.kind === 'goal')) ctx.addIssue({ code: 'custom', message: 'Choose a goal criterion.' })
  if (new Set(spec.criteria.map(criterion => criterion.id)).size !== spec.criteria.length) ctx.addIssue({ code: 'custom', message: 'Criterion identifiers must be unique.' })
  if (!spec.reference && spec.criteria.some(criterion => criterion.target === 'reference')) ctx.addIssue({ code: 'custom', message: 'Choose fixed reference evidence.' })
})
export type ClimbSpec = z.infer<typeof climbSpecSchema>
export type ClimbCriterion = z.infer<typeof climbCriterionSchema>
const citationSchema = z.object({ path: z.string().min(1).max(4_096), start: z.number().int().positive(), end: z.number().int().positive(), quote: z.string().min(1).max(4_000) }).strict()
export const climbScoreSchema = z.object({ criterion: id, exhibit: z.string().regex(/^[A-D]$/u),
  score: number.nullable(), reason: z.string().min(1).max(4_000), citations: z.array(citationSchema).max(8) }).strict()
export const climbJudgmentSchema = z.object({ scores: z.array(climbScoreSchema).min(1).max(48) }).strict()
export type ClimbJudgment = z.infer<typeof climbJudgmentSchema>
export const climbChairSchema = z.object({ summary: z.string().min(1).max(20_000) }).strict()
export const climbSetupSchema = z.object({ criteria: z.array(climbCriterionSchema).min(1).max(12), constraints: z.string().max(20_000) }).strict()
const exhibitSchema = z.object({ letter: z.string().regex(/^[A-D]$/u), evidence: z.uuid() }).strict()
export const climbRoundSchema = z.object({
  index: z.number().int().nonnegative(), baseline: z.uuid(), candidate: z.uuid(), incumbent: z.uuid(), reference: z.uuid().optional(),
  exhibits: z.array(exhibitSchema).min(1).max(4),
  judgments: z.array(z.object({ seat: z.number().int().min(0).max(2), thread: id, modelId: id, result: climbJudgmentSchema }).strict()).max(3),
  summary: z.string().max(20_000).optional(), targetMet: z.boolean().optional(), improved: z.boolean().optional(),
}).strict()
export type ClimbRound = z.infer<typeof climbRoundSchema>
export const climbTurnSchema = z.object({
  id: z.uuid(), draftId: z.uuid(), messageId: z.uuid(), thread: id, stage: z.enum(['setup', 'judge', 'chair', 'builder']),
  round: z.number().int().nonnegative(), seat: z.number().int().min(0).max(2).optional(), modelId: id.optional(),
  delivery: z.enum(['queued', 'dispatching', 'accepted', 'unconfirmed']), outcome: z.enum(['working', 'answered', 'failed']).optional(),
  repair: z.boolean(), prompt: z.string().max(1_000_000).optional(), reply: z.string().max(400_000).optional(), replyMessageId: id.optional(),
  startedAt: z.string().optional(),
}).strict()
export type ClimbTurn = z.infer<typeof climbTurnSchema>
export const climbRecordSchema = z.object({
  mode: z.literal('climb'), id: z.uuid(), createdAt: z.string(), originThread: id, originTitle: id, projectId: id,
  phase: z.enum(['setup', 'approval', 'baseline', 'builder', 'assessment', 'paused', 'done', 'stopped', 'settled']),
  resumePhase: z.enum(['setup', 'baseline', 'builder', 'assessment']).optional(), reason: z.string().max(2_000).optional(),
  spec: climbSpecSchema.optional(), preview: z.string().optional(), referencePreview: z.string().optional(), context: z.string().max(40_000).optional(),
  evidence: z.array(councilFrozenEvidenceSchema), rounds: z.array(climbRoundSchema), turns: z.array(climbTurnSchema),
  baseline: z.uuid().optional(), incumbent: z.uuid().optional(), reference: z.uuid().optional(), noImprovement: z.number().int().nonnegative(),
  completedTurns: z.number().int().nonnegative(), originLastUser: id.nullable(), retained: z.boolean(),
}).strict()
export type ClimbRecord = z.infer<typeof climbRecordSchema>
export const climbRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('read') }).strict(),
  z.object({ type: z.literal('preview'), source: councilEvidenceSourceSchema }).strict(),
  z.object({ type: z.literal('start'), origin: id, spec: climbSpecSchema, preview: id, referencePreview: id.optional(), context: z.string().max(40_000) }).strict(),
  z.object({ type: z.literal('approve'), climb: z.uuid(), spec: climbSpecSchema, referencePreview: id.optional() }).strict(),
  z.object({ type: z.literal('stop'), climb: z.uuid() }).strict(),
  z.object({ type: z.literal('resume'), climb: z.uuid() }).strict(),
  z.object({ type: z.literal('settle'), climb: z.uuid() }).strict(),
  z.object({ type: z.literal('export'), climb: z.uuid(), round: z.number().int().nonnegative(), destination: z.string().min(1).max(4_096) }).strict(),
])
export type ClimbRequest = z.infer<typeof climbRequestSchema>
export const climbResultSchema = z.object({ ok: z.boolean(), error: z.string().max(2_000).optional(), climbs: z.array(climbRecordSchema).optional(),
  preview: z.object({ fingerprint: id, files: z.number().int(), bytes: z.number().int(), excluded: z.array(z.object({ path: z.string(), reason: z.string() })), largest: z.array(z.object({ path: z.string(), bytes: z.number().int() })) }).optional(),
}).strict()
export type ClimbResult = z.infer<typeof climbResultSchema>
export function climbPlannedTurns(spec: ClimbSpec, repairs = 0): number | null {
  const planned = spec.attempts === null ? null : 5 + spec.attempts * 5 + repairs
  return spec.modelTurns === null ? planned : planned === null ? spec.modelTurns : Math.min(planned, spec.modelTurns)
}
