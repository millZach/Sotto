/**
 * Whether a GLB stands alone (ADR-0141): a binary glTF 2.0 file whose every buffer and image is inside it. glTF lets a
 * buffer or an image name a `uri`, a file beside it, an address anywhere or a data address, and a viewer would fetch
 * it. Sotto draws a 3D model from its own bytes only, so a GLB that names any `uri` there is refused whole, before
 * the window is handed a byte of it.
 *
 * The layout, from the glTF 2.0 specification's GLB section: a 12-byte header (`glTF`, version 2, the whole length),
 * then chunks of a length, a type and that many bytes; the first chunk is the JSON, and a binary chunk may follow.
 */

const MAGIC = 0x46546c67 // "glTF", little-endian
const JSON_CHUNK = 0x4e4f534a // "JSON"
const HEADER_BYTES = 12
const CHUNK_HEADER_BYTES = 8

/** What is wrong with a GLB: not one at all, cut short, or one that points outside itself. */
export type GlbProblem = 'not-glb' | 'truncated' | 'external'

/** Null when the GLB stands alone, or what is wrong with it. */
export function glbProblem(bytes: Uint8Array): GlbProblem | null {
  if (bytes.byteLength < HEADER_BYTES) return bytes.byteLength >= 4 && readUint32(bytes, 0) === MAGIC ? 'truncated' : 'not-glb'
  if (readUint32(bytes, 0) !== MAGIC || readUint32(bytes, 4) !== 2) return 'not-glb'
  const length = readUint32(bytes, 8)
  if (length > bytes.byteLength) return 'truncated'
  if (length < HEADER_BYTES + CHUNK_HEADER_BYTES) return 'not-glb'
  let offset = HEADER_BYTES
  let json: unknown
  let first = true
  while (offset < length) {
    if (offset + CHUNK_HEADER_BYTES > length) return 'truncated'
    const chunkLength = readUint32(bytes, offset)
    const type = readUint32(bytes, offset + 4)
    const start = offset + CHUNK_HEADER_BYTES
    if (start + chunkLength > length) return 'truncated'
    if (first) {
      if (type !== JSON_CHUNK) return 'not-glb'
      try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, start + chunkLength))) } catch { return 'not-glb' }
      first = false
    } else if (type === JSON_CHUNK) return 'not-glb'
    // The binary chunk holds the buffer, and a chunk of a type glTF does not know is skipped, as the specification says.
    offset = start + chunkLength
  }
  if (first || typeof json !== 'object' || json === null || Array.isArray(json)) return 'not-glb'
  for (const list of ['buffers', 'images'] as const) {
    const entries = (json as Record<string, unknown>)[list]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) return 'not-glb'
    // Any `uri` at all, even an empty one or a data address: everything a drawing needs is in the file's own chunk.
    if (entries.some(entry => typeof entry !== 'object' || entry === null || Object.hasOwn(entry, 'uri'))) return 'external'
  }
  return null
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}
