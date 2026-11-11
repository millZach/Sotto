import decodeJpeg from 'jpeg-js/lib/decoder'
import { read as readPng, write as writePng } from 'pngjs/lib/png-sync'
import { encodeJpeg } from './jpegEncoder'

/**
 * A headless host's copy of a picture at the longest edge a phone named (`thread-media-edge`, ADR-0203), made in the
 * picture worker (`pictureWorker.ts`) and never on the host's own thread, with pure JavaScript compiled into the host's
 * bundle: `jpeg-js`'s decoder and `pngjs` read the picture, and the copy is written by `pngjs` or by Sotto's own JPEG
 * writer (`jpegEncoder.ts`). It follows the desktop's maker (`mediaEdgeMaker`) rule for rule: fitted to `edge` by `edge`
 * and rounded the same way, a JPEG at quality 85 with colour at half resolution, a PNG when anything in the copy shows
 * through, and nothing when the picture already fits or cannot be read, so the phone is sent it whole. Where Electron
 * resizes with Skia, this averages each box of the picture's pixels that lands on one pixel of the copy.
 */

/** A picture as four bytes a pixel, red, green, blue and alpha. */
export interface Pixels { readonly width: number; readonly height: number; readonly data: Uint8Array }

/** What the host asks the picture worker: one picture, by its data URL, at one edge. */
export interface PictureRequest { readonly id: number; readonly dataUrl: string; readonly edge: number }
/**
 * What the worker answers: the copy as a data URL, or null for a picture already that small or one it cannot read, and
 * the worker's own process ID, which is never the host's.
 */
export interface PictureAnswer { readonly id: number; readonly copy: string | null; readonly pid: number }

/** The JPEG quality the desktop's maker writes at (`mediaThumbnail.ts`). */
export const PICTURE_COPY_QUALITY = 85
/**
 * The most pixels a picture may have for the host to decode it: a 4K screenshot's, past any photo the iPhone sends (2576
 * on its long side). Decoding and scaling a 4K JPEG holds about 220 MB in the worker for a moment; a larger picture is
 * sent whole rather than decoded on a machine short of memory.
 */
export const PICTURE_COPY_MAX_PIXELS = 3840 * 2160

const PNG_URL = 'data:image/png;base64,'
const JPEG_URL = 'data:image/jpeg;base64,'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The copy of the picture `dataUrl` holds at no more than `edge` on its longest side, or null to send it whole. Throws
 * for a PNG or JPEG that will not decode, or has more pixels than the host decodes; the worker sends that one whole too.
 */
export function pictureCopy(dataUrl: string, edge: number): string | null {
  const picture = decodedPicture(dataUrl)
  if (!picture) return null
  const size = fittedSize(picture.width, picture.height, edge)
  if (size.width === picture.width && size.height === picture.height) return null
  return encodedCopy(scaledDown(picture, size.width, size.height))
}

/**
 * The pixels of a PNG or JPEG data URL, or null for any other kind. Throws for one that will not decode, and for one with
 * more than `PICTURE_COPY_MAX_PIXELS`, which is refused from its header before anything is decoded.
 */
export function decodedPicture(dataUrl: string): Pixels | null {
  const png = dataUrl.startsWith(PNG_URL)
  if (!png && !dataUrl.startsWith(JPEG_URL)) return null
  const bytes = Buffer.from(dataUrl.slice(png ? PNG_URL.length : JPEG_URL.length), 'base64')
  return png ? decodedPng(bytes) : decodedJpeg(bytes)
}

/** `copy` as a data URL: a PNG when anything in it shows through, as the desktop's maker writes one, else a JPEG at 85. */
export function encodedCopy(copy: Pixels): string {
  return seeThrough(copy)
    ? `${PNG_URL}${writePng(copy, { colorType: 6, inputColorType: 6, inputHasAlpha: true, deflateLevel: 6 }).toString('base64')}`
    : `${JPEG_URL}${encodeJpeg(copy, PICTURE_COPY_QUALITY).toString('base64')}`
}

function decodedPng(bytes: Buffer): Pixels {
  // Its size is in the header that must come first, read before anything is inflated.
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') throw new Error('Not a PNG')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (width < 1 || height < 1 || width * height > PICTURE_COPY_MAX_PIXELS) throw new Error('Too many pixels')
  // An interlaced PNG is inflated by pngjs with no limit on what comes out, so a small file could fill the worker's
  // memory: it is sent whole, as the desktop would show it.
  if (bytes[28] !== 0) throw new Error('Interlaced')
  pngChunksChecked(bytes)
  const decoded = readPng(bytes)
  return { width: decoded.width, height: decoded.height, data: decoded.data }
}

/**
 * Walks a PNG's chunks before anything is decoded. pngjs takes the size from the last header it reads, so a second
 * header could carry a size past `PICTURE_COPY_MAX_PIXELS` after the first passed: a PNG with more than one is refused.
 * One that carries a colour profile (`iCCP`) is refused too, since the copy keeps the pixels as they are and would show
 * other colours than the picture does; it is sent whole.
 */
function pngChunksChecked(bytes: Buffer): void {
  let headers = 0
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('latin1', at + 4, at + 8)
    if (type === 'IHDR') headers++
    else if (type === 'iCCP') throw new Error('Colour profile')
    else if (type === 'IEND') break
    at += 12 + length
  }
  if (headers !== 1) throw new Error('More than one header')
}

/** Whether a JPEG carries a colour profile (an APP2 `ICC_PROFILE` segment) before its image data. */
function jpegHasProfile(bytes: Buffer): boolean {
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) return false
    const marker = bytes[at + 1]!
    // Start of scan or end of image: no segment past here describes the picture.
    if (marker === 0xda || marker === 0xd9) return false
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
    const length = bytes.readUInt16BE(at + 2)
    if (marker === 0xe2 && bytes.toString('latin1', at + 4, at + 16) === 'ICC_PROFILE\0') return true
    at += 2 + length
  }
  return false
}

function decodedJpeg(bytes: Buffer): Pixels {
  // A damaged JPEG is not guessed at: it is sent whole for the phone's own decoder to show as it can. jpeg-js reads the
  // size from the frame header and refuses one past the limit before it makes room for the pixels.
  // A JPEG with a colour profile is sent whole, as a PNG with one is.
  if (jpegHasProfile(bytes)) throw new Error('Colour profile')
  const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false,
    maxResolutionInMP: PICTURE_COPY_MAX_PIXELS / 1_000_000, maxMemoryUsageInMB: 256 })
  if (decoded.width < 1 || decoded.height < 1) throw new Error('No pixels')
  return decoded
}

/** `width` by `height` fitted inside `edge` by `edge`, rounded as the desktop's maker rounds it; as it is when it fits. */
export function fittedSize(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / width, edge / height)
  return scale >= 1 ? { width, height } : { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Whether any pixel of `picture` is less than opaque. */
export function seeThrough(picture: Pixels): boolean {
  const { data } = picture
  for (let at = 3; at < data.length; at += 4) if (data[at] !== 255) return true
  return false
}

/**
 * For each of `to` pixels along one side, the pixels of `from` its box covers and how much of each, as a share of the
 * box: the first one's index, how many, and their weights from `at` in one list.
 */
function boxes(from: number, to: number): { first: Int32Array; count: Int32Array; at: Int32Array; weights: Float32Array } {
  const ratio = from / to
  const first = new Int32Array(to), count = new Int32Array(to), at = new Int32Array(to)
  const weights: number[] = []
  for (let index = 0; index < to; index++) {
    const start = index * ratio, end = Math.min(from, (index + 1) * ratio)
    const low = Math.floor(start), high = Math.min(from, Math.ceil(end))
    first[index] = low; count[index] = high - low; at[index] = weights.length
    for (let pixel = low; pixel < high; pixel++) weights.push((Math.min(end, pixel + 1) - Math.max(start, pixel)) / ratio)
  }
  return { first, count, at, weights: Float32Array.from(weights) }
}

/**
 * `picture` scaled down to `width` by `height` by averaging each box of its pixels, across and then down. Where anything
 * shows through, each pixel's colour counts by how opaque it is, so a see-through pixel's hidden colour never bleeds
 * into its neighbours.
 */
export function scaledDown(picture: Pixels, width: number, height: number): Pixels {
  const { data } = picture, weighted = seeThrough(picture)
  const across = boxes(picture.width, width), down = boxes(picture.height, height)
  // Across first: every row of the picture, `width` pixels long, as sums.
  const rows = new Float32Array(width * picture.height * 4)
  for (let y = 0; y < picture.height; y++) {
    const source = y * picture.width * 4, target = y * width * 4
    for (let x = 0; x < width; x++) {
      let red = 0, green = 0, blue = 0, alpha = 0
      for (let step = 0, pixel = across.first[x]!, weight = across.at[x]!; step < across.count[x]!; step++, pixel++, weight++) {
        const share = across.weights[weight]!, from = source + pixel * 4
        const opacity = weighted ? data[from + 3]! / 255 : 1
        red += data[from]! * share * opacity; green += data[from + 1]! * share * opacity; blue += data[from + 2]! * share * opacity
        alpha += data[from + 3]! * share
      }
      const to = target + x * 4
      rows[to] = red; rows[to + 1] = green; rows[to + 2] = blue; rows[to + 3] = alpha
    }
  }
  // Then down, each column of those rows into `height` pixels, clamped so a sum a hair over 255 stays 255.
  const copy = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const target = y * width * 4
    for (let x = 0; x < width; x++) {
      let red = 0, green = 0, blue = 0, alpha = 0
      for (let step = 0, row = down.first[y]!, weight = down.at[y]!; step < down.count[y]!; step++, row++, weight++) {
        const share = down.weights[weight]!, from = (row * width + x) * 4
        red += rows[from]! * share; green += rows[from + 1]! * share; blue += rows[from + 2]! * share; alpha += rows[from + 3]! * share
      }
      const to = target + x * 4
      // Colours summed by opacity are divided by it again; a pixel nothing shows in is left black and clear.
      const opacity = weighted ? alpha / 255 : 1
      copy[to] = opacity > 0 ? Math.round(red / opacity) : 0
      copy[to + 1] = opacity > 0 ? Math.round(green / opacity) : 0
      copy[to + 2] = opacity > 0 ? Math.round(blue / opacity) : 0
      copy[to + 3] = Math.round(alpha)
    }
  }
  return { width, height, data: Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength) }
}
