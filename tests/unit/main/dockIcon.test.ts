// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  DOCK_COVERAGE_SIZE,
  dockAppearance,
  dockBrandFor,
  dockPainter,
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
    const coordinate = (value: number): number => 50 + Math.round(value * (DOCK_COVERAGE_SIZE - 100) / 96)
    // A corner outside the 22-unit radius, the tile below the owl and the owl's forehead.
    expect(pixel(png, 50, 50)[3]).toBe(0)
    expect(pixel(png, coordinate(48), coordinate(88))).toEqual([255, 0, 0, 255])
    expect(pixel(png, coordinate(48), coordinate(30))).toEqual([0, 0, 255, 255])
    // The eyes are holes in the owl that show the tile, with the owl's pupils inside them.
    expect(pixel(png, coordinate(26), coordinate(55))).toEqual([255, 0, 0, 255])
    expect(pixel(png, coordinate(36), coordinate(48.96))).toEqual([0, 0, 255, 255])
  })

  it('keeps a 50px transparent margin around the macOS tile and owl', () => {
    for (let y = 0; y < DOCK_COVERAGE_SIZE; y += 1) {
      for (let x = 0; x < DOCK_COVERAGE_SIZE; x += 1) {
        if (x >= 50 && x < 462 && y >= 50 && y < 462) continue
        const offset = (y * DOCK_COVERAGE_SIZE + x) * 2
        if (coverage![offset] !== 0 || coverage![offset + 1] !== 0) {
          throw new Error(`Dock artwork reaches the margin at ${x},${y}`)
        }
      }
    }
    const png = paintDockIcon(coverage!, { tile: '#ff0000', glyph: '#0000ff' })
    expect(pixel(png, 50, 256)).toEqual([255, 0, 0, 255])
    expect(pixel(png, 461, 256)).toEqual([255, 0, 0, 255])
    expect(pixel(png, 256, 50)).toEqual([255, 0, 0, 255])
    expect(pixel(png, 256, 461)).toEqual([255, 0, 0, 255])
  })

  it('gives the Dock back the bundle\'s icon when a repaint fails, and paints again on the next change', () => {
    const events: string[] = []
    let failing = false
    const paint = dockPainter(coverage!, {
      setIcon: () => {
        if (failing) throw new Error('setIcon failed')
        events.push('painted')
      },
      restoreBundleIcon: () => events.push('bundle icon'),
      log: code => events.push(code),
    })
    const [first, second] = BUILT_IN_THEMES.filter(theme => theme.id !== DEFAULT_THEME_ID)
    const themed = { ...DEFAULT_SETTINGS, appearance: 'dark' as const, darkTheme: first!.id }
    paint(themed, false)
    paint(themed, false)
    expect(events).toEqual(['painted'])
    failing = true
    paint({ ...themed, darkTheme: second!.id }, false)
    expect(events).toEqual(['painted', 'dock-icon-failed', 'bundle icon'])
    failing = false
    paint(themed, false)
    expect(events).toEqual(['painted', 'dock-icon-failed', 'bundle icon', 'painted'])
  })
})
