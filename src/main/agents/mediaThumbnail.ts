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
