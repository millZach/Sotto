/**
 * The Git launcher's worker thread (`gitLauncher.ts`). On Windows `child_process.spawn` runs CreateProcess on the
 * thread that calls it, and in Electron main that thread is the browser UI thread: a launch that took 5-15 ms, or
 * once 2 s, held every keystroke to the window for that long (`docs/perf/2026-10-19-git-launch-off-main.md`). This
 * thread does the launch, and only the launch: it starts the process it is told to, with the folder, environment and
 * input it is told to, streams what the process prints back as it prints it, and passes on a kill or a closed pipe.
 * Every decision (deadlines, output caps, stopping a process tree, errors) stays with the caller in main. An
 * interactive launch keeps standard input open and writes what main sends it, in order; Grok's limits probe speaks
 * JSON-RPC through one (`grok.ts`).
 *
 * It imports only Node builtins, so the same file runs in Electron main and in the headless host under plain Node.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { parentPort } from 'node:worker_threads'

export interface LaunchRequest {
  readonly type: 'launch'
  readonly id: number
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** Text written to the process's standard input, which is then closed; null leaves standard input unattached. */
  readonly stdin: string | null
  readonly detached: boolean
  /** Standard input stays open for `write` and `end` requests; `stdin` is then null. */
  readonly interactive?: boolean
}
export type LauncherRequest = LaunchRequest
  | { readonly type: 'kill'; readonly id: number; readonly signal?: NodeJS.Signals }
  | { readonly type: 'destroy'; readonly id: number; readonly stream: 'stdout' | 'stderr' }
  /** Text for an interactive launch's standard input; with a `serial`, the worker answers `written` once it is flushed. */
  | { readonly type: 'write'; readonly id: number; readonly data: string; readonly serial?: number }
  | { readonly type: 'end'; readonly id: number }
/** What an error carried, as plain data: a thread cannot post an Error with its `code` intact. */
export interface LaunchError { readonly message: string; readonly code?: string | number; readonly errno?: number; readonly syscall?: string; readonly path?: string }
export type LauncherEvent =
  | { readonly type: 'spawned'; readonly id: number; readonly pid: number | undefined }
  | { readonly type: 'stdout' | 'stderr'; readonly id: number; readonly chunk: Uint8Array }
  | { readonly type: 'error'; readonly id: number; readonly error: LaunchError }
  | { readonly type: 'close'; readonly id: number; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  /** The process ended; its output may still be open, held by a process it started, until `close`. */
  | { readonly type: 'exit'; readonly id: number; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  /** An interactive launch's write flushed, or failed with `error`. */
  | { readonly type: 'written'; readonly id: number; readonly serial: number; readonly error?: LaunchError }
  /** An interactive launch's standard input failed, as a closed pipe does. */
  | { readonly type: 'stdin-error'; readonly id: number; readonly error: LaunchError }

const port = parentPort
const children = new Map<number, ChildProcess>()
const post = (event: LauncherEvent): void => port?.postMessage(event)

function plain(error: unknown): LaunchError {
  const cause = error as Partial<NodeJS.ErrnoException> | undefined
  return {
    message: cause instanceof Error ? cause.message : String(error),
    ...(cause?.code !== undefined ? { code: cause.code } : {}),
    ...(typeof cause?.errno === 'number' ? { errno: cause.errno } : {}),
    ...(typeof cause?.syscall === 'string' ? { syscall: cause.syscall } : {}),
    ...(typeof cause?.path === 'string' ? { path: cause.path } : {}),
  }
}

function launch(request: LaunchRequest): void {
  const { id } = request
  let child: ChildProcess
  try {
    child = spawn(request.command, [...request.args], {
      cwd: request.cwd, env: request.env, windowsHide: true, shell: false, detached: request.detached,
      stdio: [request.stdin === null && !request.interactive ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    // A launch Node refuses outright (an argument it cannot pass) throws where it was asked; it is reported, then closed.
    post({ type: 'error', id, error: plain(error) })
    post({ type: 'close', id, code: null, signal: null })
    return
  }
  children.set(id, child)
  post({ type: 'spawned', id, pid: child.pid })
  if (request.interactive) child.stdin?.on('error', error => post({ type: 'stdin-error', id, error: plain(error) }))
  else if (request.stdin !== null && child.stdin) { child.stdin.on('error', () => undefined); child.stdin.end(request.stdin) }
  child.stdout?.on('data', (chunk: Buffer) => post({ type: 'stdout', id, chunk }))
  child.stderr?.on('data', (chunk: Buffer) => post({ type: 'stderr', id, chunk }))
  child.on('error', error => post({ type: 'error', id, error: plain(error) }))
  child.on('exit', (code, signal) => post({ type: 'exit', id, code, signal }))
  child.on('close', (code, signal) => { children.delete(id); post({ type: 'close', id, code, signal }) })
}

/** A write to a process that is not running, or whose input has ended, fails as Node's own write would. */
function write(request: Extract<LauncherRequest, { type: 'write' }>): void {
  const { id, serial } = request
  const stdin = children.get(id)?.stdin
  const answer = (error?: unknown): void => { if (serial !== undefined) post({ type: 'written', id, serial, ...(error ? { error: plain(error) } : {}) }) }
  if (!stdin || stdin.destroyed || stdin.writableEnded) { answer(new Error('The process is no longer taking input.')); return }
  stdin.write(request.data, error => answer(error ?? undefined))
}

port?.on('message', (request: LauncherRequest) => {
  if (request.type === 'launch') launch(request)
  else if (request.type === 'kill') children.get(request.id)?.kill(request.signal)
  else if (request.type === 'write') write(request)
  else if (request.type === 'end') children.get(request.id)?.stdin?.end()
  else children.get(request.id)?.[request.stream]?.destroy()
})
