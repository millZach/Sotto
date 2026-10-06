import { stderrRateExceeded } from './stderrRate'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { findCli, withCliPath, type CliLookupOptions } from './cliLookup'

/**
 * Devin's floor: the oldest client Sotto connects (ADR-0042), and what a host's tile says an update needs
 * (ADR-0035). The reason: 3000.10.31 is the version whose ACP `session/load` replay, standard elicitation for
 * questions and the ask-before-everything profile Sotto writes for it were checked (ADR-0016, ADR-0017, ADR-0022);
 * earlier versions changed exactly those. Move it only after checking a newer one against the adapter contract.
 */
export const DEVIN_CLI_VERSION = '3000.10.31'
export const DEVIN_ACP_VERSION = 1
export class DevinUncertain extends Error {}
/** Numeric codes and our own method name are diagnostic; native error text/data are never published. */
export class DevinRejected extends Error {
  readonly code: number | undefined
  constructor(code?: number, readonly operation?: string) {
    super('Devin rejected the operation. Review the thread before retrying.')
    this.code = Number.isSafeInteger(code) ? code : undefined
  }
}
const safeEnvironment = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'programdata', 'allusersprofile', 'lang', 'lc_all', 'lc_ctype', 'tz', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir'])
export function devinEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => safeEnvironment.has(key.toLowerCase())))
}
/** Where Devin's CLI is: the shared CLI lookup (ADR-0036), then inside the Devin app. The lookup never reads native credentials. */
export async function findDevinExecutable(environment: NodeJS.ProcessEnv = process.env, lookup: Omit<CliLookupOptions, 'environment'> = {}): Promise<string | undefined> {
  const app = join('resources', 'app', 'extensions', 'windsurf', 'devin', 'bin')
  const last = (lookup.platform ?? process.platform) === 'win32'
    ? environment.LOCALAPPDATA && isAbsolute(environment.LOCALAPPDATA) ? [join(environment.LOCALAPPDATA, 'Programs', 'Devin', app)] : []
    : ['/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin', join(lookup.home ?? homedir(), 'Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin')]
  return findCli({ name: 'devin', last }, { ...lookup, environment })
}
const frameSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string().max(256), z.number().int().safe()]).optional(),
  method: z.string().min(1).max(256).optional(), params: z.unknown().optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).optional(),
}).refine(frame => frame.method !== undefined
  ? frame.result === undefined && frame.error === undefined
  : frame.id !== undefined && (Object.hasOwn(frame, 'result') !== (frame.error !== undefined)))
export type DevinFrame = z.infer<typeof frameSchema>
type Waiter = { operation: string; resolve(): void; reject(error: Error): void; apply(value: unknown): Promise<void> | void; timer: ReturnType<typeof setTimeout> | undefined }
const MAX_BYTES = 1024 * 1024
// Live tool output and session/load replay can exceed a megabyte. Match Grok and Codex's
// incoming transport guards; the adapter separately bounds transcripts and tool details.
const MAX_FRAME_BYTES = 128 * 1024 * 1024
const MAX_QUEUED_BYTES = MAX_FRAME_BYTES * 2

/** One bounded ACP process. A timeout leaves the mutation pending so late evidence is applied, never retried. */
export class DevinRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, Waiter>()
  private serial = 0
  private stopped = false
  private frames = Promise.resolve()
  readonly closed: Promise<void>
  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, private readonly timeoutMs: number,
    private readonly receive: (frame: DevinFrame) => Promise<void> | void, private readonly lost: () => void) {
    this.child = spawn(executable, args, { cwd, env: withCliPath(env, executable), windowsHide: true, shell: false, stdio: 'pipe' })
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
              if (frame.error) waiter.reject(new DevinRejected(frame.error.code, waiter.operation))
              else {
                try { await waiter.apply(frame.result); waiter.resolve() }
                catch { waiter.reject(new DevinUncertain('Devin sent an invalid response.')); this.fail() }
              }
            } else await this.receive(frame)
          } finally { queued -= size }
        }).catch(() => this.fail())
      }
    })
    // Consume without decoding, retaining or logging native stderr.
    const stderrExceeded = stderrRateExceeded()
    this.child.stderr.on('data', (chunk: Buffer) => { if (stderrExceeded(chunk.length)) this.fail() })
  }
  request(method: string, params: unknown, apply: Waiter['apply'] = () => undefined, completionOnly = false): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new DevinUncertain('Devin disconnected.')); return }
      if (this.pending.size >= 128) { reject(new DevinUncertain('Devin has too many unacknowledged requests. Reconnect before continuing.')); this.fail(); return }
      const id = ++this.serial
      const timer = completionOnly ? undefined : setTimeout(() => reject(new DevinUncertain('Devin did not acknowledge the operation in time.')), this.timeoutMs)
      this.pending.set(JSON.stringify(id), { operation: method, resolve, reject, apply, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) }
      catch { this.fail() }
    })
  }
  private encode(frame: unknown): string {
    if (this.stopped || this.child.stdin.destroyed) throw new DevinUncertain('Devin disconnected before acknowledgement.')
    let line: string
    try { line = JSON.stringify(frame) + '\n' } catch { this.fail(); throw new DevinUncertain('Devin could not receive the operation.') }
    if (Buffer.byteLength(line) + this.child.stdin.writableLength > MAX_BYTES) {
      this.fail(); throw new DevinUncertain('Devin could not receive the operation because its output queue is full.')
    }
    return line
  }
  write(frame: unknown): void { this.child.stdin.write(this.encode(frame)) }
  reply(id: string | number, result: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const line = this.encode({ jsonrpc: '2.0', id, result })
      const timer = setTimeout(() => reject(new DevinUncertain('Devin answer delivery is uncertain.')), this.timeoutMs)
      this.child.stdin.write(line, error => {
        clearTimeout(timer)
        if (error) reject(new DevinUncertain('Devin answer delivery is uncertain.'))
        else resolve()
      })
    })
  }
  close(): void {
    if (this.stopped) return
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 200); timer.unref()
    this.child.once('close', () => clearTimeout(timer))
  }
  private fail(): void {
    if (this.stopped) return
    this.stopped = true
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new DevinUncertain('Devin disconnected before acknowledgement.')) }
    this.pending.clear(); this.child.kill(); this.lost()
  }
}

/** The native --version banner, not ACP agentInfo, establishes the tested CLI build. */
export async function readDevinVersion(executable: string, argsPrefix: string[] = [], env: NodeJS.ProcessEnv = devinEnvironment()): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...argsPrefix, '--version'], { env: withCliPath(env, executable), windowsHide: true, shell: false, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 4_096, encoding: 'utf8' }, (error, stdout) => {
      if (error) { reject(new Error('Sotto could not check the installed Devin version. Reinstall Devin and reconnect.')); return }
      const match = /^devin (\d+\.\d+\.\d+)(?: \([a-f0-9]+\))?\s*$/u.exec(stdout)
      if (!match) { reject(new Error('Devin returned an unsupported version banner.')); return }
      resolve(match[1]!)
    })
  })
}
