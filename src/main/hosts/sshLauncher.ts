import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { z } from 'zod'
import { parseSshResolution, validateSshHost, type SshHostConfiguration, type SshRoute, type ValidatedSshHostConfiguration } from './sshConfiguration'
import { CONTROL_OPTIONS, openSshVersion, spawnSsh, sshExecutable, tooOld, type SpawnSsh } from './sshProcess'
import { HOST_DOWNLOAD_TIMEOUT_MS, HOST_STOP_DRAIN_MS, HOST_STOP_REPLY_MS, LAUNCH_SCRIPT_SOURCE, launchScriptCommand, type LaunchOperation } from './launchScript'
import { AskpassBroker, type AskpassQuestion } from './sshAskpass'
import { LAUNCH_REASONS, SshFailure, classifySshExit, failureFix, type SshFailureCode } from './sshFailure'
import { tailscaleHold, type TailscaleHold } from './tailscaleApproval'
import { TAILSCALE_APPROVAL_MS, type HostSetupStep } from '../../shared/hosts'
import { HOST_ARCHIVE_PATTERN, type HostUpdateStep } from '../../shared/hostUpdates'
import { version as desktopVersion } from '../../../package.json'
export { SshFailure, type SshFailureCode }
export type { SshHostConfiguration, SshRoute }

export interface SshPrompt { readonly id: string; readonly kind: 'host-key' | 'password' | 'passphrase'; readonly text: string }
export type SshConnectionStatus = 'connecting' | 'starting' | 'forwarding' | 'ready' | 'disconnected'
/** The host setup checklist steps the launcher sees: everything up to the host answering through the forward. Pairing is the desktop's. */
export type SshSetupStep = Exclude<HostSetupStep, 'pair'>
const STEP_ORDER: readonly SshSetupStep[] = ['reach', 'tailscale', 'sign-in', 'install', 'start']
/** Tailscale SSH is holding the connection until the user approves it; `url` is Tailscale's own approval page. */
export interface SshApproval { readonly url?: string }
export interface SshCallbacks {
  readonly onStatus?: (status: SshConnectionStatus) => void
  /** Which checklist step the connect is on. Steps only move forward within one connect. */
  readonly onStep?: (step: SshSetupStep) => void
  /** Tailscale SSH asked for approval, or (null) the approval came or the connect ended. The URL is shown, never logged. */
  readonly onApproval?: (approval: SshApproval | null) => void
  /** Ephemeral UI only. Never persist or log a challenge, password, passphrase, or pairing code. */
  readonly onPrompt?: (prompt: SshPrompt | null) => void
  readonly onDisconnected?: (message: string) => void
}
export interface SshPairingCode { readonly hostId: string; readonly code: string; readonly expiresAt: string }
/**
 * One operation of a host update (ADR-0040), as the desktop asks for it. The restart names no host: the launcher
 * sends the one this connection reached, so an update can only ever restart the host it is connected to.
 */
export type SshHostUpdateOperation =
  | Extract<LaunchOperation, { op: 'update-fetch' | 'update-install' }>
  | (Extract<LaunchOperation, { op: 'update-receive' }> & { readonly archive: Uint8Array })
  | { readonly op: 'update-restart'; readonly version: string }
export interface SshHostUpdateOptions {
  /** Cancel update: ends the operation's ssh. A download on the host stops within a second of it on a POSIX host. */
  readonly signal?: AbortSignal
  /** The step the host moved on to while the operation runs: the checksum after a download, unpacking, the restart. */
  readonly onStep?: (step: HostUpdateStep) => void
}
export interface SshHostConnection {
  readonly url: string
  readonly hostId: string
  readonly owned: boolean
  /** Where the user's SSH configuration sent the target, from `ssh -G`. */
  readonly route: SshRoute
  /**
   * The Node the launch script ran under on the host, for the command that revokes this computer there by hand when Forget
   * cannot (ADR-0053). A path, never a secret; kept in memory only. Absent from a host whose launch script did not say.
   */
  readonly node?: string
  showHostPairingCode(): Promise<SshPairingCode>
  /** Establish this SSH desktop's default policy once; prior policy decisions are never changed. */
  ensureDesktopAnswers(clientId: string): Promise<void>
  revokeClient(clientId: string): Promise<boolean>
  /**
   * The running host's administrative token, which this connection's launch read, for the host's phone access routes on
   * its forwarded port (ADR-0050). Keep it in memory for this connection only; never write it down or log it.
   */
  hostAdminToken(): Promise<string>
  stopHost(): Promise<boolean>
  /** One operation of a host update on this host. A failure the host reports comes back as its `error` result; a lost connection throws. */
  updateHost(operation: SshHostUpdateOperation, options?: SshHostUpdateOptions): Promise<SshHostUpdateResult>
  close(): Promise<void>
}
/** How a connect treats a host that is not running. */
export interface SshConnectOptions {
  /**
   * False for an admin connection (ADR-0053): it finds the running host and starts none, so a press that needs a running
   * host fails with `host-not-running` rather than starting one.
   */
  readonly start?: boolean
}
export interface SshLauncherDependencies {
  readonly spawn?: SpawnSsh
  readonly executable?: string
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly readyTimeoutMs?: number
  readonly authenticationTimeoutMs?: number
  /** How long a connection Tailscale SSH holds for approval may wait; five minutes unless a test says otherwise. */
  readonly approvalTimeoutMs?: number
  readonly localPort?: () => Promise<number>
  /** The Node the askpass helper runs under. In the app this is Electron's own binary, run as Node. */
  readonly askpassNode?: string
}
const healthSchema = z.object({ v: z.literal(1), status: z.literal('ready'), hostId: z.uuid(), pid: z.number().int().positive(), port: z.number().int().min(1).max(65535) })
const readySchema = healthSchema.extend({ type: z.literal('ready'), owned: z.boolean(),
  /** Only a launch's result carries it (ADR-0050). It stays on this connection's attempt and goes nowhere else. */
  adminToken: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/u).optional(),
  /** The launch's Node, from `process.execPath` on the host. Only a launch's result carries it; one Sotto cannot read is left out. */
  node: z.string().max(4096).regex(/^[^\p{Cc}]+$/u).optional().catch(undefined) })
const pairingSchema = z.object({ type: z.literal('pairing-code'), code: z.string().min(1).max(256), expiresAt: z.string().datetime(), hostId: z.uuid() })
const desktopAnswersSchema = z.object({ type: z.literal('desktop-answers'), hostId: z.uuid() })
const revokedSchema = z.object({ type: z.literal('revoked'), revoked: z.boolean(), hostId: z.uuid() })
const stoppedSchema = z.object({ type: z.literal('host-stopped'), stopped: z.boolean(), hostId: z.uuid().nullable() })
const archiveName = z.string().regex(HOST_ARCHIVE_PATTERN)
/** What a host update's operation answers. Its `error` reasons are the launch script's own codes, which main turns into sentences. */
const updateResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('update-fetched'), file: archiveName, sha256: z.string().regex(/^[0-9a-f]{64}$/u) }),
  z.object({ type: z.literal('update-received'), size: z.number().int().positive() }),
  z.object({ type: z.literal('update-installed'), version: z.string().max(64) }),
  readySchema,
  z.object({ type: z.literal('error'), reason: z.string().max(64), file: archiveName.optional(), restarted: z.boolean().optional(),
    range: z.string().max(64).optional(), node: z.string().max(32).optional(), cause: z.string().max(64).optional() }),
])
export type SshHostUpdateResult = z.infer<typeof updateResultSchema>
const updateStepSchema = z.enum(['check', 'install', 'restart'])
/** Admin requests run after SSH is signed in; this bounds the work itself, on top of any prompt. */
const REQUEST_BUDGET_MS = 15_000
const OUTPUT_LIMIT = 65_536
const KEEPALIVE_SECONDS = 15
/**
 * OpenSSH reads nothing for ServerAliveInterval x ServerAliveCountMax before it gives up on a connection that
 * is still signing in ("Connection to forge port 22 timed out"). Tailscale SSH answers nothing while it holds a
 * connection for approval, so a command that signs in while Sotto connects gets the approval budget and a little
 * more, and Sotto's own timer ends the wait first. The port forward, the one live connection, and a request sent
 * once the host is connected, when nothing shows an approval, keep 30 seconds.
 */
const SIGN_IN_KEEPALIVES = Math.ceil(TAILSCALE_APPROVAL_MS / 1000 / KEEPALIVE_SECONDS) + 1
const LIVE_KEEPALIVES = 2
/** What OpenSSH prints once it has reached the server, at the log levels Sotto runs it at. */
const REACHED = /Connection established|Server host key:|Authenticated to /u

/** Reserve a loopback-only candidate; ssh owns the actual socket and refuses any subsequent collision. */
async function freeLocalPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new SshFailure('forward-failed') }
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}
function forwardedHealth(port: number): Promise<z.infer<typeof healthSchema>> {
  return new Promise((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', port, path: '/v1/health', timeout: 1000 }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk; if (body.length > 4096) request.destroy(new Error('invalid')) })
      response.on('end', () => {
        try { if (response.statusCode !== 200) throw new Error('invalid'); resolve(healthSchema.parse(JSON.parse(body))) }
        catch { reject(new SshFailure('forward-failed')) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}
/** The ssh executables each spawner has shown to be new enough, so `ssh -V` runs once, not on every connect. */
const recentEnough = new WeakMap<SpawnSsh, Set<string>>()
const VERSION_BUDGET_MS = 5_000
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function boundedWait(completion: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([completion, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds) })]) }
  finally { clearTimeout(timer) }
}
/** What OpenSSH is asking, from its own prompt text. Nothing here is logged. */
function promptKind(text: string, hint: string): SshPrompt['kind'] {
  if (hint === 'confirm' || /authenticity of host|continue connecting|key fingerprint is/iu.test(text)) return 'host-key'
  return /passphrase/iu.test(text) ? 'passphrase' : 'password'
}
function resultLine(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('{')) return undefined
  try { const value: unknown = JSON.parse(line); return value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string' ? value as Record<string, unknown> : undefined }
  catch { return undefined }
}

/** One ssh process: a `-G` lookup, a control command, or the port forward. */
interface SshRun {
  readonly caller: string
  readonly child: ChildProcess
  readonly exited: Promise<void>
  exitCode?: number | null
  spawnFailed?: boolean
  stderr: string
  /** `Server host key: <type> <fingerprint>` from OpenSSH's debug output, which Windows needs (see ask()). */
  hostKey?: string
  /** Tailscale SSH held this process for approval. */
  held?: TailscaleHold
  /**
   * Set for a process that runs with the live keepalive, where a Tailscale hold ends after 30 seconds rather
   * than waiting out the approval budget: the port forward, or a request sent once the host is connected.
   */
  liveWait?: 'forward' | 'request'
  /** The remote side printed something, which only a signed-in session can. */
  signedIn?: boolean
  /** Gives this process's own budget the approval wait, once Tailscale holds it. */
  onHold?: () => void
}
interface PendingPrompt { readonly id: string; readonly kind: SshPrompt['kind']; readonly text: string; readonly caller: string; readonly key: string; readonly resolve: (answer: string | null) => void }
interface Attempt {
  readonly configuration: ValidatedSshHostConfiguration
  readonly callbacks: SshCallbacks
  readonly runs: Set<SshRun>
  readonly cancelled: Promise<never>
  readonly cancel: (error: Error) => void
  readonly queue: PendingPrompt[]
  /**
   * Answers given during this connection, by prompt, with the processes that received each. Another ssh
   * process asking the same question gets the same answer, so the user answers once per connect; the
   * process that already got an answer asking again means it was refused, and the user is asked.
   * Memory only, cleared when the connection closes.
   */
  readonly answers: Map<string, { readonly answer: string; readonly callers: Set<string> }>
  broker?: AskpassBroker
  prompt?: PendingPrompt
  ready?: z.infer<typeof readySchema>
  route?: SshRoute
  busy: boolean
  closing?: Promise<void>
  closed: boolean
  connected: boolean
  failure?: Error
  /** The checklist step the connect is on. */
  step: SshSetupStep
  /** Set while Tailscale SSH holds a process of this connect for approval. */
  approval?: SshApproval
  /** Restarts the sign-in timer with the approval budget, once Tailscale holds the connection. */
  onHold?: () => void
}

/**
 * One configured host connection. Every control operation is its own `ssh` command with the launch
 * script on stdin; the `-N -L` port forward is the only ssh that lives as long as the connection.
 */
export class SshHostLauncher {
  private attempt: Attempt | undefined
  private revision = 0
  constructor(private readonly dependencies: SshLauncherDependencies = {}) {}

  async connect(configuration: SshHostConfiguration, callbacks: SshCallbacks = {}, options: SshConnectOptions = {}): Promise<SshHostConnection> {
    const validated = validateSshHost(configuration)
    const revision = ++this.revision
    if (this.attempt) await this.closeAttempt(this.attempt)
    if (validated.identityFile) {
      try { await access(validated.identityFile) } catch { throw new SshFailure('identity-file-unreadable') }
    }
    if (revision !== this.revision) throw new SshFailure('cancelled')
    let cancel!: (error: Error) => void
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject })
    void cancelled.catch(() => undefined)
    const attempt: Attempt = { configuration: validated, callbacks, runs: new Set(), cancelled, cancel, queue: [], answers: new Map(), busy: false, closed: false, connected: false, step: 'reach' }
    this.attempt = attempt
    this.status(attempt, 'connecting')
    callbacks.onStep?.('reach')
    const authentication = this.dependencies.authenticationTimeoutMs ?? 120_000
    // Starts once the local helper is ready. It stops at the launch command's first output, which only a signed-in
    // session can send; from there each step has its own budget, so a slow sign-in cannot eat the host's start.
    // Once Tailscale SSH holds the connection for approval, the wait is the approval budget instead.
    const expire = (): void => this.fail(attempt, new SshFailure(attempt.approval ? 'tailscale-unapproved' : attempt.prompt ? 'prompt-unanswered' : 'connect-timeout'))
    let timeout: ReturnType<typeof setTimeout> | undefined
    attempt.onHold = () => { clearTimeout(timeout); timeout = setTimeout(expire, this.dependencies.approvalTimeoutMs ?? TAILSCALE_APPROVAL_MS) }
    const signedIn = (): void => { clearTimeout(timeout); this.advance(attempt, 'install') }
    try {
      await this.checkVersion(attempt)
      const broker = await AskpassBroker.start((caller, question, withdrawn) => this.ask(attempt, caller, question, withdrawn), { node: this.dependencies.askpassNode ?? process.execPath, platform: this.platform() })
      attempt.broker = broker
      if (attempt.closed) { await broker.close(); throw attempt.failure ?? new SshFailure('cancelled') }
      timeout = setTimeout(expire, authentication)
      const route = attempt.route = await this.resolve(attempt)
      const result = await this.control(attempt, { op: 'launch', ...(options.start === false ? { start: false as const } : {}) }, authentication + this.readyTimeout(), 'host-start-failed', { onOutput: signedIn, onStarting: () => { this.advance(attempt, 'start'); this.status(attempt, 'starting') } })
      if (result.type === 'error') throw this.launchFailure(result)
      const parsed = readySchema.safeParse(result)
      if (!parsed.success) throw new SshFailure('host-start-failed')
      // A host that was already running is installed and started.
      this.advance(attempt, 'start')
      const remote = attempt.ready = parsed.data
      this.status(attempt, 'forwarding')
      const localPort = await (this.dependencies.localPort ?? freeLocalPort)()
      if (attempt.closed) throw attempt.failure ?? new SshFailure('cancelled')
      // The forward signs in too, but keeps the live keepalive: within Tailscale's check period, which the launch's
      // approval just started, it is not held. Should Tailscale hold it anyway, the checklist shows the approval
      // and OpenSSH ends the wait after 30 seconds (ADR-0025).
      const forward = this.start(attempt, [...this.baseArguments(validated), '-N', '-T', '-n', '-o', 'ExitOnForwardFailure=yes', '-o', 'GatewayPorts=no',
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${remote.port}`, validated.target], 'ignore', 'forward')
      void forward.exited.then(() => { if (!attempt.closed) this.fail(attempt, this.classify(forward, 'forward-failed')) })
      const deadline = Date.now() + authentication
      let verified = false
      while (!attempt.closed && Date.now() < deadline) {
        try {
          const health = await Promise.race([forwardedHealth(localPort), cancelled])
          if (health.hostId !== remote.hostId || health.pid !== remote.pid || health.port !== remote.port) throw new SshFailure('forward-failed')
          verified = true; break
        } catch (error) {
          if (attempt.closed) throw attempt.failure ?? error
          if (error instanceof SshFailure) throw error
          await Promise.race([delay(100), cancelled])
        }
      }
      if (!verified) throw forward.held ? this.classify(forward, 'forward-timeout') : new SshFailure(attempt.prompt ? 'prompt-unanswered' : 'forward-timeout')
      // The host answered through the forward, so the forward is signed in: an approval it was held for came,
      // and its ending later is a dropped connection, not an approval that never came.
      this.signedIn(attempt, forward)
      attempt.connected = true
      this.status(attempt, 'ready')
      return { url: `http://127.0.0.1:${localPort}`, hostId: remote.hostId, owned: remote.owned, route, ...(remote.node ? { node: remote.node } : {}),
        close: () => this.closeAttempt(attempt), showHostPairingCode: () => this.pairingCode(attempt), ensureDesktopAnswers: clientId => this.ensureDesktopAnswers(attempt, clientId), revokeClient: clientId => this.revokeClient(attempt, clientId),
        hostAdminToken: () => this.adminToken(attempt),
        stopHost: async () => { try { return await this.stopHost(attempt) } finally { await this.closeAttempt(attempt) } },
        updateHost: (operation, options) => this.updateHost(attempt, operation, options) }
    } catch (error) {
      await this.closeAttempt(attempt)
      const failure = attempt.failure ?? (error instanceof Error ? error : new SshFailure('ssh-failed'))
      if (failure instanceof SshFailure && !failure.fix) {
        const fix = failureFix(failure.code, { target: validated.target, sshPort: validated.sshPort, installPath: validated.installPath, identityFile: validated.identityFile,
          hostname: attempt.route?.hostname, port: attempt.route?.port, version: desktopVersion })
        if (fix) failure.fix = fix
      }
      throw failure
    } finally { clearTimeout(timeout) }
  }

  answerPrompt(id: string, answer: string): void {
    const attempt = this.attempt, prompt = attempt?.prompt
    if (!attempt || attempt.closed || !prompt || prompt.id !== id) throw new Error('This SSH prompt is no longer waiting. Reconnect if needed.')
    if (answer.length > 4096 || /[\r\n\0]/u.test(answer)) throw new Error('Enter one SSH answer without a line break.')
    if (prompt.kind === 'host-key' && answer !== 'yes' && answer !== 'no') throw new Error('Choose whether to trust this SSH host key.')
    delete attempt.prompt
    attempt.callbacks.onPrompt?.(null)
    if (answer !== 'no' || prompt.kind !== 'host-key') attempt.answers.set(prompt.key, { answer, callers: new Set([prompt.caller]) })
    prompt.resolve(answer)
    this.nextPrompt(attempt)
  }
  disconnect(): Promise<void> { this.revision++; return this.attempt ? this.closeAttempt(this.attempt) : Promise.resolve() }

  private platform(): NodeJS.Platform { return this.dependencies.platform ?? process.platform }
  private spawner(): SpawnSsh { return this.dependencies.spawn ?? spawnSsh }
  private executable(): string { return this.dependencies.executable ?? sshExecutable(this.platform(), this.dependencies.env ?? process.env) }
  /** What every ssh runs with, before askpass: OpenSSH's own words in English, and none of Electron's Node settings. */
  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.dependencies.env ?? process.env), LC_ALL: 'C', LANG: 'C' }
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
    return env
  }
  /**
   * `ssh -V`, once for each ssh executable: every prompt depends on SSH_ASKPASS_REQUIRE, which OpenSSH 8.4
   * added, and an older ssh would sign in with no way to ask. A version it does not print is let through.
   */
  private async checkVersion(attempt: Attempt): Promise<void> {
    const spawner = this.spawner(), executable = this.executable()
    if (recentEnough.get(spawner)?.has(executable)) return
    let child: ChildProcess
    try { child = spawner(executable, ['-V'], { env: this.environment(), stdin: 'ignore' }) }
    catch { throw new SshFailure('ssh-missing') }
    let output = ''
    const read = (chunk: string): void => { output = (output + chunk).slice(0, 4096) }
    child.stdout?.setEncoding('utf8'); child.stdout?.on('data', read)
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', read)
    let timer: ReturnType<typeof setTimeout> | undefined
    const ended = new Promise<'missing' | 'ended' | 'timeout'>(resolve => {
      child.on('error', error => { if (!child.pid || (error as NodeJS.ErrnoException).code === 'ENOENT') resolve('missing') })
      child.once('close', () => resolve('ended'))
      timer = setTimeout(() => resolve('timeout'), VERSION_BUDGET_MS)
    })
    let outcome: Awaited<typeof ended>
    try { outcome = await Promise.race([ended, attempt.cancelled]) }
    finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill() }
    if (outcome === 'missing') throw new SshFailure('ssh-missing')
    const version = openSshVersion(output)
    if (!version) return
    if (tooOld(version)) throw SshFailure.sshTooOld(version.text, this.platform())
    recentEnough.set(spawner, (recentEnough.get(spawner) ?? new Set<string>()).add(executable))
  }
  private readyTimeout(): number { return this.dependencies.readyTimeoutMs ?? 30_000 }
  /** `keepalive` is `signing-in` for a command sent while Sotto connects, which may wait for a Tailscale approval, and `live` otherwise. */
  private baseArguments(configuration: ValidatedSshHostConfiguration, keepalive: 'live' | 'signing-in' = 'live'): string[] {
    // Windows' OpenSSH starts the askpass helper through cmd.exe, which keeps only the first line of a
    // host-key question; at DEBUG1 the key's fingerprint also reaches stderr, where ask() reads it.
    // Elsewhere INFO, the lowest level at which OpenSSH prints a server's banner, where Tailscale SSH asks for approval.
    // A RemoteCommand or RequestTTY in the user's configuration (`RemoteCommand tmux new -A`) would make
    // every command Sotto runs fail with "Cannot execute command-line and remote command", so both are off.
    return ['-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=ask', '-o', 'ConnectTimeout=15', '-o', `ServerAliveInterval=${KEEPALIVE_SECONDS}`,
      '-o', `ServerAliveCountMax=${keepalive === 'live' ? LIVE_KEEPALIVES : SIGN_IN_KEEPALIVES}`,
      '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', '-o', `LogLevel=${this.platform() === 'win32' ? 'DEBUG1' : 'INFO'}`, '-e', 'none', ...CONTROL_OPTIONS,
      ...(configuration.identityFile ? ['-i', configuration.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
      ...(configuration.sshPort ? ['-p', String(configuration.sshPort)] : [])]
  }
  private start(attempt: Attempt, args: string[], stdin: 'pipe' | 'ignore', liveWait?: SshRun['liveWait']): SshRun {
    if (attempt.closed || !attempt.broker) throw attempt.failure ?? new SshFailure('cancelled')
    const caller = randomUUID()
    const base = this.environment()
    const env: NodeJS.ProcessEnv = { ...base, ...attempt.broker.environment(caller),
      // An ssh whose version checkVersion() could not read may predate 8.4, which uses askpass only with a display set.
      ...(this.platform() !== 'win32' && !base.DISPLAY ? { DISPLAY: 'sotto' } : {}) }
    let child: ChildProcess
    try { child = this.spawner()(this.executable(), args, { env, stdin }) }
    catch { attempt.broker.forget(caller); throw new SshFailure('ssh-missing') }
    let exited!: () => void
    const run: SshRun = { caller, child, stderr: '', exited: new Promise<void>(resolve => { exited = resolve }), ...(liveWait ? { liveWait } : {}) }
    child.on('error', error => { if (!child.pid || (error as NodeJS.ErrnoException).code === 'ENOENT') { run.spawnFailed = true; exited() } })
    child.once('close', code => { run.exitCode = code; exited() })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      run.stderr = (run.stderr + chunk).slice(-16_384)
      const key = run.hostKey ? undefined : /Server host key: (\S+) (\S+)/u.exec(run.stderr)
      if (key) run.hostKey = `${key[1]} key fingerprint is ${key[2]}.`
      // What signing in says about the checklist; a signed-in connection's stderr is not read for it.
      if (run.signedIn || attempt.closed) return
      if (!attempt.connected && REACHED.test(chunk)) this.advance(attempt, 'sign-in')
      if (run.held?.url) return
      const hold = tailscaleHold(run.stderr)
      if (!hold || (run.held && !hold.url)) return
      // Once the host is connected, nothing shows an approval: the hold is only remembered, for the failure's sentence.
      if (attempt.connected) run.held = hold
      else this.hold(attempt, run, hold)
    })
    attempt.runs.add(run)
    void run.exited.then(() => { attempt.runs.delete(run); attempt.broker?.forget(caller); this.dropPrompts(attempt, caller) })
    return run
  }
  /** `ssh -G`: what the user's configuration makes of the target. A failure here falls back to the name as typed; connecting reports it. */
  private async resolve(attempt: Attempt): Promise<SshRoute> {
    const target = attempt.configuration.target
    const run = this.start(attempt, [...this.baseArguments(attempt.configuration), '-G', target], 'ignore')
    let output = ''
    run.child.stdout?.setEncoding('utf8')
    run.child.stdout?.on('data', (chunk: string) => { output += chunk; if (output.length > OUTPUT_LIMIT) run.child.kill() })
    await Promise.race([run.exited, attempt.cancelled])
    if (run.spawnFailed) throw new SshFailure('ssh-missing')
    return parseSshResolution(target, run.exitCode === 0 && output.length <= OUTPUT_LIMIT ? output : '')
  }
  /**
   * Runs one launch script operation: `ssh <target> sh -c <probe> ...` with the script written to stdin.
   * The last JSON line on stdout is the result; anything a login profile printed before it is skipped.
   */
  private async control(attempt: Attempt, operation: LaunchOperation, budgetMs: number, fallback: SshFailureCode,
    events: { readonly onOutput?: () => void; readonly onStarting?: () => void; readonly onUpdateStep?: (step: HostUpdateStep) => void
      /** What goes on stdin in place of the launch script: the archive, for the receive script. */
      readonly stdin?: Uint8Array; readonly signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    const configuration = attempt.configuration
    // A request once the host is connected keeps the live keepalive: nothing shows an approval then, so a
    // request Tailscale holds ends after 30 seconds and says how to approve, rather than waiting unseen.
    const live = attempt.connected
    const run = this.start(attempt, [...this.baseArguments(configuration, live ? 'live' : 'signing-in'), '-T', '-o', 'ClearAllForwardings=yes', configuration.target,
      launchScriptCommand(configuration, operation, this.readyTimeout())], 'pipe', live ? 'request' : undefined)
    run.child.stdin?.on('error', () => undefined)
    run.child.stdin?.end(events.stdin ?? LAUNCH_SCRIPT_SOURCE)
    let result: Record<string, unknown> | undefined, buffer = '', size = 0
    const read = (line: string): void => {
      const value = resultLine(line.trim())
      if (!value) return
      if (value.type === 'starting') events.onStarting?.()
      else if (value.type === 'update-step') { const step = updateStepSchema.safeParse(value.step); if (step.success) events.onUpdateStep?.(step.data) }
      // The launch command's first line, which only a signed-in session prints; the first output already said so.
      else if (value.type !== 'signed-in') result = value
    }
    run.child.stdout?.setEncoding('utf8')
    run.child.stdout?.on('data', (chunk: string) => {
      if (size === 0) { this.signedIn(attempt, run); events.onOutput?.() }
      size += chunk.length
      if (size > OUTPUT_LIMIT) { run.child.kill(); return }
      buffer += chunk
      let at: number
      while ((at = buffer.indexOf('\n')) !== -1) { read(buffer.slice(0, at)); buffer = buffer.slice(at + 1) }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let expire!: (value: 'timeout') => void
    const timedOut = new Promise<'timeout'>(resolve => { expire = resolve })
    const signal = events.signal
    const aborted = new Promise<'aborted'>(resolve => { if (signal?.aborted) resolve('aborted'); else signal?.addEventListener('abort', () => resolve('aborted'), { once: true }) })
    const arm = (milliseconds: number): void => { clearTimeout(timer); timer = setTimeout(() => expire('timeout'), milliseconds) }
    arm(budgetMs)
    // Held by Tailscale, the command gets the approval wait on top of its own budget.
    run.onHold = () => arm((this.dependencies.approvalTimeoutMs ?? TAILSCALE_APPROVAL_MS) + budgetMs)
    try {
      const ended = await Promise.race([run.exited, timedOut, aborted, attempt.cancelled])
      if (ended === 'aborted') { run.child.kill(); throw new SshFailure('cancelled') }
      if (ended === 'timeout') {
        const asking = attempt.prompt?.caller === run.caller || attempt.queue.some(item => item.caller === run.caller)
        run.child.kill(); throw asking ? new SshFailure('prompt-unanswered') : run.held && !run.signedIn ? this.classify(run, fallback) : new SshFailure(fallback)
      }
    } finally { clearTimeout(timer) }
    read(buffer)
    if (result && size <= OUTPUT_LIMIT) return result
    throw this.classify(run, fallback)
  }
  /**
   * Why an ssh process ended without a result, from its exit and OpenSSH's own words, falling back to
   * what the operation was for. Never logged.
   */
  private classify(run: SshRun, fallback: SshFailureCode): SshFailure {
    return classifySshExit({ spawnFailed: run.spawnFailed, exitCode: run.exitCode, stderr: run.stderr, heldForApproval: !!run.held && !run.signedIn, liveWait: run.liveWait }, fallback)
  }
  /** Moves the checklist forward, never back; the Tailscale step is left only by signing in. */
  private advance(attempt: Attempt, step: SshSetupStep): void {
    if (attempt.closed || attempt.connected || STEP_ORDER.indexOf(step) <= STEP_ORDER.indexOf(attempt.step)) return
    if (attempt.approval && STEP_ORDER.indexOf(step) < STEP_ORDER.indexOf('install')) return
    attempt.step = step
    attempt.callbacks.onStep?.(step)
  }
  /**
   * Tailscale SSH holds `run` for approval: the URL, and for a command that signs in, the step and a wait as long
   * as the approval budget. The port forward keeps its live keepalive, so its step stays where it was.
   */
  private hold(attempt: Attempt, run: SshRun, hold: TailscaleHold): void {
    const first = !run.held
    run.held = hold
    attempt.approval = hold.url ? { url: hold.url } : {}
    if (first && !run.liveWait) {
      if (STEP_ORDER.indexOf(attempt.step) < STEP_ORDER.indexOf('install') && attempt.step !== 'tailscale') { attempt.step = 'tailscale'; attempt.callbacks.onStep?.('tailscale') }
      attempt.onHold?.()
      run.onHold?.()
    }
    attempt.callbacks.onApproval?.(attempt.approval)
  }
  /** A command's first output: it signed in, so an approval Tailscale held it for has come. */
  private signedIn(attempt: Attempt, run: SshRun): void {
    run.signedIn = true
    if (!run.held || !attempt.approval) return
    delete attempt.approval
    attempt.callbacks.onApproval?.(null)
  }
  private launchFailure(result: Record<string, unknown>): SshFailure {
    const reason = typeof result.reason === 'string' ? result.reason : ''
    if (!LAUNCH_REASONS.has(reason as SshFailureCode)) return new SshFailure('host-start-failed')
    if (reason === 'node-too-old' || reason === 'node-too-new') return SshFailure.node(reason, typeof result.version === 'string' ? result.version : undefined)
    return new SshFailure(reason as SshFailureCode)
  }
  /**
   * A question from the askpass helper. A host-key question missing its fingerprint gets it from the
   * same ssh process's debug output. A notice takes no answer and is not shown. A question ssh stops
   * waiting for is taken off the screen.
   */
  private async ask(attempt: Attempt, caller: string, question: AskpassQuestion, withdrawn: AbortSignal): Promise<string | null> {
    if (attempt.closed || withdrawn.aborted) return null
    // SSH asks only once it has reached the server.
    this.advance(attempt, 'sign-in')
    // SSH_ASKPASS_PROMPT=none: OpenSSH is telling, not asking ("Confirm user presence for key ..."), and
    // kills the helper when it is done. Nothing typed may be cached and replayed as an answer.
    if (question.hint === 'none') return ''
    let text = question.prompt.replace(/\r/gu, '').trim()
    const kind = promptKind(text, question.hint)
    if (kind === 'host-key' && question.hint !== 'confirm' && !/fingerprint is/iu.test(text)) {
      const run = [...attempt.runs].find(item => item.caller === caller)
      const deadline = Date.now() + 2000
      while (run && !run.hostKey && !attempt.closed && Date.now() < deadline) await delay(25)
      text = [text.split('\n')[0], run?.hostKey ?? 'Sotto could not read the key fingerprint. Check the key on the host before you trust it.',
        'Are you sure you want to continue connecting?'].join('\n')
    }
    if (attempt.closed || withdrawn.aborted) return null
    const key = `${kind}\n${text}`
    const cached = attempt.answers.get(key)
    if (cached && !cached.callers.has(caller)) { cached.callers.add(caller); return cached.answer }
    if (cached) attempt.answers.delete(key)
    return new Promise(resolve => {
      const pending: PendingPrompt = { id: randomUUID(), kind, text, caller, key, resolve }
      withdrawn.addEventListener('abort', () => this.withdraw(attempt, pending.id), { once: true })
      attempt.queue.push(pending); this.nextPrompt(attempt)
    })
  }
  private nextPrompt(attempt: Attempt): void {
    while (!attempt.prompt && !attempt.closed && attempt.queue.length) {
      const next = attempt.queue.shift()!
      const cached = attempt.answers.get(next.key)
      if (cached && !cached.callers.has(next.caller)) { cached.callers.add(next.caller); next.resolve(cached.answer); continue }
      attempt.prompt = next
      attempt.callbacks.onPrompt?.({ id: next.id, kind: next.kind, text: next.text })
    }
  }
  /** An ssh process that ended no longer needs its questions answered. */
  private dropPrompts(attempt: Attempt, caller: string): void {
    for (const pending of attempt.queue.filter(item => item.caller === caller)) this.withdraw(attempt, pending.id)
    if (attempt.prompt?.caller === caller) this.withdraw(attempt, attempt.prompt.id)
  }
  /** A question nobody is waiting for any more: resolved with no answer, and off the screen if it was showing. */
  private withdraw(attempt: Attempt, id: string): void {
    const queued = attempt.queue.findIndex(item => item.id === id)
    if (queued !== -1) { attempt.queue.splice(queued, 1)[0]!.resolve(null); return }
    if (attempt.prompt?.id !== id) return
    const shown = attempt.prompt
    delete attempt.prompt
    shown.resolve(null)
    attempt.callbacks.onPrompt?.(null)
    this.nextPrompt(attempt)
  }
  /**
   * One launch script request. `failure` is what an answer the script gave but `parse` refused says; `noAnswer` is what a
   * request that ended with no answer says, which is `failure` too unless the caller has to tell the two apart.
   */
  private async request<T>(attempt: Attempt, operation: LaunchOperation, failure: SshFailureCode, budgetMs: number, parse: (value: Record<string, unknown>) => T | undefined,
    events: Parameters<SshHostLauncher['control']>[4] = {}, noAnswer: SshFailureCode = failure): Promise<T> {
    if (attempt.busy) throw new SshFailure('request-busy')
    attempt.busy = true
    try {
      const value = parse(await this.control(attempt, operation, (this.dependencies.authenticationTimeoutMs ?? 120_000) + budgetMs, noAnswer, events))
      if (value === undefined) throw new SshFailure(failure)
      return value
    } finally { attempt.busy = false }
  }
  private pairingCode(attempt: Attempt): Promise<SshPairingCode> {
    if (attempt.closed || !attempt.connected || !attempt.ready) return Promise.reject(new SshFailure('not-connected', 'Connect to the SSH host before requesting a pairing code.'))
    const hostId = attempt.ready.hostId
    return this.request(attempt, { op: 'pairing-code', hostId }, 'pairing-failed', REQUEST_BUDGET_MS, value => {
      const code = pairingSchema.safeParse(value)
      return code.success && code.data.hostId === hostId ? { code: code.data.code, expiresAt: code.data.expiresAt, hostId } : undefined
    })
  }
  private revokeClient(attempt: Attempt, clientId: string): Promise<boolean> {
    if (attempt.closed || !attempt.connected || !attempt.ready) return Promise.reject(new SshFailure('not-connected', 'Connect to the SSH host before forgetting a client.'))
    if (!clientId || clientId.length > 512 || /[\p{Cc}]/u.test(clientId)) return Promise.reject(new Error('Choose a valid paired client.'))
    const hostId = attempt.ready.hostId
    // `revoke-failed` is the launch script saying the host did not revoke; a request that got no answer is SSH failing,
    // which Forget must not report as the host refusing (ADR-0053).
    return this.request(attempt, { op: 'revoke-client', hostId, clientId }, 'revoke-failed', REQUEST_BUDGET_MS, value => {
      const revoked = revokedSchema.safeParse(value)
      return revoked.success && revoked.data.hostId === hostId ? revoked.data.revoked : undefined
    }, {}, 'ssh-failed')
  }
  private async adminToken(attempt: Attempt): Promise<string> {
    if (attempt.closed || !attempt.connected || !attempt.ready) throw new SshFailure('not-connected', 'Connect to the SSH host before changing its phone access.')
    if (!attempt.ready.adminToken) throw new SshFailure('admin-failed')
    return attempt.ready.adminToken
  }
  private async ensureDesktopAnswers(attempt: Attempt, clientId: string): Promise<void> {
    if (attempt.closed || !attempt.connected || !attempt.ready) throw new SshFailure('not-connected', 'Connect to the SSH host before setting up desktop permissions.')
    if (!clientId || clientId.length > 512 || /[\p{Cc}]/u.test(clientId)) throw new Error('Choose a valid paired client.')
    const hostId = attempt.ready.hostId
    await this.request(attempt, { op: 'desktop-answers', hostId, clientId }, 'permission-setup-failed', REQUEST_BUDGET_MS, value => {
      const result = desktopAnswersSchema.safeParse(value)
      return result.success && result.data.hostId === hostId ? true : undefined
    })
  }
  private stopHost(attempt: Attempt): Promise<boolean> {
    if (attempt.closed || !attempt.connected || !attempt.ready) return Promise.reject(new SshFailure('not-connected', 'Connect to the SSH host before stopping it.'))
    const hostId = attempt.ready.hostId
    return this.request(attempt, { op: 'stop-host', hostId }, 'stop-failed', HOST_STOP_REPLY_MS, value => {
      const stopped = stoppedSchema.safeParse(value)
      return stopped.success && (stopped.data.hostId === null || stopped.data.hostId === hostId) ? stopped.data.stopped : undefined
    })
  }
  /**
   * One operation of a host update, sent to the host this connection reached. Each has its own budget on top of signing
   * in: two downloads, a copy, an unpack, or a stop and up to two starts (the new version, then the old one again).
   */
  private updateHost(attempt: Attempt, operation: SshHostUpdateOperation, options: SshHostUpdateOptions = {}): Promise<SshHostUpdateResult> {
    if (attempt.closed || !attempt.connected || !attempt.ready) return Promise.reject(new SshFailure('not-connected', 'Connect to the SSH host before updating it.'))
    const hostId = attempt.ready.hostId
    let launch: LaunchOperation, budget: number, stdin: Uint8Array | undefined
    if (operation.op === 'update-restart') { launch = { op: 'update-restart', hostId, version: operation.version }; budget = HOST_STOP_DRAIN_MS + 2 * this.readyTimeout() + 10_000 }
    else if (operation.op === 'update-receive') { launch = { op: 'update-receive', file: operation.file, size: operation.size }; budget = 10 * 60_000; stdin = operation.archive }
    else if (operation.op === 'update-fetch') { launch = operation; budget = 2 * HOST_DOWNLOAD_TIMEOUT_MS + 10_000 }
    else { launch = operation; budget = 2 * 60_000 }
    return this.request(attempt, launch, 'update-failed', budget, value => {
      const parsed = updateResultSchema.safeParse(value)
      return parsed.success ? parsed.data : undefined
    }, { ...(stdin ? { stdin } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.onStep ? { onUpdateStep: options.onStep } : {}) })
  }
  private status(attempt: Attempt, status: SshConnectionStatus): void { attempt.callbacks.onStatus?.(status) }
  private fail(attempt: Attempt, error: Error): void {
    if (attempt.closed) return
    attempt.failure = error; attempt.cancel(error)
    if (attempt.connected) attempt.callbacks.onDisconnected?.(error.message)
    void this.closeAttempt(attempt)
  }
  private closeAttempt(attempt: Attempt): Promise<void> {
    if (attempt.closing) return attempt.closing
    attempt.closed = true
    attempt.cancel(attempt.failure ?? new SshFailure('cancelled'))
    for (const pending of attempt.queue.splice(0)) pending.resolve(null)
    if (attempt.prompt) { const shown = attempt.prompt; delete attempt.prompt; shown.resolve(null); attempt.callbacks.onPrompt?.(null) }
    if (attempt.approval) { delete attempt.approval; attempt.callbacks.onApproval?.(null) }
    attempt.answers.clear()
    attempt.closing = (async () => {
      const runs = [...attempt.runs]
      for (const run of runs) run.child.kill()
      await Promise.all(runs.map(run => boundedWait(run.exited, 2000)))
      await attempt.broker?.close()
      this.status(attempt, 'disconnected')
      if (this.attempt === attempt) this.attempt = undefined
    })()
    return attempt.closing
  }
}
