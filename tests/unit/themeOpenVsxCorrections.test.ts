// @vitest-environment node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { OPEN_VSX_LIMITS, OpenVsxClient, extractVsixThemes, parseJsonc, readZipDirectory, type FetchLike } from '../../src/main/themes/openVsx'
import { createOpenVsxFixtureFetch, createZip } from '../../src/main/themes/openVsxFixture'
import { openVsxInstallResultSchema, type OpenVsxThemeExtension } from '../../src/shared/themes/bridge'
import { VSCODE_WORKBENCH_COLOR_KEYS, parseVsCodeThemeFile } from '../../src/shared/themes/vscodeImport'

const extension: OpenVsxThemeExtension = {
  id: 'probe.theme', namespace: 'probe', name: 'theme', collectionId: 'open-vsx:probe.theme',
  displayName: 'Probe', description: '', downloadCount: 0, sourceUrl: null, version: '1.0.0', license: 'MIT',
}
const contribution = { label: 'Probe Dark', uiTheme: 'vs-dark', path: './themes/dark.json' }
const theme = { name: 'Probe Dark', type: 'dark', colors: { 'editor.background': '#111111', 'editor.foreground': '#eeeeee' } }
const manifest = (overrides: Record<string, unknown> = {}) => ({
  publisher: 'probe', name: 'theme', version: '1.0.0', license: 'MIT', contributes: { themes: [contribution] }, ...overrides,
})
function archive(overrides: Record<string, unknown> = {}, extraFiles: Record<string, string> = {}, themeText = JSON.stringify(theme)): Buffer {
  return createZip(Object.entries({
    'extension/package.json': JSON.stringify(manifest(overrides)), 'extension/themes/dark.json': themeText, ...extraFiles,
  }).map(([name, data]) => ({ name, data, stored: true })))
}
const json = (value: unknown) => new Response(JSON.stringify(value))
const base = 'https://open-vsx.org/api/probe/theme/1.0.0/file'
const detail = {
  ...extension, categories: ['Themes'], files: { download: `${base}/probe.theme.vsix`, sha256: `${base}/probe.theme.sha256`, manifest: `${base}/package.json` },
}
function network(options: { manifest?: unknown; detail?: unknown; search?: unknown; redirect?: string; vsix?: Buffer; checksum?: string } = {}) {
  const requests: string[] = []
  const bytes = options.vsix ?? archive()
  const hash = options.checksum ?? createHash('sha256').update(bytes).digest('hex')
  const fetch: FetchLike = async url => {
    requests.push(url)
    if (url.includes('/api/-/search?')) return json(options.search ?? { extensions: [{ namespace: 'probe', name: 'theme' }] })
    if (url === 'https://open-vsx.org/api/probe/theme') return json(options.detail ?? detail)
    if (url === `${base}/package.json`) return json(options.manifest ?? manifest())
    const path = new URL(url).pathname
    if (options.redirect && new URL(url).hostname === 'open-vsx.org') {
      return new Response(null, { status: 302, headers: { location: `${options.redirect}${path}` } })
    }
    if (path.endsWith('.sha256')) return new Response(hash)
    if (path.endsWith('.vsix')) return new Response(new Uint8Array(bytes))
    throw new Error(`Unexpected request: ${url}`)
  }
  return { client: new OpenVsxClient(fetch), requests }
}
const searchRequest = { query: 'Probe', sortBy: 'downloadCount' }
const installRequest = { namespace: 'probe', name: 'theme' }

describe('Open VSX network corrections', () => {
  it('installs through the official Eclipse content redirects with checksum verification', async () => {
    const { client, requests } = network({ redirect: 'https://openvsx.eclipsecontent.org' })
    const result = await client.install(installRequest)
    expect(openVsxInstallResultSchema.safeParse(result).success).toBe(true)
    expect(requests.filter(url => url.startsWith('https://openvsx.eclipsecontent.org/'))).toHaveLength(2)
  })
  it.each(['https://openvsx.eclipsecontent.org.evil.test', 'http://openvsx.eclipsecontent.org', 'https://user@openvsx.eclipsecontent.org', 'https://openvsx.eclipsecontent.org:444', 'http://['])('rejects an unsafe redirect: %s', async redirect => {
    const { client, requests } = network({ redirect })
    await expect(client.install(installRequest)).rejects.toMatchObject({ code: 'rejected' })
    expect(requests).toHaveLength(2)
  })
  it('still rejects a checksum mismatch before reading the archive', async () => {
    await expect(network({ vsix: Buffer.from('not a ZIP'), checksum: '0'.repeat(64) }).client.install(installRequest)).rejects.toThrow(/checksum/u)
  })
  it('filters icon-only manifests even when the category is Themes', async () => {
    const { client, requests } = network({ manifest: manifest({ contributes: { iconThemes: [{ path: './icons.json' }] } }) })
    expect(await client.search(searchRequest)).toEqual([])
    expect(requests).toContain(`${base}/package.json`)
    expect(requests.some(url => url.endsWith('.vsix'))).toBe(false)
  })
  it('offers a validated color-theme manifest', async () => {
    expect(await network().client.search(searchRequest)).toEqual([extension])
  })
  it('bounds streamed search manifests and cancels an oversized response', async () => {
    let cancelled = false
    const client = new OpenVsxClient(async (url, init) => {
      if (url === `${base}/package.json`) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(OPEN_VSX_LIMITS.manifestBytes + 1)) },
        cancel() { cancelled = true },
      }))
      if (url.includes('/api/-/search?')) return json({ extensions: [{ namespace: 'probe', name: 'theme' }] })
      if (url === 'https://open-vsx.org/api/probe/theme') return json(detail)
      throw new Error(`Unexpected request: ${url} ${init.redirect}`)
    })
    expect(await client.search(searchRequest)).toEqual([])
    expect(cancelled).toBe(true)
  })
  it.each([
    manifest({ license: 'ISC' }), manifest({ publisher: 'other' }),
    manifest({ contributes: { themes: [contribution, {}] } }),
    manifest({ contributes: { themes: Array.from({ length: 41 }, () => contribution) } }),
  ])('omits invalid advertised manifests: %j', async advertised => {
    expect(await network({ manifest: advertised }).client.search(searchRequest)).toEqual([])
  })
  it('never follows an untrusted manifest URL from metadata', async () => {
    const { client, requests } = network({ detail: { ...detail, files: { ...detail.files, manifest: 'https://evil.test/package.json' } } })
    expect(await client.search(searchRequest)).toEqual([])
    expect(requests).toHaveLength(2)
  })
  it('requires the checksum before downloading a package', async () => {
    const { client, requests } = network({ detail: { ...detail, files: { ...detail.files, sha256: undefined } } })
    await expect(client.install(installRequest)).rejects.toThrow(/checksum/u)
    expect(requests).toHaveLength(1)
  })
  it.each([{}, { extensions: null }, { extensions: {} }, []].map(search => [search]))('reports a malformed search envelope: %j', async search => {
    await expect(network({ search }).client.search(searchRequest)).rejects.toMatchObject({ code: 'network' })
  })
  it('allows a genuine empty search', async () => {
    expect(await network({ search: { extensions: [] } }).client.search(searchRequest)).toEqual([])
  })
  it('refuses API identity rebinding before following its file URLs', async () => {
    const { client, requests } = network({ detail: { ...detail, namespace: 'someone-else' } })
    await expect(client.install(installRequest)).rejects.toThrow(/match/u)
    expect(requests).toHaveLength(1)
  })
  it('keeps the existing offline search and dual-mode install compatible', async () => {
    const client = new OpenVsxClient(createOpenVsxFixtureFetch())
    const results = await client.search(searchRequest)
    expect(results).toHaveLength(1)
    const result = await client.install({ namespace: results[0]!.namespace, name: results[0]!.name })
    expect(openVsxInstallResultSchema.safeParse(result).success).toBe(true)
    expect(result.themes).toHaveLength(1)
    expect(result.themes[0]!.variants).toBeDefined()
  })
})

describe('atomic manifest and theme conversion', () => {
  it.each([{ publisher: 'other' }, { name: 'other' }, { version: '9.9.9' }, { license: 'UNLICENSED' }, { license: 'ISC' }, { version: undefined }, { license: undefined }])('rejects manifest mismatch: %j', overrides => {
    expect(() => extractVsixThemes(archive(overrides), extension)).toThrow(/match/u)
  })
  it('accepts case-insensitive publisher/name and trimmed license', () => {
    expect(extractVsixThemes(archive({ publisher: 'PROBE', name: 'THEME', license: ' mit ' }), extension)).toHaveLength(1)
  })
  it('rejects over 40 contributions instead of silently truncating', () => {
    expect(() => extractVsixThemes(archive({ contributes: { themes: Array.from({ length: 41 }, (_, i) => ({ ...contribution, label: `Variant ${i}` })) } }), extension)).toThrow(/too many/u)
  })
  it('imports all 40 contributions at the supported limit', () => {
    const themes = extractVsixThemes(archive({ contributes: { themes: Array.from({ length: 40 }, (_, i) => ({ ...contribution, label: `Variant ${i}` })) } }), extension)
    expect(themes).toHaveLength(40)
    expect(themes.map(theme => theme.label)).toContain('Variant 39')
  })
  it.each([null, {}, { path: './missing.json' }, { path: '../../outside.json' }, { path: './themes/broken.json' }])('rejects the entire import for a bad contribution: %j', bad => {
    expect(() => extractVsixThemes(archive({ contributes: { themes: [contribution, bad] } }, { 'extension/themes/broken.json': '{broken' }), extension)).toThrow()
  })
  it('rejects an unconvertible theme instead of returning the other contribution', () => {
    expect(() => extractVsixThemes(archive({ contributes: { themes: [contribution, { path: './themes/bad.json' }] } }, { 'extension/themes/bad.json': '{"colors":{}}' }), extension)).toThrow(/import/u)
  })
  it.each(['../../outside.json', './missing.json', './dark.json', 123])('rejects invalid or cyclic includes atomically: %j', include => {
    expect(() => extractVsixThemes(archive({}, {}, JSON.stringify({ ...theme, include })), extension)).toThrow()
  })
  it('preserves all importer-consumed keys with direct-import palette parity', () => {
    // Derive from the consumer calls, not the whitelist under test: this also catches future omissions.
    const source = readFileSync(new URL('../../src/shared/themes/vscodeImport.ts', import.meta.url), 'utf8')
    const consumed = new Set([...source.matchAll(/(?:pick|solidOver|readableOn)\(([^)]+)\)/gu)]
      .flatMap(match => [...match[1]!.matchAll(/'([^']+)'/gu)].map(key => key[1]!)))
    expect(consumed.size).toBeGreaterThan(35)
    expect([...consumed].filter(key => !(VSCODE_WORKBENCH_COLOR_KEYS as readonly string[]).includes(key))).toEqual([])
    for (const key of consumed) {
      const input = { ...theme, colors: { 'editor.background': '#111111', [key]: '#ffeeaa' } }
      const direct = parseVsCodeThemeFile(input)
      const installed = extractVsixThemes(archive({}, {}, JSON.stringify(input)), extension)[0]!
      expect(installed.colors, key).toEqual(direct.colors)
    }
  })
})

describe('supported ZIP directory validation', () => {
  const central = (bytes: Buffer) => bytes.readUInt32LE(bytes.length - 6)
  it('accepts a valid EOCD comment containing a false EOCD signature', () => {
    const bytes = archive()
    const comment = Buffer.alloc(40, 0x61)
    comment.writeUInt32LE(0x06054b50, 4)
    bytes.writeUInt16LE(comment.length, bytes.length - 2)
    expect(extractVsixThemes(Buffer.concat([bytes, comment]), extension)).toHaveLength(1)
  })
  it.each(['disk', 'directory disk', 'disk count', 'directory size', 'directory offset', 'entry disk', 'entry extent', 'count', 'comment length', 'ZIP64 size', 'duplicate name', 'compression', 'encrypted'])('rejects invalid %s', field => {
    let bytes = archive()
    const end = bytes.length - 22
    const directory = central(bytes)
    if (field === 'disk') bytes.writeUInt16LE(1, end + 4)
    if (field === 'directory disk') bytes.writeUInt16LE(1, end + 6)
    if (field === 'disk count') bytes.writeUInt16LE(1, end + 8)
    if (field === 'directory size') bytes.writeUInt32LE(0, end + 12)
    if (field === 'directory offset') bytes.writeUInt32LE(directory + 1, end + 16)
    if (field === 'entry disk') bytes.writeUInt16LE(1, directory + 34)
    if (field === 'entry extent') bytes.writeUInt16LE(0xffff, directory + 32)
    if (field === 'count') { bytes.writeUInt16LE(1, end + 8); bytes.writeUInt16LE(1, end + 10) }
    if (field === 'comment length') bytes.writeUInt16LE(1, end + 20)
    if (field === 'ZIP64 size') bytes.writeUInt32LE(0xffffffff, end + 12)
    if (field === 'duplicate name') bytes = createZip([{ name: 'extension/package.json', data: '{}' }, { name: 'extension/package.json', data: '{}' }])
    if (field === 'compression') bytes.writeUInt16LE(99, directory + 10)
    if (field === 'encrypted') bytes.writeUInt16LE(1, directory + 8)
    expect(() => readZipDirectory(bytes)).toThrow()
  })
})

describe('JSONC lexical handling', () => {
  it('preserves commas, comment markers, escaped quotes and backslashes inside strings', () => {
    const name = 'Hello,} and ,] // text /* literal */ "quoted" \\ end'
    const source = `\uFEFF{"name":${JSON.stringify(name)},/* comment */"colors":{"editor.background":"#111111",},"items":[1, // comment\n],}`
    expect(parseJsonc(source)).toEqual({ name, colors: { 'editor.background': '#111111' }, items: [1] })
  })
  it.each(['{"a":1/* unterminated', '{"a":1/* c */2}', '{"a":1,/* unterminated }', '{"a":"unterminated}', '[,]', '[1,,]', '{"a":,}'])('rejects invalid JSONC instead of repairing it: %s', source => {
    expect(() => parseJsonc(source)).toThrow()
  })
})
