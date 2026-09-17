import { useSyncExternalStore } from 'react'

import type { ThemeAppearance } from '../../../../../shared/themes/library'

/**
 * The open theme editor, kept outside the settings page so a draft survives
 * navigation: the palette is painted on the live window, and judging it means
 * walking through threads and panels while the editor stays open. Themes are
 * referenced by id because saved definitions can change underneath a session.
 */
export interface ThemeEditorSessionInput {
  /** Set when editing a saved theme; null creates a new one. */
  readonly editingThemeId: string | null
  /** The theme a new theme starts from: the active one, or a duplicate target. */
  readonly seedThemeId: string | null
  /** Prefilled name, used by duplicate. */
  readonly seedName: string | null
  readonly initialAppearance: ThemeAppearance
}

export interface ThemeEditorSession extends ThemeEditorSessionInput {
  /** Distinguishes two sessions naming the same themes, so reopening reseeds the draft. */
  readonly id: number
}

let session: ThemeEditorSession | null = null
let nextId = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function openThemeEditor(input: ThemeEditorSessionInput): void {
  session = { ...input, id: ++nextId }
  emit()
}

export function closeThemeEditor(): void {
  if (session === null) return
  session = null
  emit()
}

function currentThemeEditorSession(): ThemeEditorSession | null {
  return session
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useThemeEditorSession(): ThemeEditorSession | null {
  return useSyncExternalStore(subscribe, currentThemeEditorSession, currentThemeEditorSession)
}
