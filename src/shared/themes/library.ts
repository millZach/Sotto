/*
 * The theme library: built-ins, validation of saved and imported themes, the
 * T3 theme file format, and which palette each appearance paints.
 *
 * The file format, id and label rules, reserved ids and the parse/serialize
 * behaviour follow T3 Code's apps/web/src/themePalette.ts at commit
 * d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3 (MIT, Copyright (c) 2026 T3 Tools
 * Inc.), so a theme exported from T3 Code imports here and back. T3 keeps its
 * library in localStorage; Sotto keeps it in settings.json (ADR-0011).
 */

import { z } from 'zod'

import { isCanonicalThemeColor, toCanonicalThemeColor } from './color'
import { getDefaultThemeColors } from './engine'
import {
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
  T3_CHAT_THEME,
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeCollection,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeVariants,
} from './palettes'

export { THEME_COLOR_ROLES }
export type { ThemeAppearance, ThemeCollection, ThemeColorRole, ThemeColors, ThemeDefinition, ThemeVariants }

export const THEME_FILE_VERSION = 1 as const
/**
 * Both halves start on Tide (id `ocean`, T3's Ocean), the theme selected in the T3 Code reference the
 * user chose from; it is also where a half lands when its theme is removed.
 */
export const DEFAULT_THEME_ID = 'ocean'
/** How many saved themes settings.json keeps; an Open VSX pack may add up to 40 at once. */
export const MAX_CUSTOM_THEMES = 64
export const APPEARANCE_CONTRAST = { min: 50, max: 200, step: 5, default: 100 } as const
export const GLASS_OPACITY = { min: 40, max: 100, step: 5, default: 80 } as const

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES)

function decodeThemeColors(colors: Readonly<Record<ThemeColorRole, string>>): ThemeColors {
  return Object.fromEntries(THEME_COLOR_ROLES.map(role => {
    const color = toCanonicalThemeColor(colors[role])
    if (!color) throw new Error(`The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`)
    return [role, color]
  })) as Record<ThemeColorRole, string>
}

/** The standard T3 Code look, as T3 Code wears it with no theme installed. */
export const T3_CODE_THEME: ThemeDefinition = {
  id: 't3-code',
  label: 'Sotto',
  appearance: 'light',
  colors: decodeThemeColors(T3_CODE_LIGHT_THEME_COLORS),
  variants: { dark: decodeThemeColors(T3_CODE_DARK_THEME_COLORS) },
}

/**
 * Sotto names its built-ins itself; the palettes and ids stay T3's, so saved
 * selections and T3 theme files keep resolving. By id: t3-code Sotto, t3-chat
 * Rose, grove Fern, ocean Tide, ember Copper, iris Dusk.
 */
export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [
  T3_CODE_THEME,
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
]

/**
 * Ids a saved theme may not take: appearance keywords, every built-in, T3's
 * legacy aliases and the editor's draft marker. Taking one would be shadowed
 * by the built-in or collide with the root's data attributes.
 */
const RESERVED_THEME_IDS: ReadonlySet<string> = new Set([
  'system',
  'light',
  'dark',
  'default',
  '__preview',
  ...BUILT_IN_THEMES.map(theme => theme.id),
  't3-chat-dark',
  't3-grove',
  't3-ocean',
  't3-ember',
  't3-iris',
])

const THEME_ID = /^[a-z0-9](?:[a-z0-9-]{0,47})$/u
const COLLECTION_ID = /^[a-z0-9][a-z0-9.:-]{0,127}$/iu

export function isThemeId(value: unknown): value is string {
  return typeof value === 'string' && THEME_ID.test(value)
}

function isThemeLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 48
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === 'light' || value === 'dark'
}

function parseThemeCollection(value: unknown): ThemeCollection | undefined {
  return isRecord(value) && typeof value.id === 'string' && COLLECTION_ID.test(value.id) && isThemeLabel(value.label)
    ? { id: value.id, label: value.label.trim() }
    : undefined
}

// ---------------------------------------------------------------------------
// Saved themes

const themeColorsSchema = z.object(
  Object.fromEntries(THEME_COLOR_ROLES.map(role => [role, z.string().refine(isCanonicalThemeColor)])) as unknown as Record<ThemeColorRole, z.ZodType<string>>,
).strict()

/**
 * A saved theme as settings.json and every settings patch must carry it: all
 * roles present and already canonical, so nothing is repaired on the way in.
 */
export const customThemeSchema = z.object({
  id: z.string().regex(THEME_ID).refine(id => !RESERVED_THEME_IDS.has(id)),
  label: z.string().refine(label => label === label.trim() && isThemeLabel(label)),
  appearance: z.enum(['light', 'dark']),
  colors: themeColorsSchema,
  variants: z.object({ light: themeColorsSchema.optional(), dark: themeColorsSchema.optional() }).strict().optional(),
  collection: z.object({ id: z.string().regex(COLLECTION_ID), label: z.string().refine(label => label === label.trim() && isThemeLabel(label)) }).strict().optional(),
  managed: z.literal(true).optional(),
}).strict().refine(theme => theme.variants?.[theme.appearance] === undefined, { message: 'A variant may not repeat the base appearance.' })

export const customThemesSchema = z.array(customThemeSchema).max(MAX_CUSTOM_THEMES).refine(
  themes => new Set(themes.map(theme => theme.id)).size === themes.length,
  { message: 'Theme ids must be unique.' },
)

/** Unknown roles and bad values are dropped and missing roles filled, so a theme from another build keeps its good colours. */
function lenientThemeColors(value: unknown, appearance: ThemeAppearance): ThemeColors | null {
  if (!isRecord(value)) return null
  const colors: Partial<Record<ThemeColorRole, string>> = {}
  for (const [role, color] of Object.entries(value)) {
    const normalized = toCanonicalThemeColor(color)
    if (THEME_COLOR_ROLE_SET.has(role) && normalized) colors[role as ThemeColorRole] = normalized
  }
  return { ...getDefaultThemeColors(appearance), ...colors }
}

/** Read one saved theme leniently; null when it cannot be a theme at all. */
function normalizeStoredTheme(value: unknown): ThemeDefinition | null {
  if (!isRecord(value)) return null
  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null
  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null
  const colors = lenientThemeColors(value.colors, value.appearance)
  if (!colors) return null
  let variants: Partial<Record<ThemeAppearance, ThemeColors>> | undefined
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) return null
    variants = {}
    for (const [appearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(appearance)) return null
      if (appearance === value.appearance) continue
      const parsed = lenientThemeColors(variantColors, appearance)
      if (!parsed) return null
      variants[appearance] = parsed
    }
    if (Object.keys(variants).length === 0) variants = undefined
  }
  const collection = parseThemeCollection(value.collection)
  return {
    id: value.id,
    label: value.label.trim(),
    appearance: value.appearance,
    colors,
    ...(variants ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  }
}

/** The saved library from an untrusted value: bad entries and duplicate ids dropped, capped. */
export function parseCustomThemes(value: unknown): ThemeDefinition[] {
  if (!Array.isArray(value)) return []
  const themes: ThemeDefinition[] = []
  for (const entry of value) {
    const theme = normalizeStoredTheme(entry)
    if (theme && !themes.some(existing => existing.id === theme.id)) themes.push(theme)
    if (themes.length === MAX_CUSTOM_THEMES) break
  }
  return themes
}

// ---------------------------------------------------------------------------
// Resolution

export function getThemeColorsForMode(theme: ThemeDefinition, mode: ThemeAppearance): ThemeColors | null {
  if (mode === theme.appearance) return theme.colors
  return theme.variants?.[mode] ?? null
}

export function getThemeModes(theme: ThemeDefinition): ThemeAppearance[] {
  return (['light', 'dark'] as const).filter(mode => getThemeColorsForMode(theme, mode) !== null)
}

export function findTheme(id: string, customThemes: readonly ThemeDefinition[]): ThemeDefinition | null {
  return BUILT_IN_THEMES.find(theme => theme.id === id) ?? customThemes.find(theme => theme.id === id) ?? null
}

/** The id that really paints an appearance: a theme that can render it, else the default. */
export function resolveThemeHalfId(id: string, appearance: ThemeAppearance, customThemes: readonly ThemeDefinition[]): string {
  const theme = findTheme(id, customThemes)
  return theme && getThemeColorsForMode(theme, appearance) ? theme.id : DEFAULT_THEME_ID
}

export interface ThemeSelection {
  readonly lightTheme: string
  readonly darkTheme: string
  readonly customThemes: readonly ThemeDefinition[]
}

export function resolveThemeFor(selection: ThemeSelection, appearance: ThemeAppearance): { theme: ThemeDefinition; colors: ThemeColors } {
  const id = resolveThemeHalfId(appearance === 'dark' ? selection.darkTheme : selection.lightTheme, appearance, selection.customThemes)
  const theme = findTheme(id, selection.customThemes) ?? OCEAN_THEME
  return { theme, colors: getThemeColorsForMode(theme, appearance) ?? getThemeColorsForMode(OCEAN_THEME, appearance)! }
}

// ---------------------------------------------------------------------------
// Theme files

export interface ThemeFile {
  readonly version: typeof THEME_FILE_VERSION
  readonly id: string
  readonly name: string
  readonly appearance: ThemeAppearance
  readonly colors: Partial<Record<ThemeColorRole, string>>
  readonly variants?: Partial<Record<ThemeAppearance, Partial<Record<ThemeColorRole, string>>>>
  readonly collection?: ThemeCollection
  readonly managed?: boolean
}

export function themeIdFromName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48).replace(/-+$/u, '')
  return normalized || 'custom-theme'
}

/** `base`, or `base-2`, `base-3`… until the id is free and not reserved. */
export function uniqueThemeId(base: string, taken: ReadonlySet<string>): string {
  const root = isThemeId(base) ? base : 'custom-theme'
  if (!taken.has(root) && !RESERVED_THEME_IDS.has(root)) return root
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`
    const candidate = `${root.slice(0, 48 - suffix.length).replace(/-+$/u, '')}${suffix}`
    if (!taken.has(candidate) && !RESERVED_THEME_IDS.has(candidate)) return candidate
  }
}

function parseThemeColorOverrides(value: unknown): Partial<Record<ThemeColorRole, string>> {
  if (!isRecord(value)) throw new Error('Theme colors must be objects.')
  const overrides: Partial<Record<ThemeColorRole, string>> = {}
  for (const [role, color] of Object.entries(value)) {
    if (!THEME_COLOR_ROLE_SET.has(role)) throw new Error(`"${role.slice(0, 64)}" is not a supported theme color role.`)
    const normalized = toCanonicalThemeColor(color)
    if (!normalized) throw new Error(`The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`)
    overrides[role as ThemeColorRole] = normalized
  }
  if (Object.keys(overrides).length === 0) throw new Error('Add at least one color role to the theme file.')
  return overrides
}

/** Parse a T3 theme file (version 1). Throws with a message fit to show the user. */
export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) throw new Error('Theme files must contain a JSON object.')
  if (value.version !== THEME_FILE_VERSION) throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`)
  const { name, appearance } = value
  if (!isThemeLabel(name)) throw new Error('Theme files need a name (48 characters or fewer).')
  if (!isThemeAppearance(appearance)) throw new Error('Theme files need an appearance of "light" or "dark".')
  if (!isRecord(value.colors)) throw new Error('Theme files need a colors object.')
  const id = value.id === undefined ? themeIdFromName(name) : value.id
  if (!isThemeId(id)) throw new Error('Theme ids may only contain lowercase letters, numbers, and hyphens.')
  if (RESERVED_THEME_IDS.has(id)) throw new Error(`The theme id "${id}" is reserved.`)
  const overrides = parseThemeColorOverrides(value.colors)
  const collection = parseThemeCollection(value.collection)
  if (value.collection !== undefined && !collection) throw new Error('Theme collections need a valid id and label.')
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {}
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error('Theme variants must be an object.')
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) throw new Error('Theme variants may only be named "light" or "dark".')
      if (variantAppearance === appearance) throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`)
      variants[variantAppearance] = { ...getDefaultThemeColors(variantAppearance), ...parseThemeColorOverrides(variantColors) }
    }
  }
  return {
    id,
    label: name.trim(),
    appearance,
    colors: { ...getDefaultThemeColors(appearance), ...overrides },
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  }
}

export function serializeThemeFile(theme: ThemeDefinition): string {
  const file: ThemeFile = {
    version: THEME_FILE_VERSION,
    id: theme.id,
    name: theme.label,
    appearance: theme.appearance,
    colors: decodeThemeColors(theme.colors),
    ...(theme.variants
      ? { variants: Object.fromEntries(Object.entries(theme.variants).map(([mode, colors]) => [mode, decodeThemeColors(colors)])) }
      : {}),
    ...(theme.collection ? { collection: theme.collection } : {}),
    ...(theme.managed ? { managed: true } : {}),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/** A theme in the exact canonical shape `customThemeSchema` accepts; throws when a colour cannot be decoded. */
export function canonicalizeTheme(theme: ThemeDefinition): ThemeDefinition {
  return {
    id: theme.id,
    label: theme.label.trim(),
    appearance: theme.appearance,
    colors: decodeThemeColors(theme.colors),
    ...(theme.variants && Object.entries(theme.variants).some(([mode, colors]) => mode !== theme.appearance && colors)
      ? {
          variants: Object.fromEntries(Object.entries(theme.variants)
            .filter(([mode, colors]) => mode !== theme.appearance && colors)
            .map(([mode, colors]) => [mode, decodeThemeColors(colors!)])),
        }
      : {}),
    ...(theme.collection ? { collection: { id: theme.collection.id, label: theme.collection.label.trim() } } : {}),
    ...(theme.managed ? { managed: true } : {}),
  }
}
