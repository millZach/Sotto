import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'

/**
 * The CLI lookup: where Sotto looks for a provider's command-line client, the same way for Claude Code, Codex,
 * Grok Build and Devin (ADR-0036). A host is often started from a non-interactive SSH shell whose PATH is
 * `/usr/local/bin:/usr/bin:/bin`, and a desktop started from the Dock or Finder has a PATH much like it, so
 * PATH alone misses every client a version manager installed. The order:
 *
 * 1. the provider's own install folder, when it has one it prefers (Grok Build's `~/.grok/bin`);
 * 2. PATH;
 * 3. the login shell's PATH (`$SHELL -l -c`, once per process, bounded), not on Windows;
 * 4. `~/.local/bin`;
 * 5. the version managers: mise's `installs/<tool>/latest`, asdf, nvm, fnm, Volta and Homebrew (Linuxbrew too);
 * 6. the npm global prefix;
 * 7. the provider's other install folders (Codex's `~/.codex/bin`, the Devin app).
 *
 * A manager's shims are never the client. A mise shim's real path is the `mise` binary and a Volta shim's is
 * `volta-shim`, and started by that path either one runs the manager rather than the tool, so a candidate whose
 * real path is one of them is passed over, and the mise and asdf shim folders are not searched at all. Nor is a script
 * that runs its command through a manager (forge's `~/.local/bin/claude` runs `mise use -g` and then `mise x`): the
 * lookup goes on to the install that script would have run.
 *
 * Nothing here logs: a path can name the user.
 */
export interface CliLookupOptions {
  /** Where PATH, SHELL and the managers' own variables are read. The process's environment by default. */
  readonly environment?: NodeJS.ProcessEnv
  /** The account's home folder. The process's by default; a test gives a fake one. */
  readonly home?: string
  /** Decides the file name (`.exe` on Windows) and the POSIX-only places. The running platform by default. */
  readonly platform?: NodeJS.Platform
  /** The login shell's PATH. By default the shell is asked once per process; a test answers for it. */
  readonly loginShellPath?: () => Promise<string | undefined>
}

export interface CliSpec {
  /** The command's name without an extension: `claude`, `codex`, `grok`, `devin`, `node`. */
  readonly name: string
  /** The provider's own install folders, tried before PATH. */
  readonly first?: readonly string[]
  /** The provider's own install folders, tried after everything else, or a reader for them, asked only when it is reached. */
  readonly last?: readonly string[] | (() => Promise<readonly string[]>)
  /** Further files to try in each folder besides `<folder>/<file>`, such as an npm package's native binary. */
  readonly within?: (directory: string, file: string) => readonly string[]
  /**
   * Whether a candidate is the client, and the path to start it by. By default a regular file that may be
   * executed, started by the path it was found at.
   */
  readonly accept?: (candidate: string) => Promise<string | undefined>
}

/** Manager binaries a shim resolves to. Started by that path they run the manager, not the tool. */
const DISPATCHERS = new Set(['mise', 'volta-shim'])
const LOGIN_SHELL_TIMEOUT_MS = 5_000
const LOGIN_SHELL_MAX_BYTES = 64 * 1024
const MARKER = '__SOTTO_LOGIN_PATH__'
/** How much of a script is read to see whether it runs its command through a manager. */
const WRAPPER_READ_BYTES = 4 * 1024
const MANAGER_RUN = /(?:^|[\s;&|(`"'/])(?:(?:mise|rtx)["']?\s+(?:x|exec)|asdf["']?\s+exec)\b/mu

const pathValue = (environment: NodeJS.ProcessEnv): string | undefined =>
  Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1]
const entries = (value: string | undefined): string[] =>
  (value ?? '').split(delimiter).map(entry => entry.trim().replace(/^"|"$/gu, '')).filter(entry => entry && isAbsolute(entry))
const sameFolder = (windows: boolean) => (a: string, b: string): boolean => {
  const clean = (value: string): string => value.replace(/[\\/]+$/u, '')
  return windows ? clean(a).toLowerCase() === clean(b).toLowerCase() : clean(a) === clean(b)
}
const absolute = (value: string | undefined): string | undefined => value && isAbsolute(value) ? value : undefined

async function list(directory: string): Promise<string[]> {
  try { return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name) }
  catch { return [] }
}
/** Version folders newest first: `v24.1.0` before `v22.9.0`, `26.8.1` before `24.21.0`. */
export function newestFirst(names: readonly string[]): string[] {
  const parts = (name: string): number[] => (name.match(/\d+/gu) ?? []).map(Number)
  return [...names].sort((a, b) => {
    const [x, y] = [parts(a), parts(b)]
    for (let index = 0; index < Math.max(x.length, y.length); index++) {
      const difference = (y[index] ?? -1) - (x[index] ?? -1)
      if (difference) return difference
    }
    return a.localeCompare(b)
  })
}
/** A manager's tools with the one named for the command first: `codex` before `npm-openai-codex` before the rest. */
function namedFirst(tools: readonly string[], name: string): string[] {
  const rank = (tool: string): number => tool === name ? 0 : tool.endsWith(`-${name}`) || tool.includes(name) ? 1 : 2
  return [...tools].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** The prefix npm installs global packages under, from npm's own variable or the account's `.npmrc`. */
async function npmPrefixes(environment: NodeJS.ProcessEnv, home: string): Promise<string[]> {
  const prefixes: string[] = []
  const fromEnvironment = absolute(Object.entries(environment).find(([key]) => key.toLowerCase() === 'npm_config_prefix')?.[1])
  if (fromEnvironment) prefixes.push(fromEnvironment)
  try {
    const line = (await readFile(join(home, '.npmrc'), 'utf8')).split(/\r?\n/u).find(entry => /^\s*prefix\s*=/u.test(entry))
    const value = line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/gu, '')
    const expanded = value?.startsWith('~/') ? join(home, value.slice(2)) : value
    if (expanded && isAbsolute(expanded)) prefixes.push(expanded)
  } catch { /* No .npmrc, or one without a prefix. */ }
  return prefixes
}

/** mise's data folder: its own variable, then the XDG data home, then `%LOCALAPPDATA%\mise` on Windows. */
export function miseDataFolder(environment: NodeJS.ProcessEnv, home: string, windows: boolean): string | undefined {
  const own = absolute(environment.MISE_DATA_DIR)
  if (own) return own
  if (!windows) return join(absolute(environment.XDG_DATA_HOME) ?? join(home, '.local', 'share'), 'mise')
  const local = absolute(environment.LOCALAPPDATA)
  return local ? join(local, 'mise') : undefined
}

/** The folders each version manager keeps installed commands in, in the order they are tried. */
async function managerFolders(name: string, environment: NodeJS.ProcessEnv, home: string, windows: boolean): Promise<string[]> {
  const folders: string[] = []
  const miseData = miseDataFolder(environment, home, windows)
  if (miseData) {
    // `latest` is mise's own link to the newest install. A tool keeps its command in `bin`, at the top of its
    // folder (an aqua download such as Claude Code), or in `node_modules/.bin` (an npm package such as Grok Build).
    for (const tool of namedFirst(await list(join(miseData, 'installs')), name)) {
      const latest = join(miseData, 'installs', tool, 'latest')
      folders.push(join(latest, 'bin'), latest, join(latest, 'node_modules', '.bin'))
    }
  }
  if (windows) return folders
  const asdf = absolute(environment.ASDF_DATA_DIR) ?? join(home, '.asdf')
  for (const tool of namedFirst(await list(join(asdf, 'installs')), name)) {
    for (const version of newestFirst(await list(join(asdf, 'installs', tool)))) folders.push(join(asdf, 'installs', tool, version, 'bin'))
  }
  const nvm = absolute(environment.NVM_DIR) ?? join(home, '.nvm')
  for (const version of newestFirst(await list(join(nvm, 'versions', 'node')))) folders.push(join(nvm, 'versions', 'node', version, 'bin'))
  const fnmHomes = [absolute(environment.FNM_DIR), join(home, '.local', 'share', 'fnm'), join(home, 'Library', 'Application Support', 'fnm'), join(home, '.fnm')]
  for (const fnm of [...new Set(fnmHomes.filter((value): value is string => Boolean(value)))]) {
    folders.push(join(fnm, 'aliases', 'default', 'bin'))
    for (const version of newestFirst(await list(join(fnm, 'node-versions')))) folders.push(join(fnm, 'node-versions', version, 'installation', 'bin'))
  }
  // Volta's own `bin` holds only shims; the installs are under `tools/image`.
  const volta = absolute(environment.VOLTA_HOME) ?? join(home, '.volta')
  const packages = join(volta, 'tools', 'image', 'packages')
  for (const entry of namedFirst(await list(packages), name)) {
    if (entry.startsWith('@')) for (const scoped of await list(join(packages, entry))) folders.push(join(packages, entry, scoped, 'bin'))
    else folders.push(join(packages, entry, 'bin'))
  }
  for (const version of newestFirst(await list(join(volta, 'tools', 'image', 'node')))) folders.push(join(volta, 'tools', 'image', 'node', version, 'bin'))
  const homebrew = absolute(environment.HOMEBREW_PREFIX)
  folders.push(...(homebrew ? [join(homebrew, 'bin')] : []), '/opt/homebrew/bin', '/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', join(home, '.linuxbrew', 'bin'))
  return folders
}

async function npmFolders(environment: NodeJS.ProcessEnv, home: string, windows: boolean): Promise<string[]> {
  const prefixes = await npmPrefixes(environment, home)
  // npm puts a global command in the prefix itself on Windows and in its `bin` elsewhere.
  if (windows) return [...prefixes, ...(absolute(environment.APPDATA) ? [join(environment.APPDATA!, 'npm')] : [])]
  return [...prefixes.map(prefix => join(prefix, 'bin')), join(home, '.npm-global', 'bin'), join(home, '.local', 'share', 'npm', 'bin')]
}

const loginPaths = new Map<string, Promise<string | undefined>>()
/**
 * The PATH the account's login shell sets up, asked once per shell and home for the life of the process. The
 * shell is given nothing on stdin and five seconds; a profile that prints is ignored up to the marker line.
 *
 * PATH is printed by `printenv`, the variable the shell exports, so fish, whose own `$PATH` is a list, answers the
 * same as sh. The answer is taken as soon as the marker line is complete: a profile that starts a background
 * process holding stdout (ssh-agent, keychain) keeps the pipe open long after the shell exits.
 */
export function loginShellPath(environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const shell = absolute(environment.SHELL) ?? '/bin/sh'
  const key = `${shell}\0${environment.HOME ?? ''}`
  let pending = loginPaths.get(key)
  if (!pending) {
    pending = new Promise<string | undefined>(resolve => {
      let output = ''
      let settled = false
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(shell, ['-l', '-c', `printf '\\n${MARKER}'; printenv PATH`], { env: environment, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false })
      } catch { resolve(undefined); return }
      /** The PATH from the last complete marker line that has arrived, if one has. */
      const answer = (): string | undefined => {
        const line = output.split('\n').slice(0, -1).reverse().find(entry => entry.startsWith(MARKER))
        return line ? line.slice(MARKER.length).trim() || undefined : undefined
      }
      const settle = (value: string | undefined): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // Whatever still holds the pipe is the profile's, not Sotto's: stop reading so it cannot keep this process busy.
        child.stdout?.destroy()
        resolve(value)
      }
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); settle(answer()) }, LOGIN_SHELL_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.length > LOGIN_SHELL_MAX_BYTES) { child.kill('SIGKILL'); output = ''; settle(undefined); return }
        const path = answer()
        if (path) settle(path)
      })
      child.on('error', () => settle(undefined))
      child.on('close', () => settle(answer()))
    })
    loginPaths.set(key, pending)
  }
  return pending
}

/**
 * A regular file that may be executed and is neither a manager's shim nor a script that hands the command to a
 * manager. Started by the path it was found at.
 */
export async function executableFile(candidate: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  try {
    if (!(await stat(candidate)).isFile()) return undefined
    await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK)
    const real = await realpath(candidate)
    if (isDispatcher(real) || await runsThroughManager(real)) return undefined
    return candidate
  } catch { return undefined }
}
/**
 * Whether a script runs its command through a version manager (`mise x`, `mise exec`, `asdf exec`), the way forge's
 * `~/.local/bin/claude` does. Such a wrapper can change the manager's own settings on every start (`mise use -g`)
 * and makes the client look like its installer's, so the lookup passes it over for the install it would run.
 */
async function runsThroughManager(file: string): Promise<boolean> {
  const handle = await open(file, 'r')
  try {
    const head = Buffer.alloc(WRAPPER_READ_BYTES)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    const text = head.subarray(0, bytesRead).toString('utf8')
    return text.startsWith('#!') && MANAGER_RUN.test(text)
  } finally { await handle.close() }
}
/** Whether a real path is a version manager's own binary, which is what a shim resolves to. */
export function isDispatcher(real: string): boolean {
  return DISPATCHERS.has(basename(real).replace(/\.exe$/iu, '').toLowerCase())
}

/**
 * Where a found client came from, for the PATH its process gets: the folders the lookup found outside the
 * inherited PATH, which go ahead of it, and the login shell's folders the inherited PATH lacks, which follow it.
 */
interface ClientPath { readonly ahead: readonly string[]; readonly after: readonly string[] }
const clientPaths = new Map<string, ClientPath>()

/** Finds one client the way the order above says, or undefined when it is not installed anywhere Sotto looks. */
export async function findCli(spec: CliSpec, options: CliLookupOptions = {}): Promise<string | undefined> {
  for await (const executable of findClis(spec, options)) return executable
  return undefined
}

/**
 * Every client the lookup finds, in the order above, each one as soon as it is found: a caller that stops early never
 * searches the places after it. Each is remembered for `withCliPath` before it is handed over. One file can come more
 * than once, by two paths that lead to it.
 */
export async function* findClis(spec: CliSpec, options: CliLookupOptions = {}): AsyncGenerator<string, void, undefined> {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const windows = platform === 'win32'
  const home = options.home ?? homedir()
  const file = windows ? `${spec.name}.exe` : spec.name
  const same = sameFolder(windows)
  const inherited = entries(pathValue(environment))
  const miseData = miseDataFolder(environment, home, windows)
  const shimFolders = [...(miseData ? [join(miseData, 'shims')] : []), join(absolute(environment.ASDF_DATA_DIR) ?? join(home, '.asdf'), 'shims')]
  const login = (): Promise<string | undefined> => windows ? Promise.resolve(undefined) : (options.loginShellPath ?? (() => loginShellPath(environment)))()
  const accept = spec.accept ?? ((candidate: string) => executableFile(candidate, platform))
  const tried = new Set<string>()
  const stages: (() => Promise<readonly string[]>)[] = [
    async () => spec.first ?? [],
    async () => inherited,
    async () => entries(await login()),
    async () => [join(home, '.local', 'bin')],
    async () => managerFolders(spec.name, environment, home, windows),
    async () => npmFolders(environment, home, windows),
    async () => typeof spec.last === 'function' ? spec.last() : spec.last ?? [],
  ]
  for (const stage of stages) {
    for (const folder of await stage()) {
      const key = windows ? folder.toLowerCase() : folder
      if (tried.has(key) || shimFolders.some(shims => same(shims, folder))) continue
      tried.add(key)
      for (const candidate of [join(folder, file), ...(spec.within?.(folder, file) ?? [])]) {
        const executable = await accept(candidate)
        if (!executable) continue
        // The folder it was found in, which for a followed link is not the client's own folder.
        await rememberClientPath(executable, folder, spec.name, { environment, platform, home, loginShellPath: login }, inherited)
        yield executable
      }
    }
  }
}

/**
 * A client found outside the inherited PATH can still need what its manager puts on PATH: an npm-installed
 * client runs `#!/usr/bin/env node`. Its own folder and Node's go ahead of the inherited PATH, and the login
 * shell's other folders after it. A client found on the inherited PATH is left with that PATH as it is.
 */
async function rememberClientPath(executable: string, foundIn: string, name: string, options: Required<Pick<CliLookupOptions, 'environment' | 'platform' | 'home' | 'loginShellPath'>>, inherited: readonly string[]): Promise<void> {
  const same = sameFolder(options.platform === 'win32')
  const onPath = (folder: string): boolean => inherited.some(entry => same(entry, folder))
  const folder = dirname(executable)
  if (onPath(foundIn)) { clientPaths.delete(executable); return }
  const ahead = [folder]
  if (name !== 'node') {
    const node = await findCli({ name: 'node' }, options)
    if (node && !onPath(dirname(node)) && !same(dirname(node), folder)) ahead.push(dirname(node))
  }
  const after = entries(await options.loginShellPath()).filter(entry => !onPath(entry) && !ahead.some(value => same(value, entry)))
  clientPaths.set(executable, { ahead, after: [...new Set(after)] })
}

/**
 * The environment a client's process gets: the adapter's own allow-list, with PATH extended by what the lookup
 * found for this executable. Only PATH changes; nothing the allow-list dropped comes back. An executable the
 * lookup did not find (a test's fixture, a path given in settings) keeps the PATH it was given.
 */
export function withCliPath(environment: NodeJS.ProcessEnv, executable: string): NodeJS.ProcessEnv {
  const extra = clientPaths.get(executable)
  if (!extra) return environment
  const key = Object.keys(environment).find(name => name.toLowerCase() === 'path') ?? 'PATH'
  const inherited = (environment[key] ?? '').split(delimiter).filter(Boolean)
  const value = [...new Set([...extra.ahead, ...inherited, ...extra.after])].join(delimiter)
  return { ...environment, [key]: value }
}

/** Forgets what earlier lookups found and asked, so a test starts clean. */
export function resetCliLookup(): void {
  clientPaths.clear()
  loginPaths.clear()
}
