// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  DOCK_COVERAGE_SIZE,
  dockAppearance,
  dockBrandFor,
  paintDockIcon,
  readDockCoverage,
} from '../../../src/main/dock/dockIcon'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { APP_ICON_BRAND, themeBrand } from '../../../src/shared/themeBranding'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, resolveThemeFor } from '../../../src/shared/themes/library'

const COVERAGE_FILE = join(__dirname, '../../../resources/dock/mark-coverage.bin')

/** Pixel (x, y) of an unfiltered RGBA PNG, as paintDockIcon writes it. */
function pixel(png: Buffer, x: number, y: number): number[] {
  const idat = png.indexOf('IDAT', 0, 'latin1')
  const length = png.readUInt32BE(idat - 4)
  const rows = inflateSync(png.subarray(idat + 4, idat + 4 + length))
  const offset = y * (1 + DOCK_COVERAGE_SIZE * 4) + 1 + x * 4
  return [...rows.subarray(offset, offset + 4)]
}

describe('dock icon', () => {
  const coverage = readDockCoverage(readFileSync(COVERAGE_FILE))

  it('reads the generated coverage and refuses anything else', () => {
    expect(coverage).not.toBeNull()
    expect(readDockCoverage(Buffer.from('not deflate'))).toBeNull()
  })

  it('follows the chosen mode, and the system only when the setting does', () => {
    expect(dockAppearance({ appearance: 'light' }, true)).toBe('light')
    expect(dockAppearance({ appearance: 'dark' }, false)).toBe('dark')
    expect(dockAppearance({ appearance: 'system' }, true)).toBe('dark')
    expect(dockAppearance({ appearance: 'system' }, false)).toBe('light')
  })

  it('follows the main window\'s appearance, not the widget\'s theme', () => {
    const [light, dark] = BUILT_IN_THEMES.filter(theme => theme.id !== DEFAULT_THEME_ID)
    const settings = { ...DEFAULT_SETTINGS, theme: 'system' as const, appearance: 'dark' as const, lightTheme: light!.id, darkTheme: dark!.id }
    expect(dockBrandFor(settings, false)).toEqual(themeBrand(resolveThemeFor(settings, 'dark').colors, 'dark'))
    expect(dockBrandFor(settings, false)).not.toEqual(dockBrandFor({ ...settings, appearance: 'light' }, false))
  })

  it('wears the app icon on the default theme and the accent on any other', () => {
    expect(dockBrandFor({ ...DEFAULT_SETTINGS, appearance: 'dark', darkTheme: DEFAULT_THEME_ID }, false))
      .toEqual({ tile: APP_ICON_BRAND.tile, glyph: APP_ICON_BRAND.glyph })
    const other = BUILT_IN_THEMES.find(theme => theme.id !== DEFAULT_THEME_ID)!
    const settings = { ...DEFAULT_SETTINGS, appearance: 'dark' as const, darkTheme: other.id }
    const resolved = resolveThemeFor(settings, 'dark')
    expect(dockBrandFor(settings, false)).toEqual(themeBrand(resolved.colors, 'dark'))
  })

  it('paints the tile, the owl and the transparent corners in the brand', () => {
    const png = paintDockIcon(coverage!, { tile: '#ff0000', glyph: '#0000ff' })
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    const scale = DOCK_COVERAGE_SIZE / 96
    // A corner outside the 22-unit radius, the tile below the owl and the owl's forehead.
    expect(pixel(png, 0, 0)[3]).toBe(0)
    expect(pixel(png, Math.round(48 * scale), Math.round(88 * scale))).toEqual([255, 0, 0, 255])
    expect(pixel(png, Math.round(48 * scale), Math.round(30 * scale))).toEqual([0, 0, 255, 255])
    // The eyes are holes in the owl that show the tile, with the owl's pupils inside them.
    expect(pixel(png, Math.round(26 * scale), Math.round(55 * scale))).toEqual([255, 0, 0, 255])
    expect(pixel(png, Math.round(36 * scale), Math.round(48.96 * scale))).toEqual([0, 0, 255, 255])
  })
})
