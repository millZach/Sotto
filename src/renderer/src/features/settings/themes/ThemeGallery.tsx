/*
 * The Themes part of Settings → Appearance (ADR-0024): the color scheme as a
 * track from Light to Dark with the system in the middle, then a Light column
 * and a Dark column, each choosing the theme that paints its half. The user's
 * own themes are managed in a list below the columns.
 */

import React, { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, Copy, Download, Moon, Paintbrush, PenLine, Plus, Sun, Trash2 } from 'lucide-react'

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
import { assignHalfPatch, halfColors, type LibraryPatch, type ThemeMode } from './themeLibrary'

export interface ThemeGalleryProps {
  readonly shown: AppearanceChoice
  readonly resolved: ThemeAppearance
  /** The operating system's name, for "Match Windows". */
  readonly system: string
  readonly onChooseMode: (mode: ThemeMode) => void
  readonly onSelect: (patch: LibraryPatch) => void
  readonly onRemove: (ids: readonly string[]) => Promise<boolean>
  readonly onExport: (theme: ThemeDefinition) => void
  readonly onAddTheme: () => void
}

const HALF_TITLES: Readonly<Record<ThemeAppearance, string>> = { light: 'Light', dark: 'Dark' }

export function ThemeGallery({ shown, resolved, system, onChooseMode, onSelect, onRemove, onExport, onAddTheme }: ThemeGalleryProps): ReactNode {
  const [removal, setRemoval] = useState<{ theme: ThemeDefinition; collection: ThemeDefinition[] } | null>(null)
  const [removeIds, setRemoveIds] = useState<string[]>([])
  const headingId = useId()
  const all = [...BUILT_IN_THEMES, ...shown.customThemes]

  const openEditor = (input: { editingThemeId?: string; seedThemeId: string | null; seedName?: string }): void => openThemeEditor({
    editingThemeId: input.editingThemeId ?? null,
    seedThemeId: input.seedThemeId,
    seedName: input.seedName ?? null,
    initialAppearance: resolved,
  })

  const remove = (theme: ThemeDefinition): void => {
    const collection = theme.collection === undefined ? [theme] : shown.customThemes.filter(candidate => candidate.collection?.id === theme.collection?.id)
    setRemoval({ theme, collection })
    setRemoveIds([theme.id])
  }

  return (
    <>
      <SchemeTrack appearance={shown.appearance} system={system} onChoose={onChooseMode} />

      <div className="theme-settings__bar">
        <h3 className="theme-settings__subheading" id={headingId}>Themes</h3>
        <div className="theme-settings__actions">
          {/* Creating starts from the theme painting the window, which is also how a built-in is duplicated. */}
          <Button variant="ghost" onClick={() => openEditor({ seedThemeId: resolved === 'light' ? shown.lightTheme : shown.darkTheme })}>
            <Paintbrush size={15} aria-hidden="true" />Create theme
          </Button>
          <Button variant="ghost" onClick={onAddTheme}>
            <Plus size={15} aria-hidden="true" />Add theme
          </Button>
        </div>
      </div>
      <p className="theme-settings__assignment-hint">Choose one theme for light mode and one for dark. Sotto wears the one for the mode it is in.</p>

      <div className="theme-halves" role="group" aria-labelledby={headingId}>
        {(['light', 'dark'] as const).map(half => (
          <ThemeColumn
            key={half}
            half={half}
            themes={all.filter(theme => getThemeModes(theme).includes(half))}
            chosen={half === 'light' ? shown.lightTheme : shown.darkTheme}
            note={half === resolved
              ? 'Painting the window now.'
              : shown.appearance === 'system' ? `Used when ${system} turns ${half}.` : `Used when you switch to ${HALF_TITLES[half]}.`}
            live={half === resolved}
            onPick={id => onSelect(assignHalfPatch(half, id))}
          />
        ))}
      </div>

      {shown.customThemes.length === 0
        ? null
        : (
            <YourThemes
              themes={shown.customThemes}
              onEdit={theme => openEditor({ editingThemeId: theme.id, seedThemeId: null })}
              onDuplicate={theme => openEditor({ seedThemeId: theme.id, seedName: `${theme.label} copy`.slice(0, 48) })}
              onExport={onExport}
              onRemove={remove}
            />
          )}

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
                            <ThemeChords theme={theme} />
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

/** Arrow keys walk a radio group and choose as they go, as native radios do; Home and End jump to the ends. */
function radioStep(event: KeyboardEvent, index: number, count: number): number | null {
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') return (index + 1) % count
  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') return (index - 1 + count) % count
  if (event.key === 'Home') return 0
  if (event.key === 'End') return count - 1
  return null
}

function SchemeTrack({ appearance, system, onChoose }: {
  readonly appearance: ThemeMode
  readonly system: string
  readonly onChoose: (mode: ThemeMode) => void
}): ReactNode {
  const headingId = useId()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const stops: ReadonlyArray<readonly [ThemeMode, string]> = [['light', 'Light'], ['system', `Match ${system}`], ['dark', 'Dark']]
  return (
    <div className="theme-settings__scheme">
      <h3 className="theme-settings__subheading" id={headingId}>Color scheme</h3>
      <div className="theme-scheme-track" role="radiogroup" aria-labelledby={headingId}>
        <span className="theme-scheme-track__rail" aria-hidden="true" />
        {stops.map(([mode, label], index) => (
          <button
            key={mode}
            ref={element => { buttons.current[index] = element }}
            type="button"
            role="radio"
            className="theme-scheme-track__stop tt-focusable"
            aria-checked={appearance === mode}
            tabIndex={appearance === mode ? 0 : -1}
            onClick={() => onChoose(mode)}
            onKeyDown={event => {
              const next = radioStep(event, index, stops.length)
              if (next === null) return
              event.preventDefault()
              buttons.current[next]?.focus()
              onChoose(stops[next]![0])
            }}
          >
            <span className="theme-scheme-track__dot" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ThemeColumn({ half, themes, chosen, note, live, onPick }: {
  readonly half: ThemeAppearance
  readonly themes: readonly ThemeDefinition[]
  readonly chosen: string
  readonly note: string
  readonly live: boolean
  readonly onPick: (id: string) => void
}): ReactNode {
  const titleId = useId()
  const noteId = useId()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const Icon = half === 'light' ? Sun : Moon
  // A saved choice that is not listed (a removed theme mid-save) still leaves one option reachable by Tab.
  const focusable = themes.some(theme => theme.id === chosen) ? chosen : themes[0]?.id
  return (
    <section className="theme-half" data-half={half} data-live={live || undefined} aria-labelledby={titleId}>
      <header className="theme-half__head">
        <Icon size={15} aria-hidden="true" />
        <h4 id={titleId}>{HALF_TITLES[half]}</h4>
        <p id={noteId}>{note}</p>
      </header>
      <div className="theme-half__options" role="radiogroup" aria-label={`${HALF_TITLES[half]} theme`} aria-describedby={noteId}>
        {themes.map((theme, index) => {
          const picked = theme.id === chosen
          return (
            <button
              key={theme.id}
              ref={element => { buttons.current[index] = element }}
              type="button"
              role="radio"
              className="theme-option tt-focusable"
              data-theme-option={theme.id}
              aria-checked={picked}
              tabIndex={theme.id === focusable ? 0 : -1}
              // A long imported name is cut to one line; the tooltip reads it whole.
              title={theme.label}
              onClick={() => onPick(theme.id)}
              onKeyDown={event => {
                const next = radioStep(event, index, themes.length)
                if (next === null) return
                event.preventDefault()
                buttons.current[next]?.focus()
                onPick(themes[next]!.id)
              }}
            >
              <ThemeChord theme={theme} half={half} />
              <span className="theme-option__name">{theme.label}</span>
              {picked ? <Check className="theme-option__check" size={15} aria-hidden="true" /> : null}
            </button>
          )
        })}
      </div>
    </section>
  )
}

const CHORD_ROLES = ['canvas', 'sidebar', 'surfaceRaised', 'messageSurface', 'accent'] as const

/**
 * A half of a theme as one flat strip of its colours: the room, the sidebar, a raised
 * surface, the message bubble and the accent. Every colour is a canonical theme role.
 */
function ThemeChord({ theme, half }: { readonly theme: ThemeDefinition; readonly half: ThemeAppearance }): ReactNode {
  const colors = halfColors(theme, half)
  return (
    <span className="theme-chord" aria-hidden="true">
      {CHORD_ROLES.map(role => <span key={role} data-role={role} style={{ backgroundColor: colors[role] }} />)}
    </span>
  )
}

/** Each half a theme carries, light first. */
function ThemeChords({ theme }: { readonly theme: ThemeDefinition }): ReactNode {
  return (
    <span className="theme-chords">
      {getThemeModes(theme).map(half => <ThemeChord key={half} theme={theme} half={half} />)}
    </span>
  )
}

function modesLabel(theme: ThemeDefinition): string {
  const modes = getThemeModes(theme)
  return modes.length === 2 ? 'Light and dark' : modes[0] === 'light' ? 'Light only' : 'Dark only'
}

function YourThemes({ themes, onEdit, onDuplicate, onExport, onRemove }: {
  readonly themes: readonly ThemeDefinition[]
  readonly onEdit: (theme: ThemeDefinition) => void
  readonly onDuplicate: (theme: ThemeDefinition) => void
  readonly onExport: (theme: ThemeDefinition) => void
  readonly onRemove: (theme: ThemeDefinition) => void
}): ReactNode {
  const headingId = useId()
  return (
    <div className="theme-own">
      <h3 className="theme-settings__subheading" id={headingId}>Your themes</h3>
      <ul className="theme-own__list" aria-labelledby={headingId}>
        {themes.map(theme => (
          <li key={theme.id} className="theme-own__row" data-theme-row={theme.id}>
            <ThemeChords theme={theme} />
            <span className="theme-own__text">
              <span className="theme-own__name" title={theme.label}>{theme.label}</span>
              <span className="theme-own__modes">{theme.collection === undefined ? modesLabel(theme) : `${modesLabel(theme)} · ${theme.collection.label}`}</span>
            </span>
            <span className="theme-own__actions">
              <Button variant="ghost" iconOnly aria-label={`Edit ${theme.label}`} onClick={() => onEdit(theme)}><PenLine size={14} aria-hidden="true" /></Button>
              <Button variant="ghost" iconOnly aria-label={`Duplicate ${theme.label}`} onClick={() => onDuplicate(theme)}><Copy size={14} aria-hidden="true" /></Button>
              <Button variant="ghost" iconOnly aria-label={`Export ${theme.label}`} onClick={() => onExport(theme)}><Download size={14} aria-hidden="true" /></Button>
              <Button variant="ghost" iconOnly className="theme-own__remove" aria-label={`Remove ${theme.label}`} onClick={() => onRemove(theme)}><Trash2 size={14} aria-hidden="true" /></Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The file a theme exports to, as T3 Code names it. */
export function themeExportFile(theme: ThemeDefinition): { fileName: string; contents: string } {
  return { fileName: `${theme.id}.json`, contents: serializeThemeFile(theme) }
}
