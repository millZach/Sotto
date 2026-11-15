import { stderrRateExceeded } from './stderrRate'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { z } from 'zod'
import { withCliPath } from './cliLookup'
import { piProgram } from './piLookup'
export { findPiExecutable } from './piLookup'

/** The oldest Pi tested through this adapter. Newer versions run, with this floor shown as the verified version. */
export const PI_CLI_VERSION = '1.5.2'
/** The client did not answer, or answered in a way that leaves the outcome unknown. */
export class PiUncertain extends Error {}
/** A check of the client's own answer refused it: a verdict whose sentence the user reads. */
export class PiRefusal extends Error {}
/** The client answered a request with a failed response. Its own words are never published. */
export class PiRejected extends Error {
  constructor() { super('Pi refused the operation. Review the thread before retrying.') }
}

/** A `pi` version: `X.Y.Z`, with a `-name.N` prerelease such as `-rc.2` sorting before its own release. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/u
export function parsePiVersion(value: string): { release: number; name: string | undefined; pre: number } | undefined {
  const match = VERSION.exec(value.trim())
  if (!match) return undefined
  const [, major, minor, patch, name, pre] = match
  return { release: Number(major) * 1_000_000 + Number(minor) * 1_000 + Number(patch), name, pre: pre === undefined ? 0 : Number(pre) }
}
/** Negative when `a` is older. A version Sotto cannot read sorts before every one it can, so it never passes the floor. */
export function comparePiVersions(a: string, b: string): number {
  const left = parsePiVersion(a), right = parsePiVersion(b)
  if (!left || !right) return left ? 1 : right ? -1 : 0
  if (left.release !== right.release) return left.release - right.release
  // A release sorts after its prereleases, and prereleases by name first, so alpha and beta come before rc.
  if (left.name === undefined || right.name === undefined) return left.name === right.name ? 0 : left.name === undefined ? 1 : -1
  return left.name < right.name ? -1 : left.name > right.name ? 1 : left.pre - right.pre
}

const safeEnvironment = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'home', 'user', 'logname', 'username', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'programdata', 'allusersprofile', 'lang', 'lc_all', 'lc_ctype', 'tz', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir'])

/** Only ordinary process settings and this thread's explicit tool-server values reach Pi. */
export function piEnvironment(homeDirectory: string, keys: Readonly<Record<string, string>> = {}, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => safeEnvironment.has(key.toLowerCase())))
  return { ...env, ...keys, PI_CODING_AGENT_DIR: homeDirectory, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_OFFLINE: '1' }
}

const OUTPUT_LIMIT = 64 * 1024
/** Read the installed client without loading a project or the user’s Pi folder. */
export async function readPiVersion(executable: string, env: NodeJS.ProcessEnv, prefixArgs: readonly string[] = []): Promise<string> {
  const program = await piProgram(executable, env)
  const stdout = await new Promise<string>(resolve => {
    execFile(program.executable, [...program.args, ...prefixArgs, '--version'], { env: program.env, windowsHide: true, shell: false, timeout: 30_000,
      killSignal: 'SIGKILL', maxBuffer: OUTPUT_LIMIT, encoding: 'utf8' },
    (error, out) => resolve(error ? '' : typeof out === 'string' ? out : ''))
  })
  const version = stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? ''
  if (!parsePiVersion(version)) throw new Error('Sotto could not read the installed Pi version. Run Pi in a terminal to check it, then connect again. Your threads are kept.')
  return version
}

const frameSchema = z.looseObject({ type: z.string().min(1).max(128), id: z.string().max(256).optional() })
const responseSchema = z.object({ type: z.literal('response'), id: z.string(), command: z.string(), success: z.boolean(), data: z.unknown().optional() })
export type PiFrame = z.infer<typeof frameSchema>
type Waiter = { command: string; resolve(): void; reject(error: Error): void; apply(value: unknown): Promise<void> | void; timer: ReturnType<typeof setTimeout> | undefined }
const MAX_WRITE_BYTES = 64 * 1024 * 1024
// A committed tool result can be large. These caps are a runaway guard, sized like the other ACP transports'.
const MAX_FRAME_BYTES = 128 * 1024 * 1024
const MAX_QUEUED_BYTES = MAX_FRAME_BYTES * 2

/** One `pi --mode rpc` process over stdio. A timeout leaves a request pending, so a late answer still applies and nothing is retried. */
export class PiRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, Waiter>()
  private serial = 0
  private stopped = false
  private frames = Promise.resolve()
  readonly closed: Promise<void>
  constructor(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, private readonly timeoutMs: number,
    private readonly receive: (frame: PiFrame) => Promise<void> | void, private readonly lost: () => void) {
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
            if (frame.type === 'response' && frame.id !== undefined) {
              const response = responseSchema.parse(frame)
              const key = frame.id; const waiter = this.pending.get(key)
              if (!waiter) return
              if (response.command !== waiter.command) { this.fail(); return }
              clearTimeout(waiter.timer); this.pending.delete(key)
              if (!response.success) waiter.reject(new PiRejected())
              else {
                try { await waiter.apply(response.data); waiter.resolve() }
                catch (error) { waiter.reject(error instanceof PiRefusal ? error : new PiUncertain('Pi sent an answer Sotto could not read.')) }
              }
            } else await this.receive(frame)
          } finally { queued -= size }
        }).catch(() => this.fail())
      }
    })
    // Read and dropped: the client's own diagnostics are never kept or logged.
    const stderrExceeded = stderrRateExceeded()
    this.child.stderr.on('data', (chunk: Buffer) => { if (stderrExceeded(chunk.length)) this.fail() })
  }
  /** The process's ID, which tells one thread's process from another's. */
  get pid(): number | undefined { return this.child.pid }
  get alive(): boolean { return !this.stopped }
  /** `timeoutMs` replaces the process's deadline for this one request, as the first one after a start takes the start's. */
  request(method: string, params: unknown, apply: Waiter['apply'] = () => undefined, completionOnly = false, timeoutMs = this.timeoutMs): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new PiUncertain('Pi stopped.')); return }
      if (this.pending.size >= 128) { reject(new PiUncertain('Pi has too many unanswered requests. Reconnect before continuing.')); this.fail(); return }
      const id = String(++this.serial)
      const timer = completionOnly ? undefined : setTimeout(() => reject(new PiUncertain('Pi did not answer in time.')), timeoutMs)
      this.pending.set(id, { command: method, resolve, reject, apply, timer })
      try { this.write({ ...params as Record<string, unknown>, type: method, id }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new PiUncertain('Pi stopped.')) }
    })
  }
  private encode(frame: unknown): string {
    if (this.stopped || this.child.stdin.destroyed) throw new PiUncertain('Pi stopped before it was sent anything.')
    const line = JSON.stringify(frame) + '\n'
    if (Buffer.byteLength(line) + this.child.stdin.writableLength > MAX_WRITE_BYTES) { this.fail(); throw new PiUncertain('Pi could not take that much at once.') }
    return line
  }
  write(frame: unknown): void { this.child.stdin.write(this.encode(frame)) }
  close(): void {
    if (this.stopped) return
    this.child.stdin.end()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5_000); timer.unref()
    this.child.once('close', () => clearTimeout(timer))
  }
  private fail(): void {
    if (this.stopped) return
    this.stopped = true
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new PiUncertain('Pi stopped before it answered.')) }
    this.pending.clear(); this.child.kill(); this.lost()
  }
}
