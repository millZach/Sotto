import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import { PLAYBOOK_OUTPUT_BYTES_MAX } from '../../shared/playbooks'
import { stopProcessTree } from '../agents/git/gitLauncher'

/**
 * A playbook's code step (ADR-0218): one program, with the arguments its file names, run without a shell in the step's
 * folder. A run's inputs and earlier outputs reach it only as environment variables, never in its command line, so
 * nothing from outside Sotto can change what runs. What it prints is read, the end of it kept as the step's output, and
 * never logged. When the step times out, is cancelled or Sotto closes, its whole process tree is stopped.
 *
 * On Windows a `.cmd` or `.bat` shim, such as npm's, can only start through cmd.exe, which reads `%`, quotes and
 * `& | < > ^ !` itself, so such a command runs only when none of its arguments holds one.
 */

export interface CodeRun {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly jsonOutput?: boolean
}
export interface CodeResult {
  readonly exitCode: number | null
  /** The end of what it printed to standard output. */
  readonly stdout: string
  readonly timedOut: boolean
  readonly stopped: boolean
  /** Why it never started, in plain words. */
  readonly refused?: string
}
export type CodeRunner = (run: CodeRun) => Promise<CodeResult>

/** How much of what a step prints is kept. */
export const CODE_OUTPUT_KEPT = 8000
const CMD_SAFE_ARGUMENT = /^[^"%^&|<>!\r\n]*$/u

/** Sotto's own environment for a child, without Electron's and Node's own switches. */
function childEnvironment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!/^(ELECTRON_|NODE_OPTIONS$|SOTTO_)/iu.test(key)) env[key] = value
  return { ...env, ...extra }
}

async function exists(path: string): Promise<boolean> { try { await access(path, constants.F_OK); return true } catch { return false } }

/** Where Windows would find a bare command name: the first folder on PATH holding it with one of PATHEXT's endings. */
async function windowsCommand(name: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (extname(name) !== '' || isAbsolute(name) || name.includes('/') || name.includes('\\')) return name
  const endings = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const folder of (env['PATH'] ?? env['Path'] ?? '').split(delimiter).filter(Boolean)) {
    for (const ending of endings) { const candidate = join(folder, name + ending.toLowerCase()); if (await exists(candidate)) return candidate }
  }
  return name
}

/** Runs one code step to its end. */
export const runCodeStep: CodeRunner = async run => {
  if (run.signal.aborted) return { exitCode: null, stdout: '', timedOut: false, stopped: true }
  const env = childEnvironment(run.env)
  let command = run.argv[0]!, args = run.argv.slice(1)
  let verbatim = false
  if (process.platform === 'win32') {
    command = await windowsCommand(command, env)
    if (/\.(cmd|bat)$/iu.test(command)) {
      if (/["%\r\n]/u.test(command) || !run.argv.every(argument => CMD_SAFE_ARGUMENT.test(argument))) {
        return { exitCode: null, stdout: '', timedOut: false, stopped: false, refused: 'Windows runs this command through cmd.exe, and one of its arguments holds %, a quote or one of & | < > ^ !, which cmd.exe would read itself. Call the program\'s .exe, or put the command in a script.' }
      }
      const quoted = [`"${command}"`, ...args.map(argument => /[\s,;=]/u.test(argument) ? `"${argument}"` : argument)].join(' ')
      args = ['/d', '/v:off', '/s', '/c', `"${quoted}"`]; command = env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe'; verbatim = true
    }
  }
  // On Windows, cancellation can arrive while the executable is being resolved.
  if (run.signal.aborted) return { exitCode: null, stdout: '', timedOut: false, stopped: true }
  return await new Promise<CodeResult>(done => {
    let stdout = '', timedOut = false, stopped = false, settled = false
    const child = spawn(command, args, { cwd: run.cwd, env, shell: false, windowsHide: true, windowsVerbatimArguments: verbatim, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const stop = (): void => {
      if (child.pid === undefined || child.exitCode !== null) return
      void stopProcessTree(child.pid).catch(() => { child.kill('SIGKILL') })
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, run.timeoutMs)
    timer.unref?.()
    const abort = (): void => { stopped = true; stop() }
    run.signal.addEventListener('abort', abort, { once: true })
    const outputLimit = run.jsonOutput ? PLAYBOOK_OUTPUT_BYTES_MAX + 1 : CODE_OUTPUT_KEPT
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-outputLimit) })
    child.stderr.on('data', () => undefined)
    const finish = (result: CodeResult): void => {
      if (settled) return
      settled = true; clearTimeout(timer); run.signal.removeEventListener('abort', abort); done(result)
    }
    child.on('error', error => finish({ exitCode: null, stdout, timedOut, stopped,
      refused: (error as NodeJS.ErrnoException).code === 'ENOENT' ? `The command ${run.argv[0]} was not found on this computer.` : 'The command could not start.' }))
    child.on('close', code => finish({ exitCode: code, stdout, timedOut, stopped }))
  })
}
