/*
 * The palette engine: a full theme from two seed colours, and the Advanced
 * editor's family updates. Ported from T3 Code's apps/web/src/themePalette.ts
 * (createVividThemeColors, updateThemeColorFamily and their helpers) at commit
 * d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3. MIT License, Copyright (c) 2026
 * T3 Tools Inc.; see THIRD_PARTY_NOTICES.md.
 */

import {
  THEME_BLACK_FOREGROUND,
  THEME_LIGHT_FOREGROUND,
  THEME_WHITE_FOREGROUND,
  formatOklch,
  isDarkRgb,
  mixRgb,
  oklchToRgb,
  oklchToThemeColor,
  parseThemeColor,
  parseThemeRgb,
  readableForeground,
  readableText,
  rgbToOklch,
  rgbToThemeColor,
  solveOklchLightness,
  toCanonicalThemeColor,
  type ThemeOklch,
  type ThemeRgb,
} from './color'
import { T3_CHAT_THEME, type ThemeAppearance, type ThemeColorRole, type ThemeColors } from './palettes'

/** Roles a theme file leaves out are filled from the flagship T3 Chat palette, as in T3 Code. */
export function getDefaultThemeColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === 'dark' ? T3_CHAT_THEME.variants!.dark! : T3_CHAT_THEME.colors
}

const DARK_CANVAS_FALLBACK: ThemeRgb = { r: 24, g: 15, b: 27 }
const LIGHT_CANVAS_FALLBACK: ThemeRgb = { r: 250, g: 245, b: 250 }
const ACCENT_FALLBACK: ThemeRgb = { r: 168, g: 67, b: 112 }

/**
 * The status colours T3 Code shows without a theme (red-500 / amber-500
 * families). Generated palettes use these so a created or imported theme
 * never inherits a brand tint on destructive buttons and warnings.
 */
const STANDARD_STATUS_COLORS = {
  light: { error: '#fb2c36', errorForeground: '#c10007', warning: '#fe9a00', warningForeground: '#bb4d00' },
  dark: { error: '#fb414a', errorForeground: '#ff6467', warning: '#fe9a00', warningForeground: '#ffb900' },
} as const

function standardStatusColors(canvas: ThemeRgb): Pick<ThemeColors, 'error' | 'errorForeground' | 'errorSurface' | 'warning' | 'warningForeground' | 'warningSurface'> {
  // Keyed off the canvas, not the appearance slot: a dark canvas saved as a
  // light theme still needs the dark pair.
  const appearance: ThemeAppearance = isDarkRgb(canvas) ? 'dark' : 'light'
  const standard = STANDARD_STATUS_COLORS[appearance]
  const surfaceMix = appearance === 'dark' ? 0.16 : 0.08
  const surfaceOf = (value: string): ThemeRgb => mixRgb(canvas, parseThemeRgb(value, canvas), surfaceMix)
  const readableOn = (foreground: string, surface: ThemeRgb): string => oklchToThemeColor(
    solveOklchLightness(rgbToOklch(parseThemeRgb(foreground, canvas)), surface, 4.6, appearance === 'dark' ? 'lighter' : 'darker'),
  )
  const errorSurface = surfaceOf(standard.error)
  const warningSurface = surfaceOf(standard.warning)
  return {
    error: toCanonicalThemeColor(standard.error)!,
    errorForeground: readableOn(standard.errorForeground, errorSurface),
    errorSurface: rgbToThemeColor(errorSurface),
    warning: toCanonicalThemeColor(standard.warning)!,
    warningForeground: readableOn(standard.warningForeground, warningSurface),
    warningSurface: rgbToThemeColor(warningSurface),
  }
}

// The measured contrast of zinc-500 on T3's standard light canvas and #818181
// on its dark canvas, so generated muted text matches the stock strength.
const STANDARD_LIGHT_MUTED_CONTRAST = 4.705
const STANDARD_DARK_MUTED_CONTRAST = 5.082

function standardMutedText(background: ThemeRgb, foreground: ThemeRgb): ThemeRgb {
  return readableText(background, foreground, 1, isDarkRgb(background) ? STANDARD_DARK_MUTED_CONTRAST : STANDARD_LIGHT_MUTED_CONTRAST)
}

/**
 * Derive a full palette from two seed colours, in OKLCH. Surfaces climb an
 * even lightness ramp carrying the accent hue at low chroma, a companion
 * action colour is rotated off the accent, and every foreground is
 * contrast-solved against its own surface.
 */
export function createVividThemeColors(appearance: ThemeAppearance, backgroundValue: string, accentValue: string): ThemeColors {
  const defaults = getDefaultThemeColors(appearance)
  const canvasRgb = parseThemeRgb(backgroundValue, appearance === 'dark' ? DARK_CANVAS_FALLBACK : LIGHT_CANVAS_FALLBACK)
  const accentRgb = parseThemeRgb(accentValue, ACCENT_FALLBACK)
  const canvas = rgbToOklch(canvasRgb)
  const accent = rgbToOklch(accentRgb)
  const dark = isDarkRgb(canvasRgb)
  const hue = accent.C < 0.02 ? canvas.h : accent.h
  const tintC = Math.min(0.045, Math.max(0.008, accent.C * 0.22))
  const step = dark ? 1 : -1

  const surfaceAt = (deltaL: number, chroma = tintC): ThemeOklch => ({
    L: Math.min(0.98, Math.max(0.05, canvas.L + step * deltaL)),
    C: chroma,
    h: hue,
  })
  const themeColor = (color: ThemeOklch): string => oklchToThemeColor(color)

  const textBase: ThemeOklch = { L: dark ? 0.95 : 0.2, C: Math.min(0.035, accent.C * 0.25), h: hue }
  const text = solveOklchLightness(textBase, canvasRgb, 7, dark ? 'lighter' : 'darker')
  const textRgb = oklchToRgb(text)
  const textMutedRgb = standardMutedText(canvasRgb, textRgb)

  const action: ThemeOklch = {
    L: Math.min(0.85, Math.max(0.35, accent.L + (dark ? 0.06 : -0.02))),
    C: Math.max(accent.C * 0.9, 0.06),
    h: (hue + 50) % 360,
  }
  const actionRgb = oklchToRgb(action)
  const actionForeground = readableForeground(actionRgb)
  const accentForeground = readableForeground(accentRgb)

  const sidebar = surfaceAt(0.045, tintC * 1.4)
  const sidebarRgb = oklchToRgb(sidebar)
  const surface = surfaceAt(0.015)
  const surfaceRaised = surfaceAt(0.05)
  const surfaceRaisedRgb = oklchToRgb(surfaceRaised)
  const surfaceOverlay = surfaceAt(0.075)
  const border = surfaceAt(dark ? 0.16 : 0.12, Math.min(0.07, accent.C * 0.35))
  const input = surfaceAt(dark ? 0.21 : 0.16, Math.min(0.08, accent.C * 0.4))
  const secondary = surfaceAt(dark ? 0.1 : 0.06, Math.min(0.09, accent.C * 0.5))
  const secondaryRgb = oklchToRgb(secondary)
  const muted = surfaceAt(dark ? 0.06 : 0.04, Math.min(0.06, accent.C * 0.35))
  const mutedRgb = oklchToRgb(muted)
  const accentSurface = surfaceAt(dark ? 0.13 : 0.08, Math.min(0.11, accent.C * 0.55))
  const accentSurfaceRgb = oklchToRgb(accentSurface)
  const messageSurface = surfaceAt(dark ? 0.16 : 0.1, Math.min(0.13, accent.C * 0.6))
  const messageSurfaceRgb = oklchToRgb(messageSurface)
  const codeBackground = surfaceAt(0.035, tintC * 0.8)
  const updateSurface = surfaceAt(dark ? 0.14 : 0.09, Math.min(0.12, accent.C * 0.55))

  const foregroundOn = (surfaceRgb: ThemeRgb): string =>
    oklchToThemeColor(solveOklchLightness(textBase, surfaceRgb, 4.6, dark ? 'lighter' : 'darker'))
  const mutedForeground = rgbToThemeColor(readableText(mutedRgb, textRgb, 1, 4.6))
  const placeholder = rgbToThemeColor(readableText(surfaceRaisedRgb, textRgb, 1, 4.6))
  const actionHover: ThemeOklch = { ...action, L: action.L + (dark ? 0.06 : -0.06) }

  return {
    ...defaults,
    ...standardStatusColors(canvasRgb),
    canvas: rgbToThemeColor(canvasRgb),
    chrome: rgbToThemeColor(canvasRgb),
    toolbar: rgbToThemeColor(canvasRgb),
    toolbarForeground: rgbToThemeColor(textRgb),
    toolbarBorder: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.08, accent.C * 0.4))),
    toolbarControl: themeColor(surfaceAt(dark ? 0.09 : 0.05, tintC * 1.3)),
    toolbarControlForeground: rgbToThemeColor(textRgb),
    toolbarControlHover: themeColor(surfaceAt(dark ? 0.14 : 0.09, tintC * 1.6)),
    surface: themeColor(surface),
    surfaceRaised: themeColor(surfaceRaised),
    surfaceOverlay: themeColor(surfaceOverlay),
    text: rgbToThemeColor(textRgb),
    textMuted: rgbToThemeColor(textMutedRgb),
    border: themeColor(border),
    input: themeColor(input),
    focus: rgbToThemeColor(accentRgb),
    accent: rgbToThemeColor(accentRgb),
    accentForeground: rgbToThemeColor(accentForeground),
    secondary: themeColor(secondary),
    secondaryForeground: foregroundOn(secondaryRgb),
    muted: themeColor(muted),
    mutedForeground,
    placeholder,
    secondaryLabel: rgbToThemeColor(textMutedRgb),
    iconMuted: rgbToThemeColor(textMutedRgb),
    update: rgbToThemeColor(accentRgb),
    updateForeground: foregroundOn(oklchToRgb(updateSurface)),
    updateSurface: themeColor(updateSurface),
    accentSurface: themeColor(accentSurface),
    accentSurfaceForeground: foregroundOn(accentSurfaceRgb),
    messageSurface: themeColor(messageSurface),
    messageForeground: foregroundOn(messageSurfaceRgb),
    messageAction: rgbToThemeColor(actionRgb),
    messageActionForeground: rgbToThemeColor(actionForeground),
    messageActionHover: themeColor(actionHover),
    codeBackground: themeColor(codeBackground),
    codeForeground: rgbToThemeColor(textRgb),
    sidebar: themeColor(sidebar),
    sidebarForeground: foregroundOn(sidebarRgb),
    sidebarMutedForeground: rgbToThemeColor(standardMutedText(sidebarRgb, textRgb)),
    sidebarControlSurface: themeColor(surfaceAt(dark ? 0.1 : 0.07, tintC * 1.5)),
    sidebarRowHover: themeColor(surfaceAt(dark ? 0.08 : 0.06, Math.min(0.08, accent.C * 0.45))),
    sidebarRowActive: themeColor(surfaceAt(dark ? 0.12 : 0.09, Math.min(0.1, accent.C * 0.55))),
    sidebarRowSelected: themeColor(surfaceAt(dark ? 0.14 : 0.1, Math.min(0.11, accent.C * 0.6))),
    sidebarBorder: themeColor(surfaceAt(dark ? 0.17 : 0.12, Math.min(0.08, accent.C * 0.4))),
    terminalBackground: rgbToThemeColor(canvasRgb),
    terminalForeground: rgbToThemeColor(textRgb),
    terminalCursor: rgbToThemeColor(accentRgb),
    terminalSelection: themeColor(surfaceAt(dark ? 0.18 : 0.12, Math.min(0.12, accent.C * 0.55))),
    terminalScrollbar: themeColor(surfaceAt(dark ? 0.22 : 0.16, tintC)),
    terminalScrollbarHover: themeColor(surfaceAt(dark ? 0.3 : 0.22, tintC)),
  }
}

/**
 * Update one Advanced-editor colour family without normalising the rest of a
 * hand-tuned palette. Each family exposes a representative role; its paired
 * foregrounds and nearby states are derived only when that role changes.
 */
export function updateThemeColorFamily(appearance: ThemeAppearance, colors: ThemeColors, role: ThemeColorRole, value: string): ThemeColors {
  const parsedSelected = parseThemeColor(value)
  if (!parsedSelected) return { ...colors, [role]: value }
  const normalized = formatOklch(parsedSelected.color, parsedSelected.alpha)

  const canvas = parseThemeRgb(colors.canvas, appearance === 'dark' ? DARK_CANVAS_FALLBACK : LIGHT_CANVAS_FALLBACK)
  const selected = oklchToRgb(parsedSelected.color)
  const selectedOn = (background: ThemeRgb): ThemeRgb => mixRgb(background, selected, parsedSelected.alpha)
  const selectedOnCanvas = selectedOn(canvas)
  const accent = parseThemeRgb(colors.accent, ACCENT_FALLBACK)
  const canvasIsDark = isDarkRgb(canvas)
  const terminalIsDark = isDarkRgb(selectedOnCanvas)
  const colorOf = (color: ThemeRgb): string => rgbToThemeColor(color)
  const foregroundOn = (background: ThemeRgb): string => colorOf(readableForeground(background))
  const selectedToneOn = (background: ThemeRgb): string => oklchToThemeColor(
    solveOklchLightness(parsedSelected.color, background, 4.6, isDarkRgb(background) ? 'lighter' : 'darker'),
  )
  const statusColors = (): { foreground: string; surface: string } => {
    const surface = mixRgb(canvas, selectedOnCanvas, canvasIsDark ? 0.16 : 0.08)
    return { foreground: selectedToneOn(surface), surface: colorOf(surface) }
  }

  switch (role) {
    case 'canvas':
      return { ...colors, canvas: normalized, chrome: normalized, toolbar: normalized }
    case 'surface':
    case 'surfaceRaised':
    case 'surfaceOverlay':
    case 'input':
    case 'sidebarControlSurface':
      return { ...colors, [role]: normalized }
    case 'text':
      return { ...colors, text: normalized, toolbarForeground: normalized, toolbarControlForeground: normalized }
    case 'mutedForeground':
      return {
        ...colors,
        textMuted: normalized,
        mutedForeground: normalized,
        placeholder: normalized,
        secondaryLabel: normalized,
        iconMuted: normalized,
        sidebarMutedForeground: normalized,
      }
    case 'border':
      return { ...colors, border: normalized, toolbarBorder: normalized, sidebarBorder: normalized }
    case 'secondary':
      return { ...colors, secondary: normalized, secondaryForeground: foregroundOn(selectedOnCanvas), muted: normalized, toolbarControl: normalized }
    case 'accentSurface':
      return { ...colors, accentSurface: normalized, accentSurfaceForeground: foregroundOn(selectedOnCanvas), toolbarControlHover: normalized }
    case 'accent': {
      const updateSurface = mixRgb(canvas, selectedOnCanvas, canvasIsDark ? 0.32 : 0.16)
      return {
        ...colors,
        accent: normalized,
        accentForeground: foregroundOn(selectedOnCanvas),
        focus: normalized,
        update: normalized,
        updateForeground: selectedToneOn(updateSurface),
        updateSurface: colorOf(updateSurface),
        terminalCursor: normalized,
      }
    }
    case 'messageAction': {
      const actionForeground = readableForeground(selectedOnCanvas)
      const towardOpposite = actionForeground === THEME_LIGHT_FOREGROUND || actionForeground === THEME_WHITE_FOREGROUND
        ? THEME_BLACK_FOREGROUND
        : THEME_WHITE_FOREGROUND
      const actionHover = mixRgb(selected, towardOpposite, 0.12)
      return {
        ...colors,
        messageAction: normalized,
        messageActionForeground: colorOf(actionForeground),
        messageActionHover: formatOklch(rgbToOklch(actionHover), parsedSelected.alpha),
      }
    }
    case 'messageSurface':
      return { ...colors, messageSurface: normalized, messageForeground: foregroundOn(selectedOnCanvas) }
    case 'codeBackground':
      return { ...colors, codeBackground: normalized, codeForeground: foregroundOn(selectedOnCanvas) }
    case 'sidebar':
      return { ...colors, sidebar: normalized, sidebarForeground: foregroundOn(selectedOnCanvas) }
    case 'sidebarRowSelected': {
      const sidebar = parseThemeRgb(colors.sidebar, canvas)
      const selectedOnSidebar = selectedOn(sidebar)
      return {
        ...colors,
        sidebarRowHover: colorOf(mixRgb(sidebar, selectedOnSidebar, 0.5)),
        sidebarRowActive: colorOf(mixRgb(sidebar, selectedOnSidebar, 0.8)),
        sidebarRowSelected: normalized,
      }
    }
    case 'terminalBackground': {
      const terminalForeground = readableForeground(selectedOnCanvas)
      return {
        ...colors,
        terminalBackground: normalized,
        terminalForeground: colorOf(terminalForeground),
        terminalSelection: colorOf(mixRgb(selectedOnCanvas, accent, terminalIsDark ? 0.35 : 0.18)),
        terminalScrollbar: colorOf(mixRgb(selectedOnCanvas, terminalForeground, terminalIsDark ? 0.42 : 0.22)),
        terminalScrollbarHover: colorOf(mixRgb(selectedOnCanvas, terminalForeground, terminalIsDark ? 0.55 : 0.32)),
      }
    }
    case 'error': {
      const status = statusColors()
      return { ...colors, error: normalized, errorForeground: status.foreground, errorSurface: status.surface }
    }
    case 'warning': {
      const status = statusColors()
      return { ...colors, warning: normalized, warningForeground: status.foreground, warningSurface: status.surface }
    }
    default:
      return { ...colors, [role]: normalized }
  }
}
