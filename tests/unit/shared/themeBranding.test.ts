// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { widgetSnapshotSchema } from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import {
  APP_ICON_BRAND,
  DEFAULT_WIDGET_PALETTE,
  MARK_GLYPH_CONTRAST,
  WIDGET_THEME_ROLES,
  themeBrand,
  widgetPaletteFor,
  widgetPaletteSchema,
  widgetPresentationFor,
} from '../../../src/shared/themeBranding'
import { contrastRatio, parseThemeRgb, rgbToOklch } from '../../../src/shared/themes/color'
import { createVividThemeColors } from '../../../src/shared/themes/engine'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, getThemeColorsForMode, parseThemeFile, type ThemeDefinition } from '../../../src/shared/themes/library'

const BLACK = { r: 0, g: 0, b: 0 }

function hueOf(hex: string): number {
  return rgbToOklch(parseThemeRgb(hex, BLACK)).h
}

function hueDistance(a: number, b: number): number {
  const distance = Math.abs(((a - b) % 360) + 360) % 360
  return Math.min(distance, 360 - distance)
}

function aurora(): ThemeDefinition {
  return parseThemeFile({ version: 1, id: 'aurora', name: 'Aurora', appearance: 'dark', colors: createVividThemeColors('dark', '#101820', '#e0a040') })
}

describe('widget palette projection', () => {
  it('carries only the painted roles of the theme that owns each half, built-in or custom', () => {
    const custom = aurora()
    const palette = widgetPaletteFor({ lightTheme: 'citrine', darkTheme: custom.id, customThemes: [custom] })
    const citrine = BUILT_IN_THEMES.find(theme => theme.id === 'citrine')!

    expect(Object.keys(palette).sort()).toEqual(['appIcon', 'dark', 'light'])
    expect(Object.keys(palette.light)).toEqual([...WIDGET_THEME_ROLES])
    for (const role of WIDGET_THEME_ROLES) {
      expect(palette.light[role]).toBe(getThemeColorsForMode(citrine, 'light')![role])
      expect(palette.dark[role]).toBe(custom.colors[role])
    }
    // No ids, labels or library ride along to the widget renderer.
    const serialized = JSON.stringify(palette)
    expect(serialized).not.toContain('citrine')
    expect(serialized).not.toContain('Aurora')
    expect(widgetPaletteSchema.parse(palette)).toEqual(palette)
  })

  it('says per half whether the default theme paints it, so the widget knows when to wear the app icon', () => {
    const custom = aurora()
    expect(DEFAULT_WIDGET_PALETTE.appIcon).toEqual({ light: true, dark: true })
    expect(widgetPaletteFor({ lightTheme: DEFAULT_THEME_ID, darkTheme: custom.id, customThemes: [custom] }).appIcon)
      .toEqual({ light: true, dark: false })
    expect(widgetPaletteFor({ lightTheme: 'hush', darkTheme: 'nocturne', customThemes: [] }).appIcon)
      .toEqual({ light: false, dark: false })
    // A half whose theme is gone lands on the default, so the app icon comes back with it.
    expect(widgetPaletteFor({ lightTheme: 'deleted-theme', darkTheme: 'hush', customThemes: [] }).appIcon)
      .toEqual({ light: true, dark: false })
  })

  it('lands a half on the default theme when its theme is gone, exactly as the main window does', () => {
    expect(widgetPaletteFor({ lightTheme: 'deleted-theme', darkTheme: DEFAULT_THEME_ID, customThemes: [] })).toEqual(DEFAULT_WIDGET_PALETTE)
  })

  it('projects presentation from settings without leaking unrelated fields', () => {
    const settings: AppSettings = { ...DEFAULT_SETTINGS, theme: 'light', reducedMotion: 'on', lightTheme: 'tropic', llmApiKey: 'secret' }
    const presentation = widgetPresentationFor(settings)
    expect(Object.keys(presentation).sort()).toEqual(['palette', 'reducedMotion', 'theme', 'voiceCoordinator'])
    expect(presentation.theme).toBe('light')
    expect(presentation.reducedMotion).toBe('on')
    expect(JSON.stringify(presentation)).not.toContain('secret')
  })

  it('tells the widget whether the voice coordinator is shown, since the widget cannot read settings', () => {
    expect(widgetPresentationFor({ ...DEFAULT_SETTINGS }).voiceCoordinator).toBe(false)
    expect(widgetPresentationFor({ ...DEFAULT_SETTINGS, voiceCoordinatorEnabled: true }).voiceCoordinator).toBe(true)
  })

  it('rejects palettes with extra roles, missing halves or app icon flags, or colours that are not canonical literals', () => {
    const light = DEFAULT_WIDGET_PALETTE.light
    expect(() => widgetPaletteSchema.parse({ light })).toThrow()
    expect(() => widgetPaletteSchema.parse({ light, dark: DEFAULT_WIDGET_PALETTE.dark })).toThrow()
    expect(() => widgetPaletteSchema.parse({ ...DEFAULT_WIDGET_PALETTE, appIcon: { light: true } })).toThrow()
    expect(() => widgetPaletteSchema.parse({ ...DEFAULT_WIDGET_PALETTE, appIcon: { light: 'yes', dark: false } })).toThrow()
    expect(() => widgetPaletteSchema.parse({ ...DEFAULT_WIDGET_PALETTE, extra: light })).toThrow()
    expect(() => widgetPaletteSchema.parse({ ...DEFAULT_WIDGET_PALETTE, light: { ...light, sidebar: light.canvas } })).toThrow()
    expect(() => widgetPaletteSchema.parse({ ...DEFAULT_WIDGET_PALETTE, light: { ...light, accent: 'var(--x)' } })).toThrow()
    expect(() => widgetPaletteSchema.parse({ ...DEFAULT_WIDGET_PALETTE, light: { ...light, accent: '#ff0000' } })).toThrow()
    expect(() => widgetPaletteSchema.parse({ ...DEFAULT_WIDGET_PALETTE, dark: { ...light, text: 'oklch(0.5 0.1 20); background: url(x)' } })).toThrow()
  })

  it('requires the palette on every widget snapshot', () => {
    const idle = { status: 'idle', theme: 'system', palette: DEFAULT_WIDGET_PALETTE, reducedMotion: 'system', shortcut: 'Primary', cancellable: false }
    expect(widgetSnapshotSchema.parse(idle)).toEqual(idle)
    const withoutPalette: Partial<typeof idle> = { ...idle }
    delete withoutPalette.palette
    expect(() => widgetSnapshotSchema.parse(withoutPalette)).toThrow()
    // The widget only hides its voice controls if the flag survives the boundary.
    expect(widgetSnapshotSchema.parse({ ...idle, voiceCoordinator: true })).toMatchObject({ voiceCoordinator: true })
  })
})

describe('theme brand', () => {
  it.each(BUILT_IN_THEMES.flatMap(theme => (['light', 'dark'] as const).map(mode => [theme.label, mode, theme] as const)))(
    '%s %s: the tile is the accent and the glyph reads on it',
    (_label, mode, theme) => {
      const colors = getThemeColorsForMode(theme, mode)!
      const brand = themeBrand(colors, mode)
      const tile = parseThemeRgb(brand.tile, BLACK)
      expect(contrastRatio(tile, parseThemeRgb(brand.glyph, BLACK))).toBeGreaterThanOrEqual(MARK_GLYPH_CONTRAST)
      const accent = rgbToOklch(parseThemeRgb(colors.accent, BLACK))
      expect(hueDistance(hueOf(brand.tile), accent.h)).toBeLessThan(2)
      // The orb keeps the accent's hue in both colours.
      if (accent.C > 0.05) {
        expect(hueDistance(hueOf(brand.orb[0]), accent.h)).toBeLessThan(12)
        expect(hueDistance(hueOf(brand.orb[1]), accent.h)).toBeLessThan(12)
      }
    },
  )

  it('wears the app icon’s own tile and glyph when the half asks for it, whatever the accent', () => {
    for (const accent of ['oklch(0.7 0.18 30)', 'oklch(0.55 0.2 300)', 'oklch(0.6 0 0)']) {
      const brand = themeBrand({ canvas: 'oklch(0.2 0 0)', accent, accentForeground: 'oklch(0.99 0 0)' }, 'dark', { appIcon: true })
      expect(brand.tile, accent).toBe(APP_ICON_BRAND.tile)
      expect(brand.glyph, accent).toBe(APP_ICON_BRAND.glyph)
    }
    // The orb follows the tile, so the icon's teal reaches it too.
    const sotto = getThemeColorsForMode(BUILT_IN_THEMES.find(theme => theme.id === DEFAULT_THEME_ID)!, 'dark')!
    expect(themeBrand(sotto, 'dark', { appIcon: true }).orb).toEqual(themeBrand({ ...sotto, accent: APP_ICON_BRAND.tile }, 'dark').orb)
  })

  it('distinguishes contrasting themes', () => {
    const nocturne = themeBrand(getThemeColorsForMode(BUILT_IN_THEMES.find(theme => theme.id === 'nocturne')!, 'dark')!, 'dark')
    const tropic = themeBrand(getThemeColorsForMode(BUILT_IN_THEMES.find(theme => theme.id === 'tropic')!, 'dark')!, 'dark')
    expect(nocturne.tile).not.toBe(tropic.tile)
    expect(nocturne.orb).not.toEqual(tropic.orb)
  })

  it('runs a pale tint into a deep tone on dark, and ink into a softer tone on light', () => {
    const colors = getThemeColorsForMode(BUILT_IN_THEMES.find(theme => theme.id === 'citrine')!, 'dark')!
    const dark = themeBrand(colors, 'dark').orb.map(hex => rgbToOklch(parseThemeRgb(hex, BLACK)).L)
    const light = themeBrand(colors, 'light').orb.map(hex => rgbToOklch(parseThemeRgb(hex, BLACK)).L)
    expect(dark[0]!).toBeGreaterThan(dark[1]!)
    expect(light[0]!).toBeLessThan(light[1]!)
  })

  it('replaces an unreadable accent foreground rather than painting an invisible glyph', () => {
    const brand = themeBrand({ canvas: 'oklch(0.2 0 0)', accent: 'oklch(0.7 0.15 150)', accentForeground: 'oklch(0.68 0.15 150)' }, 'dark')
    expect(contrastRatio(parseThemeRgb(brand.tile, BLACK), parseThemeRgb(brand.glyph, BLACK))).toBeGreaterThanOrEqual(MARK_GLYPH_CONTRAST)
  })

  it('falls back to the default theme for unreadable roles and keeps a grey accent grey', () => {
    expect(themeBrand({ canvas: '', accent: '', accentForeground: '' }, 'dark').tile)
      .toBe(themeBrand(DEFAULT_WIDGET_PALETTE.dark, 'dark').tile)
    const grey = themeBrand({ canvas: 'oklch(0.2 0 0)', accent: 'oklch(0.6 0 0)', accentForeground: 'oklch(1 0 0)' }, 'dark')
    for (const hex of grey.orb) expect(rgbToOklch(parseThemeRgb(hex, BLACK)).C).toBeLessThan(0.01)
  })
})
