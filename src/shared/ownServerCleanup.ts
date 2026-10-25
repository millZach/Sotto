import { z } from 'zod'

/**
 * AI cleanup on the user's own model server (ADR-0136): a model from Your own model servers (ADR-0124) chosen as the
 * cleanup model (ADR-0122), with Sotto measuring which thinking setting answers fastest on that server. Only a server
 * added without a key can clean up: OpenCode keeps a server's key and Sotto keeps none.
 */

/** Passed to the main window's preload only while cleanup on the user's own servers may run; without it there is no bridge. */
export const OWN_SERVER_CLEANUP_RENDERER_ARGUMENT = '--sotto-own-server-cleanup'
export const OWN_SERVER_CLEANUP_MEASURE = 'sotto:own-server-cleanup:measure'
export const OWN_SERVER_CLEANUP_MEASURED = 'sotto:own-server-cleanup:measured'

/**
 * How a cleanup asks the server to think. `plain` sends nothing about thinking, so the model does what it does by default.
 * `off` asks the chat template to skip thinking (`enable_thinking` for Qwen-style templates, `thinking` for DeepSeek's).
 * `least` asks for the least effort through `reasoning_effort`. A server that refuses one of these only loses that candidate.
 */
export const OWN_CLEANUP_THINKING = ['plain', 'off', 'least'] as const
export type OwnCleanupThinking = typeof OWN_CLEANUP_THINKING[number]

/** A server and one of its models, by the IDs Sotto saved them under. */
export const ownCleanupChoiceSchema = z.object({
  server: z.string().min(1).max(64).regex(/^own-[a-z0-9-]+$/u),
  model: z.string().min(1).max(200),
}).strict()
export type OwnCleanupChoice = z.infer<typeof ownCleanupChoiceSchema>

/** What the last measure found for a server's model: the fastest setting that passed, or that none did. */
export const ownCleanupTuningSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('fastest'),
    thinking: z.enum(OWN_CLEANUP_THINKING),
    /** The fastest passing test cleanup of the built-in sample, in milliseconds. */
    ms: z.number().int().min(0).max(600_000),
  }).strict(),
  z.object({ status: z.literal('none-passed') }).strict(),
])
export type OwnCleanupTuning = z.infer<typeof ownCleanupTuningSchema>

/** One saved measure, kept per server and model. */
export const ownCleanupMeasuredSchema = ownCleanupChoiceSchema.extend({ tuning: ownCleanupTuningSchema }).strict()
export type OwnCleanupMeasured = z.infer<typeof ownCleanupMeasuredSchema>
/** The most measures Sotto keeps: 32 servers' worth of a few models each. Older ones go first. */
export const OWN_CLEANUP_MEASURED_MAX = 256
export const ownCleanupMeasuredListSchema = z.array(ownCleanupMeasuredSchema).max(OWN_CLEANUP_MEASURED_MAX)

/**
 * What Measure answers. `measured` carries what was found and saved. `unreachable`: nothing answered, so nothing was
 * saved. `keyed`: the server was added with a key, which Sotto does not have. `not-found`: the server or the model is no
 * longer saved. `failed`: something in Sotto went wrong.
 */
export const ownCleanupMeasureResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('measured'), tuning: ownCleanupTuningSchema }).strict(),
  z.object({ status: z.enum(['unreachable', 'keyed', 'not-found', 'failed']) }).strict(),
])
export type OwnCleanupMeasureResult = z.infer<typeof ownCleanupMeasureResultSchema>

/** The main window's bridge, present only while the feature runs. */
export interface OwnServerCleanupBridge {
  /** Runs the test cleanups for a server's model and saves the fastest passing setting. */
  measure(choice: OwnCleanupChoice): Promise<OwnCleanupMeasureResult>
  /** Every saved measure. */
  measured(): Promise<OwnCleanupMeasured[]>
}
