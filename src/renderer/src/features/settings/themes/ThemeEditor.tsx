/*
 * The theme editor: a floating panel that paints its draft on the live window.
 *
 * Follows T3 Code's apps/web/src/components/settings/ThemeEditorHost.tsx and
 * ThemeEditorPanel.tsx at commit d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3
 * (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md): Simple
 * mode edits the background and accent and derives every other role, Advanced
 * edits colour families, a name matching a saved theme adds the other
 * appearance to it, and closing without saving puts the saved look back.
 * Not ported: T3's element inspector and corner-grip resizing.
 *
 * The panel is non-modal so the window can be browsed while it is open. It is
 * still a role="dialog", which the tools browser treats as covering its native
 * view, so a native page never paints over the editor.
 */

import React, { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Paintbrush, Plus, X } from 'lucide-react'

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
import { appearancePreview, useAppearancePreviewVersion } from '../../../state/appearance'
import { isEditorColor, ThemeColorField, themeRoleLabel } from './ThemeColorField'
import { closeThemeEditor, useThemeEditorSession, type ThemeEditorSession } from './themeEditorSession'
import { editorMergeTarget, editorSavePatch, ThemeLibraryWriter } from './themeLibrary'
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
  const panelRef = useRef<HTMLElement>(null)
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null)
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

  const clampPosition = (x: number, y: number): { x: number; y: number } => {
    const width = panelRef.current?.offsetWidth ?? 0
    return {
      x: Math.min(Math.max(x, 8), Math.max(8, window.innerWidth - width - 8)),
      y: Math.min(Math.max(y, 8), Math.max(8, window.innerHeight - 48)),
    }
  }
  useEffect(() => {
    const clamp = (): void => setPosition(current => (current === null ? current : clampPosition(current.x, current.y)))
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

  const query = roleQuery.trim().toLowerCase()
  const groups = THEME_EDITOR_ROLE_GROUPS
    .map(group => ({ ...group, families: group.families.filter(family => !query || [family.label, ...family.roles.map(themeRoleLabel)].join(' ').toLowerCase().includes(query)) }))
    .filter(group => group.families.length > 0)
  const palette = colorsByAppearance[activeAppearance]
  const title = isEditing ? 'Edit theme' : 'Create theme'

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
      style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined}
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          close()
        }
      }}
    >
      <div className="theme-editor__header" {...dragHandlers}>
        <h2 id={titleId}>{title}</h2>
        {minimized ? null : <p>{advanced ? 'Colors by family' : 'Two colors, rest derived'}</p>}
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
                            {group.families.map(family => <ThemeColorField key={family.id} role={family.role} label={family.label} value={palette[family.role]} onChange={updateColor} />)}
                          </section>
                        ))}
                        {groups.length === 0 ? <p className="theme-editor__empty">No matches.</p> : null}
                      </div>
                    )
                  : SIMPLE_ROLES.map(role => <ThemeColorField key={role} role={role} label={role === 'canvas' ? 'Background' : 'Accent'} value={palette[role]} onChange={updateColor} />)}
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
            </>
          )}
    </section>
  )
}
