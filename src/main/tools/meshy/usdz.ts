/**
 * Whether a file is a USDZ a phone can turn (the Meshy plan's ticket 7): a whole ZIP archive of files kept without
 * compression, whose first file is a USD layer, as Pixar's USDZ specification lays one out. The phone opens it in the
 * app's own 3D view, which reads files on the phone and fetches nothing, so the check is that it is one, whole, before a
 * byte of it leaves the computer; a file that is not is refused whole, as a GLB that is not one is.
 *
 * The layout, from the ZIP specification: a local file header (`PK\x03\x04`) and the bytes of each file; then the
 * central directory, an entry (`PK\x01\x02`) for each file naming where its header is; and last the end of central
 * directory record (`PK\x05\x06`) of 22 bytes and a comment of at most 65,535, which says how many entries the directory
 * holds, how long it is and where it starts. Every entry is read and every file found where it says, inside the bytes
 * and before the directory, so an archive cut short or pointing past its end is refused even with its end record kept.
 * A ZIP64 archive, whose fields say "look elsewhere", is refused: a USDZ under the 64 MiB cap never needs one.
 */

const LOCAL_FILE = 0x04034b50 // "PK\x03\x04", little-endian
const DIRECTORY_ENTRY = 0x02014b50 // "PK\x01\x02"
const END_OF_DIRECTORY = 0x06054b50 // "PK\x05\x06"
const LOCAL_HEADER_BYTES = 30
const ENTRY_BYTES = 46
const END_BYTES = 22
const COMMENT_MAX = 0xffff
const STORED = 0
const ZIP64 = 0xffffffff
/** The layers a USDZ may open with: text, binary, or either. */
const LAYER = /\.usd[ac]?$/u

/** What is wrong with a USDZ: not one at all, or cut short or pointing past its end. */
export type UsdzProblem = 'not-usdz' | 'truncated'

/** Null when the bytes are a whole USDZ, or what is wrong with them. */
export function usdzProblem(bytes: Uint8Array): UsdzProblem | null {
  if (bytes.byteLength < LOCAL_HEADER_BYTES + END_BYTES || readUint32(bytes, 0) !== LOCAL_FILE) return 'not-usdz'
  const end = endOfDirectory(bytes)
  if (end === null) return 'truncated'
  const count = readUint16(bytes, end + 10), size = readUint32(bytes, end + 12), start = readUint32(bytes, end + 16)
  if (count === 0 || size === ZIP64 || start === ZIP64) return 'not-usdz'
  // The directory sits right before its end record, and holds exactly the entries the record counts.
  if (start + size !== end) return 'truncated'
  let at = start
  for (let index = 0; index < count; index++) {
    if (at + ENTRY_BYTES > end || readUint32(bytes, at) !== DIRECTORY_ENTRY) return 'truncated'
    const method = readUint16(bytes, at + 10), stored = readUint32(bytes, at + 20), nameLength = readUint16(bytes, at + 28)
    const extraLength = readUint16(bytes, at + 30), commentLength = readUint16(bytes, at + 32), local = readUint32(bytes, at + 42)
    if (method !== STORED || stored === ZIP64 || local === ZIP64 || nameLength === 0) return 'not-usdz'
    // Its file: a local header where the entry says, kept without compression, whose bytes end before the directory.
    if (local + LOCAL_HEADER_BYTES > start || readUint32(bytes, local) !== LOCAL_FILE) return 'truncated'
    if (readUint16(bytes, local + 8) !== STORED) return 'not-usdz'
    if (local + LOCAL_HEADER_BYTES + readUint16(bytes, local + 26) + readUint16(bytes, local + 28) + stored > start) return 'truncated'
    // The first file, at the archive's start, is the layer the phone opens.
    if (local === 0 && !LAYER.test(new TextDecoder('utf-8').decode(bytes.subarray(at + ENTRY_BYTES, at + ENTRY_BYTES + nameLength)).toLowerCase())) return 'not-usdz'
    at += ENTRY_BYTES + nameLength + extraLength + commentLength
  }
  if (at !== end) return 'truncated'
  // The archive's first file is listed: an entry names the header at its start.
  return firstListed(bytes, start, count) ? null : 'not-usdz'
}

/** Where the end of central directory record starts: in the last 22 bytes and a comment's length, ending the bytes. */
function endOfDirectory(bytes: Uint8Array): number | null {
  const earliest = Math.max(0, bytes.byteLength - END_BYTES - COMMENT_MAX)
  for (let at = bytes.byteLength - END_BYTES; at >= earliest; at--) {
    if (readUint32(bytes, at) === END_OF_DIRECTORY && at + END_BYTES + readUint16(bytes, at + 20) === bytes.byteLength) return at
  }
  return null
}

function firstListed(bytes: Uint8Array, start: number, count: number): boolean {
  let at = start
  for (let index = 0; index < count; index++) {
    if (readUint32(bytes, at + 42) === 0) return true
    at += ENTRY_BYTES + readUint16(bytes, at + 28) + readUint16(bytes, at + 30) + readUint16(bytes, at + 32)
  }
  return false
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16 | bytes[offset + 3]! << 24) >>> 0
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | bytes[offset + 1]! << 8
}
