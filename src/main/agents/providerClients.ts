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
import { findClaudeExecutable } from './subscriptionClaude'
import { findCli, miseDataFolder, withCliPath } from './cliLookup'
import { findExecutable as findCodexExecutable } from './subscriptionCodex'

/** The package whose `latest` tag says what each client has published. Devin ships inside its own app. */
export const CLIENT_PACKAGES: Readonly<Partial<Record<ProviderId, string>>> = {
  claude: '@anthropic-ai/claude-code', codex: '@openai/codex', grok: '@xai-official/grok',
  // OpenCode 2's package; OpenCode 1 is `opencode-ai`, and Sotto never moves an install between them (ADR-0087).
  opencode: '@opencode/cli',
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
  // for that package, which is what npm updates.
  const inside = parts.findIndex((part, index) => part.toLowerCase() === 'node_modules'
    && names.every((name, offset) => {
      const found = parts[index + 1 + offset]?.toLowerCase(), wanted = name.toLowerCase()
      return found === wanted || (offset === names.length - 1 && found?.startsWith(`${wanted}-`))
    }))
  const bin = dirname(executable)
  const ownPrefix = [join(bin, 'node_modules'), join(dirname(bin), 'lib', 'node_modules'), join(dirname(bin), 'node_modules')]
  const real = platform === 'win32' ? undefined : await realpath(executable).catch(() => executable)
  // A link out of its own folder. Grok Build's `~/.grok/bin/grok` links to `grok-<version>` beside it and is still npm's,
  // even when `~/.grok` is npm's prefix too, so a package there claims that link without resolving into it.
  const linked = real !== undefined && dirname(real) !== await realpath(bin).catch(() => bin)
  const grokVersionLink = packageName === CLIENT_PACKAGES.grok && real !== undefined && !linked
    && basename(real).toLowerCase().startsWith(`${basename(executable).toLowerCase()}-`)
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
/** The command to run on the machine by hand, a line each, or undefined when Sotto cannot name one. */
export function byHandFor(provider: ProviderId, install: ClientInstall, platform: NodeJS.Platform = process.platform,
  releaseAgeFlag = false): readonly string[] | undefined {
  const packageName = CLIENT_PACKAGES[provider]
  switch (install.channel) {
    case 'npm': return packageName
      ? [`npm install -g${install.npmPrefix ? ` --prefix ${shellArgument(install.npmPrefix, platform)}` : ''} --allow-scripts=${packageName} ${packageName}@latest`]
      : undefined
    case 'self-update': return provider === 'muse' && install.muse ? museByHand(install.muse) : provider === 'claude' || provider === 'grok' ? [`${provider} update`]
      : provider === 'opencode' ? ['opencode upgrade'] : undefined
    case 'mise': {
      if (!install.miseTool) return undefined
      const command = `mise upgrade ${install.miseTool}${releaseAgeFlag ? ' --minimum-release-age 0s' : ''}`
      // A child cmd keeps the Windows override inside this one command, in either PowerShell or cmd.
      const upgrade = platform === 'win32' ? `cmd /c "set MISE_MINIMUM_RELEASE_AGE=0s&& ${command}"`
        : `MISE_MINIMUM_RELEASE_AGE=0s ${command}`
      // Checked on forge on September 29, 2026: the package's install step, run in the folder mise installed it in.
      return needsInstallStep(provider, install.miseTool) && packageName
        ? [upgrade, `cd "$(mise where ${install.miseTool})/node_modules/${packageName}"`, GROK_INSTALL_STEP] : [upgrade]
    }
    default: return install.byHand?.length ? [...install.byHand] : undefined
  }
}
/** A path as one argument to type into a shell: bare when nothing in it needs quoting, else quoted for that platform's shell. */
function shellArgument(value: string, platform: NodeJS.Platform): string {
  if (/^[\w/\\.:~+-]+$/u.test(value)) return value
  return platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`
}
const needsInstallStep = (provider: ProviderId, miseTool: string): boolean => provider === 'grok' && miseTool === `npm:${CLIENT_PACKAGES.grok}`

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
  npmPath: () => Promise<string | undefined> = defaultNpmPath, misePath: () => Promise<string | undefined> = defaultMisePath,
  miseReleaseAgeFlag: (executable: string) => Promise<boolean> = defaultMiseReleaseAgeFlag): Promise<UpdateAction | undefined> {
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
  if (found.channel === 'self-update' && provider !== 'muse' && executable && byHand) return { command: byHand[0]!, byHand, executable, args: [provider === 'opencode' ? 'upgrade' : 'update'] }
  if (found.channel === 'mise' && found.miseTool && byHand) {
    const mise = await misePath()
    if (!mise) return undefined
    const packageName = CLIENT_PACKAGES[provider]
    const supportsFlag = await miseReleaseAgeFlag(mise)
    const commands = byHandFor(provider, found, process.platform, supportsFlag)!
    // Update is an explicit request to install now. mise's release-age delay can otherwise exit successfully
    // without changing the client. Older mise rejects the CLI flag but ignores this environment variable.
    // The flag also overrides a per-tool delay, which takes precedence over the global environment setting.
    // Override only this process, on desktops and hosts alike; leave the app and mise's saved policy alone.
    return { command: commands[0]!, byHand: commands, executable: mise,
      args: ['upgrade', found.miseTool, ...(supportsFlag ? ['--minimum-release-age', '0s'] : [])], cwd: homedir(), env: { MISE_MINIMUM_RELEASE_AGE: '0s' },
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
    this.platform = options.platform ?? process.platform
  }

  /** The published version, or undefined when the registry cannot be read. A failed check is not a finding. */
  async publishedVersion(provider: ProviderId, museChannel: MuseChannel = 'muse-stable'): Promise<string | undefined> {
    if (provider === 'muse') return this.publishedMuseVersion(museChannel)
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

  private async publishedMuseVersion(channel: MuseChannel): Promise<string | undefined> {
    // Even an untyped caller cannot turn a channel response or a setting into another endpoint.
    if (channel !== 'muse-stable' && channel !== 'muse-canary') return undefined
    const key = `muse:${channel}`, cached = this.cache.get(key)
    if (cached && cached.expiresAt > this.now()) return cached.version
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

  /** One client's reading. `installed` is the version the adapter connected to; without one nothing is claimed. */
  async check(provider: ProviderId, installed: string, executable: string | undefined,
    environment: NodeJS.ProcessEnv = process.env): Promise<ProviderClientUpdate> {
    const install = await detectClientInstall(provider, executable, environment, this.platform)
    const action = await updateActionFor(provider, install, executable, this.npmPath, this.misePath, this.miseReleaseAgeFlag)
    const byHand = action?.byHand ?? byHandFor(provider, install)
    const museChannel = provider === 'muse' ? await museReleaseChannel(executable, environment) : undefined
    const latest = install.channel === 'devin-app' || provider === 'muse' && museChannel === undefined ? undefined : await this.publishedVersion(provider, museChannel)
    const behind = provider === 'muse'
      ? Boolean(latest && (compareMuseVersions(installed, latest) ?? 0) < 0)
      : Boolean(installed && latest && isComparableVersion(installed) && isComparableVersion(latest) && compareClientVersions(installed, latest) < 0)
    const makerUpdate = provider === 'muse' && Boolean(install.muse)
    return {
      id: provider, installed, ...(latest ? { published: latest } : {}), behind, channel: install.channel,
      ...(makerUpdate ? { steps: 1 } : action ? { command: action.command, steps: action.installStep ? 2 : 1 } : byHand ? { command: byHand[0]! } : {}),
      ...(byHand ? { byHand: [...byHand] } : {}), canInstall: Boolean((action || makerUpdate) && behind),
      checkedAt: new Date(this.now()).toISOString(), state: 'idle',
    }
  }

  /**
   * Install the published version through the channel that owns this install. `onStep` hears each step as it starts,
   * counted from 1: Grok Build under mise has two, the upgrade and then its package's install step.
   */
  async install(provider: ProviderId, executable: string | undefined,
    environment: NodeJS.ProcessEnv = process.env, onStep?: (step: number) => void): Promise<InstallResult> {
    const install = await detectClientInstall(provider, executable, environment, this.platform)
    if (provider === 'muse' && install.muse) {
      onStep?.(1)
      const updated = await installMuseClient(install.muse, environment, {
        fetchImpl: this.fetchImpl,
        run: (runner, args, updateEnvironment) => this.run(runner, args, false, { environment: updateEnvironment }),
      })
      return updated.ok ? updated : { ...updated, step: 1, failure: updated.failure ?? (DOWNLOAD_FAILED.test(updated.printed ?? updated.detail ?? '') ? 'download' : 'installer') }
    }
    const action = await updateActionFor(provider, install, executable, this.npmPath, this.misePath, this.miseReleaseAgeFlag)
    if (!action) {
      return { ok: false, detail: install.channel === 'devin-app'
        ? `${PROVIDER_LABELS[provider]} updates with the Devin app.`
        : install.channel === 'mise' ? `Sotto could not find mise, so it did not update ${PROVIDER_LABELS[provider]}.`
        : install.channel === 'npm' && !install.npmPrefix ? `Sotto cannot tell which npm folder ${PROVIDER_LABELS[provider]} is in, so it did not update it. Nothing changed.`
        : `Sotto does not know how ${PROVIDER_LABELS[provider]} was installed, so it will not replace it.` }
    }
    onStep?.(1)
    // Elsewhere npm deletes a running program's folder like any other, so nothing is left to clear.
    const packageName = CLIENT_PACKAGES[provider]
    if (process.platform === 'win32' && install.channel === 'npm' && executable && packageName) {
      const folder = await npmPackageFolder(packageName, executable, environment)
      if (folder) await clearLeftoverPackage(folder)
    }
    // OpenCode's own updater reads its config folder, so it runs on Sotto's OpenCode folders and the shared allow-list,
    // never the user's own OpenCode folders or other providers' keys.
    const opencodeOwn = provider === 'opencode' && install.channel === 'self-update' && this.opencodeFolders
      ? { environment: opencodeEnvironment(withCliPath(environment, action.executable), this.opencodeFolders, opencodePassword()) } : {}
    const upgrade = await this.run(action.executable, action.args, action.asNode, action.cwd || action.env || opencodeOwn.environment
      ? { ...(action.cwd ? { cwd: action.cwd } : {}), ...(action.env ? { env: action.env } : {}), ...opencodeOwn } : undefined)
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
    case 'muse': return findMuseExecutable()
    case 'opencode': return findOpenCodeExecutable()
  }
}
