import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { retryWindowsFileOperation } from '../storage/windowsFileRetry'
import { ANTIGRAVITY_APP_DATA, type AntigravityFolders } from './antigravityFolders'
import { withCliPath } from './cliLookup'
import { ANTIGRAVITY_SIGN_IN_METHODS, type AntigravitySignInMethod } from '../../shared/antigravity'
export { ANTIGRAVITY_SIGN_IN_METHODS, type AntigravitySignInMethod }
import { stderrRateExceeded } from './stderrRate'

/** Antigravity's `agy acp` over stdio, as T3 Code drives it (the research note, "Launch" and "The protocol"). */
export { ANTIGRAVITY_CLI_FLOOR, compareAntigravityVersions, meetsAntigravityFloor } from './antigravityRelease'
export const ANTIGRAVITY_ACP_VERSION = 1

/** The client did not answer, or answered in a way that leaves the outcome unknown. */
export class AntigravityUncertain extends Error {}
/** Antigravity answered a request with a JSON-RPC error. Only the numeric code is kept; its own words are never published. */
export class AntigravityRejected extends Error {
  readonly code: number | undefined
  /** Whether the error says no one is signed in: `-32000`, or 1.5's `-32603` when it has no sign-in and no browser. */
  readonly signInRequired: boolean
  constructor(code?: number, message?: string) {
    super('Antigravity refused the operation. Review the thread before retrying.')
    this.code = Number.isSafeInteger(code) ? code : undefined
    this.signInRequired = code === -32000 || (code === -32603 && typeof message === 'string' && message.startsWith('No browser is available here'))
  }
}

/** A version `agy --version` prints: `major.minor.patch`. */
const VERSION = /^\d+\.\d+\.\d+$/u

/**
 * The sign-in a process starts with. The key is held in main only, from the credential store, and goes to `agy` in its
 * environment, never in a file, a log or an argument. Project and location are written to `agy`'s own settings.
 */
export interface AntigravitySignIn {
  readonly method: AntigravitySignInMethod
  readonly apiKey?: string | undefined
  readonly project?: string | undefined
  readonly location?: string | undefined
}
export const GOOGLE_ACCOUNT: AntigravitySignIn = { method: 'oauth-personal' }

/** What a sign-in still needs before `agy` can use it, in T3's words, or undefined when it has what it needs. */
export function antigravitySignInIssue(signIn: AntigravitySignIn): string | undefined {
  switch (signIn.method) {
    case 'oauth-personal': return undefined
    case 'oauth-business': return signIn.project && signIn.location ? undefined : 'Gemini Enterprise needs a Google Cloud project and location. Add them in Antigravity’s row in Settings › Providers.'
    case 'gemini-api-key': return signIn.apiKey ? undefined : 'Add a Gemini API key in Antigravity’s row in Settings › Providers.'
    case 'agent-platform': return signIn.apiKey || (signIn.project && signIn.location) ? undefined
      : 'Agent Platform needs an API key, or a Google Cloud project and location. Add them in Antigravity’s row in Settings › Providers.'
  }
}

const safeEnvironment = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'home', 'user', 'logname', 'username', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'programdata', 'allusersprofile', 'lang', 'lc_all', 'lc_ctype', 'tz', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir', 'xdg_data_home', 'xdg_config_home', 'xdg_cache_home'])
/**
 * The environment every `agy` process gets: the shared allow-list, so no other provider's key and no Google credential
 * of the user's (`GEMINI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, project variables) reaches it, and then T3's:
 * Sotto's own Gemini folder, file storage, no self-update, and for a Google account the SSH marker that makes 1.5 keep
 * the sign-in in that folder rather than the system keyring. Temporary files go under Sotto's own folder, since each
 * launch unpacks about a gigabyte. `BROWSER` is left unset, so a sign-in prints its page and opens nothing.
 */
export function antigravityEnvironment(folders: AntigravityFolders, signIn: AntigravitySignIn, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => safeEnvironment.has(key.toLowerCase())))
  const temporary = join(folders.root, 'tmp')
  const credential = signIn.method === 'gemini-api-key' && signIn.apiKey ? { GEMINI_API_KEY: signIn.apiKey }
    : signIn.method === 'agent-platform' && signIn.apiKey ? { GOOGLE_API_KEY: signIn.apiKey } : {}
  const ssh = Object.entries(environment).find(([key]) => key.toUpperCase() === 'SSH_CONNECTION')?.[1]
  return { ...env, ...credential,
    ...(signIn.method === 'oauth-personal' ? { SSH_CONNECTION: ssh || '127.0.0.1 0 127.0.0.1 0' } : {}),
    GEMINI_HOME: folders.gemini, AGY_ACP_FORCE_FILE_STORAGE: '1', AGY_CLI_DISABLE_AUTO_UPDATE: '1', PYTHONUNBUFFERED: '1',
    ...(platform === 'win32' ? { TEMP: temporary, TMP: temporary } : { TMPDIR: temporary }) }
}

/** The arguments every `agy acp` gets: Sotto's Gemini folder and its app data name (relative, as `agy` requires). */
export function antigravityArguments(folders: AntigravityFolders, extra: readonly string[] = []): string[] {
  return ['acp', '--gemini-dir', folders.gemini, '--app-data-dir', ANTIGRAVITY_APP_DATA, ...extra]
}

const settingsWrites = new Map<string, Promise<void>>()

/**
 * `agy`'s own settings in Sotto's app data folder, written before each start as T3 writes them: the sign-in method and,
 * where it has them, the Google Cloud project and location. Never a credential. Everything else `agy` keeps there,
 * such as permission rules a past answer saved, stays as it was.
 *
 * Writes for the same profile serialize behind each other, stage to a unique synced temp file and replace atomically
 * with Windows lock retries so overlapping thread or sign-in starts never lose updates or leave a half-written file.
 */
export async function writeAntigravitySettings(folders: AntigravityFolders, signIn: AntigravitySignIn): Promise<void> {
  const path = join(folders.appData, 'settings.json')
  const key = resolve(path)
  const previous = settingsWrites.get(key) ?? Promise.resolve()
  const run = previous.then(() => writeAntigravitySettingsOnce(folders, path, signIn))
  const tail = run.catch(() => undefined)
  settingsWrites.set(key, tail)
  try {
    await run
  } finally {
    if (settingsWrites.get(key) === tail) settingsWrites.delete(key)
  }
}

async function writeAntigravitySettingsOnce(folders: AntigravityFolders, path: string, signIn: AntigravitySignIn): Promise<void> {
  await mkdir(folders.appData, { recursive: true })
  await mkdir(join(folders.root, 'tmp'), { recursive: true })
  let current: Record<string, unknown> = {}
  let raw: string | undefined
  try {
    raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>
  } catch { /* A missing or unreadable file is written afresh. */ }
  const gcp = { ...(signIn.project ? { project: signIn.project } : {}), ...(signIn.location ? { location: signIn.location } : {}) }
  const { gcp: _previous, ...rest } = current
  void _previous
  const next = { ...rest, auth: { type: signIn.method }, ...(Object.keys(gcp).length ? { gcp } : {}) }
  const text = JSON.stringify(next, null, 2) + '\n'
  if (raw !== undefined && (raw === text || JSON.stringify(current, null, 2) + '\n' === text)) return
  const staged = `${path}.${process.pid}.${randomUUID()}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(staged, 'wx', 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await retryWindowsFileOperation(() => rename(staged, path))
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined)
    await rm(staged, { force: true }).catch(() => undefined)
    throw error
  }
}

const frameSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string().max(256), z.number().int().safe()]).optional(),
  method: z.string().min(1).max(256).optional(), params: z.unknown().optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).optional(),
}).refine(frame => frame.method !== undefined
  ? frame.result === undefined && frame.error === undefined
  : frame.id !== undefined && (Object.hasOwn(frame, 'result') !== (frame.error !== undefined)))
export type AntigravityFrame = z.infer<typeof frameSchema>
type Waiter = { resolve(): void; reject(error: Error): void; apply(value: unknown): Promise<void> | void; timer: ReturnType<typeof setTimeout> | undefined }
const MAX_WRITE_BYTES = 64 * 1024 * 1024
// A tool's output can be large. These caps are a runaway guard, sized like the other ACP transports'.
const MAX_FRAME_BYTES = 128 * 1024 * 1024
const MAX_QUEUED_BYTES = MAX_FRAME_BYTES * 2

/** One `agy acp` process over stdio. A timeout leaves a request pending, so a late answer still applies and nothing is retried. */
export class AntigravityRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, Waiter>()
  private serial = 0
  private stopped = false
  private frames = Promise.resolve()
  readonly closed: Promise<void>
  constructor(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, private readonly timeoutMs: number,
    private readonly receive: (frame: AntigravityFrame) => Promise<void> | void, private readonly lost: () => void) {
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
        // `agy` can print a line of its own before its first frame; only JSON is read.
        if (!line.trim().startsWith('{')) continue
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
              if (frame.error) waiter.reject(new AntigravityRejected(frame.error.code, frame.error.message))
              else {
                try { await waiter.apply(frame.result); waiter.resolve() }
                catch { waiter.reject(new AntigravityUncertain('Antigravity sent an answer Sotto could not read.')) }
              }
            } else await this.receive(frame)
          } finally { queued -= size }
        }).catch(() => this.fail())
      }
    })
    // Read and dropped: Antigravity's own diagnostics are never kept or logged.
    const stderrExceeded = stderrRateExceeded()
    this.child.stderr.on('data', (chunk: Buffer) => { if (stderrExceeded(chunk.length)) this.fail() })
  }
  /** The process's ID, which tells one thread's process from another's. */
  get pid(): number | undefined { return this.child.pid }
  get alive(): boolean { return !this.stopped }
  /** `timeoutMs` replaces the process's deadline for this one request, as the first one after a start takes the start's. */
  request(method: string, params: unknown, apply: Waiter['apply'] = () => undefined, completionOnly = false, timeoutMs = this.timeoutMs): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new AntigravityUncertain('Antigravity stopped.')); return }
      if (this.pending.size >= 128) { reject(new AntigravityUncertain('Antigravity has too many unanswered requests. Reconnect before continuing.')); this.fail(); return }
      const id = ++this.serial
      const timer = completionOnly ? undefined : setTimeout(() => reject(new AntigravityUncertain('Antigravity did not answer in time.')), timeoutMs)
      this.pending.set(JSON.stringify(id), { resolve, reject, apply, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(JSON.stringify(id)); reject(error instanceof Error ? error : new AntigravityUncertain('Antigravity stopped.')) }
    })
  }
  private encode(frame: unknown): string {
    if (this.stopped || this.child.stdin.destroyed) throw new AntigravityUncertain('Antigravity stopped before it was sent anything.')
    const line = JSON.stringify(frame) + '\n'
    if (Buffer.byteLength(line) + this.child.stdin.writableLength > MAX_WRITE_BYTES) { this.fail(); throw new AntigravityUncertain('Antigravity could not take that much at once.') }
    return line
  }
  write(frame: unknown): void { this.child.stdin.write(this.encode(frame)) }
  /** Answers one of Antigravity's own requests; resolves once the answer is written. */
  reply(id: string | number, result: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      let line: string
      try { line = this.encode({ jsonrpc: '2.0', id, result }) } catch (error) { reject(error); return }
      const timer = setTimeout(() => reject(new AntigravityUncertain('Antigravity may not have received the answer.')), this.timeoutMs)
      this.child.stdin.write(line, error => { clearTimeout(timer); if (error) reject(new AntigravityUncertain('Antigravity may not have received the answer.')); else resolve() })
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
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new AntigravityUncertain('Antigravity stopped before it answered.')) }
    this.pending.clear(); this.child.kill(); this.lost()
  }
}

/** The version `agy --version` prints, or undefined when it prints none Sotto can read. */
export function readAntigravityVersion(executable: string, prefix: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(executable, [...prefix, '--version'], { env: withCliPath(env, executable), windowsHide: true, shell: false, timeout: timeoutMs, killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
      const version = (typeof stdout === 'string' ? stdout : '').trim().split(/\r?\n/u).at(-1)?.trim()
      resolve(!error && version && VERSION.test(version) ? version : undefined)
    })
  })
}
