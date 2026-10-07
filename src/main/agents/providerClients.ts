import { execFile } from 'node:child_process'
import { access, constants, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { PROVIDER_LABELS, type ClientChannel, type ClientUpdateFailure, type ProviderClientUpdate, type ProviderId } from '../../shared/agents'
import { compareClientVersions, isComparableVersion } from './clientVersions'
import { installerDetail, installerOutput } from './installerDetail'
import { findDevinExecutable } from './devinRpc'
import { findGrokExecutable } from './grokRpc'
import { findClaudeExecutable } from './subscriptionClaude'
import { findCli, miseDataFolder, withCliPath } from './cliLookup'
import { findExecutable as findCodexExecutable } from './subscriptionCodex'

/** The package whose `latest` tag says what each client has published. Devin ships inside its own app. */
export const CLIENT_PACKAGES: Readonly<Partial<Record<ProviderId, string>>> = {
  claude: '@anthropic-ai/claude-code', codex: '@openai/codex', grok: '@xai-official/grok',
}
const REGISTRY = 'https://registry.npmjs.org'
const PUBLISHED_CACHE_MS = 60 * 60 * 1000
const REGISTRY_TIMEOUT_MS = 10_000
const REGISTRY_MAX_BYTES = 256 * 1024
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000
const published = z.object({ version: z.string().min(1).max(64) })

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
/**
 * How one run of an installer went. `detail` is its last line and `printed` its last few, both without home folders;
 * `stdout` is what it answered, for a run that is asked something (`mise where`).
 */
export interface RunResult { readonly ok: boolean; readonly detail?: string; readonly printed?: string; readonly stdout?: string }
export interface RunOptions { readonly cwd?: string }
export type RunLike = (executable: string, args: readonly string[], asNode?: boolean, options?: RunOptions) => Promise<RunResult>


// A client a version manager installed is that manager's to update: npm here would install a second copy elsewhere.
// mise is read before these, and only its installs folder makes a client mise's (see `miseToolOf`).
const MANAGED_ELSEWHERE = [`${sep}.bun${sep}`, `${sep}pnpm${sep}`, `${sep}.pnpm${sep}`, `${sep}.volta${sep}`, `${sep}.mise${sep}`, `${sep}mise${sep}installs${sep}`, `${sep}.asdf${sep}`, 'homebrew', 'linuxbrew']

/** The client's own home, when its own installer owns the binary there: `~/.local/bin/claude.exe`. */
function ownHome(provider: ProviderId, environment: NodeJS.ProcessEnv): readonly string[] {
  const home = homedir()
  if (provider === 'claude') return [join(home, '.local', 'bin'), join(home, '.claude')]
  if (provider === 'grok') return [grokBin(environment)]
  return []
}
function grokBin(environment: NodeJS.ProcessEnv): string {
  return join(environment.GROK_HOME && isAbsolute(environment.GROK_HOME) ? environment.GROK_HOME : join(homedir(), '.grok'), 'bin')
}
const within = (path: string, directory: string): boolean =>
  path.toLowerCase().startsWith(`${directory.toLowerCase()}${sep}`)

/** Where a global npm install keeps its packages, without running npm to ask. */
function npmGlobalRoots(environment: NodeJS.ProcessEnv): readonly string[] {
  const home = homedir()
  const prefix = environment.npm_config_prefix && isAbsolute(environment.npm_config_prefix) ? [environment.npm_config_prefix] : []
  const appData = environment.APPDATA && isAbsolute(environment.APPDATA) ? [join(environment.APPDATA, 'npm')] : []
  return [
    ...prefix.map(root => join(root, 'lib', 'node_modules')), ...prefix.map(root => join(root, 'node_modules')),
    ...appData.map(root => join(root, 'node_modules')),
    join('/usr', 'local', 'lib', 'node_modules'), join('/usr', 'lib', 'node_modules'),
    join(home, '.npm-global', 'lib', 'node_modules'), join(home, '.local', 'share', 'npm', 'lib', 'node_modules'),
  ]
}
/** The folder npm installed a client's package in: the one the binary sits inside, else one in a global root. */
async function npmPackageFolder(packageName: string, executable: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const parts = executable.split(sep), names = packageName.split('/')
  const inside = parts.findIndex((part, index) => part.toLowerCase() === 'node_modules'
    && names.every((name, offset) => parts[index + 1 + offset]?.toLowerCase() === name.toLowerCase()))
  const bin = dirname(executable)
  const roots = [...inside > 0 ? [parts.slice(0, inside + 1).join(sep)] : [], ...npmGlobalRoots(environment),
    join(bin, 'node_modules'), join(dirname(bin), 'lib', 'node_modules'), join(dirname(bin), 'node_modules')]
  for (const root of roots) {
    const folder = join(root, ...names)
    try { await access(join(folder, 'package.json'), constants.F_OK); return folder } catch { /* Try the next global layout. */ }
  }
  return undefined
}
async function npmOwns(packageName: string, executable: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  return await npmPackageFolder(packageName, executable, environment) !== undefined
}

/** True when a program or library in this folder is running: Windows will not open a running image for writing. */
async function runningFrom(folder: string): Promise<boolean> {
  const files = await readdir(folder, { recursive: true }).catch(() => [] as string[])
  for (const file of files.filter(name => /\.(?:exe|dll|node)$/iu.test(name))) {
    try { await (await open(join(folder, file), 'r+')).close() } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ETXTBSY') return true
    }
  }
  return false
}

/**
 * npm moves the package it replaces to `.<name>-<hash>` beside it and deletes that folder once the new one is in.
 * The name is the same on every run (arborist's `retire-path.js` hashes the package's path). On Windows npm cannot
 * delete a program that is still running, so an update made while a thread works leaves the folder behind (ADR-0042).
 * That costs nothing until the next update needs the same name while something from before the last one still runs
 * there: npm cannot move the folder in, falls back to copying file by file, and stops on
 * `EBUSY: resource busy or locked, copyfile`. So before npm runs, each such folder is deleted when nothing runs from
 * it, and moved to a name of its own when something does, to be deleted before a later update.
 */
export async function clearLeftoverPackage(packageFolder: string, now: () => number = Date.now): Promise<void> {
  const scope = dirname(packageFolder)
  const leftover = new RegExp(`^\\.${basename(packageFolder).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-[A-Za-z0-9]{8}(?:\\.old-\\d+)?$`, 'u')
  for (const entry of await readdir(scope, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !leftover.test(entry.name)) continue
    const folder = join(scope, entry.name)
    if (!await runningFrom(folder)) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
    // Only npm's own name has to be free. A folder already moved waits there until its program stops.
    else if (!entry.name.includes('.old-')) await moveAside(folder, `${folder}.old-${now()}`)
  }
}
/**
 * Opening the folder's idle programs to look for a running one is enough for a virus scanner to read them, and while
 * it does Windows refuses to move their folder (`EPERM`, measured under load). That passes, so the move is tried again
 * for a few seconds. One still refused is left where it is, and npm says what it says.
 */
const MOVE_ASIDE_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600] as const
async function moveAside(folder: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(folder, to); return } catch (error) {
      const retry = MOVE_ASIDE_RETRY_DELAYS_MS[attempt], code = (error as NodeJS.ErrnoException).code
      if (retry === undefined || (code !== 'EPERM' && code !== 'EBUSY')) return
      await delay(retry)
    }
  }
}

/**
 * The folder mise keeps a tool's installs in is its name made safe for a path: `npm:@xai-official/grok` becomes
 * `npm-xai-official-grok`. mise writes the real name beside the installs (`.mise.backend.toml`, `short = "…"`); these
 * are the names Sotto knows for a folder without one, checked against forge's installs on September 29, 2026.
 */
const MISE_FOLDER_TOOLS: Readonly<Record<string, string>> = {
  claude: 'claude', codex: 'codex',
  'npm-xai-official-grok': 'npm:@xai-official/grok',
  'npm-openai-codex': 'npm:@openai/codex',
  'npm-anthropic-ai-claude-code': 'npm:@anthropic-ai/claude-code',
}
/** A mise tool name Sotto will pass as an argument: a backend and a name, nothing that reads as an option. */
const MISE_TOOL = /^[A-Za-z0-9@][A-Za-z0-9@/:._+-]{0,127}$/u

/** The tool a mise installs folder holds: mise's own record of its name, else the name Sotto knows for the folder. */
async function miseToolNamed(installs: string, folder: string): Promise<string | undefined> {
  try {
    const record = await readFile(join(installs, folder, '.mise.backend.toml'), 'utf8')
    const short = /^\s*short\s*=\s*"([^"]+)"\s*$/mu.exec(record)?.[1]
    if (short && MISE_TOOL.test(short)) return short
  } catch { /* An older mise wrote no record; the folder's name decides. */ }
  return MISE_FOLDER_TOOLS[folder]
}

/**
 * Which mise tool installed this client, or undefined when mise did not. Two ways, both read from disk:
 *
 * - The client lives in mise's installs folder (`<mise data>/installs/<tool>/<version>/…`, found through its `latest`
 *   link), as Claude Code and Codex do on forge. mise's data folder is its own `MISE_DATA_DIR`, else the XDG data
 *   home, else `~/.local/share/mise` (`%LOCALAPPDATA%\mise` on Windows); an installs folder under another `mise`
 *   folder counts too.
 * - Grok Build, whose npm package mise installs but whose program the package's install step puts in `~/.grok/bin`.
 *   There the evidence is mise holding `npm:@xai-official/grok` with an installed version, and npm not holding it.
 */
export async function miseToolOf(provider: ProviderId, executable: string, environment: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const windows = process.platform === 'win32'
  const data = miseDataFolder(environment, homedir(), windows)
  const installs = data ? join(data, 'installs') : undefined
  const real = await realpath(executable).catch(() => executable)
  for (const path of [...new Set([executable, real])]) {
    if (installs && within(path, installs)) {
      const folder = relative(installs, path).split(sep)[0]
      if (folder) return miseToolNamed(installs, folder)
    }
    const parts = path.split(sep)
    const at = parts.findIndex((part, index) => part.toLowerCase() === 'installs' && parts[index - 1]?.toLowerCase().replace(/^\./u, '') === 'mise')
    if (at > 0 && parts[at + 1]) return miseToolNamed(parts.slice(0, at + 1).join(sep), parts[at + 1]!)
  }
  if (provider !== 'grok' || !installs || !within(executable, grokBin(environment))) return undefined
  for (const folder of await readdir(installs).catch(() => [] as string[])) {
    if (await miseToolNamed(installs, folder) !== `npm:${CLIENT_PACKAGES.grok}`) continue
    const versions = (await readdir(join(installs, folder), { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory() && /^\d/u.test(entry.name))
    if (versions.length) return `npm:${CLIENT_PACKAGES.grok}`
  }
  return undefined
}

/** The channel that owns an install, and for mise the tool it is installed as. */
export interface ClientInstall { readonly channel: ClientChannel; readonly miseTool?: string }

/**
 * Which channel owns this install, from the path it was found at and from what is installed where.
 *
 * The evidence, in order: mise, then a manager Sotto will not drive, then npm, then the client's own home. npm shows
 * itself three ways, and the live run this feature was written against needed all three: the package's vendored
 * binary buried inside `node_modules` (Codex), a launcher beside its package, and — the one that is easy to get wrong —
 * a package in the npm global root whose real binary lives in the client's own home. Grok Build is that third case:
 * 142 MB of `~/.grok/bin/grok.exe` that npm's install script put there, and `grok update --check --json` says
 * `"installer":"npm"` itself. Grok Build installed by mise's npm backend looks the same from `~/.grok/bin`, so mise is
 * asked only once npm has said the package is not its own. Only a client nobody else owns, like Claude Code's own
 * installer in `~/.local/bin`, updates itself.
 */
export async function detectClientInstall(provider: ProviderId, executable: string | undefined,
  environment: NodeJS.ProcessEnv = process.env): Promise<ClientInstall> {
  if (provider === 'devin') return { channel: 'devin-app' }
  if (!executable || !isAbsolute(executable)) return { channel: 'unknown' }
  const lower = executable.toLowerCase()
  const packageName = CLIENT_PACKAGES[provider]
  const inOwnHome = ownHome(provider, environment).some(directory => within(executable, directory))
  if (!inOwnHome) {
    const miseTool = await miseToolOf(provider, executable, environment)
    if (miseTool) return { channel: 'mise', miseTool }
  }
  if (MANAGED_ELSEWHERE.some(marker => lower.includes(marker))) return { channel: 'unknown' }
  if (lower.split(sep).includes('node_modules')) return { channel: 'npm' }
  if (packageName && await npmOwns(packageName, executable, environment)) return { channel: 'npm' }
  if (inOwnHome) {
    const miseTool = await miseToolOf(provider, executable, environment)
    if (miseTool) return { channel: 'mise', miseTool }
    return { channel: 'self-update' }
  }
  return { channel: 'unknown' }
}
export async function detectClientChannel(provider: ProviderId, executable: string | undefined,
  environment: NodeJS.ProcessEnv = process.env): Promise<ClientChannel> {
  return (await detectClientInstall(provider, executable, environment)).channel
}

/** Grok Build's own install step, which mise's npm backend skips: it puts the new program in `~/.grok/bin`. */
export const GROK_INSTALL_STEP = 'node bin/postinstall.js'
/** The command to run on the machine by hand, a line each, or undefined when Sotto cannot name one. */
export function byHandFor(provider: ProviderId, install: ClientInstall): readonly string[] | undefined {
  const packageName = CLIENT_PACKAGES[provider]
  switch (install.channel) {
    case 'npm': return packageName ? [`npm install -g --allow-scripts=${packageName} ${packageName}@latest`] : undefined
    case 'self-update': return provider === 'claude' || provider === 'grok' ? [`${provider} update`] : undefined
    case 'mise': {
      if (!install.miseTool) return undefined
      const upgrade = `mise upgrade ${install.miseTool}`
      // Checked on forge on September 29, 2026: the package's install step, run in the folder mise installed it in.
      return needsInstallStep(provider, install.miseTool) && packageName
        ? [upgrade, `cd "$(mise where ${install.miseTool})/node_modules/${packageName}"`, GROK_INSTALL_STEP] : [upgrade]
    }
    default: return undefined
  }
}
const needsInstallStep = (provider: ProviderId, miseTool: string): boolean => provider === 'grok' && miseTool === `npm:${CLIENT_PACKAGES.grok}`

export interface UpdateAction {
  readonly command: string; readonly executable: string; readonly args: readonly string[]; readonly asNode?: boolean
  /** The same update as lines to run by hand, for when it fails. */
  readonly byHand: readonly string[]
  /** Where to run it: mise from the home folder, so the global config applies and no project's own mise.toml does. */
  readonly cwd?: string
  /** Grok Build under mise: after the upgrade, its package's install step, in the folder `mise where` names. */
  readonly installStep?: { readonly mise: string; readonly tool: string; readonly packageName: string }
}
/**
 * What a press runs. The package names come from this file's own table, and a mise tool's name from mise's own record
 * beside its installs, never from the registry's answer or from anything the user typed.
 *
 * npm is run as `npm-cli.js` under this process's own Node rather than through `npm.cmd`, because
 * the shell hop is where the first live run of this broke: a `cmd /s /c` line naming npm's batch
 * file loses its quoting and answers "operable program or batch file". No shell, no quoting, same npm.
 * mise is run as the mise binary itself, never through a shim, which would run the tool instead.
 */
export async function updateActionFor(provider: ProviderId, install: ClientChannel | ClientInstall, executable: string | undefined,
  npmPath: () => Promise<string | undefined> = defaultNpmPath, misePath: () => Promise<string | undefined> = defaultMisePath): Promise<UpdateAction | undefined> {
  const found: ClientInstall = typeof install === 'string' ? { channel: install } : install
  const byHand = byHandFor(provider, found)
  if (found.channel === 'npm') {
    const packageName = CLIENT_PACKAGES[provider]
    if (!packageName || !byHand) return undefined
    // npm 12 runs no install scripts unless a package is named, and still exits 0 without them. Grok
    // Build finishes its install in one, so this one package's scripts are allowed, the way T3 Code does
    // it. An older npm warns about a config it does not know and installs all the same.
    const allowScripts = `--allow-scripts=${packageName}`
    const cli = await npmPath()
    if (!cli) return undefined
    return { command: byHand[0]!, byHand, executable: process.execPath, args: [cli, 'install', '-g', allowScripts, `${packageName}@latest`], asNode: true }
  }
  if (found.channel === 'self-update' && executable && byHand) return { command: byHand[0]!, byHand, executable, args: ['update'] }
  if (found.channel === 'mise' && found.miseTool && byHand) {
    const mise = await misePath()
    if (!mise) return undefined
    const packageName = CLIENT_PACKAGES[provider]
    return { command: byHand[0]!, byHand, executable: mise, args: ['upgrade', found.miseTool], cwd: homedir(),
      ...(needsInstallStep(provider, found.miseTool) && packageName ? { installStep: { mise, tool: found.miseTool, packageName } } : {}) }
  }
  return undefined
}

/** npm's own entry point, beside the Node that is running or in the global root. */
const defaultNpmPath = async (): Promise<string | undefined> => {
  const candidates = new Set<string>()
  for (const directory of [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)
    .map(entry => entry.replace(/^"|"$/gu, '')).filter(isAbsolute)]) {
    candidates.add(join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    candidates.add(join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  }
  for (const root of npmGlobalRoots(process.env)) candidates.add(join(root, 'npm', 'bin', 'npm-cli.js'))
  for (const candidate of candidates) {
    try { await access(candidate, constants.F_OK); return candidate } catch { /* Try the next layout. */ }
  }
  return undefined
}

/**
 * The mise binary itself, by its real path: a file whose real name is `mise`, and not a script. A mise shim resolves to
 * this same binary but runs the tool it is named for, and the shim folders are never searched; a script named mise
 * could run anything. Found the way a client is (ADR-0036), and also where `MISE_INSTALL_PATH` puts it.
 */
export async function miseBinary(candidate: string): Promise<string | undefined> {
  try {
    const real = await realpath(candidate)
    if (basename(real).replace(/\.exe$/iu, '').toLowerCase() !== 'mise' || !(await stat(real)).isFile()) return undefined
    await access(real, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    const handle = await open(real, 'r')
    try {
      const head = Buffer.alloc(2)
      await handle.read(head, 0, 2, 0)
      if (head.toString('latin1') === '#!') return undefined
    } finally { await handle.close() }
    return real
  } catch { return undefined }
}
const defaultMisePath = async (): Promise<string | undefined> => {
  const installPath = process.env.MISE_INSTALL_PATH
  return findCli({ name: 'mise', accept: miseBinary, last: [...(installPath && isAbsolute(installPath) ? [dirname(installPath)] : []), '/usr/bin'] })
}

const RUN_OUTPUT_BYTES = 1024 * 1024
const defaultRun: RunLike = (executable, args, asNode, options) => new Promise(resolve => {
  // ELECTRON_RUN_AS_NODE turns this app's own binary into the Node that runs npm's CLI.
  // A client's own updater gets the PATH the CLI lookup gave the client (ADR-0036): a wrapper may need its manager.
  const env = asNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : withCliPath(process.env, executable)
  execFile(executable, [...args], { env, windowsHide: true, shell: false, timeout: UPDATE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: RUN_OUTPUT_BYTES, encoding: 'utf8',
    ...(options?.cwd ? { cwd: options.cwd } : {}) },
    (error, stdout, stderr) => {
      if (!error) { resolve({ ok: true, stdout: String(stdout) }); return }
      const said = String(stderr).trim() ? String(stderr) : String(stdout)
      const detail = installerDetail(said), printed = installerOutput(said)
      resolve({ ok: false, ...(detail ? { detail } : {}), ...(printed ? { printed } : {}) })
    })
})

/** Words an installer prints when the download itself went wrong, rather than the install. */
const DOWNLOAD_FAILED = /error sending request|connection (?:reset|closed|aborted)|reset by peer|socket hang up|unexpected eof|ECONNRESET|operation timed out|error decoding response body/iu

/**
 * How an install went: `step` is the one that did not finish, `failure` why, and `printed` what the installer said.
 * A run that fails before its first step (nothing Sotto can run) has no step.
 */
export interface InstallResult extends RunResult { readonly step?: number; readonly failure?: ClientUpdateFailure }

export interface ProviderClientsOptions {
  readonly fetchImpl?: FetchLike
  readonly run?: RunLike
  readonly now?: () => number
  /** Where npm is. Injected so a test never depends on the machine's own PATH. */
  readonly npmPath?: () => Promise<string | undefined>
  /** Where mise is. Injected so a test never depends on the machine's own mise. */
  readonly misePath?: () => Promise<string | undefined>
  /** The Node that runs Grok Build's install step: this process's own, by default. */
  readonly nodePath?: string
}

/**
 * What each installed client publishes, and the one press that installs it. Nothing here connects,
 * disconnects or decides: the install runs beside whatever is running the old client, and the
 * coordinator tells the adapters afterwards (ADR-0042).
 */
export class ProviderClients {
  private readonly cache = new Map<string, { version: string; expiresAt: number }>()
  private readonly fetchImpl: FetchLike
  private readonly run: RunLike
  private readonly now: () => number
  private readonly npmPath: () => Promise<string | undefined>
  private readonly misePath: () => Promise<string | undefined>
  private readonly nodePath: string
  constructor(options: ProviderClientsOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.run = options.run ?? defaultRun
    this.now = options.now ?? Date.now
    this.npmPath = options.npmPath ?? defaultNpmPath
    this.misePath = options.misePath ?? defaultMisePath
    this.nodePath = options.nodePath ?? process.execPath
  }

  /** The published version, or undefined when the registry cannot be read. A failed check is not a finding. */
  async publishedVersion(provider: ProviderId): Promise<string | undefined> {
    const packageName = CLIENT_PACKAGES[provider]
    if (!packageName) return undefined
    const cached = this.cache.get(packageName)
    if (cached && cached.expiresAt > this.now()) return cached.version
    try {
      const response = await this.fetchImpl(`${REGISTRY}/${packageName.split('/').map(encodeURIComponent).join('/')}/latest`, {
        redirect: 'error', signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
        // The registry answers 406 to the abbreviated packument type on this endpoint; it wants plain JSON.
        headers: { accept: 'application/json' },
      })
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return undefined }
      const body = await response.text()
      if (body.length > REGISTRY_MAX_BYTES) return undefined
      const version = published.parse(JSON.parse(body)).version
      this.cache.set(packageName, { version, expiresAt: this.now() + PUBLISHED_CACHE_MS })
      return version
    } catch { return undefined }
  }

  /** One client's reading. `installed` is the version the adapter connected to; without one nothing is claimed. */
  async check(provider: ProviderId, installed: string, executable: string | undefined,
    environment: NodeJS.ProcessEnv = process.env): Promise<ProviderClientUpdate> {
    const install = await detectClientInstall(provider, executable, environment)
    const action = await updateActionFor(provider, install, executable, this.npmPath, this.misePath)
    const byHand = action?.byHand ?? byHandFor(provider, install)
    const latest = install.channel === 'devin-app' ? undefined : await this.publishedVersion(provider)
    const behind = Boolean(installed && latest && isComparableVersion(installed) && isComparableVersion(latest)
      && compareClientVersions(installed, latest) < 0)
    return {
      id: provider, installed, ...(latest ? { published: latest } : {}), behind, channel: install.channel,
      ...(action ? { command: action.command, steps: action.installStep ? 2 : 1 } : byHand ? { command: byHand[0]! } : {}),
      ...(byHand ? { byHand: [...byHand] } : {}), canInstall: Boolean(action && behind),
      checkedAt: new Date(this.now()).toISOString(), state: 'idle',
    }
  }

  /**
   * Install the published version through the channel that owns this install. `onStep` hears each step as it starts,
   * counted from 1: Grok Build under mise has two, the upgrade and then its package's install step.
   */
  async install(provider: ProviderId, executable: string | undefined,
    environment: NodeJS.ProcessEnv = process.env, onStep?: (step: number) => void): Promise<InstallResult> {
    const install = await detectClientInstall(provider, executable, environment)
    const action = await updateActionFor(provider, install, executable, this.npmPath, this.misePath)
    if (!action) {
      return { ok: false, detail: install.channel === 'devin-app'
        ? `${PROVIDER_LABELS[provider]} updates with the Devin app.`
        : install.channel === 'mise' ? `Sotto could not find mise, so it did not update ${PROVIDER_LABELS[provider]}.`
        : `Sotto does not know how ${PROVIDER_LABELS[provider]} was installed, so it will not replace it.` }
    }
    onStep?.(1)
    // Elsewhere npm deletes a running program's folder like any other, so nothing is left to clear.
    const packageName = CLIENT_PACKAGES[provider]
    if (process.platform === 'win32' && install.channel === 'npm' && executable && packageName) {
      const folder = await npmPackageFolder(packageName, executable, environment)
      if (folder) await clearLeftoverPackage(folder)
    }
    const upgrade = await this.run(action.executable, action.args, action.asNode, action.cwd ? { cwd: action.cwd } : undefined)
    if (!upgrade.ok) return { ...upgrade, step: 1, failure: DOWNLOAD_FAILED.test(upgrade.printed ?? upgrade.detail ?? '') ? 'download' : 'installer' }
    if (!action.installStep) return upgrade
    onStep?.(2)
    return this.installStep(action.installStep)
  }

  /**
   * Grok Build's install step, which mise's npm backend does not run: `node bin/postinstall.js` in the package folder of
   * the version mise now uses, which copies the program into `~/.grok/bin` and moves its `grok` link there. It runs on
   * this process's own Node, needs no network, and is only ever this one file of the package mise installed.
   */
  private async installStep(step: NonNullable<UpdateAction['installStep']>): Promise<InstallResult> {
    const failed = (result: RunResult): InstallResult => ({ ...result, ok: false, step: 2, failure: 'install-step' })
    const where = await this.run(step.mise, ['where', step.tool], false, { cwd: homedir() })
    const root = where.stdout?.trim().split(/\r?\n/u).at(-1)?.trim()
    if (!where.ok || !root || !isAbsolute(root)) return failed(where.ok ? { ok: false, detail: `mise did not say where it installed ${step.tool}.` } : where)
    const folder = join(root, 'node_modules', ...step.packageName.split('/'))
    const script = join(folder, 'bin', 'postinstall.js')
    try { await access(script, constants.F_OK) } catch { return failed({ ok: false, detail: 'The package mise installed has no install step at bin/postinstall.js.' }) }
    const ran = await this.run(this.nodePath, [script], true, { cwd: folder })
    return ran.ok ? ran : failed(ran)
  }
}

/**
 * Where each client is installed, asked of the same discovery the adapters use, so the update check
 * cannot disagree with the connection about which binary it means.
 */
export async function locateClient(provider: ProviderId): Promise<string | undefined> {
  switch (provider) {
    case 'claude': return (await findClaudeExecutable()) ?? undefined
    case 'codex': return (await findCodexExecutable()) ?? undefined
    case 'grok': return findGrokExecutable()
    case 'devin': return findDevinExecutable()
  }
}
