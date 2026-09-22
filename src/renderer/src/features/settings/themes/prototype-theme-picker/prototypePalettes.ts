/* PROTOTYPE, throwaway: candidate palettes for round two (Lacquer kept, eight candidates). No renderer-only imports, so the capture spec can load it. */

import { formatOklch, parseThemeColor } from '../../../../../../shared/themes/color'
import { createVividThemeColors } from '../../../../../../shared/themes/engine'
import type { ThemeAppearance, ThemeColorRole, ThemeColors, ThemeDefinition } from '../../../../../../shared/themes/library'

/** One line of character per palette, for the variants that have room to say it. */
export const PALETTE_NOTES: Readonly<Record<string, string>> = {
  't3-code': 'Quiet slate with a cyan voice.',
  't3-chat': 'Blush paper and berry ink.',
  grove: 'Leaf green on soft grey.',
  ocean: 'Harbour blue, cool and clear.',
  ember: 'Copper and cream.',
  iris: 'Lavender evening.',
  'proto-lacquer': 'Soot black and lacquer red.',
  'proto-hush': 'Fog grey with a sage whisper.',
  'proto-linen': 'Unbleached linen and walnut.',
  'proto-nocturne': 'Ink blue, late and still.',
  'proto-clay': 'Unfired clay and dusty rose.',
  'proto-chorus': 'Orchid, loud and bright.',
  'proto-cobalt': 'Ultramarine on paper and ink.',
  'proto-citrine': 'Signal yellow on carbon.',
  'proto-jade': 'Jade, bright and cold.',
}

/** Round two asks for some quiet palettes and some bold ones; the prototype labels which is which. */
export const PALETTE_MOOD: Readonly<Record<string, 'quiet' | 'bold'>> = {
  'proto-lacquer': 'bold',
  'proto-hush': 'quiet',
  'proto-linen': 'quiet',
  'proto-nocturne': 'quiet',
  'proto-clay': 'quiet',
  'proto-chorus': 'bold',
  'proto-cobalt': 'bold',
  'proto-citrine': 'bold',
  'proto-jade': 'bold',
}

/** Chrome: the room's frame and panels. Voice: the surfaces that carry the accent (bubble, selection). */
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
  /** How much colour the chrome carries, as a share of what the engine would give it (0 is grey). */
  readonly chrome: number
  /** How much colour the accent surfaces carry. */
  readonly voice: number
}

function retint(value: string, scale: number): string {
  const parsed = parseThemeColor(value)
  if (parsed === null) return value
  return formatOklch({ ...parsed.color, C: parsed.color.C * scale }, parsed.alpha)
}

/** The engine grows every role from the two seeds; the chrome and voice dials then set how much colour each carries. */
function grown(appearance: ThemeAppearance, seed: HalfSeed): ThemeColors {
  const colors: Record<ThemeColorRole, string> = { ...createVividThemeColors(appearance, seed.canvas, seed.accent) }
  for (const role of CHROME_ROLES) colors[role] = retint(colors[role], seed.chrome)
  for (const role of VOICE_ROLES) colors[role] = retint(colors[role], seed.voice)
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

/** Lacquer, kept from round one, and eight candidates for the other four places: four quiet, four bold. */
export const PROTOTYPE_NEW_PALETTES: readonly ThemeDefinition[] = [
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
  seeded('proto-clay', 'Clay',
    { canvas: '#f5efec', accent: '#98635a', chrome: 0.8, voice: 0.8 },
    { canvas: '#1c1716', accent: '#d39c8e', chrome: 0.8, voice: 0.8 }),
  seeded('proto-chorus', 'Chorus',
    { canvas: '#faf7fa', accent: '#b01f9a', chrome: 0.3, voice: 0.4 },
    { canvas: '#161119', accent: '#ff5fd6', chrome: 0.5, voice: 0.55 }),
  seeded('proto-cobalt', 'Cobalt',
    { canvas: '#f5f6fb', accent: '#2a45d8', chrome: 0.45, voice: 0.6 },
    { canvas: '#0e1020', accent: '#6f86ff', chrome: 0.8, voice: 0.85 }),
  seeded('proto-citrine', 'Citrine',
    { canvas: '#f7f6f0', accent: '#8a6f00', chrome: 0.25, voice: 0.6 },
    { canvas: '#121211', accent: '#f2d024', chrome: 0, voice: 0.3 }),
  seeded('proto-jade', 'Jade',
    { canvas: '#f2f6f3', accent: '#0d8558', chrome: 0.4, voice: 0.55 },
    { canvas: '#0d1512', accent: '#3ddc97', chrome: 0.5, voice: 0.6 }),
]

