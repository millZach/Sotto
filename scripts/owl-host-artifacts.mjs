import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { TextDecoder } from 'node:util'
import { checkedFullOwlVersion } from './owl-release.mjs'
import { sha256, verifyHostArchive } from './verify-host-archive.mjs'

export const OWL_HOST_ARCHIVE_LIMIT = 512 * 1024 * 1024
const archivePattern = /^Sotto-host-(.+)-(linux|darwin|win32)-([a-z0-9]+)\.tar\.gz$/u
export function checkedOwlHostVersion(version) {
  return checkedFullOwlVersion(version, { form: 'Supply a full Sotto Owl host version', date: 'Supply a valid UTC date in the Owl host version' })
}

function archivePath(value) {
  if (value === '.' || value === './') return ''
  const path = value.replace(/^(?:\.\/)+/u, '').replace(/\/$/u, '')
  if (!path || path.length > 4096 || /[\\:\p{Cc}]/u.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || posix.normalize(path) !== path) {
    throw new Error('Host archive contains an unsafe path')
  }
  return path
}
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
function octal(field) {
  const value = utf8(field).replace(/\0.*$/su, '').trim()
  if (!/^[0-7]+$/u.test(value)) throw new Error('Host archive contains an unsupported tar number')
  const number = parseInt(value, 8)
  if (!Number.isSafeInteger(number) || number < 0 || number > OWL_HOST_ARCHIVE_LIMIT) throw new Error('Host archive tar entry exceeds the size limit')
  return number
}
function paxFields(bytes) {
  const fields = {}
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset)
    if (space < 0) throw new Error('Invalid host archive tar metadata')
    const lengthText = utf8(bytes.subarray(offset, space))
    if (!/^[1-9]\d*$/u.test(lengthText)) throw new Error('Invalid host archive tar metadata')
    const length = Number(lengthText), end = offset + length
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || end > bytes.length || bytes[end - 1] !== 10) throw new Error('Invalid host archive tar metadata')
    const item = utf8(bytes.subarray(space + 1, end - 1)), equals = item.indexOf('=')
    if (equals <= 0) throw new Error('Invalid host archive tar metadata')
    fields[item.slice(0, equals)] = item.slice(equals + 1)
    offset = end
  }
  return fields
}
/** Inspect bounded decompressed tar bytes before extraction; links and traversal never reach tar. */
export function safeHostTarInventory(compressed) {
  if (compressed.length > OWL_HOST_ARCHIVE_LIMIT) throw new Error('Host archive exceeds the size limit')
  const bytes = gunzipSync(compressed, { maxOutputLength: OWL_HOST_ARCHIVE_LIMIT })
  const entries = new Map()
  let metadata = {}, longName
  for (let offset = 0, headers = 0; offset + 512 <= bytes.length; headers++) {
    if (headers >= 20000) throw new Error('Host archive has too many tar entries')
    const header = bytes.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (bytes.subarray(offset).some(byte => byte !== 0) || longName !== undefined || Object.keys(metadata).length) throw new Error('Invalid host archive tar ending')
      return entries
    }
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]
    if (octal(header.subarray(148, 156)) !== checksum) throw new Error('Host archive tar checksum does not match')
    const string = (start, end) => utf8(header.subarray(start, end)).replace(/\0.*$/su, '')
    const prefix = string(345, 500), name = prefix ? `${prefix}/${string(0, 100)}` : string(0, 100)
    const size = octal(header.subarray(124, 136)), type = String.fromCharCode(header[156] || 48)
    offset += 512
    if (offset + size > bytes.length) throw new Error('Truncated host archive tar entry')
    const body = bytes.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (type === 'x' || type === 'L') {
      if (size > 512 * 1024) throw new Error('Host archive tar metadata exceeds the size limit')
      if (type === 'x') metadata = { ...metadata, ...paxFields(body) }
      else longName = utf8(body).replace(/\0.*$/su, '')
      continue
    }
    if (type !== '0' && type !== '5' || string(157, 257) || metadata.linkpath !== undefined) throw new Error('Host archive may contain only regular files and directories')
    if (metadata.size !== undefined && metadata.size !== String(size)) throw new Error('Unsupported host archive tar size override')
    const path = archivePath(metadata.path ?? longName ?? name)
    metadata = {}; longName = undefined
    if (!path && type === '5') continue
    if (!path || entries.has(path)) throw new Error('Host archive contains repeated tar paths')
    entries.set(path, type === '5' ? 'directory' : 'file')
  }
  throw new Error('Host archive has no complete tar ending')
}

/** Publication trusts extracted bytes and provenance, never a packaging receipt beside them. */
export async function verifyOwlHostArtifact(archive, { version, sourceCommit } = {}) {
  checkedOwlHostVersion(version)
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? '')) throw new Error('Supply a full lower-case source commit')
  const path = resolve(archive), name = basename(path), match = archivePattern.exec(name)
  if (!match || match[1] !== version) throw new Error('Host archive filename does not match the Owl release')
  const info = await lstat(path)
  if (!info.isFile() || info.size < 1 || info.size > OWL_HOST_ARCHIVE_LIMIT) throw new Error('Host archive must be a bounded regular file')
  const bytes = await readFile(path), digest = sha256(bytes)
  const sidecarPath = `${path}.sha256`, sidecarInfo = await lstat(sidecarPath)
  if (!sidecarInfo.isFile() || sidecarInfo.size > 4096) throw new Error('Invalid host archive checksum sidecar')
  const sidecarBytes = await readFile(sidecarPath), sidecar = sidecarBytes.toString('utf8').trim()
  if (sidecar !== `${digest}  ${name}`) throw new Error('Host archive checksum sidecar does not match its bytes and filename')
  const inventory = safeHostTarInventory(bytes)
  for (const [entry, kind] of inventory) {
    const parts = entry.split('/')
    while (parts.length > 1) { parts.pop(); if (inventory.get(parts.join('/')) === 'file') throw new Error('Host archive has conflicting tar paths') }
    if (kind === 'directory' && entry.endsWith('.json')) throw new Error('Host archive contains an invalid metadata directory')
  }
  const temporary = await mkdtemp(join(tmpdir(), 'sotto-owl-host-verify-'))
  if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('sotto-owl-host-verify-')) throw new Error('Unexpected host archive verification directory')
  try {
    // Extract the exact bytes inspected above, so a concurrent replacement cannot bypass the path checks.
    const unpacked = join(temporary, 'unpacked'); await mkdir(unpacked)
    await writeFile(join(temporary, 'archive.tar.gz'), bytes)
    execFileSync('tar', ['-xzf', 'archive.tar.gz', '-C', unpacked], { cwd: temporary, windowsHide: true, timeout: 30000, stdio: 'ignore' })
    const verified = await verifyHostArchive(unpacked, { expectedVersion: version, expectedSourceCommit: sourceCommit, requireClean: true })
    if (verified.manifest.platform !== match[2] || verified.manifest.arch !== match[3] ||
      verified.provenance.builder?.platform !== match[2] || verified.provenance.builder?.arch !== match[3]) throw new Error('Host archive platform does not match its native build and filename')
    const files = [...inventory].filter(([, kind]) => kind === 'file').map(([path]) => path).sort()
    const expectedFiles = [...verified.provenance.artifacts.map(file => file.path), 'build-provenance.json'].sort()
    if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) throw new Error('Host archive extracted inventory does not match its tar entries')
    return { archive: path, sidecar: sidecarPath, version, sourceCommit, platform: match[2], arch: match[3], sha256: digest, sidecarSha256: sha256(sidecarBytes) }
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}
