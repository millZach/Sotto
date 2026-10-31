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
import { findMuseExecutable } from './museRpc'
import { findOpenCodeExecutable, opencodeEnvironment, opencodePassword, type OpenCodeFolders } from './opencodeServer'
import { compareMuseVersions, installMuseClient, museByHand, museInstallForExecutable, musePublishedVersion, museReleaseChannel, museResponseText, MUSE_FEED_BYTES, type MuseChannel, type MuseMakerInstall } from './museClientInstall'
import { findGrokExecutable } from './grokRpc'
import { compareCursorVersions, cursorEnvironment, cursorInstallRoot, cursorProgramOf, cursorPublishedVersion, findCursorExecutable, parseCursorVersion } from './cursorRpc'
import { findDeepSeekExecutable } from './deepseekRpc'
import { findClaudeExecutable } from './subscriptionClaude'
import { findCli, miseDataFolder, withCliPath } from './cliLookup'
import { findExecutable as findCodexExecutable } from './subscriptionCodex'

/** The package whose `latest` tag says what each client has published. Devin ships inside its own app. */
export const CLIENT_PACKAGES: Readonly<Partial<Record<ProviderId, string>>> = {
  claude: '@anthropic-ai/claude-code', codex: '@openai/codex', grok: '@xai-official/grok',
  // OpenCode 2's package; OpenCode 1 is `opencode-ai`, and Sotto never moves an install between them (ADR-0087).
  opencode: '@opencode/cli',
  deepseek: '@deepseek-ai/dsh',
}
const REGISTRY = 'https://registry.npmjs.org'
/** How often each machine asks again while Sotto stays open, so a client published meanwhile is noticed (ADR-0042). */
export const CLIENT_CHECK_INTERVAL_MS = 5 * 60 * 1000
/**
 * How long an answer from the registry or Muse's channel feed is reused. Shorter than the check interval, so no
 * five-minute check ever reads an answer kept from the one before; it spares the registry only the checks that come
 * together, as when several providers connect at once. An explicit check asks afresh whatever is kept.
 */
const PUBLISHED_CACHE_MS = 4 * 60 * 1000
const REGISTRY_TIMEOUT_MS = 10_000
const REGISTRY_MAX_BYTES = 256 * 1024
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000
const published = z.object({ version: z.string().min(1).max(64) })
/** Claude Code's own release feed, which its native installer and `claude update` read (ADR-0165). */
const CLAUDE_RELEASES = 'https://downloads.claude.ai/claude-code-releases'
/** A channel answers with one version on a line, `2.1.314`, so anything longer is not an answer. */
const CLAUDE_RELEASE_BYTES = 64
const CLAUDE_RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const claudeSettings = z.object({ autoUpdatesChannel: z.enum(['latest', 'stable']).optional() })
/** The release channel a native Claude Code follows. */
export type ClaudeReleaseChannel = 'latest' | 'stable'
/** The folder Claude Code reads an organisation's managed settings from, by Claude Code's own documentation. */
export function claudeManagedFolder(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code'
}
/** The channel one settings file names, or undefined when it names none or cannot be read. */
async function channelIn(file: string): Promise<ClaudeReleaseChannel | undefined> {
  try {
    const settings = claudeSettings.safeParse(JSON.parse(await readFile(file, 'utf8')))
    return settings.success ? settings.data.autoUpdatesChannel : undefined
  } catch { return undefined }
}
/**
 * The channel `claude update` installs from: `autoUpdatesChannel` in managed settings, which Claude Code lets nothing
 * override (`managed-settings.json`, then each `managed-settings.d/*.json` in name order, the last naming one winning),
 * else in the user's own settings in `CLAUDE_CONFIG_DIR` or `~/.claude`, else `latest`, Claude Code's default.
 */
export async function claudeReleaseChannel(environment: NodeJS.ProcessEnv = process.env, managedFolder = claudeManagedFolder()): Promise<ClaudeReleaseChannel> {
  const dropIns = (await readdir(join(managedFolder, 'managed-settings.d')).catch(() => [] as string[]))
    .filter(name => name.toLowerCase().endsWith('.json') && !name.startsWith('.')).sort()
  let managed: ClaudeReleaseChannel | undefined
  for (const file of [join(managedFolder, 'managed-settings.json'), ...dropIns.map(name => join(managedFolder, 'managed-settings.d', name))]) {
    managed = await channelIn(file) ?? managed
  }
  if (managed) return managed
  const configured = environment.CLAUDE_CONFIG_DIR
  const home = configured && isAbsolute(configured) ? configured : join(homedir(), '.claude')
  return await channelIn(join(home, 'settings.json')) ?? 'latest'
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
/**
 * How one run of an installer went. `detail` is its last line and `printed` its last few, both without home folders;
 * `stdout` is what it answered, for a run that is asked something (`mise where`).
 */
export interface RunResult { readonly ok: boolean; readonly detail?: string; readonly printed?: string; readonly stdout?: string }
export interface RunOptions {
  readonly cwd?: string
  /** A complete child environment, including an installer's restricted allowlist. */
  readonly environment?: NodeJS.ProcessEnv
  /** Overrides scoped to this command, applied to its child environment. */
  readonly env?: Readonly<NodeJS.ProcessEnv>
}
export type RunLike = (executable: string, args: readonly string[], asNode?: boolean, options?: RunOptions) => Promise<RunResult>


// A client a version manager installed is that manager's to update: npm here would install a second copy elsewhere.
// mise is read before these, and only its installs folder makes a client mise's (see `miseToolOf`).
const MANAGED_ELSEWHERE = [`${sep}.bun${sep}`, `${sep}pnpm${sep}`, `${sep}.pnpm${sep}`, `${sep}.volta${sep}`, `${sep}.mise${sep}`, `${sep}mise${sep}installs${sep}`, `${sep}.asdf${sep}`, 'homebrew', 'linuxbrew']
/** The managers above that are not Homebrew, whose own Node may hold an npm global root of its own. */
const OTHER_PACKAGE_MANAGERS = MANAGED_ELSEWHERE.filter(marker => marker !== 'homebrew' && marker !== 'linuxbrew')
/** yarn classic's global packages (`%LOCALAPPDATA%\Yarn\Data\global`, `~/.config/yarn/global`), which the OpenCode lookup searches. */
const YARN_GLOBAL = [`${sep}yarn${sep}data${sep}global${sep}`, `${sep}yarn${sep}global${sep}`, `${sep}.yarn${sep}`]

/** The client's own home, when its own installer owns the binary there: `~/.local/bin/claude.exe`. */
function ownHome(provider: ProviderId, environment: NodeJS.ProcessEnv): readonly string[] {
  const home = homedir()
  if (provider === 'claude') return [join(home, '.local', 'bin'), join(home, '.claude')]
  if (provider === 'grok') return [grokBin(environment)]
  // OpenCode 2's install script (`opencode.ai/v2/install`) puts it here, and `opencode upgrade` updates it in place.
  if (provider === 'opencode') return [join(home, '.opencode', 'bin')]
  // Cursor's installer keeps each version in its own folder and `agent update` replaces them (ADR-0128).
  if (provider === 'cursor') return [cursorInstallRoot(environment), ...(process.platform === 'win32' ? [] : [join(home, '.local', 'bin')])].filter((folder): folder is string => Boolean(folder))
  return []
}
function grokBin(environment: NodeJS.ProcessEnv): string {
  return join(environment.GROK_HOME && isAbsolute(environment.GROK_HOME) ? environment.GROK_HOME : join(homedir(), '.grok'), 'bin')
}
const within = (path: string, directory: string): boolean =>
  path.toLowerCase().startsWith(`${directory.toLowerCase()}${sep}`)

/** The platform part of a client's platform package name: `darwin-arm64`, `linux-x64-musl`, `win32-x64`. */
const PLATFORM_PACKAGE = /^(?:darwin|linux|win32)-(?:x64|arm64)(?:-[a-z0-9]+)?$/u
/** The program Grok Build's install step links `~/.grok/bin/grok` to: `grok-1.0.5`. */
const GROK_VERSIONED = /^grok-\d+(?:\.\d+)*(?:\.exe)?$/iu
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
/**
 * The folder npm installed a client's package in: the one the binary sits inside, else one in a global root. With no
 * environment only the binary's own prefix is looked in, so a package elsewhere on the machine cannot claim it.
 * The binary's own prefix is asked before the global roots, so an old copy in `~/.npm-global` never claims one npm
 * installed elsewhere. Outside Windows npm links a global binary to its package, so a package in the binary's own
 * prefix claims only a binary that resolves into it, and a binary that links out of its folder (Claude Code's own
 * installer in `~/.local/share/claude`) is claimed by no global root it does not resolve into: a script of the user's own in
 * `~/.local/bin`, beside a package npm left in `~/.local/lib/node_modules`, is not that package's.
 */
async function npmPackageFolder(packageName: string, executable: string, environment: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const parts = executable.split(sep), names = packageName.split('/')
  // A platform package npm hoisted beside the client's own (`@openai/codex-darwin-arm64` beside `@openai/codex`) stands
  // for that package, which is what npm updates. Only a platform package's name does: `@openai/codex-tools` is not one.
  const inside = parts.findIndex((part, index) => part.toLowerCase() === 'node_modules'
    && names.every((name, offset) => {
      const found = parts[index + 1 + offset]?.toLowerCase(), wanted = name.toLowerCase()
      return found === wanted || (offset === names.length - 1 && found !== undefined && found.startsWith(`${wanted}-`)
        && PLATFORM_PACKAGE.test(found.slice(wanted.length + 1)))
    }))
  const bin = dirname(executable)
  const ownPrefix = [join(bin, 'node_modules'), join(dirname(bin), 'lib', 'node_modules'), join(dirname(bin), 'node_modules')]
  const real = platform === 'win32' ? undefined : await realpath(executable).catch(() => executable)
  // A link out of its own folder. Grok Build's `~/.grok/bin/grok` links to `grok-<version>` beside it and is still npm's,
  // even when `~/.grok` is npm's prefix too, so a package there claims that link without resolving into it.
  const linked = real !== undefined && dirname(real) !== await realpath(bin).catch(() => bin)
  const grokVersionLink = packageName === CLIENT_PACKAGES.grok && real !== undefined && !linked
    && bin.toLowerCase() === grokBin(environment ?? {}).toLowerCase() && GROK_VERSIONED.test(basename(real))
  const roots = [...inside > 0 ? [parts.slice(0, inside + 1).join(sep)] : [], ...ownPrefix, ...environment ? npmGlobalRoots(environment) : []]
  for (const root of roots) {
    const folder = join(root, ...names)
    const mustResolve = real !== undefined && inside <= 0 && ((ownPrefix.includes(root) && !grokVersionLink) || linked)
    if (mustResolve && !within(real, await realpath(folder).catch(() => folder))) continue
    try { await access(join(folder, 'package.json'), constants.F_OK); return folder } catch { /* Try the next global layout. */ }
  }
  return undefined
}
/**
 * The prefix npm installed a global package under: `<prefix>/lib/node_modules/<package>`, or on Windows
 * `<prefix>\node_modules\<package>` whatever the prefix is called. Anything else is not a global install Sotto can name a prefix for.
 */
export function npmPrefixOf(folder: string, packageName: string, platform: NodeJS.Platform = process.platform): string | undefined {
  let root = folder
  for (let index = 0; index < packageName.split('/').length; index += 1) root = dirname(root)
  if (basename(root).toLowerCase() !== 'node_modules') return undefined
  if (platform === 'win32') return dirname(root)
  return basename(dirname(root)).toLowerCase() === 'lib' ? dirname(dirname(root)) : undefined
}
/** npm's claim on a client, with the prefix to update it under when Sotto can name one. */
async function npmInstall(packageName: string, executable: string, environment: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform): Promise<ClientInstall | undefined> {
  const folder = await npmPackageFolder(packageName, executable, environment, platform)
  if (!folder) return undefined
  const npmPrefix = npmPrefixOf(folder, packageName, platform)
  return { channel: 'npm', ...(npmPrefix ? { npmPrefix } : {}) }
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
export interface ClientInstall {
  readonly channel: ClientChannel; readonly miseTool?: string; readonly muse?: MuseMakerInstall
  /** For a copy another package manager owns, the command that manager updates it with, which Sotto shows and never runs. */
  readonly byHand?: readonly string[]
  /**
   * For npm, the prefix the package is installed under. npm otherwise takes its global prefix from the Node running it,
   * which for Sotto is the app itself: on macOS that put Claude Code 2.1.306 in `Sotto.app/Contents/lib` and left the
   * copy in use where it was.
   */
  readonly npmPrefix?: string
}

const MANAGER_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._+-]{0,63}$/u
/**
 * The package manager that owns an OpenCode copy, and its own update command (ADR-0087): Homebrew by the Cellar formula
 * the program lives in (`opencode` in core, `opencode-v2` in the tap), scoop by its app folder, pacman by the package
 * whose record names the program. Each is named, never driven, as ADR-0042 has it for every manager Sotto does not run.
 */
export async function opencodeManager(executable: string, platform: NodeJS.Platform = process.platform,
  pacmanRecords = '/var/lib/pacman/local'): Promise<readonly string[] | undefined> {
  const real = await realpath(executable).catch(() => executable)
  // npm's copy under a manager's Node (`/opt/homebrew/lib/node_modules/@opencode/cli`) is npm's, not the manager's.
  if ([real, executable].some(path => path.toLowerCase().split(/[\\/]/u).includes('node_modules'))) return undefined
  for (const path of [real, executable]) {
    const parts = path.split(/[\\/]/u), lower = parts.map(part => part.toLowerCase())
    const cellar = lower.indexOf('cellar')
    if (cellar >= 0 && parts[cellar + 1] && MANAGER_NAME.test(parts[cellar + 1]!)) return [`brew upgrade ${parts[cellar + 1]}`]
    if (lower.some(part => part === 'homebrew' || part === 'linuxbrew' || part === '.linuxbrew')) return ['brew upgrade opencode']
    const scoop = lower.findIndex((part, index) => part === 'apps' && lower[index - 1] === 'scoop')
    if (scoop >= 0 && parts[scoop + 1] && MANAGER_NAME.test(parts[scoop + 1]!)) return [`scoop update ${parts[scoop + 1]}`]
    const shims = lower.findIndex((part, index) => part === 'shims' && lower[index - 1] === 'scoop')
    if (shims >= 0) {
      // A scoop shim names the program it runs in a `.shim` file beside it: `path = "...\\scoop\\apps\\opencode2\\current\\opencode.exe"`.
      const shim = await readFile(path.replace(/\.(?:exe|cmd|ps1)$/iu, '') + '.shim', 'utf8').catch(() => '')
      const app = /[\\/]scoop[\\/]apps[\\/]([^\\/]+)[\\/]/iu.exec(shim)?.[1]
      return [`scoop update ${app && MANAGER_NAME.test(app) ? app : 'opencode2'}`]
    }
  }
  if (platform !== 'linux' || !real.startsWith('/usr/')) return undefined
  for (const record of await readdir(pacmanRecords).catch(() => [] as string[])) {
    const name = /^(.+)-[^-]+-[^-]+$/u.exec(record)?.[1]
    if (!name || !name.toLowerCase().startsWith('opencode') || !MANAGER_NAME.test(name)) continue
    const files = await readFile(join(pacmanRecords, record, 'files'), 'utf8').catch(() => '')
    if (files.split(/\r?\n/u).includes(real.slice(1))) return [name === 'opencode' ? 'sudo pacman -Syu opencode' : `paru -Syu ${name}`]
  }
  return undefined
}

/**
 * npm may hoist OpenCode's program package (`@opencode/cli-<target>`, which the install script also downloads) beside
 * `@opencode/cli`: a program there stands for the `@opencode/cli` beside it, which is what npm updates.
 */
function opencodePlatformPackage(path: string): string[] {
  const parts = path.split(sep)
  const at = parts.findIndex((part, index) => part.toLowerCase() === 'node_modules' && parts[index + 1]?.toLowerCase() === '@opencode' && /^cli-/iu.test(parts[index + 2] ?? ''))
  return at < 0 ? [] : [join(parts.slice(0, at + 2).join(sep), 'cli', 'bin', basename(path))]
}

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
  environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<ClientInstall> {
  if (provider === 'devin') return { channel: 'devin-app' }
  if (!executable || !isAbsolute(executable)) return { channel: 'unknown' }
  const lower = executable.toLowerCase()
  const packageName = CLIENT_PACKAGES[provider]
  const inOwnHome = ownHome(provider, environment).some(directory => within(executable, directory))
  if (!inOwnHome) {
    const miseTool = await miseToolOf(provider, executable, environment)
    if (miseTool) return { channel: 'mise', miseTool }
  }
  if (provider === 'opencode') {
    const real = await realpath(executable).catch(() => executable)
    // bun, pnpm, yarn, Volta and asdf lay a global package out the way npm does, so they are asked before npm: `npm install -g`
    // over their copy would install a second one and leave theirs as it was (ADR-0042).
    if ([executable, real].some(path => [...OTHER_PACKAGE_MANAGERS, ...YARN_GLOBAL].some(marker => path.toLowerCase().includes(marker)))) return { channel: 'unknown' }
    // bun and pnpm can live anywhere their own variable says, which the OpenCode lookup searches too.
    const managerHomes = ['BUN_INSTALL', 'PNPM_HOME'].map(name => environment[name]).filter((value): value is string => Boolean(value) && isAbsolute(value!))
    if ([executable, real].some(path => managerHomes.some(directory => within(path, directory)))) return { channel: 'unknown' }
    // npm's copy is npm's even under Homebrew's Node (`/opt/homebrew/lib/node_modules/@opencode/cli`), so npm is asked
    // before Homebrew (mise was asked above). Only the program's own prefix counts, so an npm package elsewhere on the
    // machine never claims a copy Homebrew, the install script or a system package put there.
    for (const path of new Set([executable, real, ...[executable, real].flatMap(opencodePlatformPackage)])) {
      const npm = await npmInstall(CLIENT_PACKAGES.opencode!, path, undefined, platform)
      if (npm) return npm
    }
    const byHand = await opencodeManager(executable)
    if (byHand) return { channel: 'unknown', byHand }
    return inOwnHome ? { channel: 'self-update' } : { channel: 'unknown' }
  }
  if (MANAGED_ELSEWHERE.some(marker => lower.includes(marker))) return { channel: 'unknown' }
  // Only a copy Cursor's own installer put in its version folders updates itself; any other copy is left to whoever installed it.
  if (provider === 'cursor') {
    const real = await realpath(executable).catch(() => executable)
    return [executable, real].some(path => inOwnHome || ownHome(provider, environment).some(directory => within(path, directory))) ? { channel: 'self-update' } : { channel: 'unknown' }
  }
  if (provider === 'muse') {
    const real = await realpath(executable).catch(() => executable)
    if (MANAGED_ELSEWHERE.some(marker => real.toLowerCase().includes(marker))) return { channel: 'unknown' }
    const muse = await museInstallForExecutable(executable, process.platform, environment)
    return muse ? { channel: 'self-update', muse } : { channel: 'unknown' }
  }
  const npm = packageName ? await npmInstall(packageName, executable, environment, platform) : undefined
  if (npm) return npm
  if (lower.split(sep).includes('node_modules')) return { channel: 'npm' }
  if (inOwnHome) {
    const miseTool = await miseToolOf(provider, executable, environment)
    if (miseTool) return { channel: 'mise', miseTool }
    return { channel: 'self-update' }
  }
  return { channel: 'unknown' }
}
export async function detectClientChannel(provider: ProviderId, executable: string | undefined,
  environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<ClientChannel> {
  return (await detectClientInstall(provider, executable, environment, platform)).channel
}

/** Grok Build's own install step, which mise's npm backend skips: it puts the new program in `~/.grok/bin`. */
export const GROK_INSTALL_STEP = 'node bin/postinstall.js'
/** A published version Sotto will pass to mise as `<tool>@<version>`: `2.1.310`, `1.4.12-R6909.1`, nothing that reads as an option. */
const MISE_VERSION = /^\d[0-9A-Za-z.+_-]{0,63}$/u
/**
 * What a mise update asks mise for: `install <tool>@<version>` when Sotto knows a published version it can pass, else
 * `upgrade <tool>`. Both the lines to run by hand and the arguments Sotto runs are made from it, so they cannot disagree.
 */
interface MiseTarget { readonly verb: 'install' | 'upgrade'; readonly tool: string; readonly version?: string }
function miseTarget(miseTool: string, version: string | undefined): MiseTarget {
  return version !== undefined && MISE_VERSION.test(version) ? { verb: 'install', tool: `${miseTool}@${version}`, version } : { verb: 'upgrade', tool: miseTool }
}
/**
 * The command to run on the machine by hand, a line each, or undefined when Sotto cannot name one. `version` is the
 * published version Sotto found, which a mise install asks for by name (see `updateActionFor`).
 */
export function byHandFor(provider: ProviderId, install: ClientInstall, platform: NodeJS.Platform = process.platform,
  releaseAgeFlag = false, version?: string): readonly string[] | undefined {
  const packageName = CLIENT_PACKAGES[provider]
  switch (install.channel) {
    case 'npm': {
      if (!packageName) return undefined
      // A Windows prefix no shell there would keep literal gets no line at all: without it npm would update another folder.
      const prefix = install.npmPrefix === undefined ? undefined : shellArgument(install.npmPrefix, platform)
      if (install.npmPrefix !== undefined && prefix === undefined) return undefined
      return [`npm install -g${prefix ? ` --prefix ${prefix}` : ''} --allow-scripts=${packageName} ${packageName}@latest`]
    }
    case 'self-update': return provider === 'muse' && install.muse ? museByHand(install.muse) : provider === 'claude' || provider === 'grok' ? [`${provider} update`]
      : provider === 'opencode' ? ['opencode upgrade'] : provider === 'cursor' ? ['agent update'] : undefined
    case 'mise': {
      if (!install.miseTool) return undefined
      const target = miseTarget(install.miseTool, version)
      const command = `mise ${target.verb} ${target.tool}${releaseAgeFlag ? ' --minimum-release-age 0s' : ''}`
      // A child cmd keeps the Windows override inside this one command, in either PowerShell or cmd.
      const upgrade = platform === 'win32' ? `cmd /c "set MISE_MINIMUM_RELEASE_AGE=0s&& ${command}"`
        : `MISE_MINIMUM_RELEASE_AGE=0s ${command}`
      const lines = target.version ? [`mise cache clear ${install.miseTool}`, upgrade] : [upgrade]
      // Checked on forge on September 29, 2026: the package's install step, run in the folder mise installed it in.
      return needsInstallStep(provider, install.miseTool) && packageName
        ? [...lines, `cd "$(mise where ${target.tool})/node_modules/${packageName}"`, GROK_INSTALL_STEP] : lines
    }
    default: return install.byHand?.length ? [...install.byHand] : undefined
  }
}
/**
 * A path as one argument to type into a shell, or undefined when it cannot be written so that it stays literal. POSIX
 * shells take anything in single quotes literally but the quote itself. On Windows the line may be typed into PowerShell
 * or cmd, so double quotes go only around a path neither would expand: no `$`, backtick, `%`, `!` or `"`.
 */
export function shellArgument(value: string, platform: NodeJS.Platform): string | undefined {
  if (platform === 'win32') return /^[\w\\/.:+-]+$/u.test(value) ? value : /[$`%!"]/u.test(value) ? undefined : `"${value}"`
  return /^[\w/.:+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}
const needsInstallStep = (provider: ProviderId, miseTool: string): boolean => provider === 'grok' && miseTool === `npm:${CLIENT_PACKAGES.grok}`
/** The line a card names as the update: the first, or for a mise install by version the install after its cache clear. */
const commandOf = (install: ClientInstall, lines: readonly string[], version: string | undefined): string =>
  lines[install.channel === 'mise' && install.miseTool && miseTarget(install.miseTool, version).version ? 1 : 0]!

export interface UpdateAction {
  readonly command: string; readonly executable: string; readonly args: readonly string[]; readonly asNode?: boolean
  /** The same update as lines to run by hand, for when it fails. */
  readonly byHand: readonly string[]
  /** Where to run it: mise from the home folder, so the global config applies and no project's own mise.toml does. */
  readonly cwd?: string
  /** Overrides for this install process only, never this app's environment or a saved setting. */
  readonly env?: Readonly<NodeJS.ProcessEnv>
  /** Grok Build under mise: after the upgrade, its package's install step, in the folder `mise where` names. */
  readonly installStep?: { readonly mise: string; readonly tool: string; readonly packageName: string }
  /**
   * A mise install of one published version: before it runs, mise's cache of the tool is cleared and its version list
   * is asked what it holds of `version`, which decides whether the install runs and how a failed one is worded. `releaseAge` says this mise takes the release-age flag.
   */
  readonly miseList?: { readonly tool: string; readonly version: string; readonly releaseAge: boolean }
}
/**
 * What a press runs. The package names come from this file's own table, and a mise tool's name from mise's own record
 * beside its installs, never from the registry's answer or from anything the user typed.
 *
 * npm is run as `npm-cli.js` under this process's own Node rather than through `npm.cmd`, because
 * the shell hop is where the first live run of this broke: a `cmd /s /c` line naming npm's batch
 * file loses its quoting and answers "operable program or batch file". No shell, no quoting, same npm.
 * mise is run as the mise binary itself, never through a shim, which would run the tool instead.
 *
 * Given the published `version`, mise installs that version by name rather than upgrading to the newest it knows.
 * mise reads its version lists through caches of its own, and `mise upgrade` answers "up to date" and exits 0 while
 * they lag: on forge on October 23, 2026 Claude Code 2.1.310 was on npm and GitHub for half an hour while
 * `mise upgrade claude` still found 2.1.309. Clearing the tool's cache made `mise ls-remote` list 2.1.310, but
 * `mise upgrade` still resolved the newest version through another cache; `mise install claude@2.1.310` installed it,
 * and mise's `latest` link moved to it. Without a version, mise upgrades as it always has.
 */
export async function updateActionFor(provider: ProviderId, install: ClientChannel | ClientInstall, executable: string | undefined,
  npmPath: () => Promise<string | undefined> = defaultNpmPath, misePath: () => Promise<string | undefined> = defaultMisePath,
  miseReleaseAgeFlag: (executable: string) => Promise<boolean> = defaultMiseReleaseAgeFlag, version?: string): Promise<UpdateAction | undefined> {
  const found: ClientInstall = typeof install === 'string' ? { channel: install } : install
  const byHand = byHandFor(provider, found)
  if (found.channel === 'npm') {
    const packageName = CLIENT_PACKAGES[provider]
    if (!packageName || !byHand) return undefined
    // npm 12 runs no install scripts unless a package is named, and still exits 0 without them. Grok
    // Build finishes its install in one, so this one package's scripts are allowed, the way T3 Code does
    // it. An older npm warns about a config it does not know and installs all the same.
    const allowScripts = `--allow-scripts=${packageName}`
    // Run under this app's Node, npm would install into the app (`Sotto.app/Contents/lib` on macOS) and leave the copy
    // in use as it was. Windows' npm names its own prefix in its builtin npmrc, so there an unnamed one stays npm's.
    if (!found.npmPrefix && process.platform !== 'win32') return undefined
    const cli = await npmPath()
    if (!cli) return undefined
    return { command: byHand[0]!, byHand, executable: process.execPath, asNode: true,
      args: [cli, 'install', '-g', ...found.npmPrefix ? ['--prefix', found.npmPrefix] : [], allowScripts, `${packageName}@latest`] }
  }
  // Cursor's program on Windows is its own node.exe running the index.js beside it, so `update` follows that script.
  if (found.channel === 'self-update' && provider === 'cursor' && executable && byHand) { const program = cursorProgramOf(executable); return { command: byHand[0]!, byHand, executable: program.executable, args: [...program.args, 'update'] } }
  if (found.channel === 'self-update' && provider !== 'muse' && executable && byHand) return { command: byHand[0]!, byHand, executable, args: [provider === 'opencode' ? 'upgrade' : 'update'] }
  if (found.channel === 'mise' && found.miseTool && byHand) {
    const mise = await misePath()
    if (!mise) return undefined
    const packageName = CLIENT_PACKAGES[provider]
    const supportsFlag = await miseReleaseAgeFlag(mise)
    const target = miseTarget(found.miseTool, version)
    const commands = byHandFor(provider, found, process.platform, supportsFlag, version)!
    // Update is an explicit request to install now. mise's release-age delay can otherwise exit successfully
    // without changing the client. Older mise rejects the CLI flag but ignores this environment variable.
    // The flag also overrides a per-tool delay, which takes precedence over the global environment setting.
    // Override only this process, on desktops and hosts alike; leave the app and mise's saved policy alone.
    return { command: commandOf(found, commands, version), byHand: commands, executable: mise,
      args: [target.verb, target.tool, ...(supportsFlag ? ['--minimum-release-age', '0s'] : [])], cwd: homedir(), env: { MISE_MINIMUM_RELEASE_AGE: '0s' },
      ...(target.version ? { miseList: { tool: found.miseTool, version: target.version, releaseAge: supportsFlag } } : {}),
      ...(needsInstallStep(provider, found.miseTool) && packageName ? { installStep: { mise, tool: target.tool, packageName } } : {}) }
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

/** Help is a local read, not an install or a version lookup. Older mise has no release-age option. */
const defaultMiseReleaseAgeFlag = (executable: string): Promise<boolean> => new Promise(resolve => {
  execFile(executable, ['upgrade', '--help'], { env: withCliPath(process.env, executable), windowsHide: true, shell: false,
    timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8' },
  (error, stdout) => resolve(!error && /--minimum-release-age\b/u.test(String(stdout))))
})

const RUN_OUTPUT_BYTES = 1024 * 1024
const defaultRun: RunLike = (executable, args, asNode, options) => new Promise(resolve => {
  // ELECTRON_RUN_AS_NODE turns this app's own binary into the Node that runs npm's CLI.
  // A client's own updater gets the PATH the CLI lookup gave the client (ADR-0036): a wrapper may need its manager.
  const environment = options?.environment ?? (asNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : withCliPath(process.env, executable))
  const env = { ...environment, ...options?.env }
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
  /** Whether this mise accepts the release-age flag. Injected so fixtures do not read the machine's mise. */
  readonly miseReleaseAgeFlag?: (executable: string) => Promise<boolean>
  /** The Node that runs Grok Build's install step: this process's own, by default. */
  readonly nodePath?: string
  /** Sotto's own OpenCode folders: `opencode upgrade` runs with them, never with the user's own OpenCode folders (ADR-0087). */
  readonly opencodeFolders?: OpenCodeFolders
  /** The platform whose install layouts are read: this one's, by default. */
  readonly platform?: NodeJS.Platform
  /** Sotto's own Cursor folder: `agent update` runs with it, never with the user's own Cursor folder (ADR-0128). */
  readonly cursorConfigDirectory?: string
  /** Where Claude Code's managed settings are read: the system folder Claude Code reads, by default. */
  readonly claudeManagedFolder?: string
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
  private readonly miseReleaseAgeFlag: (executable: string) => Promise<boolean>
  private readonly nodePath: string
  private readonly opencodeFolders: OpenCodeFolders | undefined
  private readonly cursorConfigDirectory: string | undefined
  private readonly claudeManagedFolder: string
  private readonly platform: NodeJS.Platform
  constructor(options: ProviderClientsOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.run = options.run ?? defaultRun
    this.now = options.now ?? Date.now
    this.npmPath = options.npmPath ?? defaultNpmPath
    this.misePath = options.misePath ?? defaultMisePath
    this.miseReleaseAgeFlag = options.miseReleaseAgeFlag ?? defaultMiseReleaseAgeFlag
    this.nodePath = options.nodePath ?? process.execPath
    this.opencodeFolders = options.opencodeFolders
    this.cursorConfigDirectory = options.cursorConfigDirectory
    this.claudeManagedFolder = options.claudeManagedFolder ?? claudeManagedFolder()
    this.platform = options.platform ?? process.platform
  }

  /**
   * The published version, or undefined when the registry cannot be read. A failed check is not a finding. `afresh`
   * asks the registry even when an answer is kept, and keeps the new one.
   */
  async publishedVersion(provider: ProviderId, museChannel: MuseChannel = 'muse-stable', afresh = false): Promise<string | undefined> {
    if (provider === 'muse') return this.publishedMuseVersion(museChannel, afresh)
    if (provider === 'cursor') return this.publishedCursorVersion(afresh)
    const packageName = CLIENT_PACKAGES[provider]
    if (!packageName) return undefined
    const cached = this.cache.get(packageName)
    if (!afresh && cached && cached.expiresAt > this.now()) return cached.version
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

  /** The version Cursor's own install script downloads, the one place Cursor says what it has published (ADR-0128). */
  private async publishedCursorVersion(afresh: boolean): Promise<string | undefined> {
    const key = 'cursor:install', cached = this.cache.get(key)
    if (!afresh && cached && cached.expiresAt > this.now()) return cached.version
    try {
      const response = await this.fetchImpl('https://cursor.com/install', { redirect: 'error', signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS), headers: { accept: 'text/plain' } })
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return undefined }
      const body = await response.text()
      if (body.length > REGISTRY_MAX_BYTES) return undefined
      const version = cursorPublishedVersion(body)
      if (version) this.cache.set(key, { version, expiresAt: this.now() + PUBLISHED_CACHE_MS })
      return version
    } catch { return undefined }
  }

  /**
   * The version a native Claude Code's channel offers, the one `claude update` installs. npm's `latest` tag can be ahead
   * of it for hours, and a native install offered that version could not reach it (ADR-0165).
   */
  private async publishedClaudeNativeVersion(channel: ClaudeReleaseChannel, afresh: boolean): Promise<string | undefined> {
    const key = `claude-native:${channel}`, cached = this.cache.get(key)
    if (!afresh && cached && cached.expiresAt > this.now()) return cached.version
    try {
      const response = await this.fetchImpl(`${CLAUDE_RELEASES}/${channel}`, { redirect: 'error', signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS), headers: { accept: 'text/plain' } })
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return undefined }
      const body = await response.text()
      if (body.length > CLAUDE_RELEASE_BYTES) return undefined
      const version = body.trim()
      if (!CLAUDE_RELEASE.test(version)) return undefined
      this.cache.set(key, { version, expiresAt: this.now() + PUBLISHED_CACHE_MS })
      return version
    } catch { return undefined }
  }

  private async publishedMuseVersion(channel: MuseChannel, afresh: boolean): Promise<string | undefined> {
    // Even an untyped caller cannot turn a channel response or a setting into another endpoint.
    if (channel !== 'muse-stable' && channel !== 'muse-canary') return undefined
    const key = `muse:${channel}`, cached = this.cache.get(key)
    if (!afresh && cached && cached.expiresAt > this.now()) return cached.version
    try {
      const response = await this.fetchImpl(`https://api.meta.ai/muse-code/channels/${channel}`, {
        redirect: 'error', signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS), headers: { accept: 'application/json' },
      })
      const body = await museResponseText(response, MUSE_FEED_BYTES)
      const version = body === undefined ? undefined : musePublishedVersion(body, channel)
      if (version) this.cache.set(key, { version, expiresAt: this.now() + PUBLISHED_CACHE_MS })
      return version
    } catch { return undefined }
  }

  /**
   * One client's reading. `installed` is the version the adapter connected to; without one nothing is claimed. `afresh`
   * asks the registry or channel feed rather than reusing an answer it gave a few minutes ago.
   */
  async check(provider: ProviderId, installed: string, executable: string | undefined,
    environment: NodeJS.ProcessEnv = process.env, options: { readonly afresh?: boolean } = {}): Promise<ProviderClientUpdate> {
    const install = await detectClientInstall(provider, executable, environment, this.platform)
    const museChannel = provider === 'muse' ? await museReleaseChannel(executable, environment) : undefined
    // A native Claude Code is compared with what its own updater can install, and an npm one with npm's `latest` (ADR-0165).
    const claudeChannel = provider === 'claude' && install.channel === 'self-update' ? await claudeReleaseChannel(environment, this.claudeManagedFolder) : undefined
    const latest = install.channel === 'devin-app' || provider === 'muse' && museChannel === undefined ? undefined
      : claudeChannel ? await this.publishedClaudeNativeVersion(claudeChannel, options.afresh === true)
      : await this.publishedVersion(provider, museChannel, options.afresh === true)
    const behind = provider === 'muse'
      ? Boolean(latest && (compareMuseVersions(installed, latest) ?? 0) < 0)
      : provider === 'cursor' ? Boolean(latest && parseCursorVersion(installed) && compareCursorVersions(installed, latest) < 0)
      : Boolean(installed && latest && isComparableVersion(installed) && isComparableVersion(latest) && compareClientVersions(installed, latest) < 0)
    // A client behind what is published is updated to that version, which mise is asked for by name.
    const target = behind ? latest : undefined
    const action = await updateActionFor(provider, install, executable, this.npmPath, this.misePath, this.miseReleaseAgeFlag, target)
    const byHand = action?.byHand ?? byHandFor(provider, install, process.platform, false, target)
    const makerUpdate = provider === 'muse' && Boolean(install.muse)
    return {
      id: provider, installed, ...(latest ? { published: latest } : {}), behind, channel: install.channel,
      ...(makerUpdate ? { steps: 1 } : action ? { command: action.command, steps: action.installStep ? 2 : 1 } : byHand ? { command: commandOf(install, byHand, target) } : {}),
      ...(byHand ? { byHand: [...byHand] } : {}), canInstall: Boolean((action || makerUpdate) && behind),
      checkedAt: new Date(this.now()).toISOString(), state: 'idle',
    }
  }

  /**
   * Install the published version through the channel that owns this install. `onStep` hears each step as it starts,
   * counted from 1: Grok Build under mise has two, the upgrade and then its package's install step. `version` is the
   * published version the check found, which mise installs by name unless its version list holds another build of it.
   */
  async install(provider: ProviderId, executable: string | undefined,
    environment: NodeJS.ProcessEnv = process.env, onStep?: (step: number) => void, version?: string): Promise<InstallResult> {
    const install = await detectClientInstall(provider, executable, environment, this.platform)
    if (provider === 'muse' && install.muse) {
      onStep?.(1)
      const updated = await installMuseClient(install.muse, environment, {
        fetchImpl: this.fetchImpl,
        run: (runner, args, updateEnvironment) => this.run(runner, args, false, { environment: updateEnvironment }),
      })
      return updated.ok ? updated : { ...updated, step: 1, failure: updated.failure ?? (DOWNLOAD_FAILED.test(updated.printed ?? updated.detail ?? '') ? 'download' : 'installer') }
    }
    const action = await updateActionFor(provider, install, executable, this.npmPath, this.misePath, this.miseReleaseAgeFlag, version)
    if (!action) {
      return { ok: false, detail: install.channel === 'devin-app'
        ? `${PROVIDER_LABELS[provider]} updates with the Devin app.`
        : install.channel === 'mise' ? `Sotto could not find mise, so it did not update ${PROVIDER_LABELS[provider]}.`
        : install.channel === 'npm' && !install.npmPrefix ? `Sotto cannot tell which npm folder ${PROVIDER_LABELS[provider]} is in, so it did not update it. Nothing changed.`
        : `Sotto does not know how ${PROVIDER_LABELS[provider]} was installed, so it will not replace it.` }
    }
    onStep?.(1)
    // A list without the version does not stop the install: mise then installs the version as named, fetching that one
    // release. On October 27, 2026 GitHub's list of Codex releases timed out, mise's versions host stopped at
    // 0.164.0-alpha.12 and `mise ls-remote codex` ended at 0.163.0 with any cache cleared, yet `mise install codex@0.165.0`
    // installed it. A list holding another build of the version does stop it, since mise would install that build instead.
    const listing = action.miseList ? await this.miseLists(action.executable, action.miseList, action.env) : undefined
    const notListed = action.miseList && `mise does not list ${PROVIDER_LABELS[provider]} ${action.miseList.version} yet, so Sotto could not install it. Nothing was changed. Try again later.`
    if (listing === 'other-build' && notListed) return { ok: false, step: 1, failure: 'not-listed', detail: notListed }
    // Elsewhere npm deletes a running program's folder like any other, so nothing is left to clear.
    const packageName = CLIENT_PACKAGES[provider]
    if (process.platform === 'win32' && install.channel === 'npm' && executable && packageName) {
      const folder = await npmPackageFolder(packageName, executable, environment)
      if (folder) await clearLeftoverPackage(folder)
    }
    // OpenCode's own updater reads its config folder, so it runs on Sotto's OpenCode folders and the shared allow-list,
    // never the user's own OpenCode folders or other providers' keys.
    const opencodeOwn = provider === 'opencode' && install.channel === 'self-update' && this.opencodeFolders
      ? { environment: opencodeEnvironment(withCliPath(environment, action.executable), this.opencodeFolders, opencodePassword()) }
      // Cursor's updater runs with Sotto's Cursor folder and the shared allow-list, never the user's own ~/.cursor (ADR-0128).
      : provider === 'cursor' && this.cursorConfigDirectory ? { environment: cursorEnvironment(this.cursorConfigDirectory, withCliPath(environment, action.executable)) } : {}
    const upgrade = await this.run(action.executable, action.args, action.asNode, action.cwd || action.env || opencodeOwn.environment
      ? { ...(action.cwd ? { cwd: action.cwd } : {}), ...(action.env ? { env: action.env } : {}), ...opencodeOwn } : undefined)
    if (!upgrade.ok) {
      if (DOWNLOAD_FAILED.test(upgrade.printed ?? upgrade.detail ?? '')) return { ...upgrade, step: 1, failure: 'download' }
      return listing === 'missing' && notListed
        ? { ...upgrade, step: 1, failure: 'not-listed', detail: notListed }
        : { ...upgrade, step: 1, failure: 'installer' }
    }
    if (!action.installStep) return upgrade
    onStep?.(2)
    return this.installStep(action.installStep)
  }

  /**
   * What mise's version list says of the version about to be installed, read afresh: the tool's cache is cleared first,
   * which costs nothing but the next read of the list, and `mise ls-remote <tool> <version>` lists what starts with it.
   * `listed` when it has the version; `other-build` when it lacks it but has a version extending it, such as
   * `0.165.0-alpha.3` (with mise's prereleases on) or `0.165.0.1`, which mise 2026.9.10 resolves the request to instead;
   * `missing` when it has neither, and mise installs the version as named. Undefined when mise could not say, as when
   * its list could not be fetched; the install then speaks for itself.
   */
  private async miseLists(mise: string, list: NonNullable<UpdateAction['miseList']>, env: Readonly<NodeJS.ProcessEnv> | undefined): Promise<'listed' | 'other-build' | 'missing' | undefined> {
    const options = { cwd: homedir(), ...(env ? { env } : {}) }
    // A mise too old to clear one tool's cache still installs; the list below says whether it can see the version.
    await this.run(mise, ['cache', 'clear', list.tool], false, options)
    const listed = await this.run(mise, ['ls-remote', list.tool, list.version, ...(list.releaseAge ? ['--minimum-release-age', '0s'] : [])], false, options)
    if (!listed.ok) return undefined
    const lines = (listed.stdout ?? '').split(/\r?\n/u).map(line => line.trim())
    if (lines.includes(list.version)) return 'listed'
    // mise matches a version it lacks against `^<version>([-.].+)?$`, so `2.1.3100` is not a build of `2.1.310`.
    return lines.some(line => line.length > list.version.length + 1 && (line.startsWith(`${list.version}-`) || line.startsWith(`${list.version}.`)))
      ? 'other-build' : 'missing'
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
    case 'muse': return findMuseExecutable()
    case 'opencode': return findOpenCodeExecutable()
    case 'cursor': return findCursorExecutable()
    case 'deepseek': return findDeepSeekExecutable()
  }
}
