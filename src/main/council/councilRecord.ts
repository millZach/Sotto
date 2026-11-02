import { z } from 'zod'
import { providerIdSchema } from '../../shared/providerIds'
import { COUNCIL_KINDS, COUNCIL_STAGES, COUNCIL_TURN_STAGES, councilCitationSchema, type CouncilCitation, type CouncilStage, type CouncilTurnStage } from '../../shared/council'
import { cruxSchema, framingSchema, type CouncilAmend, type CouncilAnswer, type CouncilCrux, type CouncilCruxResult, type CouncilFairness, type CouncilFraming,
  type CouncilReview } from '../../shared/councilBlocks'

/**
 * A Council's own record in main (ADR-0177): its seats and their threads, by Sotto thread ID (ADR-0002), each prompt it
 * sent and where that prompt stands, and what Sotto read from the replies. It lives in `councils.json` in Sotto's data
 * folder. The words in it, the question, the framing, what the result blocks said and the verdict, are saved only while
 * Keep local history is on; the replies themselves stay in each thread's own history and are read from there.
 */

const id = z.string().min(1).max(512)
const at = z.iso.datetime()
const seat = z.string().min(1).max(8)

/** One prompt to one thread, and what came of it. */
export const councilTurnSchema = z.object({
  id: z.uuid(),
  round: z.number().int().nonnegative(),
  seat,
  thread: id,
  stage: z.enum(COUNCIL_TURN_STAGES),
  /** This prompt asked again for the result block that turn's reply lacked. */
  repairOf: z.uuid().optional(),
  /** For a crux check with no panelist on neither side: the side whose claim this runner tries to establish, 0 or 1. */
  establish: z.union([z.literal(0), z.literal(1)]).optional(),
  /** For a conversation sent in parts: which part, from 1. */
  part: z.number().int().positive().optional(),
  /** For the chair's answer to objections: the panelists whose objections it carries. */
  objections: z.array(seat).max(5).optional(),
  draftId: z.uuid(),
  messageId: z.uuid(),
  /**
   * `queued` until the thread is free to take it; `dispatching` from just before it is sent until the thread shows it;
   * `accepted` once it does; `failed` when the send was refused; `unconfirmed` when it was sent and never shown, or Sotto
   * restarted first. An unconfirmed prompt is never sent again (ADR-0058, ADR-0081).
   */
  delivery: z.enum(['queued', 'dispatching', 'accepted', 'failed', 'unconfirmed']),
  outcome: z.enum(['working', 'answered', 'failed', 'stopped', 'unknown']).optional(),
  sentAt: at.optional(),
  replyMessageId: id.optional(),
  /** Whether Sotto could read its result block: `invalid` until its repair is answered, `none` where the stage has no block. */
  result: z.enum(['pending', 'valid', 'invalid', 'unavailable', 'none']),
  /** Retried, given to another model or left out: no longer the seat's turn for its stage. */
  superseded: z.boolean().optional(),
  // Words, saved only while Keep local history is on.
  block: z.unknown().optional(),
  summary: z.string().max(2_000).optional(),
  reason: z.string().max(2_000).optional(),
  citations: z.array(councilCitationSchema).max(40).optional(),
}).strict()

export const councilObjectionSchema = z.object({
  seat,
  claim: z.string().max(2_000).optional(),
  passage: z.string().max(2_000).optional(),
  /** The chair's answer: `unanswered` when its block could not be read. */
  answer: z.enum(['pending', 'amended', 'stands', 'unanswered']),
  reason: z.string().max(2_000).optional(),
  /** The chair's turn that carried it. */
  turn: z.uuid().optional(),
}).strict()

export const councilRoundSchema = z.object({
  index: z.number().int().nonnegative(),
  askedAt: at,
  stage: z.enum(COUNCIL_STAGES),
  /** Panelists the user went on without, and the chair's framing when the user went on without it. */
  leftOut: z.array(seat).max(6),
  reviewPlan: z.record(seat, z.array(seat).max(4)).optional(),
  framingFallback: z.boolean().optional(),
  /** The kind and research the user set in the record over the chair's framing, which restarted the answers. */
  kinds: z.array(z.enum(COUNCIL_KINDS)).min(1).max(2).optional(),
  research: z.boolean().optional(),
  reframedAt: at.optional(),
  // Words, saved only while Keep local history is on: the criteria the user set in the record.
  criteria: z.array(z.object({ id: z.string(), source: z.enum(['question', 'assumed', 'user']), text: z.string().min(1).max(2_000) }).strict()).max(5).optional(),
  cruxRunners: z.array(seat).max(2).optional(),
  cruxDone: z.boolean().optional(),
  fairnessAt: at.optional(),
  doneAt: at.optional(),
  objections: z.array(councilObjectionSchema).max(10),
  // Words, saved only while Keep local history is on.
  question: z.string().max(20_000).optional(),
  framing: framingSchema.optional(),
  crux: cruxSchema.optional(),
  verdict: z.string().max(400_000).optional(),
  amended: z.boolean().optional(),
}).strict()

export const councilSeatSchema = z.object({
  seat,
  role: z.enum(['panelist', 'chair']),
  modelId: id,
  modelName: z.string().max(512),
  provider: providerIdSchema.optional(),
  effort: z.string().max(64).nullable(),
  thread: id,
  /** The threads that held this seat before Use another model. */
  formerThreads: z.array(id).max(20),
  /** The thread has been made, so a send goes to it. */
  started: z.boolean(),
  /** The thread has been sent the origin conversation and the question, so later prompts send only what is new. */
  context: z.boolean(),
}).strict()

export const councilRecordSchema = z.object({
  id: z.uuid(),
  createdAt: at,
  originThread: id,
  originTitle: z.string().max(512),
  projectId: id,
  snapshot: z.object({ path: z.string().max(4_096), repositoryRoot: z.string().max(4_096), commit: z.string().max(64), branch: z.string().max(512),
    untracked: z.number().int().nonnegative(), dirty: z.boolean().optional(), removedAt: at.optional() }).strict(),
  /** What each thread read of the origin conversation: inline, from a file in the snapshot, or its newest part. */
  history: z.object({ messages: z.number().int().nonnegative(), words: z.number().int().nonnegative(), tools: z.number().int().nonnegative(),
    /** How many prompts the conversation takes: 1 when it goes in the first stage prompt, more when it goes in parts before it. */
    parts: z.number().int().positive(), lastMessageId: id.optional() }).strict(),
  seats: z.array(councilSeatSchema).min(3).max(6),
  rounds: z.array(councilRoundSchema).min(1).max(50),
  turns: z.array(councilTurnSchema).max(2_000),
  deadlineMinutes: z.number().int().positive(),
  stoppedAt: at.optional(),
  stoppedBecause: z.enum(['user', 'words-lost', 'snapshot']).optional(),
  settledAt: at.optional(),
}).strict()
export const councilFileSchema = z.object({ version: z.literal(1), councils: z.array(councilRecordSchema).max(200) }).strict()

export type CouncilTurn = z.infer<typeof councilTurnSchema>
export type CouncilRound = z.infer<typeof councilRoundSchema>
export type CouncilSeat = z.infer<typeof councilSeatSchema>
export type CouncilRecord = z.infer<typeof councilRecordSchema>
export type CouncilFile = z.infer<typeof councilFileSchema>
export type { CouncilStage, CouncilTurnStage, CouncilCitation }

/** What a turn's block holds, by its stage. */
export interface CouncilBlocks {
  /** A part of the conversation has no block. */
  history: never
  framing: CouncilFraming
  answer: CouncilAnswer
  review: CouncilReview
  crux: CouncilCruxResult
  /** A verdict turn's block is the chair's request for a crux check; a verdict itself has none. */
  verdict: CouncilCrux
  fairness: CouncilFairness
  amend: CouncilAmend
}
export function blockOf<Stage extends CouncilTurnStage>(turn: CouncilTurn & { stage: Stage }): CouncilBlocks[Stage] | undefined {
  return turn.result === 'valid' ? turn.block as CouncilBlocks[Stage] : undefined
}

/** The record as it is saved: without its words while Keep local history is off. */
export function savedRecord(record: CouncilRecord, keepWords: boolean): CouncilRecord {
  if (keepWords) return record
  const without = <Value extends object>(value: Value, keys: readonly (keyof Value)[]): Value => {
    const kept = { ...value }
    for (const key of keys) delete kept[key]
    return kept
  }
  return {
    ...record,
    rounds: record.rounds.map(round => ({ ...without(round, ['question', 'framing', 'crux', 'verdict', 'criteria']),
      objections: round.objections.map(objection => without(objection, ['claim', 'passage', 'reason'])) })),
    turns: record.turns.map(turn => without(turn, ['block', 'summary', 'reason'])),
  }
}
