import { stderrRateExceeded } from './stderrRate'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { z } from 'zod'
import { findCli, withCliPath, type CliLookupOptions } from './cliLookup'

/**
 * DeepSeek Harness's floor: the oldest client Sotto connects (ADR-0042, ADR-0138). 0.2.1-rc.2 is the version whose
 * ACP profile was checked live (docs/research/2026-10-24-deepseek-harness-acp-probe.md): `dsh --profile acp` with
 * `session/new`, `session/resume`, `session/close`, grouped model and `reasoning_effort` config options, sandbox
 * escalation through `session/request_permission` offering one-shot choices only, HTTP MCP mounts, committed
 * message updates and `session/cancel`. Move it only after the adapter contract and the live test pass against a
 * newer client.
 */
export const DEEPSEEK_CLI_VERSION = '0.2.1-rc.2'
export const DEEPSEEK_ACP_VERSION = 1
/** The client did not answer, or answered in a way that leaves the outcome unknown. */
export class DeepSeekUncertain extends Error {}
/** A check of the harness's own answer refused it: a verdict whose sentence the user reads. */
export class DeepSeekRefusal extends Error {}
/** The harness answered a request with a JSON-RPC error. Only the numeric code is kept; its own words are never published. */
export class DeepSeekRejected extends Error {
  readonly code: number | undefined
  constructor(code?: number) {
    super('DeepSeek Harness refused the operation. Review the thread before retrying.')
    this.code = Number.isSafeInteger(code) ? code : undefined
  }
}

/** A `dsh` version: `X.Y.Z`, with a `-name.N` prerelease such as `-rc.2` sorting before its own release. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/u
export function parseDeepSeekVersion(value: string): { release: number; name: string | undefined; pre: number } | undefined {
  const match = VERSION.exec(value.trim())
  if (!match) return undefined
  const [, major, minor, patch, name, pre] = match
  return { release: Number(major) * 1_000_000 + Number(minor) * 1_000 + Number(patch), name, pre: pre === undefined ? 0 : Number(pre) }
}
/** Negative when `a` is older. A version Sotto cannot read sorts before every one it can, so it never passes the floor. */
export function compareDeepSeekVersions(a: string, b: string): number {
  const left = parseDeepSeekVersion(a), right = parseDeepSeekVersion(b)
  if (!left || !right) return left ? 1 : right ? -1 : 0
  if (left.release !== right.release) return left.release - right.release
  // A release sorts after its prereleases, and prereleases by name first, so alpha and beta come before rc.
  if (left.name === undefined || right.name === undefined) return left.name === right.name ? 0 : left.name === undefined ? 1 : -1
  return left.name < right.name ? -1 : left.name > right.name ? 1 : left.pre - right.pre
}

const safeEnvironment = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'home', 'user', 'logname', 'username', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'programdata', 'allusersprofile', 'lang', 'lc_all', 'lc_ctype', 'tz', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir'])

/** The harness's sandbox modes, as its base profile reads them from the process environment (ADR-0138). */
export type DeepSeekSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * The environment every DeepSeek Harness process gets: the shared allow-list, so no provider's key reaches it
 * (`DEEPSEEK_API_KEY` included), Sotto's own harness folder as `DSH_HOME` (ADR-0138), the thread's sandbox mode,
 * and one placeholder key variable per model server route, which the adapter names in `keys`. A keyless server
 * ignores the value; the harness's OpenAI-compatible transport still requires one to be present.
 */
export function deepseekEnvironment(homeDirectory: string, mode: DeepSeekSandboxMode, keys: Readonly<Record<string, string>> = {}, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => safeEnvironment.has(key.toLowerCase())))
  return { ...env, ...keys, DSH_HOME: homeDirectory, DSH_PERMISSION_MODE: mode }
}

/** Where DeepSeek Harness is: `dsh` by the shared CLI lookup (ADR-0036). */
export async function findDeepSeekExecutable(environment: NodeJS.ProcessEnv = process.env, lookup: Omit<CliLookupOptions, 'environment'> = {}): Promise<string | undefined> {
  return findCli({ name: 'dsh' }, { ...lookup, environment })
}

const OUTPUT_LIMIT = 64 * 1024
/** The version `dsh --version` prints. The ACP handshake's agent version is a hardcoded `0.0.1`, so the floor reads this. */
export async function readDeepSeekVersion(executable: string, env: NodeJS.ProcessEnv, prefixArgs: readonly string[] = []): Promise<string> {
  const stdout = await new Promise<string>(resolve => {
    execFile(executable, [...prefixArgs, '--version'], { env: withCliPath(env, executable), windowsHide: true, shell: false, timeout: 30_000,
      killSignal: 'SIGKILL', maxBuffer: OUTPUT_LIMIT, encoding: 'utf8' },
    (error, out) => resolve(error ? '' : typeof out === 'string' ? out : ''))
  })
  const version = stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? ''
  if (!parseDeepSeekVersion(version)) throw new Error('Sotto could not read the installed DeepSeek Harness version. Reinstall it, then connect again.')
  return version
}

const frameSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string().max(256), z.number().int().safe()]).optional(),
  method: z.string().min(1).max(256).optional(), params: z.unknown().optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).optional(),
}).refine(frame => frame.method !== undefined
  ? frame.result === undefined && frame.error === undefined
  : frame.id !== undefined && (Object.hasOwn(frame, 'result') !== (frame.error !== undefined)))
export type DeepSeekFrame = z.infer<typeof frameSchema>
type Waiter = { resolve(): void; reject(error: Error): void; apply(value: unknown): Promise<void> | void; timer: ReturnType<typeof setTimeout> | undefined }
const MAX_WRITE_BYTES = 64 * 1024 * 1024
// A committed tool result can be large. These caps are a runaway guard, sized like the other ACP transports'.
const MAX_FRAME_BYTES = 128 * 1024 * 1024
const MAX_QUEUED_BYTES = MAX_FRAME_BYTES * 2

/** One `dsh --profile acp` process over stdio. A timeout leaves a request pending, so a late answer still applies and nothing is retried. */
export class DeepSeekRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, Waiter>()
  private serial = 0
  private stopped = false
  private frames = Promise.resolve()
  readonly closed: Promise<void>
  constructor(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, private readonly timeoutMs: number,
    private readonly receive: (frame: DeepSeekFrame) => Promise<void> | void, private readonly lost: () => void) {
    this.child = spawn(executable, [...args], { cwd, env: withCliPath(env, executable), windowsHide: true, shell: false, stdio: 'pipe' })
    this.closed = new Promise(resolve => this.child.once('close', () => { this.fail(); void this.frames.then(resolve, resolve) }))
    this.child.once('exit', () => { this.child.stdout.destroy(); this.child.stderr.destroy() })
    this.child.on('error', () => this.fail()); this.child.stdin.on('error', () => this.fail())
    let buffer = ''; let bufferedBytes = 0; let queued = 0
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      if (this.stopped) return
      buffer += chunk; bufferedBytes += Buffer.byteLength(chunk)
      if (bufferedBytes > MAX_FRAME_BYTES) { this.fail(); return }
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        const size = Buffer.byteLength(line); bufferedBytes -= size + 1
        if (!line.trim()) continue
        queued += size
        if (queued > MAX_QUEUED_BYTES) { this.fail(); return }
        this.frames = this.frames.then(async () => {
          try {
            if (this.stopped) return
            const frame = frameSchema.parse(JSON.parse(line))
            if (!frame.method && frame.id !== undefined) {
              const key = JSON.stringify(frame.id); const waiter = this.pending.get(key)
              if (!waiter) return
              clearTimeout(waiter.timer); this.pending.delete(key)
              if (frame.error) waiter.reject(new DeepSeekRejected(frame.error.code))
              else {
                try { await waiter.apply(frame.result); waiter.resolve() }
                catch (error) { waiter.reject(error instanceof DeepSeekRefusal ? error : new DeepSeekUncertain('DeepSeek Harness sent an answer Sotto could not read.')) }
              }
            } else await this.receive(frame)
          } finally { queued -= size }
        }).catch(() => this.fail())
      }
    })
    // Read and dropped: the harness's own diagnostics are never kept or logged.
    const stderrExceeded = stderrRateExceeded()
    this.child.stderr.on('data', (chunk: Buffer) => { if (stderrExceeded(chunk.length)) this.fail() })
  }
  /** The process's ID, which tells one thread's process from another's. */
  get pid(): number | undefined { return this.child.pid }
  get alive(): boolean { return !this.stopped }
  /** `timeoutMs` replaces the process's deadline for this one request, as the first one after a start takes the start's. */
  request(method: string, params: unknown, apply: Waiter['apply'] = () => undefined, completionOnly = false, timeoutMs = this.timeoutMs): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new DeepSeekUncertain('DeepSeek Harness stopped.')); return }
      if (this.pending.size >= 128) { reject(new DeepSeekUncertain('DeepSeek Harness has too many unanswered requests. Reconnect before continuing.')); this.fail(); return }
      const id = ++this.serial
      const timer = completionOnly ? undefined : setTimeout(() => reject(new DeepSeekUncertain('DeepSeek Harness did not answer in time.')), timeoutMs)
      this.pending.set(JSON.stringify(id), { resolve, reject, apply, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(JSON.stringify(id)); reject(error instanceof Error ? error : new DeepSeekUncertain('DeepSeek Harness stopped.')) }
    })
  }
  private encode(frame: unknown): string {
    if (this.stopped || this.child.stdin.destroyed) throw new DeepSeekUncertain('DeepSeek Harness stopped before it was sent anything.')
    const line = JSON.stringify(frame) + '\n'
    if (Buffer.byteLength(line) + this.child.stdin.writableLength > MAX_WRITE_BYTES) { this.fail(); throw new DeepSeekUncertain('DeepSeek Harness could not take that much at once.') }
    return line
  }
  write(frame: unknown): void { this.child.stdin.write(this.encode(frame)) }
  /** Answers one of the harness's own requests; resolves once the answer is written. */
  reply(id: string | number, result: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      let line: string
      try { line = this.encode({ jsonrpc: '2.0', id, result }) } catch (error) { reject(error); return }
      const timer = setTimeout(() => reject(new DeepSeekUncertain('DeepSeek Harness may not have received the answer.')), this.timeoutMs)
      this.child.stdin.write(line, error => { clearTimeout(timer); if (error) reject(new DeepSeekUncertain('DeepSeek Harness may not have received the answer.')); else resolve() })
    })
  }
  refuse(id: string | number, code = -32601): void {
    try { this.child.stdin.write(this.encode({ jsonrpc: '2.0', id, error: { code, message: 'Sotto does not handle this request.' } })) } catch { /* A closed pipe answers nothing. */ }
  }
  close(): void {
    if (this.stopped) return
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 500); timer.unref()
    this.child.once('close', () => clearTimeout(timer))
  }
  private fail(): void {
    if (this.stopped) return
    this.stopped = true
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new DeepSeekUncertain('DeepSeek Harness stopped before it answered.')) }
    this.pending.clear(); this.child.kill(); this.lost()
  }
}
