/**
 * Whether a file is a USDZ a phone can turn (the Meshy plan's ticket 7): a whole ZIP archive, kept without compression,
 * whose first file is a USD layer, as Pixar's USDZ specification lays one out. The phone opens it in the app's own 3D
 * view, which reads files on the phone and fetches nothing, so the check is that it is one, whole, before a byte of it
 * leaves the computer; a file that is not is refused whole, as a GLB that is not one is.
 *
 * The layout, from the ZIP specification: a local file header (`PK\x03\x04`) for each file, its compression method at
 * byte 8, the lengths of its name and extra field at bytes 26 and 28 and its name at byte 30; and, last, an end of
 * central directory record (`PK\x05\x06`) of 22 bytes and a comment of at most 65,535.
 */

const LOCAL_FILE = 0x04034b50 // "PK\x03\x04", little-endian
const END_OF_DIRECTORY = 0x06054b50 // "PK\x05\x06"
const LOCAL_HEADER_BYTES = 30
const END_BYTES = 22
const COMMENT_MAX = 0xffff
const STORED = 0
/** The layers a USDZ may open with: text, binary, or either. */
const LAYER = /\.usd[ac]?$/u

/** What is wrong with a USDZ: not one at all, or cut short. */
export type UsdzProblem = 'not-usdz' | 'truncated'

/** Null when the bytes are a whole USDZ, or what is wrong with them. */
export function usdzProblem(bytes: Uint8Array): UsdzProblem | null {
  if (bytes.byteLength < LOCAL_HEADER_BYTES + END_BYTES || readUint32(bytes, 0) !== LOCAL_FILE) return 'not-usdz'
  if (readUint16(bytes, 8) !== STORED) return 'not-usdz'
  const nameLength = readUint16(bytes, 26)
  if (nameLength === 0 || LOCAL_HEADER_BYTES + nameLength > bytes.byteLength) return 'truncated'
  const name = new TextDecoder('utf-8').decode(bytes.subarray(LOCAL_HEADER_BYTES, LOCAL_HEADER_BYTES + nameLength)).toLowerCase()
  if (!LAYER.test(name)) return 'not-usdz'
  // The end of the central directory is in the last 22 bytes and a comment's length; a file without one was cut short.
  const earliest = Math.max(0, bytes.byteLength - END_BYTES - COMMENT_MAX)
  for (let at = bytes.byteLength - END_BYTES; at >= earliest; at--) {
    if (readUint32(bytes, at) === END_OF_DIRECTORY && at + END_BYTES + readUint16(bytes, at + 20) === bytes.byteLength) return null
  }
  return 'truncated'
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16 | bytes[offset + 3]! << 24) >>> 0
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | bytes[offset + 1]! << 8
}
