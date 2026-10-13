import { constants, access, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { findCli, type CliLookupOptions } from './cliLookup'

/** Only these public release tracks are accepted by the maker's launchers (ADR-0078). */
export type MuseChannel = 'muse-stable' | 'muse-canary'
export const MUSE_INSTALL_GUIDE = 'https://dev.meta.ai/docs/muse-code/'
const MUSE_VERSION = /^(\d+)\.(\d+)\.(\d+)-R(\d+)(?:\.(\d+))?$/u
const SEMANTIC_VERSION = /^(\d+)\.(\d+)\.(\d+)$/u
const RECORD_BYTES = 128
export const MUSE_FEED_BYTES = 16 * 1024
const INSTALLER_BYTES = 256 * 1024
const NETWORK_TIMEOUT_MS = 10_000

export interface MuseMakerInstall {
  readonly directory: string
  readonly executable: string
  readonly version: string
  readonly channel: MuseChannel
}

/** A configured channel also applies to manager installs; a malformed record is unknown, never silently stable. */
export async function museReleaseChannel(executable: string | undefined, environment: NodeJS.ProcessEnv): Promise<MuseChannel | undefined> {
  const configured = environment.MUSE_CHANNEL
  if (configured) return configured === 'muse-stable' || configured === 'muse-canary' ? configured : undefined
  if (!executable || !isAbsolute(executable)) return 'muse-stable'
  const path = join(dirname(executable), '.muse-channel')
  const present = await stat(path).then(() => true, () => false)
  if (!present) return 'muse-stable'
  const channel = await record(path)
  return channel === 'muse-stable' || channel === 'muse-canary' ? channel : undefined
}

/** A small local record, bounded while reading rather than after loading an arbitrary file. */
async function record(path: string): Promise<string | undefined> {
  try {
    const file = await open(path, 'r')
    try {
      if (!(await file.stat()).isFile()) return undefined
      const bytes = Buffer.alloc(RECORD_BYTES + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      return bytesRead <= RECORD_BYTES ? bytes.subarray(0, bytesRead).toString('utf8').trim() : undefined
    } finally { await file.close() }
  } catch { return undefined }
}

/** Native programs only: connecting must never run a shell/WSL launcher or its automatic updater. */
export async function museNativeBinary(candidate: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  try {
    const real = await realpath(candidate)
    if (!(await stat(real)).isFile()) return undefined
    await access(real, platform === 'win32' ? constants.F_OK : constants.X_OK)
    const file = await open(real, 'r')
    try {
      const head = Buffer.alloc(4096)
      const { bytesRead } = await file.read(head, 0, head.length, 0)
      if (platform === 'win32') {
        if (bytesRead < 64 || head.toString('latin1', 0, 2) !== 'MZ') return undefined
        const at = head.readUInt32LE(60)
        if (at < 64 || at + 4 > bytesRead || head.toString('latin1', at, at + 4) !== 'PE\0\0') return undefined
      } else {
        if (bytesRead < 4) return undefined
        const magic = head.readUInt32BE(0)
        // ELF, Mach-O (both byte orders and widths), and universal Mach-O.
        if (![0x7f454c46, 0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) return undefined
      }
      return candidate
    } finally { await file.close() }
  } catch { return undefined }
}

/** The maker layout is evidenced by its launcher, version record, and corresponding native binary. */
export async function museMakerInstall(directory: string, platform: NodeJS.Platform = process.platform): Promise<MuseMakerInstall | undefined> {
  if (!isAbsolute(directory)) return undefined
  const version = await record(join(directory, '.muse-version'))
  if (!version || version.length > 64 || !MUSE_VERSION.test(version)) return undefined
  const channelPath = join(directory, '.muse-channel')
  const channelPresent = await stat(channelPath).then(() => true, () => false)
  const channelRecord = await record(channelPath)
  if (channelPresent && channelRecord !== 'muse-stable' && channelRecord !== 'muse-canary') return undefined
  const channel: MuseChannel = channelRecord === 'muse-canary' ? 'muse-canary' : 'muse-stable'
  const windows = platform === 'win32'
  for (const name of windows ? ['muse.cmd', '.muse-launcher.ps1'] : ['muse']) {
    try { if (!(await stat(join(directory, name))).isFile()) return undefined } catch { return undefined }
  }
  const binary = join(directory, `muse-bin-${version}${windows ? '.exe' : ''}`)
  if (!await museNativeBinary(binary, platform)) return undefined
  const executable = await realpath(binary).catch(() => undefined)
  if (!executable) return undefined
  // A versioned link pointing outside the layout is a native copy, not evidence this installer owns it.
  const realDirectory = await realpath(directory).catch(() => undefined)
  if (!realDirectory || dirname(executable) !== realDirectory) return undefined
  return { directory: realDirectory, executable, version, channel }
}

export async function museInstallForExecutable(executable: string, platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env): Promise<MuseMakerInstall | undefined> {
  const install = await museMakerInstall(dirname(executable), platform)
  const real = await realpath(executable).catch(() => undefined)
  const configuredChannel = environment.MUSE_CHANNEL
  if (configuredChannel && configuredChannel !== 'muse-stable' && configuredChannel !== 'muse-canary') return undefined
  if (!install || real !== install.executable) return undefined
  const channel: MuseChannel = configuredChannel === 'muse-stable' || configuredChannel === 'muse-canary' ? configuredChannel : install.channel
  return { ...install, channel }
}

/** The adapter may report a native build only for the exact binary it identified at that semantic version. */
export async function museVersionForExecutable(executable: string, identified: string,
  platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const install = await museInstallForExecutable(executable, platform, {})
  return install && (identified === install.version || identified === install.version.split('-')[0]) ? install.version : undefined
}

/** The common lookup order remains intact; an explicit maker directory is the account's own preference. */
export async function findMuseNativeExecutable(environment: NodeJS.ProcessEnv = process.env,
  lookup: Omit<CliLookupOptions, 'environment'> = {}): Promise<string | undefined> {
  const platform = lookup.platform ?? process.platform
  const home = lookup.home ?? homedir()
  const configured = environment.MUSE_INSTALL_DIR && isAbsolute(environment.MUSE_INSTALL_DIR) ? environment.MUSE_INSTALL_DIR : undefined
  const local = environment.LOCALAPPDATA && isAbsolute(environment.LOCALAPPDATA) ? environment.LOCALAPPDATA : undefined
  const defaultDirectory = platform === 'win32' ? local ? join(local, 'Programs', 'muse') : undefined : join(home, '.local', 'bin')
  return findCli({ name: 'muse', ...(configured ? { first: [configured] } : {}),
    ...(defaultDirectory ? { last: [defaultDirectory] } : {}),
    accept: async candidate => (await museMakerInstall(dirname(candidate), platform))?.executable ?? await museNativeBinary(candidate, platform),
  }, { ...lookup, environment })
}

/** Native build numbers matter only when both versions actually carry them. MSP's semantic version stays honest. */
export function compareMuseVersions(installed: string, published: string): number | undefined {
  const left = MUSE_VERSION.exec(installed) ?? SEMANTIC_VERSION.exec(installed)
  const right = MUSE_VERSION.exec(published) ?? SEMANTIC_VERSION.exec(published)
  if (!left || !right) return undefined
  const length = left[4] !== undefined && right[4] !== undefined ? 5 : 3
  for (let index = 1; index <= length; index += 1) {
    const a = BigInt(left[index] ?? '0'), b = BigInt(right[index] ?? '0')
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** Read network data up to a fixed bound, cancelling oversized responses without retaining their body. */
export async function museResponseText(response: Response, limit: number): Promise<string | undefined> {
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); return undefined }
  const advertised = response.headers.get('content-length')
  if (advertised && /^\d+$/u.test(advertised) && Number(advertised) > limit) { await response.body?.cancel().catch(() => undefined); return undefined }
  if (!response.body) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > limit) { await reader.cancel().catch(() => undefined); return undefined }
      chunks.push(next.value)
    }
    return Buffer.concat(chunks, size).toString('utf8')
  } finally { reader.releaseLock() }
}

export function musePublishedVersion(body: string, channel: MuseChannel): string | undefined {
  try {
    const value: unknown = JSON.parse(body)
    if (!value || typeof value !== 'object' || !('channel' in value) || !('version' in value)
      || value.channel !== channel || typeof value.version !== 'string' || value.version.length > 64
      || value.version.trim() !== value.version || !MUSE_VERSION.test(value.version)) return undefined
    return value.version
  } catch { return undefined }
}

/** The documented command is display-only; Sotto executes a downloaded fixed file without a shell pipeline. */
export function museByHand(install: MuseMakerInstall, platform: NodeJS.Platform = process.platform): readonly string[] | undefined {
  const quoted = platform === 'win32' ? `'${install.directory.replace(/'/gu, "''")}'` : `'${install.directory.replace(/'/gu, "'\"'\"'")}'`
  const lines = platform === 'win32' ? [
    `$env:MUSE_INSTALL_DIR = ${quoted}`,
    `$env:MUSE_CHANNEL = '${install.channel}'`,
    "$env:MUSE_UPGRADE_MODE = '1'; $env:MUSE_NO_MODIFY_PATH = '1'; $env:MUSE_LOGIN = '0'",
    'irm https://dev.meta.ai/install.ps1 | iex',
  ] : [
    `export MUSE_INSTALL_DIR=${quoted}`,
    `export MUSE_CHANNEL='${install.channel}'`,
    'export MUSE_UPGRADE_MODE=1 MUSE_NO_MODIFY_PATH=1 MUSE_LOGIN=0',
    'curl -fsSL https://dev.meta.ai/install.sh | bash',
  ]
  // Never truncate a command or a path: a long root uses the maker guide instead of a misleading copy button.
  return lines.every(line => line.length <= 300) ? lines : undefined
}

const INSTALL_ENVIRONMENT = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir', 'home', 'user', 'logname', 'username', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata', 'lang', 'lc_all', 'lc_ctype', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file', 'ssl_cert_dir', 'xdg_config_home', 'xdg_data_home', 'xdg_cache_home'])
export function museInstallerEnvironment(install: MuseMakerInstall, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(environment).filter(([key]) => INSTALL_ENVIRONMENT.has(key.toLowerCase()))),
    MUSE_INSTALL_DIR: install.directory, MUSE_CHANNEL: install.channel, MUSE_UPGRADE_MODE: '1', MUSE_NO_MODIFY_PATH: '1', MUSE_LOGIN: '0' }
}

export interface MuseInstallerResult { readonly ok: boolean; readonly detail?: string; readonly printed?: string; readonly failure?: 'download' | 'installer' }
export interface MuseInstallerOptions {
  readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  readonly run: (executable: string, args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<MuseInstallerResult>
  readonly platform?: NodeJS.Platform
}

/** A maker update refreshes that one layout. It neither starts login nor changes the account's PATH. */
export async function installMuseClient(install: MuseMakerInstall, environment: NodeJS.ProcessEnv, options: MuseInstallerOptions): Promise<MuseInstallerResult> {
  const platform = options.platform ?? process.platform
  const windows = platform === 'win32'
  const endpoint = windows ? 'https://dev.meta.ai/install.ps1' : 'https://dev.meta.ai/install.sh'
  let temporary: string | undefined
  let running = false
  try {
    const response = await options.fetchImpl(endpoint, { redirect: 'error', signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS), headers: { accept: 'text/plain' } })
    const script = await museResponseText(response, INSTALLER_BYTES)
    if (!script?.trim() || script.includes('\0')) return { ok: false, failure: 'download', detail: 'Muse’s installer could not be downloaded. Nothing was replaced. Try again.' }
    temporary = await mkdtemp(join(tmpdir(), 'sotto-muse-update-'))
    const file = join(temporary, windows ? 'install.ps1' : 'install.sh')
    await writeFile(file, script, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT
    const runner = windows
      ? join(systemRoot && isAbsolute(systemRoot) ? systemRoot : 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : '/bin/bash'
    const args = windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file] : [file]
    running = true
    return await options.run(runner, args, museInstallerEnvironment(install, environment))
  } catch { return running
    ? { ok: false, failure: 'installer', detail: 'Muse’s installer did not finish. Existing threads keep their client. Try again.' }
    : { ok: false, failure: 'download', detail: 'Muse’s installer could not be downloaded. Nothing was replaced. Try again.' } }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined) }
}
