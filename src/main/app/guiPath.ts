import { execFile, execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join, posix } from 'node:path'

const LOGIN_PATH_TIMEOUT_MS = 4_000
/** macOS and Linux separate PATH entries with a colon. These helpers never run for a Windows launch. */
const POSIX_PATH_DELIMITER = ':'

/** A POSIX home stays POSIX on the Windows test runner. A real Windows home stays a Windows path so the directory exists. */
function userDirectory(home: string, ...parts: string[]): string {
  return (/^[A-Za-z]:[\\/]|\\/.test(home) ? join : posix.join)(home, ...parts)
}

/**
 * Split a POSIX PATH. The unit suite runs on Windows, where a temp directory is `D:\...`, so a drive
 * letter and the rest of that directory are one entry rather than two.
 */

function posixEntries(path: string): string[] {
  const pieces = path.split(POSIX_PATH_DELIMITER)
  const entries: string[] = []
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]!.replace(/^"|"$/g, '').trim()
    const next = pieces[index + 1]?.replace(/^"|"$/g, '').trim()
    if (/^[A-Za-z]$/.test(piece) && next !== undefined && next.startsWith('\\')) {
      entries.push(`${piece}:${next}`)
      index += 1
      continue
    }
    if (piece) entries.push(piece)
  }
  return entries
}

/** Directories a Terminal login would search, and a Dock-launched Electron process would not. */
export function staticPathCandidates(home: string, platform: NodeJS.Platform): string[] {
  const candidates = [userDirectory(home, '.local', 'bin'), userDirectory(home, '.grok', 'bin'), userDirectory(home, '.codex', 'bin'), userDirectory(home, '.cargo', 'bin')]
  if (platform === 'darwin') candidates.push('/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin')
  else if (platform === 'linux') candidates.push('/usr/local/bin')
  return candidates
}

/** A GUI launch whose PATH is only the system defaults, so Homebrew, nvm and ~/.local/bin are invisible. */
export function pathLooksTruncated(path: string, home: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return false
  const entries = new Set(posixEntries(path))
  const markers = platform === 'darwin'
    ? [userDirectory(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
    : [userDirectory(home, '.local', 'bin'), '/usr/local/bin']
  return markers.every(marker => !entries.has(marker))
}

export function mergePath(current: string, additions: readonly string[]): string {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const entry of [...posixEntries(current), ...additions]) {
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
    if (!isAbsolute(dir)) continue
    try {
      await access(dir, constants.X_OK)
      found.push(dir)
    } catch { /* Not a searchable directory. */ }
  }
  return found
}

async function nvmDefaultBin(home: string): Promise<string | null> {
  try {
    const alias = (await readFile(join(home, '.nvm', 'alias', 'default'), 'utf8')).trim()
    if (!/^v\d+\.\d+\.\d+/.test(alias)) return null
    return join(home, '.nvm', 'versions', 'node', alias, 'bin')
  } catch { return null }
}

export function readLoginShellPath(shell: string, timeoutMs = LOGIN_PATH_TIMEOUT_MS): Promise<string | null> {
  if (!isAbsolute(shell) || /\/(false|nologin)$/.test(shell)) return Promise.resolve(null)
  const home = homedir()
  return new Promise(resolve => {
    execFile(shell, ['-ilc', 'printf %s "$PATH"'], {
      timeout: timeoutMs,
      windowsHide: true,
      env: {
        HOME: home,
        USER: process.env.USER || userInfo().username,
        LOGNAME: process.env.LOGNAME || process.env.USER || userInfo().username,
        SHELL: shell,
        TMPDIR: process.env.TMPDIR || '/tmp',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
    }, (error, stdout) => { resolve(error ? null : pathLine(stdout)) })
  })
}

function defaultShell(): string {
  if (process.platform !== 'darwin') return process.env.SHELL && isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/sh'
  try {
    const output = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${userInfo().username}`, 'UserShell'], { encoding: 'utf8', timeout: 1_000 })
    const match = output.match(/UserShell:\s*(\/\S+)/)
    if (match?.[1] && isAbsolute(match[1])) return match[1]
  } catch { /* The platform default is enough when Directory Services is unavailable. */ }
  return '/bin/zsh'
}

export interface GuiPathDeps {
  platform?: NodeJS.Platform
  home?: string
  loginPath?: () => Promise<string | null>
  shell?: string
}

/** Adds the user's own bin directories to PATH. Never copies the rest of the login environment. */
export async function installGuiPath(env: NodeJS.ProcessEnv = process.env, deps: GuiPathDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32') return
  const home = deps.home ?? homedir()
  const current = env.PATH ?? env.Path ?? ''
  const additions = [...staticPathCandidates(home, platform)]
  const nvm = await nvmDefaultBin(home)
  if (nvm) additions.push(nvm)
  if (pathLooksTruncated(current, home, platform)) {
    const login = await (deps.loginPath ?? (() => readLoginShellPath(deps.shell ?? defaultShell())))().catch(() => null)
    if (login) additions.push(...posixEntries(login))
  }
  const present = await existingDirectories(additions)
  const next = mergePath(current, present)
  if (next) env.PATH = next
}
