import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  speechModelBytes,
  speechModelFileUrl,
  type SottoSpeechModel,
  type SpeechModelFailure,
  type SpeechModelFile,
  type SpeechModelStatus,
} from '../../shared/speechModel'
import type { SpeechEngine, SpeechEngineLoader } from './speechEngine'

/**
 * GitHub serves a release asset by redirecting from github.com to its asset host. Only these hosts
 * are followed, over HTTPS, at most five times; the README names them already for update checks.
 */
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com'])
const MAX_REDIRECTS = 5
/** A download that has received nothing for this long has stalled; it fails and a retry resumes it. */
const STALL_MS = 30_000
/** Progress is pushed at most this often, so a fast link does not flood the windows. */
const PROGRESS_INTERVAL_MS = 250
/** Written once every file has matched its pin, so a later start checks sizes instead of hashing 670 MB again. */
const VERIFIED_MARKER = 'verified.json'

class SpeechModelError extends Error {
  constructor(readonly reason: SpeechModelFailure) {
    super(reason)
  }
}

export interface SpeechModelStoreDependencies {
  /** The folder that holds every speech model, under userData. */
  readonly directory: string
  readonly loadEngine: SpeechEngineLoader
  readonly onStatus: (status: SpeechModelStatus) => void
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
  /** The model this store downloads and runs; a test passes a small one. */
  readonly model: SottoSpeechModel
  readonly fileUrl?: (file: SpeechModelFile) => string
}

/**
 * Owns one of Sotto's speech models on disk and the engine running it (ADR-0071); there is one store
 * per model Sotto downloads, each in its own folder (ADR-0094). `ensure()` makes the model
 * ready: files already verified load at once; missing or partial files download, resuming where a
 * stopped download left off, and must match their pinned size and SHA-256 before the engine starts.
 * Only one `ensure()` runs at a time; calling it again while it runs returns the same attempt.
 * `unload()` lets go of the model when the user picks another one; an attempt already running then
 * stops at its next chunk and never publishes, so it cannot bring the old model back.
 */
export class SpeechModelStore {
  private status: SpeechModelStatus = { state: 'missing' }
  private engine: SpeechEngine | null = null
  private attempt: Promise<void> | null = null
  /** The last attempt started, finished or not; a new one waits for it so two never write the same files. */
  private latest: Promise<void> = Promise.resolve()
  /** Bumped by `unload()`; an attempt from an earlier generation no longer counts. */
  private generation = 0
  private readonly listeners = new Set<(status: SpeechModelStatus) => void>()
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly modelDirectory: string
  readonly model: SottoSpeechModel
  private readonly fileUrl: (file: SpeechModelFile) => string
  private readonly totalBytes: number
  private disposed = false

  constructor(private readonly dependencies: SpeechModelStoreDependencies) {
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.now = dependencies.now ?? Date.now
    this.model = dependencies.model
    this.fileUrl = dependencies.fileUrl ?? ((file) => speechModelFileUrl(this.model, file))
    this.totalBytes = speechModelBytes(this.model)
    this.modelDirectory = join(dependencies.directory, this.model.id)
  }

  get(): SpeechModelStatus {
    return this.status
  }

  /** The engine while the model is ready, otherwise null. */
  currentEngine(): SpeechEngine | null {
    return this.status.state === 'ready' ? this.engine : null
  }

  ensure(): Promise<void> {
    if (this.status.state === 'ready') return Promise.resolve()
    if (this.attempt === null) {
      const generation = this.generation
      const attempt = this.latest.then(() => this.run(generation)).finally(() => {
        if (this.attempt === attempt) this.attempt = null
      })
      this.attempt = attempt
      this.latest = attempt
    }
    return this.attempt
  }

  /** Hears every status after `onStatus` does; the speech model manager passes them on while this model is chosen. */
  subscribe(listener: (status: SpeechModelStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** True when the files are here and verified, without hashing them again or loading anything. */
  isDownloaded(): Promise<boolean> {
    return this.verifiedOnDisk()
  }

  /** Lets go of the engine when another model is chosen, and goes back to `missing`; the files stay. */
  unload(): void {
    this.generation += 1
    this.attempt = null
    disposeEngine(this.engine)
    this.engine = null
    this.publish({ state: 'missing' })
  }

  dispose(): void {
    this.disposed = true
    this.engine = null
  }

  private publish(status: SpeechModelStatus, generation = this.generation): void {
    if (this.disposed || generation !== this.generation) return
    this.status = status
    for (const listener of [this.dependencies.onStatus, ...this.listeners]) {
      try {
        listener(status)
      } catch {
        // A window that cannot take the update does not stop the model.
      }
    }
  }

  private async run(generation: number): Promise<void> {
    const stale = (): boolean => generation !== this.generation
    const publish = (status: SpeechModelStatus): void => this.publish(status, generation)
    let received = 0
    try {
      await mkdir(this.modelDirectory, { recursive: true }).catch(() => { throw new SpeechModelError('disk') })
      if (!(await this.verifiedOnDisk())) {
        received = await this.bytesAlreadyHere()
        publish({ state: 'downloading', receivedBytes: received, totalBytes: this.totalBytes })
        let lastPush = 0
        const progress = (bytes: number): void => {
          received = bytes
          const now = this.now()
          if (now - lastPush < PROGRESS_INTERVAL_MS) return
          lastPush = now
          publish({ state: 'downloading', receivedBytes: Math.min(bytes, this.totalBytes), totalBytes: this.totalBytes })
        }
        await this.download(progress, stale)
        await writeFile(join(this.modelDirectory, VERIFIED_MARKER), JSON.stringify(this.model.files)).catch(() => { throw new SpeechModelError('disk') })
        received = this.totalBytes
      }
      publish({ state: 'loading' })
      let engine: SpeechEngine
      try {
        engine = await this.dependencies.loadEngine(this.modelDirectory)
      } catch {
        // The marker trusts sizes, and a file can go bad without changing size. Dropping it makes
        // Try again hash every file and download any that no longer match.
        await rm(join(this.modelDirectory, VERIFIED_MARKER), { force: true }).catch(() => undefined)
        throw new SpeechModelError('engine')
      }
      if (stale() || this.disposed) {
        disposeEngine(engine)
        return
      }
      this.engine = engine
      publish({ state: 'ready' })
    } catch (error) {
      const reason = error instanceof SpeechModelError ? error.reason : 'network'
      publish({ state: 'failed', reason, receivedBytes: Math.min(received, this.totalBytes), totalBytes: this.totalBytes })
    }
  }

  /** True when the marker matches the pins and every file still has its pinned size. */
  private async verifiedOnDisk(): Promise<boolean> {
    const marker = await readFile(join(this.modelDirectory, VERIFIED_MARKER), 'utf8').catch(() => null)
    if (marker !== JSON.stringify(this.model.files)) return false
    for (const file of this.model.files) {
      const info = await stat(join(this.modelDirectory, file.name)).catch(() => null)
      if (info?.size !== file.bytes) return false
    }
    return true
  }

  /** Complete files plus any partial download, so progress starts where it stands. */
  private async bytesAlreadyHere(): Promise<number> {
    let total = 0
    for (const file of this.model.files) {
      const complete = await stat(join(this.modelDirectory, file.name)).catch(() => null)
      if (complete?.size === file.bytes) { total += file.bytes; continue }
      const partial = await stat(this.partPath(file)).catch(() => null)
      if (partial !== null && partial.size <= file.bytes) total += partial.size
    }
    return total
  }

  private partPath(file: SpeechModelFile): string {
    return join(this.modelDirectory, `${file.name}.part`)
  }

  private async download(progress: (bytes: number) => void, stale: () => boolean): Promise<void> {
    let done = 0
    for (const file of this.model.files) {
      if (stale()) throw new SpeechModelError('network')
      const target = join(this.modelDirectory, file.name)
      const complete = await stat(target).catch(() => null)
      if (complete?.size === file.bytes && (await sha256(target)) === file.sha256) {
        done += file.bytes
        progress(done)
        continue
      }
      await rm(target, { force: true }).catch(() => undefined)
      await this.downloadFile(file, (bytes) => progress(done + bytes), stale)
      if ((await sha256(this.partPath(file)).catch(() => { throw new SpeechModelError('disk') })) !== file.sha256) {
        await rm(this.partPath(file), { force: true }).catch(() => undefined)
        throw new SpeechModelError('checksum')
      }
      await rename(this.partPath(file), target).catch(() => { throw new SpeechModelError('disk') })
      done += file.bytes
      progress(done)
    }
  }

  /** Fetches one file into its `.part`, continuing from what is already there when the host allows it. */
  private async downloadFile(file: SpeechModelFile, progress: (bytes: number) => void, stale: () => boolean): Promise<void> {
    const part = this.partPath(file)
    let have = (await stat(part).catch(() => null))?.size ?? 0
    if (have > file.bytes) {
      await rm(part, { force: true }).catch(() => undefined)
      have = 0
    }
    if (have === file.bytes) { progress(have); return }

    const controller = new AbortController()
    let stall: ReturnType<typeof setTimeout> | null = null
    const armStall = (): void => {
      if (stall !== null) clearTimeout(stall)
      stall = setTimeout(() => controller.abort(), STALL_MS)
      stall.unref?.()
    }
    try {
      armStall()
      const response = await this.fetchFollowingGitHub(this.fileUrl(file), have, controller.signal)
      let start = 0
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
        if (range === null || Number(range[1]) !== have || Number(range[3]) !== file.bytes) throw new SpeechModelError('network')
        start = have
      } else if (response.status === 200) {
        const length = Number(response.headers.get('content-length') ?? file.bytes)
        if (length !== file.bytes) throw new SpeechModelError('network')
      } else {
        throw new SpeechModelError('network')
      }
      if (response.body === null) throw new SpeechModelError('network')

      let received = start
      progress(received)
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          armStall()
          if (received > file.bytes || stale()) { callback(new SpeechModelError('network')); return }
          progress(received)
          callback(null, chunk)
        },
      })
      const sink = createWriteStream(part, { flags: start === 0 ? 'w' : 'a' })
      sink.on('error', () => controller.abort())
      try {
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), counter, sink)
      } catch (error) {
        if (error instanceof SpeechModelError) throw error
        const code = (error as NodeJS.ErrnoException | null)?.code
        throw new SpeechModelError(code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'disk' : 'network')
      }
      if (received !== file.bytes) throw new SpeechModelError('network')
    } finally {
      if (stall !== null) clearTimeout(stall)
    }
  }

  /** Follows GitHub's redirect to its asset host by hand, so no other host is ever contacted. */
  private async fetchFollowingGitHub(url: string, offset: number, signal: AbortSignal): Promise<Response> {
    let current = new URL(url)
    for (let redirects = 0; ; redirects += 1) {
      if (current.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(current.hostname) || current.username || current.password || current.port) {
        throw new SpeechModelError('network')
      }
      const response = await this.fetchFn(current, {
        redirect: 'manual',
        signal,
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
      }).catch(() => { throw new SpeechModelError('network') })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => undefined)
      if (location === null || redirects >= MAX_REDIRECTS) throw new SpeechModelError('network')
      current = new URL(location, current)
    }
  }
}

/** Stops an engine that has its own process; sherpa's runs in this one and has nothing to stop. */
export function disposeEngine(engine: SpeechEngine | null): void {
  try {
    engine?.dispose?.()
  } catch {
    // An engine that is already gone has nothing left to stop.
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
