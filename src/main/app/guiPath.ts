import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { posix } from 'node:path'

const LOGIN_PATH_TIMEOUT_MS = 4_000
const DSCL_TIMEOUT_MS = 1_000
/** How long a finished command's output may take to arrive after it exits. A background child holding the pipe never closes it. */
const EXIT_GRACE_MS = 250
const MAX_OUTPUT = 64 * 1024
/** macOS and Linux separate PATH entries with a colon. Nothing here runs for a Windows launch. */
const POSIX_PATH_DELIMITER = ':'

function posixEntries(path: string): string[] {
  return path.split(POSIX_PATH_DELIMITER).map(piece => piece.replace(/^"|"$/g, '').trim()).filter(Boolean)
}

/** Directories a Terminal login would search, and a Dock-launched Electron process would not. */
export function staticPathCandidates(home: string, platform: NodeJS.Platform): string[] {
  const candidates = ['.local', '.grok', '.codex', '.cargo'].map(folder => posix.join(home, folder, 'bin'))
  if (platform === 'darwin') candidates.push('/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin')
  else if (platform === 'linux') candidates.push('/usr/local/bin')
  return candidates
}

/** A GUI launch whose PATH is only the system defaults, so Homebrew, nvm and ~/.local/bin are invisible. */
export function pathLooksTruncated(path: string, home: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return false
  const entries = new Set(posixEntries(path))
  const markers = platform === 'darwin'
    ? [posix.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
    : [posix.join(home, '.local', 'bin'), '/usr/local/bin']
  return markers.every(marker => !entries.has(marker))
}

/**
 * `leading` goes before the current PATH, as a Terminal login puts Homebrew and the user's own folders ahead of
 * /usr/bin; `trailing` only fills gaps after it. Each directory appears once, at its first position.
 */
export function mergePath(current: string, trailing: readonly string[], leading: readonly string[] = []): string {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const entry of [...leading, ...posixEntries(current), ...trailing]) {
    const dir = entry.replace(/^"|"$/g, '').trim()
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    ordered.push(dir)
  }
  return ordered.join(POSIX_PATH_DELIMITER)
}

/** The last absolute PATH line. Login scripts sometimes print a greeting before it. */
export function pathLine(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (posixEntries(line).some(entry => posix.isAbsolute(entry))) return line
  }
  return null
}

export async function existingDirectories(candidates: readonly string[]): Promise<string[]> {
  const found: string[] = []
  for (const dir of candidates) {
    if (!posix.isAbsolute(dir)) continue
    try {
      await access(dir, constants.X_OK)
      found.push(dir)
    } catch { /* Not a searchable directory. */ }
  }
  return found
}

type NodeVersion = readonly [number, number, number]

function parseVersion(name: string): NodeVersion | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function newer(a: NodeVersion, b: NodeVersion): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
}

/**
 * The bin folder of nvm's default Node, so a `#!/usr/bin/env node` CLI runs when the login shell could not be read.
 * Follows alias files (`default -> lts/*`, `lts/* -> lts/jod`) and resolves `node`, `stable`, `22` or `v22.1`
 * to the newest installed match, as `nvm use default` would.
 */
export async function nvmDefaultBin(nvmDir: string): Promise<string | null> {
  let installed: { name: string; version: NodeVersion }[]
  try {
    installed = (await readdir(posix.join(nvmDir, 'versions', 'node')))
      .flatMap(name => { const version = parseVersion(name); return version ? [{ name, version }] : [] })
  } catch { return null }
  let target = 'default'
  for (let hop = 0; hop < 8; hop += 1) {
    if (target.split('/').some(part => part === '..' || part === '')) return null
    let next: string
    try { next = (await readFile(posix.join(nvmDir, 'alias', target), 'utf8')).trim() } catch { break }
    if (!next) return null
    target = next
  }
  if (target === 'default') return null
  const pick = (matches: (version: NodeVersion) => boolean): string | null => {
    let best: { name: string; version: NodeVersion } | null = null
    for (const entry of installed) if (matches(entry.version) && (!best || newer(entry.version, best.version))) best = entry
    return best ? posix.join(nvmDir, 'versions', 'node', best.name, 'bin') : null
  }
  if (target === 'node' || target === 'stable') return pick(() => true)
  const prefix = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(target)
  if (!prefix) return null
  const wanted = prefix.slice(1).filter((part): part is string => part !== undefined).map(Number)
  return pick(version => wanted.every((part, index) => version[index] === part))
}

export interface BoundedCommand { readonly command: string; readonly args: readonly string[] }

/**
 * Runs a command and settles by `timeoutMs` whatever it does. It settles on exit rather than on its pipes closing,
 * because a login rc can leave a background process (gitstatusd, a tmux server) holding stdout open for good.
 * Its whole process group is killed once it settles, so nothing it started outlives the read.
 */
export function runBounded(invocation: BoundedCommand, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string } | null> {
  return new Promise(resolve => {
    const windows = process.platform === 'win32'
    let stdout = ''
    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(invocation.command, [...invocation.args], {
        // Its own process group, so a timeout reaches what the shell started too. Windows has no groups to kill.
        detached: !windows,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env,
      })
    } catch { resolve(null); return }
    const stop = (): void => {
      try {
        if (!windows && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* Already gone. */ }
    }
    const finish = (result: { code: number | null; stdout: string } | null): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (grace !== undefined) clearTimeout(grace)
      stop()
      child.stdout?.destroy()
      child.unref()
      resolve(result)
    }
    const deadline = setTimeout(() => finish(null), timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { if (stdout.length < MAX_OUTPUT) stdout += chunk })
    child.stdout?.on('error', () => undefined)
    child.on('error', () => finish(null))
    child.on('close', code => finish({ code, stdout }))
    child.on('exit', code => { grace ??= setTimeout(() => finish({ code, stdout }), EXIT_GRACE_MS) })
  })
}

export function loginShellCommand(shell: string): BoundedCommand | null {
  if (!posix.isAbsolute(shell) || /\/(false|nologin)$/.test(shell)) return null
  return { command: shell, args: ['-ilc', 'printf %s "$PATH"'] }
}

function minimalEnvironment(shell?: string): NodeJS.ProcessEnv {
  const user = process.env.USER || userInfo().username
  return {
    HOME: homedir(),
    USER: user,
    LOGNAME: process.env.LOGNAME || user,
    ...(shell ? { SHELL: shell } : {}),
    TMPDIR: process.env.TMPDIR || '/tmp',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  }
}

/** Reads PATH from an interactive login shell. Null when the shell fails, prints no PATH, or takes longer than `timeoutMs`. */
export async function readShellPath(invocation: BoundedCommand, timeoutMs = LOGIN_PATH_TIMEOUT_MS, env: NodeJS.ProcessEnv = minimalEnvironment()): Promise<string | null> {
  const result = await runBounded(invocation, timeoutMs, env)
  return result?.code === 0 ? pathLine(result.stdout) : null
}

export function readLoginShellPath(shell: string, timeoutMs = LOGIN_PATH_TIMEOUT_MS): Promise<string | null> {
  const invocation = loginShellCommand(shell)
  return invocation ? readShellPath(invocation, timeoutMs, minimalEnvironment(shell)) : Promise.resolve(null)
}

async function defaultShell(): Promise<string> {
  if (process.platform !== 'darwin') return process.env.SHELL && posix.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/sh'
  const result = await runBounded({ command: '/usr/bin/dscl', args: ['.', '-read', `/Users/${userInfo().username}`, 'UserShell'] }, DSCL_TIMEOUT_MS, minimalEnvironment())
  const match = result?.code === 0 ? /UserShell:\s*(\/\S+)/.exec(result.stdout) : null
  // The platform default is enough when Directory Services is unavailable.
  return match?.[1] ?? '/bin/zsh'
}

export interface GuiPathDeps {
  platform?: NodeJS.Platform
  home?: string
  loginPath?: () => Promise<string | null>
  shell?: string
  nvmBin?: () => Promise<string | null>
  existing?: (candidates: readonly string[]) => Promise<string[]>
}

/**
 * Adds the user's own bin directories to PATH. Never copies the rest of the login environment.
 * A Dock launch takes the login shell's order, so Homebrew's git wins over /usr/bin's as it does in Terminal.
 * A launch that already has a full PATH keeps its order and only gains missing folders at the end.
 */
export async function installGuiPath(env: NodeJS.ProcessEnv = process.env, deps: GuiPathDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') return
  const home = deps.home ?? homedir()
  const existing = deps.existing ?? existingDirectories
  const current = env.PATH ?? env.Path ?? ''
  const fallback = [...staticPathCandidates(home, platform)]
  const nvm = await (deps.nvmBin ?? (() => nvmDefaultBin(env.NVM_DIR && posix.isAbsolute(env.NVM_DIR) ? env.NVM_DIR : posix.join(home, '.nvm'))))().catch(() => null)
  if (nvm) fallback.push(nvm)
  if (!pathLooksTruncated(current, home, platform)) {
    const next = mergePath(current, await existing(fallback))
    if (next) env.PATH = next
    return
  }
  const login = await (deps.loginPath ?? (async () => readLoginShellPath(deps.shell ?? await defaultShell())))().catch(() => null)
  const next = mergePath(current, [], await existing([...login ? posixEntries(login) : [], ...fallback]))
  if (next) env.PATH = next
}
