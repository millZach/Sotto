import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { z } from 'zod'
import { parseSshResolution, validateSshHost, type SshHostConfiguration, type SshRoute, type ValidatedSshHostConfiguration } from './sshConfiguration'
import { CONTROL_OPTIONS, spawnSsh, sshExecutable, type SpawnSsh } from './sshProcess'
import { HOST_STOP_REPLY_MS, LAUNCH_SCRIPT_SOURCE, launchScriptCommand, type LaunchOperation } from './launchScript'
import { AskpassBroker, type AskpassQuestion } from './sshAskpass'
import { LAUNCH_REASONS, SshFailure, type SshFailureCode } from './sshFailure'
export { SshFailure, type SshFailureCode }
export type { SshHostConfiguration, SshRoute }

export interface SshPrompt { readonly id: string; readonly kind: 'host-key' | 'password' | 'passphrase'; readonly text: string }
export type SshConnectionStatus = 'connecting' | 'starting' | 'forwarding' | 'ready' | 'disconnected'
export interface SshCallbacks {
  readonly onStatus?: (status: SshConnectionStatus) => void
  /** Ephemeral UI only. Never persist or log a challenge, password, passphrase, or pairing code. */
  readonly onPrompt?: (prompt: SshPrompt | null) => void
  readonly onDisconnected?: (message: string) => void
}
export interface SshPairingCode { readonly hostId: string; readonly code: string; readonly expiresAt: string }
export interface SshHostConnection {
  readonly url: string
  readonly hostId: string
  readonly owned: boolean
  /** Where the user's SSH configuration sent the target, from `ssh -G`. */
  readonly route: SshRoute
  showHostPairingCode(): Promise<SshPairingCode>
  revokeClient(clientId: string): Promise<boolean>
  stopHost(): Promise<boolean>
  close(): Promise<void>
}
export interface SshLauncherDependencies {
  readonly spawn?: SpawnSsh
  readonly executable?: string
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly readyTimeoutMs?: number
  readonly authenticationTimeoutMs?: number
  readonly localPort?: () => Promise<number>
  /** The Node the askpass helper runs under. In the app this is Electron's own binary, run as Node. */
  readonly askpassNode?: string
}
const healthSchema = z.object({ v: z.literal(1), status: z.literal('ready'), hostId: z.uuid(), pid: z.number().int().positive(), port: z.number().int().min(1).max(65535) })
const readySchema = healthSchema.extend({ type: z.literal('ready'), owned: z.boolean() })
const pairingSchema = z.object({ type: z.literal('pairing-code'), code: z.string().min(1).max(256), expiresAt: z.string().datetime(), hostId: z.uuid() })
const revokedSchema = z.object({ type: z.literal('revoked'), revoked: z.boolean(), hostId: z.uuid() })
const stoppedSchema = z.object({ type: z.literal('host-stopped'), stopped: z.boolean(), hostId: z.uuid().nullable() })
/** Admin requests run after SSH is signed in; this bounds the work itself, on top of any prompt. */
const REQUEST_BUDGET_MS = 15_000
const OUTPUT_LIMIT = 65_536

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
}

/**
 * One configured host connection. Every control operation is its own `ssh` command with the launch
 * script on stdin; the `-N -L` port forward is the only ssh that lives as long as the connection.
 */
export class SshHostLauncher {
  private attempt: Attempt | undefined
  private revision = 0
  constructor(private readonly dependencies: SshLauncherDependencies = {}) {}

  async connect(configuration: SshHostConfiguration, callbacks: SshCallbacks = {}): Promise<SshHostConnection> {
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
    const attempt: Attempt = { configuration: validated, callbacks, runs: new Set(), cancelled, cancel, queue: [], answers: new Map(), busy: false, closed: false, connected: false }
    this.attempt = attempt
    this.status(attempt, 'connecting')
    const authentication = this.dependencies.authenticationTimeoutMs ?? 120_000
    const timeout = setTimeout(() => this.fail(attempt, new SshFailure(attempt.prompt ? 'prompt-unanswered' : 'connect-timeout')), authentication)
    try {
      const broker = await AskpassBroker.start((caller, question, withdrawn) => this.ask(attempt, caller, question, withdrawn), { node: this.dependencies.askpassNode ?? process.execPath, platform: this.platform() })
      attempt.broker = broker
      if (attempt.closed) { await broker.close(); throw attempt.failure ?? new SshFailure('cancelled') }
      const route = attempt.route = await this.resolve(attempt)
      const result = await this.control(attempt, { op: 'launch' }, authentication + this.readyTimeout(), 'host-start-failed', () => this.status(attempt, 'starting'))
      if (result.type === 'error') throw this.launchFailure(result)
      const parsed = readySchema.safeParse(result)
      if (!parsed.success) throw new SshFailure('host-start-failed')
      const remote = attempt.ready = parsed.data
      this.status(attempt, 'forwarding')
      const localPort = await (this.dependencies.localPort ?? freeLocalPort)()
      if (attempt.closed) throw attempt.failure ?? new SshFailure('cancelled')
      const forward = this.start(attempt, [...this.baseArguments(validated), '-N', '-T', '-n', '-o', 'ExitOnForwardFailure=yes', '-o', 'GatewayPorts=no',
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${remote.port}`, validated.target], 'ignore')
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
      if (!verified) throw new SshFailure('forward-timeout')
      attempt.connected = true
      this.status(attempt, 'ready')
      return { url: `http://127.0.0.1:${localPort}`, hostId: remote.hostId, owned: remote.owned, route,
        close: () => this.closeAttempt(attempt), showHostPairingCode: () => this.pairingCode(attempt), revokeClient: clientId => this.revokeClient(attempt, clientId),
        stopHost: async () => { try { return await this.stopHost(attempt) } finally { await this.closeAttempt(attempt) } } }
    } catch (error) {
      await this.closeAttempt(attempt)
      throw attempt.failure ?? (error instanceof Error ? error : new SshFailure('ssh-failed'))
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
  private readyTimeout(): number { return this.dependencies.readyTimeoutMs ?? 30_000 }
  private baseArguments(configuration: ValidatedSshHostConfiguration): string[] {
    // Windows' OpenSSH starts the askpass helper through cmd.exe, which keeps only the first line of a
    // host-key question; at DEBUG1 the key's fingerprint also reaches stderr, where ask() reads it.
    return ['-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=ask', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
      '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', `LogLevel=${this.platform() === 'win32' ? 'DEBUG1' : 'ERROR'}`, '-e', 'none', ...CONTROL_OPTIONS,
      ...(configuration.identityFile ? ['-i', configuration.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
      ...(configuration.sshPort ? ['-p', String(configuration.sshPort)] : [])]
  }
  private start(attempt: Attempt, args: string[], stdin: 'pipe' | 'ignore'): SshRun {
    if (attempt.closed || !attempt.broker) throw attempt.failure ?? new SshFailure('cancelled')
    const caller = randomUUID()
    const base = this.dependencies.env ?? process.env
    const env: NodeJS.ProcessEnv = { ...base, LC_ALL: 'C', LANG: 'C', ...attempt.broker.environment(caller),
      // OpenSSH before 8.4 ignores SSH_ASKPASS_REQUIRE and uses askpass only with a display set.
      ...(this.platform() !== 'win32' && !base.DISPLAY ? { DISPLAY: 'sotto' } : {}) }
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
    const executable = this.dependencies.executable ?? sshExecutable(this.platform(), base)
    let child: ChildProcess
    try { child = (this.dependencies.spawn ?? spawnSsh)(executable, args, { env, stdin }) }
    catch { attempt.broker.forget(caller); throw new SshFailure('ssh-missing') }
    let exited!: () => void
    const run: SshRun = { caller, child, stderr: '', exited: new Promise<void>(resolve => { exited = resolve }) }
    child.on('error', error => { if (!child.pid || (error as NodeJS.ErrnoException).code === 'ENOENT') { run.spawnFailed = true; exited() } })
    child.once('close', code => { run.exitCode = code; exited() })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      run.stderr = (run.stderr + chunk).slice(-16_384)
      const key = run.hostKey ? undefined : /Server host key: (\S+) (\S+)/u.exec(run.stderr)
      if (key) run.hostKey = `${key[1]} key fingerprint is ${key[2]}.`
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
  private async control(attempt: Attempt, operation: LaunchOperation, budgetMs: number, fallback: SshFailureCode, onStarting?: () => void): Promise<Record<string, unknown>> {
    const configuration = attempt.configuration
    const run = this.start(attempt, [...this.baseArguments(configuration), '-T', '-o', 'ClearAllForwardings=yes', configuration.target,
      launchScriptCommand(configuration, operation, this.readyTimeout())], 'pipe')
    run.child.stdin?.on('error', () => undefined)
    run.child.stdin?.end(LAUNCH_SCRIPT_SOURCE)
    let result: Record<string, unknown> | undefined, buffer = '', size = 0
    const read = (line: string): void => {
      const value = resultLine(line.trim())
      if (!value) return
      if (value.type === 'starting') onStarting?.()
      else result = value
    }
    run.child.stdout?.setEncoding('utf8')
    run.child.stdout?.on('data', (chunk: string) => {
      size += chunk.length
      if (size > OUTPUT_LIMIT) { run.child.kill(); return }
      buffer += chunk
      let at: number
      while ((at = buffer.indexOf('\n')) !== -1) { read(buffer.slice(0, at)); buffer = buffer.slice(at + 1) }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), budgetMs) })
    try {
      if (await Promise.race([run.exited, timedOut, attempt.cancelled]) === 'timeout') { run.child.kill(); throw new SshFailure(fallback) }
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
    if (run.spawnFailed) return new SshFailure('ssh-missing')
    // 127 is the remote shell's "command not found": the account has no usable shell or Node.
    if (run.exitCode === 127) return new SshFailure('node-missing')
    const text = run.stderr.split(/\r?\n/u).filter(line => !/^debug\d?:/u.test(line)).join('\n')
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(text)) return new SshFailure('host-key-changed')
    if (/Host key verification failed/iu.test(text)) return new SshFailure('host-key-rejected')
    if (/Permission denied|Too many authentication failures|Authentication failed/iu.test(text)) return new SshFailure('auth-failed')
    if (/bind .*Address already in use|cannot listen to port|Could not request local forwarding|forwarding failed/iu.test(text)) return new SshFailure('forward-failed')
    if (/Could not resolve hostname|Name or service not known|Connection refused|Connection timed out|Operation timed out|Network is unreachable|No route to host|Connection closed by|Connection reset|kex_exchange_identification/iu.test(text)) return new SshFailure('ssh-unreachable')
    // 255 is ssh's own exit: it failed before or instead of running the command. Anything else came from the host's side.
    return new SshFailure(run.exitCode === 255 && fallback !== 'forward-failed' ? 'ssh-failed' : fallback)
  }
  private launchFailure(result: Record<string, unknown>): SshFailure {
    const reason = typeof result.reason === 'string' ? result.reason : ''
    if (!LAUNCH_REASONS.has(reason as SshFailureCode)) return new SshFailure('host-start-failed')
    if (reason === 'node-too-old' || reason === 'node-too-new') return SshFailure.node(reason, typeof result.version === 'string' ? result.version : undefined)
    return new SshFailure(reason as SshFailureCode)
  }
  /**
   * A question from the askpass helper. On Windows it arrives as its first line only, so a host-key
   * question gets its fingerprint back from the same ssh process's debug output. A notice takes no
   * answer and is not shown. A question ssh stops waiting for is taken off the screen.
   */
  private async ask(attempt: Attempt, caller: string, question: AskpassQuestion, withdrawn: AbortSignal): Promise<string | null> {
    if (attempt.closed || withdrawn.aborted) return null
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
  private async request<T>(attempt: Attempt, operation: LaunchOperation, failure: SshFailureCode, budgetMs: number, parse: (value: Record<string, unknown>) => T | undefined): Promise<T> {
    if (attempt.busy) throw new SshFailure('request-busy')
    attempt.busy = true
    try {
      const value = parse(await this.control(attempt, operation, (this.dependencies.authenticationTimeoutMs ?? 120_000) + budgetMs, failure))
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
    return this.request(attempt, { op: 'revoke-client', hostId, clientId }, 'revoke-failed', REQUEST_BUDGET_MS, value => {
      const revoked = revokedSchema.safeParse(value)
      return revoked.success && revoked.data.hostId === hostId ? revoked.data.revoked : undefined
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
