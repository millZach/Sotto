import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * An app.asar carrying the provenance and manifest a packaged Owl would, written in one call. @electron/asar's
 * createPackage resolves before its stream finishes writing, so a fixture built with it can be read half-written.
 */
export async function owlAppAsar(destination, { sourceCommit, version, buildInputsRevision }) {
  const provenance = Buffer.from(JSON.stringify({ version: 2, sourceCommit, buildInputsRevision, buildSha256: 'd'.repeat(64), artifacts: [] }))
  const manifest = Buffer.from(JSON.stringify({ name: 'sotto', version }))
  const header = Buffer.from(JSON.stringify({ files: {
    out: { files: { 'build-provenance.json': { size: provenance.length, offset: '0' } } },
    'package.json': { size: manifest.length, offset: String(provenance.length) },
  } }))
  // Two Chromium pickles: the first holds the second's size, the second the header string padded to four bytes.
  const headerPickle = Buffer.alloc(8 + Math.ceil(header.length / 4) * 4)
  headerPickle.writeUInt32LE(headerPickle.length - 4, 0); headerPickle.writeUInt32LE(header.length, 4); header.copy(headerPickle, 8)
  const sizePickle = Buffer.alloc(8); sizePickle.writeUInt32LE(4, 0); sizePickle.writeUInt32LE(headerPickle.length, 4)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, Buffer.concat([sizePickle, headerPickle, provenance, manifest]))
}
