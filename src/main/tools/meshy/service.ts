import { randomUUID } from 'node:crypto'
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { MESHY_CREDITS, MESHY_POLL_MS, MeshyApi, MeshyApiError, type MeshyApiFetch, type MeshyFormat, type MeshyTask, type MeshyTaskKind } from './api'
import { DownloadError, downloadModelFile, fetchModelBytes, isInside, isPartOf, modelFolder } from './download'
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

export { MESHY_CREDITS }
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
  /** Each change to a 3D model, for whatever shows it, with Meshy's progress on its step while Meshy works. */
  readonly changed?: (model: ThreeDModel, progress: ModelProgress | undefined) => void
}

/**
 * Meshy's percent for the step a 3D model is on, and the seconds left at the rate it has gone since Sotto first read
 * that step. Held in memory alone, and never written to the record: a restart starts the rate again.
 */
export interface ModelProgress { readonly percent: number; readonly secondsLeft?: number }
interface Live { readonly stage: (typeof MODEL_STAGES)[number]; readonly since: number; readonly from: number; percent: number; secondsLeft?: number }

/** How a run ends early: a state the record takes, why, and the credits that come back, written together. */
class Ending {
  constructor(readonly state: 'failed' | 'lost', readonly failure: NonNullable<ModelRecord['failure']>, readonly refund = 0) {}
}
/** The record went while the 3D model was being made: its thread was forgotten. Nothing more is written. */
class Forgotten {}

export class MeshyModels {
  private readonly running = new Map<string, Promise<ThreeDModel | undefined>>()
  private readonly live = new Map<string, Live>()
  /** The shape Meshy made, by its signed link, while the texture is painted; and its bytes once the window asked. */
  private readonly shapes = new Map<string, { readonly link: string; bytes?: Promise<Uint8Array | null> }>()
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
    this.options.changed?.(modelOf(record), undefined)
    // The words and the photo are handed over here, and are not read back from the record.
    const done = this.run(record.id, request.source.kind === 'words' ? { words: request.source.words } : { photo: request.source.photo })
    return { model: modelOf(record), done }
  }

  /** The run of a 3D model being made now, if there is one. */
  whenDone(id: string): Promise<ThreeDModel | undefined> | undefined { return this.running.get(id) }

  /** Meshy's progress on a 3D model's step, while Sotto is reading it. */
  progressOf(id: string, stage: ModelRecord['stage']): ModelProgress | undefined {
    const held = this.live.get(id)
    if (!held || held.stage !== stage) return undefined
    return { percent: held.percent, ...(held.secondsLeft !== undefined ? { secondsLeft: held.secondsLeft } : {}) }
  }

  /** Whether the shape Meshy made can be drawn now, while it paints the texture. */
  hasShape(id: string): boolean { return this.shapes.has(id) }

  /**
   * The shape Meshy made, fetched into memory from Meshy's file server the first time the window asks and never
   * written anywhere; null once the texture is done, or when it cannot be fetched.
   */
  shapeBytes(id: string): Promise<Uint8Array | null> {
    const shape = this.shapes.get(id)
    if (!shape) return Promise.resolve(null)
    shape.bytes ??= fetchModelBytes(this.options.fetch, shape.link, { ...(this.options.assets ? { assets: this.options.assets } : {}),
      ...(this.options.fileBytesMax !== undefined ? { maxBytes: this.options.fileBytesMax } : {}), signal: this.options.signal }).catch(() => null)
    return shape.bytes
  }

  /** Picks up every 3D model still being made when Sotto last stopped. */
  async resume(): Promise<void> {
    for (const record of await this.options.records.unfinished()) void this.run(record.id, {})
  }

  private run(id: string, inputs: { readonly words?: string; readonly photo?: string }): Promise<ThreeDModel | undefined> {
    const held = this.running.get(id)
    if (held) return held
    const run = this.drive(id, inputs).finally(() => { this.running.delete(id); this.live.delete(id); this.shapes.delete(id) })
    this.running.set(id, run)
    return run
  }

  private async drive(id: string, inputs: { readonly words?: string; readonly photo?: string }): Promise<ThreeDModel | undefined> {
    try {
      const record = await this.current(id)
      this.inTime(record)
      // A key the credential store will not hand over, as while it is locked, ends it here: nothing has gone to Meshy.
      let key: string | undefined
      try { key = await this.options.keyOf(record.accountId) } catch { throw new Ending('failed', 'locked') }
      if (!key) throw new Ending('failed', 'no-account')
      const api = new MeshyApi(this.options.fetch, key, { ...(this.options.base ? { base: this.options.base } : {}), signal: this.options.signal })
      let made: MeshyTask
      if (record.source.kind === 'words') {
        const words = inputs.words
        // A texture Meshy already has needs no second look at its shape.
        if (record.job.refine === undefined) {
          const shape = await this.step(id, api, 'preview', 'shape', words === undefined ? undefined : () => api.createPreview({ words, ...(record.triangles !== undefined ? { triangles: record.triangles } : {}) }))
          // The shape can be turned while Meshy paints the texture.
          if (shape.files.glb) this.shapes.set(id, { link: shape.files.glb })
        } else if (record.job.preview !== undefined) {
          // Picked up during the texture: the shape's link is read once more from the task Meshy keeps, so it can be
          // turned again. Without it the texture carries on, with nothing to show meanwhile.
          const shape = await api.task('preview', record.job.preview).catch(() => undefined)
          if (shape?.status === 'made' && shape.files.glb) this.shapes.set(id, { link: shape.files.glb })
        }
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
      // Its credits are counted as it is asked for, so a task Meshy took just as Sotto stopped is not left uncounted.
      record = await this.change(id, held => ({ ...held, stage, credits: held.credits + MESHY_CREDITS[kind], job: { ...held.job, asking: kind } }))
      try { taskId = await this.ask(record, create) } catch (error) {
        // Its credits come back only when Meshy plainly did not take it. With no answer Sotto can read, it may have.
        throw error instanceof Ending && error.failure !== 'unreachable' ? new Ending(error.state, error.failure, MESHY_CREDITS[kind]) : error
      }
      const asked = taskId
      await this.change(id, held => {
        const job = { ...held.job, [kind]: asked }
        delete job.asking
        return { ...held, job }
      })
    }
    let backoff = MESHY_POLL_MS
    for (;;) {
      // Read again at each turn, so a 3D model whose thread was forgotten meanwhile stops here: nothing more is asked
      // of Meshy for it, its progress is not sent, and the shape it held goes with it.
      record = await this.current(id)
      this.inTime(record)
      let task: MeshyTask
      try { task = await api.task(kind, taskId) } catch (error) {
        this.stopping()
        const problem = error instanceof MeshyApiError ? error.problem : 'unreachable'
        if (problem === 'gone') throw new Ending('lost', 'expired')
        if (problem === 'refused' || problem === 'no-credits' || problem === 'rejected') throw new Ending('failed', problem === 'rejected' ? 'rejected' : 'refused')
        // Meshy says a failed read is tried again at the next one, and does not mean the task failed.
        await this.wait(problem === 'busy' && error instanceof MeshyApiError && error.retryAfterMs !== undefined ? error.retryAfterMs : backoff)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        continue
      }
      backoff = MESHY_POLL_MS
      if (task.status === 'made') return task
      // Meshy refunds a task that failed.
      if (task.status === 'failed') throw new Ending('failed', 'failed', MESHY_CREDITS[kind])
      if (this.observe(id, stage, task.progress)) this.options.changed?.(modelOf(record), this.progressOf(id, record.stage))
      await this.wait(task.pollAfterMs)
    }
  }

  /**
   * Asks Meshy for a task. A 429 took nothing, so it is asked again when Meshy says, until Meshy's three days are up.
   * A refusal (401, 402, 403, 400, 409, 422) took nothing either, and fails it. Anything else (no answer in time, a
   * dropped connection, a 5xx, or an answer Sotto cannot read) may have been taken and charged without Sotto learning
   * the task, so it is lost with its credits counted, and never asked for again.
   */
  private async ask(record: ModelRecord, create: () => Promise<string>): Promise<string> {
    for (;;) {
      this.inTime(record)
      try { return await create() } catch (error) {
        this.stopping()
        const problem = error instanceof MeshyApiError ? error.problem : 'unreachable'
        if (problem === 'busy') { await this.wait(error instanceof MeshyApiError && error.retryAfterMs !== undefined ? error.retryAfterMs : MESHY_POLL_MS); continue }
        if (problem === 'refused' || problem === 'no-credits' || problem === 'rejected') throw new Ending('failed', problem)
        throw new Ending('lost', 'unreachable')
      }
    }
  }

  /** Fetches the finished files into the folder, under one free name, the still picture first. */
  private async fetchFiles(id: string, made: MeshyTask): Promise<ThreeDModel> {
    // A try Sotto was stopped in is started again whole: what it wrote is this 3D model's own, and goes.
    await this.clearTry(await this.current(id))
    this.shapes.delete(id)
    let record = await this.change(id, held => ({ ...held, stage: 'files', files: [] }))
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
          await downloadModelFile(this.options.fetch, address, { root: record.root, folder: record.folder, fileName, owner: id },
            { ...(this.options.assets ? { assets: this.options.assets } : {}), ...(this.options.fileBytesMax !== undefined ? { maxBytes: this.options.fileBytesMax } : {}), signal: this.options.signal })
          files.push(fileName)
          // Each whole file is named in the record as it lands, so a try stopped part way knows what was its own.
          record = await this.change(id, held => ({ ...held, files: [...files] }))
        }
      } catch (error) {
        // What this try wrote goes, so the next try starts whole or the record names no half of a 3D model.
        if (error instanceof Forgotten) throw error
        await this.removeOwn(record, files)
        // Written before anything else, stopping included, so the record never names files that are gone and may
        // since be someone else's.
        await this.change(id, held => ({ ...held, files: [] }))
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

  /** The files and part files a try stopped hard left, which are this 3D model's own. */
  private async clearTry(record: ModelRecord): Promise<void> {
    const names = await readdir(record.folder).catch(() => [] as string[])
    await this.removeOwn(record, [...record.files, ...names.filter(name => isPartOf(record.id, name))])
  }

  /** Removes files this 3D model wrote, only while its folder is still inside the thread's working folder. */
  private async removeOwn(record: ModelRecord, names: readonly string[]): Promise<void> {
    if (names.length === 0) return
    const inside = await Promise.all([realpath(record.root), realpath(record.folder)]).then(([root, folder]) => isInside(root, folder), () => false)
    if (!inside) return
    await Promise.all(names.map(name => rm(join(record.folder, name), { force: true }).catch(() => undefined)))
  }

  private async end(id: string, ending: Ending): Promise<ThreeDModel | undefined> {
    try {
      return modelOf(await this.change(id, held => ended({ ...held, state: ending.state, failure: ending.failure, credits: Math.max(0, held.credits - ending.refund) }, this.now())))
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
    this.options.changed?.(modelOf(next), next.state === 'making' ? this.progressOf(id, next.stage) : undefined)
    return next
  }

  /**
   * Keeps Meshy's percent for a step, and the seconds left at the rate since Sotto first read that step. True when
   * either changed.
   */
  private observe(id: string, stage: (typeof MODEL_STAGES)[number], percent: number): boolean {
    const now = this.now()
    const held = this.live.get(id)
    if (!held || held.stage !== stage) { this.live.set(id, { stage, since: now, from: percent, percent }); return true }
    const gained = percent - held.from
    const elapsed = now - held.since
    const secondsLeft = gained > 0 && elapsed > 0 && percent < 100 ? Math.max(1, Math.round((100 - percent) * elapsed / gained / 1_000)) : undefined
    if (held.percent === percent && held.secondsLeft === secondsLeft) return false
    held.percent = percent
    if (secondsLeft === undefined) delete held.secondsLeft
    else held.secondsLeft = secondsLeft
    return true
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
