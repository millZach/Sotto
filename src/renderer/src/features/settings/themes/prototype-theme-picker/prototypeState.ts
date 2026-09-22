/*
 * PROTOTYPE, throwaway. The question: how should Settings → Appearance present themes, now that the
 * T3 Code card grid is going? Four structurally different variants on the real Appearance page,
 * switched from a floating bar (development builds only). A second toggle swaps today's six palettes
 * for a set of new, Sotto-original ones so the palettes can be judged too. Effort color keeps its look.
 * Nothing here is production code; the winner gets rewritten properly.
 */

import { useSyncExternalStore } from 'react'

import { PROTOTYPE_NEW_PALETTES } from './prototypePalettes'
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
    const variant = PROTOTYPE_VARIANTS.find(entry => entry.key === parsed?.variant)?.key ?? 'halves'
    return { variant, palettes: parsed?.palettes === 'today' ? 'today' : 'new' }
  } catch {
    return { variant: 'halves', palettes: 'new' }
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

export { PALETTE_MOOD, PALETTE_NOTES, PROTOTYPE_NEW_PALETTES } from './prototypePalettes'

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
