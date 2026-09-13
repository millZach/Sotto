/*
 * Community themes from Open VSX (ADR-0011).
 *
 * T3 Code searches Open VSX and installs a VS Code colour-theme extension from
 * its web client (apps/web/src/openVsxThemes.ts at commit
 * d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3, MIT, T3 Tools Inc.). Sotto's
 * renderer has no network under its content security policy, so the main
 * process does the same work with Node's fetch, crypto and zlib, and nothing
 * from the download is kept except the theme colours:
 *
 * - Only https://open-vsx.org is contacted; file downloads may redirect to
 *   Open VSX's own blob storage and nowhere else. The renderer sends an
 *   extension's namespace and name, never a URL.
 * - Every response has a byte limit, and a VSIX must match the SHA-256 that
 *   Open VSX publishes for it. The checksum proves the file is the one Open VSX
 *   serves, not that its publisher is trustworthy; only colours survive.
 * - Only extensions under a permissive open-source licence are offered.
 * - The archive is read in memory with bounded entry counts, sizes and
 *   compression ratios; ZIP64, encryption and paths outside the extension are
 *   refused. No file from it is written to disk and no code from it runs.
 * - Theme files may be JSON with comments; `include` chains are followed to a
 *   fixed depth. Only the workbench colour keys the importer reads are kept,
 *   then each file goes through the same VS Code importer as a pasted file.
 */

import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import {
  openVsxInstallRequestSchema,
  openVsxSearchRequestSchema,
  type OpenVsxInstallResult,
  type OpenVsxThemeExtension,
  type ThemesError,
} from '../../shared/themes/bridge'
import { THEME_FILE_VERSION, canonicalizeTheme, parseThemeFile, type ThemeDefinition } from '../../shared/themes/library'
import {
  VSCODE_WORKBENCH_COLOR_KEYS,
  humanizeThemeName,
  pairVsCodeThemes,
  parseVsCodeThemeFile,
  resolveThemeLabelCollisions,
} from '../../shared/themes/vscodeImport'

export const OPEN_VSX_ORIGIN = 'https://open-vsx.org'
const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set(['open-vsx.org', 'openvsxorg.blob.core.windows.net'])

export const OPEN_VSX_LIMITS = {
  searchBytes: 512 * 1024,
  detailBytes: 256 * 1024,
  checksumBytes: 1024,
  vsixBytes: 20 * 1024 * 1024,
  manifestBytes: 256 * 1024,
  themeFileBytes: 256 * 1024,
  archiveEntries: 5_000,
  totalUncompressedBytes: 100 * 1024 * 1024,
  compressionRatio: 200,
  includeDepth: 8,
  themes: 40,
  redirects: 3,
  searchResults: 16,
  apiTimeoutMs: 15_000,
  downloadTimeoutMs: 60_000,
} as const

/** SPDX identifiers of licences that allow redistributing a theme's colours. */
export const OPEN_VSX_LICENSES: ReadonlySet<string> = new Set([
  '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'ISC', 'MIT', 'MPL-2.0', 'Unlicense',
])

export type FetchLike = (url: string, init: { readonly redirect: 'manual'; readonly signal: AbortSignal; readonly headers: Record<string, string> }) => Promise<Response>

export class OpenVsxFailure extends Error {
  constructor(readonly code: ThemesError['code'], message: string) {
    super(message)
  }
}

const NETWORK_MESSAGE = 'Open VSX could not be reached. Check your connection and try again.'

// ---------------------------------------------------------------------------
// Bounded HTTP

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function allowedUrl(raw: string, hosts: ReadonlySet<string>): URL | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname)) return null
    return url
  } catch {
    return null
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new OpenVsxFailure('too-large', 'Open VSX sent more data than a theme needs, so the download was stopped.')
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new OpenVsxFailure('too-large', 'Open VSX sent more data than a theme needs, so the download was stopped.')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

export class OpenVsxClient {
  constructor(private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init)) {}

  private async get(raw: string, maxBytes: number, hosts: ReadonlySet<string>, timeoutMs: number): Promise<Buffer> {
    let url = allowedUrl(raw, hosts)
    const signal = AbortSignal.timeout(timeoutMs)
    for (let hop = 0; url !== null && hop <= OPEN_VSX_LIMITS.redirects; hop += 1) {
      let response: Response
      try {
        response = await this.fetchImpl(url.href, { redirect: 'manual', signal, headers: { accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.1' } })
      } catch {
        throw new OpenVsxFailure('network', NETWORK_MESSAGE)
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        url = location ? allowedUrl(new URL(location, url).href, DOWNLOAD_HOSTS) : null
        if (url === null) throw new OpenVsxFailure('rejected', 'Open VSX redirected somewhere Sotto does not download from.')
        continue
      }
      if (response.status === 404) throw new OpenVsxFailure('unavailable', 'That extension is no longer on Open VSX.')
      if (!response.ok) throw new OpenVsxFailure('network', `Open VSX answered with an error (${response.status}). Try again later.`)
      try {
        return await readLimited(response, maxBytes)
      } catch (cause) {
        if (cause instanceof OpenVsxFailure) throw cause
        throw new OpenVsxFailure('network', NETWORK_MESSAGE)
      }
    }
    throw new OpenVsxFailure('rejected', url === null ? 'That address is not an Open VSX address.' : 'Open VSX redirected too many times.')
  }

  private async getJson(url: string, maxBytes: number): Promise<unknown> {
    const body = await this.get(url, maxBytes, new Set(['open-vsx.org']), OPEN_VSX_LIMITS.apiTimeoutMs)
    try {
      return JSON.parse(body.toString('utf8'))
    } catch {
      throw new OpenVsxFailure('network', 'Open VSX sent a response Sotto could not read.')
    }
  }

  private async detail(namespace: string, name: string): Promise<{ extension: OpenVsxThemeExtension; download: string; sha256: string | null }> {
    const value = await this.getJson(`${OPEN_VSX_ORIGIN}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, OPEN_VSX_LIMITS.detailBytes)
    const parsed = parseExtensionDetail(value)
    if (!parsed) throw new OpenVsxFailure('unavailable', 'Open VSX did not describe that extension completely.')
    return parsed
  }

  async search(input: unknown): Promise<OpenVsxThemeExtension[]> {
    const request = openVsxSearchRequestSchema.safeParse(input)
    if (!request.success) throw new OpenVsxFailure('invalid-request', 'Type up to 100 characters to search.')
    const query = new URLSearchParams({
      query: request.data.query,
      category: 'Themes',
      size: String(OPEN_VSX_LIMITS.searchResults),
      offset: '0',
      sortBy: request.data.sortBy,
      sortOrder: 'desc',
      includeAllVersions: 'false',
    })
    const value = await this.getJson(`${OPEN_VSX_ORIGIN}/api/-/search?${query}`, OPEN_VSX_LIMITS.searchBytes)
    const hits = isRecord(value) && Array.isArray(value.extensions) ? value.extensions.slice(0, OPEN_VSX_LIMITS.searchResults) : []
    const identities = hits
      .map(hit => (isRecord(hit) && isIdentityPart(hit.namespace) && isIdentityPart(hit.name) ? { namespace: hit.namespace, name: hit.name } : null))
      .filter((identity): identity is { namespace: string; name: string } => identity !== null)
    // Search results carry no licence, so each hit's detail is read (four at a
    // time) and only permissively licensed colour themes are offered.
    const results: Array<OpenVsxThemeExtension | null> = new Array(identities.length).fill(null)
    let next = 0
    let unreachable = 0
    const worker = async (): Promise<void> => {
      while (next < identities.length) {
        const index = next++
        const identity = identities[index]!
        try {
          const detail = await this.detail(identity.namespace, identity.name)
          if (OPEN_VSX_LICENSES.has(detail.extension.license)) results[index] = detail.extension
        } catch (cause) {
          if (cause instanceof OpenVsxFailure && cause.code === 'network') unreachable += 1
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
    if (identities.length > 0 && unreachable === identities.length) throw new OpenVsxFailure('network', NETWORK_MESSAGE)
    return results.filter((result): result is OpenVsxThemeExtension => result !== null)
  }

  async install(input: unknown): Promise<OpenVsxInstallResult> {
    const request = openVsxInstallRequestSchema.safeParse(input)
    if (!request.success) throw new OpenVsxFailure('invalid-request', 'That is not an Open VSX extension name.')
    const { extension, download, sha256 } = await this.detail(request.data.namespace, request.data.name)
    if (!OPEN_VSX_LICENSES.has(extension.license)) {
      throw new OpenVsxFailure('rejected', `${extension.displayName} is licensed as ${extension.license || 'unknown'}, which Sotto does not import.`)
    }
    if (sha256 === null) throw new OpenVsxFailure('rejected', `Open VSX publishes no checksum for ${extension.displayName}, so Sotto did not download it.`)
    const checksumText = await this.get(sha256, OPEN_VSX_LIMITS.checksumBytes, DOWNLOAD_HOSTS, OPEN_VSX_LIMITS.apiTimeoutMs)
    const expected = /\b([0-9a-f]{64})\b/iu.exec(checksumText.toString('utf8'))?.[1]?.toLowerCase()
    if (!expected) throw new OpenVsxFailure('rejected', 'The checksum from Open VSX could not be read.')
    const vsix = await this.get(download, OPEN_VSX_LIMITS.vsixBytes, DOWNLOAD_HOSTS, OPEN_VSX_LIMITS.downloadTimeoutMs)
    if (createHash('sha256').update(vsix).digest('hex') !== expected) {
      throw new OpenVsxFailure('rejected', 'The download did not match the checksum Open VSX publishes, so it was discarded.')
    }
    const themes = extractVsixThemes(vsix, extension)
    return { extension, themes }
  }
}

function isIdentityPart(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/u.test(value)
}

function boundedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : ''
}

/** The collection id every variant of an extension shares, e.g. `open-vsx:dracula-theme.theme-dracula`. */
export function openVsxCollectionId(namespace: string, name: string): string {
  return `open-vsx:${namespace}.${name}`.toLowerCase().replace(/_/gu, '-').slice(0, 128)
}

export function parseExtensionDetail(value: unknown): { extension: OpenVsxThemeExtension; download: string; sha256: string | null } | null {
  if (!isRecord(value) || !isIdentityPart(value.namespace) || !isIdentityPart(value.name) || !isRecord(value.files)) return null
  if (Array.isArray(value.categories) && !value.categories.includes('Themes')) return null
  const download = typeof value.files.download === 'string' && allowedUrl(value.files.download, DOWNLOAD_HOSTS) ? value.files.download : null
  if (download === null) return null
  const sha256 = typeof value.files.sha256 === 'string' && allowedUrl(value.files.sha256, DOWNLOAD_HOSTS) ? value.files.sha256 : null
  const repository = typeof value.repository === 'string' ? allowedUrl(value.repository, new Set(['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org', 'sr.ht', 'git.sr.ht'])) : null
  const displayName = boundedText(value.displayName, 200) || value.name
  const downloadCount = typeof value.downloadCount === 'number' && Number.isFinite(value.downloadCount) && value.downloadCount >= 0 ? value.downloadCount : 0
  return {
    download,
    sha256,
    extension: {
      id: `${value.namespace}.${value.name}`.slice(0, 128),
      namespace: value.namespace,
      name: value.name,
      collectionId: openVsxCollectionId(value.namespace, value.name),
      displayName,
      description: boundedText(value.description, 500),
      downloadCount,
      sourceUrl: repository && repository.href.length <= 500 ? repository.href : null,
      version: boundedText(value.version, 64),
      license: boundedText(value.license, 32),
    },
  }
}

// ---------------------------------------------------------------------------
// ZIP

interface ZipEntry {
  readonly name: string
  readonly method: number
  readonly compressedSize: number
  readonly size: number
  readonly localOffset: number
}

function reject(message: string): never {
  throw new OpenVsxFailure('rejected', message)
}

/** The central directory of an in-memory ZIP. ZIP64, encryption and multi-disk archives are refused. */
export function readZipDirectory(archive: Buffer): Map<string, ZipEntry> {
  const searchFrom = Math.max(0, archive.length - 22 - 0xffff)
  let end = -1
  for (let offset = archive.length - 22; offset >= searchFrom; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end < 0) reject('The extension is not a valid VSIX archive.')
  const disk = archive.readUInt16LE(end + 4)
  const count = archive.readUInt16LE(end + 10)
  const directorySize = archive.readUInt32LE(end + 12)
  const directoryOffset = archive.readUInt32LE(end + 16)
  if (disk !== 0 || count === 0xffff || directoryOffset === 0xffffffff) reject('The extension uses a ZIP format Sotto does not read.')
  if (count > OPEN_VSX_LIMITS.archiveEntries) reject('The extension has too many files to be a theme.')
  if (directoryOffset + directorySize > end) reject('The extension is not a valid VSIX archive.')
  const entries = new Map<string, ZipEntry>()
  let offset = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) reject('The extension is not a valid VSIX archive.')
    const flags = archive.readUInt16LE(offset + 8)
    const method = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const size = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const localOffset = archive.readUInt32LE(offset + 42)
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) reject('The extension uses a ZIP format Sotto does not read.')
    if ((flags & 0x1) !== 0) reject('The extension is encrypted.')
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength
    if (!name.endsWith('/')) entries.set(name, { name, method, compressedSize, size, localOffset })
  }
  return entries
}

class ZipReader {
  private readonly entries: Map<string, ZipEntry>
  private inflated = 0

  constructor(private readonly archive: Buffer) {
    this.entries = readZipDirectory(archive)
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  read(name: string, maxBytes: number): Buffer {
    const entry = this.entries.get(name)
    if (!entry) reject(`The extension is missing ${name}.`)
    if (entry.size > maxBytes) reject(`${posix.basename(name)} is too large to be a theme file.`)
    if (entry.compressedSize > 0 && entry.size / entry.compressedSize > OPEN_VSX_LIMITS.compressionRatio) reject('The extension is compressed suspiciously well, so it was not opened.')
    this.inflated += entry.size
    if (this.inflated > OPEN_VSX_LIMITS.totalUncompressedBytes) reject('The extension expands to more data than a theme needs.')
    const local = entry.localOffset
    if (local + 30 > this.archive.length || this.archive.readUInt32LE(local) !== 0x04034b50) reject('The extension is not a valid VSIX archive.')
    const start = local + 30 + this.archive.readUInt16LE(local + 26) + this.archive.readUInt16LE(local + 28)
    if (start + entry.compressedSize > this.archive.length) reject('The extension is not a valid VSIX archive.')
    const raw = this.archive.subarray(start, start + entry.compressedSize)
    let data: Buffer
    if (entry.method === 0) data = Buffer.from(raw)
    else if (entry.method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) })
      } catch {
        reject('The extension is not a valid VSIX archive.')
      }
    } else reject('The extension uses a compression method Sotto does not read.')
    if (data.length !== entry.size) reject('The extension is not a valid VSIX archive.')
    return data
  }
}

// ---------------------------------------------------------------------------
// JSON with comments

/** Parse JSON that may contain comments and trailing commas, as VS Code theme files do. */
export function parseJsonc(text: string): unknown {
  let output = ''
  let index = 0
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]
    if (char === '"') {
      const start = index
      index += 1
      while (index < source.length && source[index] !== '"') index += source[index] === '\\' ? 2 : 1
      output += source.slice(start, index + 1)
      index += 1
    } else if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2)
      index = close < 0 ? source.length : close + 2
    } else {
      output += char
      index += 1
    }
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/gu, '$1'))
}

// ---------------------------------------------------------------------------
// Themes

const WORKBENCH_KEYS: ReadonlySet<string> = new Set(VSCODE_WORKBENCH_COLOR_KEYS)

/** A problem with one theme file; the extension's other themes can still install. */
class ThemeFileProblem extends Error {}

function extensionPath(fromFile: string, relative: string): string | null {
  if (typeof relative !== 'string' || relative.length === 0 || relative.length > 260 || relative.includes('\\') || relative.includes('\0')) return null
  if (relative.startsWith('/') || /^[A-Za-z]:/u.test(relative)) return null
  const resolved = posix.normalize(posix.join(posix.dirname(fromFile), relative))
  return resolved.startsWith('extension/') && !resolved.split('/').includes('..') ? resolved : null
}

/** The colours and type of a theme file and its includes, keeping only keys the importer reads. */
function readThemeFile(zip: ZipReader, path: string, depth: number, seen: Set<string>): { colors: Record<string, string>; type: string | null; name: string | null } {
  if (depth > OPEN_VSX_LIMITS.includeDepth) throw new ThemeFileProblem('A theme file includes too many other files.')
  if (seen.has(path)) throw new ThemeFileProblem('A theme file includes itself.')
  seen.add(path)
  let value: unknown
  try {
    value = parseJsonc(zip.read(path, OPEN_VSX_LIMITS.themeFileBytes).toString('utf8'))
  } catch (cause) {
    if (cause instanceof OpenVsxFailure) throw cause
    throw new ThemeFileProblem(`${posix.basename(path)} is not valid JSON.`)
  }
  if (!isRecord(value)) throw new ThemeFileProblem(`${posix.basename(path)} is not a theme file.`)
  const colors: Record<string, string> = {}
  let type: string | null = null
  let name: string | null = null
  if (typeof value.include === 'string') {
    const included = extensionPath(path, value.include)
    if (included === null || !zip.has(included)) throw new ThemeFileProblem(`${posix.basename(path)} includes a file outside the extension.`)
    const base = readThemeFile(zip, included, depth + 1, seen)
    Object.assign(colors, base.colors)
    type = base.type
    name = base.name
  }
  if (isRecord(value.colors)) {
    for (const key of WORKBENCH_KEYS) {
      const color = value.colors[key]
      if (typeof color === 'string' && color.length <= 96) colors[key] = color
    }
  }
  if (typeof value.type === 'string' && value.type.length <= 16) type = value.type
  if (typeof value.name === 'string' && value.name.length <= 200) name = value.name
  return { colors, type, name }
}

function themeIdFor(collectionId: string, label: string): string {
  return `ovx-${createHash('sha256').update(`${collectionId}\n${label.toLowerCase()}`).digest('hex').slice(0, 12)}`
}

/** Every colour theme an extension contributes, converted, paired and labelled as one collection. */
export function extractVsixThemes(archive: Buffer, extension: OpenVsxThemeExtension): ThemeDefinition[] {
  const zip = new ZipReader(archive)
  let manifest: unknown
  try {
    manifest = JSON.parse(zip.read('extension/package.json', OPEN_VSX_LIMITS.manifestBytes).toString('utf8'))
  } catch (cause) {
    if (cause instanceof OpenVsxFailure) throw cause
    reject('The extension manifest is not valid JSON.')
  }
  const contributions = isRecord(manifest) && isRecord(manifest.contributes) && Array.isArray(manifest.contributes.themes) ? manifest.contributes.themes : []
  if (contributions.length === 0) reject(`${extension.displayName} contributes no color themes.`)

  const converted: Array<{ theme: ThemeDefinition; sourceName: string }> = []
  for (const contribution of contributions.slice(0, OPEN_VSX_LIMITS.themes)) {
    if (!isRecord(contribution) || typeof contribution.path !== 'string') continue
    const path = extensionPath('extension/package.json', contribution.path)
    if (path === null || !zip.has(path)) continue
    try {
      const file = readThemeFile(zip, path, 0, new Set())
      const uiType = contribution.uiTheme === 'vs' || contribution.uiTheme === 'hc-light' ? 'light' : contribution.uiTheme === 'vs-dark' || contribution.uiTheme === 'hc-black' ? 'dark' : null
      const label = typeof contribution.label === 'string' && contribution.label.trim() ? contribution.label : file.name ?? humanizeThemeName(posix.basename(path, '.json'))
      converted.push({
        sourceName: posix.basename(path),
        theme: parseVsCodeThemeFile({ name: label.slice(0, 200), type: uiType ?? file.type ?? undefined, colors: file.colors }),
      })
    } catch (cause) {
      // A size or archive violation stops the install; an unreadable theme
      // among several is skipped.
      if (cause instanceof OpenVsxFailure) throw cause
    }
  }
  if (converted.length === 0) reject(`None of the themes in ${extension.displayName} could be read.`)

  const collection = { id: extension.collectionId, label: humanizeThemeName(extension.displayName).slice(0, 48).trim() || extension.name.slice(0, 48) }
  const taken = new Set<string>()
  return pairVsCodeThemes(resolveThemeLabelCollisions(converted)).map(theme => {
    let id = themeIdFor(collection.id, theme.label)
    for (let suffix = 2; taken.has(id); suffix += 1) id = themeIdFor(collection.id, `${theme.label} ${suffix}`)
    taken.add(id)
    return canonicalizeTheme(parseThemeFile({
      version: THEME_FILE_VERSION,
      id,
      name: theme.label,
      appearance: theme.appearance,
      colors: theme.colors,
      ...(theme.variants ? { variants: theme.variants } : {}),
      collection,
    }))
  })
}
