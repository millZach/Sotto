import { useEffect, useState, useSyncExternalStore } from 'react'

import { DEFAULT_SETTINGS, EFFORT_COLORS, type AppSettings, type Appearance, type EffortColor } from '../../../shared/settings'
import { APP_ICON_BRAND_ATTRIBUTE, wearsAppIcon } from '../../../shared/themeBranding'
import { OMARCHY_THEME_ID, guardOmarchyColors, omarchySuccessText, omarchyThemeSchema, type OmarchyTheme } from '../../../shared/themes/omarchy'
import { isCanonicalThemeColor } from '../../../shared/themes/color'
import { GLASS_BACKDROP_VARIABLES, GLASS_CONTRAST_FLOOR, GLASS_THEME_ID, GLASS_TINT_VARIABLES, glassTintDeclarations } from '../../../shared/themes/glass'
import {
  APPEARANCE_CONTRAST,
  DEFAULT_THEME_ID,
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
export type AppearanceChoice = Pick<AppSettings, 'appearance' | 'lightTheme' | 'darkTheme' | 'appearanceContrast' | 'effortColor'> & {
  readonly customThemes: readonly ThemeDefinition[]
  readonly omarchyTheme?: OmarchyTheme | null | undefined
  /** Whether this run has the Glass theme (ADR-0149); filled in from the window's bridge when unsaid. */
  readonly glass?: boolean | undefined
}

type ChoiceKey = keyof AppearanceChoice
const CHOICE_KEYS = ['appearance', 'lightTheme', 'darkTheme', 'appearanceContrast', 'effortColor', 'customThemes'] as const satisfies readonly ChoiceKey[]

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
const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)'

type GlassTarget = (Pick<Window, 'matchMedia'> & { readonly sotto?: Pick<NonNullable<Window['sotto']>, 'glassWindow'> | undefined }) | undefined
const currentWindow = (): GlassTarget => (typeof window === 'undefined' ? undefined : window)

/**
 * Whether this run has the Glass theme (ADR-0149). Main gives the window its Glass bridge only while the Owl feature
 * `glass-theme` is on, and the bridge is there before the first frame, so a saved Glass never paints Sotto first.
 * What the window offers asks useOwlFeature('glass-theme'), the same startup answer.
 */
export function glassThemeOffered(target: GlassTarget = currentWindow()): boolean {
  return target?.sotto?.glassWindow !== undefined
}

/**
 * What the window has asked main for, and what main has said. The room shows the desktop only once main says the
 * material is drawn; until then, and whenever Glass stops, the page is opaque, so the window never flashes black.
 */
const glassWindowSync: { confirmed: boolean; requested: boolean | null } = (() => {
  const bridge = currentWindow()?.sotto?.glassWindow
  return { confirmed: bridge?.seeThrough === true, requested: bridge === undefined ? null : bridge.seeThrough }
})()

// When the system takes the material away (Windows' Transparency effects turned off) or gives it back, main says so,
// and the room follows: its own backdrop first, the desktop again only once the material is back (ADR-0149).
currentWindow()?.sotto?.glassWindow?.onChanged(seeThrough => {
  glassWindowSync.confirmed = seeThrough && glassWindowSync.requested === true
  const root = typeof document === 'undefined' ? null : document.documentElement
  if (root?.dataset.glass === undefined) return
  root.dataset.glass = glassWindowSync.confirmed && glassWantsSeeThrough(currentWindow()) ? 'see-through' : 'in-app'
})

function systemReducesTransparency(target: GlassTarget): boolean {
  return target !== undefined && typeof target.matchMedia === 'function' && target.matchMedia(REDUCED_TRANSPARENCY_QUERY).matches
}

/** Glass shows the desktop where main can draw a material and the system has not asked for less transparency. */
function glassWantsSeeThrough(target: GlassTarget): boolean {
  const bridge = target?.sotto?.glassWindow
  return bridge !== undefined && bridge.material !== null && !systemReducesTransparency(target)
}

function requestSeeThrough(on: boolean, root: HTMLElement, target: GlassTarget): void {
  const bridge = target?.sotto?.glassWindow
  if (bridge === undefined || bridge.material === null) return
  // Leaving Glass, the room is already opaque: the material can go after it.
  if (!on) glassWindowSync.confirmed = false
  if (glassWindowSync.requested === on) return
  glassWindowSync.requested = on
  void bridge.setSeeThrough(on).then(result => {
    if (glassWindowSync.requested !== on) return
    glassWindowSync.confirmed = on && result
    // The backdrop gives way to the desktop only now that the material is under it.
    if (glassWindowSync.confirmed && root.dataset.glass === 'in-app' && glassWantsSeeThrough(target)) root.dataset.glass = 'see-through'
  }, () => {
    if (glassWindowSync.requested !== on) return
    glassWindowSync.requested = null
    glassWindowSync.confirmed = false
  })
}

/**
 * Paint or stop painting Glass's tints on the root, and keep the window's material in step: `see-through` once main
 * draws the material behind the room, `in-app` (Glass's own backdrop) until then and wherever it cannot.
 */
function applyGlass(root: HTMLElement, appearance: ThemeAppearance | null, target: GlassTarget): void {
  if (appearance === null) {
    delete root.dataset.glass
    for (const variable of [...Object.values(GLASS_TINT_VARIABLES), ...GLASS_BACKDROP_VARIABLES]) root.style.removeProperty(variable)
    requestSeeThrough(false, root, target)
    return
  }
  for (const [variable, value] of glassTintDeclarations(appearance)) root.style.setProperty(variable, value)
  const seeThrough = glassWantsSeeThrough(target)
  root.dataset.glass = seeThrough && glassWindowSync.confirmed ? 'see-through' : 'in-app'
  requestSeeThrough(seeThrough, root, target)
}

/**
 * The last applied look, kept in renderer storage so the next launch paints
 * the right palette before settings arrive over IPC. Settings stay the source
 * of truth; this is only a first-frame hint, validated like the settings file
 * and overwritten on every apply.
 */
export const APPEARANCE_CACHE_KEY = 'sotto.appearance'

export function resolveAppearance(appearance: Appearance, systemDark: boolean, choice?: AppearanceChoice): ResolvedAppearance {
  if (appearance === 'system') {
    const theme = choice?.omarchyTheme
    if (theme && (theme.appearance === 'dark' ? choice.darkTheme : choice.lightTheme) === OMARCHY_THEME_ID) return theme.appearance
    return systemDark ? 'dark' : 'light'
  }
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
 * contrast strength on the main window root. A mode or theme change
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
  const resolved = draft?.appearance ?? resolveAppearance(choice.appearance, systemDark, choice)
  const target = currentWindow()
  const { theme, colors } = resolveThemeFor({ ...choice, glass: choice.glass ?? glassThemeOffered(target) }, resolved)
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
  // Only the runtime palette needs the derived green repaired against its own surfaces.
  // Remove the override when leaving it, so stock and user themes retain their tokens.
  if (draft === null && theme.id === OMARCHY_THEME_ID) root.style.setProperty('--tt-success', omarchySuccessText(colors, resolved))
  else root.style.removeProperty('--tt-success')
  // An editor draft is a palette of solid roles, so the window is solid while one paints.
  const glassPaints = draft === null && theme.id === GLASS_THEME_ID
  applyGlass(root, glassPaints ? resolved : null, target)
  // Glass never softens its words below full strength: they must read over whatever desktop is behind (ADR-0149).
  const chosenContrast = clampStep(choice.appearanceContrast, APPEARANCE_CONTRAST)
  const contrast = glassPaints ? Math.max(chosenContrast, GLASS_CONTRAST_FLOOR) : chosenContrast
  root.style.setProperty('--theme-contrast-base', `${Math.min(contrast, 100)}%`)
  root.style.setProperty('--theme-contrast-boost', `${Math.max(contrast - 100, 0)}%`)
  root.style.setProperty('--theme-contrast-border-boost', `${Math.max(contrast - 100, 0) / 4}%`)
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
    const onLinux = typeof window !== 'undefined' && window.sotto?.platform === 'linux'
    const runtimeTheme = onLinux ? omarchyThemeSchema.nullable().safeParse(record.omarchyTheme) : null
    // This first-frame hint may have been saved by an older readability guard.
    // Repair it before applyAppearance derives status text, or use the fallback
    // below if it cannot read. Fresh settings remain the source of truth.
    const cachedTheme = runtimeTheme?.success ? runtimeTheme.data : null
    const omarchyTheme = cachedTheme ? { ...cachedTheme, colors: guardOmarchyColors(cachedTheme.colors, cachedTheme.appearance) } : null
    const glass = glassThemeOffered()
    const half = (id: string, mode: ThemeAppearance): string => onLinux && id === OMARCHY_THEME_ID ? id : resolveThemeHalfId(id, mode, customThemes, glass)
    const text = (value: unknown, otherwise: string): string => (typeof value === 'string' ? value : otherwise)
    const number = (value: unknown, otherwise: number): number => (typeof value === 'number' ? value : otherwise)
    return {
      appearance: record.appearance === 'system' || record.appearance === 'light' || record.appearance === 'dark' ? record.appearance : fallback.appearance,
      lightTheme: half(text(record.lightTheme, fallback.lightTheme), 'light'),
      darkTheme: half(text(record.darkTheme, fallback.darkTheme), 'dark'),
      appearanceContrast: clampStep(number(record.appearanceContrast, fallback.appearanceContrast), APPEARANCE_CONTRAST),
      effortColor: isEffortColor(record.effortColor) ? record.effortColor : fallback.effortColor,
      customThemes,
      ...(onLinux ? { omarchyTheme } : {}),
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
      effortColor: choice.effortColor,
      customThemes: selected,
      ...(choice.omarchyTheme === undefined ? {} : { omarchyTheme: choice.omarchyTheme }),
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
    const glass = persisted.glass ?? glassThemeOffered()
    // A half saved on Glass by an Owl run shows as Sotto where Glass is not offered; the saved choice stays whole.
    const shownHalf = (id: string): string => (!glass && id === GLASS_THEME_ID ? DEFAULT_THEME_ID : id)
    return {
      appearance: fields.appearance?.value ?? persisted.appearance,
      lightTheme: shownHalf(fields.lightTheme?.value ?? persisted.lightTheme),
      darkTheme: shownHalf(fields.darkTheme?.value ?? persisted.darkTheme),
      appearanceContrast: fields.appearanceContrast?.value ?? persisted.appearanceContrast,
      effortColor: fields.effortColor?.value ?? persisted.effortColor,
      customThemes,
      ...(persisted.omarchyTheme === undefined ? {} : { omarchyTheme: persisted.omarchyTheme }),
      glass,
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

/** Whether the half the window paints now is Glass, which holds Contrast at GLASS_CONTRAST_FLOOR or above. */
export function glassPaints(choice: AppearanceChoice, resolved: ThemeAppearance): boolean {
  return resolveThemeFor({ ...choice, glass: choice.glass ?? glassThemeOffered() }, resolved).theme.id === GLASS_THEME_ID
}

/**
 * A media query's answer, kept current. `unknown` is the answer where the window cannot ask. With `enabled` false
 * nothing is read or subscribed, and the answer is false: a part an Owl feature holds starts no listener.
 */
function useMediaQuery(query: string, unknown: boolean, enabled = true): boolean {
  const read = (): boolean => (typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? unknown : window.matchMedia(query).matches)
  const [matches, setMatches] = useState(() => enabled && read())
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const update = (): void => setMatches(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query, enabled])
  return enabled && matches
}

/**
 * Whether the system asks for less transparency, kept current, so a see-through Glass room turns solid and back at
 * once. Only Glass reads it: pass whether the run has Glass (`useOwlFeature('glass-theme')`), and without it nothing listens.
 */
export function useSystemReducesTransparency(glass: boolean): boolean {
  return useMediaQuery(REDUCED_TRANSPARENCY_QUERY, false, glass)
}

/** Whether the operating system currently prefers a dark scheme, updated live. Unknown is dark, the default mode. */
export function useSystemPrefersDark(): boolean {
  return useMediaQuery(SYSTEM_DARK_QUERY, true)
}
