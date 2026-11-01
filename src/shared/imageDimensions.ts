/**
 * A picture's width and height read from its own header, without decoding it: PNG, GIF, JPEG and WebP. Undefined when the
 * header is not one of those or is cut short. Used where only the size is wanted and decoding would cost the whole picture
 * (ADR-0170): a tile keeps its place before its thumbnail arrives.
 */
export function imageDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  const at = (index: number): number => bytes[index] ?? 0
  const be16 = (index: number): number => at(index) << 8 | at(index + 1)
  const le16 = (index: number): number => at(index) | at(index + 1) << 8
  const be32 = (index: number): number => (at(index) << 24 >>> 0) + (at(index + 1) << 16) + (at(index + 2) << 8) + at(index + 3)
  const sized = (width: number, height: number) => width > 0 && height > 0 ? { width, height } : undefined
  // PNG: the signature, then IHDR's width and height.
  if (bytes.length >= 24 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return sized(be32(16), be32(20))
  // GIF87a or GIF89a: the logical screen's size.
  if (bytes.length >= 10 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return sized(le16(6), le16(8))
  // JPEG: walk the segments to the first start-of-frame.
  if (bytes.length >= 4 && at(0) === 0xff && at(1) === 0xd8) {
    let index = 2
    while (index + 9 < bytes.length) {
      if (at(index) !== 0xff) return undefined
      const marker = at(index + 1)
      if (marker === 0xff) { index += 1; continue }
      if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { index += 2; continue }
      const length = be16(index + 2)
      if (length < 2) return undefined
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return sized(be16(index + 7), be16(index + 5))
      index += 2 + length
    }
    return undefined
  }
  // WebP: RIFF....WEBP and its first chunk.
  if (bytes.length >= 30 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
    const chunk = String.fromCharCode(at(12), at(13), at(14), at(15))
    if (chunk === 'VP8X') return sized(1 + (at(24) | at(25) << 8 | at(26) << 16), 1 + (at(27) | at(28) << 8 | at(29) << 16))
    if (chunk === 'VP8 ') return sized(le16(26) & 0x3fff, le16(28) & 0x3fff)
    if (chunk === 'VP8L') {
      const bits = at(21) | at(22) << 8 | at(23) << 16 | at(24) << 24
      return sized((bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1)
    }
  }
  return undefined
}
