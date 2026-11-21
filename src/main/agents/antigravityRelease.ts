import { access } from 'node:fs/promises'
import { z } from 'zod'

/**
 * Which `agy` Google has published, read from the platform manifest Google's own updater reads, as T3 Code reads it
 * (`t3:apps/server/src/provider/antigravityCliRelease.ts`). The manifest names one version, its download and the
 * download's SHA-512. Sotto accepts a download only at the Google Storage path T3 accepts, for this computer's
 * platform, so a manifest that names anything else installs nothing.
 */
export const ANTIGRAVITY_MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'
const DOWNLOAD_BASE = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/'

/** The oldest `agy` Sotto runs, as T3's model manifest has it: older ones lack the ACP Sotto speaks. */
export const ANTIGRAVITY_CLI_FLOOR = '1.5.0'

const VERSION = /^\d+\.\d+\.\d+$/u
const manifestSchema = z.object({
  version: z.string().regex(VERSION),
  url: z.string().max(512),
  sha512: z.string().regex(/^[a-fA-F0-9]{128}$/u),
})
const MANIFEST_MAX_BYTES = 16 * 1024
const MANIFEST_TIMEOUT_MS = 10_000

export interface AntigravityRelease {
  readonly version: string
  readonly url: string
  /** Lower-case hex. */
  readonly sha512: string
  /** The program's name in the download: `agy.exe` on Windows, `antigravity` in the archive elsewhere. */
  readonly executable: string
  /** Windows' download is the program itself; macOS and Linux get a gzipped tar holding it. */
  readonly format: 'executable' | 'tar.gz'
}

export interface AntigravityPlatform { readonly platform: NodeJS.Platform; readonly arch: string; readonly musl?: boolean }

/** The manifest's name for a platform (`windows_amd64`, `darwin_arm64`, `linux_amd64_musl`), or undefined where Google publishes none. */
export function antigravityTarget({ platform, arch, musl = false }: AntigravityPlatform): string | undefined {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) return undefined
  const os = platform === 'win32' ? 'windows' : platform
  return `${os}_${arch === 'x64' ? 'amd64' : arch}${platform === 'linux' && musl ? '_musl' : ''}`
}

/** Linux with musl gets its own build, told apart by musl's loader, as T3 tells it. */
export async function isMuslLinux(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Promise<boolean> {
  if (platform !== 'linux') return false
  return access(arch === 'arm64' ? '/lib/libc.musl-aarch64.so.1' : '/lib/libc.musl-x86_64.so.1').then(() => true, () => false)
}

/** The release a manifest names, or undefined when the manifest is malformed or its download is not where Google keeps this platform's. */
export function parseAntigravityRelease(value: unknown, target: AntigravityPlatform): AntigravityRelease | undefined {
  const parsed = manifestSchema.safeParse(value)
  if (!parsed.success || antigravityTarget(target) === undefined) return undefined
  const { platform, arch } = target
  const musl = platform === 'linux' && target.musl === true
  const manifest = parsed.data
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux'
  const cpu = arch === 'x64' ? 'x64' : 'arm64'
  const suffix = musl ? '_musl' : ''
  const extension = platform === 'win32' ? 'exe' : 'tar.gz'
  const folder = `${platform === 'win32' ? 'windows' : platform}-${arch === 'arm64' ? 'arm' : 'x64'}${musl ? '-musl' : ''}`
  const prefix = `${DOWNLOAD_BASE}${manifest.version}-`
  const rest = manifest.url.startsWith(prefix) ? manifest.url.slice(prefix.length) : ''
  if (!/^\d+\//u.test(rest) || rest.replace(/^\d+\//u, '') !== `${folder}/cli_${os}_${cpu}${suffix}.${extension}`) return undefined
  return {
    version: manifest.version, url: manifest.url, sha512: manifest.sha512.toLowerCase(),
    executable: platform === 'win32' ? 'agy.exe' : 'antigravity', format: platform === 'win32' ? 'executable' : 'tar.gz',
  }
}

/** Compares two `agy` versions, `x.y.z`: negative when `a` is older. An unreadable part counts as 0. */
export function compareAntigravityVersions(a: string, b: string): number {
  const parts = (value: string): number[] => value.trim().replace(/^v/u, '').split(/[-+]/u)[0]!.split('.').map(part => Number.parseInt(part, 10) || 0)
  const left = parts(a), right = parts(b)
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Whether Sotto runs this `agy` at all. */
export const meetsAntigravityFloor = (version: string): boolean => VERSION.test(version.trim()) && compareAntigravityVersions(version, ANTIGRAVITY_CLI_FLOOR) >= 0

export type ManifestFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Asks Google's manifest for this platform's newest release. Undefined when it cannot be read or names a download Sotto
 * does not accept; a failed read is not a finding. Redirects are refused, so the manifest host is the only one asked.
 */
export async function readAntigravityRelease(fetchImpl: ManifestFetch, target: AntigravityPlatform, signal?: AbortSignal): Promise<AntigravityRelease | undefined> {
  const name = antigravityTarget(target)
  if (!name) return undefined
  try {
    const timeout = AbortSignal.timeout(MANIFEST_TIMEOUT_MS)
    const response = await fetchImpl(`${ANTIGRAVITY_MANIFEST_BASE}/${name}.json`, {
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: 'application/json' },
    })
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return undefined }
    const body = await response.text()
    if (body.length > MANIFEST_MAX_BYTES) return undefined
    return parseAntigravityRelease(JSON.parse(body), target)
  } catch { return undefined }
}
