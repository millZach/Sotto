import { z } from 'zod'

/**
 * A 3D model Meshy made for a thread, as the window draws it in that thread (ADR-0141; the Meshy plan's ticket 4). Main
 * builds it from the 3D model's record and what Sotto holds in memory while Meshy works: Meshy's percent and the time
 * left, which are never written to the record. It names the 3D model by Sotto's own ID and its files by their names
 * alone, never by a path.
 */

/**
 * What became of a 3D model: `making` while Meshy works on it, at the `shape`, the `texture` or fetching the `files`;
 * `done` with its files in the thread's folder; `failed` or `lost` when it was not made.
 */
export const MODEL_3D_STATES = ['making', 'done', 'failed', 'lost'] as const
export const MODEL_3D_STAGES = ['shape', 'texture', 'files'] as const
/** Why a 3D model was not made, in one word. `src/main/tools/meshy/records.ts` says what each means. */
export const MODEL_3D_FAILURES = ['refused', 'no-credits', 'rejected', 'failed', 'too-large', 'folder', 'unreachable', 'no-account', 'locked', 'expired', 'stopped'] as const
export type Model3dFailure = typeof MODEL_3D_FAILURES[number]

/** A visual's kind for a 3D model in its thread. Sotto adds it; the `visualize` tool does not take it. */
export const MODEL_VISUAL_KIND = '3d-model'

const fileName = z.string().min(1).max(200)
export const model3dViewSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  source: z.enum(['words', 'photo']),
  state: z.enum(MODEL_3D_STATES),
  stage: z.enum(MODEL_3D_STAGES).optional(),
  /** Meshy's percent for the step it is on, and the time left at the rate so far, while it works. */
  percent: z.number().int().min(0).max(100).optional(),
  secondsLeft: z.number().int().nonnegative().optional(),
  credits: z.number().int().nonnegative(),
  /** The folder the files go into, relative to the thread's folder, with forward slashes; empty for the folder itself. */
  folder: z.string().max(1_000),
  /** The files in that folder, the still picture first, each with its size as it is now. A file that is gone has none. */
  files: z.array(z.object({ name: fileName, bytes: z.number().int().nonnegative().optional() }).strict()).max(20),
  still: fileName.optional(),
  /** Whether the shape Meshy made can be drawn while it paints the texture. */
  shape: z.boolean().optional(),
  failure: z.enum(MODEL_3D_FAILURES).optional(),
}).strict()
export type Model3dView = z.infer<typeof model3dViewSchema>

/** Which bytes of a 3D model the window draws: its GLB, its still picture, or the shape while the texture is painted. */
export const MODEL_3D_PARTS = ['model', 'still', 'shape'] as const
export type Model3dPart = typeof MODEL_3D_PARTS[number]
export const model3dRequestSchema = z.object({ id: z.string().min(1).max(100) }).strict()
export const model3dBytesRequestSchema = z.object({ id: z.string().min(1).max(100), part: z.enum(MODEL_3D_PARTS) }).strict()
export type Model3dBytesRequest = z.infer<typeof model3dBytesRequestSchema>
/** The bytes, or null when Sotto will not hand them over: the 3D model or the file is gone, or it is not what it should be. */
export const model3dBytesSchema = z.custom<Uint8Array>(value => value instanceof Uint8Array && value.byteLength > 0).nullable()
export const model3dViewOrNullSchema = model3dViewSchema.nullable()

/** One 3D model's view by its ID, or null when Sotto holds no such 3D model. */
export const PLUGINS_MODEL_3D = 'sotto:plugins:model-3d'
/** Main to the window: a 3D model's view, whenever it changes. */
export const PLUGINS_MODEL_3D_CHANGED = 'sotto:plugins:model-3d-changed'
export const PLUGINS_MODEL_3D_BYTES = 'sotto:plugins:model-3d-bytes'
