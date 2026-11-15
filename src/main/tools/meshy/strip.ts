import type { RedrawPhoto } from './photo'

/**
 * A photo for a 3D model made on a paired host, with its location, camera and other metadata sections taken out of
 * the file itself and its pixels left exactly as they were (Zach's pick on #2497, November 15, 2026). A headless host
 * has no image library to draw the photo again as the desktop does, so it removes what is not the picture instead, in
 * plain Node. It is used where `photoToSend` would redraw, after the same checks of where the photo is, its pixel
 * count and its fingerprint.
 *
 * A JPEG keeps its JFIF header (APP0) and its colour profile (APP2 ICC_PROFILE), and loses every other application
 * segment (Exif and XMP among them, which hold the location and camera) and every comment. A PNG loses its eXIf,
 * tEXt, zTXt, iTXt and tIME chunks. Whatever a file carries after its end, as a phone's motion photo or a second
 * picture does, is left out too. A file that cannot be read through is not sent.
 */
export const stripPhoto: RedrawPhoto = async (bytes, kind) => {
  const stripped = kind === 'image/png' ? stripPng(bytes) : stripJpeg(bytes)
  return stripped ? { bytes: stripped, kind } : null
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** The PNG chunks that say something about the photo rather than draw it. */
const PNG_DROPPED = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'])

/** A PNG without its metadata chunks, each kept chunk byte for byte, up to and including IEND. Null when it cannot be read through. */
export function stripPng(bytes: Buffer): Buffer | null {
  if (bytes.byteLength < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  const kept: Buffer[] = [bytes.subarray(0, 8)]
  let at = 8
  while (at + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(at)
    const end = at + 12 + length
    if (end > bytes.byteLength) return null
    const type = bytes.toString('latin1', at + 4, at + 8)
    if (!PNG_DROPPED.has(type)) kept.push(bytes.subarray(at, end))
    if (type === 'IEND') return Buffer.concat(kept)
    at = end
  }
  return null
}

const JFIF = Buffer.from('JFIF\0', 'latin1')
const ICC = Buffer.from('ICC_PROFILE\0', 'latin1')

/**
 * A JPEG without its metadata segments, every kept segment and all of its compressed picture byte for byte, up to and
 * including its end marker. Null when it cannot be read through.
 */
export function stripJpeg(bytes: Buffer): Buffer | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const kept: Buffer[] = [bytes.subarray(0, 2)]
  let at = 2
  while (at + 2 <= bytes.byteLength) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]!
    // Fill bytes before a marker.
    if (marker === 0xff) { at++; continue }
    if (marker === 0xd9) { kept.push(bytes.subarray(at, at + 2)); return Buffer.concat(kept) }
    // Markers that stand alone, with no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { kept.push(bytes.subarray(at, at + 2)); at += 2; continue }
    if (at + 4 > bytes.byteLength) return null
    const length = bytes.readUInt16BE(at + 2)
    const end = at + 2 + length
    if (length < 2 || end > bytes.byteLength) return null
    const body = bytes.subarray(at + 4, end)
    const isApp = marker >= 0xe0 && marker <= 0xef
    const keep = marker === 0xfe ? false
      : !isApp ? true
        : marker === 0xe0 ? body.subarray(0, JFIF.byteLength).equals(JFIF)
          : marker === 0xe2 ? body.subarray(0, ICC.byteLength).equals(ICC)
            : false
    if (keep) kept.push(bytes.subarray(at, end))
    at = end
    // A scan's compressed picture follows its header, up to the next marker that is not a stuffed byte or a restart.
    if (marker === 0xda) {
      const start = at
      while (at + 1 < bytes.byteLength) {
        if (bytes[at] === 0xff) {
          const next = bytes[at + 1]!
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break
        }
        at++
      }
      if (at + 1 >= bytes.byteLength) return null
      kept.push(bytes.subarray(start, at))
    }
  }
  return null
}
