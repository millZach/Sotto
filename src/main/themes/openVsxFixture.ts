/*
 * An offline Open VSX for end-to-end runs and unit tests: a fake fetch that
 * serves a search, extension details, checksums and a VSIX built in memory, so
 * the real download, checksum, archive and import path runs without network.
 */

import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'

import type { FetchLike } from './openVsx'

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipFixtureEntry {
  readonly name: string
  readonly data: Buffer | string
  /** Store instead of deflate. */
  readonly stored?: boolean
}

/** A minimal ZIP archive, deflated unless an entry asks to be stored. */
export function createZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const body = entry.stored ? data : deflateRawSync(data)
    const name = Buffer.from(entry.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.stored ? 0 : 8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.stored ? 0 : 8, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** A two-variant colour-theme extension, like the ones on Open VSX. */
export function createThemeVsix(): Buffer {
  const manifest = {
    name: 'harbor-theme',
    publisher: 'sotto-fixtures',
    contributes: {
      themes: [
        { label: 'Harbor Light', uiTheme: 'vs', path: './themes/harbor-light.json' },
        { label: 'Harbor Dark', uiTheme: 'vs-dark', path: './themes/harbor-dark.json' },
      ],
    },
  }
  const dark = `{
    // Base colours shared by the dark variant.
    "include": "./harbor-base.json",
    "colors": {
      "editor.background": "#102a33",
      "focusBorder": "#3fb6a8",
      "button.background": "#3fb6a8",
      "editor.foreground": "#dcefee",
    },
    "tokenColors": [{ "scope": "comment", "settings": { "foreground": "#5f7d85" } }]
  }`
  return createZip([
    { name: 'extension.vsixmanifest', data: '<PackageManifest />' },
    { name: 'extension/package.json', data: JSON.stringify(manifest) },
    { name: 'extension/themes/harbor-base.json', data: JSON.stringify({ colors: { 'sideBar.background': '#0c222a', 'workbench.unknownKey': 'url(javascript:alert(1))' } }) },
    { name: 'extension/themes/harbor-dark.json', data: dark },
    { name: 'extension/themes/harbor-light.json', data: JSON.stringify({ type: 'light', colors: { 'editor.background': '#f4fbfa', 'focusBorder': '#1f7f75', 'editor.foreground': '#15313a' } }), stored: true },
  ])
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * A fetch that answers like Open VSX for one MIT-licensed theme extension and
 * one GPL extension (which must never be offered). The VSIX download redirects
 * to blob storage, as the real service does.
 */
export function createOpenVsxFixtureFetch(vsix: Buffer = createThemeVsix()): FetchLike {
  const checksum = createHash('sha256').update(vsix).digest('hex')
  const base = 'https://open-vsx.org/api'
  const blob = 'https://openvsxorg.blob.core.windows.net/resources/sotto-fixtures/harbor-theme/1.2.0'
  const detail = (name: string, license: string) => ({
    namespace: 'sotto-fixtures',
    name,
    version: '1.2.0',
    displayName: name === 'harbor-theme' ? 'Harbor Theme' : 'Copyleft Theme',
    description: 'A calm teal colour theme for testing Sotto.',
    downloadCount: 12_345,
    license,
    categories: ['Themes'],
    repository: 'https://github.com/sotto-fixtures/harbor-theme',
    files: {
      download: `${base}/sotto-fixtures/${name}/1.2.0/file/${name}.vsix`,
      sha256: `${base}/sotto-fixtures/${name}/1.2.0/file/${name}.sha256`,
    },
  })
  return async url => {
    const parsed = new URL(url)
    if (parsed.pathname === '/api/-/search') {
      return json({ offset: 0, totalSize: 2, extensions: [{ namespace: 'sotto-fixtures', name: 'harbor-theme' }, { namespace: 'sotto-fixtures', name: 'copyleft-theme' }] })
    }
    if (parsed.pathname === '/api/sotto-fixtures/harbor-theme') return json(detail('harbor-theme', 'MIT'))
    if (parsed.pathname === '/api/sotto-fixtures/copyleft-theme') return json(detail('copyleft-theme', 'GPL-3.0-only'))
    if (parsed.pathname.endsWith('/harbor-theme.sha256')) return new Response(`${checksum}  harbor-theme.vsix`)
    if (parsed.pathname.endsWith('/harbor-theme.vsix')) return new Response(null, { status: 302, headers: { location: `${blob}/harbor-theme.vsix` } })
    if (parsed.hostname === 'openvsxorg.blob.core.windows.net') return new Response(new Uint8Array(vsix), { headers: { 'content-length': String(vsix.length) } })
    return json({ error: 'not found' }, 404)
  }
}
