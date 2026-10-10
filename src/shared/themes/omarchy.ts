import { z } from 'zod'
import {
  contrastRatio, mixRgb, parseThemeColor, parseThemeRgb, rgbToThemeColor,
  isCanonicalThemeColor, type ThemeRgb,
} from './color'
import {
  THEME_COLOR_ROLES, SOTTO_DARK_THEME_COLORS, SOTTO_LIGHT_THEME_COLORS,
  type ThemeColors, type ThemeColorRole, type ThemeDefinition, type ThemeAppearance,
} from './palettes'

/** Outside the custom-theme ID grammar, so an older library can never own it. */
export const OMARCHY_THEME_ID = '__omarchy'
export interface OmarchyTheme extends ThemeDefinition { readonly sourceName: string }

const colorsSchema = (color: z.ZodType<string>) => z.object(Object.fromEntries(
  THEME_COLOR_ROLES.map(role => [role, color]),
) as Record<ThemeColorRole, z.ZodType<string>>).strict()

/** Only fully rendered, opaque template colours are admitted. No imports or partial palettes. */
export const omarchyFileSchema = z.object({
  version: z.literal(1), id: z.literal('omarchy'), name: z.literal('Omarchy'),
  appearance: z.enum(['light', 'dark']), colors: colorsSchema(z.string().regex(/^#[\da-f]{6}$/iu)),
}).strict()

/** Main's read-only projection; it never enters the saved custom library. */
export const omarchyThemeSchema: z.ZodType<OmarchyTheme> = z.object({
  id: z.literal(OMARCHY_THEME_ID), label: z.literal('Omarchy'), appearance: z.enum(['light', 'dark']),
  sourceName: z.string().trim().min(1).max(80), colors: colorsSchema(z.string().refine(isCanonicalThemeColor)),
}).strict()

const rgb = (color: string): ThemeRgb => parseThemeRgb(color, { r: 0, g: 0, b: 0 })
const mix = (from: string, to: string, percent: number): string => rgbToThemeColor(mixRgb(rgb(from), rgb(to), percent / 100))
const ratio = (foreground: string, background: string): number => contrastRatio(rgb(foreground), rgb(background))

/** Smallest whole percent, measured after canonical conversion and sRGB quantisation. */
export function readableOmarchyMix(from: string, to: string, score: (color: string) => number, minimum = 4.5): number | null {
  for (let percent = 0; percent <= 100; percent += 1) {
    if (score(mix(from, to, percent)) >= minimum) return percent
  }
  return null
}

export interface OmarchyTextPair { readonly foreground: ThemeColorRole; readonly surfaces: readonly ThemeColorRole[] }
const room = ['canvas', 'surface', 'surfaceRaised', 'surfaceOverlay', 'accentSurface', 'sidebarRowSelected'] as const
const sidebar = ['sidebar', 'sidebarRowSelected', 'sidebarRowHover', 'sidebarControlSurface'] as const
/** Every text role, on the surfaces used by the main window and widget. */
export const OMARCHY_TEXT_PAIRS: readonly OmarchyTextPair[] = [
  { foreground: 'text', surfaces: [...room, ...sidebar] },
  { foreground: 'toolbarForeground', surfaces: ['toolbar'] },
  { foreground: 'toolbarControlForeground', surfaces: ['toolbarControl', 'toolbarControlHover'] },
  { foreground: 'sidebarForeground', surfaces: sidebar },
  { foreground: 'messageForeground', surfaces: ['messageSurface'] },
  { foreground: 'textMuted', surfaces: room },
  { foreground: 'mutedForeground', surfaces: [...room, ...sidebar] },
  { foreground: 'sidebarMutedForeground', surfaces: sidebar },
  { foreground: 'placeholder', surfaces: room },
  { foreground: 'secondaryLabel', surfaces: room },
  { foreground: 'iconMuted', surfaces: room },
  { foreground: 'secondaryForeground', surfaces: ['secondary'] },
  { foreground: 'accentSurfaceForeground', surfaces: ['accentSurface'] },
  { foreground: 'codeForeground', surfaces: ['codeBackground'] },
  { foreground: 'terminalForeground', surfaces: ['terminalBackground', 'terminalSelection'] },
  { foreground: 'updateForeground', surfaces: [...room, ...sidebar, 'updateSurface'] },
  { foreground: 'errorForeground', surfaces: [...room, ...sidebar, 'errorSurface'] },
  { foreground: 'warningForeground', surfaces: [...room, ...sidebar, 'warningSurface'] },
]

function meansStatus(kind: 'error' | 'warning', color: string): boolean {
  const { C, h: rawHue } = parseThemeColor(color)!.color
  const hue = (rawHue + 360) % 360
  return C >= 0.07 && (kind === 'error' ? hue <= 45 || hue >= 345 : hue >= 45 && hue <= 105)
}

/** M3's readability check. An impossible palette is refused, so it cannot paint a broken theme. */
export function guardOmarchyColors(input: ThemeColors, mode: ThemeAppearance): ThemeColors {
  const colors = { ...input }
  const own = mode === 'dark' ? SOTTO_DARK_THEME_COLORS : SOTTO_LIGHT_THEME_COLORS
  for (const kind of ['error', 'warning'] as const) {
    const score = (color: string): number => Math.min(...['canvas', 'surface', 'sidebar'].map(surface => ratio(color, colors[surface as ThemeColorRole])))
    const needed = readableOmarchyMix(colors[kind], colors.text, score)
    if (!meansStatus(kind, colors[kind]) || needed === null || needed > 35) {
      colors[kind] = own[kind]
      colors[`${kind}Foreground`] = own[`${kind}Foreground`]
      colors[`${kind}Surface`] = mix(colors.canvas, own[kind], 12)
    }
  }
  const extreme = mode === 'dark' ? '#ffffff' : '#000000'
  const repair = (role: ThemeColorRole, score: (color: string) => number, minimum = 4.5): void => {
    if (score(colors[role]) >= minimum) return
    const target = role === 'text' ? extreme : colors.text
    const needed = readableOmarchyMix(colors[role], target, score, minimum)
    if (needed === null) throw new Error('Omarchy theme cannot be made readable')
    colors[role] = mix(colors[role], target, needed)
  }
  const body = OMARCHY_TEXT_PAIRS[0]!
  repair(body.foreground, color => Math.min(...body.surfaces.map(surface => ratio(color, colors[surface]))))
  // Body text settles first; the button fill then moves, keeping its original ink (M3).
  repair('accent', color => Math.min(ratio(colors.accentForeground, color), ratio(colors.messageActionForeground, color)))
  colors.messageAction = colors.accent
  colors.update = colors.accent
  colors.messageActionHover = mix(colors.accent, colors.text, 15)
  for (const pair of OMARCHY_TEXT_PAIRS.slice(1)) {
    repair(pair.foreground, color => Math.min(...pair.surfaces.map(surface => ratio(color, colors[surface]))))
  }
  repair('focus', color => Math.min(...['canvas', 'surface'].map(surface => ratio(color, colors[surface as ThemeColorRole]))), 3)
  // Verify the final roles as well: repairing the text can change subsequent targets.
  for (const pair of OMARCHY_TEXT_PAIRS) {
    if (pair.surfaces.some(surface => ratio(colors[pair.foreground], colors[surface]) < 4.5)) throw new Error('Omarchy theme cannot be made readable')
  }
  return Object.fromEntries(THEME_COLOR_ROLES.map(role => [role, rgbToThemeColor(rgb(colors[role]))])) as Record<ThemeColorRole, string>
}

export function parseOmarchyTheme(input: unknown, sourceName = 'Current Omarchy theme'): OmarchyTheme {
  const file = omarchyFileSchema.parse(input)
  return omarchyThemeSchema.parse({
    id: OMARCHY_THEME_ID, label: 'Omarchy', sourceName, appearance: file.appearance,
    colors: guardOmarchyColors(file.colors, file.appearance),
  })
}
