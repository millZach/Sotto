/* PROTOTYPE, throwaway: what every variant is handed. See prototypeState.ts. */

import { useRef, type ReactNode } from 'react'

import type { AppSettings } from '../../../../../../shared/settings'
import type { ThemeAppearance, ThemeDefinition } from '../../../../../../shared/themes/library'
import { appearancePreview, type AppearanceChoice } from '../../../../state/appearance'
import type { LibraryPatch, ThemeMode } from '../themeLibrary'
import { isPrototypePalette, paletteSet, PROTOTYPE_NEW_PALETTES, type PrototypePalettes } from './prototypeState'

export interface PickerProps {
  readonly shown: AppearanceChoice
  readonly resolved: ThemeAppearance
  readonly systemDark: boolean
  readonly system: string
  readonly still: boolean
  /** The six palettes on show: today's built-ins or the new set. */
  readonly palettes: readonly ThemeDefinition[]
  /** The user's own created and imported themes. */
  readonly customs: readonly ThemeDefinition[]
  readonly onChooseMode: (mode: ThemeMode) => void
  /** Use a theme for both halves, or for one. */
  readonly use: (theme: ThemeDefinition, half?: ThemeAppearance) => void
  /** Paint the whole window with a theme without saving; null puts the saved look back. */
  readonly tryOn: (theme: ThemeDefinition | null, half?: ThemeAppearance) => void
  readonly onCreate: () => void
  readonly onAdd: () => void
  readonly effort: ReactNode
  readonly sliders: ReactNode
  readonly livePreview: ReactNode
  readonly status: ReactNode
}

function patchFor(shown: AppearanceChoice, theme: ThemeDefinition, half?: ThemeAppearance): LibraryPatch {
  const halves: LibraryPatch = half === undefined
    ? { lightTheme: theme.id, darkTheme: theme.id }
    : half === 'light' ? { lightTheme: theme.id } : { darkTheme: theme.id }
  if (!isPrototypePalette(theme)) return halves
  // A new palette only paints once it is in the library, so the prototype installs the whole set on first use.
  const missing = PROTOTYPE_NEW_PALETTES.filter(candidate => !shown.customThemes.some(existing => existing.id === candidate.id))
  return missing.length === 0 ? halves : { ...halves, customThemes: [...shown.customThemes, ...missing] }
}

export function usePickerLibrary(shown: AppearanceChoice, palettes: PrototypePalettes, settings: AppSettings, onSelect: (patch: LibraryPatch) => void): Pick<PickerProps, 'palettes' | 'customs' | 'use' | 'tryOn'> {
  const trying = useRef<number | null>(null)
  const release = (): void => {
    if (trying.current === null) return
    appearancePreview.settle(trying.current, false, settings)
    trying.current = null
  }
  return {
    palettes: paletteSet(palettes),
    customs: shown.customThemes.filter(theme => !isPrototypePalette(theme)),
    use: (theme, half) => {
      release()
      onSelect(patchFor(shown, theme, half))
    },
    tryOn: (theme, half) => {
      release()
      if (theme === null) return
      trying.current = appearancePreview.choose(patchFor(shown, theme, half))
    },
  }
}
