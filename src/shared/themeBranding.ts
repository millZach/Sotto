/*
 * Theme branding: the Sotto mark and the floating widget take
 * their colours from the selected theme's canonical roles, so a theme change
 * repaints the brand in both windows. Nothing here holds a palette of its own;
 * every colour is read from, or solved against, a theme role.
 */

import { z } from 'zod'

import {
  contrastRatio,
  isCanonicalThemeColor,
  mixRgb,
  oklchToRgb,
  parseThemeColor,
  parseThemeRgb,
  readableForeground,
  rgbToHex,
  type ThemeRgb,
} from './themes/color'
import { DEFAULT_THEME_ID, resolveThemeFor, type ThemeSelection } from './themes/library'
import type { ThemeAppearance, ThemeColorRole, ThemeColors } from './themes/palettes'

/**
 * The roles the widget paints from. Only the two halves' colours cross to the
 * widget renderer: no theme ids, labels, custom library or other settings.
 */
export const WIDGET_THEME_ROLES = [
  'canvas',
  'surface',
  'surfaceRaised',
  'text',
  'mutedForeground',
  'accent',
  'accentForeground',
  'updateForeground',
  'errorForeground',
] as const satisfies readonly ThemeColorRole[]

export type WidgetThemeRole = (typeof WIDGET_THEME_ROLES)[number]
export type WidgetThemeColors = Readonly<Record<WidgetThemeRole, string>>

/**
 * Both halves, so a widget following the system scheme can switch without a new snapshot. `appIcon` says, per
 * half, whether the default theme paints it, in which case the mark wears the app icon's own colours.
 */
export interface WidgetPalette {
  readonly light: WidgetThemeColors
  readonly dark: WidgetThemeColors
  readonly appIcon: Readonly<Record<ThemeAppearance, boolean>>
}

const widgetThemeColorsSchema = z.object(
  Object.fromEntries(WIDGET_THEME_ROLES.map(role => [role, z.string().max(64).refine(isCanonicalThemeColor)])) as unknown as Record<WidgetThemeRole, z.ZodType<string>>,
).strict()

export const widgetPaletteSchema: z.ZodType<WidgetPalette> = z.object({
  light: widgetThemeColorsSchema,
  dark: widgetThemeColorsSchema,
  appIcon: z.object({ light: z.boolean(), dark: z.boolean() }).strict(),
}).strict()

function pickWidgetRoles(colors: ThemeColors): WidgetThemeColors {
  return Object.fromEntries(WIDGET_THEME_ROLES.map(role => [role, colors[role]])) as Record<WidgetThemeRole, string>
}

/** The widget's projection of the themes that own each half, resolved exactly as the main window resolves them. */
export function widgetPaletteFor(selection: ThemeSelection): WidgetPalette {
  const light = resolveThemeFor(selection, 'light')
  const dark = resolveThemeFor(selection, 'dark')
  return {
    light: pickWidgetRoles(light.colors),
    dark: pickWidgetRoles(dark.colors),
    appIcon: { light: wearsAppIcon(light.theme.id), dark: wearsAppIcon(dark.theme.id) },
  }
}

/** The default themes' projection, for previews and a widget that has no settings to read. */
export const DEFAULT_WIDGET_PALETTE: WidgetPalette = widgetPaletteFor({
  lightTheme: DEFAULT_THEME_ID,
  darkTheme: DEFAULT_THEME_ID,
  customThemes: [],
})

/** The brand as painted: hex for SVG paint. */
export interface ThemeBrand {
  /** The mark's rounded tile: the theme's accent. */
  readonly tile: string
  /** The mark's bar and wave, readable on the tile. */
  readonly glyph: string
}

export type ThemeBrandRoles = Pick<ThemeColors, 'canvas' | 'accent' | 'accentForeground'>

/**
 * The app icon's own colours (build/icon.svg). On the default theme the mark is the icon: this tile and glyph in
 * both halves, whatever the half's accent (ADR-0024).
 */
export const APP_ICON_BRAND = { tile: '#47b8a9', glyph: '#000000' } as const

/** The root attribute value that asks for the app icon's brand; both windows set `data-brand` to it on the default theme. */
export const APP_ICON_BRAND_ATTRIBUTE = 'app-icon'

/** Whether the theme painting a half wears the app icon's brand: only the default theme does. */
export function wearsAppIcon(themeId: string): boolean {
  return themeId === DEFAULT_THEME_ID
}

/** The mark's glyph must read on its tile at least this well, as body text would. */
export const MARK_GLYPH_CONTRAST = 4.5

/** A role as an opaque colour: a translucent accent is seen over the canvas. */
function opaqueRole(value: string, under: ThemeRgb): ThemeRgb | null {
  const parsed = parseThemeColor(value)
  if (parsed === null) return null
  return mixRgb(under, oklchToRgb(parsed.color), parsed.alpha)
}

/**
 * Derive the brand from a theme's roles. The tile is the accent, or the app
 * icon's teal when `appIcon` is set; the glyph is the icon's black then, and
 * otherwise the theme's own accent foreground when it reads on the tile, else
 * the most readable foreground.
 */
export function themeBrand(roles: ThemeBrandRoles, appearance: ThemeAppearance, options: { readonly appIcon?: boolean } = {}): ThemeBrand {
  const fallback = DEFAULT_WIDGET_PALETTE[appearance]
  const canvas = opaqueRole(roles.canvas, { r: 0, g: 0, b: 0 }) ?? opaqueRole(fallback.canvas, { r: 0, g: 0, b: 0 })!
  const tile = options.appIcon === true
    ? parseThemeRgb(APP_ICON_BRAND.tile, canvas)
    : opaqueRole(roles.accent, canvas) ?? opaqueRole(fallback.accent, canvas)!
  const ownGlyph = opaqueRole(roles.accentForeground, tile)
  const glyph = options.appIcon === true
    ? parseThemeRgb(APP_ICON_BRAND.glyph, tile)
    : ownGlyph !== null && contrastRatio(ownGlyph, tile) >= MARK_GLYPH_CONTRAST ? ownGlyph : readableForeground(tile)

  return { tile: rgbToHex(tile), glyph: rgbToHex(glyph) }
}

export interface WidgetPresentationSettings extends ThemeSelection {
  readonly theme: 'system' | 'light' | 'dark'
  readonly reducedMotion: 'system' | 'on'
}

/** Every presentation field a widget snapshot carries, from settings. */
export function widgetPresentationFor(settings: WidgetPresentationSettings): {
  readonly theme: WidgetPresentationSettings['theme']
  readonly palette: WidgetPalette
  readonly reducedMotion: WidgetPresentationSettings['reducedMotion']
} {
  return {
    theme: settings.theme,
    palette: widgetPaletteFor(settings),
    reducedMotion: settings.reducedMotion,
  }
}
