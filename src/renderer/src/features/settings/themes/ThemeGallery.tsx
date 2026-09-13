/*
 * The Themes part of Settings → Appearance: the colour-scheme tiles, the theme
 * cards with their light and dark circles, and removal.
 *
 * Follows T3 Code's apps/web/src/components/settings/ThemeSettings.tsx at
 * commit d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3 (MIT, Copyright (c) 2026
 * T3 Tools Inc.). Differences: T3's environment-published themes do not exist
 * in Sotto (ADR-0011), and a collection card switches variants with a row of
 * named chips instead of T3's radial fan-out.
 */

import React, { useId, useState, type ReactNode } from 'react'
import { Copy, Download, Paintbrush, PenLine, Plus, Trash2 } from 'lucide-react'

import {
  BUILT_IN_THEMES,
  getThemeModes,
  serializeThemeFile,
  type ThemeAppearance,
  type ThemeDefinition,
} from '../../../../../shared/themes/library'
import { Button } from '../../../components/Button'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import type { AppearanceChoice } from '../../../state/appearance'
import { openThemeEditor } from './themeEditorSession'
import {
  activeModesFor,
  assignHalfPatch,
  collectionVariantLabels,
  groupCustomThemes,
  previewColorsFor,
  themeCardPreviews,
  useThemePatch,
  type LibraryPatch,
  type ThemeMode,
} from './themeLibrary'
import { MODE_LABELS, ThemePreviewCircle, ThemePreviewCircles, ThemeWireframe } from './ThemePreview'

export interface ThemeGalleryProps {
  readonly shown: AppearanceChoice
  readonly resolved: ThemeAppearance
  readonly onChooseMode: (mode: ThemeMode) => void
  readonly onSelect: (patch: LibraryPatch) => void
  readonly onRemove: (ids: readonly string[]) => Promise<boolean>
  readonly onExport: (theme: ThemeDefinition) => void
  readonly onAddTheme: () => void
}

export function ThemeGallery({ shown, resolved, onChooseMode, onSelect, onRemove, onExport, onAddTheme }: ThemeGalleryProps): ReactNode {
  const [removal, setRemoval] = useState<{ theme: ThemeDefinition; collection: ThemeDefinition[] } | null>(null)
  const [removeIds, setRemoveIds] = useState<string[]>([])
  const headingId = useId()
  const schemeId = useId()

  const openEditor = (input: { editingThemeId?: string; seedThemeId: string | null; seedName?: string }): void => openThemeEditor({
    editingThemeId: input.editingThemeId ?? null,
    seedThemeId: input.seedThemeId,
    seedName: input.seedName ?? null,
    initialAppearance: resolved,
  })

  const duplicate = (theme: ThemeDefinition): void => openEditor({ seedThemeId: theme.id, seedName: `${theme.label} copy`.slice(0, 48) })
  const assign = (id: string) => (mode: ThemeAppearance): void => onSelect(assignHalfPatch(mode, id))

  const wireframe = (mode: ThemeMode): ReactNode => {
    const colors = (appearance: ThemeAppearance) => previewColorsFor(appearance === 'light' ? shown.lightTheme : shown.darkTheme, appearance, shown.customThemes)
    return (
      <ThemeWireframe panes={mode === 'system'
        ? [{ clip: 'left', colors: colors('light') }, { clip: 'right', colors: colors('dark') }]
        : [{ colors: colors(mode) }]}
      />
    )
  }

  return (
    <>
      <h3 className="theme-settings__subheading" id={schemeId}>Color scheme</h3>
      <div className="theme-mode-tiles" role="group" aria-labelledby={schemeId}>
        {(['system', 'light', 'dark'] as const).map(mode => (
          <button
            key={mode}
            type="button"
            className="theme-mode-tile tt-focusable"
            aria-label={mode === 'system' ? 'Follow the system appearance' : `Use ${mode} mode`}
            aria-pressed={shown.appearance === mode}
            onClick={() => onChooseMode(mode)}
          >
            {wireframe(mode)}
            <span className="theme-mode-tile__label">{MODE_LABELS[mode]}</span>
          </button>
        ))}
      </div>

      <div className="theme-settings__bar">
        <h3 className="theme-settings__subheading" id={headingId}>Themes</h3>
        <div className="theme-settings__actions">
          <Button variant="secondary" onClick={() => openEditor({ seedThemeId: resolved === 'light' ? shown.lightTheme : shown.darkTheme })}>
            <Paintbrush size={15} aria-hidden="true" />Create theme
          </Button>
          <Button variant="secondary" onClick={onAddTheme}>
            <Plus size={15} aria-hidden="true" />Add theme
          </Button>
        </div>
      </div>

      <div className="theme-grid" role="list" aria-labelledby={headingId}>
        {BUILT_IN_THEMES.map(theme => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            activeModes={activeModesFor(shown, theme.id)}
            onUse={() => onSelect(useThemePatch(theme))}
            onUseMode={assign(theme.id)}
            onDuplicate={() => duplicate(theme)}
          />
        ))}
        {groupCustomThemes(shown.customThemes).map(([key, themes]) => (
          <CollectionCard
            key={key}
            themes={themes}
            state={shown}
            onSelect={onSelect}
            onDuplicate={duplicate}
            onEdit={theme => openEditor({ editingThemeId: theme.id, seedThemeId: null })}
            onExport={onExport}
            onRemove={theme => {
              setRemoval({ theme, collection: themes })
              setRemoveIds(themes.length > 1 ? [] : [theme.id])
            }}
          />
        ))}
      </div>

      {removal === null
        ? null
        : (
            <ConfirmationDialog
              title={removal.collection.length > 1
                ? `Remove themes from “${removal.theme.collection?.label ?? removal.theme.label}”?`
                : `Remove “${removal.theme.label}”?`}
              description={removal.collection.length > 1
                ? (
                    <>
                      <p>Select the variants you want to remove. You can restore them by installing the extension again.</p>
                      <div className="theme-remove-grid">
                        {removal.collection.map(theme => (
                          <label key={theme.id} className="theme-remove-option">
                            <input
                              type="checkbox"
                              checked={removeIds.includes(theme.id)}
                              onChange={event => {
                                const checked = event.currentTarget.checked
                                setRemoveIds(current => (checked ? [...current, theme.id] : current.filter(id => id !== theme.id)))
                              }}
                            />
                            <span className="theme-remove-option__circles" aria-hidden="true">
                              {themeCardPreviews(theme).map(preview => <ThemePreviewCircle key={preview.mode} colors={preview.colors} mode={preview.mode} small />)}
                            </span>
                            <span className="theme-remove-option__label">{theme.label}</span>
                          </label>
                        ))}
                      </div>
                    </>
                  )
                : 'You can bring it back anytime by importing its JSON file.'}
              confirmLabel={removal.collection.length > 1 ? `Remove selected${removeIds.length > 0 ? ` (${removeIds.length})` : ''}` : 'Remove theme'}
              cancelLabel="Cancel"
              confirmDisabled={removeIds.length === 0}
              failureMessage="The theme could not be removed. Your themes are unchanged."
              onConfirm={() => onRemove(removeIds)}
              onCancel={() => setRemoval(null)}
            />
          )}
    </>
  )
}

interface ThemeCardProps {
  readonly theme: ThemeDefinition
  readonly activeModes: readonly ThemeAppearance[]
  readonly onUse: () => void
  readonly onUseMode: (mode: ThemeAppearance) => void
  readonly onDuplicate: () => void
  readonly onEdit?: () => void
  readonly onExport?: () => void
  readonly onRemove?: () => void
  /** Collection cards name the collection and let the circles switch variant. */
  readonly title?: string
  readonly removeLabel?: string
  readonly variants?: ReactNode
}

function ThemeCard({ theme, activeModes, onUse, onUseMode, onDuplicate, onEdit, onExport, onRemove, title, removeLabel, variants }: ThemeCardProps): ReactNode {
  const previews = themeCardPreviews(theme)
  const modes = previews.map(preview => preview.mode)
  const hint = modes.length > 1 ? 'Use for both light and dark' : `Use for ${modes[0]} mode only`
  const owned = activeModes.length > 0 && modes.every(mode => activeModes.includes(mode))
  return (
    // The card is a plain element (buttons cannot nest in a button); the title
    // and the circles carry the accessible actions, a card click is a pointer shortcut.
    <div className="theme-card" role="listitem" data-theme-card={theme.id} data-active={activeModes.length > 0 || undefined} title={hint} onClick={onUse}>
      <ThemePreviewCircles label={theme.label} previews={previews} activeModes={activeModes} onSelectMode={onUseMode} />
      {variants}
      <div className="theme-card__footer">
        <button
          type="button"
          className="theme-card__title tt-focusable"
          aria-label={`Use ${title === undefined ? `${theme.label} theme` : `${title}, ${theme.label} variant`}${owned ? ', currently active' : ''}`}
          aria-pressed={owned}
          title={hint}
          onClick={event => {
            event.stopPropagation()
            onUse()
          }}
        >
          {title ?? theme.label}
        </button>
        <span className="theme-card__actions" onClick={event => event.stopPropagation()}>
          <Button variant="ghost" iconOnly aria-label={`Duplicate ${theme.label}`} onClick={onDuplicate}><Copy size={14} aria-hidden="true" /></Button>
          {onEdit ? <Button variant="ghost" iconOnly aria-label={`Edit ${theme.label}`} onClick={onEdit}><PenLine size={14} aria-hidden="true" /></Button> : null}
          {onExport ? <Button variant="ghost" iconOnly aria-label={`Export ${theme.label}`} onClick={onExport}><Download size={14} aria-hidden="true" /></Button> : null}
          {onRemove ? <Button variant="ghost" iconOnly className="theme-card__remove" aria-label={removeLabel ?? `Remove ${theme.label}`} onClick={onRemove}><Trash2 size={14} aria-hidden="true" /></Button> : null}
        </span>
      </div>
    </div>
  )
}

function CollectionCard({ themes, state, onSelect, onDuplicate, onEdit, onExport, onRemove }: {
  readonly themes: ThemeDefinition[]
  readonly state: AppearanceChoice
  readonly onSelect: (patch: LibraryPatch) => void
  readonly onDuplicate: (theme: ThemeDefinition) => void
  readonly onEdit: (theme: ThemeDefinition) => void
  readonly onExport: (theme: ThemeDefinition) => void
  readonly onRemove: (theme: ThemeDefinition) => void
}): ReactNode {
  const [index, setIndex] = useState(() => Math.max(0, themes.findIndex(theme => activeModesFor(state, theme.id).length > 0)))
  const safeIndex = Math.min(index, themes.length - 1)
  const theme = themes[safeIndex]!
  const labels = collectionVariantLabels(themes)
  const collectionLabel = themes.length > 1 ? theme.collection?.label ?? theme.label : undefined

  const useCollection = (): void => {
    if (themes.length === 1) {
      onSelect(useThemePatch(theme))
      return
    }
    // The collection's first light and first dark variants take their halves.
    const light = themes.find(candidate => getThemeModes(candidate).includes('light'))
    const dark = themes.find(candidate => getThemeModes(candidate).includes('dark'))
    onSelect({ ...(light ? { lightTheme: light.id } : {}), ...(dark ? { darkTheme: dark.id } : {}) })
  }

  return (
    <ThemeCard
      theme={theme}
      activeModes={activeModesFor(state, theme.id)}
      onUse={useCollection}
      onUseMode={mode => onSelect(assignHalfPatch(mode, theme.id))}
      onDuplicate={() => onDuplicate(theme)}
      onEdit={() => onEdit(theme)}
      onExport={() => onExport(theme)}
      onRemove={() => onRemove(theme)}
      {...(collectionLabel === undefined ? {} : { title: collectionLabel, removeLabel: `Remove themes from ${collectionLabel}` })}
      variants={themes.length > 1
        ? (
            <div className="theme-card__variants" role="group" aria-label={`${collectionLabel} variants`} onClick={event => event.stopPropagation()}>
              {themes.map((variant, variantIndex) => (
                <button
                  key={variant.id}
                  type="button"
                  className="theme-variant-chip tt-focusable"
                  aria-pressed={variantIndex === safeIndex}
                  data-owns={activeModesFor(state, variant.id).length > 0 || undefined}
                  onClick={() => setIndex(variantIndex)}
                >
                  {labels[variantIndex]}
                </button>
              ))}
            </div>
          )
        : undefined}
    />
  )
}

/** The file a theme exports to, as T3 Code names it. */
export function themeExportFile(theme: ThemeDefinition): { fileName: string; contents: string } {
  return { fileName: `${theme.id}.json`, contents: serializeThemeFile(theme) }
}
