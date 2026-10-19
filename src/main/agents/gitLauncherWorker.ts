/**
 * The Git launcher's worker thread (`gitLauncher.ts`). On Windows `child_process.spawn` runs CreateProcess on the
 * thread that calls it, and in Electron main that thread is the browser UI thread: a launch that took 5-15 ms, or
 * once 2 s, held every keystroke to the window for that long (`docs/perf/2026-10-19-git-launch-off-main.md`). This
 * thread does the launch, and only the launch: it starts the process it is told to, with the folder, environment and
 * input it is told to, streams what the process prints back as it prints it, and passes on a kill or a closed pipe.
 * Every decision (deadlines, output caps, stopping a process tree, errors) stays with the caller in main.
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
}
export type LauncherRequest = LaunchRequest
  | { readonly type: 'kill'; readonly id: number; readonly signal?: NodeJS.Signals }
  | { readonly type: 'destroy'; readonly id: number; readonly stream: 'stdout' | 'stderr' }
/** What an error carried, as plain data: a thread cannot post an Error with its `code` intact. */
export interface LaunchError { readonly message: string; readonly code?: string | number; readonly errno?: number; readonly syscall?: string; readonly path?: string }
export type LauncherEvent =
  | { readonly type: 'spawned'; readonly id: number; readonly pid: number | undefined }
  | { readonly type: 'stdout' | 'stderr'; readonly id: number; readonly chunk: Uint8Array }
  | { readonly type: 'error'; readonly id: number; readonly error: LaunchError }
  | { readonly type: 'close'; readonly id: number; readonly code: number | null; readonly signal: NodeJS.Signals | null }

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
      stdio: [request.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    // A launch Node refuses outright (an argument it cannot pass) throws where it was asked; it is reported, then closed.
    post({ type: 'error', id, error: plain(error) })
    post({ type: 'close', id, code: null, signal: null })
    return
  }
  children.set(id, child)
  post({ type: 'spawned', id, pid: child.pid })
  if (request.stdin !== null && child.stdin) { child.stdin.on('error', () => undefined); child.stdin.end(request.stdin) }
  child.stdout?.on('data', (chunk: Buffer) => post({ type: 'stdout', id, chunk }))
  child.stderr?.on('data', (chunk: Buffer) => post({ type: 'stderr', id, chunk }))
  child.on('error', error => post({ type: 'error', id, error: plain(error) }))
  child.on('close', (code, signal) => { children.delete(id); post({ type: 'close', id, code, signal }) })
}

port?.on('message', (request: LauncherRequest) => {
  if (request.type === 'launch') launch(request)
  else if (request.type === 'kill') children.get(request.id)?.kill(request.signal)
  else children.get(request.id)?.[request.stream]?.destroy()
})
