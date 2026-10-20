/*
 * The macOS Dock icon wears the selected theme's mark, as SottoMark does in the
 * windows. Main cannot draw SVG, so scripts/generate-brand-assets.mjs renders
 * build/icon.svg's shapes once as coverage (resources/dock/mark-coverage.bin)
 * and this file only paints that coverage in the theme's tile and glyph.
 */

import { crc32, deflateSync, inflateSync } from 'node:zlib'

import { resolveThemeFor, type ThemeSelection } from '../../shared/themes/library'
import type { ThemeAppearance } from '../../shared/themes/palettes'
import { themeBrand, wearsAppIcon, type ThemeBrand } from '../../shared/themeBranding'

/** The coverage's side in pixels; the generator writes exactly this. */
export const DOCK_COVERAGE_SIZE = 512

export interface DockIconSettings extends ThemeSelection {
  /** The main window's mode, not the widget's `theme`. */
  readonly appearance: 'system' | 'light' | 'dark'
}

/** The half the main window paints: the chosen mode, or the system's when it follows the system. */
export function dockAppearance(settings: Pick<DockIconSettings, 'appearance'>, systemDark: boolean): ThemeAppearance {
  if (settings.appearance === 'light' || settings.appearance === 'dark') return settings.appearance
  return systemDark ? 'dark' : 'light'
}

/** The saved theme's mark for that half, derived as the main window derives its own. */
export function dockBrandFor(settings: DockIconSettings, systemDark: boolean): ThemeBrand {
  const appearance = dockAppearance(settings, systemDark)
  const { theme, colors } = resolveThemeFor(settings, appearance)
  return themeBrand(colors, appearance, { appIcon: wearsAppIcon(theme.id) })
}

/**
 * Unpack the generator's file: per pixel, the tile's coverage then the glyph's,
 * one byte each. Returns null for anything that is not that shape.
 */
export function readDockCoverage(file: Buffer): Buffer | null {
  try {
    const coverage = inflateSync(file)
    return coverage.length === DOCK_COVERAGE_SIZE * DOCK_COVERAGE_SIZE * 2 ? coverage : null
  } catch {
    return null
  }
}

function hexRgb(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1, 7), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(data, crc32(head.subarray(4))), 0)
  return Buffer.concat([head, data, crc])
}

/** The mark as a PNG: the tile's colour under its coverage, the glyph's over its own. */
export function paintDockIcon(coverage: Buffer, brand: ThemeBrand): Buffer {
  const size = DOCK_COVERAGE_SIZE
  const tile = hexRgb(brand.tile)
  const glyph = hexRgb(brand.glyph)
  const rowBytes = 1 + size * 4
  const pixels = Buffer.alloc(rowBytes * size)
  for (let y = 0; y < size; y += 1) {
    // Each row starts with PNG's "no filter" byte, already zero.
    for (let x = 0; x < size; x += 1) {
      const c = (y * size + x) * 2
      const t = coverage[c]!
      const g = Math.min(coverage[c + 1]!, t) / 255
      const p = y * rowBytes + 1 + x * 4
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[p + channel] = Math.round(tile[channel]! * (1 - g) + glyph[channel]! * g)
      }
      pixels[p + 3] = t
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
