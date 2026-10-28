import type { ThemeRgb } from '../../../shared/themes/color'

/**
 * A colour as the canvas paints it, whatever form the style gave it in: a hex value, `rgb()`, a named colour or a
 * `color-mix()`. Painted on one pixel of `pixel` and read back, so null means it paints nothing (transparent or unreadable).
 * Watcher's night scene reads its inks with it, and night falls' Stars look reads the theme's.
 */
export function toRgb(value: string, pixel: CanvasRenderingContext2D): ThemeRgb | null {
  pixel.clearRect(0, 0, 1, 1)
  pixel.fillStyle = 'rgba(0, 0, 0, 0)'
  pixel.fillStyle = value
  pixel.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 0] = pixel.getImageData(0, 0, 1, 1).data
  return a === 0 ? null : { r, g, b }
}
