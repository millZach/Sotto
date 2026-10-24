import { stderrRateExceeded } from './stderrRate'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, constants, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { findCli, withCliPath, type CliLookupOptions } from './cliLookup'

/**
 * Cursor's floor: the oldest client Sotto connects (ADR-0042, ADR-0127). 2026.10.22-27dcf5f is the version whose ACP
 * agent was checked live: the parameterized model picker, `cursor/list_available_models`, `session/set_config_option`
 * for the model and its effort, `session/load` replaying a whole conversation, `cursor/ask_question` and
 * `cursor/create_plan` as client methods, and `CURSOR_CONFIG_DIR` moving the whole config folder. Move it only after
 * the adapter contract and the live test pass against a newer client.
 */
export const CURSOR_CLI_VERSION = '2026.10.22-27dcf5f'
export const CURSOR_ACP_VERSION = 1
/** The client did not answer, or answered in a way that leaves the outcome unknown. */
export class CursorUncertain extends Error {}
/** A check of Cursor's own answer refused it: a verdict whose sentence the user reads. */
export class CursorRefusal extends Error {}
/** Cursor answered a request with a JSON-RPC error. Only the numeric code is kept; Cursor's own words are never published. */
export class CursorRejected extends Error {
  readonly code: number | undefined
  constructor(code?: number) {
    super('Cursor refused the operation. Review the thread before retrying.')
    this.code = Number.isSafeInteger(code) ? code : undefined
  }
}

/**
 * A Cursor version: `YYYY.MM.DD-<commit>`, or `YYYY.MM.DD-HH-MM-SS-<commit>` from builds that add the time between the
 * date and the commit. Undefined for anything else, which is never compared.
 */
export interface CursorVersion { readonly date: number; readonly time: number; readonly commit: string }
const VERSION = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-([a-f0-9]+)$/u
export function parseCursorVersion(value: string): CursorVersion | undefined {
  const match = VERSION.exec(value.trim())
  if (!match) return undefined
  const [, year, month, day, hours, minutes, seconds, commit] = match
  return { date: Number(year) * 10_000 + Number(month) * 100 + Number(day),
    time: hours === undefined ? 0 : Number(hours) * 10_000 + Number(minutes) * 100 + Number(seconds), commit: commit! }
}
/**
 * Compare two Cursor versions by day, then by the time a newer build adds. The commit decides nothing: two builds of
 * the same moment are the same age. A version Sotto cannot read sorts before every one it can, so it is never newest
 * and never passes the floor. Negative when `a` is older.
 */
export function compareCursorVersions(a: string, b: string): number {
  const left = parseCursorVersion(a), right = parseCursorVersion(b)
  if (!left || !right) return left ? 1 : right ? -1 : 0
  return left.date - right.date || left.time - right.time
}

const safeEnvironment = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'home', 'user', 'logname', 'username', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'programdata', 'allusersprofile', 'lang', 'lc_all', 'lc_ctype', 'tz', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir', 'xdg_data_home', 'xdg_config_home', 'xdg_cache_home'])
/**
 * The environment every Cursor process gets: the shared allow-list, so no other provider's key and no Cursor key
 * (`CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`) reaches it, Sotto's own Cursor folder (ADR-0127), so nothing a thread does
 * changes the user's own Cursor, and `NO_OPEN_BROWSER`, so a sign-in prints its page instead of opening one.
 * `CURSOR_INVOKED_AS` is what Cursor's own launchers set.
 */
export function cursorEnvironment(configDirectory: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => safeEnvironment.has(key.toLowerCase())))
  return { ...env, CURSOR_CONFIG_DIR: configDirectory, CURSOR_INVOKED_AS: 'agent', NO_OPEN_BROWSER: '1' }
}

/**
 * How a Cursor process is started: the program and the arguments before Cursor's own. On Windows that is the newest
 * version folder's own `node.exe` running its `index.js`, with no shell between; elsewhere `agent`, followed to its
 * version folder so a process keeps the version it started from.
 */
export interface CursorProgram { readonly executable: string; readonly args: readonly string[] }

/** Where Cursor's installer keeps its version folders on this platform. */
export function cursorInstallRoot(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string | undefined {
  if (platform === 'win32') return environment.LOCALAPPDATA && isAbsolute(environment.LOCALAPPDATA) ? join(environment.LOCALAPPDATA, 'cursor-agent') : undefined
  return join(home, '.local', 'share', 'cursor-agent')
}

/** The newest version folder that holds a program, the way Cursor's own launcher picks it; staged and old trees are passed over. */
export async function newestCursorVersion(versions: string): Promise<string | undefined> {
  const names = await readdir(versions).catch(() => [] as string[])
  return names.filter(name => parseCursorVersion(name)).sort((a, b) => compareCursorVersions(b, a))[0]
}

/**
 * Cursor's program on this computer (ADR-0127): on Windows, the newest version folder's `node.exe` and `index.js`;
 * elsewhere `agent` by the shared CLI lookup (ADR-0036) with `~/.local/bin` first, followed to its real file.
 */
export async function findCursorProgram(environment: NodeJS.ProcessEnv = process.env, lookup: Omit<CliLookupOptions, 'environment'> = {}): Promise<CursorProgram | undefined> {
  const platform = lookup.platform ?? process.platform
  if (platform === 'win32') {
    const root = cursorInstallRoot(environment, platform)
    if (!root) return undefined
    const version = await newestCursorVersion(join(root, 'versions'))
    if (!version) return undefined
    const folder = join(root, 'versions', version), node = join(folder, 'node.exe'), index = join(folder, 'index.js')
    try { await access(node, constants.F_OK); await access(index, constants.F_OK) } catch { return undefined }
    return { executable: node, args: [index] }
  }
  const found = await findCli({ name: 'agent', first: [join(lookup.home ?? homedir(), '.local', 'bin')] }, { ...lookup, environment })
  if (!found) return undefined
  return { executable: await realpath(found).catch(() => found), args: [] }
}
/** Cursor's program as one path, for the checks that need only that: its `node.exe` on Windows, its `agent` elsewhere. */
export async function findCursorExecutable(environment: NodeJS.ProcessEnv = process.env, lookup: Omit<CliLookupOptions, 'environment'> = {}): Promise<string | undefined> {
  return (await findCursorProgram(environment, lookup))?.executable
}
/** The program a path names: Cursor's `node.exe` runs the `index.js` beside it; anything else runs as it is. */
export function cursorProgramOf(executable: string): CursorProgram {
  return /^node(?:\.exe)?$/iu.test(basename(executable)) ? { executable, args: [join(dirname(executable), 'index.js')] } : { executable, args: [] }
}

const OUTPUT_LIMIT = 64 * 1024
function run(program: CursorProgram, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number, cwd?: string): Promise<{ ok: boolean; stdout: string }> {
  return new Promise(resolve => {
    execFile(program.executable, [...program.args, ...args], { env: withCliPath(env, program.executable), windowsHide: true, shell: false, timeout: timeoutMs,
      killSignal: 'SIGKILL', maxBuffer: OUTPUT_LIMIT, encoding: 'utf8', ...(cwd ? { cwd } : {}) },
    (error, stdout) => resolve({ ok: !error, stdout: typeof stdout === 'string' ? stdout : '' }))
  })
}
/** The version Cursor prints for `--version`, which is its version folder's name. */
export async function readCursorVersion(program: CursorProgram, env: NodeJS.ProcessEnv): Promise<string> {
  const { ok, stdout } = await run(program, ['--version'], env, 30_000)
  const version = stdout.trim().split(/\r?\n/u).at(-1)?.trim() ?? ''
  if (!ok || !parseCursorVersion(version)) throw new Error('Sotto could not read the installed Cursor version. Reinstall Cursor’s CLI, then connect again.')
  return version
}
const statusSchema = z.object({ status: z.string().optional(), isAuthenticated: z.boolean().optional() }).passthrough()
/**
 * Whether Cursor is signed in on this computer, from `agent status --format json`. Only the verdict is read: the
 * account's name and email in the same answer are never kept. Cursor asks its servers, which takes a few seconds.
 */
export async function readCursorSignIn(program: CursorProgram, env: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<'signed-in' | 'signed-out' | 'unknown'> {
  const { stdout } = await run(program, ['status', '--format', 'json'], env, timeoutMs)
  try {
    const status = statusSchema.parse(JSON.parse(stdout.slice(stdout.indexOf('{'))))
    if (status.isAuthenticated === true || status.status === 'authenticated') return 'signed-in'
    if (status.isAuthenticated === false || status.status === 'unauthenticated') return 'signed-out'
  } catch { /* Anything else says nothing about the sign-in. */ }
  return 'unknown'
}

/**
 * Sotto's rules in its Cursor folder (ADR-0127), written before every Cursor process starts: Sotto's own tool servers
 * allowed by name and nothing denied, Cursor's allowlist mode, and no vim keys. Everything else Cursor keeps in the
 * file is Cursor's and stays as it was, except a rule a past answer saved, which Sotto never gives. One folder serves
 * every thread, so the rules name every Sotto server; a thread can still reach only the servers it was given.
 */
export async function writeCursorConfig(configDirectory: string, servers: readonly string[]): Promise<void> {
  await mkdir(configDirectory, { recursive: true })
  const path = join(configDirectory, 'cli-config.json')
  let current: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>
  } catch { /* A missing or unreadable file is written afresh. */ }
  const editor = current.editor && typeof current.editor === 'object' && !Array.isArray(current.editor) ? current.editor as Record<string, unknown> : {}
  const next = { ...current, version: 1, editor: { ...editor, vimMode: false },
    permissions: { allow: [...new Set(servers)].sort().map(name => `Mcp(${name}:*)`), deny: [] }, approvalMode: 'allowlist' }
  const text = JSON.stringify(next, null, 2) + '\n'
  if (JSON.stringify(current, null, 2) + '\n' === text) return
  // Written beside and moved into place, so a Cursor process starting meanwhile never reads half a file.
  const staged = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(staged, text, 'utf8')
  try { await rename(staged, path) }
  catch {
    // Windows refuses the move while another process holds the file; the rules are written in place instead.
    await rm(staged, { force: true }).catch(() => undefined)
    await writeFile(path, text, 'utf8')
  }
}

const frameSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string().max(256), z.number().int().safe()]).optional(),
  method: z.string().min(1).max(256).optional(), params: z.unknown().optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).optional(),
}).refine(frame => frame.method !== undefined
  ? frame.result === undefined && frame.error === undefined
  : frame.id !== undefined && (Object.hasOwn(frame, 'result') !== (frame.error !== undefined)))
export type CursorFrame = z.infer<typeof frameSchema>
type Waiter = { resolve(): void; reject(error: Error): void; apply(value: unknown): Promise<void> | void; timer: ReturnType<typeof setTimeout> | undefined }
const MAX_WRITE_BYTES = 64 * 1024 * 1024
// A `session/load` replays a whole conversation, one message per frame, and a tool's output can be large. These caps
// are a runaway guard, sized like the Grok and Devin transports'.
const MAX_FRAME_BYTES = 128 * 1024 * 1024
const MAX_QUEUED_BYTES = MAX_FRAME_BYTES * 2

/** One Cursor `agent acp` process over stdio. A timeout leaves a request pending, so a late answer still applies and nothing is retried. */
export class CursorRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, Waiter>()
  private serial = 0
  private stopped = false
  private frames = Promise.resolve()
  readonly closed: Promise<void>
  constructor(program: CursorProgram, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, private readonly timeoutMs: number,
    private readonly receive: (frame: CursorFrame) => Promise<void> | void, private readonly lost: () => void) {
    this.child = spawn(program.executable, [...program.args, ...args], { cwd, env: withCliPath(env, program.executable), windowsHide: true, shell: false, stdio: 'pipe' })
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
              if (frame.error) waiter.reject(new CursorRejected(frame.error.code))
              else {
                try { await waiter.apply(frame.result); waiter.resolve() }
                catch (error) { waiter.reject(error instanceof CursorRefusal ? error : new CursorUncertain('Cursor sent an answer Sotto could not read.')) }
              }
            } else await this.receive(frame)
          } finally { queued -= size }
        }).catch(() => this.fail())
      }
    })
    // Read and dropped: Cursor's own diagnostics are never kept or logged.
    const stderrExceeded = stderrRateExceeded()
    this.child.stderr.on('data', (chunk: Buffer) => { if (stderrExceeded(chunk.length)) this.fail() })
  }
  /** The process's ID, which tells one thread's process from another's. */
  get pid(): number | undefined { return this.child.pid }
  get alive(): boolean { return !this.stopped }
  /** `timeoutMs` replaces the process's deadline for this one request, as the first one after a start takes the start's. */
  request(method: string, params: unknown, apply: Waiter['apply'] = () => undefined, completionOnly = false, timeoutMs = this.timeoutMs): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new CursorUncertain('Cursor stopped.')); return }
      if (this.pending.size >= 128) { reject(new CursorUncertain('Cursor has too many unanswered requests. Reconnect before continuing.')); this.fail(); return }
      const id = ++this.serial
      const timer = completionOnly ? undefined : setTimeout(() => reject(new CursorUncertain('Cursor did not answer in time.')), timeoutMs)
      this.pending.set(JSON.stringify(id), { resolve, reject, apply, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(JSON.stringify(id)); reject(error instanceof Error ? error : new CursorUncertain('Cursor stopped.')) }
    })
  }
  private encode(frame: unknown): string {
    if (this.stopped || this.child.stdin.destroyed) throw new CursorUncertain('Cursor stopped before it was sent anything.')
    const line = JSON.stringify(frame) + '\n'
    if (Buffer.byteLength(line) + this.child.stdin.writableLength > MAX_WRITE_BYTES) { this.fail(); throw new CursorUncertain('Cursor could not take that much at once.') }
    return line
  }
  write(frame: unknown): void { this.child.stdin.write(this.encode(frame)) }
  /** Answers one of Cursor's own requests; resolves once the answer is written. */
  reply(id: string | number, result: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      let line: string
      try { line = this.encode({ jsonrpc: '2.0', id, result }) } catch (error) { reject(error); return }
      const timer = setTimeout(() => reject(new CursorUncertain('Cursor may not have received the answer.')), this.timeoutMs)
      this.child.stdin.write(line, error => { clearTimeout(timer); if (error) reject(new CursorUncertain('Cursor may not have received the answer.')); else resolve() })
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
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new CursorUncertain('Cursor stopped before it answered.')) }
    this.pending.clear(); this.child.kill(); this.lost()
  }
}

/**
 * The newest version Cursor's install script downloads, which it names in its download address (ADR-0127): the one
 * place Cursor says what it has published.
 */
export function cursorPublishedVersion(script: string): string | undefined {
  const match = /downloads\.cursor\.com\/lab\/([0-9.]+(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+)\//u.exec(script)
  return match && parseCursorVersion(match[1]!) ? match[1] : undefined
}
