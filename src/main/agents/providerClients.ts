import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path'
import { z } from 'zod'
import { PROVIDER_LABELS, type ClientChannel, type ProviderClientUpdate, type ProviderId } from '../../shared/agents'
import { compareClientVersions, isComparableVersion } from './clientVersions'
import { installerDetail } from './installerDetail'
import { findDevinExecutable } from './devinRpc'
import { findGrokExecutable } from './grokRpc'
import { findClaudeExecutable } from './subscriptionClaude'
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
export interface RunResult { readonly ok: boolean; readonly detail?: string }
export type RunLike = (executable: string, args: readonly string[], asNode?: boolean) => Promise<RunResult>


const MANAGED_ELSEWHERE = [`${sep}.bun${sep}`, `${sep}pnpm${sep}`, `${sep}.pnpm${sep}`, `${sep}.volta${sep}`, `${sep}.mise${sep}`, 'homebrew', 'linuxbrew']

/** The client's own home, when its own installer owns the binary there: `~/.local/bin/claude.exe`. */
function ownHome(provider: ProviderId, environment: NodeJS.ProcessEnv): readonly string[] {
  const home = homedir()
  if (provider === 'claude') return [join(home, '.local', 'bin'), join(home, '.claude')]
  if (provider === 'grok') {
    const grokHome = environment.GROK_HOME && isAbsolute(environment.GROK_HOME) ? environment.GROK_HOME : join(home, '.grok')
    return [join(grokHome, 'bin')]
  }
  return []
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
async function npmOwns(packageName: string, executable: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  const bin = dirname(executable)
  const roots = [...npmGlobalRoots(environment), join(bin, 'node_modules'), join(dirname(bin), 'lib', 'node_modules'), join(dirname(bin), 'node_modules')]
  for (const root of roots) {
    try { await access(join(root, ...packageName.split('/'), 'package.json'), constants.F_OK); return true } catch { /* Try the next global layout. */ }
  }
  return false
}

/**
 * Which channel owns this install, from the path it was found at and from what is installed where.
 *
 * The evidence, in order: a manager Sotto will not drive, then npm, then the client's own home. npm
 * shows itself three ways, and the live run this feature was written against needed all three: the
 * package's vendored binary buried inside `node_modules` (Codex), a launcher beside its package, and
 * — the one that is easy to get wrong — a package in the npm global root whose real binary lives in
 * the client's own home. Grok Build is that third case: 142 MB of `~/.grok/bin/grok.exe` that npm's
 * install script put there, and `grok update --check --json` says `"installer":"npm"` itself. Only a
 * client npm does not own, like Claude Code's own installer in `~/.local/bin`, updates itself.
 */
export async function detectClientChannel(provider: ProviderId, executable: string | undefined,
  environment: NodeJS.ProcessEnv = process.env): Promise<ClientChannel> {
  if (provider === 'devin') return 'devin-app'
  if (!executable || !isAbsolute(executable)) return 'unknown'
  const lower = executable.toLowerCase()
  if (MANAGED_ELSEWHERE.some(marker => lower.includes(marker))) return 'unknown'
  if (lower.split(sep).includes('node_modules')) return 'npm'
  const packageName = CLIENT_PACKAGES[provider]
  if (packageName && await npmOwns(packageName, executable, environment)) return 'npm'
  if (ownHome(provider, environment).some(directory => within(executable, directory))) return 'self-update'
  return 'unknown'
}

export interface UpdateAction { readonly command: string; readonly executable: string; readonly args: readonly string[]; readonly asNode?: boolean }
/**
 * What a press runs. The package names come from this file's own table and never from the registry's
 * answer or from anything the user typed.
 *
 * npm is run as `npm-cli.js` under this process's own Node rather than through `npm.cmd`, because
 * the shell hop is where the first live run of this broke: a `cmd /s /c` line naming npm's batch
 * file loses its quoting and answers "operable program or batch file". No shell, no quoting, same npm.
 */
export async function updateActionFor(provider: ProviderId, channel: ClientChannel, executable: string | undefined,
  npmPath: () => Promise<string | undefined> = defaultNpmPath): Promise<UpdateAction | undefined> {
  if (channel === 'npm') {
    const packageName = CLIENT_PACKAGES[provider]
    if (!packageName) return undefined
    const command = `npm install -g ${packageName}@latest`
    const cli = await npmPath()
    if (!cli) return undefined
    return { command, executable: process.execPath, args: [cli, 'install', '-g', `${packageName}@latest`], asNode: true }
  }
  if (channel === 'self-update' && executable) {
    const name = provider === 'claude' ? 'claude' : 'grok'
    return { command: `${name} update`, executable, args: ['update'] }
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

const defaultRun: RunLike = (executable, args, asNode) => new Promise(resolve => {
  // ELECTRON_RUN_AS_NODE turns this app's own binary into the Node that runs npm's CLI.
  const env = asNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
  execFile(executable, [...args], { env, windowsHide: true, shell: false, timeout: UPDATE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8' },
    (error, _stdout, stderr) => {
      if (!error) { resolve({ ok: true }); return }
      const detail = installerDetail(String(stderr))
      resolve(detail ? { ok: false, detail } : { ok: false })
    })
})

export interface ProviderClientsOptions {
  readonly fetchImpl?: FetchLike
  readonly run?: RunLike
  readonly now?: () => number
  /** Where npm is. Injected so a test never depends on the machine's own PATH. */
  readonly npmPath?: () => Promise<string | undefined>
}

/**
 * What each installed client publishes, and the one press that installs it. Nothing here connects,
 * disconnects or decides: the coordinator owns that order, because only it knows which threads are working.
 */
export class ProviderClients {
  private readonly cache = new Map<string, { version: string; expiresAt: number }>()
  private readonly fetchImpl: FetchLike
  private readonly run: RunLike
  private readonly now: () => number
  private readonly npmPath: () => Promise<string | undefined>
  constructor(options: ProviderClientsOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.run = options.run ?? defaultRun
    this.now = options.now ?? Date.now
    this.npmPath = options.npmPath ?? defaultNpmPath
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
    const channel = await detectClientChannel(provider, executable, environment)
    const action = await updateActionFor(provider, channel, executable, this.npmPath)
    const latest = channel === 'devin-app' ? undefined : await this.publishedVersion(provider)
    const behind = Boolean(installed && latest && isComparableVersion(installed) && isComparableVersion(latest)
      && compareClientVersions(installed, latest) < 0)
    return {
      id: provider, installed, ...(latest ? { published: latest } : {}), behind, channel,
      ...(action ? { command: action.command } : {}), canInstall: Boolean(action && behind),
      checkedAt: new Date(this.now()).toISOString(), state: 'idle',
    }
  }

  /** Install the published version through the channel that owns this install. */
  async install(provider: ProviderId, executable: string | undefined,
    environment: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
    const channel = await detectClientChannel(provider, executable, environment)
    const action = await updateActionFor(provider, channel, executable, this.npmPath)
    if (!action) {
      return { ok: false, detail: channel === 'devin-app'
        ? `${PROVIDER_LABELS[provider]} updates with the Devin app.`
        : `Sotto does not know how ${PROVIDER_LABELS[provider]} was installed, so it will not replace it.` }
    }
    return this.run(action.executable, action.args, action.asNode)
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

