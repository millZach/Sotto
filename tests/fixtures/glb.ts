/**
 * A tiny binary glTF built in memory, for tests of the check that a GLB stands alone (ADR-0141). `json` is the JSON
 * chunk; `bin`, when given, the binary chunk. Both are padded to four bytes, as the GLB layout asks.
 */
export function glbBytes(json: unknown, bin?: Uint8Array): Uint8Array {
  const text = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonChunk = Buffer.concat([text, Buffer.alloc((4 - text.byteLength % 4) % 4, 0x20)])
  const binChunk = bin ? Buffer.concat([Buffer.from(bin), Buffer.alloc((4 - bin.byteLength % 4) % 4)]) : undefined
  const length = 12 + 8 + jsonChunk.byteLength + (binChunk ? 8 + binChunk.byteLength : 0)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(length, 8)
  const chunk = (type: number, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32LE(body.byteLength, 0)
    head.writeUInt32LE(type, 4)
    return Buffer.concat([head, body])
  }
  return new Uint8Array(Buffer.concat([header, chunk(0x4e4f534a, jsonChunk), ...(binChunk ? [chunk(0x004e4942, binChunk)] : [])]))
}

/** A GLB holding one triangle's buffer and one image, both in its own binary chunk. */
export function selfContainedGlb(): Uint8Array {
  const bin = new Uint8Array(48)
  return glbBytes({
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }],
    images: [{ bufferView: 1, mimeType: 'image/png' }],
  }, bin)
}
