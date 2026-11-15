import { randomUUID } from 'node:crypto'
import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { MESHY_POLL_MS, MeshyApi, MeshyApiError, type MeshyApiFetch, type MeshyFormat, type MeshyTask, type MeshyTaskKind } from './api'
import { DownloadError, downloadModelFile, modelFolder } from './download'
import { MODEL_KEPT_MS, MODEL_STAGES, modelOf, type ModelRecord, type ModelRecords, type ThreeDModel } from './records'

/**
 * Making a 3D model with Meshy (ADR-0141), from the request to the files in the thread's folder. Asking the user, the
 * month's limit and the tool are ticket 3's; this runs what was already allowed. Everything here addresses a 3D model
 * by its own ID; Meshy's task IDs stay in its record.
 *
 * Words are a shape task and then a texture task; a photo is one task. Each task is kept in the record once Meshy
 * takes it, so a 3D model still being made when Sotto quits is picked up when Sotto starts, for Meshy's three days.
 * A task Sotto was asking for when it stopped is never asked for again, since Meshy may have taken and charged it.
 */

/** Meshy's price table on October 22, 2026 (docs.meshy.ai/en/api/pricing): what each task costs when it is asked for. */
export const MESHY_CREDITS: Readonly<Record<MeshyTaskKind, number>> = { preview: 20, refine: 10, photo: 30 }
/** Where a thread's 3D models go when its agent names no folder. */
export const MODEL_FOLDER = 'models'
/** Always made, so the viewer and the iPhone can draw every 3D model. */
const ALWAYS: readonly MeshyFormat[] = ['glb', 'usdz']
/** How long Sotto waits between tries when Meshy does not answer, at most. */
const BACKOFF_MAX_MS = 5 * 60_000
const STILL_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const
const NAMES_MAX = 1_000

export interface ModelRequest {
  readonly threadId: string
  readonly accountId: string
  readonly name: string
  /** The thread's working folder, and a folder inside it; `models` when none is named. */
  readonly root: string
  readonly folder?: string
  /** What goes to Meshy. A photo is a data address, already checked and redrawn without its location and camera. */
  readonly source: { readonly kind: 'words'; readonly words: string } | { readonly kind: 'photo'; readonly fileName: string; readonly photo: string }
  /** Formats beyond GLB and USDZ, which are always made. */
  readonly formats?: readonly MeshyFormat[]
  readonly triangles?: number
}

export interface MeshyModelsOptions {
  readonly records: ModelRecords
  readonly fetch: MeshyApiFetch
  /** The key of the Meshy account that asked, or undefined when that account is gone or holds none. */
  readonly keyOf: (accountId: string) => string | undefined | Promise<string | undefined>
  /** Ends every wait and call when Sotto stops; a 3D model being made then stays to be picked up on start. */
  readonly signal: AbortSignal
  /** A stand-in for Meshy's API and file server, for tests. */
  readonly base?: string
  readonly assets?: string
  /** The most one file may be; MODEL_FILE_BYTES_MAX unless a test says less. */
  readonly fileBytesMax?: number
  readonly now?: () => number
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Each change to a 3D model, for whatever shows it. */
  readonly changed?: (model: ThreeDModel) => void
}

/** How a run ends early: a state the record takes and why. */
class Ending {
  constructor(readonly state: 'failed' | 'lost', readonly failure: NonNullable<ModelRecord['failure']>) {}
}
/** The record went while the 3D model was being made: its thread was forgotten. Nothing more is written. */
class Forgotten {}

export class MeshyModels {
  private readonly running = new Map<string, Promise<ThreeDModel | undefined>>()
  constructor(private readonly options: MeshyModelsOptions) {}

  /**
   * Starts a 3D model the user allowed. Its record is kept before anything goes to Meshy; `done` settles with the 3D
   * model as it ended, or undefined when Sotto stopped first or the thread was forgotten. Rejects, with nothing sent,
   * when the folder is not inside the thread's working folder or the record cannot be kept.
   */
  async make(request: ModelRequest): Promise<{ readonly model: ThreeDModel; readonly done: Promise<ThreeDModel | undefined> }> {
    const folder = await modelFolder(request.root, request.folder ?? MODEL_FOLDER)
    const record = await this.options.records.add({
      id: randomUUID(), threadId: request.threadId, accountId: request.accountId, name: request.name,
      source: request.source.kind === 'words' ? { kind: 'words', words: request.source.words } : { kind: 'photo', fileName: request.source.fileName },
      root: request.root, folder, formats: [...new Set([...ALWAYS, ...(request.formats ?? [])])],
      ...(request.triangles !== undefined ? { triangles: request.triangles } : {}),
      state: 'making', stage: 'shape', credits: 0, askedAt: new Date(this.now()).toISOString(), files: [], job: {},
    })
    this.options.changed?.(modelOf(record))
    // The words and the photo are handed over here, and are not read back from the record.
    const done = this.run(record.id, request.source.kind === 'words' ? { words: request.source.words } : { photo: request.source.photo })
    return { model: modelOf(record), done }
  }

  /** The run of a 3D model being made now, if there is one. */
  whenDone(id: string): Promise<ThreeDModel | undefined> | undefined { return this.running.get(id) }

  /** Picks up every 3D model still being made when Sotto last stopped. */
  async resume(): Promise<void> {
    for (const record of await this.options.records.unfinished()) void this.run(record.id, {})
  }

  private run(id: string, inputs: { readonly words?: string; readonly photo?: string }): Promise<ThreeDModel | undefined> {
    const held = this.running.get(id)
    if (held) return held
    const run = this.drive(id, inputs).finally(() => this.running.delete(id))
    this.running.set(id, run)
    return run
  }

  private async drive(id: string, inputs: { readonly words?: string; readonly photo?: string }): Promise<ThreeDModel | undefined> {
    try {
      const record = await this.current(id)
      this.inTime(record)
      const key = await this.options.keyOf(record.accountId)
      if (!key) throw new Ending('failed', 'no-account')
      const api = new MeshyApi(this.options.fetch, key, { ...(this.options.base ? { base: this.options.base } : {}), signal: this.options.signal })
      let made: MeshyTask
      if (record.source.kind === 'words') {
        const words = inputs.words
        // A texture Meshy already has needs no second look at its shape.
        if (record.job.refine === undefined) await this.step(id, api, 'preview', 'shape', words === undefined ? undefined : () => api.createPreview({ words, ...(record.triangles !== undefined ? { triangles: record.triangles } : {}) }))
        const shaped = await this.current(id)
        made = await this.step(id, api, 'refine', 'texture', () => api.createRefine(shaped.job.preview!, shaped.formats))
      } else {
        const photo = inputs.photo
        made = await this.step(id, api, 'photo', 'shape', photo === undefined ? undefined
          : () => api.createFromPhoto({ photo, formats: record.formats, ...(record.triangles !== undefined ? { triangles: record.triangles } : {}) }))
      }
      return await this.fetchFiles(id, made)
    } catch (error) {
      if (error instanceof Forgotten) return undefined
      if (error instanceof Ending) return this.end(id, error)
      // Sotto is stopping: the record stays as it is, to be picked up on start.
      if (this.options.signal.aborted) return undefined
      console.warn('meshy-model-record-not-written')
      return undefined
    }
  }

  /**
   * One Meshy task of a 3D model: asked for when the record has none yet, then read until it ends. `create` is
   * undefined when what it needs was not kept (the words with history off, or the photo, after a restart).
   */
  private async step(id: string, api: MeshyApi, kind: MeshyTaskKind, stage: (typeof MODEL_STAGES)[number], create: (() => Promise<string>) | undefined): Promise<MeshyTask> {
    let record = await this.current(id)
    let taskId = record.job[kind]
    if (taskId === undefined) {
      // Sotto stopped while asking for it, or no longer has what it would send: what became of it cannot be told.
      if (record.job.asking === kind || !create) throw new Ending('lost', 'stopped')
      await this.change(id, held => ({ ...held, stage, job: { ...held.job, asking: kind } }))
      taskId = await this.ask(create)
      const asked = taskId
      record = await this.change(id, held => {
        const job = { ...held.job, [kind]: asked }
        delete job.asking
        return { ...held, credits: held.credits + MESHY_CREDITS[kind], job }
      })
    }
    let backoff = MESHY_POLL_MS
    for (;;) {
      this.inTime(record)
      let task: MeshyTask
      try { task = await api.task(kind, taskId) } catch (error) {
        this.stopping()
        const problem = error instanceof MeshyApiError ? error.problem : 'unreachable'
        if (problem === 'gone') throw new Ending('lost', 'expired')
        if (problem === 'refused' || problem === 'no-credits') throw new Ending('failed', 'refused')
        // Meshy says a failed read is tried again at the next one, and does not mean the task failed.
        await this.wait(problem === 'busy' && error instanceof MeshyApiError && error.retryAfterMs !== undefined ? error.retryAfterMs : backoff)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        continue
      }
      backoff = MESHY_POLL_MS
      if (task.status === 'made') return task
      if (task.status === 'failed') {
        // Meshy refunds a task that failed.
        await this.change(id, held => ({ ...held, credits: Math.max(0, held.credits - MESHY_CREDITS[kind]) }))
        throw new Ending('failed', 'failed')
      }
      await this.wait(task.pollAfterMs)
    }
  }

  /** Asks Meshy for a task. A 429 took nothing, so it is asked again when Meshy says; any other refusal ends it. */
  private async ask(create: () => Promise<string>): Promise<string> {
    for (;;) {
      try { return await create() } catch (error) {
        this.stopping()
        const problem = error instanceof MeshyApiError ? error.problem : 'unreachable'
        if (problem === 'busy') { await this.wait(error instanceof MeshyApiError && error.retryAfterMs !== undefined ? error.retryAfterMs : MESHY_POLL_MS); continue }
        throw new Ending('failed', problem === 'refused' || problem === 'no-credits' || problem === 'rejected' ? problem : 'unreachable')
      }
    }
  }

  /** Fetches the finished files into the folder, under one free name, the still picture first. */
  private async fetchFiles(id: string, made: MeshyTask): Promise<ThreeDModel> {
    let record = await this.change(id, held => ({ ...held, stage: 'files' }))
    if (!made.files.glb) throw new Ending('failed', 'failed')
    let backoff = MESHY_POLL_MS
    for (;;) {
      this.inTime(record)
      const wanted = record.formats.flatMap(format => format === 'obj' ? ['obj', 'mtl'] as const : [format]).filter(format => made.files[format] !== undefined)
      const base = await this.freeName(record)
      const still = made.still ? `${base}.${stillExtension(made.still)}` : undefined
      const files: string[] = []
      try {
        for (const [address, fileName] of [...(still ? [[made.still!, still] as const] : []), ...wanted.map(format => [made.files[format]!, `${base}.${format}`] as const)]) {
          await downloadModelFile(this.options.fetch, address, { root: record.root, folder: record.folder, fileName },
            { ...(this.options.assets ? { assets: this.options.assets } : {}), ...(this.options.fileBytesMax !== undefined ? { maxBytes: this.options.fileBytesMax } : {}), signal: this.options.signal })
          files.push(fileName)
        }
      } catch (error) {
        // What this try wrote goes, so the next try starts whole or the record names no half of a 3D model.
        await Promise.all(files.map(name => rm(join(record.folder, name), { force: true }).catch(() => undefined)))
        this.stopping()
        const problem = error instanceof DownloadError ? error.problem : 'unreachable'
        if (problem === 'gone') throw new Ending('lost', 'expired')
        if (problem === 'too-large') throw new Ending('failed', 'too-large')
        if (problem === 'folder' || problem === 'refused') throw new Ending('failed', problem === 'refused' ? 'failed' : 'folder')
        // Another file took the name, or Meshy did not answer: try again.
        if (problem === 'unreachable') { await this.wait(backoff); backoff = Math.min(backoff * 2, BACKOFF_MAX_MS) }
        record = await this.current(id)
        continue
      }
      return modelOf(await this.change(id, held => ended({ ...held, state: 'done', files, ...(still ? { still } : {}) }, this.now())))
    }
  }

  /** The first name none of whose files is in the folder yet: the 3D model's own, then with -2, -3 and on. */
  private async freeName(record: ModelRecord): Promise<string> {
    const base = modelFileBase(record.name)
    const extensions = [...record.formats, 'mtl', ...STILL_EXTENSIONS]
    for (let n = 1; n <= NAMES_MAX; n++) {
      const name = n === 1 ? base : `${base}-${n}`
      const taken = await Promise.all(extensions.map(extension => lstat(join(record.folder, `${name}.${extension}`)).then(() => true, () => false)))
      if (!taken.includes(true)) return name
    }
    throw new Ending('failed', 'folder')
  }

  private async end(id: string, ending: Ending): Promise<ThreeDModel | undefined> {
    try {
      return modelOf(await this.change(id, held => ended({ ...held, state: ending.state, failure: ending.failure }, this.now())))
    } catch { return undefined }
  }

  private async current(id: string): Promise<ModelRecord> {
    const record = await this.options.records.record(id)
    if (!record) throw new Forgotten()
    return record
  }

  private async change(id: string, change: (record: ModelRecord) => ModelRecord): Promise<ModelRecord> {
    const next = await this.options.records.update(id, change)
    if (!next) throw new Forgotten()
    this.options.changed?.(modelOf(next))
    return next
  }

  /** Past Meshy's three days its files are gone: the record says it was lost, and nothing more is charged. */
  private inTime(record: ModelRecord): void {
    if (this.now() - Date.parse(record.askedAt) > MODEL_KEPT_MS) throw new Ending('lost', 'expired')
  }

  /** Throws when Sotto is stopping, so nothing past this point is written. */
  private stopping(): void { if (this.options.signal.aborted) throw this.options.signal.reason }

  private async wait(ms: number): Promise<void> {
    await (this.options.wait ?? ((delay, signal) => sleep(delay, undefined, { signal })))(ms, this.options.signal)
    this.stopping()
  }

  private now(): number { return this.options.now?.() ?? Date.now() }
}

/** A 3D model's name as a file name: nothing Windows refuses, at most 80 characters, and never empty or reserved. */
export function modelFileBase(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[\\/:*?"<>|\p{Cc}]+/gu, '-').replace(/\s+/gu, ' ').trim()
  let base = Array.from(cleaned).slice(0, 80).join('').replace(/^[\s.-]+|[\s.]+$/gu, '')
  if (base.length === 0) base = '3d-model'
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)$/iu.test(base)) base = `${base}-model`
  return base
}

/** A record as it ends: no stage, and when. */
function ended(record: ModelRecord, now: number): ModelRecord {
  const next = { ...record, endedAt: new Date(now).toISOString() }
  delete next.stage
  return next
}

/** The still picture's own extension, from its link; PNG when the link does not say. */
function stillExtension(address: string): (typeof STILL_EXTENSIONS)[number] {
  let path = ''
  try { path = new URL(address).pathname.toLowerCase() } catch { /* Not a link: the download refuses it. */ }
  return STILL_EXTENSIONS.find(extension => path.endsWith(`.${extension}`)) ?? 'png'
}
