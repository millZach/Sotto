import type { NativeImage } from 'electron'

/** A tile is 208x140 in the window's own units (ADR-0170). */
export const MEDIA_TILE_SIZE = { width: 208, height: 140 } as const
/** The scale a thumbnail is made at when the window names none: twice the tile, for a high-density screen. */
export const MEDIA_TILE_DEFAULT_SCALE = 2

/**
 * Makes a picture's tile thumbnail on the desktop (ADR-0170): the whole picture in, scaled down to fit the tile at the
 * window's scale, as a JPEG data URL. A 1x screen gets 208x140 at most and a 2x screen 416x280: a pixel more than the
 * screen shows is memory the window holds for nothing. A picture already that small is handed back as it is. Null when
 * Electron cannot read it.
 */
export function mediaThumbnailMaker(fromDataUrl: (dataUrl: string) => NativeImage): (dataUrl: string, scale?: number) => string | null {
  return (dataUrl, tileScale = MEDIA_TILE_DEFAULT_SCALE) =>
    fitted(fromDataUrl(dataUrl), dataUrl, Math.ceil(MEDIA_TILE_SIZE.width * tileScale), Math.ceil(MEDIA_TILE_SIZE.height * tileScale), asJpeg)
}

/**
 * Makes the copy of a picture a phone asked for at a longest edge (`thread-media-edge`, ADR-0170's November 10
 * amendment), with the tile thumbnail's own scaling, to fit `edge` by `edge`. The phone's tile shows what it showed
 * before: a picture with any pixel that is not opaque stays a PNG, since a JPEG has none and Electron turns them black,
 * and a JPEG carrying camera details is handed back whole, since those can say to turn it, which Electron does not do
 * and the phone does. A picture already that small is handed back as it is. Null when Electron cannot read it, as a GIF
 * or a WebP.
 */
export function mediaEdgeMaker(fromDataUrl: (dataUrl: string) => NativeImage): (dataUrl: string, edge: number) => string | null {
  return (dataUrl, edge) => carriesCameraDetails(dataUrl) ? dataUrl
    : fitted(fromDataUrl(dataUrl), dataUrl, edge, edge, scaled => seeThrough(scaled) ? `data:image/png;base64,${scaled.toPNG().toString('base64')}` : asJpeg(scaled))
}

/** `image` scaled down to fit `width` by `height` and written by `write`, `dataUrl` when it already fits, or null when empty. */
function fitted(image: NativeImage, dataUrl: string, width: number, height: number, write: (scaled: NativeImage) => string): string | null {
  if (image.isEmpty()) return null
  const size = image.getSize()
  const scale = Math.min(1, width / size.width, height / size.height)
  if (scale >= 1) return dataUrl
  return write(image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }))
}

const asJpeg = (scaled: NativeImage): string => `data:image/jpeg;base64,${scaled.toJPEG(85).toString('base64')}`

/** Whether any pixel of `image` is less than opaque. Its bitmap is four bytes a pixel, the fourth alpha on every platform. */
function seeThrough(image: NativeImage): boolean {
  const bitmap = image.toBitmap()
  for (let index = 3; index < bitmap.length; index += 4) if (bitmap[index] !== 255) return true
  return false
}

const JPEG_URL = 'data:image/jpeg;base64,'
const EXIF = Buffer.from('Exif\0\0', 'latin1')
/**
 * Whether a JPEG data URL carries an Exif segment before its picture starts: read from its first 64 KiB, never all of it.
 * A headless host's maker (`src/host/pictureMaker.ts`, ADR-0203) hands such a picture back whole by the same rule, since
 * its decoder does not turn a picture either.
 */
export function carriesCameraDetails(dataUrl: string): boolean {
  if (!dataUrl.startsWith(JPEG_URL)) return false
  const head = Buffer.from(dataUrl.slice(JPEG_URL.length, JPEG_URL.length + 87_384), 'base64')
  for (let at = 2; at + 4 <= head.length && head[at] === 0xff;) {
    const marker = head[at + 1]
    // The scan's start, or the end of the image: no segment after it is a header.
    if (marker === 0xda || marker === 0xd9) return false
    if (marker === 0xe1 && head.subarray(at + 4, at + 10).equals(EXIF)) return true
    at += 2 + head.readUInt16BE(at + 2)
  }
  return false
}

/**
 * How much of main's memory the thumbnails it has made may hold (ADR-0170): 32 MiB of data URLs, about 880 of today's
 * 37 KB tiles, enough that a thread of several hundred pictures is decoded once. A budget in bytes rather than a count,
 * so larger thumbnails mean fewer kept and main's memory stays bounded however long the thread or the session.
 */
export const MEDIA_TILE_KEEP_BYTES = 32 * 1024 * 1024

/**
 * The thumbnails main has made, kept by the picture they show until they come to `budget` bytes, when the one read
 * longest ago goes first. A thumbnail is a base64 data URL, so its length is its size in bytes.
 */
export class KeptThumbnails {
  private readonly kept = new Map<string, string>()
  private held = 0
  constructor(private readonly budget = MEDIA_TILE_KEEP_BYTES) {}
  /** The thumbnail kept under `key`, which then counts as read most recently. */
  get(key: string): string | undefined {
    const tile = this.kept.get(key)
    if (tile !== undefined) { this.kept.delete(key); this.kept.set(key, tile) }
    return tile
  }
  set(key: string, tile: string): void {
    const before = this.kept.get(key)
    if (before !== undefined) { this.kept.delete(key); this.held -= before.length }
    // One thumbnail larger than the whole budget is handed back but never kept.
    if (tile.length > this.budget) return
    this.kept.set(key, tile)
    this.held += tile.length
    for (const [oldest, gone] of this.kept) {
      if (this.held <= this.budget) break
      this.kept.delete(oldest)
      this.held -= gone.length
    }
  }
  /** The bytes kept now, never more than the budget. */
  get bytes(): number { return this.held }
}

/** What a phone asked for at a longest edge is answered with: the picture as a data URL, or null when none is kept. */
type PictureRead = { readonly dataUrl: string } | null

/**
 * The copies of pictures phones asked for at a longest edge (`thread-media-edge`, ADR-0170's November 10 amendment),
 * made by `reduce` and kept in `kept`, which the desktop shares with its window's thumbnails, so both stay inside one
 * budget in bytes. A GIF is answered whole, so it keeps its frames for the phone to play; so is a picture `reduce`
 * cannot read, or whose copy comes out no smaller. None of those is kept, as no whole picture is. `reduce` is the process
 * owner's: Electron's image tools on the desktop, the picture worker on a headless host (ADR-0203). A picture and edge
 * asked for again while its copy is being made waits for that one, so it is read and made once.
 */
export class ReducedPictures {
  /** The copies being made now, by the name they will be kept under. */
  private readonly making = new Map<string, Promise<PictureRead>>()
  constructor(private readonly reduce: (dataUrl: string, edge: number) => string | null | Promise<string | null>, private readonly kept = new KeptThumbnails()) {}
  /** The picture `key` names at no more than `edge` on its longest side, read whole by `whole` only when none is kept. */
  read(key: readonly string[], edge: number, whole: () => Promise<PictureRead>): Promise<PictureRead> {
    const name = JSON.stringify(['edge', ...key, edge])
    const kept = this.kept.get(name)
    if (kept !== undefined) return Promise.resolve({ dataUrl: kept })
    const making = this.making.get(name)
    if (making) return making
    const made = this.make(name, edge, whole).finally(() => { this.making.delete(name) })
    this.making.set(name, made)
    return made
  }
  private async make(name: string, edge: number, whole: () => Promise<PictureRead>): Promise<PictureRead> {
    const picture = await whole()
    if (!picture || picture.dataUrl.startsWith('data:image/gif;')) return picture
    const reduced = await this.reduce(picture.dataUrl, edge)
    if (reduced === null || reduced.length >= picture.dataUrl.length) return picture
    this.kept.set(name, reduced)
    return { dataUrl: reduced }
  }
}
