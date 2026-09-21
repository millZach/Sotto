import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path'
import { z } from 'zod'
import { PROVIDER_LABELS, type ClientChannel, type ProviderClientUpdate, type ProviderId } from '../../shared/agents'
import { compareClientVersions, isComparableVersion } from './clientVersions'
import { findDevinExecutable } from './devinRpc'
import { findGrokExecutable } from './grokRpc'
import { findClaudeExecutable } from './subscriptionClaude'
import { findExecutable as findCodexExecutable } from './subscriptionCodex'

export { clientVersionOf, compareClientVersions, isComparableVersion } from './clientVersions'

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
export type RunLike = (executable: string, args: readonly string[]) => Promise<RunResult>


const MANAGED_ELSEWHERE = [`${sep}.bun${sep}`, `${sep}pnpm${sep}`, `${sep}.pnpm${sep}`, `${sep}.volta${sep}`, `${sep}.mise${sep}`, 'homebrew', 'linuxbrew']

/**
 * Which channel owns this install, from the path it was found at. npm global bin directories keep
 * the package beside or above them, so the package's own folder is the evidence rather than a guess
 * from the directory's name. A manager Sotto does not drive is named, not driven: replacing a bun or
 * Homebrew install with an npm one leaves two clients and the wrong one first on PATH.
 */
export async function detectClientChannel(provider: ProviderId, executable: string | undefined): Promise<ClientChannel> {
  if (provider === 'devin') return 'devin-app'
  if (!executable || !isAbsolute(executable)) return 'unknown'
  const lower = executable.toLowerCase()
  if (MANAGED_ELSEWHERE.some(marker => lower.includes(marker))) return 'unknown'
  const packageName = CLIENT_PACKAGES[provider]
  if (packageName) {
    const bin = dirname(executable)
    for (const root of [join(bin, 'node_modules'), join(dirname(bin), 'lib', 'node_modules'), join(dirname(bin), 'node_modules')]) {
      try { await access(join(root, ...packageName.split('/'), 'package.json'), constants.F_OK); return 'npm' } catch { /* Try the next global layout. */ }
    }
  }
  // Claude Code's own installer owns ~/.local/bin/claude and updates it in place.
  if (provider === 'claude' && (lower.includes(`${sep}.local${sep}bin${sep}`) || lower.includes(`${sep}.claude${sep}`))) return 'claude-installer'
  return 'unknown'
}

export interface UpdateAction { readonly command: string; readonly executable: string; readonly args: readonly string[] }
/**
 * What a press runs. The package names come from this file's own table and never from the registry's
 * answer or from anything the user typed, which is what makes the Windows shell hop safe: cmd.exe is
 * needed because npm on Windows is a batch file, and every word of the line is a constant.
 */
export async function updateActionFor(provider: ProviderId, channel: ClientChannel, executable: string | undefined,
  npmPath: () => Promise<string | undefined> = defaultNpmPath): Promise<UpdateAction | undefined> {
  if (channel === 'npm') {
    const packageName = CLIENT_PACKAGES[provider]
    if (!packageName) return undefined
    const command = `npm install -g ${packageName}@latest`
    const npm = await npmPath()
    if (!npm) return undefined
    return process.platform === 'win32'
      ? { command, executable: process.env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${npm}" install -g ${packageName}@latest`] }
      : { command, executable: npm, args: ['install', '-g', `${packageName}@latest`] }
  }
  if (channel === 'claude-installer' && executable) return { command: 'claude update', executable, args: ['update'] }
  return undefined
}

const defaultNpmPath = (): Promise<string | undefined> => findOnPath(process.platform === 'win32' ? ['npm.cmd', 'npm.exe'] : ['npm'])

async function findOnPath(names: readonly string[]): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? '').split(delimiter).map(entry => entry.replace(/^"|"$/gu, '')).filter(isAbsolute)) {
    for (const name of names) {
      const candidate = join(directory, name)
      try { await access(candidate, constants.F_OK); return candidate } catch { /* Try the next entry. */ }
    }
  }
  return undefined
}

const defaultRun: RunLike = (executable, args) => new Promise(resolve => {
  execFile(executable, [...args], { windowsHide: true, shell: false, timeout: UPDATE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8' },
    (error, _stdout, stderr) => {
      if (!error) { resolve({ ok: true }); return }
      // The installer's own last words, bounded, with no path or token echoed back beyond them.
      const tail = String(stderr).split('\n').map(line => line.trim()).filter(Boolean).at(-1)
      resolve(tail ? { ok: false, detail: tail.slice(0, 200) } : { ok: false })
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
        headers: { accept: 'application/vnd.npm.install-v1+json' },
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
  async check(provider: ProviderId, installed: string, executable: string | undefined): Promise<ProviderClientUpdate> {
    const channel = await detectClientChannel(provider, executable)
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
  async install(provider: ProviderId, executable: string | undefined): Promise<RunResult> {
    const channel = await detectClientChannel(provider, executable)
    const action = await updateActionFor(provider, channel, executable, this.npmPath)
    if (!action) {
      return { ok: false, detail: channel === 'devin-app'
        ? `${PROVIDER_LABELS[provider]} updates with the Devin app.`
        : `Sotto does not know how ${PROVIDER_LABELS[provider]} was installed, so it will not replace it.` }
    }
    return this.run(action.executable, action.args)
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

