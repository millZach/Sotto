import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { access, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { HOST_NODE_RANGE, LAUNCH_SCRIPT_SOURCE } from '../main/hosts/launchScript'
import { hostLaunchTimings } from '../shared/hostLaunchTimings'
import { HOST_RELEASES_URL, HOST_UPDATE_STEPS, HOST_VERSION_PATTERN, hostArchiveName, type HostUpdateStep } from '../shared/hostUpdates'
import { compareHostToTarget, HOST_UPDATE_ANSWER_WAIT_MS, HOST_UPDATE_FETCH_BUDGET_MS, HOST_UPDATE_INSTALL_BUDGET_MS, hostUpdateAttemptFile, HOST_UPDATE_RESTART_BUDGET_MS, HOST_UPDATE_RESTART_WAIT_MS, HOST_UPDATE_STATUS_FILE, HOST_UPDATE_STATUS_LIMIT_BYTES, hostUpdateErrorSchema, hostUpdateFetchedSchema, hostUpdateInstalledSchema, hostUpdateStatusSchema,
  type HostUpdateAnswer, type HostUpdateRequest, type HostUpdateStatus } from '../shared/hostSelfUpdate'
export type { HostUpdateRequest } from '../shared/hostSelfUpdate'
import { startedBySotto, type HostStartedBy } from '../shared/hostConnection'
import type { HostUpdateRequestAction } from '../shared/hostProtocol'
import { processAlive } from './lock'

/**
 * A host that updates itself when a paired desktop asks over its socket (ADR-0088). It runs the launch script it ships for
 * SSH against itself, on this machine, so there is one implementation of the download, the checksum, the unpack, the Node
 * range, the version conflict, the restart, the rollback and the prune. The client names only a version, and for install
 * the archive's name and checksum the host's own download answered. Everything else the script reads, the host builds
 * itself: its installation folder from where its own entry sits, its data folder and port from its own command line, its
 * Node, its host ID, the launch timings the desktop sends, and the fixed releases page. A version that is not newer than
 * the one running is refused at every step, since `versions/` keeps the previous one and a client could otherwise roll the
 * host back.
 *
 * The restart stops this host, so it runs in a process that outlives it: detached in its own session, or for a host its
 * start at boot unit runs (ADR-0054), in a transient systemd unit of its own, since stopping `sotto-host` kills everything
 * left in that unit's cgroup. The restart reports in a status file in the data folder, which the host waits on for up to
 * ten seconds before it answers, and which the new host, or the old one started again, reads for `outcome`.
 */

/** Where a running host was installed, from its own entry. `version` is the version folder it runs from, or null for a flat install. */
export interface HostInstallation { readonly installPath: string; readonly version: string | null }
/**
 * The installation folder of a host whose entry is `<install>/versions/<version>/host/index.js`, the layout updates make,
 * or `<install>/host/index.js`, a flat install. Any other path, and a version folder that is not the version this host
 * says it runs, is refused: the host updates only a folder it can be sure the launch script starts.
 */
export function hostInstallation(entry: string, sottoVersion: string): HostInstallation | null {
  if (!entry || !isAbsolute(entry)) return null
  const file = resolve(entry)
  if (basename(file) !== 'index.js' || basename(dirname(file)) !== 'host') return null
  const folder = dirname(dirname(file)), parent = dirname(folder)
  if (basename(parent) === 'versions') {
    const version = basename(folder)
    return HOST_VERSION_PATTERN.test(version) && version === sottoVersion ? { installPath: dirname(parent), version } : null
  }
  return { installPath: folder, version: null }
}

/**
 * Whether this host runs under its start at boot unit (ADR-0054), from its own cgroup: a restart in that cgroup would be
 * killed with the host it stops. Only Linux has the unit.
 */
export async function runByBootUnit(platform: NodeJS.Platform = process.platform, read: (file: string) => Promise<string> = file => readFile(file, 'utf8')): Promise<boolean> {
  if (platform !== 'linux') return false
  try { return /\/sotto-host\.service(?:\/|$)/mu.test(await read('/proc/self/cgroup')) } catch { return false }
}

/** The variables a transient unit is given from this host's environment: what the launch script and the host it starts read. */
const UNIT_ENVIRONMENT = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'SOTTO_HOST_KEY_FILE'] as const

/**
 * The command that runs a restart in a transient user unit of its own (ADR-0054, October 16 amendment): collected once it
 * ends, with the environment the host it starts needs, and the launch script as a file, since a unit's stdin is not ours.
 */
export function transientRestartCommand(input: { readonly node: string; readonly script: string; readonly configuration: string; readonly env: NodeJS.ProcessEnv; readonly unit: string }): string[] {
  const environment = UNIT_ENVIRONMENT.flatMap(name => {
    const value = input.env[name]
    return typeof value === 'string' && value && !/[\p{Cc}]/u.test(value) ? ['--setenv=' + name + '=' + value] : []
  })
  return ['--user', '--collect', '--quiet', '--unit=' + input.unit, ...environment, '--', input.node, input.script, input.configuration]
}

export interface HostSelfUpdateOptions {
  /** The running host's entry, `process.argv[1]`: where it was installed is read from it. */
  readonly entry: string
  readonly dataDirectory: string
  /** The port the host was started with, which the launch script and the boot unit's script pin. */
  readonly port: number
  readonly hostId: string
  readonly sottoVersion: string
  readonly startedBy?: HostStartedBy | undefined
  /** Tests stand a local releases page in; a host always uses the published one. */
  readonly releasesUrl?: string | undefined
  readonly node?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly arch?: string | undefined
  readonly runByUnit?: (() => Promise<boolean>) | undefined
  /** The clock the restart's wait is measured by. Tests run it on so the wait ends without waiting it out. */
  readonly now?: (() => number) | undefined
  readonly spawn?: typeof spawnProcess | undefined
  readonly log?: ((event: string) => void) | undefined
}
/** Why a host offers no self-update: Sotto did not start it, or it does not run from a release's own layout. */
export type HostSelfUpdateRefusal = 'update-not-owned' | 'update-layout'
export interface HostUpdateContext {
  /** The client that asked. Only it may cancel its own download. */
  readonly owner: object
  /** Aborted once that client's socket has closed, which ends its download and nothing else. */
  readonly gone: AbortSignal
  /** Told each step as the host reaches it. */
  readonly onStep: (step: HostUpdateStep) => void
}

/** A host that may update itself, or why it may not. */
export function createHostSelfUpdate(options: HostSelfUpdateOptions): { readonly ok: true; readonly update: HostSelfUpdate } | { readonly ok: false; readonly reason: HostSelfUpdateRefusal } {
  // Only a host Sotto started is restarted by Sotto (ADR-0025, ADR-0040): the launch script or its start at boot unit.
  if (!startedBySotto(options.startedBy)) return { ok: false, reason: 'update-not-owned' }
  const installation = hostInstallation(options.entry, options.sottoVersion)
  if (!installation) return { ok: false, reason: 'update-layout' }
  return { ok: true, update: new HostSelfUpdate(options, installation) }
}

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const OUTPUT_LIMIT = 65_536
const fetchResult = z.union([hostUpdateFetchedSchema, hostUpdateErrorSchema])
const installResult = z.union([hostUpdateInstalledSchema, hostUpdateErrorSchema])
const invalid = (): HostUpdateAnswer => ({ type: 'error', reason: 'update-invalid' })
/** The status file as read, with how long ago it was last written. */
interface StatusRead { readonly status: HostUpdateStatus; readonly age: number }
/** Whether a `restarting` status belongs to a restart that can no longer finish: its process has gone, or it is too old. */
const interrupted = (read: StatusRead): boolean => read.age > HOST_UPDATE_RESTART_BUDGET_MS
  || (read.status.state === 'restarting' && read.status.pid !== undefined && !processAlive(read.status.pid))
const busy = (): HostUpdateAnswer => ({ type: 'error', reason: 'update-busy' })

export class HostSelfUpdate {
  /** The one update action running here, whichever listener asked: two never run at once. */
  private running: HostUpdateRequestAction | null = null
  private download: { readonly owner: object; readonly abort: AbortController } | null = null
  /** A restart that went ahead waits for this host to have answered its desktop: the file that says so, once it has. */
  private answering: string | null = null
  /** How long a finished attempt's claim and answer files are kept: far longer than any restart runs. */
  private static readonly ATTEMPT_FILES_KEPT_MS = 10 * 60_000
  private readonly statusPath: string
  private readonly node: string
  private readonly env: NodeJS.ProcessEnv
  private readonly spawn: typeof spawnProcess

  constructor(private readonly options: HostSelfUpdateOptions, readonly installation: HostInstallation) {
    this.statusPath = join(resolve(options.dataDirectory), HOST_UPDATE_STATUS_FILE)
    this.node = options.node ?? process.execPath
    this.env = options.env ?? process.env
    this.spawn = options.spawn ?? spawnProcess
  }

  /** One step of an update, as `host-update` asks for it. Every answer is one the desktop reads (`hostUpdateAnswerSchema`). */
  async run(request: HostUpdateRequest, context: HostUpdateContext): Promise<HostUpdateAnswer> {
    switch (request.action) {
      case 'fetch': return this.fetch(request, context)
      case 'install': return this.install(request, context)
      case 'restart': return this.restart(request, context)
      case 'cancel': {
        const download = this.download
        if (!download || download.owner !== context.owner) return { type: 'update-cancelled', cancelled: false }
        download.abort.abort()
        return { type: 'update-cancelled', cancelled: true }
      }
      case 'outcome': {
        const read = await this.readStatus()
        if (!read) return { type: 'update-outcome', running: this.options.sottoVersion, restart: { state: 'none' } }
        const { status } = read
        // A restart whose process has gone, or that has run far past any restart's time, was interrupted before it could
        // say how it ended: Sotto cannot tell which version is running beyond what this host says it runs.
        if (status.state === 'restarting' && interrupted(read)) {
          return { type: 'update-outcome', running: this.options.sottoVersion, restart: { state: 'finished', version: status.version, attempt: status.attempt, result: { type: 'error', reason: 'update-lost' } } }
        }
        return { type: 'update-outcome', running: this.options.sottoVersion,
          restart: status.state === 'restarting' ? { state: 'restarting', version: status.version, attempt: status.attempt } : { state: 'finished', version: status.version, attempt: status.attempt, result: status.result } }
      }
    }
  }

  /** A version this host may move to: a release number newer than its own, by the rule the desktop uses. */
  private newer(version: string | undefined): string | null {
    if (!version || !HOST_VERSION_PATTERN.test(version)) return null
    return compareHostToTarget(this.options.sottoVersion, version) === -1 ? version : null
  }
  private configuration(operation: Record<string, unknown>): string {
    return JSON.stringify({ ...operation, installPath: this.installation.installPath, dataDirectory: resolve(this.options.dataDirectory),
      remotePort: this.options.port, hostId: this.options.hostId, nodeRange: HOST_NODE_RANGE,
      releasesUrl: this.options.releasesUrl ?? HOST_RELEASES_URL, ...hostLaunchTimings() })
  }
  private take(action: HostUpdateRequestAction): boolean {
    if (this.running) return false
    this.running = action
    return true
  }

  private async fetch(request: HostUpdateRequest, context: HostUpdateContext): Promise<HostUpdateAnswer> {
    const version = this.newer(request.version)
    if (!version) return invalid()
    if (!this.take('fetch')) return busy()
    const abort = new AbortController()
    this.download = { owner: context.owner, abort }
    const stop = (): void => abort.abort()
    context.gone.addEventListener('abort', stop, { once: true })
    try {
      // The launch script's download holds the folder's update lock, as it does over SSH, so the two refuse each other.
      if (context.gone.aborted) return { type: 'update-cancelled', cancelled: true }
      context.onStep('download')
      const result = await this.script(this.configuration({ op: 'update-fetch', version }), context.onStep, HOST_UPDATE_FETCH_BUDGET_MS, abort.signal)
      if (abort.signal.aborted) return { type: 'update-cancelled', cancelled: true }
      return fetchResult.safeParse(result).data ?? { type: 'error', reason: 'update-failed' }
    } finally {
      context.gone.removeEventListener('abort', stop)
      this.download = null
      this.running = null
    }
  }

  private async install(request: HostUpdateRequest, context: HostUpdateContext): Promise<HostUpdateAnswer> {
    const version = this.newer(request.version)
    // The archive is the one this host's own download names, for its own system: a client chooses no file.
    if (!version || request.file !== hostArchiveName(version, this.options.platform ?? process.platform, this.options.arch ?? process.arch)
      || typeof request.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(request.sha256)) return invalid()
    if (!this.take('install')) return busy()
    // Unpacking carries on when the client's socket closes, as it does over SSH: it is never stopped partway.
    try {
      const result = await this.script(this.configuration({ op: 'update-install', version, file: request.file, sha256: request.sha256 }), context.onStep, HOST_UPDATE_INSTALL_BUDGET_MS)
      return installResult.safeParse(result).data ?? { type: 'error', reason: 'update-failed' }
    } finally { this.running = null }
  }

  private async restart(request: HostUpdateRequest, context: HostUpdateContext): Promise<HostUpdateAnswer> {
    const version = this.newer(request.version)
    if (!version) return invalid()
    try { await access(join(this.installation.installPath, 'versions', version, 'host', 'index.js')) } catch { return { type: 'error', reason: 'update-missing' } }
    if (!this.take('restart')) return busy()
    try {
      // A restart this host already answered for may still be stopping it: its status says restarting and its process is
      // alive. Another is refused before anything is touched, so the first one's status stays for outcome to read.
      const previous = await this.readStatus()
      if (previous?.status.state === 'restarting' && !interrupted(previous)) return busy()
      context.onStep('restart')
      // One status file for each update: what the last one said is gone before this one starts. Each attempt has a claim of
      // its own, so an earlier restart this host gave up on can never take this one's.
      await rm(this.statusPath, { force: true })
      await this.forgetOldAttempts()
      const attempt = randomBytes(8).toString('hex')
      const configuration = this.configuration({ op: 'update-restart', version, resultFile: this.statusPath, attempt, answerWaitMs: HOST_UPDATE_ANSWER_WAIT_MS })
      const unit = await (this.options.runByUnit ?? (() => runByBootUnit(this.options.platform)))()
      const ended = unit ? (await this.restartInUnit(configuration)).ended : this.restartDetached(configuration)
      const answer = await this.awaitRestart(version, attempt, ended)
      if (answer.type === 'update-restarting') this.answering = hostUpdateAttemptFile(this.statusPath, attempt, 'answered')
      return answer
    } finally { this.running = null }
  }

  /** Takes away the claim and answer files of attempts long finished. */
  private async forgetOldAttempts(): Promise<void> {
    const directory = resolve(this.options.dataDirectory), prefix = HOST_UPDATE_STATUS_FILE + '.'
    let names: string[]
    try { names = await readdir(directory) } catch { return }
    for (const name of names) {
      if (!name.startsWith(prefix) || !/\.[a-f0-9]{8,64}\.(?:claim|answered)$/u.test(name)) continue
      const file = join(directory, name)
      const age = await stat(file).then(info => Date.now() - info.mtimeMs, () => 0)
      if (age > HostSelfUpdate.ATTEMPT_FILES_KEPT_MS) await rm(file, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Told once the answer to the restart that went ahead has been handed to its client's socket, and only for that answer.
   * This says so to the restart, which waits for it before it stops this host, so the answer is not cut off.
   */
  async delivered(): Promise<void> {
    const file = this.answering
    this.answering = null
    if (file) await writeFile(file, '', { mode: 0o600 }).catch(() => undefined)
  }

  /** The restart in its own session, which outlives this host: setsid on Linux and macOS, its own process group on Windows. */
  private restartDetached(configuration: string): Promise<void> {
    const child = this.spawn(this.node, ['--input-type=commonjs', '-', configuration], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: this.env })
    const ended = new Promise<void>(done => { child.once('exit', () => done()); child.once('error', () => done()) })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(LAUNCH_SCRIPT_SOURCE)
    child.unref()
    this.options.log?.('host-update-restart-started')
    return ended
  }

  /**
   * The restart in a transient user unit of its own, for a host its start at boot unit runs: `systemctl stop sotto-host`
   * kills everything in that unit's cgroup, a detached process included (`KillMode=mixed`). The script goes in the data
   * folder, which is this account's own; it holds nothing secret.
   */
  private async restartInUnit(configuration: string): Promise<{ readonly ended: Promise<void> }> {
    const script = join(resolve(this.options.dataDirectory), 'host-update-restart.cjs')
    await writeFile(script, LAUNCH_SCRIPT_SOURCE, { mode: 0o600 })
    const env = { ...this.env }
    if (!env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') env.XDG_RUNTIME_DIR = '/run/user/' + process.getuid()
    const args = transientRestartCommand({ node: this.node, script, configuration, env, unit: 'sotto-host-update-' + randomUUID().slice(0, 8) })
    const child: ChildProcess = this.spawn('systemd-run', args, { stdio: 'ignore', windowsHide: true, env })
    const code = await new Promise<number | null>(done => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(null) }, 15_000)
      child.once('exit', value => { clearTimeout(timer); done(value) })
      child.once('error', () => { clearTimeout(timer); done(null) })
    })
    this.options.log?.(code === 0 ? 'host-update-restart-started' : 'host-update-restart-unit-refused')
    // A unit the user manager would not start never claims the status file: the wait ends at once.
    return { ended: code === 0 ? new Promise<void>(() => undefined) : Promise.resolve() }
  }

  /**
   * Waits for the restart to claim the status file, once its checks pass, or to write why it stopped. When it has done
   * neither in time, or ended without either, the host claims the file itself, and the restart, if it ever gets that far,
   * then stops without touching anything: `restart-not-sent` stays true.
   */
  private async awaitRestart(version: string, attempt: string, ended: Promise<void>): Promise<HostUpdateAnswer> {
    let over = false
    void ended.then(() => { over = true })
    const now = this.options.now ?? Date.now
    const deadline = now() + HOST_UPDATE_RESTART_WAIT_MS
    const ours = async (): Promise<HostUpdateStatus | null> => { const read = await this.readStatus(); return read?.status.attempt === attempt ? read.status : null }
    while (now() < deadline) {
      const status = await ours()
      if (status) return this.restartAnswer(status, version)
      if (over) break
      await pause(100)
    }
    try {
      await writeFile(hostUpdateAttemptFile(this.statusPath, attempt, 'claim'), 'host', { flag: 'wx', mode: 0o600 })
    } catch {
      // The restart claimed it a moment earlier; its few bytes are being written.
      for (let tries = 0; tries < 20; tries++) {
        const status = await ours()
        if (status) return this.restartAnswer(status, version)
        await pause(50)
      }
      return { type: 'error', reason: 'restart-not-sent' }
    }
    const temporary = this.statusPath + '.' + attempt + '.tmp'
    const abandoned = { v: 1, attempt, version, state: 'finished', result: { type: 'error', reason: 'restart-not-sent' } }
    await writeFile(temporary, JSON.stringify(abandoned) + '\n', { mode: 0o600 }).then(() => rename(temporary, this.statusPath)).catch(() => rm(temporary, { force: true }).catch(() => undefined))
    this.options.log?.('host-update-restart-abandoned')
    return { type: 'error', reason: 'restart-not-sent' }
  }
  private restartAnswer(status: HostUpdateStatus, version: string): HostUpdateAnswer {
    if (status.state === 'finished' && status.result.type === 'error') {
      const { reason, restarted, cause } = status.result
      return { type: 'error', reason, ...(restarted !== undefined ? { restarted } : {}), ...(cause !== undefined ? { cause } : {}) }
    }
    return { type: 'update-restarting', version }
  }
  /** The status file, when it is one a restart wrote: small, and in its shape. */
  private async readStatus(): Promise<StatusRead | null> {
    try {
      const info = await stat(this.statusPath)
      if (info.size > HOST_UPDATE_STATUS_LIMIT_BYTES) return null
      const status = hostUpdateStatusSchema.safeParse(JSON.parse(await readFile(this.statusPath, 'utf8'))).data
      return status ? { status, age: Date.now() - info.mtimeMs } : null
    } catch { return null }
  }

  /**
   * Runs one launch script operation as a child of this host, the way the probe runs it over SSH: the source on stdin and
   * the configuration as its last argument. Each `update-step` line is told as it comes; the answer is the last result.
   */
  private script(configuration: string, onStep: (step: HostUpdateStep) => void, budgetMs: number, signal?: AbortSignal): Promise<unknown> {
    const child = this.spawn(this.node, ['--input-type=commonjs', '-', configuration], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: this.env })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(LAUNCH_SCRIPT_SOURCE)
    let buffer = '', size = 0, result: unknown
    const read = (line: string): void => {
      if (!line.startsWith('{')) return
      let value: unknown
      try { value = JSON.parse(line) } catch { return }
      const step = z.object({ type: z.literal('update-step'), step: z.enum(HOST_UPDATE_STEPS) }).safeParse(value)
      if (step.success) onStep(step.data.step)
      else result = value
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      size += chunk.length
      if (size > OUTPUT_LIMIT) { child.kill(); return }
      buffer += chunk
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) { read(buffer.slice(0, at).trim()); buffer = buffer.slice(at + 1) }
    })
    const stop = (): void => { child.kill() }
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    const timer = setTimeout(stop, budgetMs)
    return new Promise(done => {
      const end = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', stop); read(buffer.trim()); done(result) }
      child.once('close', end)
      child.once('error', () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); done(undefined) })
    })
  }
}
