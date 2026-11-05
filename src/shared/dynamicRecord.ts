import { z } from 'zod'
import { providerIdSchema } from './agents'

/**
 * **Its record** (ADR-0191 decision 9): how each model's pieces of a Dynamic thread's work ended on this computer, in
 * counts and no words, on Usage history's terms. It is kept whatever Keep local history says and cleared with a press;
 * pieces from before a clear never return. An overseer reads it when it chooses, and Settings → Threads shows it.
 */

export const DYNAMIC_RECORD_READ = 'sotto:dynamic-record:read'
export const DYNAMIC_RECORD_CLEAR = 'sotto:dynamic-record:clear'
/** Main adds it to the main window's arguments only while the `dynamic-threads` Owl feature is on here. */
export const DYNAMIC_RECORD_RENDERER_ARGUMENT = '--sotto-dynamic-record'
/** The most models one record names: far more than any computer has had. */
export const DYNAMIC_RECORD_MODELS_MAX = 200

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/**
 * One model's line. `pieces`: the pieces an overseer gave it. `finished`: those whose worker answered. `moved`: those an
 * overseer then gave to another model. `tokens`: what its workers' threads used, input and output, as Sotto saw it.
 */
export const dynamicRecordRowSchema = z.object({ provider: providerIdSchema, model: z.string().min(1).max(512), name: z.string().min(1).max(200),
  pieces: count, finished: count, moved: count, tokens: count }).strict()
export type DynamicRecordRow = z.infer<typeof dynamicRecordRowSchema>
export const dynamicRecordReadSchema = z.object({ models: z.array(dynamicRecordRowSchema).max(DYNAMIC_RECORD_MODELS_MAX) }).strict()
export type DynamicRecordRead = z.infer<typeof dynamicRecordReadSchema>

/** The main window's reach into its record: a read, and a clear that answers with what is left, which is nothing. */
export interface DynamicRecordBridge {
  read(): Promise<DynamicRecordRead>
  clear(): Promise<DynamicRecordRead>
}
