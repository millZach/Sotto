/*
 * PROTOTYPE, throwaway: candidate palettes, round three. Kept: Lacquer, Hush, Linen, Nocturne, Cobalt, Citrine.
 * New: three midnight dark halves for Sotto itself, and four exotic candidates to choose two from.
 * No renderer-only imports, so the capture spec can load it.
 */

import { formatOklch, parseThemeColor } from '../../../../../../shared/themes/color'
import { createVividThemeColors } from '../../../../../../shared/themes/engine'
import { T3_CODE_THEME, type ThemeAppearance, type ThemeColorRole, type ThemeColors, type ThemeDefinition } from '../../../../../../shared/themes/library'

/** One line of character per palette, for the variants that have room to say it. */
export const PALETTE_NOTES: Readonly<Record<string, string>> = {
  't3-code': 'Quiet slate with a cyan voice.',
  't3-chat': 'Blush paper and berry ink.',
  grove: 'Leaf green on soft grey.',
  ocean: 'Harbour blue, cool and clear.',
  ember: 'Copper and cream.',
  iris: 'Lavender evening.',
  'proto-sotto-midnight': 'Sotto, with a midnight room and a charcoal sidebar.',
  'proto-sotto-ink': 'Sotto, with an almost-black room and a graphite sidebar.',
  'proto-sotto-deep': 'Sotto, with a deep blue-black room and a slate sidebar.',
  'proto-lacquer': 'Soot black and lacquer red.',
  'proto-hush': 'Fog grey with a sage whisper.',
  'proto-linen': 'Unbleached linen and walnut.',
  'proto-nocturne': 'Ink blue, late and still.',
  'proto-cobalt': 'Ultramarine on paper and ink.',
  'proto-citrine': 'Signal yellow on carbon.',
  'proto-velvet': 'Oxblood velvet and old brass.',
  'proto-tropic': 'Jungle night and a flamingo.',
  'proto-synth': 'Violet dusk and a neon coral.',
  'proto-souk': 'Indigo cloth and saffron.',
}

export type PaletteMood = 'sotto' | 'quiet' | 'bold' | 'exotic'

/** What each candidate is for, so the prototype can label it. */
export const PALETTE_MOOD: Readonly<Record<string, PaletteMood>> = {
  'proto-sotto-midnight': 'sotto',
  'proto-sotto-ink': 'sotto',
  'proto-sotto-deep': 'sotto',
  'proto-lacquer': 'bold',
  'proto-hush': 'quiet',
  'proto-linen': 'quiet',
  'proto-nocturne': 'quiet',
  'proto-cobalt': 'bold',
  'proto-citrine': 'bold',
  'proto-velvet': 'exotic',
  'proto-tropic': 'exotic',
  'proto-synth': 'exotic',
  'proto-souk': 'exotic',
}

// ---------------------------------------------------------------------------
// Sotto's dark half, repainted: a near-black room for the thread, a lighter blackish-grey sidebar.

const oklch = (L: number, C: number, h: number): string => formatOklch({ L, C, h })

interface MidnightSeed {
  /** The thread's room. */
  readonly room: readonly [number, number, number]
  /** The sidebar, lighter than the room. */
  readonly sidebar: readonly [number, number, number]
}

function midnight(seed: MidnightSeed): ThemeColors {
  const [L, C, h] = seed.room
  const [sL, sC, sh] = seed.sidebar
  const room = oklch(L, C, h)
  const up = (by: number, chroma = C): string => oklch(L + by, chroma, h)
  const side = (by: number, chroma = sC): string => oklch(sL + by, chroma, sh)
  const base = T3_CODE_THEME.variants!.dark!
  return {
    ...base,
    canvas: room,
    chrome: room,
    toolbar: room,
    terminalBackground: room,
    toolbarBorder: up(0.17, 0.02),
    toolbarControl: up(0.04),
    toolbarControlHover: up(0.08),
    surface: up(0.03),
    surfaceRaised: up(0.07),
    surfaceOverlay: up(0.1),
    border: up(0.19, 0.02),
    input: up(0.26, 0.024),
    secondary: up(0.04),
    muted: up(0.04),
    codeBackground: up(0.04),
    messageSurface: up(0.09, C + 0.006),
    accentSurface: oklch(L + 0.2, 0.06, 230),
    updateSurface: oklch(L + 0.13, 0.05, 230),
    terminalSelection: oklch(L + 0.2, 0.06, 230),
    terminalScrollbar: up(0.2),
    terminalScrollbarHover: up(0.3),
    sidebar: side(0),
    sidebarControlSurface: side(0.06),
    sidebarRowHover: side(0.045),
    sidebarRowActive: oklch(sL + 0.085, 0.03, 262),
    sidebarRowSelected: oklch(sL + 0.12, 0.04, 262),
    sidebarBorder: side(0.12, 0.012),
  }
}

function sottoWith(id: string, label: string, dark: ThemeColors): ThemeDefinition {
  return { id, label, appearance: 'light', colors: T3_CODE_THEME.colors, variants: { dark } }
}

// ---------------------------------------------------------------------------
// Grown palettes: the engine grows every role from a canvas and an accent, then dials set how much colour
// the chrome (frame and panels) and the voice (bubble and selection) carry, and optionally in which hue.

const CHROME_ROLES = [
  'sidebar', 'surface', 'surfaceRaised', 'surfaceOverlay', 'border', 'input', 'secondary', 'muted', 'codeBackground',
  'toolbarBorder', 'toolbarControl', 'toolbarControlHover', 'sidebarControlSurface', 'sidebarRowHover', 'sidebarBorder',
  'terminalScrollbar', 'terminalScrollbarHover',
] as const satisfies readonly ThemeColorRole[]
const VOICE_ROLES = [
  'accentSurface', 'messageSurface', 'updateSurface', 'sidebarRowActive', 'sidebarRowSelected', 'terminalSelection',
] as const satisfies readonly ThemeColorRole[]

interface HalfSeed {
  readonly canvas: string
  readonly accent: string
  /** How much colour the chrome carries, as a share of what the engine gives it (0 is grey). */
  readonly chrome: number
  /** How much colour the accent surfaces carry. */
  readonly voice: number
  /** Exotic rooms: the chrome takes the canvas's own hue and this chroma instead of a tint of the accent. */
  readonly chromeHue?: number
  readonly chromeChroma?: number
  /** Exotic rooms: the bubble and selection in the room's hue rather than the accent's. */
  readonly voiceHue?: number
}

function retint(value: string, scale: number, hue?: number, chroma?: number): string {
  const parsed = parseThemeColor(value)
  if (parsed === null) return value
  return formatOklch({ L: parsed.color.L, C: chroma ?? parsed.color.C * scale, h: hue ?? parsed.color.h }, parsed.alpha)
}

function grown(appearance: ThemeAppearance, seed: HalfSeed): ThemeColors {
  const colors: Record<ThemeColorRole, string> = { ...createVividThemeColors(appearance, seed.canvas, seed.accent) }
  for (const role of CHROME_ROLES) colors[role] = retint(colors[role], seed.chrome, seed.chromeHue, seed.chromeChroma)
  for (const role of VOICE_ROLES) colors[role] = retint(colors[role], seed.voice, seed.voiceHue)
  // One voice: the send button wears the accent rather than the engine's rotated companion.
  colors.messageAction = colors.accent
  colors.messageActionForeground = colors.accentForeground
  colors.messageActionHover = colors.accent
  colors.terminalCursor = colors.accent
  return colors
}

function seeded(id: string, label: string, light: HalfSeed, dark: HalfSeed): ThemeDefinition {
  return { id, label, appearance: 'light', colors: grown('light', light), variants: { dark: grown('dark', dark) } }
}

export const PROTOTYPE_NEW_PALETTES: readonly ThemeDefinition[] = [
  // Sotto's own, three ways to be midnight. The light half is unchanged.
  sottoWith('proto-sotto-midnight', 'Sotto · Midnight', midnight({ room: [0.145, 0.018, 268], sidebar: [0.225, 0.006, 270] })),
  sottoWith('proto-sotto-ink', 'Sotto · Ink', midnight({ room: [0.115, 0.008, 265], sidebar: [0.235, 0.003, 265] })),
  sottoWith('proto-sotto-deep', 'Sotto · Deep', midnight({ room: [0.155, 0.03, 265], sidebar: [0.215, 0.012, 268] })),
  // Kept
  seeded('proto-lacquer', 'Lacquer',
    { canvas: '#f7f3f1', accent: '#b3302a', chrome: 0.3, voice: 0.55 },
    { canvas: '#161312', accent: '#e8574a', chrome: 0.35, voice: 0.5 }),
  seeded('proto-hush', 'Hush',
    { canvas: '#f3f3f0', accent: '#56695f', chrome: 0.6, voice: 0.8 },
    { canvas: '#191b1a', accent: '#9db4a8', chrome: 0.6, voice: 0.8 }),
  seeded('proto-linen', 'Linen',
    { canvas: '#f5f0e6', accent: '#76624a', chrome: 1, voice: 0.9 },
    { canvas: '#1d1a16', accent: '#cdb592', chrome: 0.9, voice: 0.9 }),
  seeded('proto-nocturne', 'Nocturne',
    { canvas: '#eef1f5', accent: '#3d5878', chrome: 0.8, voice: 0.8 },
    { canvas: '#11161f', accent: '#8ea7c6', chrome: 0.9, voice: 0.8 }),
  seeded('proto-cobalt', 'Cobalt',
    { canvas: '#f5f6fb', accent: '#2a45d8', chrome: 0.45, voice: 0.6 },
    { canvas: '#0e1020', accent: '#6f86ff', chrome: 0.8, voice: 0.85 }),
  seeded('proto-citrine', 'Citrine',
    { canvas: '#f7f6f0', accent: '#8a6f00', chrome: 0.25, voice: 0.6 },
    { canvas: '#121211', accent: '#f2d024', chrome: 0, voice: 0.3 }),
  // Exotic: the room itself is coloured, and the accent is its complement.
  seeded('proto-velvet', 'Velvet',
    { canvas: '#f7ebe8', accent: '#7d1d34', chrome: 1, voice: 0.8, chromeHue: 15, chromeChroma: 0.028, voiceHue: 10 },
    { canvas: '#1f0b12', accent: '#d9a94e', chrome: 1, voice: 0.6, chromeHue: 5, chromeChroma: 0.05, voiceHue: 5 }),
  seeded('proto-tropic', 'Tropic',
    { canvas: '#edf5ee', accent: '#c2185b', chrome: 1, voice: 0.55, chromeHue: 155, chromeChroma: 0.025 },
    { canvas: '#08190f', accent: '#ff7096', chrome: 1, voice: 0.45, chromeHue: 158, chromeChroma: 0.04, voiceHue: 160 }),
  seeded('proto-synth', 'Synth',
    { canvas: '#f4effb', accent: '#c23b22', chrome: 1, voice: 0.7, chromeHue: 300, chromeChroma: 0.03, voiceHue: 300 },
    { canvas: '#190f33', accent: '#ff7a5c', chrome: 1, voice: 0.8, chromeHue: 295, chromeChroma: 0.07, voiceHue: 295 }),
  seeded('proto-souk', 'Souk',
    { canvas: '#f6eddb', accent: '#2c3a94', chrome: 1, voice: 0.6, chromeHue: 80, chromeChroma: 0.035 },
    { canvas: '#0f1331', accent: '#f5a524', chrome: 1, voice: 0.7, chromeHue: 275, chromeChroma: 0.06, voiceHue: 275 }),
]
