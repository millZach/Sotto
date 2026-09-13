/** Only raster signatures are eligible for data URLs. Never infer MIME from a filename. */
export function rasterImage(buffer: Buffer): { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; width: number; height: number } | null {
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('latin1', 12, 16) === 'IHDR' && buffer.readUInt32BE(8) === 13) {
    return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length >= 13 && /^(GIF87a|GIF89a)$/.test(buffer.toString('latin1', 0, 6))) {
    return { mime: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  if (buffer.length >= 30 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    const kind = buffer.toString('latin1', 12, 16)
    if (kind === 'VP8X') return { mime: 'image/webp', width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) }
    if (kind === 'VP8L' && buffer[20] === 0x2f) {
      const packed = buffer.readUInt32LE(21)
      return { mime: 'image/webp', width: 1 + (packed & 0x3fff), height: 1 + ((packed >>> 14) & 0x3fff) }
    }
    if (kind === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      return { mime: 'image/webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
      while (buffer[offset] === 0xff) offset++
      const marker = buffer[offset++]
      if (marker === undefined || marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > buffer.length) break
      const length = buffer.readUInt16BE(offset)
      if (length < 2 || offset + length > buffer.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        return { mime: 'image/jpeg', height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) }
      }
      offset += length
    }
  }
  return null
}
