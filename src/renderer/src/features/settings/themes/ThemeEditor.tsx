/*
 * The theme editor: a floating panel that paints its draft on the live window.
 *
 * Follows T3 Code's apps/web/src/components/settings/ThemeEditorHost.tsx and
 * ThemeEditorPanel.tsx at commit d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3
 * (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md): Simple
 * mode edits the background and accent and derives every other role, Advanced
 * edits colour families, a name matching a saved theme adds the other
 * appearance to it, and closing without saving puts the saved look back.
 * Inspect picks a colour from the window itself, a colour's label spotlights
 * everywhere it is used (themeInspector.ts), and the corner grip resizes.
 *
 * The panel is non-modal so the window can be browsed while it is open. It is
 * still a role="dialog", which the tools browser treats as covering its native
 * view, so a native page never paints over the editor.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, MousePointer2, Paintbrush, Plus, X } from 'lucide-react'

import type { AppSettings, SettingsPatch } from '../../../../../shared/settings'
import { toCanonicalThemeColor } from '../../../../../shared/themes/color'
import { createVividThemeColors, updateThemeColorFamily } from '../../../../../shared/themes/engine'
import {
  T3_CODE_THEME,
  THEME_COLOR_ROLES,
  findTheme,
  getThemeColorsForMode,
  getThemeModes,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from '../../../../../shared/themes/library'
import { Button } from '../../../components/Button'
import { appearancePreview, isTransientPaintMutation, useAppearancePreviewVersion } from '../../../state/appearance'
import { isEditorColor, ThemeColorField, themeRoleLabel } from './ThemeColorField'
import { closeThemeEditor, useThemeEditorSession, type ThemeEditorSession } from './themeEditorSession'
import { editorMergeTarget, editorSavePatch, ThemeLibraryWriter } from './themeLibrary'
import {
  clearThemeInspectorHighlights,
  clearThemeInspectorHover,
  highlightThemeRoleUsage,
  inspectThemeRoleAtElement,
  refreshThemeInspectorSpotlight,
  showThemeInspectorHover,
  type ThemeElementInspection,
} from './themeInspector'
import './themes.css'

const SIMPLE_ROLES: readonly ThemeColorRole[] = ['canvas', 'accent']

interface ColorFamily { readonly id: string; readonly label: string; readonly role: ThemeColorRole; readonly roles: readonly ThemeColorRole[] }

export const THEME_EDITOR_ROLE_GROUPS: ReadonlyArray<{ readonly id: string; readonly title: string; readonly families: readonly ColorFamily[] }> = [
  {
    id: 'foundation',
    title: 'Foundation',
    families: [
      { id: 'background', label: 'Background', role: 'canvas', roles: ['canvas', 'chrome', 'toolbar'] },
      { id: 'surface', label: 'Surface', role: 'surface', roles: ['surface'] },
      { id: 'raised-surface', label: 'Raised surface', role: 'surfaceRaised', roles: ['surfaceRaised'] },
      { id: 'overlay', label: 'Overlay', role: 'surfaceOverlay', roles: ['surfaceOverlay'] },
      { id: 'text', label: 'Text', role: 'text', roles: ['text', 'toolbarForeground', 'toolbarControlForeground'] },
      { id: 'muted-text', label: 'Muted text', role: 'mutedForeground', roles: ['textMuted', 'mutedForeground', 'placeholder', 'secondaryLabel', 'iconMuted', 'sidebarMutedForeground'] },
      { id: 'border', label: 'Border', role: 'border', roles: ['border', 'toolbarBorder', 'sidebarBorder'] },
      { id: 'input', label: 'Input', role: 'input', roles: ['input'] },
    ],
  },
  {
    id: 'brand-content',
    title: 'Brand & content',
    families: [
      { id: 'subtle-surface', label: 'Subtle surface', role: 'secondary', roles: ['secondary', 'secondaryForeground', 'muted', 'toolbarControl'] },
      { id: 'highlight-surface', label: 'Highlight surface', role: 'accentSurface', roles: ['accentSurface', 'accentSurfaceForeground', 'toolbarControlHover'] },
      { id: 'accent', label: 'Accent', role: 'accent', roles: ['accent', 'accentForeground', 'focus', 'update', 'updateForeground', 'updateSurface', 'terminalCursor'] },
      { id: 'action', label: 'Action', role: 'messageAction', roles: ['messageAction', 'messageActionForeground', 'messageActionHover'] },
      { id: 'message-surface', label: 'Message surface', role: 'messageSurface', roles: ['messageSurface', 'messageForeground'] },
      { id: 'code-surface', label: 'Code surface', role: 'codeBackground', roles: ['codeBackground', 'codeForeground'] },
    ],
  },
  {
    id: 'context',
    title: 'Context',
    families: [
      { id: 'sidebar-background', label: 'Sidebar background', role: 'sidebar', roles: ['sidebar', 'sidebarForeground'] },
      { id: 'sidebar-controls', label: 'Sidebar controls', role: 'sidebarControlSurface', roles: ['sidebarControlSurface'] },
      { id: 'sidebar-selection', label: 'Sidebar selection', role: 'sidebarRowSelected', roles: ['sidebarRowHover', 'sidebarRowActive', 'sidebarRowSelected'] },
      { id: 'terminal-background', label: 'Terminal background', role: 'terminalBackground', roles: ['terminalBackground', 'terminalForeground', 'terminalSelection', 'terminalScrollbar', 'terminalScrollbarHover'] },
    ],
  },
  {
    id: 'status',
    title: 'Status',
    families: [
      { id: 'error', label: 'Error', role: 'error', roles: ['error', 'errorForeground', 'errorSurface'] },
      { id: 'warning', label: 'Warning', role: 'warning', roles: ['warning', 'warningForeground', 'warningSurface'] },
    ],
  },
]

const FAMILY_BY_ROLE = new Map<ThemeColorRole, ColorFamily>()
for (const family of THEME_EDITOR_ROLE_GROUPS.flatMap(group => group.families)) {
  for (const role of family.roles) if (!FAMILY_BY_ROLE.has(role)) FAMILY_BY_ROLE.set(role, family)
}

/** The Advanced colour row that edits `role`. */
export function themeEditorColorFamily(role: ThemeColorRole): ColorFamily | null {
  return FAMILY_BY_ROLE.get(role) ?? null
}

/** The smallest the corner grip makes the panel. */
export const THEME_EDITOR_MIN_SIZE = { width: 280, height: 220 } as const
/** The gap the panel keeps from the window edge. */
const EDGE = 8

type ColorsByAppearance = Record<ThemeAppearance, ThemeColors>

/** A draft with no source starts as the standard T3 Code look for that appearance. */
function editorDefaults(appearance: ThemeAppearance): ThemeColors {
  return { ...getThemeColorsForMode(T3_CODE_THEME, appearance)! }
}

function managedColors(appearance: ThemeAppearance, colors: ThemeColors): ThemeColors {
  const defaults = editorDefaults(appearance)
  return createVividThemeColors(
    appearance,
    isEditorColor(colors.canvas) ? colors.canvas : defaults.canvas,
    isEditorColor(colors.accent) ? colors.accent : defaults.accent,
  )
}

/** What the window paints: typed-but-unfinished values keep the last good colour (see applyAppearance). */
function paintableColors(colors: ThemeColors): ThemeColors {
  return Object.fromEntries(THEME_COLOR_ROLES.map(role => [role, toCanonicalThemeColor(colors[role]) ?? colors[role]])) as Record<ThemeColorRole, string>
}

export interface ThemeEditorHostProps {
  readonly settings: AppSettings | null
  readonly onSave: (patch: SettingsPatch) => Promise<boolean>
  readonly getSettings: () => AppSettings
  readonly onNotice?: (message: string) => void
}

/** Mounted beside the page content so a draft outlives navigating away from Settings. */
export function ThemeEditorHost({ settings, onSave, getSettings, onNotice }: ThemeEditorHostProps): ReactNode {
  const session = useThemeEditorSession()
  useEffect(() => {
    // Without settings there is no library to save into; drop any session.
    if (settings === null) closeThemeEditor()
  }, [settings])
  if (session === null || settings === null) return null
  return <ThemeEditorPanel key={session.id} session={session} settings={settings} onSave={onSave} getSettings={getSettings} {...(onNotice ? { onNotice } : {})} />
}

function ThemeEditorPanel({ session, settings, onSave, getSettings, onNotice }: ThemeEditorHostProps & { readonly session: ThemeEditorSession; readonly settings: AppSettings }): ReactNode {
  useAppearancePreviewVersion()
  const library = appearancePreview.effective(settings)
  const editingTheme = session.editingThemeId === null ? null : library.customThemes.find(theme => theme.id === session.editingThemeId) ?? null
  const writer = useMemo(() => new ThemeLibraryWriter(onSave, getSettings), [onSave, getSettings])

  const [seeded] = useState(() => {
    const source = editingTheme ?? (session.seedThemeId === null ? null : findTheme(session.seedThemeId, library.customThemes))
    const colors: ColorsByAppearance = { light: editorDefaults('light'), dark: editorDefaults('dark') }
    if (source) {
      for (const mode of getThemeModes(source)) colors[mode] = { ...getThemeColorsForMode(source, mode)! }
    }
    return {
      colors,
      appearance: source && !getThemeColorsForMode(source, session.initialAppearance) ? source.appearance : session.initialAppearance,
      // Themes the guided editor made carry `managed`; anything else opens in
      // Advanced so regeneration cannot silently discard hand-tuned colours.
      advanced: source !== null && source.managed !== true,
      name: editingTheme?.label ?? session.seedName ?? '',
    }
  })
  const [name, setName] = useState(seeded.name)
  const [activeAppearance, setActiveAppearance] = useState<ThemeAppearance>(seeded.appearance)
  const [advanced, setAdvanced] = useState(seeded.advanced)
  const [colorsByAppearance, setColorsByAppearance] = useState<ColorsByAppearance>(seeded.colors)
  const [simpleDirty, setSimpleDirty] = useState<Record<ThemeAppearance, boolean>>({ light: false, dark: false })
  const [regenerateOnSimple, setRegenerateOnSimple] = useState(seeded.advanced)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [roleQuery, setRoleQuery] = useState('')
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  // Null keeps the stylesheet's size; a value is a corner-grip resize.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [selectedRole, setSelectedRole] = useState<ThemeColorRole | null>(null)
  const [usageCount, setUsageCount] = useState<number | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null)
  const resizeStart = useRef<{ pointerX: number; pointerY: number; left: number; top: number; width: number; height: number } | null>(null)
  const titleId = useId()
  const nameId = useId()
  const errorId = useId()

  const isEditing = session.editingThemeId !== null
  const mergeTarget = editorMergeTarget(library, name, editingTheme?.id ?? null)
  const takenAppearances = mergeTarget ? getThemeModes(mergeTarget) : []
  const editableAppearances = editingTheme ? getThemeModes(editingTheme) : null

  // The whole window wears the draft while the editor is open; the saved look
  // returns when it closes, whether by Save, Cancel or navigation.
  useEffect(() => {
    appearancePreview.setDraft({ appearance: activeAppearance, colors: paintableColors(colorsByAppearance[activeAppearance]) })
  }, [activeAppearance, colorsByAppearance])
  useEffect(() => () => appearancePreview.setDraft(null), [])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      queueMicrotask(() => {
        if (previous?.isConnected) previous.focus()
      })
    }
  }, [])

  // Typing a name whose theme already owns this appearance flips the draft to the free side.
  const mergeKey = `${mergeTarget?.id ?? ''}:${takenAppearances.join(',')}`
  useEffect(() => {
    if (isEditing || takenAppearances.length !== 1) return
    setActiveAppearance(current => (takenAppearances.includes(current) ? (takenAppearances[0] === 'light' ? 'dark' : 'light') : current))
  }, [isEditing, mergeKey])

  const lockReason = (appearance: ThemeAppearance): string | null => {
    if (editableAppearances && !editableAppearances.includes(appearance)) return `“${editingTheme?.label}” has no ${appearance} palette. Create a theme with the same name to add one.`
    if (!isEditing && takenAppearances.includes(appearance)) return `“${mergeTarget?.label}” already has a ${appearance} palette.`
    return null
  }

  const updateColor = (role: ThemeColorRole, value: string): void => {
    const guided = !advanced && SIMPLE_ROLES.includes(role) && isEditorColor(value)
    setColorsByAppearance(current => {
      const next = { ...current[activeAppearance], [role]: value }
      return {
        ...current,
        [activeAppearance]: advanced ? updateThemeColorFamily(activeAppearance, current[activeAppearance], role, value) : guided ? managedColors(activeAppearance, next) : next,
      }
    })
    if (guided) setSimpleDirty(current => ({ ...current, [activeAppearance]: true }))
    if (advanced) setRegenerateOnSimple(true)
  }

  const changeAdvanced = (checked: boolean): void => {
    setAdvanced(checked)
    // Simple mode has no row for a family colour, so its spotlight would point at nothing.
    if (!checked) setSelectedRole(current => (current !== null && !SIMPLE_ROLES.includes(current) ? null : current))
    if (checked || !regenerateOnSimple) return
    // Leaving Advanced regenerates every palette the theme will save, so what
    // shows after the switch is what gets saved.
    const appearances: ThemeAppearance[] = editingTheme && getThemeModes(editingTheme).length > 1 ? ['light', 'dark'] : [activeAppearance]
    setSimpleDirty(current => ({ ...current, ...Object.fromEntries(appearances.map(mode => [mode, true])) }))
    setColorsByAppearance(current => ({ ...current, ...Object.fromEntries(appearances.map(mode => [mode, managedColors(mode, current[mode])])) }))
    setRegenerateOnSimple(false)
  }

  const close = (): void => closeThemeEditor()

  const submit = async (): Promise<void> => {
    if (saving) return
    if (!name.trim()) {
      setError('Name your theme first.')
      return
    }
    setSaving(true)
    setError(null)
    // Only palettes touched in Simple mode are regenerated; the rest save as shown.
    const colors: ColorsByAppearance = advanced
      ? colorsByAppearance
      : {
          light: simpleDirty.light ? managedColors('light', colorsByAppearance.light) : colorsByAppearance.light,
          dark: simpleDirty.dark ? managedColors('dark', colorsByAppearance.dark) : colorsByAppearance.dark,
        }
    try {
      const result = await writer.run(state => editorSavePatch(state, { name, editingTheme: session.editingThemeId === null ? null : editingTheme ?? ({ id: session.editingThemeId } as ThemeDefinition), activeAppearance, colorsByAppearance: colors, advanced }))
      if (!result.saved) {
        setError('The theme could not be saved. Your saved themes are unchanged.')
        setSaving(false)
        return
      }
      onNotice?.(result.mergedAppearance
        ? `${result.theme.label} updated. Its ${result.mergedAppearance} palette was added.`
        : result.created ? `${result.theme.label} created. It’s now your ${activeAppearance} theme.` : `${result.theme.label} saved.`)
      close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : isEditing ? 'Could not save the theme.' : 'Could not create the theme.')
      setSaving(false)
    }
  }

  const palette = colorsByAppearance[activeAppearance]

  /** Selects the row that edits `role`, opening Advanced when only Advanced has that row. */
  const selectRole = useCallback((role: ThemeColorRole, reveal = false): void => {
    const visible = themeEditorColorFamily(role)?.role ?? role
    setSelectedRole(visible)
    if (!SIMPLE_ROLES.includes(visible)) {
      setAdvanced(true)
      setRoleQuery('')
    }
    if (reveal) requestAnimationFrame(() => panelRef.current?.querySelector(`[data-theme-color-role="${visible}"]`)?.scrollIntoView({ block: 'nearest' }))
  }, [])
  const toggleRole = useCallback((role: ThemeColorRole): void => setSelectedRole(current => (current === role ? null : role)), [])
  const clearInspector = useCallback((): void => {
    setSelectedRole(null)
    setUsageCount(null)
    setInspecting(false)
  }, [])
  const roleName = useCallback((role: ThemeColorRole): string => themeEditorColorFamily(role)?.label ?? themeRoleLabel(role), [])

  // Advanced spotlights a whole family; Simple spotlights every role its guided colour set.
  const highlightRoles = selectedRole === null
    ? []
    : advanced
      ? themeEditorColorFamily(selectedRole)?.roles ?? [selectedRole]
      : SIMPLE_ROLES.includes(selectedRole)
        ? THEME_COLOR_ROLES.filter(role => palette[role].trim().toLowerCase() === palette[selectedRole].trim().toLowerCase())
        : [selectedRole]
  const highlightKey = highlightRoles.join(',')

  useEffect(() => {
    clearThemeInspectorHighlights()
    if (selectedRole === null) {
      setUsageCount(null)
      return
    }
    // Picking needs the window unobscured, so the spotlight waits while Inspect is armed.
    if (inspecting) return
    const roles = highlightKey.split(',') as ThemeColorRole[]
    const refresh = (): void => setUsageCount(highlightThemeRoleUsage(roles))
    refresh()
    // A refresh reads every element's style twice, so page changes (a streaming
    // reply, a growing list) refresh it at most twice a second.
    const interval = 500
    let frame: number | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = performance.now()
    const run = (): void => {
      frame = null
      timer = null
      last = performance.now()
      refresh()
    }
    const observer = new MutationObserver(mutations => {
      // The spotlight redrawing itself, colour probes and the editor's own count are not page changes;
      // refreshing on them would wake another refresh every interval, forever.
      if (mutations.every(mutation => isTransientPaintMutation(mutation) || (mutation.target instanceof Element && mutation.target.closest('#theme-inspector-spotlight, [data-theme-editor-panel]')))) return
      if (frame !== null || timer !== null) return
      const wait = Math.max(0, interval - (performance.now() - last))
      if (wait === 0) frame = requestAnimationFrame(run)
      else timer = setTimeout(run, wait)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    let spotlightFrame: number | null = null
    const redraw = (): void => {
      spotlightFrame ??= requestAnimationFrame(() => {
        spotlightFrame = null
        refreshThemeInspectorSpotlight()
      })
    }
    window.addEventListener('resize', redraw)
    window.addEventListener('scroll', redraw, true)
    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      if (timer !== null) clearTimeout(timer)
      if (spotlightFrame !== null) cancelAnimationFrame(spotlightFrame)
      window.removeEventListener('resize', redraw)
      window.removeEventListener('scroll', redraw, true)
      clearThemeInspectorHighlights()
    }
  }, [inspecting, selectedRole, highlightKey])

  useEffect(() => {
    if (!inspecting) {
      clearThemeInspectorHover()
      return
    }
    let disarmAfterClick = false
    let hoverTarget: Element | null = null
    let hoverInspection: ThemeElementInspection | null = null
    let hoverTimer: ReturnType<typeof setTimeout> | null = null
    let hoverFrame: number | null = null
    const inEditor = (target: Element): boolean => target.closest('[data-theme-editor-panel]') !== null
    const clearHover = (): void => {
      if (hoverTimer !== null) clearTimeout(hoverTimer)
      hoverTimer = null
      hoverTarget = null
      hoverInspection = null
      clearThemeInspectorHover()
    }
    const show = (inspection: ThemeElementInspection): void => {
      hoverInspection = inspection
      showThemeInspectorHover(inspection, roleName(inspection.role))
    }
    const onPointerOver = (event: PointerEvent): void => {
      const target = event.target
      clearHover()
      if (!(target instanceof Element) || inEditor(target)) return
      hoverTarget = target
      // Probing every role costs a few dozen style passes, so wait for the pointer to settle.
      hoverTimer = setTimeout(() => {
        hoverTimer = null
        if (hoverTarget !== target || !target.isConnected) return
        const inspection = inspectThemeRoleAtElement(target)
        if (inspection) show(inspection)
      }, 140)
    }
    const onPointerOut = (event: PointerEvent): void => {
      if (event.relatedTarget === null) clearHover()
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Element) || inEditor(target)) return
      // The pick is the whole gesture: the page under the pointer is not pressed.
      event.preventDefault()
      event.stopPropagation()
      const inspection = hoverTarget === target && hoverInspection ? hoverInspection : inspectThemeRoleAtElement(target)
      if (!inspection) return
      clearHover()
      selectRole(inspection.role, true)
      disarmAfterClick = true
    }
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element) || inEditor(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      if (disarmAfterClick) setInspecting(false)
      disarmAfterClick = false
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      clearHover()
      clearInspector()
    }
    const onResize = (): void => {
      if (!hoverInspection) return
      hoverFrame ??= requestAnimationFrame(() => {
        hoverFrame = null
        if (hoverInspection) show(hoverInspection)
      })
    }
    document.addEventListener('pointerover', onPointerOver, true)
    document.addEventListener('pointerout', onPointerOut, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', clearHover, true)
    return () => {
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', clearHover, true)
      if (hoverTimer !== null) clearTimeout(hoverTimer)
      if (hoverFrame !== null) cancelAnimationFrame(hoverFrame)
      clearThemeInspectorHover()
    }
  }, [clearInspector, inspecting, roleName, selectRole])

  const clampPosition = (x: number, y: number): { x: number; y: number } => {
    const width = panelRef.current?.offsetWidth ?? 0
    return {
      x: Math.min(Math.max(x, EDGE), Math.max(EDGE, window.innerWidth - width - EDGE)),
      // The header stays reachable even when the panel is dragged far down.
      y: Math.min(Math.max(y, EDGE), Math.max(EDGE, window.innerHeight - 48)),
    }
  }
  useEffect(() => {
    const clamp = (): void => {
      const panel = panelRef.current
      setSize(current => current === null
        ? current
        : {
            width: Math.max(THEME_EDITOR_MIN_SIZE.width, Math.min(current.width, window.innerWidth - EDGE * 2)),
            height: Math.max(THEME_EDITOR_MIN_SIZE.height, Math.min(current.height, window.innerHeight - EDGE * 2)),
          })
      // A smaller window pulls the whole panel back into view when it fits, so the grip stays reachable.
      setPosition(current => {
        if (current === null) return current
        const width = Math.min(panel?.offsetWidth ?? 0, window.innerWidth - EDGE * 2)
        const height = Math.min(panel?.offsetHeight ?? 0, window.innerHeight - EDGE * 2)
        return {
          x: Math.min(Math.max(current.x, EDGE), Math.max(EDGE, window.innerWidth - width - EDGE)),
          y: Math.min(Math.max(current.y, EDGE), Math.max(EDGE, window.innerHeight - height - EDGE)),
        }
      })
    }
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])

  const dragHandlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest('button, input, a')) return
      const rect = panelRef.current?.getBoundingClientRect()
      if (!rect) return
      dragOffset.current = { dx: event.clientX - rect.x, dy: event.clientY - rect.y }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const offset = dragOffset.current
      if (offset) setPosition(clampPosition(event.clientX - offset.dx, event.clientY - offset.dy))
    },
    onPointerUp: () => { dragOffset.current = null },
    onPointerCancel: () => { dragOffset.current = null },
  }

  const resizeHandlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      const rect = panelRef.current?.getBoundingClientRect()
      if (!rect) return
      event.preventDefault()
      // The grip moves the bottom-right corner, so the top-left holds still:
      // the default bottom-right parking spot becomes an explicit position.
      if (position === null) setPosition(clampPosition(rect.x, rect.y))
      resizeStart.current = { pointerX: event.clientX, pointerY: event.clientY, left: rect.x, top: rect.y, width: rect.width, height: rect.height }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = resizeStart.current
      if (!start) return
      // Grow only into the room right of and below the panel, so the grip never leaves the window.
      const maxWidth = Math.max(THEME_EDITOR_MIN_SIZE.width, window.innerWidth - EDGE - start.left)
      const maxHeight = Math.max(THEME_EDITOR_MIN_SIZE.height, window.innerHeight - EDGE - start.top)
      setSize({
        width: Math.min(Math.max(start.width + event.clientX - start.pointerX, THEME_EDITOR_MIN_SIZE.width), maxWidth),
        height: Math.min(Math.max(start.height + event.clientY - start.pointerY, THEME_EDITOR_MIN_SIZE.height), maxHeight),
      })
    },
    onPointerUp: () => { resizeStart.current = null },
    onPointerCancel: () => { resizeStart.current = null },
  }

  const query = roleQuery.trim().toLowerCase()
  const groups = THEME_EDITOR_ROLE_GROUPS
    .map(group => ({ ...group, families: group.families.filter(family => !query || [family.label, ...family.roles.map(themeRoleLabel)].join(' ').toLowerCase().includes(query)) }))
    .filter(group => group.families.length > 0)
  const title = isEditing ? 'Edit theme' : 'Create theme'
  const status = inspecting
    ? 'Select an element · Esc to cancel'
    : selectedRole !== null
      ? `${advanced ? roleName(selectedRole) : themeRoleLabel(selectedRole)} · ${usageCount ?? 0} ${usageCount === 1 ? 'use' : 'uses'}`
      : advanced ? 'Colors by family' : 'Two colors, rest derived'

  return (
    <section
      ref={panelRef}
      className="theme-editor"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-theme-editor-panel=""
      data-covers-native-view=""
      data-minimized={minimized || undefined}
      data-inspecting={inspecting || undefined}
      style={{
        ...(position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : {}),
        ...(size ? { width: size.width } : {}),
        // A chosen height applies only expanded; minimized, the panel hugs its header.
        ...(size && !minimized ? { height: size.height, maxHeight: `calc(100vh - ${EDGE * 2}px)` } : {}),
      }}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        // Escape first puts a spotlight away, then closes.
        if (selectedRole !== null) clearInspector()
        else close()
      }}
    >
      <div className="theme-editor__header" {...dragHandlers}>
        <h2 id={titleId}>{title}</h2>
        {minimized ? null : <p aria-live="polite">{status}</p>}
        <Button
          variant={inspecting ? 'secondary' : 'ghost'}
          className="theme-editor__inspect"
          aria-pressed={inspecting}
          aria-label={inspecting ? 'Cancel inspecting app colors' : 'Inspect app colors'}
          title={inspecting ? 'Cancel and clear the selection' : 'Pick a color from the app'}
          onClick={() => {
            if (inspecting) clearInspector()
            else setInspecting(true)
          }}
        >
          <MousePointer2 size={14} aria-hidden="true" />
          {inspecting ? 'Cancel' : 'Inspect'}
        </Button>
        <Button variant="ghost" iconOnly aria-label={minimized ? 'Expand the theme editor' : 'Minimize the theme editor'} onClick={() => setMinimized(current => !current)}>
          {minimized ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
        </Button>
        <Button variant="ghost" iconOnly aria-label="Close the theme editor" onClick={close}><X size={15} aria-hidden="true" /></Button>
      </div>
      {minimized
        ? null
        : (
            <>
              <div className="theme-editor__body">
                <div className="theme-editor__row">
                  <label htmlFor={nameId}>Theme name</label>
                  <input
                    id={nameId}
                    className="tt-input"
                    autoFocus
                    maxLength={48}
                    placeholder={isEditing ? 'Theme name' : 'e.g. Aurora'}
                    value={name}
                    aria-invalid={error !== null || undefined}
                    aria-describedby={error === null ? undefined : errorId}
                    onChange={event => {
                      setName(event.currentTarget.value)
                      setError(null)
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') void submit()
                    }}
                  />
                </div>
                {error === null ? null : <p className="theme-editor__error" id={errorId} role="alert">{error}</p>}
                <div className="theme-editor__row">
                  <span id={`${titleId}-appearance`}>Appearance</span>
                  <div className="segmented-control theme-editor__appearance" role="radiogroup" aria-labelledby={`${titleId}-appearance`}>
                    {(['light', 'dark'] as const).map(appearance => {
                      const reason = lockReason(appearance)
                      return (
                        <button
                          key={appearance}
                          type="button"
                          role="radio"
                          aria-checked={activeAppearance === appearance}
                          aria-disabled={reason !== null || undefined}
                          title={reason ?? undefined}
                          tabIndex={activeAppearance === appearance ? 0 : -1}
                          onClick={() => {
                            if (reason === null) setActiveAppearance(appearance)
                          }}
                          onKeyDown={event => {
                            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
                            event.preventDefault()
                            const other = appearance === 'light' ? 'dark' : 'light'
                            if (lockReason(other) === null) {
                              setActiveAppearance(other)
                              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[other === 'light' ? 0 : 1]?.focus()
                            }
                          }}
                        >
                          {appearance === 'light' ? 'Light' : 'Dark'}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="theme-editor__colors-head">
                  <h3>Colors</h3>
                  {advanced ? <input className="tt-input" aria-label="Filter colors" placeholder="Filter colors" value={roleQuery} onChange={event => setRoleQuery(event.currentTarget.value)} /> : null}
                  <label className="theme-editor__advanced">
                    <span>Advanced</span>
                    <input type="checkbox" role="switch" aria-label="Use advanced theme colors" checked={advanced} onChange={event => changeAdvanced(event.currentTarget.checked)} />
                  </label>
                </div>
                {advanced
                  ? (
                      <div className="theme-editor__groups">
                        {groups.map(group => (
                          <section key={group.id} aria-label={group.title}>
                            <h4>{group.title}</h4>
                            {group.families.map(family => <ThemeColorField key={family.id} role={family.role} label={family.label} value={palette[family.role]} onChange={updateColor} selected={selectedRole === family.role} onSelect={selectRole} onToggleSelected={toggleRole} />)}
                          </section>
                        ))}
                        {groups.length === 0 ? <p className="theme-editor__empty">No matches.</p> : null}
                      </div>
                    )
                  : SIMPLE_ROLES.map(role => <ThemeColorField key={role} role={role} label={role === 'canvas' ? 'Background' : 'Accent'} value={palette[role]} onChange={updateColor} selected={selectedRole === role} onSelect={selectRole} onToggleSelected={toggleRole} />)}
              </div>
              <div className="theme-editor__footer">
                <Button variant="ghost" onClick={close}>Cancel</Button>
                <Button variant="primary" disabled={!name.trim() || saving} onClick={() => void submit()}>
                  {isEditing
                    ? mergeTarget ? `Merge into “${mergeTarget.label}”` : 'Save changes'
                    : mergeTarget
                      ? <><Plus size={15} aria-hidden="true" />{`Add ${activeAppearance} palette`}</>
                      : <><Paintbrush size={15} aria-hidden="true" />Create theme</>}
                </Button>
              </div>
              <div className="theme-editor__grip" aria-hidden="true" {...resizeHandlers}>
                <svg viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.2"><path d="M7 1 1 7M7 4.5 4.5 7" /></svg>
              </div>
            </>
          )}
    </section>
  )
}
