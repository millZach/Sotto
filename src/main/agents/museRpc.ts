import { stderrRateExceeded } from './stderrRate'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { withCliPath, type CliLookupOptions } from './cliLookup'
import { findMuseNativeExecutable } from './museClientInstall'

/**
 * Muse's floor: the oldest client Sotto connects (ADR-0042), and what a host's tile says an update needs
 * (ADR-0035). 1.1.1 is the client this adapter was checked against (ADR-0079): MSP envelope schema 1 over
 * `muse serve`, with `session/resume` serving folded history and the view stream carrying turns live.
 * Move it only after checking a newer client against the adapter contract.
 */
export const MUSE_CLI_VERSION = '1.1.1'
export const MUSE_MSP_VERSION = 1
export class MuseUncertain extends Error {}
/** The client answered, and the answer was not a shape Sotto can read. Only this one is the client's word. */
export class MuseUnreadable extends MuseUncertain {}
/** A client Sotto will not drive: an older CLI or another MSP version. */
export class MuseUnsupported extends Error {}
/** A client older than the version Sotto checked (ADR-0042), carrying the version it reported. */
export class MuseTooOld extends MuseUnsupported { constructor(message: string, readonly version: string) { super(message) } }
/**
 * The client refused a command outright. `kind` and `reason` are the wire error's own stable words, which the
 * adapter branches on (an approval-mode ceiling is `commandRejected`/`approval_mode_ceiling`); the sentence a
 * user reads is always Sotto's, never the client's message.
 */
export class MuseRejected extends Error {
  constructor(message: string, readonly kind?: string, readonly reason?: string) { super(message) }
}
const safeEnvironment = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir', 'home', 'user', 'logname', 'username', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'programdata', 'allusersprofile', 'lang', 'lc_all', 'lc_ctype', 'tz', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir', 'xdg_data_home', 'xdg_config_home', 'xdg_cache_home'])
/**
 * The environment a Muse process gets: the shared allow-list and nothing else. `META_API_KEY` is not on it, so a
 * thread always runs on the sign-in Muse itself holds (`muse login`, or credentials stored with `muse auth`),
 * never on a key that happened to be in Sotto's own environment (ADR-0079).
 */
export function museEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => safeEnvironment.has(key.toLowerCase())))
}
/** The shared lookup order, resolving maker launchers to their current native binary (ADR-0079). */
export async function findMuseExecutable(environment: NodeJS.ProcessEnv = process.env, lookup: Omit<CliLookupOptions, 'environment'> = {}): Promise<string | undefined> {
  return findMuseNativeExecutable(environment, lookup)
}
/** A UUIDv7, which every MSP command carries as its idempotency handle. Time-ordered, so retries sort after the first try. */
export function museCommandId(): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const errorSchema = z.object({ code: z.number(), message: z.string(),
  data: z.looseObject({ kind: z.string().optional(), reason: z.string().optional() }).optional() })
const frameSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: errorSchema.optional() })
export type MuseFrame = z.infer<typeof frameSchema>
type Waiter = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | undefined }

// A resume answers with a thread's whole folded history on one line, so a large line is an ordinary read of an
// ordinary thread, not a runaway client. These caps are a runaway guard, sized like the other transports'.
const MAX_FRAME_BYTES = 128 * 1024 * 1024
const MAX_QUEUED_BYTES = MAX_FRAME_BYTES * 2

/** Bounded stdio transport for one `muse serve` host. A timeout never retries: the adapter reconciles instead. */
export class MuseRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, Waiter>()
  private serial = 0
  private stopped = false
  private frames = Promise.resolve()
  readonly closed: Promise<void>
  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, private readonly timeoutMs: number,
    private readonly receive: (frame: MuseFrame) => Promise<void> | void, private readonly lost: () => void) {
    this.child = spawn(executable, args, { cwd, env: withCliPath(env, executable), windowsHide: true, shell: false, stdio: 'pipe' })
    this.closed = new Promise(resolve => this.child.once('close', () => { this.fail(); void this.frames.finally(resolve) }))
    this.child.once('exit', () => { this.child.stdout.destroy(); this.child.stderr.destroy() })
    this.child.on('error', () => this.fail()); this.child.stdin.on('error', () => this.fail())
    let buffer = ''; let bufferedBytes = 0; let queued = 0
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
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
              const key = JSON.stringify(frame.id)
              const waiter = this.pending.get(key); if (!waiter) return
              clearTimeout(waiter.timer); this.pending.delete(key)
              if (frame.error !== undefined) waiter.reject(new MuseRejected('Muse rejected the operation. Review the thread before retrying.', frame.error.data?.kind, frame.error.data?.reason))
              else waiter.resolve(frame.result)
            } else await this.receive(frame)
          } finally { queued -= size }
        }).catch(() => this.fail())
      }
    })
    const stderrExceeded = stderrRateExceeded()
    this.child.stderr.on('data', (chunk: Buffer) => { if (stderrExceeded(chunk.length)) this.fail() })
  }
  /** The client process's ID, for telling one thread's process from another's. */
  get pid(): number | undefined { return this.child.pid }
  request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new MuseUncertain('Muse disconnected.')); return }
      if (this.pending.size >= 128) { reject(new MuseUncertain('Muse has too many unacknowledged requests. Reconnect before continuing.')); this.fail(); return }
      const id = ++this.serial
      const timer = setTimeout(() => {
        this.pending.delete(JSON.stringify(id))
        reject(new MuseUncertain('Muse did not acknowledge the operation in time.'))
      }, timeoutMs)
      this.pending.set(JSON.stringify(id), { resolve, reject, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) } catch (error) { reject(error); this.fail() }
    })
  }
  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }
  write(frame: unknown): void {
    if (this.stopped || this.child.stdin.destroyed) throw new MuseUncertain('Muse disconnected before acknowledgement.')
    this.child.stdin.write(JSON.stringify(frame) + '\n')
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
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new MuseUncertain('Muse disconnected before acknowledgement.')) }
    this.pending.clear(); this.child.kill(); this.lost()
  }
}
