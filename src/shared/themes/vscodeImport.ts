/*
 * Best-effort import of a VS Code colour theme (`*-color-theme.json`).
 *
 * Ported from T3 Code's apps/web/src/vscodeThemeImport.ts at commit
 * d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3. MIT License, Copyright (c) 2026
 * T3 Tools Inc.; see THIRD_PARTY_NOTICES.md.
 *
 * VS Code themes describe editor chrome, not an app palette: they carry a few
 * hundred workbench keys, leave most of them unset, and freely use 8-digit hex
 * with alpha for overlays. So the conversion derives a complete, contrast-solved
 * palette from the theme's editor background and accent, then layers the
 * workbench colours it did specify on top. Anything the file omits keeps the
 * derived value instead of falling back to an unrelated palette. The result
 * goes through parseThemeFile, so it is validated like a hand-written file.
 */

import { contrastRatio, relativeLuminance, themeColorToHex, type ThemeRgb } from './color'
import { createVividThemeColors } from './engine'
import { THEME_FILE_VERSION, getThemeModes, parseThemeFile } from './library'
import type { ThemeAppearance, ThemeColorRole, ThemeDefinition } from './palettes'

interface VsCodeRgba extends ThemeRgb { readonly a: number }

/** Every workbench colour the importer reads. Open VSX installs keep only these keys. */
export const VSCODE_WORKBENCH_COLOR_KEYS = [
  'focusBorder', 'foreground', 'descriptionForeground', 'disabledForeground', 'contrastBorder', 'errorForeground',
  'activityBar.background', 'activityBarBadge.background', 'badge.background', 'button.background',
  'button.foreground', 'dropdown.background', 'dropdown.border', 'editor.background', 'editor.foreground',
  'editor.selectionBackground', 'editorCursor.foreground', 'editorError.foreground', 'editorGroup.border',
  'editorPane.background', 'editorWarning.foreground', 'editorWidget.background', 'input.border',
  'input.placeholderForeground', 'list.activeSelectionBackground', 'list.hoverBackground',
  'list.inactiveSelectionBackground', 'menu.background', 'panel.background', 'panel.border',
  'progressBar.background', 'quickInput.background', 'scrollbarSlider.background', 'sideBar.background',
  'sideBar.border', 'sideBar.foreground', 'terminal.background', 'terminal.foreground',
  'terminal.selectionBackground', 'terminalCursor.foreground', 'textCodeBlock.background',
  'textLink.foreground',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function decodeGamma(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function encodeGamma(value: number): number {
  const clamped = clamp01(value)
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055
}

/** `color(display-p3 r g b / a)` from themes authored for wide-gamut displays;
 *  out-of-gamut colours clip to the sRGB edge. */
function parseColorFunction(value: string): VsCodeRgba | null {
  const match = /^color\(\s*(display-p3|srgb)\s+([^)]+)\)$/iu.exec(value)
  if (!match) return null
  const space = match[1]!.toLowerCase()
  const [channelPart, alphaPart, extra] = match[2]!.split('/')
  if (extra !== undefined) return null
  const channels = channelPart!.trim().split(/\s+/u).map(part => (part.endsWith('%') ? Number.parseFloat(part) / 100 : Number(part)))
  if (channels.length !== 3 || channels.some(channel => !Number.isFinite(channel))) return null
  const alphaRaw = alphaPart?.trim()
  const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith('%') ? Number.parseFloat(alphaRaw) / 100 : Number(alphaRaw)
  if (!Number.isFinite(alpha)) return null
  const [red, green, blue] = channels as [number, number, number]
  if (space === 'srgb') return { r: clamp01(red) * 255, g: clamp01(green) * 255, b: clamp01(blue) * 255, a: clamp01(alpha) }
  const [lr, lg, lb] = [red, green, blue].map(decodeGamma) as [number, number, number]
  // Display P3 linear -> sRGB linear.
  return {
    r: encodeGamma(1.2249401762805 * lr - 0.2249401762805 * lg) * 255,
    g: encodeGamma(-0.042056961239 * lr + 1.042056961239 * lg) * 255,
    b: encodeGamma(-0.0196375547643 * lr - 0.0786360655012 * lg + 1.0982736202656 * lb) * 255,
    a: clamp01(alpha),
  }
}

/** VS Code accepts #RGB, #RGBA, #RRGGBB and #RRGGBBAA; some themes also use CSS color(). */
function parseVsCodeColor(value: unknown): VsCodeRgba | null {
  if (typeof value !== 'string' || value.length > 96) return null
  const trimmed = value.trim()
  if (trimmed.startsWith('color(')) return parseColorFunction(trimmed)
  const hex = trimmed.replace(/^#/u, '')
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(hex)) return null
  const expand = (part: string): number => (part.length === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16))
  if (hex.length <= 4) {
    return { r: expand(hex[0]!), g: expand(hex[1]!), b: expand(hex[2]!), a: hex.length === 4 ? expand(hex[3]!) / 255 : 1 }
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  }
}

function toHex(color: ThemeRgb): string {
  const channel = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

/** Overlays are translucent in VS Code; theme roles are opaque, so they are
 *  composited onto the surface they sit on. */
function flattenOver(color: VsCodeRgba, base: ThemeRgb): string {
  if (color.a >= 1) return toHex(color)
  return toHex({
    r: color.r * color.a + base.r * (1 - color.a),
    g: color.g * color.a + base.g * (1 - color.a),
    b: color.b * color.a + base.b * (1 - color.a),
  })
}

function hexToRgb(value: string): ThemeRgb {
  return parseVsCodeColor(themeColorToHex(value) ?? value) ?? { r: 0, g: 0, b: 0 }
}

/** A VS Code theme is recognised by its workbench colours: dotted keys
 *  (`editor.background`), which theme files never use. */
export function isVsCodeThemeFile(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.version === THEME_FILE_VERSION) return false
  const hasWorkbenchColors = isRecord(value.colors) && Object.keys(value.colors).some(key => key.includes('.'))
  return hasWorkbenchColors || Array.isArray(value.tokenColors)
}

function resolveAppearance(value: Record<string, unknown>, canvas: ThemeRgb): ThemeAppearance {
  const type = typeof value.type === 'string' ? value.type.toLowerCase() : null
  if (type === 'light' || type === 'hc-light') return 'light'
  if (type === 'dark' || type === 'hc-black') return 'dark'
  return relativeLuminance(canvas) < 0.179 ? 'dark' : 'light'
}

/** Extension `name` fields are often package slugs; read them as words. */
export function humanizeThemeName(raw: string): string {
  const trimmed = raw.trim()
  if (/\s/u.test(trimmed) || !/[-_.]/u.test(trimmed)) return trimmed
  return trimmed
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function resolveName(value: Record<string, unknown>): string {
  for (const candidate of [value.displayName, value.name]) {
    if (typeof candidate !== 'string') continue
    const humanized = humanizeThemeName(candidate).slice(0, 48).trim()
    if (humanized.length > 0) return humanized
  }
  return 'VS Code theme'
}

export function parseVsCodeThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) throw new Error('Theme files must contain a JSON object.')
  const colors = isRecord(value.colors) ? value.colors : {}

  const pick = (...keys: readonly string[]): VsCodeRgba | null => {
    for (const key of keys) {
      const parsed = parseVsCodeColor(colors[key])
      if (parsed) return parsed
    }
    return null
  }
  const solidOver = (base: ThemeRgb, ...keys: readonly string[]): string | null => {
    const parsed = pick(...keys)
    return parsed ? flattenOver(parsed, base) : null
  }

  const canvasColor = pick('editor.background', 'editorPane.background')
  if (!canvasColor) throw new Error('That VS Code theme has no "editor.background" color, so there is nothing to build a palette from.')
  const canvas = { r: canvasColor.r, g: canvasColor.g, b: canvasColor.b }
  const appearance = resolveAppearance(value, canvas)

  const accentColor = pick('focusBorder', 'button.background', 'textLink.foreground', 'activityBarBadge.background', 'progressBar.background', 'badge.background')
  const canvasHex = toHex(canvas)
  const accentHex = accentColor ? flattenOver(accentColor, canvas) : null

  // The derived palette is the floor, built from a muted accent so a neutral
  // theme with a blue focusBorder does not get blue text surfaces.
  const mutedAccentHex = accentColor ? flattenOver({ r: accentColor.r, g: accentColor.g, b: accentColor.b, a: 0.2 }, canvas) : null
  const derived = createVividThemeColors(appearance, canvasHex, mutedAccentHex ?? canvasHex)
  const sidebarHex = solidOver(canvas, 'sideBar.background', 'activityBar.background') ?? derived.sidebar
  const sidebar = hexToRgb(sidebarHex)
  const terminalHex = solidOver(canvas, 'terminal.background', 'panel.background') ?? derived.terminalBackground
  const terminal = hexToRgb(terminalHex)

  /** Foregrounds only win when they stay readable on the surface they land on. */
  const readableOn = (surface: string, fallback: string, ...keys: readonly string[]): string => {
    const surfaceRgb = hexToRgb(surface)
    const isReadable = (candidate: string): boolean => contrastRatio(hexToRgb(candidate), surfaceRgb) >= 4.5
    const specified = solidOver(surfaceRgb, ...keys)
    if (specified && isReadable(specified)) return specified
    if (isReadable(fallback)) return fallback
    return relativeLuminance(surfaceRgb) < 0.179 ? '#ffffff' : '#000000'
  }

  const overrides: Partial<Record<ThemeColorRole, string>> = {
    canvas: canvasHex,
    text: readableOn(canvasHex, derived.text, 'editor.foreground', 'foreground'),
    textMuted: readableOn(canvasHex, derived.textMuted, 'descriptionForeground', 'disabledForeground'),
    surface: solidOver(canvas, 'editorWidget.background') ?? derived.surface,
    surfaceRaised: solidOver(canvas, 'editorWidget.background', 'dropdown.background') ?? derived.surfaceRaised,
    surfaceOverlay: solidOver(canvas, 'menu.background', 'quickInput.background', 'dropdown.background') ?? derived.surfaceOverlay,
    border: solidOver(canvas, 'panel.border', 'editorGroup.border', 'contrastBorder') ?? derived.border,
    input: solidOver(canvas, 'input.border', 'dropdown.border') ?? derived.input,
    placeholder: readableOn(canvasHex, derived.placeholder, 'input.placeholderForeground'),
    error: readableOn(canvasHex, derived.error, 'editorError.foreground', 'errorForeground'),
    warning: readableOn(canvasHex, derived.warning, 'editorWarning.foreground'),
    accentSurface: solidOver(canvas, 'list.activeSelectionBackground', 'list.hoverBackground') ?? derived.accentSurface,
    codeBackground: solidOver(canvas, 'textCodeBlock.background') ?? derived.codeBackground,
    sidebar: sidebarHex,
    sidebarForeground: readableOn(sidebarHex, derived.sidebarForeground, 'sideBar.foreground'),
    sidebarBorder: solidOver(sidebar, 'sideBar.border') ?? derived.sidebarBorder,
    sidebarRowHover: solidOver(sidebar, 'list.hoverBackground') ?? derived.sidebarRowHover,
    sidebarRowActive: solidOver(sidebar, 'list.inactiveSelectionBackground', 'list.hoverBackground') ?? derived.sidebarRowActive,
    sidebarRowSelected: solidOver(sidebar, 'list.activeSelectionBackground') ?? derived.sidebarRowSelected,
    terminalBackground: terminalHex,
    terminalForeground: readableOn(terminalHex, derived.terminalForeground, 'terminal.foreground'),
    terminalCursor: solidOver(terminal, 'terminalCursor.foreground', 'editorCursor.foreground') ?? derived.terminalCursor,
    terminalSelection: solidOver(terminal, 'terminal.selectionBackground', 'editor.selectionBackground') ?? derived.terminalSelection,
    terminalScrollbar: solidOver(terminal, 'scrollbarSlider.background') ?? derived.terminalScrollbar,
  }
  if (accentHex) {
    overrides.accent = accentHex
    overrides.focus = accentHex
    const actionHex = solidOver(canvas, 'button.background') ?? accentHex
    overrides.messageAction = actionHex
    overrides.messageActionForeground = readableOn(actionHex, derived.messageActionForeground, 'button.foreground')
    overrides.accentForeground = readableOn(accentHex, derived.accentForeground, 'button.foreground')
  }

  return parseThemeFile({ version: THEME_FILE_VERSION, name: resolveName(value), appearance, colors: { ...derived, ...overrides } })
}

/**
 * Extensions ship families of themes. When several are imported together, a
 * light and a dark file whose names differ only by the appearance word become
 * one dual-mode theme; everything else stays its own theme.
 */
export function pairVsCodeThemes(
  themes: readonly ThemeDefinition[],
  options?: { readonly pairedId?: (light: ThemeDefinition, dark: ThemeDefinition) => string },
): ThemeDefinition[] {
  const stripAppearance = (label: string): string => label.replace(/\b(?:light|dark)\b/giu, ' ').replace(/\s+/gu, ' ').trim()

  interface Group { light: ThemeDefinition[]; dark: ThemeDefinition[]; order: number }
  const groups = new Map<string, Group>()
  const passthrough: Array<{ theme: ThemeDefinition; order: number }> = []
  themes.forEach((theme, order) => {
    const key = stripAppearance(theme.label)
    if (getThemeModes(theme).length !== 1 || key === theme.label || key.length === 0) {
      passthrough.push({ theme, order })
      return
    }
    const group = groups.get(key) ?? { light: [], dark: [], order }
    group[theme.appearance].push(theme)
    groups.set(key, group)
  })

  const paired: Array<{ theme: ThemeDefinition; order: number }> = []
  for (const [key, group] of groups) {
    // Ambiguous pairs, and pairs whose stripped name is reserved, stay single.
    if (group.light.length === 1 && group.dark.length === 1) {
      try {
        paired.push({
          order: group.order,
          theme: parseThemeFile({
            version: THEME_FILE_VERSION,
            ...(options?.pairedId ? { id: options.pairedId(group.light[0]!, group.dark[0]!) } : {}),
            name: key,
            appearance: 'light',
            colors: group.light[0]!.colors,
            variants: { dark: group.dark[0]!.colors },
          }),
        })
        continue
      } catch {
        // Fall through to the individual themes.
      }
    }
    for (const theme of [...group.light, ...group.dark]) paired.push({ theme, order: group.order })
  }

  return [...passthrough, ...paired].sort((a, b) => a.order - b.order).map(entry => entry.theme)
}

/**
 * Some extensions reuse one display name across files (Dracula ships
 * dracula.json and dracula-soft.json, both "Dracula"). Colliding entries are
 * relabelled from their file name, numbered only when even that collides.
 */
export function resolveThemeLabelCollisions(
  entries: ReadonlyArray<{ readonly theme: ThemeDefinition; readonly sourceName?: string | undefined }>,
): ThemeDefinition[] {
  const rename = (theme: ThemeDefinition, name: string): ThemeDefinition | null => {
    try {
      return parseThemeFile({
        version: THEME_FILE_VERSION,
        name: name.slice(0, 48).trim(),
        appearance: theme.appearance,
        colors: theme.colors,
        ...(theme.variants ? { variants: theme.variants } : {}),
        ...(theme.managed ? { managed: true } : {}),
      })
    } catch {
      return null
    }
  }

  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.theme.id, (counts.get(entry.theme.id) ?? 0) + 1)
  const relabelled = entries.map(({ theme, sourceName }) => {
    if ((counts.get(theme.id) ?? 0) < 2) return theme
    const stem = sourceName?.replace(/\.[^.]+$/u, '')
    const fromFile = stem ? humanizeThemeName(stem) : null
    const renamed = fromFile && fromFile.toLowerCase() !== theme.label.toLowerCase() ? rename(theme, fromFile) : null
    return renamed ?? theme
  })

  const seen = new Set<string>()
  return relabelled.map(theme => {
    if (!seen.has(theme.id)) {
      seen.add(theme.id)
      return theme
    }
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = rename(theme, `${theme.label} ${suffix}`)
      if (candidate && !seen.has(candidate.id)) {
        seen.add(candidate.id)
        return candidate
      }
    }
    return theme
  })
}
