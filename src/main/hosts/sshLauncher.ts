import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { stripVTControlCharacters } from 'node:util'
import { z } from 'zod'
import { validateSshHost, type SshHostConfiguration, type ValidatedSshHostConfiguration } from './sshConfiguration'
import { spawnSsh, type SpawnSsh, type SshProcess } from './sshProcess'
import { sshSupervisorCommand } from './sshSupervisor'

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
  showHostPairingCode(): Promise<SshPairingCode>
  revokeClient(clientId: string): Promise<boolean>
  close(): Promise<void>
}
export interface SshLauncherDependencies {
  readonly spawn?: SpawnSsh
  readonly executable?: string
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly readyTimeoutMs?: number
  readonly authenticationTimeoutMs?: number
  readonly closeTimeoutMs?: number
  readonly localPort?: () => Promise<number>
}
const healthSchema = z.object({ v: z.literal(1), status: z.literal('ready'), hostId: z.uuid(), pid: z.number().int().positive(), port: z.number().int().min(1).max(65535) })
const readySchema = healthSchema.extend({ type: z.literal('ready'), owned: z.boolean() })
const pairingSchema = z.object({ type: z.literal('pairing-code'), id: z.uuid(), code: z.string().min(1).max(256), expiresAt: z.string().datetime(), hostId: z.uuid() })
const REVOCATION_ERROR = 'Client access could not be revoked. Check the host connection and try Forget again.'
const PAIRING_ERROR = 'The pairing code could not be read from the host. Check that the host is running and try again.'
const ERRORS: Readonly<Record<string, string>> = {
  'archive-missing': 'The host installation was not found. Check its folder on the SSH host and reconnect.',
  'descriptor-invalid': 'The host connection record could not be read. Check the host data folder before reconnecting.',
  'port-taken': 'The host port is being used by another service. Stop that service or choose another host port.',
  'host-start-failed': 'The host could not start. Check its installation, data folder, and key file on the SSH host.',
  'host-timeout': 'The host was not ready in time. Check that it starts on the SSH host, then reconnect.',
  'ssh-refused': 'SSH refused the connection. Check the host name, SSH access, and identity file, then reconnect.',
  'forward-failed': 'The local SSH forward could not open. Check that the local port is available and reconnect.',
  'ssh-missing': 'SSH could not start. Install OpenSSH and check that its executable is available.',
}
/** Reserve a loopback-only candidate; ssh owns the actual socket and refuses any subsequent collision. */
async function freeLocalPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error(ERRORS['forward-failed']) }
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
        catch { reject(new Error(ERRORS['forward-failed'])) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
  })
}
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function boundedWait(completion: Promise<void>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([completion, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds) })]) }
  finally { clearTimeout(timer) }
}

interface ProcessRecord {
  readonly process: SshProcess
  readonly subscriptions: { dispose(): void }[]
  readonly exited: Promise<void>
  exit: boolean
  buffer: string
  promptBuffer: string
  lastPrompt: string
}
interface Attempt {
  readonly configuration: ValidatedSshHostConfiguration
  readonly callbacks: SshCallbacks
  readonly marker: string
  readonly processes: ProcessRecord[]
  readonly cancelled: Promise<never>
  readonly cancel: (error: Error) => void
  supervisor?: ProcessRecord
  prompt?: { id: string; kind: SshPrompt['kind']; process: ProcessRecord }
  ready?: z.infer<typeof readySchema>
  closing?: Promise<void>
  closed: boolean
  connected: boolean
  failure?: Error
  rejectReady?: (error: Error) => void
  resolveReady?: (ready: z.infer<typeof readySchema>) => void
  revocation?: { id: string; resolve: (revoked: boolean) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  pairing?: { id: string; resolve: (code: SshPairingCode) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
}

/** One configured host connection. Reconnect closes the previous forward before creating a new socket path. */
export class SshHostLauncher {
  private attempt: Attempt | undefined
  private revision = 0
  constructor(private readonly dependencies: SshLauncherDependencies = {}) {}

  async connect(configuration: SshHostConfiguration, callbacks: SshCallbacks = {}): Promise<SshHostConnection> {
    const validated = validateSshHost(configuration)
    const revision = ++this.revision
    if (this.attempt) await this.closeAttempt(this.attempt)
    if (validated.identityFile) {
      try { await access(validated.identityFile) } catch { throw new Error('The SSH identity file could not be read. Choose its current path and reconnect.') }
    }
    if (revision !== this.revision) throw new Error('The SSH connection was cancelled.')
    let cancel!: (error: Error) => void
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject })
    void cancelled.catch(() => undefined)
    const attempt: Attempt = { configuration: validated, callbacks, marker: `SOTTO_SSH_${randomUUID()}:`, processes: [], cancelled, cancel, closed: false, connected: false }
    this.attempt = attempt
    this.status(attempt, 'connecting')
    const timeout = setTimeout(() => this.fail(attempt, new Error('SSH did not finish connecting in time. Check any authentication prompt, then reconnect.')), this.dependencies.authenticationTimeoutMs ?? 120_000)
    try {
      const ready = new Promise<z.infer<typeof readySchema>>((resolve, reject) => { attempt.resolveReady = resolve; attempt.rejectReady = reject })
      void ready.catch(() => undefined)
      attempt.supervisor = await this.startProcess(attempt, [...this.baseArguments(validated), '-T', '-o', 'ClearAllForwardings=yes', validated.target,
        sshSupervisorCommand(validated, attempt.marker, this.dependencies.readyTimeoutMs ?? 30_000)], true)
      const remote = await Promise.race([ready, cancelled])
      clearTimeout(timeout)
      this.status(attempt, 'forwarding')
      const localPort = await (this.dependencies.localPort ?? freeLocalPort)()
      if (attempt.closed) throw attempt.failure ?? new Error('The SSH connection was cancelled.')
      await this.startProcess(attempt, [...this.baseArguments(validated), '-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'GatewayPorts=no',
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${remote.port}`, validated.target], false)
      const deadline = Date.now() + (this.dependencies.authenticationTimeoutMs ?? 120_000)
      let verified = false
      while (!attempt.closed && Date.now() < deadline) {
        try {
          const health = await Promise.race([forwardedHealth(localPort), cancelled])
          if (health.hostId !== remote.hostId || health.pid !== remote.pid || health.port !== remote.port) throw new Error(ERRORS['forward-failed'])
          verified = true; break
        } catch (error) {
          if (attempt.closed) throw attempt.failure ?? error
          if (error instanceof Error && error.message === ERRORS['forward-failed']) throw error
          await Promise.race([delay(100), cancelled])
        }
      }
      if (!verified) throw new Error('The SSH forward was not ready in time. Check SSH access and reconnect.')
      attempt.connected = true
      this.status(attempt, 'ready')
      return { url: `http://127.0.0.1:${localPort}`, hostId: remote.hostId, owned: remote.owned,
        close: () => this.closeAttempt(attempt), showHostPairingCode: () => this.pairingCode(attempt), revokeClient: clientId => this.revokeClient(attempt, clientId) }
    } catch (error) {
      await this.closeAttempt(attempt)
      throw attempt.failure ?? (error instanceof Error ? error : new Error(ERRORS['ssh-refused']))
    } finally { clearTimeout(timeout) }
  }

  answerPrompt(id: string, answer: string): void {
    const attempt = this.attempt, prompt = attempt?.prompt
    if (!attempt || attempt.closed || !prompt || prompt.id !== id) throw new Error('This SSH prompt is no longer waiting. Reconnect if needed.')
    if (answer.length > 4096 || /[\r\n\0]/u.test(answer)) throw new Error('Enter one SSH answer without a line break.')
    if (prompt.kind === 'host-key' && answer !== 'yes' && answer !== 'no') throw new Error('Choose whether to trust this SSH host key.')
    delete attempt.prompt
    prompt.process.lastPrompt = ''
    prompt.process.promptBuffer = ''
    attempt.callbacks.onPrompt?.(null)
    prompt.process.process.write(`${answer}\r`)
  }
  disconnect(): Promise<void> { this.revision++; return this.attempt ? this.closeAttempt(this.attempt) : Promise.resolve() }

  private baseArguments(configuration: ValidatedSshHostConfiguration): string[] {
    return ['-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=ask', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
      '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'LogLevel=ERROR', '-e', 'none',
      ...(configuration.identityFile ? ['-i', configuration.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
      ...(configuration.sshPort ? ['-p', String(configuration.sshPort)] : [])]
  }
  private async startProcess(attempt: Attempt, args: string[], supervisor: boolean): Promise<ProcessRecord> {
    let process: SshProcess
    try {
      process = await (this.dependencies.spawn ?? spawnSsh)(this.dependencies.executable ?? ((this.dependencies.platform ?? globalThis.process.platform) === 'win32' ? 'ssh.exe' : 'ssh'), args,
        { name: 'xterm-256color', cols: 200, rows: 40, env: { ...(this.dependencies.env ?? globalThis.process.env), LC_ALL: 'C', LANG: 'C', SSH_ASKPASS_REQUIRE: 'never' } })
    } catch { throw new Error(ERRORS['ssh-missing']) }
    let exited!: () => void
    const record: ProcessRecord = { process, subscriptions: [], exited: new Promise(resolve => { exited = resolve }), exit: false, buffer: '', promptBuffer: '', lastPrompt: '' }
    attempt.processes.push(record)
    record.subscriptions.push(process.onData(data => this.receive(attempt, record, data, supervisor)), process.onExit(() => {
      record.exit = true; exited()
      if (!attempt.closed) this.fail(attempt, new Error(ERRORS[supervisor ? 'ssh-refused' : 'forward-failed']))
    }))
    if (attempt.closed) { process.kill(); for (const subscription of record.subscriptions) subscription.dispose(); throw attempt.failure ?? new Error('The SSH connection was cancelled.') }
    return record
  }
  private receive(attempt: Attempt, record: ProcessRecord, chunk: string, supervisor: boolean): void {
    if (attempt.closed) return
    // Strip terminal control sequences before matching fixed OpenSSH prompts. Nothing is logged.
    const plain = stripVTControlCharacters(chunk).replace(/\r/gu, '')
    record.buffer = (record.buffer + plain).slice(-16_384)
    record.promptBuffer = (record.promptBuffer + plain).slice(-8192)
    let newline: number
    while ((newline = record.buffer.indexOf('\n')) !== -1) {
      const line = record.buffer.slice(0, newline); record.buffer = record.buffer.slice(newline + 1)
      const position = line.indexOf(attempt.marker)
      if (supervisor && position !== -1) {
        try { this.protocol(attempt, JSON.parse(line.slice(position + attempt.marker.length))) } catch { this.fail(attempt, new Error(ERRORS['host-start-failed'])) }
      }
    }
    if (/bind .*Address already in use|cannot listen to port|Could not request local forwarding/iu.test(record.promptBuffer)) { this.fail(attempt, new Error(ERRORS['forward-failed'])); return }
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(record.promptBuffer)) { this.fail(attempt, new Error('The SSH host key changed. Verify the host identity and update your SSH known hosts before reconnecting.')); return }
    if (/Host key verification failed|Permission denied|Connection refused|Could not resolve hostname/iu.test(record.promptBuffer)) { this.fail(attempt, new Error(ERRORS['ssh-refused'])); return }
    const kind: SshPrompt['kind'] | undefined = /Are you sure you want to continue connecting[^?]*\?\s*$/iu.test(record.promptBuffer) ? 'host-key'
      : /Enter passphrase for key[^:]*:\s*$/iu.test(record.promptBuffer) ? 'passphrase'
        : /(?:password|verification code|one.time password):\s*$/iu.test(record.promptBuffer) ? 'password' : undefined
    if (!kind || attempt.prompt || record.lastPrompt === record.promptBuffer) return
    const id = randomUUID()
    record.lastPrompt = record.promptBuffer
    attempt.prompt = { id, kind, process: record }
    const text = kind === 'host-key' ? record.promptBuffer.trim() : record.promptBuffer.trim().split('\n').at(-1) ?? 'SSH needs your answer.'
    attempt.callbacks.onPrompt?.({ id, kind, text })
  }
  private protocol(attempt: Attempt, value: unknown): void {
    if (!value || typeof value !== 'object' || !('type' in value)) throw new Error('invalid')
    if (value.type === 'starting') { this.status(attempt, 'starting'); return }
    if (value.type === 'ready') {
      const ready = readySchema.parse(value); attempt.ready = ready; attempt.resolveReady?.(ready); return
    }
    if (value.type === 'error') {
      const reason = 'reason' in value && typeof value.reason === 'string' ? value.reason : 'host-start-failed'
      this.fail(attempt, new Error(ERRORS[reason] ?? ERRORS['host-start-failed'])); return
    }
    if (value.type === 'pairing-code') {
      const code = pairingSchema.parse(value), pending = attempt.pairing
      if (pending?.id !== code.id || code.hostId !== attempt.ready?.hostId) return
      clearTimeout(pending.timer); delete attempt.pairing
      pending.resolve({ code: code.code, expiresAt: code.expiresAt, hostId: code.hostId }); return
    }
    if (value.type === 'revoked') {
      const revoked = z.object({ id: z.uuid(), hostId: z.uuid(), revoked: z.boolean() }).parse(value)
      const request = attempt.revocation
      if (!request || request.id !== revoked.id || revoked.hostId !== attempt.ready?.hostId) return
      clearTimeout(request.timer); delete attempt.revocation; request.resolve(revoked.revoked); return
    }
    const revoke = attempt.revocation
    if (value.type === 'pairing-failed' && 'id' in value && revoke && revoke.id === value.id) {
      clearTimeout(revoke.timer); revoke.reject(new Error(REVOCATION_ERROR)); delete attempt.revocation; return
    }
    const pending = attempt.pairing
    if (value.type === 'pairing-failed' && 'id' in value && pending && pending.id === value.id) {
      clearTimeout(pending.timer); pending.reject(new Error(PAIRING_ERROR)); delete attempt.pairing
    }
  }
  private pairingCode(attempt: Attempt): Promise<SshPairingCode> {
    if (attempt.closed || !attempt.connected || !attempt.supervisor) return Promise.reject(new Error('Connect to the SSH host before requesting a pairing code.'))
    if (attempt.pairing || attempt.revocation) return Promise.reject(new Error('A pairing code is already being requested.'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { delete attempt.pairing; reject(new Error(PAIRING_ERROR)) }, 12_000)
      attempt.pairing = { id, resolve, reject, timer }
      attempt.supervisor!.process.write(`${attempt.marker}${JSON.stringify({ type: 'pairing-code', id })}\r`)
    })
  }
  private revokeClient(attempt: Attempt, clientId: string): Promise<boolean> {
    if (attempt.closed || !attempt.connected || !attempt.supervisor) return Promise.reject(new Error('Connect to the SSH host before forgetting a client.'))
    if (!clientId || clientId.length > 512 || /[\p{Cc}]/u.test(clientId)) return Promise.reject(new Error('Choose a valid paired client.'))
    if (attempt.pairing || attempt.revocation) return Promise.reject(new Error('Wait for the current host request to finish.'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { delete attempt.revocation; reject(new Error(REVOCATION_ERROR)) }, 12_000)
      attempt.revocation = { id, resolve, reject, timer }
      attempt.supervisor!.process.write(`${attempt.marker}${JSON.stringify({ type: 'revoke-client', id, clientId })}\r`)
    })
  }
  private status(attempt: Attempt, status: SshConnectionStatus): void { attempt.callbacks.onStatus?.(status) }
  private fail(attempt: Attempt, error: Error): void {
    if (attempt.closed) return
    attempt.failure = error; attempt.cancel(error); attempt.rejectReady?.(error)
    if (attempt.connected) attempt.callbacks.onDisconnected?.(error.message)
    void this.closeAttempt(attempt)
  }
  private closeAttempt(attempt: Attempt): Promise<void> {
    if (attempt.closing) return attempt.closing
    attempt.closed = true
    attempt.cancel(attempt.failure ?? new Error('The SSH connection was cancelled.'))
    attempt.rejectReady?.(attempt.failure ?? new Error('The SSH connection was cancelled.'))
    if (attempt.prompt) { delete attempt.prompt; attempt.callbacks.onPrompt?.(null) }
    if (attempt.pairing) { clearTimeout(attempt.pairing.timer); attempt.pairing.reject(new Error(PAIRING_ERROR)); delete attempt.pairing }
    if (attempt.revocation) { clearTimeout(attempt.revocation.timer); attempt.revocation.reject(new Error(REVOCATION_ERROR)); delete attempt.revocation }
    attempt.closing = (async () => {
      const supervisor = attempt.supervisor
      for (const record of attempt.processes) if (record !== supervisor && !record.exit) record.process.kill()
      if (supervisor && !supervisor.exit) {
        supervisor.process.write(`${attempt.marker}${JSON.stringify({ type: 'close' })}\r`)
        await boundedWait(supervisor.exited, this.dependencies.closeTimeoutMs ?? 16000)
        if (!supervisor.exit) supervisor.process.kill()
      }
      await Promise.all(attempt.processes.map(async record => {
        if (!record.exit) await boundedWait(record.exited, 1000)
        for (const subscription of record.subscriptions) subscription.dispose()
      }))
      this.status(attempt, 'disconnected')
      if (this.attempt === attempt) this.attempt = undefined
    })()
    return attempt.closing
  }
}
