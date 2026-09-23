import { useEffect, useState, useSyncExternalStore } from 'react'

import { DEFAULT_SETTINGS, EFFORT_COLORS, type AppSettings, type Appearance, type EffortColor } from '../../../shared/settings'
import { APP_ICON_BRAND_ATTRIBUTE, wearsAppIcon } from '../../../shared/themeBranding'
import { isCanonicalThemeColor } from '../../../shared/themes/color'
import {
  APPEARANCE_CONTRAST,
  GLASS_OPACITY,
  THEME_COLOR_ROLES,
  parseCustomThemes,
  resolveThemeFor,
  resolveThemeHalfId,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from '../../../shared/themes/library'

/** What the main window actually paints: `system` is resolved before it reaches the root. */
export type ResolvedAppearance = ThemeAppearance

/** Everything that decides the main window's look. */
export type AppearanceChoice = Pick<AppSettings, 'appearance' | 'lightTheme' | 'darkTheme' | 'appearanceContrast' | 'glassOpacity' | 'effortColor'> & {
  readonly customThemes: readonly ThemeDefinition[]
}

type ChoiceKey = keyof AppearanceChoice
const CHOICE_KEYS = ['appearance', 'lightTheme', 'darkTheme', 'appearanceContrast', 'glassOpacity', 'effortColor', 'customThemes'] as const satisfies readonly ChoiceKey[]

const isEffortColor = (value: unknown): value is EffortColor => typeof value === 'string' && (EFFORT_COLORS as readonly string[]).includes(value)

/** An unsaved palette from the theme editor, painted over the saved look until the editor closes. */
export interface ThemeDraft {
  readonly appearance: ThemeAppearance
  readonly colors: ThemeColors
}

/** The root's theme id while an editor draft is painted. */
export const THEME_PREVIEW_ID = '__preview'

/**
 * Marks work that reads theme colours without changing them: on the root while
 * the theme inspector swaps roles for sentinels and back, and on the hidden
 * elements colour readers add and remove. Page observers skip these, so two
 * readers never keep waking each other.
 */
export const THEME_TOKEN_PROBE_ATTRIBUTE = 'data-theme-token-probe'

/** True when a root mutation batch left the style attribute exactly as it was, as a probe does. */
export function rootStyleUnchanged(records: readonly MutationRecord[], root: Element): boolean {
  if (records.length === 0 || records.some(record => record.attributeName !== 'style')) return false
  if (!(root instanceof HTMLElement)) return false
  // Compare declarations, not text: writing through CSSOM reserializes an attribute that was set by hand.
  const before = root.ownerDocument.createElement('div')
  before.setAttribute('style', records[0]!.oldValue ?? '')
  return before.style.cssText === root.style.cssText
}

/** True when a childList record only added or removed probe elements and inspector overlays. */
export function isTransientPaintMutation(record: MutationRecord): boolean {
  const nodes = [...record.addedNodes, ...record.removedNodes]
  return record.type === 'childList' && nodes.length > 0 && nodes.every(node => node instanceof Element && (node.hasAttribute(THEME_TOKEN_PROBE_ATTRIBUTE) || node.id === 'theme-inspector-spotlight' || node.id === 'theme-inspector-hover'))
}

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * The last applied look, kept in renderer storage so the next launch paints
 * the right palette before settings arrive over IPC. Settings stay the source
 * of truth; this is only a first-frame hint, validated like the settings file
 * and overwritten on every apply.
 */
export const APPEARANCE_CACHE_KEY = 'sotto.appearance'

export function resolveAppearance(appearance: Appearance, systemDark: boolean): ResolvedAppearance {
  if (appearance === 'system') return systemDark ? 'dark' : 'light'
  return appearance
}

export function systemPrefersDark(target: Pick<Window, 'matchMedia'> | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  // Without a media query the window cannot know the system scheme; dark is
  // the default mode, so an unknown system never flips the room to light.
  if (target === undefined || typeof target.matchMedia !== 'function') return true
  return target.matchMedia(SYSTEM_DARK_QUERY).matches
}

/** The custom property a role paints through, e.g. `sidebarRowHover` → `--theme-sidebar-row-hover`. */
export function themeColorVariable(role: ThemeColorRole): string {
  return `--theme-${role.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`
}

function clampStep(value: number, bounds: { min: number; max: number; step: number; default: number }): number {
  if (!Number.isFinite(value)) return bounds.default
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value / bounds.step) * bounds.step))
}

/**
 * Put the resolved mode, the palette of the theme that owns it, and the
 * contrast and glass strengths on the main window root. A mode or theme change
 * marks the root as switching for two frames so no colour transition animates
 * the repaint. An editor draft, when given, paints instead of the saved theme
 * and is never cached. Returns the mode that was applied.
 */
export function applyAppearance(
  choice: AppearanceChoice,
  root: HTMLElement = document.documentElement,
  systemDark: boolean = systemPrefersDark(),
  draft: ThemeDraft | null = null,
): ResolvedAppearance {
  const resolved = draft?.appearance ?? resolveAppearance(choice.appearance, systemDark)
  const { theme, colors } = resolveThemeFor(choice, resolved)
  const themeId = draft === null ? theme.id : THEME_PREVIEW_ID
  const changed = root.dataset.theme !== undefined && (root.dataset.theme !== resolved || root.dataset.themeId !== themeId)
  if (changed && draft === null) suppressTransitions(root)
  root.dataset.theme = resolved
  root.dataset.themeId = themeId
  // On the default theme the mark is the app icon itself (ADR-0024); an editor draft is never the default.
  if (wearsAppIcon(themeId)) root.dataset.brand = APP_ICON_BRAND_ATTRIBUTE
  else delete root.dataset.brand
  const painted = draft?.colors ?? colors
  for (const role of THEME_COLOR_ROLES) {
    // Only canonical OKLCH text reaches the style: a half-typed draft value
    // keeps the last good colour instead of blanking the role.
    const value = painted[role]
    if (isCanonicalThemeColor(value)) root.style.setProperty(themeColorVariable(role), value)
  }
  const contrast = clampStep(choice.appearanceContrast, APPEARANCE_CONTRAST)
  root.style.setProperty('--theme-contrast-base', `${Math.min(contrast, 100)}%`)
  root.style.setProperty('--theme-contrast-boost', `${Math.max(contrast - 100, 0)}%`)
  root.style.setProperty('--theme-contrast-border-boost', `${Math.max(contrast - 100, 0) / 4}%`)
  root.style.setProperty('--theme-glass-opacity', `${clampStep(choice.glassOpacity, GLASS_OPACITY)}%`)
  // The effort colourway is an attribute, not a role: tokens.css keys its palette blocks on it (ADR-0019).
  root.dataset.effortColor = isEffortColor(choice.effortColor) ? choice.effortColor : DEFAULT_SETTINGS.effortColor
  if (draft === null) writeCachedAppearance(choice)
  return resolved
}

function suppressTransitions(root: HTMLElement): void {
  root.dataset.themeSwitching = ''
  const release = (): void => { delete root.dataset.themeSwitching }
  if (typeof requestAnimationFrame !== 'function') {
    release()
    return
  }
  requestAnimationFrame(() => requestAnimationFrame(release))
}

function defaultChoice(): AppearanceChoice {
  return {
    appearance: DEFAULT_SETTINGS.appearance,
    lightTheme: DEFAULT_SETTINGS.lightTheme,
    darkTheme: DEFAULT_SETTINGS.darkTheme,
    appearanceContrast: DEFAULT_SETTINGS.appearanceContrast,
    glassOpacity: DEFAULT_SETTINGS.glassOpacity,
    effortColor: DEFAULT_SETTINGS.effortColor,
    customThemes: [],
  }
}

export function readCachedAppearance(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): AppearanceChoice {
  const fallback = defaultChoice()
  try {
    const raw = storage?.getItem(APPEARANCE_CACHE_KEY)
    if (raw === null || raw === undefined || raw.length > 64_000) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return fallback
    const record = parsed as Record<string, unknown>
    const customThemes = parseCustomThemes(record.customThemes)
    const text = (value: unknown, otherwise: string): string => (typeof value === 'string' ? value : otherwise)
    const number = (value: unknown, otherwise: number): number => (typeof value === 'number' ? value : otherwise)
    return {
      appearance: record.appearance === 'system' || record.appearance === 'light' || record.appearance === 'dark' ? record.appearance : fallback.appearance,
      lightTheme: resolveThemeHalfId(text(record.lightTheme, fallback.lightTheme), 'light', customThemes),
      darkTheme: resolveThemeHalfId(text(record.darkTheme, fallback.darkTheme), 'dark', customThemes),
      appearanceContrast: clampStep(number(record.appearanceContrast, fallback.appearanceContrast), APPEARANCE_CONTRAST),
      glassOpacity: clampStep(number(record.glassOpacity, fallback.glassOpacity), GLASS_OPACITY),
      effortColor: isEffortColor(record.effortColor) ? record.effortColor : fallback.effortColor,
      customThemes,
    }
  } catch {
    return fallback
  }
}

function writeCachedAppearance(choice: AppearanceChoice, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  // Only the themes that own a half travel to the cache; the whole library stays in settings.
  const selected = [choice.lightTheme, choice.darkTheme]
    .map(id => choice.customThemes.find(theme => theme.id === id))
    .filter((theme, index, list): theme is ThemeDefinition => theme !== undefined && list.indexOf(theme) === index)
  try {
    storage?.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({
      appearance: choice.appearance,
      lightTheme: choice.lightTheme,
      darkTheme: choice.darkTheme,
      appearanceContrast: choice.appearanceContrast,
      glassOpacity: choice.glassOpacity,
      effortColor: choice.effortColor,
      customThemes: selected,
    }))
  } catch {
    // Storage can be unavailable; the settings file still carries the choice.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

interface PendingChoice<T> {
  readonly value: T
  readonly sequence: number
  /** The persisted settings object seen when this choice's save succeeded. */
  readonly savedAgainst: object | null
}

type PreviewFields = { [Key in ChoiceKey]?: PendingChoice<AppearanceChoice[Key]> }

/**
 * The user's latest appearance edits while their saves are in flight, and the
 * theme editor's unsaved draft.
 *
 * Each field remembers only its newest choice, so picking Light and then a
 * dark theme previews both together even though each save carries one field,
 * and an older response can never repaint an older choice. A failed save
 * removes its choice only if nothing newer replaced it, which leaves the
 * persisted value in force. A successful save keeps its choice until the
 * settings the window holds catch up with it (or are replaced by newer ones).
 */
export class AppearancePreview {
  private sequence = 0
  private fields: PreviewFields = {}
  private currentDraft: ThemeDraft | null = null
  private readonly listeners = new Set<() => void>()
  private version = 0

  choose(patch: Partial<AppearanceChoice>): number {
    const sequence = ++this.sequence
    const next: Record<string, PendingChoice<unknown>> = { ...this.fields }
    for (const key of CHOICE_KEYS) {
      if (patch[key] !== undefined) next[key] = { value: patch[key], sequence, savedAgainst: null }
    }
    this.fields = next as PreviewFields
    this.emit()
    return sequence
  }

  settle(sequence: number, saved: boolean, persisted: object): void {
    const next: Record<string, PendingChoice<unknown>> = { ...this.fields }
    let changed = false
    for (const key of CHOICE_KEYS) {
      const pending = next[key]
      if (pending === undefined || pending.sequence !== sequence) continue
      changed = true
      if (saved) next[key] = { ...pending, savedAgainst: persisted }
      else delete next[key]
    }
    if (!changed) return
    this.fields = next as PreviewFields
    this.emit()
  }

  /**
   * The choice to paint: pending edits over the persisted settings. Pass the
   * settings object itself; a saved edit is dropped once a different settings
   * object arrives, because that object already reflects the save or a later one.
   */
  effective(persisted: AppearanceChoice): AppearanceChoice {
    const next: Record<string, PendingChoice<unknown>> = { ...this.fields }
    let pruned = false
    for (const key of CHOICE_KEYS) {
      const pending = next[key]
      if (pending === undefined || pending.savedAgainst === null) continue
      if (pending.value === persisted[key] || pending.savedAgainst !== persisted) {
        delete next[key]
        pruned = true
      }
    }
    if (pruned) this.fields = next as PreviewFields
    const fields = next as PreviewFields
    const customThemes = fields.customThemes?.value ?? persisted.customThemes
    return {
      appearance: fields.appearance?.value ?? persisted.appearance,
      lightTheme: fields.lightTheme?.value ?? persisted.lightTheme,
      darkTheme: fields.darkTheme?.value ?? persisted.darkTheme,
      appearanceContrast: fields.appearanceContrast?.value ?? persisted.appearanceContrast,
      glassOpacity: fields.glassOpacity?.value ?? persisted.glassOpacity,
      effortColor: fields.effortColor?.value ?? persisted.effortColor,
      customThemes,
    }
  }

  get draft(): ThemeDraft | null {
    return this.currentDraft
  }

  /** Paint (or, with null, stop painting) the editor's unsaved palette. */
  setDraft(draft: ThemeDraft | null): void {
    if (draft === this.currentDraft) return
    this.currentDraft = draft
    this.emit()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): number => this.version

  reset(): void {
    this.fields = {}
    this.currentDraft = null
    this.emit()
  }

  private emit(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

export const appearancePreview = new AppearancePreview()

/** Re-render when a pending appearance edit or editor draft starts or settles. */
export function useAppearancePreviewVersion(preview: AppearancePreview = appearancePreview): number {
  return useSyncExternalStore(preview.subscribe, preview.snapshot, preview.snapshot)
}

/** Whether the operating system currently prefers a dark scheme, updated live. */
export function useSystemPrefersDark(): boolean {
  const [dark, setDark] = useState(() => systemPrefersDark())
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(SYSTEM_DARK_QUERY)
    const update = (): void => setDark(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return dark
}
