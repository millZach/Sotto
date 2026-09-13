/*
 * The theme library as the Appearance page edits it: which theme owns each
 * half, installing, updating and removing saved themes, and the editor's save
 * rules. Every mutation is a pure function from the current selection to a
 * settings patch, so a removal and the halves it moves off the removed theme
 * land in one atomic write.
 *
 * The rules follow T3 Code's ThemeSettings.tsx, ThemeImportDialog.tsx and
 * ThemeEditorPanel.tsx at commit d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3
 * (MIT, Copyright (c) 2026 T3 Tools Inc.). T3 keeps a base theme plus optional
 * halves; Sotto always stores both halves, so "use for both" writes two ids.
 */

import type { AppSettings, SettingsPatch } from '../../../../../shared/settings'
import {
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  MAX_CUSTOM_THEMES,
  T3_CODE_THEME,
  THEME_FILE_VERSION,
  canonicalizeTheme,
  findTheme,
  getThemeColorsForMode,
  getThemeModes,
  parseThemeFile,
  themeIdFromName,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
} from '../../../../../shared/themes/library'
import { appearancePreview, type AppearanceChoice } from '../../../state/appearance'

export type ThemeMode = ThemeAppearance | 'system'

export type LibraryState = Pick<AppearanceChoice, 'lightTheme' | 'darkTheme' | 'customThemes'>

export type LibraryPatch = Pick<SettingsPatch, 'lightTheme' | 'darkTheme' | 'customThemes'>

// ---------------------------------------------------------------------------
// Cards

export const THEME_PREVIEW_ROLES = ['sidebar', 'canvas', 'surface', 'accentSurface', 'accent', 'messageSurface', 'messageAction'] as const
export type ThemePreviewRole = (typeof THEME_PREVIEW_ROLES)[number]
export type ThemePreviewColors = Readonly<Record<ThemePreviewRole, string>>

export interface ThemeCardPreview {
  readonly mode: ThemeAppearance
  readonly colors: ThemePreviewColors
}

/**
 * T3 Code draws its standard card from these fixed swatches rather than from
 * the palette (T3's ThemePreviewCircles.tsx and packages/shared themePreview.ts).
 */
export const STANDARD_THEME_PREVIEW_COLORS: Readonly<Record<ThemeAppearance, ThemePreviewColors>> = {
  light: { sidebar: '#fafafa', surface: '#ffffff', accentSurface: '#f4f4f5', messageSurface: '#e4e4e7', canvas: '#fcfcfc', accent: '#f4f4f5', messageAction: '#4f46e5' },
  dark: { sidebar: '#0f0f10', surface: '#121212', accentSurface: '#27272a', messageSurface: '#27272a', canvas: '#0a0a0a', accent: '#1c1c1f', messageAction: '#8b9cff' },
}

export function themeCardPreviews(theme: ThemeDefinition): ThemeCardPreview[] {
  if (theme.id === T3_CODE_THEME.id) return (['light', 'dark'] as const).map(mode => ({ mode, colors: STANDARD_THEME_PREVIEW_COLORS[mode] }))
  return getThemeModes(theme).map(mode => {
    const colors = getThemeColorsForMode(theme, mode) ?? theme.colors
    return { mode, colors: Object.fromEntries(THEME_PREVIEW_ROLES.map(role => [role, colors[role]])) as unknown as ThemePreviewColors }
  })
}

export function previewColorsFor(id: string, mode: ThemeAppearance, customThemes: readonly ThemeDefinition[]): ThemePreviewColors {
  const theme = findTheme(id, customThemes) ?? findTheme(DEFAULT_THEME_ID, [])!
  const previews = themeCardPreviews(theme)
  return (previews.find(preview => preview.mode === mode) ?? previews[0]!).colors
}

/** The halves a theme owns right now, in light-then-dark order. */
export function activeModesFor(state: LibraryState, id: string): ThemeAppearance[] {
  const modes: ThemeAppearance[] = []
  if (state.lightTheme === id) modes.push('light')
  if (state.darkTheme === id) modes.push('dark')
  return modes
}

/** Saved themes grouped the way cards show them: one card per collection, one per loose theme. */
export function groupCustomThemes(customThemes: readonly ThemeDefinition[]): Array<readonly [string, ThemeDefinition[]]> {
  const groups = new Map<string, ThemeDefinition[]>()
  for (const theme of customThemes) {
    const key = theme.collection ? `collection:${theme.collection.id}` : `theme:${theme.id}`
    const group = groups.get(key)
    if (group) group.push(theme)
    else groups.set(key, [theme])
  }
  return [...groups.entries()]
}

/** "Catppuccin Latte" and "Catppuccin Mocha" show as "Latte" and "Mocha" inside their collection. */
export function collectionVariantLabels(themes: readonly ThemeDefinition[]): string[] {
  if (themes.length === 0) return []
  const words = themes.map(theme => theme.label.trim().split(/\s+/u))
  const firstWords = words[0]!
  const sharedWordCount = firstWords.findIndex((word, index) => words.some(labelWords => labelWords[index]?.toLocaleLowerCase() !== word.toLocaleLowerCase()))
  const prefixLength = sharedWordCount === -1 ? firstWords.length - 1 : sharedWordCount
  return themes.map((theme, index) => words[index]?.slice(Math.max(0, prefixLength)).join(' ').trim() || theme.label)
}

// ---------------------------------------------------------------------------
// Selection

export function assignHalfPatch(appearance: ThemeAppearance, id: string): LibraryPatch {
  return appearance === 'light' ? { lightTheme: id } : { darkTheme: id }
}

/** Clicking a card: a one-appearance theme takes only its own half; a full theme takes both. */
export function useThemePatch(theme: ThemeDefinition): LibraryPatch {
  const modes = getThemeModes(theme)
  if (modes.length === 1) return assignHalfPatch(modes[0]!, theme.id)
  return { lightTheme: theme.id, darkTheme: theme.id }
}

// ---------------------------------------------------------------------------
// Library changes

export class ThemeLibraryError extends Error {}

function libraryIds(state: LibraryState): Set<string> {
  return new Set(state.customThemes.map(theme => theme.id))
}

function checkCapacity(count: number): void {
  if (count > MAX_CUSTOM_THEMES) throw new ThemeLibraryError(`Sotto keeps up to ${MAX_CUSTOM_THEMES} saved themes. Remove one to add another.`)
}

export function installThemesPatch(state: LibraryState, themes: readonly ThemeDefinition[]): LibraryPatch {
  const taken = libraryIds(state)
  for (const theme of themes) {
    if (BUILT_IN_THEMES.some(builtIn => builtIn.id === theme.id)) throw new ThemeLibraryError(`The theme id "${theme.id}" is reserved.`)
    if (taken.has(theme.id)) throw new ThemeLibraryError(`A theme with the id "${theme.id}" is already installed.`)
    taken.add(theme.id)
  }
  checkCapacity(state.customThemes.length + themes.length)
  return { customThemes: [...state.customThemes, ...themes.map(canonicalizeTheme)] }
}

export function updateThemesPatch(state: LibraryState, themes: readonly ThemeDefinition[]): LibraryPatch {
  const byId = new Map(themes.map(theme => [theme.id, canonicalizeTheme(theme)]))
  for (const id of byId.keys()) {
    if (!state.customThemes.some(theme => theme.id === id)) throw new ThemeLibraryError('That theme is no longer installed.')
  }
  return { customThemes: state.customThemes.map(theme => byId.get(theme.id) ?? theme) }
}

/** Remove saved themes; a half they owned falls back to the default theme in the same write. */
export function removeThemesPatch(state: LibraryState, ids: readonly string[]): LibraryPatch {
  const removed = new Set(ids)
  return {
    customThemes: state.customThemes.filter(theme => !removed.has(theme.id)),
    ...(removed.has(state.lightTheme) ? { lightTheme: DEFAULT_THEME_ID } : {}),
    ...(removed.has(state.darkTheme) ? { darkTheme: DEFAULT_THEME_ID } : {}),
  }
}

/** Replace an installed collection (an Open VSX update): variants no longer shipped are removed. */
export function replaceCollectionPatch(state: LibraryState, collectionId: string, themes: readonly ThemeDefinition[]): LibraryPatch {
  const previousIds = state.customThemes.filter(theme => theme.collection?.id === collectionId).map(theme => theme.id)
  const incomingIds = new Set(themes.map(theme => theme.id))
  const kept = state.customThemes.filter(theme => theme.collection?.id !== collectionId)
  const keptIds = new Set(kept.map(theme => theme.id))
  for (const theme of themes) {
    if (keptIds.has(theme.id)) throw new ThemeLibraryError(`A theme with the id "${theme.id}" is already installed.`)
  }
  checkCapacity(kept.length + themes.length)
  const insertAt = state.customThemes.findIndex(theme => theme.collection?.id === collectionId)
  const customThemes = [...kept]
  customThemes.splice(insertAt < 0 ? kept.length : insertAt, 0, ...themes.map(canonicalizeTheme))
  const dropped = previousIds.filter(id => !incomingIds.has(id))
  return {
    customThemes,
    ...(dropped.includes(state.lightTheme) ? { lightTheme: DEFAULT_THEME_ID } : {}),
    ...(dropped.includes(state.darkTheme) ? { darkTheme: DEFAULT_THEME_ID } : {}),
  }
}

/** A copy of an installed theme under the file's own name when that differs, else "Name (1)". */
export function versionedCopy(theme: ThemeDefinition, state: LibraryState, preferredName?: string | null): ThemeDefinition {
  const taken = libraryIds(state)
  const build = (name: string): ThemeDefinition => parseThemeFile({
    version: THEME_FILE_VERSION,
    name: name.slice(0, 48).trim(),
    appearance: theme.appearance,
    colors: theme.colors,
    ...(theme.variants ? { variants: theme.variants } : {}),
    ...(theme.managed ? { managed: true } : {}),
  })
  if (preferredName && preferredName.toLowerCase() !== theme.label.toLowerCase()) {
    try {
      const candidate = build(preferredName)
      if (!taken.has(candidate.id)) return candidate
    } catch {
      // A reserved or unusable file name falls through to numbered copies.
    }
  }
  for (let copy = 1; copy < 100; copy += 1) {
    const suffix = ` (${copy})`
    try {
      const candidate = build(`${theme.label.slice(0, 48 - suffix.length)}${suffix}`)
      if (!taken.has(candidate.id)) return candidate
    } catch {
      continue
    }
  }
  throw new ThemeLibraryError(`Too many copies of "${theme.label}".`)
}

// ---------------------------------------------------------------------------
// Editor

export interface EditorSaveInput {
  readonly name: string
  readonly editingTheme: ThemeDefinition | null
  readonly activeAppearance: ThemeAppearance
  readonly colorsByAppearance: Readonly<Record<ThemeAppearance, ThemeColors>>
  readonly advanced: boolean
}

export interface EditorSaveResult {
  readonly patch: LibraryPatch
  readonly theme: ThemeDefinition
  readonly created: boolean
  readonly mergedAppearance: ThemeAppearance | null
}

/** A saved theme whose name the editor's name would combine with, if any. */
export function editorMergeTarget(state: LibraryState, name: string, editingId: string | null): ThemeDefinition | null {
  const normalized = name.trim().toLowerCase()
  if (normalized === '') return null
  const targetId = themeIdFromName(name)
  return state.customThemes.find(theme => theme.id !== editingId && (theme.id === targetId || theme.label.trim().toLowerCase() === normalized)) ?? null
}

/**
 * The editor's save, as T3 Code does it: a new name creates a theme and makes
 * it the active half; a name that matches a saved theme adds this palette as
 * that theme's other appearance; an edit keeps its id, and renaming it onto
 * another theme folds its palettes in and retires the old entry. A created or
 * merged theme becomes the active theme for the palettes it now carries.
 */
export function editorSavePatch(state: LibraryState, input: EditorSaveInput): EditorSaveResult {
  const name = input.name.trim()
  if (!name) throw new ThemeLibraryError('Name your theme first.')
  const { editingTheme, activeAppearance, colorsByAppearance, advanced } = input
  const live = editingTheme ? state.customThemes.find(theme => theme.id === editingTheme.id) ?? null : null
  // A built-in's name would put two cards with one name in the gallery; a theme that already has it may keep it.
  const builtIn = BUILT_IN_THEMES.find(theme => theme.label.toLowerCase() === name.toLowerCase())
  if (builtIn && live?.label.trim().toLowerCase() !== name.toLowerCase()) throw new ThemeLibraryError(`“${builtIn.label}” is a built-in theme. Pick another name.`)
  const mergeTarget = editorMergeTarget(state, name, live?.id ?? null)
  const managed = advanced ? {} : { managed: true }

  if (live && mergeTarget) {
    const editedModes = getThemeModes(live)
    const taken = getThemeModes(mergeTarget)
    const collision = editedModes.find(mode => taken.includes(mode))
    if (collision) throw new ThemeLibraryError(`“${mergeTarget.label}” already has a ${collision} palette. Pick another name.`)
    const merged = withCollection(parseThemeFile({
      version: THEME_FILE_VERSION,
      id: mergeTarget.id,
      name: mergeTarget.label,
      appearance: mergeTarget.appearance,
      colors: mergeTarget.colors,
      variants: { ...mergeTarget.variants, ...Object.fromEntries(editedModes.map(mode => [mode, colorsByAppearance[mode]])) },
      ...(mergeTarget.managed === true && !advanced ? { managed: true } : {}),
    }), mergeTarget)
    const customThemes = state.customThemes.filter(theme => theme.id !== live.id).map(theme => (theme.id === merged.id ? canonicalizeTheme(merged) : theme))
    return {
      patch: { customThemes, ...moveHalves(state, live.id, merged.id) },
      theme: merged,
      created: false,
      mergedAppearance: editedModes[0] ?? null,
    }
  }

  if (live) {
    const base = live.appearance
    const other: ThemeAppearance = base === 'light' ? 'dark' : 'light'
    const saved = withCollection(parseThemeFile({
      version: THEME_FILE_VERSION,
      id: live.id,
      name,
      appearance: base,
      colors: colorsByAppearance[base],
      ...(getThemeModes(live).length > 1 ? { variants: { [other]: colorsByAppearance[other] } } : {}),
      ...managed,
    }), live)
    return { patch: updateThemesPatch(state, [saved]), theme: saved, created: false, mergedAppearance: null }
  }

  if (editingTheme) throw new ThemeLibraryError('That theme was removed while you were editing it. Save it under a new name to keep your changes.')

  if (mergeTarget) {
    if (getThemeModes(mergeTarget).includes(activeAppearance)) {
      throw new ThemeLibraryError(`“${mergeTarget.label}” already has light and dark palettes. Pick another name.`)
    }
    const merged = withCollection(parseThemeFile({
      version: THEME_FILE_VERSION,
      id: mergeTarget.id,
      name: mergeTarget.label,
      appearance: mergeTarget.appearance,
      colors: mergeTarget.colors,
      variants: { ...mergeTarget.variants, [activeAppearance]: colorsByAppearance[activeAppearance] },
      ...(mergeTarget.managed === true && !advanced ? { managed: true } : {}),
    }), mergeTarget)
    return {
      patch: { ...updateThemesPatch(state, [merged]), lightTheme: merged.id, darkTheme: merged.id },
      theme: merged,
      created: false,
      mergedAppearance: activeAppearance,
    }
  }

  const created = parseThemeFile({ version: THEME_FILE_VERSION, name, appearance: activeAppearance, colors: colorsByAppearance[activeAppearance], ...managed })
  if (BUILT_IN_THEMES.some(theme => theme.id === created.id)) throw new ThemeLibraryError(`The theme id "${created.id}" is reserved. Pick another name.`)
  return {
    patch: { ...installThemesPatch(state, [created]), ...assignHalfPatch(activeAppearance, created.id) },
    theme: created,
    created: true,
    mergedAppearance: null,
  }
}

function withCollection(theme: ThemeDefinition, source: ThemeDefinition): ThemeDefinition {
  return source.collection ? { ...theme, collection: source.collection } : theme
}

function moveHalves(state: LibraryState, from: string, to: string): LibraryPatch {
  return {
    ...(state.lightTheme === from ? { lightTheme: to } : {}),
    ...(state.darkTheme === from ? { darkTheme: to } : {}),
  }
}

// ---------------------------------------------------------------------------
// Writes

export type SaveSettings = (patch: SettingsPatch) => Promise<boolean>

/**
 * Runs library writes one at a time. Each write computes its patch from the
 * look the window is painting right now (saved settings plus pending edits),
 * so two quick removals, or an import racing an editor save, cannot both start
 * from the same library and undo each other. The queue is shared by every
 * writer. The patch previews at once; a failed save leaves the saved library
 * in force. Resolves with the result of `compute`, or rejects with its error.
 */
let writeQueue: Promise<unknown> = Promise.resolve()

export class ThemeLibraryWriter {
  constructor(
    private readonly save: SaveSettings,
    private readonly getSettings: () => AppSettings,
  ) {}

  /** The library as the window paints it now, including edits still saving. */
  current(): AppearanceChoice {
    return appearancePreview.effective(this.getSettings())
  }

  run<T extends { readonly patch: SettingsPatch }>(compute: (state: AppearanceChoice) => T): Promise<T & { readonly saved: boolean }> {
    const next = writeQueue.then(async () => {
      const result = compute(appearancePreview.effective(this.getSettings()))
      const sequence = appearancePreview.choose(result.patch as Partial<AppearanceChoice>)
      const saved = await this.save(result.patch).catch(() => false)
      appearancePreview.settle(sequence, saved, this.getSettings())
      return { ...result, saved }
    })
    writeQueue = next.catch(() => undefined)
    return next
  }
}
