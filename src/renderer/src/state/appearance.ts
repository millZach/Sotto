import { useEffect, useState, useSyncExternalStore } from 'react'

import { ACCENTS, DEFAULT_SETTINGS, type Accent, type Appearance } from '../../../shared/settings'

/** What the main window actually paints: `system` is resolved before it reaches the root. */
export type ResolvedAppearance = 'light' | 'dark'

export interface AppearanceChoice {
  readonly appearance: Appearance
  readonly accent: Accent
}

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * The last applied look, kept in renderer storage so the next launch paints
 * the right field before settings arrive over IPC. Settings stay the source of
 * truth; this is only a first-frame hint and is overwritten on every apply.
 */
export const APPEARANCE_CACHE_KEY = 'sotto.appearance'

export function resolveAppearance(appearance: Appearance, systemDark: boolean): ResolvedAppearance {
  if (appearance === 'system') return systemDark ? 'dark' : 'light'
  return appearance
}

export function systemPrefersDark(target: Pick<Window, 'matchMedia'> | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  // Without a media query the window cannot know the system scheme; dark is
  // the Crossing default, so an unknown system never flips the room to light.
  if (target === undefined || typeof target.matchMedia !== 'function') return true
  return target.matchMedia(SYSTEM_DARK_QUERY).matches
}

/**
 * Put the resolved mode and accent on the main window root. A mode change
 * marks the root as switching for two frames so no colour transition animates
 * the repaint. Returns the mode that was applied.
 */
export function applyAppearance(
  choice: AppearanceChoice,
  root: HTMLElement = document.documentElement,
  systemDark: boolean = systemPrefersDark(),
): ResolvedAppearance {
  const resolved = resolveAppearance(choice.appearance, systemDark)
  const modeChanged = root.dataset.theme !== undefined && root.dataset.theme !== resolved
  if (modeChanged) suppressTransitions(root)
  root.dataset.theme = resolved
  root.dataset.accent = choice.accent
  writeCachedAppearance(choice)
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

function isAppearance(value: unknown): value is Appearance {
  return value === 'system' || value === 'light' || value === 'dark'
}

function isAccent(value: unknown): value is Accent {
  return typeof value === 'string' && (ACCENTS as readonly string[]).includes(value)
}

export function readCachedAppearance(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): AppearanceChoice {
  const fallback = { appearance: DEFAULT_SETTINGS.appearance, accent: DEFAULT_SETTINGS.accent }
  try {
    const raw = storage?.getItem(APPEARANCE_CACHE_KEY)
    if (raw === null || raw === undefined) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return fallback
    const { appearance, accent } = parsed as Record<string, unknown>
    return {
      appearance: isAppearance(appearance) ? appearance : fallback.appearance,
      accent: isAccent(accent) ? accent : fallback.accent,
    }
  } catch {
    return fallback
  }
}

function writeCachedAppearance(choice: AppearanceChoice, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ appearance: choice.appearance, accent: choice.accent }))
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

type PreviewFields = { appearance?: PendingChoice<Appearance>; accent?: PendingChoice<Accent> }

/**
 * The user's latest appearance edits while their saves are in flight.
 *
 * Each field remembers only its newest choice, so picking Light and then an
 * accent previews both together even though the accent save carries only the
 * accent, and an older response can never repaint an older choice. A failed
 * save removes its choice only if nothing newer replaced it, which leaves the
 * persisted value in force. A successful save keeps its choice until the
 * settings the window holds catch up with it (or are replaced by newer ones).
 */
export class AppearancePreview {
  private sequence = 0
  private fields: PreviewFields = {}
  private readonly listeners = new Set<() => void>()
  private version = 0

  choose(patch: Partial<AppearanceChoice>): number {
    const sequence = ++this.sequence
    const next: PreviewFields = { ...this.fields }
    if (patch.appearance !== undefined) next.appearance = { value: patch.appearance, sequence, savedAgainst: null }
    if (patch.accent !== undefined) next.accent = { value: patch.accent, sequence, savedAgainst: null }
    this.fields = next
    this.emit()
    return sequence
  }

  settle(sequence: number, saved: boolean, persisted: object): void {
    const next: PreviewFields = { ...this.fields }
    let changed = false
    for (const key of ['appearance', 'accent'] as const) {
      const pending = next[key]
      if (pending === undefined || pending.sequence !== sequence) continue
      changed = true
      if (saved) (next as Record<string, PendingChoice<unknown>>)[key] = { ...pending, savedAgainst: persisted }
      else delete next[key]
    }
    if (!changed) return
    this.fields = next
    this.emit()
  }

  /**
   * The choice to paint: pending edits over the persisted settings. Pass the
   * settings object itself; a saved edit is dropped once a different settings
   * object arrives, because that object already reflects the save or a later one.
   */
  effective(persisted: AppearanceChoice): AppearanceChoice {
    const next: PreviewFields = { ...this.fields }
    let pruned = false
    for (const key of ['appearance', 'accent'] as const) {
      const pending = next[key]
      if (pending?.savedAgainst === null || pending === undefined) continue
      if (pending.value === persisted[key] || pending.savedAgainst !== persisted) {
        delete next[key]
        pruned = true
      }
    }
    if (pruned) this.fields = next
    return {
      appearance: next.appearance?.value ?? persisted.appearance,
      accent: next.accent?.value ?? persisted.accent,
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): number => this.version

  reset(): void {
    this.fields = {}
    this.emit()
  }

  private emit(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

export const appearancePreview = new AppearancePreview()

/** Re-render when a pending appearance edit starts or settles. */
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
