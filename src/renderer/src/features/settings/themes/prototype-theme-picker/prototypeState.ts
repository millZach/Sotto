/*
 * PROTOTYPE, throwaway. The question: how should Settings → Appearance present themes, now that the
 * T3 Code card grid is going? Four structurally different variants on the real Appearance page,
 * switched from a floating bar (development builds only). A second toggle swaps today's six palettes
 * for a set of new, Sotto-original ones so the palettes can be judged too. Effort color keeps its look.
 * Nothing here is production code; the winner gets rewritten properly.
 */

import { useSyncExternalStore } from 'react'

import { createVividThemeColors } from '../../../../../../shared/themes/engine'
import { BUILT_IN_THEMES, getThemeColorsForMode, type ThemeAppearance, type ThemeColors, type ThemeDefinition } from '../../../../../../shared/themes/library'

export const PROTOTYPE_VARIANTS = [
  { key: 'current', name: 'Today (T3 cards)' },
  { key: 'spheres', name: 'Voice spheres' },
  { key: 'rooms', name: 'Day into night rooms' },
  { key: 'halves', name: 'Day and night columns' },
  { key: 'index', name: 'Index, try it on' },
] as const

export type PrototypeVariant = (typeof PROTOTYPE_VARIANTS)[number]['key']
export type PrototypePalettes = 'today' | 'new'

interface PrototypeState { readonly variant: PrototypeVariant; readonly palettes: PrototypePalettes }

const STORAGE_KEY = 'sotto.prototype.theme-picker'
const listeners = new Set<() => void>()

function load(): PrototypeState {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<PrototypeState> | null
    const variant = PROTOTYPE_VARIANTS.find(entry => entry.key === parsed?.variant)?.key ?? 'spheres'
    return { variant, palettes: parsed?.palettes === 'new' ? 'new' : 'today' }
  } catch {
    return { variant: 'spheres', palettes: 'today' }
  }
}

let state: PrototypeState = load()

export function setPrototypeState(patch: Partial<PrototypeState>): void {
  state = { ...state, ...patch }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  for (const listener of listeners) listener()
}

export function usePrototypeState(): PrototypeState {
  return useSyncExternalStore(listener => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, () => state)
}

export const PROTOTYPE_ENABLED = import.meta.env.DEV || import.meta.env.VITE_THEME_PROTOTYPE === '1'

// ---------------------------------------------------------------------------
// Palettes

/** One line of character per palette, for the variants that have room to say it. */
export const PALETTE_NOTES: Readonly<Record<string, string>> = {
  't3-code': 'Quiet slate with a cyan voice.',
  't3-chat': 'Blush paper and berry ink.',
  grove: 'Leaf green on soft grey.',
  ocean: 'Harbour blue, cool and clear.',
  ember: 'Copper and cream.',
  iris: 'Lavender evening.',
  'proto-vesper': 'Plum dusk with an apricot glow.',
  'proto-lichen': 'Moss grey and a chartreuse spark.',
  'proto-reel': 'Tape-deck amber on warm brown.',
  'proto-lacquer': 'Soot black and lacquer red.',
  'proto-graphite': 'Pencil grey and bone. No colour at all.',
}

/** The engine rotates the send button off the accent; these palettes keep one voice, so it wears the accent. */
function grown(appearance: ThemeAppearance, background: string, accent: string): ThemeColors {
  const colors = createVividThemeColors(appearance, background, accent)
  return { ...colors, messageAction: colors.accent, messageActionForeground: colors.accentForeground, messageActionHover: colors.accent, terminalCursor: colors.accent }
}

function seeded(id: string, label: string, light: [string, string], dark: [string, string]): ThemeDefinition {
  return {
    id,
    label,
    appearance: 'light',
    colors: grown('light', light[0], light[1]),
    variants: { dark: grown('dark', dark[0], dark[1]) },
  }
}

/** Sotto-original palettes, seeded [background, accent] for each half and grown by the editor's own engine. */
export const PROTOTYPE_NEW_PALETTES: readonly ThemeDefinition[] = [
  seeded('proto-vesper', 'Vesper', ['#f6f1ec', '#c0582f'], ['#1c1823', '#f0a066']),
  seeded('proto-lichen', 'Lichen', ['#f0f2ea', '#5b7a18'], ['#161b17', '#b8d65c']),
  seeded('proto-reel', 'Reel', ['#f6efe0', '#9a6508'], ['#1b1611', '#e9b04a']),
  seeded('proto-lacquer', 'Lacquer', ['#f8f0ed', '#b2302a'], ['#1b1514', '#e8574a']),
  seeded('proto-graphite', 'Graphite', ['#f3f1eb', '#2a2926'], ['#191919', '#e6e1d6']),
]

export function paletteSet(which: PrototypePalettes): readonly ThemeDefinition[] {
  return which === 'new' ? [BUILT_IN_THEMES[0]!, ...PROTOTYPE_NEW_PALETTES] : BUILT_IN_THEMES
}

export const isPrototypePalette = (theme: ThemeDefinition): boolean => theme.id.startsWith('proto-')

export function colorsFor(theme: ThemeDefinition, mode: ThemeAppearance): ThemeColors | null {
  return getThemeColorsForMode(theme, mode)
}

/** The palette a half is painted with, looked up among everything the prototype can show. */
export function findShown(id: string, customThemes: readonly ThemeDefinition[]): ThemeDefinition | null {
  return BUILT_IN_THEMES.find(theme => theme.id === id)
    ?? PROTOTYPE_NEW_PALETTES.find(theme => theme.id === id)
    ?? customThemes.find(theme => theme.id === id)
    ?? null
}
