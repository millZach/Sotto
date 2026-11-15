import { z } from 'zod'
import { MESHY_API } from '../../plugins/meshy/account'

/**
 * Meshy's API behind one adapter (ADR-0141). Every call goes to `api.meshy.ai` with the account's key as a bearer
 * token, over Node's own `fetch`, with no redirect followed and nothing from Electron, so a headless host can run the
 * same code. Read from docs.meshy.ai on November 15, 2026: text to 3D is a preview task (the shape) and then a refine
 * task (the texture) at `/openapi/v2/text-to-3d`; a photo is one image-to-3D task at `/openapi/v1/image-to-3d`; each
 * answers `{"result": "<task id>"}`, and the task is read again at its path until it ends, pacing on `Retry-After` and
 * five seconds when Meshy does not say.
 *
 * Meshy's task IDs stay inside `src/main/tools/meshy/`. A failure is a `MeshyApiError` naming what happened in one
 * word; it never repeats the key, an address or what Meshy wrote.
 */

/** How Meshy's API is reached: `fetch` as main and the host have it, with no redirect followed. */
export type MeshyApiFetch = (url: string, init: {
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly redirect: 'manual'
  readonly signal: AbortSignal
}) => Promise<Response>

/** The formats Sotto asks Meshy for. GLB and USDZ are always made (ADR-0141); the rest when the agent asks. */
export const MESHY_FORMATS = ['glb', 'usdz', 'fbx', 'obj', 'stl'] as const
export type MeshyFormat = (typeof MESHY_FORMATS)[number]

/** The three tasks a 3D model is made of: a shape and a texture from words, or one task from a photo. */
export type MeshyTaskKind = 'preview' | 'refine' | 'photo'

/**
 * What went wrong, in one word. `refused`: Meshy does not take the key, or will not do this for it (401, 403).
 * `no-credits`: the account has no credits left, or is on a plan without API access (402). `rejected`: Meshy will not
 * make this one (400, 409, 422), or Sotto would not send it. `gone`: Meshy no longer has the task (404). `busy`: try
 * again later (429). `unreachable`: no answer, or Meshy failed (5xx). `unreadable`: an answer Sotto could not read.
 */
export type MeshyProblem = 'refused' | 'no-credits' | 'rejected' | 'gone' | 'busy' | 'unreachable' | 'unreadable'

export class MeshyApiError extends Error {
  constructor(readonly problem: MeshyProblem, readonly retryAfterMs?: number) { super(`meshy-${problem}`) }
}

/** A task as Sotto reads it. `files` are Meshy's signed links, which expire; `credits` is what Meshy says it took. */
export interface MeshyTask {
  readonly status: 'waiting' | 'running' | 'made' | 'failed'
  readonly progress: number
  readonly files: Partial<Record<MeshyFormat | 'mtl', string>>
  readonly still?: string
  readonly credits?: number
  /** How long to wait before reading it again: Meshy's `Retry-After`, or five seconds. */
  readonly pollAfterMs: number
}

/** Meshy's own limit on the words of a preview, and on a photo before it is written as a data address. */
export const MESHY_WORDS_MAX = 800
export const MESHY_PHOTO_BYTES_MAX = 20 * 1024 * 1024
/** Meshy's range for a remeshed model's triangles. */
export const MESHY_TRIANGLES_MIN = 100
export const MESHY_TRIANGLES_MAX = 300_000

export const MESHY_POLL_MS = 5_000
/** A `Retry-After` is followed within these bounds, so a wrong one neither hammers Meshy nor stalls a model. */
const RETRY_AFTER_MIN_MS = 1_000
const RETRY_AFTER_MAX_MS = 10 * 60_000
/** Meshy's own client timeouts: a minute to create a task, half a minute to read one. */
const CREATE_TIMEOUT_MS = 60_000
const READ_TIMEOUT_MS = 30_000

const ROUTES: Record<MeshyTaskKind, string> = { preview: '/openapi/v2/text-to-3d', refine: '/openapi/v2/text-to-3d', photo: '/openapi/v1/image-to-3d' }
/** A task ID Sotto will put in a path: Meshy's are short runs of letters, digits and dashes. */
export const MESHY_TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u
const PHOTO_ADDRESS = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u

const createdSchema = z.object({ result: z.string().regex(MESHY_TASK_ID) })
const link = z.string().max(4_096)
const taskSchema = z.object({
  status: z.enum(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED']),
  progress: z.number().optional().catch(undefined),
  model_urls: z.object({ glb: link, usdz: link, fbx: link, obj: link, stl: link, mtl: link }).partial().nullish().catch(undefined),
  thumbnail_url: link.nullish().catch(undefined),
  consumed_credits: z.number().int().nonnegative().optional().catch(undefined),
})

export interface MeshyWordsRequest { readonly words: string; readonly triangles?: number }
export interface MeshyPhotoRequest { readonly photo: string; readonly formats: readonly MeshyFormat[]; readonly triangles?: number }

/** One account's way to Meshy. */
export class MeshyApi {
  private readonly base: string
  constructor(private readonly fetcher: MeshyApiFetch, private readonly key: string, private readonly options: { readonly base?: string; readonly signal?: AbortSignal } = {}) {
    this.base = options.base ?? MESHY_API
  }

  /** Starts a shape from words. Only the shape: its formats do not matter, since the texture task makes the files. */
  createPreview(request: MeshyWordsRequest): Promise<string> {
    if (request.words.trim().length === 0 || request.words.length > MESHY_WORDS_MAX) return Promise.reject(new MeshyApiError('rejected'))
    return this.create('preview', { mode: 'preview', prompt: request.words, target_formats: ['glb'], ...remeshing(request.triangles) })
  }

  /** Textures a finished shape, making the files in these formats. */
  createRefine(previewId: string, formats: readonly MeshyFormat[]): Promise<string> {
    if (!MESHY_TASK_ID.test(previewId)) return Promise.reject(new MeshyApiError('rejected'))
    return this.create('refine', { mode: 'refine', preview_task_id: previewId, target_formats: formats })
  }

  /** Makes a textured model from one photo, sent as a data address and never as a link to somewhere else. */
  createFromPhoto(request: MeshyPhotoRequest): Promise<string> {
    // A data address of at most 20 MB of photo: four characters for every three bytes, and its short prefix.
    if (!PHOTO_ADDRESS.test(request.photo) || request.photo.length > Math.ceil(MESHY_PHOTO_BYTES_MAX / 3) * 4 + 64) return Promise.reject(new MeshyApiError('rejected'))
    return this.create('photo', { image_url: request.photo, should_texture: true, target_formats: request.formats, ...remeshing(request.triangles) })
  }

  /** Reads a task as it stands. */
  async task(kind: MeshyTaskKind, id: string): Promise<MeshyTask> {
    if (!MESHY_TASK_ID.test(id)) throw new MeshyApiError('rejected')
    const response = await this.call(`${ROUTES[kind]}/${id}`, 'GET', undefined, READ_TIMEOUT_MS)
    const parsed = taskSchema.safeParse(await body(response))
    if (!parsed.success) throw new MeshyApiError('unreadable')
    const task = parsed.data
    const files: Partial<Record<MeshyFormat | 'mtl', string>> = {}
    for (const [format, address] of Object.entries(task.model_urls ?? {})) if (typeof address === 'string' && address.length > 0) files[format as MeshyFormat | 'mtl'] = address
    const status = task.status === 'SUCCEEDED' ? 'made' : task.status === 'FAILED' || task.status === 'CANCELED' ? 'failed' : task.status === 'PENDING' ? 'waiting' : 'running'
    return {
      status, files,
      progress: Math.max(0, Math.min(100, Math.round(task.progress ?? 0))),
      ...(task.thumbnail_url ? { still: task.thumbnail_url } : {}),
      ...(task.consumed_credits !== undefined ? { credits: task.consumed_credits } : {}),
      pollAfterMs: retryAfter(response) ?? MESHY_POLL_MS,
    }
  }

  private async create(kind: MeshyTaskKind, payload: Record<string, unknown>): Promise<string> {
    const response = await this.call(ROUTES[kind], 'POST', JSON.stringify(payload), CREATE_TIMEOUT_MS)
    const parsed = createdSchema.safeParse(await body(response))
    if (!parsed.success) throw new MeshyApiError('unreadable')
    return parsed.data.result
  }

  private async call(path: string, method: 'GET' | 'POST', payload: string | undefined, timeoutMs: number): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await this.fetcher(new URL(path, this.base).toString(), {
        method, redirect: 'manual',
        headers: { Authorization: `Bearer ${this.key}`, Accept: 'application/json', ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload !== undefined ? { body: payload } : {}),
        signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout,
      })
    } catch { throw new MeshyApiError('unreachable') }
    if (response.status >= 200 && response.status < 300) return response
    // Nothing of a refusal is read: Meshy's words never reach the user, the agent or a log.
    await response.body?.cancel().catch(() => undefined)
    throw problemOf(response)
  }
}

function remeshing(triangles: number | undefined): Record<string, unknown> {
  if (triangles === undefined) return {}
  return { should_remesh: true, topology: 'triangle', target_polycount: Math.max(MESHY_TRIANGLES_MIN, Math.min(MESHY_TRIANGLES_MAX, Math.round(triangles))) }
}

function problemOf(response: Response): MeshyApiError {
  const status = response.status
  if (status === 401 || status === 403) return new MeshyApiError('refused')
  if (status === 402) return new MeshyApiError('no-credits')
  if (status === 404) return new MeshyApiError('gone')
  if (status === 429) return new MeshyApiError('busy', retryAfter(response))
  if (status === 400 || status === 409 || status === 422) return new MeshyApiError('rejected')
  return new MeshyApiError('unreachable')
}

async function body(response: Response): Promise<unknown> {
  try { return await response.json() } catch { throw new MeshyApiError('unreadable') }
}

/** Meshy's `Retry-After`, in seconds or as a date, held within bounds; undefined when it sent none Sotto can read. */
export function retryAfter(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const ms = /^\d+$/u.test(value) ? Number(value) * 1_000 : Date.parse(value) - now
  if (!Number.isFinite(ms)) return undefined
  return Math.max(RETRY_AFTER_MIN_MS, Math.min(RETRY_AFTER_MAX_MS, ms))
}
