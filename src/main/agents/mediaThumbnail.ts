import type { NativeImage } from 'electron'

/** A tile is 208x140; its thumbnail is made at twice that, for a high-density screen (ADR-0170). */
export const MEDIA_TILE_PIXELS = { width: 416, height: 280 } as const

/**
 * Makes a picture's tile thumbnail on the desktop (ADR-0170): the whole picture in, scaled down to fit the tile at twice its
 * size, as a JPEG data URL. A picture already that small is handed back as it is. Null when Electron cannot read it.
 */
export function mediaThumbnailMaker(fromDataUrl: (dataUrl: string) => NativeImage): (dataUrl: string) => string | null {
  return dataUrl => {
    const image = fromDataUrl(dataUrl)
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    const scale = Math.min(1, MEDIA_TILE_PIXELS.width / width, MEDIA_TILE_PIXELS.height / height)
    if (scale >= 1) return dataUrl
    const tile = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
    return `data:image/jpeg;base64,${tile.toJPEG(85).toString('base64')}`
  }
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
