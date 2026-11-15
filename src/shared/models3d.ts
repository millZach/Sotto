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

/**
 * A 3D model as the 3D models page and Tools › 3D models list it (the Meshy plan's ticket 5): its view, the thread that
 * made it, the name of the Meshy account it was made with, and when it was asked for. The words sent are there only
 * while the record holds them, as Keep local history says, and a photo by its file name alone. Only 3D models being made
 * or done are listed; one that was not made stays as its line in its thread (Zach's pick on November 15, 2026).
 */
export const model3dListedSchema = z.object({
  ...model3dViewSchema.shape,
  /** The thread that made it, by this computer's own ID for it; a host thread by the window's key for it. */
  threadId: z.string().min(1).max(500),
  /** The Meshy account's name, or empty once that account is gone. */
  account: z.string().max(200),
  askedAt: z.string().datetime(),
  words: z.string().max(2_000).optional(),
  photo: fileName.optional(),
  /**
   * The paired host that holds it, by its name, for a host's 3D model on this computer (the Meshy plan's ticket 6, part
   * 2): the page's kind line ends with it ("on forge"). Main sets it; a host's own answer never carries it.
   */
  computer: z.string().min(1).max(200).optional(),
}).strict()
export type Model3dListed = z.infer<typeof model3dListedSchema>
/** The most 3D models one list holds. */
export const MODELS_3D_LISTED_MAX = 2_000
export const model3dListSchema = z.array(model3dListedSchema).max(MODELS_3D_LISTED_MAX)
/** Every 3D model, or one thread's, by the key the window names the thread by. */
export const model3dListRequestSchema = z.object({ threadId: z.string().min(1).max(600).optional() }).strict()
export type Model3dListRequest = z.infer<typeof model3dListRequestSchema>
/** One of a 3D model's files to show in the folder app, by its name in the record; its GLB, or its first file, when none is named. */
export const model3dRevealRequestSchema = z.object({ id: z.string().min(1).max(100), file: fileName.optional() }).strict()
export type Model3dRevealRequest = z.infer<typeof model3dRevealRequestSchema>
/** Whether main showed the file. */
export const model3dDoneSchema = z.boolean()
/**
 * What became of Remove from 3D models: the record was `removed`; it stays because `files-there` (one of its files is
 * back), because it `changed` meanwhile (it is not a finished 3D model as it was looked at); or there was `no-record`.
 */
export const MODEL_3D_REMOVALS = ['removed', 'files-there', 'changed', 'no-record'] as const
export type Model3dRemoval = typeof MODEL_3D_REMOVALS[number]
export const model3dRemovalSchema = z.enum(MODEL_3D_REMOVALS)

/**
 * Whether a finished 3D model's files are all gone from its folder: none has a size, as when they were moved, renamed
 * or deleted, or the folder is no longer inside the thread's.
 */
export function model3dFilesGone(view: Pick<Model3dView, 'state' | 'files'>): boolean {
  return view.state === 'done' && view.files.every(file => file.bytes === undefined)
}

/** The 3D models the window lists, newest first; optionally one thread's. */
export const PLUGINS_MODELS_3D = 'sotto:plugins:models-3d'
/** Removes the record of a 3D model whose files are gone. Never a file. */
export const PLUGINS_MODEL_3D_REMOVE = 'sotto:plugins:model-3d-remove'
/** Shows one of a 3D model's files in the folder app. */
export const PLUGINS_MODEL_3D_REVEAL = 'sotto:plugins:model-3d-reveal'
/** Main to the window: the IDs of 3D models whose records went, with their forgotten thread or by Remove from 3D models. */
export const PLUGINS_MODELS_3D_REMOVED = 'sotto:plugins:models-3d-removed'
export const model3dRemovedSchema = z.array(z.string().min(1).max(100)).min(1).max(2_000)

/**
 * A paired host's 3D models on this computer (the Meshy plan's ticket 6, part 2; host feature `plugin-meshy-models`).
 * The host answers with its own IDs: a listed 3D model names its thread by the host's ID for it. Main gives the window
 * each one by a key that says which host holds it, as a host thread's key does (`hostEntityKey`), its thread by that
 * thread's key, and `computer`, the host's name. The window asks for one by that key, and main sends its host the ID.
 */
/**
 * A 3D model's bytes cross the connection in parts no larger than this, as a video's do, so no frame passes the socket's
 * cap. A GLB is read whole on the host, checked as one on this computer is (inside its record's folder, under the cap,
 * standing alone), and then handed over a part at a time from what was checked.
 */
export const MODEL_3D_HOST_PART_BYTES = 8 * 1024 * 1024
/**
 * The most a host's 3D model may be to be drawn on this computer: 64 MiB, eight parts. A GLB Meshy makes is a few MB; a
 * larger one is drawn from its still picture rather than held whole in main and the window.
 */
export const MODEL_3D_HOST_BYTES_MAX = 64 * 1024 * 1024
export const MODEL_3D_HOST_PARTS_MAX = MODEL_3D_HOST_BYTES_MAX / MODEL_3D_HOST_PART_BYTES
/** The host's SHA-256 of the whole file it checked, in hex, which every part of it carries and the whole must match. */
const digest = z.string().regex(/^[0-9a-f]{64}$/u)
/** One part of a host's 3D model's bytes, from `offset` in the file the host checked, which is `total` bytes long. */
export const model3dHostBytesRequestSchema = z.object({
  id: z.string().min(1).max(100), part: z.enum(MODEL_3D_PARTS),
  offset: z.number().int().min(0).max(MODEL_3D_HOST_BYTES_MAX - 1),
  /** After the first part, the digest it carried: a file that changed since is refused rather than mixed. */
  digest: digest.optional(),
}).strict()
export type Model3dHostBytesRequest = z.infer<typeof model3dHostBytesRequestSchema>
export const model3dHostBytesSchema = z.object({
  data: z.string().min(1).max(Math.ceil(MODEL_3D_HOST_PART_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/u),
  total: z.number().int().positive().max(MODEL_3D_HOST_BYTES_MAX),
  digest,
}).strict().nullable()
export type Model3dHostBytes = z.infer<typeof model3dHostBytesSchema>
/**
 * The host's news of its 3D models (`plugin-meshy-models` push): one 3D model's view, with the thread that made it by the
 * host's ID for it, as it changes; and the IDs of 3D models whose records went, with their forgotten thread or by Remove
 * from 3D models.
 */
export const model3dHostNewsSchema = z.object({
  changed: z.object({ threadId: z.string().min(1).max(500), view: model3dViewSchema }).strict().optional(),
  removed: model3dRemovedSchema.optional(),
}).strict()
export type Model3dHostNews = z.infer<typeof model3dHostNewsSchema>

/**
 * A host's 3D models as a recorded desktop reads them (`plugin-meshy-models`), by the host's own IDs: on the headless
 * host over its records, and on the desktop's connection to it over the socket. Bytes come a part at a time, each part
 * from the one file the host checked, for the client that asked.
 */
export interface HostModelViews {
  list(threadId?: string): Promise<Model3dListed[]>
  view(id: string): Promise<Model3dView | null>
  bytes(request: Model3dHostBytesRequest, clientId: string): Promise<Model3dHostBytes>
  remove(id: string): Promise<Model3dRemoval>
  /** Hears a 3D model change, or records go. Returns the way to stop. */
  subscribe(listener: (news: Model3dHostNews) => void): () => void
}
