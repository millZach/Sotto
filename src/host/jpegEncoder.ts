/**
 * A baseline JPEG writer for the headless host's picture copies (ADR-0202), written from the JPEG standard (ITU-T T.81:
 * its Annex K quantization and Huffman tables, the zigzag order, and the coding of DC and AC coefficients). It writes
 * colour at half resolution each way (4:2:0), as Electron's JPEG writer does on the desktop, so a copy is about the size
 * the desktop's would be: jpeg-js, which the host decodes with, writes colour at full resolution, half as large again at
 * the same quality. Pixels are four bytes each, red, green, blue and alpha; alpha is not written, as a JPEG has none.
 */
import type { Pixels } from './pictureCopy'

/** Natural (row by row) index of each coefficient in zigzag order. */
const ZIGZAG = Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
])
/** Annex K.1's luminance and chrominance quantization tables, in natural order. */
const LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
]
const CHROMA_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...Array<number>(32).fill(99),
]
/** Annex K.3's typical Huffman tables: how many codes of each length from 1 to 16, then the symbols in code order. */
interface HuffmanSpec { readonly counts: readonly number[]; readonly symbols: readonly number[] }
const LUMA_DC: HuffmanSpec = { counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
const CHROMA_DC: HuffmanSpec = { counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
const LUMA_AC: HuffmanSpec = { counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], symbols: [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
] }
const CHROMA_AC: HuffmanSpec = { counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], symbols: [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
] }

/** A table's code and code length for each symbol (Annex C): codes of one length count up, then double for the next. */
interface HuffmanCodes { readonly code: Uint16Array; readonly length: Uint8Array }
function codesOf(spec: HuffmanSpec): HuffmanCodes {
  const code = new Uint16Array(256), length = new Uint8Array(256)
  let next = 0, at = 0
  for (let bits = 1; bits <= 16; bits++) {
    for (let count = 0; count < spec.counts[bits - 1]!; count++) { const symbol = spec.symbols[at++]!; code[symbol] = next++; length[symbol] = bits }
    next <<= 1
  }
  return { code, length }
}
const CODES = { lumaDc: codesOf(LUMA_DC), lumaAc: codesOf(LUMA_AC), chromaDc: codesOf(CHROMA_DC), chromaAc: codesOf(CHROMA_AC) }

/** Each table scaled to `quality` as libjpeg scales it, so quality 85 here means what it means to Electron's writer. */
function quantized(base: readonly number[], quality: number): Uint8Array {
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2
  return Uint8Array.from(base, value => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))))
}

/** The 8-point DCT's basis: `BASIS[u * 8 + x]` is C(u)/2 * cos((2x + 1)uπ/16). */
const BASIS = Float64Array.from({ length: 64 }, (_, index) => {
  const u = index >> 3, x = index & 7
  return (u === 0 ? Math.SQRT1_2 : 1) / 2 * Math.cos((2 * x + 1) * u * Math.PI / 16)
})

/** Where the coded bytes go, with a byte of zero after every 0xFF the entropy-coded data writes (B.1.1.5). */
class Writer {
  private bytes = new Uint8Array(1 << 16)
  private size = 0
  private bits = 0
  private count = 0
  private room(more: number): void {
    if (this.size + more <= this.bytes.length) return
    const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.size + more))
    grown.set(this.bytes.subarray(0, this.size)); this.bytes = grown
  }
  byte(value: number): void { this.room(1); this.bytes[this.size++] = value }
  word(value: number): void { this.byte(value >> 8 & 0xff); this.byte(value & 0xff) }
  all(values: ArrayLike<number>): void { for (let index = 0; index < values.length; index++) this.byte(values[index]!) }
  /** `length` bits of `value`, most significant first. */
  put(value: number, length: number): void {
    this.bits = (this.bits << length | value & (1 << length) - 1) >>> 0
    this.count += length
    while (this.count >= 8) {
      const byte = this.bits >>> this.count - 8 & 0xff
      this.byte(byte)
      if (byte === 0xff) this.byte(0)
      this.count -= 8
      this.bits &= (1 << this.count) - 1
    }
  }
  /** The last byte filled out with one bits (F.1.2.3). */
  flush(): void { if (this.count > 0) this.put((1 << 8 - this.count) - 1, 8 - this.count) }
  result(): Buffer { return Buffer.from(this.bytes.buffer, 0, this.size) }
}

/** The bits a coefficient's magnitude needs, its "size" category (F.1.2.1). */
const sizeOf = (value: number): number => value === 0 ? 0 : 32 - Math.clz32(Math.abs(value))

/**
 * Codes one 8x8 block (`block`, level-shifted samples in natural order) and answers its DC value for the next block's
 * difference: the forward DCT, quantization by `quant`, the DC difference, then the AC coefficients in zigzag order as
 * runs of zeros (F.1.2).
 */
function codeBlock(out: Writer, block: Float64Array, quant: Uint8Array, previousDc: number, dc: HuffmanCodes, ac: HuffmanCodes, rows: Float64Array, coefficients: Int32Array): number {
  // Rows, then columns: rows[y * 8 + u] = Σx block[y * 8 + x] * BASIS[u * 8 + x].
  for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) {
    let sum = 0
    for (let x = 0; x < 8; x++) sum += block[y * 8 + x]! * BASIS[u * 8 + x]!
    rows[y * 8 + u] = sum
  }
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let sum = 0
    for (let y = 0; y < 8; y++) sum += rows[y * 8 + u]! * BASIS[v * 8 + y]!
    coefficients[v * 8 + u] = Math.round(sum / quant[v * 8 + u]!)
  }
  const value = coefficients[0]!, difference = value - previousDc, size = sizeOf(difference)
  out.put(dc.code[size]!, dc.length[size]!)
  if (size) out.put(difference < 0 ? difference + (1 << size) - 1 : difference, size)
  let zeros = 0
  for (let k = 1; k < 64; k++) {
    const coefficient = coefficients[ZIGZAG[k]!]!
    if (coefficient === 0) { zeros++; continue }
    for (; zeros > 15; zeros -= 16) out.put(ac.code[0xf0]!, ac.length[0xf0]!)
    const bits = sizeOf(coefficient), symbol = zeros << 4 | bits
    out.put(ac.code[symbol]!, ac.length[symbol]!)
    out.put(coefficient < 0 ? coefficient + (1 << bits) - 1 : coefficient, bits)
    zeros = 0
  }
  // End of block, unless the last coefficient was not zero.
  if (zeros) out.put(ac.code[0]!, ac.length[0]!)
  return value
}

function writeHuffman(out: Writer, kind: number, spec: HuffmanSpec): void {
  out.byte(kind); out.all(spec.counts); out.all(spec.symbols)
}

/** `picture` as a baseline JFIF JPEG at `quality` (1 to 100), its colour at half resolution each way. */
export function encodeJpeg(picture: Pixels, quality: number): Buffer {
  const { width, height, data } = picture
  const level = Math.min(100, Math.max(1, Math.round(quality)))
  const lumaQuant = quantized(LUMA_QUANT, level), chromaQuant = quantized(CHROMA_QUANT, level)
  const out = new Writer()
  out.word(0xffd8)
  // JFIF 1.01, square pixels, no thumbnail.
  out.word(0xffe0); out.word(16); out.all([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]); out.word(1); out.word(1); out.byte(0); out.byte(0)
  out.word(0xffdb); out.word(2 + 2 * 65)
  out.byte(0); for (let k = 0; k < 64; k++) out.byte(lumaQuant[ZIGZAG[k]!]!)
  out.byte(1); for (let k = 0; k < 64; k++) out.byte(chromaQuant[ZIGZAG[k]!]!)
  // Baseline, eight bits, three components: luminance sampled 2x2 against each chrominance's 1x1.
  out.word(0xffc0); out.word(17); out.byte(8); out.word(height); out.word(width); out.byte(3)
  out.all([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  out.word(0xffc4); out.word(2 + 4 * 17 + LUMA_DC.symbols.length + LUMA_AC.symbols.length + CHROMA_DC.symbols.length + CHROMA_AC.symbols.length)
  writeHuffman(out, 0x00, LUMA_DC); writeHuffman(out, 0x10, LUMA_AC); writeHuffman(out, 0x01, CHROMA_DC); writeHuffman(out, 0x11, CHROMA_AC)
  out.word(0xffda); out.word(12); out.byte(3); out.all([1, 0x00, 2, 0x11, 3, 0x11]); out.all([0, 63, 0])

  const block = new Float64Array(64), cb = new Float64Array(64), cr = new Float64Array(64)
  const rows = new Float64Array(64), coefficients = new Int32Array(64)
  let dcY = 0, dcCb = 0, dcCr = 0
  // A sample past the picture's right or bottom edge repeats the edge's own.
  const at = (x: number, y: number): number => (Math.min(y, height - 1) * width + Math.min(x, width - 1)) * 4
  for (let top = 0; top < height; top += 16) for (let left = 0; left < width; left += 16) {
    // Four luminance blocks, left to right and top to bottom, then one of each chrominance from the 16x16 averaged 2x2.
    for (let quarter = 0; quarter < 4; quarter++) {
      const x0 = left + (quarter & 1) * 8, y0 = top + (quarter >> 1) * 8
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const p = at(x0 + x, y0 + y)
        block[y * 8 + x] = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]! - 128
      }
      dcY = codeBlock(out, block, lumaQuant, dcY, CODES.lumaDc, CODES.lumaAc, rows, coefficients)
    }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const p = at(left + x * 2, top + y * 2), q = at(left + x * 2 + 1, top + y * 2)
      const r = at(left + x * 2, top + y * 2 + 1), s = at(left + x * 2 + 1, top + y * 2 + 1)
      const red = (data[p]! + data[q]! + data[r]! + data[s]!) / 4
      const green = (data[p + 1]! + data[q + 1]! + data[r + 1]! + data[s + 1]!) / 4
      const blue = (data[p + 2]! + data[q + 2]! + data[r + 2]! + data[s + 2]!) / 4
      cb[y * 8 + x] = -0.168736 * red - 0.331264 * green + 0.5 * blue
      cr[y * 8 + x] = 0.5 * red - 0.418688 * green - 0.081312 * blue
    }
    dcCb = codeBlock(out, cb, chromaQuant, dcCb, CODES.chromaDc, CODES.chromaAc, rows, coefficients)
    dcCr = codeBlock(out, cr, chromaQuant, dcCr, CODES.chromaDc, CODES.chromaAc, rows, coefficients)
  }
  out.flush()
  out.word(0xffd9)
  return out.result()
}
