// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  OPEN_VSX_LIMITS,
  OpenVsxClient,
  OpenVsxFailure,
  extractVsixThemes,
  parseExtensionDetail,
  parseJsonc,
  readZipDirectory,
  type FetchLike,
} from '../../../src/main/themes/openVsx'
import { createOpenVsxFixtureFetch, createThemeVsix, createZip } from '../../../src/main/themes/openVsxFixture'
import { customThemesSchema } from '../../../src/shared/themes/library'
import type { OpenVsxThemeExtension } from '../../../src/shared/themes/bridge'

const extension: OpenVsxThemeExtension = {
  id: 'sotto-fixtures.harbor-theme',
  namespace: 'sotto-fixtures',
  name: 'harbor-theme',
  collectionId: 'open-vsx:sotto-fixtures.harbor-theme',
  displayName: 'Harbor Theme',
  description: '',
  downloadCount: 0,
  sourceUrl: null,
  version: '1.2.0',
  license: 'MIT',
}

function manifest(themes: unknown[]): string {
  return JSON.stringify({ publisher: 'sotto-fixtures', name: 'harbor-theme', version: '1.2.0', license: 'MIT', contributes: { themes } })
}

async function failure(promise: Promise<unknown>): Promise<OpenVsxFailure> {
  const error = await promise.then(() => null, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(OpenVsxFailure)
  return error as OpenVsxFailure
}

/** The fixture fetch with one route answered differently. */
function withRoute(route: (url: URL) => Response | null, vsix?: Buffer): FetchLike {
  const base = createOpenVsxFixtureFetch(vsix)
  return async (url, init) => route(new URL(url)) ?? base(url, init)
}

describe('Open VSX client', () => {
  it('offers only permissively licensed colour themes from a search', async () => {
    const fetch = vi.fn(createOpenVsxFixtureFetch())
    const results = await new OpenVsxClient(fetch).search({ query: 'harbor', sortBy: 'downloadCount' })
    expect(results.map(result => [result.id, result.license])).toEqual([['sotto-fixtures.harbor-theme', 'MIT']])
    const searched = new URL(fetch.mock.calls[0]![0])
    expect(searched.origin).toBe('https://open-vsx.org')
    expect(searched.searchParams.get('category')).toBe('Themes')
    expect(fetch.mock.calls.every(([, init]) => init.redirect === 'manual')).toBe(true)
  })

  it('rejects a malformed search or install request before any request is made', async () => {
    const fetch = vi.fn(createOpenVsxFixtureFetch())
    const client = new OpenVsxClient(fetch)
    expect((await failure(client.search({ query: '', sortBy: 'downloadCount' }))).code).toBe('invalid-request')
    expect((await failure(client.search({ query: 'x', sortBy: 'price' }))).code).toBe('invalid-request')
    expect((await failure(client.install({ namespace: '../etc', name: 'passwd' }))).code).toBe('invalid-request')
    expect((await failure(client.install({ namespace: 'a', name: 'b', url: 'https://evil.example' }))).code).toBe('invalid-request')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('installs a verified VSIX through the blob-storage redirect, keeping only colours as one collection', async () => {
    const result = await new OpenVsxClient(createOpenVsxFixtureFetch()).install({ namespace: 'sotto-fixtures', name: 'harbor-theme' })
    expect(result.themes).toHaveLength(1)
    const [harbor] = result.themes
    expect(harbor!.label).toBe('Harbor')
    expect(harbor!.id).toMatch(/^ovx-[0-9a-f]{12}$/u)
    expect(harbor!.collection).toEqual({ id: 'open-vsx:sotto-fixtures.harbor-theme', label: 'Harbor Theme' })
    expect(Object.keys(harbor!.variants ?? {})).toEqual(['dark'])
    // The saved shape is exactly what settings accept, and nothing hostile survived.
    expect(customThemesSchema.safeParse(result.themes).success).toBe(true)
    expect(JSON.stringify(result.themes)).not.toMatch(/url\(|javascript/u)
  })

  it('refuses a copyleft extension even when asked for it directly', async () => {
    const error = await failure(new OpenVsxClient(createOpenVsxFixtureFetch()).install({ namespace: 'sotto-fixtures', name: 'copyleft-theme' }))
    expect(error.code).toBe('rejected')
    expect(error.message).toContain('GPL-3.0-only')
  })

  it('discards a download that does not match the published checksum', async () => {
    const other = createZip([{ name: 'extension/package.json', data: manifest([]) }])
    const fetch = withRoute(url => (url.hostname === 'openvsxorg.blob.core.windows.net' ? new Response(new Uint8Array(other)) : null))
    const error = await failure(new OpenVsxClient(fetch).install({ namespace: 'sotto-fixtures', name: 'harbor-theme' }))
    expect(error.code).toBe('rejected')
    expect(error.message).toMatch(/checksum/u)
  })

  it('never follows a redirect off the allowed hosts', async () => {
    const fetch = vi.fn(withRoute(url => (url.pathname.endsWith('/harbor-theme.vsix')
      ? new Response(null, { status: 302, headers: { location: 'https://attacker.example/harbor-theme.vsix' } })
      : null)))
    const error = await failure(new OpenVsxClient(fetch).install({ namespace: 'sotto-fixtures', name: 'harbor-theme' }))
    expect(error.code).toBe('rejected')
    expect(fetch.mock.calls.some(([url]) => url.includes('attacker.example'))).toBe(false)
  })

  it('stops a response that declares or streams more than its byte limit', async () => {
    const declared = withRoute(url => (url.hostname === 'openvsxorg.blob.core.windows.net'
      ? new Response('x', { headers: { 'content-length': String(OPEN_VSX_LIMITS.vsixBytes + 1) } })
      : null))
    expect((await failure(new OpenVsxClient(declared).install({ namespace: 'sotto-fixtures', name: 'harbor-theme' }))).code).toBe('too-large')

    const streamed = withRoute(url => (url.pathname === '/api/-/search' ? new Response('x'.repeat(OPEN_VSX_LIMITS.searchBytes + 10)) : null))
    expect((await failure(new OpenVsxClient(streamed).search({ query: 'harbor', sortBy: 'relevance' }))).code).toBe('too-large')
  })

  it('reports an unreachable service as a network failure', async () => {
    const offline: FetchLike = async () => { throw new TypeError('fetch failed') }
    expect((await failure(new OpenVsxClient(offline).search({ query: 'harbor', sortBy: 'rating' }))).code).toBe('network')
  })

  it('reads extension details only with allowed download hosts and a Themes category', () => {
    const detail = {
      namespace: 'a', name: 'b', version: '1.0.0', categories: ['Themes'], license: 'MIT', repository: 'https://github.com/a/b',
      files: { download: 'https://open-vsx.org/api/a/b/1/file/b.vsix', sha256: 'https://open-vsx.org/api/a/b/1/file/b.sha256' },
    }
    expect(parseExtensionDetail(detail)?.extension.sourceUrl).toBe('https://github.com/a/b')
    expect(parseExtensionDetail({ ...detail, repository: 'javascript:alert(1)' })?.extension.sourceUrl).toBeNull()
    expect(parseExtensionDetail({ ...detail, categories: ['Linters'] })).toBeNull()
    expect(parseExtensionDetail({ ...detail, files: { download: 'http://open-vsx.org/b.vsix' } })).toBeNull()
    expect(parseExtensionDetail({ ...detail, files: { download: 'https://open-vsx.org.evil.example/b.vsix' } })).toBeNull()
  })
})

describe('VSIX theme extraction', () => {
  it('parses the JSONC theme files VS Code accepts', () => {
    expect(parseJsonc('{ // note\n "a": "x // not a comment", /* block */ "b": [1, 2,], }')).toEqual({ a: 'x // not a comment', b: [1, 2] })
  })

  it('refuses ZIP64 and encrypted archives', () => {
    const zip = createZip([{ name: 'extension/package.json', data: manifest([]) }])
    const zip64 = Buffer.from(zip)
    zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10)
    expect(() => readZipDirectory(zip64)).toThrow(/ZIP format/u)

    const encrypted = Buffer.from(zip)
    const central = encrypted.readUInt32LE(encrypted.length - 22 + 16)
    encrypted.writeUInt16LE(1, central + 8)
    expect(() => readZipDirectory(encrypted)).toThrow(/encrypted/u)
  })

  it('refuses an entry that inflates suspiciously well', () => {
    const bomb = createZip([
      { name: 'extension/package.json', data: manifest([{ label: 'Bomb', uiTheme: 'vs-dark', path: './bomb.json' }]) },
      { name: 'extension/bomb.json', data: `{"colors":{"editor.background":"#000000"},"pad":"${' '.repeat(200_000)}"}` },
    ])
    expect(() => extractVsixThemes(bomb, extension)).toThrow(/compressed suspiciously well/u)
  })

  it('refuses the whole extension when any theme reaches outside it, loops, or cannot be read', () => {
    const ok = { name: 'extension/themes/ok.json', data: '{"colors":{"editor.background":"#202020","focusBorder":"#4080ff"}}', stored: true }
    const fine = { label: 'Fine', uiTheme: 'vs-dark', path: './themes/ok.json' }
    const withTheme = (contribution: Record<string, unknown>, ...files: Array<{ name: string; data: string }>) => createZip([
      { name: 'extension/package.json', data: manifest([contribution, fine]) },
      { name: 'secret.json', data: '{"colors":{"editor.background":"#ff0000"}}' },
      ok,
      ...files,
    ])
    expect(extractVsixThemes(createZip([{ name: 'extension/package.json', data: manifest([fine]) }, ok]), extension).map(theme => theme.label)).toEqual(['Fine'])
    const hostile = [
      withTheme({ label: 'Escape Dark', uiTheme: 'vs-dark', path: './themes/escape.json' }, { name: 'extension/themes/escape.json', data: '{"include":"../../secret.json","colors":{"editor.background":"#111111"}}' }),
      withTheme({ label: 'Loop Dark', uiTheme: 'vs-dark', path: './themes/loop.json' }, { name: 'extension/themes/loop.json', data: '{"include":"./loop.json","colors":{"editor.background":"#111111"}}' }),
      withTheme({ label: 'Absolute Dark', uiTheme: 'vs-dark', path: '/extension/themes/ok.json' }),
      withTheme({ label: 'Parent Dark', uiTheme: 'vs-dark', path: '../secret.json' }),
      withTheme({ label: 'Broken', uiTheme: 'vs-dark', path: './broken.json' }, { name: 'extension/broken.json', data: '{ nope' }),
    ]
    for (const archive of hostile) {
      const error = (() => { try { extractVsixThemes(archive, extension); return null } catch (cause) { return cause } })()
      expect(error).toBeInstanceOf(OpenVsxFailure)
      expect((error as OpenVsxFailure).code).toBe('rejected')
    }
  })

  it('rejects an extension that contributes no color themes', () => {
    expect(() => extractVsixThemes(createZip([{ name: 'extension/package.json', data: manifest([]) }]), extension)).toThrow(/contributes no color themes/u)
  })

  it('gives each variant a stable id derived from the collection', () => {
    const first = extractVsixThemes(createThemeVsix(), extension)
    const second = extractVsixThemes(createThemeVsix(), extension)
    expect(first.map(theme => theme.id)).toEqual(second.map(theme => theme.id))
    const expected = `ovx-${createHash('sha256').update(`${extension.collectionId}\nharbor`).digest('hex').slice(0, 12)}`
    expect(first[0]!.id).toBe(expected)
  })
})
