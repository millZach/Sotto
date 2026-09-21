import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, constants, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { z } from 'zod'

export const GROK_CLI_VERSION = '1.0.5'
export const GROK_ACP_VERSION = 1
export class GrokUncertain extends Error {}
/**
 * The client answered, and the answer was not one Sotto can use: a version or a protocol it refuses, or
 * a shape it does not know. Separate from a lost connection, because only this one is the client's word.
 */
export class GrokUnreadable extends GrokUncertain {}
/** A client Sotto will not drive: an older CLI, another protocol version, or no subscription sign-in. */
export class GrokUnsupported extends Error {}
export class GrokRejected extends Error {}
const safeEnvironment = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'lang', 'lc_all', 'lc_ctype', 'tz', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir'])
export function grokEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => safeEnvironment.has(key.toLowerCase())))
  for (const key of ['GROK_HOME', 'GROK_AUTH_PATH']) if (environment[key] && isAbsolute(environment[key]!)) env[key] = environment[key]
  return { ...env, GROK_DISABLE_API_KEY_AUTH: '1', GROK_DISABLE_AUTOUPDATER: '1', GROK_DEFAULT_SELECTED_PERMISSION: 'reject', GROK_REMEMBER_TOOL_APPROVALS: '0' }
}
export async function findGrokExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const name = process.platform === 'win32' ? 'grok.exe' : 'grok'
  const home = environment.GROK_HOME && isAbsolute(environment.GROK_HOME) ? environment.GROK_HOME : join(homedir(), '.grok')
  for (const candidate of new Set([join(home, 'bin', name), ...(environment.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, name))])) {
    try { if ((await stat(candidate)).isFile()) { await access(candidate, constants.X_OK); return candidate } } catch { /* Native executables only. */ }
  }
  return undefined
}
const frameSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional() })
export type GrokFrame = z.infer<typeof frameSchema>
type Waiter = { resolve(): void; reject(error: Error): void; apply(value: unknown): Promise<void> | void; timer: ReturnType<typeof setTimeout> | undefined }

// A Grok response is one line, and `_x.ai/session/updates` answers with a whole page of durable history
// on it: 100 entries carrying whatever that session's tools printed. One real project thread measured
// 1.5 MB, 2.6 MB, 1.6 MB and 0.5 MB across its four pages, so a line over a megabyte is not a runaway
// client, it is an ordinary read of an ordinary thread. Capping it there refused every connection that
// loaded such a thread. These caps are a runaway guard, sized like the Codex transport's.
const MAX_FRAME_BYTES = 128 * 1024 * 1024
const MAX_QUEUED_BYTES = MAX_FRAME_BYTES * 2
/** Diagnostics, not protocol: a client that answers nothing and only floods stderr is still lost. */
const MAX_STDERR_BYTES = 1024 * 1024

/** Bounded stdio transport. Late responses still apply; mutation timeouts never trigger retries. */
export class GrokRpc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, Waiter>()
  private serial = 0
  private stopped = false
  private frames = Promise.resolve()
  readonly closed: Promise<void>
  constructor(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, private readonly timeoutMs: number,
    private readonly receive: (frame: GrokFrame) => Promise<void> | void, private readonly lost: () => void) {
    this.child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: 'pipe' })
    this.closed = new Promise(resolve => this.child.once('close', () => { this.fail(); void this.frames.finally(resolve) }))
    // A Windows leader can inherit its short-lived proxy's output handles. Once the proxy
    // exits those inherited handles must not keep the adapter's shutdown barrier open.
    this.child.once('exit', () => { this.child.stdout.destroy(); this.child.stderr.destroy() })
    this.child.on('error', () => this.fail()); this.child.stdin.on('error', () => this.fail())
    let buffer = ''; let bufferedBytes = 0; let queued = 0; let stderr = 0
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      buffer += chunk; bufferedBytes += Buffer.byteLength(chunk)
      // Measured as it arrives; re-measuring the whole buffer on every chunk is quadratic in a large frame.
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
              const waiter = this.pending.get(JSON.stringify(frame.id)); if (!waiter) return
              clearTimeout(waiter.timer); this.pending.delete(JSON.stringify(frame.id))
              if (frame.error !== undefined) waiter.reject(new GrokRejected('Grok rejected the operation. Review the thread before retrying.'))
              else {
                try { await waiter.apply(frame.result); waiter.resolve() }
                // Sotto's own refusal is the one answer worth repeating; anything else is a shape it could not read.
                catch (error) { waiter.reject(error instanceof GrokUnsupported ? error : new GrokUnreadable('Grok sent an invalid response.')); this.fail() }
              }
            } else await this.receive(frame)
          } finally { queued -= size }
        }).catch(() => this.fail())
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.length; if (stderr > MAX_STDERR_BYTES) this.fail() })
  }
  request(method: string, params: unknown, apply: Waiter['apply'] = () => undefined, completionOnly = false): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new GrokUncertain('Grok disconnected.')); return }
      if (this.pending.size >= 128) { reject(new GrokUncertain('Grok has too many unacknowledged requests. Reconnect before continuing.')); this.fail(); return }
      const id = ++this.serial
      const timer = completionOnly ? undefined : setTimeout(() => {
        if (!['session/new', 'session/set_model'].includes(method)) this.pending.delete(JSON.stringify(id))
        reject(new GrokUncertain('Grok did not acknowledge the operation in time.'))
      }, this.timeoutMs)
      this.pending.set(JSON.stringify(id), { resolve, reject, apply, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) } catch (error) { reject(error); this.fail() }
    })
  }
  write(frame: unknown): void {
    if (this.stopped || this.child.stdin.destroyed) throw new GrokUncertain('Grok disconnected before acknowledgement.')
    this.child.stdin.write(JSON.stringify(frame) + '\n')
  }
  reply(id: string | number, result: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) { reject(new GrokUncertain('Grok disconnected before receiving the answer.')); return }
      const timer = setTimeout(() => reject(new GrokUncertain('Grok answer delivery is uncertain.')), this.timeoutMs)
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n', error => { clearTimeout(timer); if (error) reject(new GrokUncertain('Grok answer delivery is uncertain.')); else resolve() })
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
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new GrokUncertain('Grok disconnected before acknowledgement.')) }
    this.pending.clear(); this.child.kill(); this.lost()
  }
}
