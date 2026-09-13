/*
 * Theme branding: the Sotto mark, the agent orb and the floating widget take
 * their colours from the selected theme's canonical roles, so a theme change
 * repaints the brand in both windows. Nothing here holds a palette of its own;
 * every colour is read from, or solved against, a theme role.
 */

import { z } from 'zod'

import {
  contrastRatio,
  isCanonicalThemeColor,
  mapOklchToSrgbGamut,
  mixRgb,
  oklchToRgb,
  parseThemeColor,
  readableForeground,
  rgbToHex,
  rgbToOklch,
  type ThemeOklch,
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

/** Both halves, so a widget following the system scheme can switch without a new snapshot. */
export interface WidgetPalette {
  readonly light: WidgetThemeColors
  readonly dark: WidgetThemeColors
}

const widgetThemeColorsSchema = z.object(
  Object.fromEntries(WIDGET_THEME_ROLES.map(role => [role, z.string().max(64).refine(isCanonicalThemeColor)])) as unknown as Record<WidgetThemeRole, z.ZodType<string>>,
).strict()

export const widgetPaletteSchema: z.ZodType<WidgetPalette> = z.object({
  light: widgetThemeColorsSchema,
  dark: widgetThemeColorsSchema,
}).strict()

function pickWidgetRoles(colors: ThemeColors): WidgetThemeColors {
  return Object.fromEntries(WIDGET_THEME_ROLES.map(role => [role, colors[role]])) as Record<WidgetThemeRole, string>
}

/** The widget's projection of the themes that own each half, resolved exactly as the main window resolves them. */
export function widgetPaletteFor(selection: ThemeSelection): WidgetPalette {
  return {
    light: pickWidgetRoles(resolveThemeFor(selection, 'light').colors),
    dark: pickWidgetRoles(resolveThemeFor(selection, 'dark').colors),
  }
}

/** The default themes' projection, for previews and a widget that has no settings to read. */
export const DEFAULT_WIDGET_PALETTE: WidgetPalette = widgetPaletteFor({
  lightTheme: DEFAULT_THEME_ID,
  darkTheme: DEFAULT_THEME_ID,
  customThemes: [],
})

/** The brand as painted: hex, because the orb's canvas maths and SVG stops both take it directly. */
export interface ThemeBrand {
  /** The mark's rounded tile: the theme's accent. */
  readonly tile: string
  /** The mark's bar and wave, readable on the tile. */
  readonly glyph: string
  /** The orb's two colours as they should appear: top-left, then bottom-right. */
  readonly orb: readonly [string, string]
}

export type ThemeBrandRoles = Pick<ThemeColors, 'canvas' | 'accent' | 'accentForeground'>

/** The mark's glyph must read on its tile at least this well, as body text would. */
export const MARK_GLYPH_CONTRAST = 4.5

const hexOf = (color: ThemeOklch): string => rgbToHex(oklchToRgb(mapOklchToSrgbGamut(color)))

/** A role as an opaque colour: a translucent accent is seen over the canvas. */
function opaqueRole(value: string, under: ThemeRgb): ThemeRgb | null {
  const parsed = parseThemeColor(value)
  if (parsed === null) return null
  return mixRgb(under, oklchToRgb(parsed.color), parsed.alpha)
}

/**
 * Derive the brand from a theme's roles. The tile is the accent; the glyph is
 * the theme's own accent foreground when it reads on the tile, else the most
 * readable foreground. The orb keeps the accent's hue: on a dark room a pale
 * tint runs into a deep tone, as the original teal orb did; on a light room
 * the orb is drawn as ink, so it runs from a deep tone into a softer one.
 */
export function themeBrand(roles: ThemeBrandRoles, appearance: ThemeAppearance): ThemeBrand {
  const fallback = DEFAULT_WIDGET_PALETTE[appearance]
  const canvas = opaqueRole(roles.canvas, { r: 0, g: 0, b: 0 }) ?? opaqueRole(fallback.canvas, { r: 0, g: 0, b: 0 })!
  const tile = opaqueRole(roles.accent, canvas) ?? opaqueRole(fallback.accent, canvas)!
  const ownGlyph = opaqueRole(roles.accentForeground, tile)
  const glyph = ownGlyph !== null && contrastRatio(ownGlyph, tile) >= MARK_GLYPH_CONTRAST ? ownGlyph : readableForeground(tile)

  const accent = rgbToOklch(tile)
  // A near-grey accent has no meaningful hue; keep it grey rather than inventing one.
  const hue = Number.isFinite(accent.h) ? accent.h : 0
  const chroma = accent.C < 0.02 ? 0 : accent.C
  const orb: readonly [string, string] = appearance === 'dark'
    ? [
        hexOf({ L: 0.9, C: Math.min(chroma * 0.75, 0.13), h: hue }),
        hexOf({ L: Math.min(0.6, Math.max(0.45, accent.L - 0.12)), C: Math.min(chroma * 1.1, 0.2), h: hue }),
      ]
    : [
        hexOf({ L: 0.36, C: Math.min(chroma, 0.15), h: hue }),
        hexOf({ L: 0.7, C: Math.min(chroma * 0.8, 0.13), h: hue }),
      ]
  return { tile: rgbToHex(tile), glyph: rgbToHex(glyph), orb }
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
  return { theme: settings.theme, palette: widgetPaletteFor(settings), reducedMotion: settings.reducedMotion }
}
