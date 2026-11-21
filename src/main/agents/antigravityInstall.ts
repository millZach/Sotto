import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { antigravityFolders } from './antigravityFolders'
import {
  ANTIGRAVITY_CLI_FLOOR, antigravityTarget, isMuslLinux, meetsAntigravityFloor, readAntigravityRelease,
  type AntigravityPlatform, type AntigravityRelease, type ManifestFetch,
} from './antigravityRelease'

/**
 * The copy of Google's `agy` Sotto downloads and verifies itself, as T3 Code does
 * (`t3:apps/server/src/provider/AntigravityInstallation.ts`). Each version lives in its own folder,
 * `<runtime>/<platform>-<arch>/versions/<version>/`, beside a record of what was verified, and `active.json` names the
 * one new sessions start. A download is checked against the SHA-512 Google's manifest publishes before anything is
 * unpacked, and a release becomes active only once it is whole. A version a running `agy` holds a lease on is never
 * removed, so a thread keeps the version it started with while new threads start the new one.
 */

const DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024
const FREE_SPACE_MARGIN = 256 * 1024 * 1024
/** About 1.25 GiB, the space T3 asks for: the download, the program unpacked from it and room to spare. */
export const ANTIGRAVITY_INSTALL_SPACE = MAX_DOWNLOAD_BYTES + MAX_EXECUTABLE_BYTES + FREE_SPACE_MARGIN
const RECORD = '.install-complete.json'
const ACTIVE = 'active.json'
const RECORD_MAX_BYTES = 8 * 1024
const PROGRESS_EVERY_MS = 250

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u)
const activeSchema = z.object({ version: versionSchema })
const recordSchema = z.object({
  version: versionSchema, sha512: z.string().regex(/^[a-f0-9]{128}$/u),
  executable: z.enum(['agy.exe', 'antigravity']), size: z.number().int().positive(),
})
type InstalledRecord = z.infer<typeof recordSchema>

export type AntigravityInstallPhase = 'checking' | 'downloading' | 'verifying' | 'extracting' | 'activating'
export interface AntigravityInstallProgress {
  readonly phase: AntigravityInstallPhase
  readonly version?: string
  readonly downloadedBytes?: number
}

/** Progress in plain words, for the client's tile. */
export function describeAntigravityProgress(progress: AntigravityInstallProgress): string {
  const version = progress.version ? `Antigravity ${progress.version}` : 'Antigravity'
  switch (progress.phase) {
    case 'checking': return 'Asking Google for the newest Antigravity.'
    case 'downloading': return `Downloading ${version}${progress.downloadedBytes ? `: ${Math.round(progress.downloadedBytes / 1024 / 1024)} MB so far` : ''}.`
    case 'verifying': return `Checking ${version} against Google's checksum.`
    case 'extracting': return `Unpacking ${version}.`
    case 'activating': return `Starting to use ${version} for new threads.`
  }
}

export type AntigravityInstallFailure = 'download' | 'installer' | 'cancelled'
export type AntigravityInstallResult =
  | { readonly ok: true; readonly version: string; readonly executable: string; readonly downloaded: boolean }
  | { readonly ok: false; readonly failure: AntigravityInstallFailure; readonly detail: string }

export interface AntigravityRemoveResult {
  /** Versions removed. */
  readonly removed: readonly string[]
  /** Versions a running thread still uses, removed once it lets go. */
  readonly kept: readonly string[]
}

const NOTHING_CHANGED = 'Nothing was changed.'
const CANCELLED = 'The Antigravity install was cancelled. Nothing was changed.'
class InstallError extends Error {
  constructor(readonly failure: AntigravityInstallFailure, message: string) { super(message) }
}

/** The folder of one platform's copies: `<runtime>/<platform>-<arch>`. */
export function antigravityRuntimeFolder(directory: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return join(antigravityFolders(directory).runtime, `${platform}-${arch}`)
}

const readSmallJson = async <T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> => {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > RECORD_MAX_BYTES) return undefined
    const parsed = schema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}

/** A version folder's program, when its record says it was verified and the program is still the size it was. */
async function verifiedExecutable(folder: string, version: string, platform: NodeJS.Platform): Promise<{ path: string; record: InstalledRecord } | undefined> {
  const record = await readSmallJson(join(folder, RECORD), recordSchema)
  if (!record || record.version !== version || record.executable !== (platform === 'win32' ? 'agy.exe' : 'antigravity')) return undefined
  const path = join(folder, record.executable)
  const info = await stat(path).catch(() => undefined)
  return info?.isFile() && info.size === record.size ? { path, record } : undefined
}

/**
 * The active verified `agy` Sotto downloaded, or undefined when there is none. Read for every lookup, so an install or
 * a removal is seen by the next session that starts.
 */
export async function managedAntigravityExecutable(directory: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): Promise<string | undefined> {
  const root = antigravityRuntimeFolder(directory, platform, arch)
  const active = await readSmallJson(join(root, ACTIVE), activeSchema)
  if (!active) return undefined
  return (await verifiedExecutable(join(root, 'versions', active.version), active.version, platform))?.path
}

// Leases are per process: only an `agy` this process started can be using a version Sotto downloaded.
const leases = new Map<string, number>()
/** Platform folders with an install or removal running, whose versions a released lease leaves alone. */
const busyRoots = new Set<string>()
const isLeased = (folder: string): boolean => (leases.get(resolve(folder)) ?? 0) > 0

/**
 * Holds the version an `agy` runs from until the returned release is called, so no install or removal deletes it
 * underneath the process. Call it when the process starts and release it once the process has exited. Releasing the
 * last lease on a version that is no longer active removes it.
 */
export function leaseAntigravityRuntime(executable: string): () => void {
  const folder = resolve(dirname(executable))
  leases.set(folder, (leases.get(folder) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (leases.get(folder) ?? 1) - 1
    if (remaining > 0) { leases.set(folder, remaining); return }
    leases.delete(folder)
    void removeIfInactive(folder)
  }
}

/**
 * Removes a released version once nothing uses it and it is not active. Only a folder laid out the way Sotto lays out
 * its downloads, with its record verified, is ever removed, so a lease on an `agy` the user installed never deletes it.
 */
async function removeIfInactive(folder: string): Promise<void> {
  const versions = dirname(folder), root = dirname(versions), runtime = dirname(root)
  const ours = basename(versions) === 'versions' && basename(runtime) === 'runtime' && basename(dirname(runtime)) === 'antigravity'
  if (!ours || !versionSchema.safeParse(basename(folder)).success || busyRoots.has(root) || isLeased(folder)) return
  if (!await verifiedExecutable(folder, basename(folder), basename(root).split('-')[0] as NodeJS.Platform)) return
  const active = await readSmallJson(join(root, ACTIVE), activeSchema)
  if (active?.version === basename(folder)) return
  await removeFolder(folder).catch(() => undefined)
}

/** Windows holds a handle on a program for a moment after it exits or an antivirus reads it, so a rename or removal is tried again for up to ten seconds. */
async function retrying<T>(action: () => Promise<T>, platform: NodeJS.Platform): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await action() } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (platform !== 'win32' || attempt >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw error
      await delay(250)
    }
  }
}
const removeFolder = (folder: string): Promise<void> => retrying(() => rm(folder, { recursive: true, force: true }), process.platform)

/** The tar this computer already has: Windows' own in System32, `tar` on the PATH elsewhere, as T3 runs it. */
export function systemTar(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env): string {
  if (platform !== 'win32') return 'tar'
  return `${environment.SystemRoot ?? environment.windir ?? 'C:\\Windows'}\\System32\\tar.exe`
}

export interface AntigravityRuntimeOptions {
  /** User data on the desktop, the data directory on a headless host. */
  readonly directory: string
  readonly fetchImpl?: ManifestFetch
  /** The platform whose build is installed: this computer's, by default. */
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly musl?: () => Promise<boolean>
  /** The tar that unpacks macOS and Linux downloads. */
  readonly tar?: string
  /** Free bytes in a folder, or undefined when the system cannot say. */
  readonly freeBytes?: (folder: string) => Promise<number | undefined>
}

/** One computer's managed `agy`: its install, update, reinstall, cancel and removal. One install runs at a time. */
export class AntigravityRuntime {
  private readonly directory: string
  private readonly fetchImpl: ManifestFetch
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly musl: () => Promise<boolean>
  private readonly tar: string
  private readonly freeBytes: (folder: string) => Promise<number | undefined>
  private running: AbortController | undefined
  private removing = false

  constructor(options: AntigravityRuntimeOptions) {
    this.directory = options.directory
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.musl = options.musl ?? (() => isMuslLinux(this.platform, this.arch))
    this.tar = options.tar ?? systemTar()
    this.freeBytes = options.freeBytes ?? (async folder => {
      const info = await statfs(folder).catch(() => undefined)
      return info ? info.bavail * info.bsize : undefined
    })
  }

  /** This platform's folder of downloaded versions. */
  get root(): string { return antigravityRuntimeFolder(this.directory, this.platform, this.arch) }
  private get versions(): string { return join(this.root, 'versions') }
  /** Whether Google publishes `agy` for this computer at all. */
  get supported(): boolean { return antigravityTarget({ platform: this.platform, arch: this.arch }) !== undefined }
  get installing(): boolean { return this.running !== undefined }

  private async target(): Promise<AntigravityPlatform> {
    return { platform: this.platform, arch: this.arch, musl: await this.musl() }
  }

  /** Google's newest release for this computer, or undefined when the manifest cannot be read. */
  async latest(signal?: AbortSignal): Promise<AntigravityRelease | undefined> {
    return readAntigravityRelease(this.fetchImpl, await this.target(), signal)
  }

  /** The active verified program, or undefined. */
  executable(): Promise<string | undefined> { return managedAntigravityExecutable(this.directory, this.platform, this.arch) }

  /** Stops the install that is running. The version in use before it stays in use. False when nothing was running. */
  cancel(): boolean {
    if (!this.running) return false
    this.running.abort()
    return true
  }

  /**
   * Installs Google's newest release, or makes it active when it is already here and whole. `reinstall` downloads it
   * again even then, unless a running thread holds it. Install, Update, Reinstall and Retry are all this one call.
   */
  async install(options: { readonly reinstall?: boolean; readonly onProgress?: (progress: AntigravityInstallProgress) => void } = {}): Promise<AntigravityInstallResult> {
    if (this.running) return { ok: false, failure: 'installer', detail: 'Antigravity is already installing. Wait for it to finish, or cancel it.' }
    if (this.removing) return { ok: false, failure: 'installer', detail: `Sotto is removing its Antigravity. ${NOTHING_CHANGED} Try again when it finishes.` }
    const controller = new AbortController()
    this.running = controller
    busyRoots.add(this.root)
    try {
      return await this.installWith(controller.signal, options.reinstall === true, options.onProgress ?? (() => undefined))
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, failure: 'cancelled', detail: CANCELLED }
      if (error instanceof InstallError) return { ok: false, failure: error.failure, detail: error.message }
      return { ok: false, failure: 'installer', detail: `Sotto could not install Antigravity. ${NOTHING_CHANGED} Try again.` }
    } finally {
      this.running = undefined
      busyRoots.delete(this.root)
    }
  }

  private async installWith(signal: AbortSignal, reinstall: boolean, report: (progress: AntigravityInstallProgress) => void): Promise<AntigravityInstallResult> {
    if (!this.supported) throw new InstallError('installer', `Google does not publish Antigravity for ${this.platform} on ${this.arch}. Install it yourself and Sotto will find it.`)
    report({ phase: 'checking' })
    const release = await this.latest(signal)
    signal.throwIfAborted()
    if (!release) throw new InstallError('download', `Sotto could not read Google's list of Antigravity releases, or it named a download Sotto does not trust. ${NOTHING_CHANGED} Check the network connection, then try again.`)
    if (!meetsAntigravityFloor(release.version)) throw new InstallError('installer', `Google's newest Antigravity is ${release.version}, older than the ${ANTIGRAVITY_CLI_FLOOR} Sotto needs, so Sotto did not install it.`)
    await mkdir(this.versions, { recursive: true })
    await this.clearStaging()
    const destination = join(this.versions, release.version)
    const existing = await verifiedExecutable(destination, release.version, this.platform)
    const whole = existing !== undefined && existing.record.sha512 === release.sha512
    if (whole && (!reinstall || isLeased(destination))) {
      report({ phase: 'activating', version: release.version })
      await this.activate(release.version)
      return { ok: true, version: release.version, executable: existing.path, downloaded: false }
    }
    if (isLeased(destination)) throw new InstallError('installer', `A thread is still running Antigravity ${release.version}, so Sotto cannot replace it. ${NOTHING_CHANGED} Try again once that thread finishes.`)
    const free = await this.freeBytes(this.versions)
    if (free !== undefined && free < ANTIGRAVITY_INSTALL_SPACE) {
      throw new InstallError('installer', `Antigravity needs at least ${Math.ceil(ANTIGRAVITY_INSTALL_SPACE / 1024 / 1024)} MB of free space to install. ${NOTHING_CHANGED} Free some space, then try again.`)
    }
    const staging = await mkdtemp(join(this.versions, '.install-'))
    try {
      const download = join(staging, 'download')
      report({ phase: 'downloading', version: release.version, downloadedBytes: 0 })
      const digest = await this.download(release, download, signal, downloadedBytes => report({ phase: 'downloading', version: release.version, downloadedBytes }))
      report({ phase: 'verifying', version: release.version })
      if (digest !== release.sha512) throw new InstallError('download', `The Antigravity download did not match the checksum Google published, so Sotto did not install it. ${NOTHING_CHANGED} Try again.`)
      signal.throwIfAborted()
      report({ phase: 'extracting', version: release.version })
      const unpacked = join(staging, 'runtime')
      await mkdir(unpacked)
      const program = join(unpacked, release.executable)
      if (release.format === 'executable') await retrying(() => rename(download, program), this.platform)
      else { await this.extract(download, release.executable, program, signal); await rm(download, { force: true }) }
      if (this.platform !== 'win32') await chmod(program, 0o755)
      const size = (await stat(program)).size
      await writeFile(join(unpacked, RECORD), JSON.stringify({ version: release.version, sha512: release.sha512, executable: release.executable, size }), { encoding: 'utf8', mode: 0o600 })
      signal.throwIfAborted()
      // From here the install finishes even if cancelled: the release is whole, and stopping halfway would leave less than either version.
      report({ phase: 'activating', version: release.version })
      await removeFolder(destination)
      await retrying(() => rename(unpacked, destination), this.platform)
      await this.activate(release.version)
      return { ok: true, version: release.version, executable: join(destination, release.executable), downloaded: true }
    } finally {
      await removeFolder(staging).catch(() => undefined)
    }
  }

  /** Streams the download to disk while hashing it, and answers the SHA-512 it read. */
  private async download(release: AntigravityRelease, path: string, signal: AbortSignal, onBytes: (bytes: number) => void): Promise<string> {
    const failed = `Sotto could not download Antigravity from Google. ${NOTHING_CHANGED} Check the network connection and any proxy settings, then try again.`
    let response: Response
    try {
      response = await this.fetchImpl(release.url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) })
    } catch { signal.throwIfAborted(); throw new InstallError('download', failed) }
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); throw new InstallError('download', failed) }
    const hash = createHash('sha512')
    const file = await open(path, 'wx', 0o600)
    let bytes = 0, reported = 0
    const reader = response.body.getReader()
    // A body that stalls still stops at once on Cancel.
    const stop = (): void => { void reader.cancel().catch(() => undefined) }
    signal.addEventListener('abort', stop, { once: true })
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try { chunk = await reader.read() } catch { signal.throwIfAborted(); throw new InstallError('download', failed) }
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > MAX_DOWNLOAD_BYTES) { await reader.cancel().catch(() => undefined); throw new InstallError('download', `The Antigravity download was larger than Sotto allows, so it stopped. ${NOTHING_CHANGED}`) }
        hash.update(chunk.value)
        await file.write(chunk.value)
        if (Date.now() - reported >= PROGRESS_EVERY_MS) { reported = Date.now(); onBytes(bytes) }
        signal.throwIfAborted()
      }
    } finally { signal.removeEventListener('abort', stop); await file.close() }
    signal.throwIfAborted()
    onBytes(bytes)
    return hash.digest('hex')
  }

  /**
   * Unpacks the one program from the archive with this computer's own tar, as T3 does: the archive must list exactly
   * that one regular file, and it is read out through tar's output into a file Sotto names, so nothing in the archive
   * chooses where anything is written.
   */
  private async extract(archive: string, name: string, program: string, signal: AbortSignal): Promise<void> {
    const refused = `The Antigravity download did not hold the one program Sotto expects, so it was not installed. ${NOTHING_CHANGED}`
    const list = await this.runTar(['-tzf', archive], signal)
    const types = await this.runTar(['-tvzf', archive], signal)
    if (list.trim() !== name || types.trim().split(/\r?\n/u).length !== 1 || !types.startsWith('-')) throw new InstallError('installer', refused)
    const file = await open(program, 'wx', 0o600)
    try {
      let written = 0
      await new Promise<void>((done, fail) => {
        const child = spawn(this.tar, ['-xOzf', archive, name], { stdio: ['ignore', 'pipe', 'ignore'], signal, windowsHide: true })
        let writing = Promise.resolve()
        child.stdout.on('data', (chunk: Buffer) => {
          written += chunk.byteLength
          if (written > MAX_EXECUTABLE_BYTES) { child.kill(); return }
          child.stdout.pause()
          writing = writing.then(() => file.write(chunk)).then(() => { child.stdout.resume() })
        })
        child.on('error', fail)
        child.on('close', code => { void writing.then(() => code === 0 && written > 0 && written <= MAX_EXECUTABLE_BYTES ? done() : fail(new InstallError('installer', refused)), fail) })
      })
    } catch (error) {
      signal.throwIfAborted()
      throw error instanceof InstallError ? error : new InstallError('installer', `Sotto could not unpack Antigravity with this computer's tar. ${NOTHING_CHANGED}`)
    } finally { await file.close() }
  }

  private runTar(args: readonly string[], signal: AbortSignal): Promise<string> {
    return new Promise((done, fail) => {
      const child = spawn(this.tar, args, { stdio: ['ignore', 'pipe', 'ignore'], signal, windowsHide: true })
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { if (out.length < 64 * 1024) out += chunk })
      child.on('error', () => { fail(signal.aborted ? signal.reason : new InstallError('installer', `Sotto could not unpack Antigravity with this computer's tar. ${NOTHING_CHANGED}`)) })
      child.on('close', code => { if (code === 0) done(out); else fail(new InstallError('installer', `Sotto could not unpack Antigravity with this computer's tar. ${NOTHING_CHANGED}`)) })
    })
  }

  /** Names the version new sessions start, by a rename so `active.json` is never half written, then removes the versions nothing uses. */
  private async activate(version: string): Promise<void> {
    const pointer = join(this.root, `${ACTIVE}.${process.pid}.tmp`)
    await writeFile(pointer, JSON.stringify({ version }), { encoding: 'utf8', mode: 0o600 })
    await retrying(() => rename(pointer, join(this.root, ACTIVE)), this.platform)
    await this.prune(version)
  }

  private async prune(keep: string | undefined): Promise<{ removed: string[]; kept: string[] }> {
    const removed: string[] = [], kept: string[] = []
    const entries = await readdir(this.versions).catch(() => [] as string[])
    for (const entry of entries) {
      if (entry === keep || !versionSchema.safeParse(entry).success) continue
      const folder = join(this.versions, entry)
      if (isLeased(folder)) { kept.push(entry); continue }
      try { await removeFolder(folder); removed.push(entry) } catch { kept.push(entry) }
    }
    return { removed, kept }
  }

  /** Staging folders an install that stopped (Sotto quit, the power went) left behind. */
  private async clearStaging(): Promise<void> {
    for (const entry of await readdir(this.versions).catch(() => [] as string[])) {
      if (entry.startsWith('.install-')) await removeFolder(join(this.versions, entry)).catch(() => undefined)
    }
  }

  /**
   * Remove downloaded runtime: no version is active afterwards, so new sessions use an `agy` the user installed, if any.
   * A version a running thread holds stays until that thread lets go.
   */
  async remove(): Promise<AntigravityRemoveResult> {
    if (this.running) throw new Error('Antigravity is installing. Cancel the install first, then remove it.')
    this.removing = true
    busyRoots.add(this.root)
    try {
      await rm(join(this.root, ACTIVE), { force: true })
      await this.clearStaging()
      return await this.prune(undefined)
    } finally {
      this.removing = false
      busyRoots.delete(this.root)
    }
  }
}

/** What a removal did, in plain words. */
export function describeAntigravityRemoval(result: AntigravityRemoveResult): string {
  if (!result.removed.length && !result.kept.length) return 'Sotto had no downloaded Antigravity to remove.'
  const kept = result.kept.length ? ` Antigravity ${result.kept.join(', ')} stays until the threads using it finish.` : ''
  return `Removed the Antigravity Sotto downloaded.${kept}`
}
