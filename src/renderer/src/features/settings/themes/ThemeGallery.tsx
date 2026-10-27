/*
 * The Theme card of Settings → Appearance (ADR-0024, the Studio page): the color scheme, a grid of theme tiles that
 * each choose one theme for both halves, and a switch that splits the grid into a Light grid and a Dark grid, each
 * choosing its own half. The switch is view state, never a setting: it starts on when the saved halves differ. The
 * user's own themes are managed in a list that opens below the grid.
 */

import React, { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight, Copy, Download, Paintbrush, PenLine, Plus, Trash2 } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg, plural, t } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { shownCount } from '../../../state/interfaceNumbers'

import {
  builtInThemesFor,
  T3_CODE_THEME,
  getThemeModes,
  serializeThemeFile,
  type ThemeAppearance,
  type ThemeDefinition,
} from '../../../../../shared/themes/library'
import { OMARCHY_THEME_ID } from '../../../../../shared/themes/omarchy'
import { Button } from '../../../components/Button'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { SegmentedControl } from '../../../components/SegmentedControl'
import { Toggle } from '../../../components/Toggle'
import type { AppearanceChoice } from '../../../state/appearance'
import { useOwlFeature } from '../../../state/owlFeature'
import { openThemeEditor } from './themeEditorSession'
import { assignHalfPatch, halfColors, useThemePatch as bothHalvesPatch, type LibraryPatch, type ThemeMode } from './themeLibrary'

export interface ThemeGalleryProps {
  readonly shown: AppearanceChoice
  readonly resolved: ThemeAppearance
  /** The operating system's name, for "Match Windows". */
  readonly system: string
  readonly onChooseMode: (mode: ThemeMode) => void
  /** Saves a choice of theme; answers whether it was saved, where it can tell. */
  readonly onSelect: (patch: LibraryPatch) => Promise<boolean> | void
  readonly onRemove: (ids: readonly string[]) => Promise<boolean>
  readonly onExport: (theme: ThemeDefinition) => void
  readonly onAddTheme: () => void
}

const HALF_TITLES: Readonly<Record<ThemeAppearance, MessageDescriptor>> = {
  light: msg({ message: 'Light', comment: 'The light color scheme, or the themes that paint it' }),
  dark: msg({ message: 'Dark', comment: 'The dark color scheme, or the themes that paint it' }),
}

/** Which half a tile shows: both, one half alone, or the waiting Omarchy tile. */
type TileHalves = 'both' | ThemeAppearance | 'waiting'

export function ThemeGallery({ shown, resolved, system, onChooseMode, onSelect, onRemove, onExport, onAddTheme }: ThemeGalleryProps): ReactNode {
  const { t, i18n } = useLingui()
  const [removal, setRemoval] = useState<{ theme: ThemeDefinition; collection: ThemeDefinition[] } | null>(null)
  const [removeIds, setRemoveIds] = useState<string[]>([])
  // View state only (no setting): on when the saved halves differ, then the user's until the page goes.
  const [split, setSplit] = useState(() => shown.lightTheme !== shown.darkTheme)
  const [ownOpen, setOwnOpen] = useState(false)
  const ownButton = useRef<HTMLButtonElement>(null)
  const ownListId = useId()
  const omarchy = system === 'Linux' ? shown.omarchyTheme ?? { ...T3_CODE_THEME, id: OMARCHY_THEME_ID, label: 'Omarchy' } : null
  // Glass is offered only where its Owl feature is on (ADR-0150).
  const all = [...(omarchy ? [omarchy] : []), ...builtInThemesFor(useOwlFeature('glass-theme')), ...shown.customThemes]
  const omarchyMode = shown.omarchyTheme?.appearance
  const omarchyName = shown.omarchyTheme?.sourceName

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

  const pickBoth = (theme: ThemeDefinition): void => {
    if (theme === omarchy) onSelect({ lightTheme: OMARCHY_THEME_ID, darkTheme: OMARCHY_THEME_ID })
    else onSelect(bothHalvesPatch(theme))
  }

  const chooseSplit = (on: boolean): void => {
    setSplit(on)
    if (on) return
    // One theme for both again: the dark half follows the light one, where the light theme has a dark half.
    const light = all.find(theme => theme.id === shown.lightTheme)
    if (light === undefined || shown.darkTheme === shown.lightTheme) return
    if (light !== omarchy && !getThemeModes(light).includes('dark')) return
    // A refused save leaves the halves different, so the switch goes back on to show them; the status line says why.
    void Promise.resolve(onSelect({ darkTheme: light.id })).then(saved => { if (saved === false) setSplit(true) })
  }

  // In the one grid, the chosen tile is the theme on both halves, or a one-half theme on its own half (the one painting
  // the window first, when each half holds one).
  const bothChosen = ((): string | null => {
    if (shown.lightTheme === shown.darkTheme) return shown.lightTheme
    const onlyOn = (id: string, half: ThemeAppearance): boolean => {
      const theme = all.find(candidate => candidate.id === id)
      return theme !== undefined && theme !== omarchy && getThemeModes(theme).length === 1 && getThemeModes(theme)[0] === half
    }
    const light = onlyOn(shown.lightTheme, 'light'), dark = onlyOn(shown.darkTheme, 'dark')
    if (light && dark) return resolved === 'light' ? shown.lightTheme : shown.darkTheme
    return light ? shown.lightTheme : dark ? shown.darkTheme : null
  })()

  const waitsFor = (half: ThemeAppearance): string => half === 'light' ? t`Waits for a light Omarchy theme` : t`Waits for a dark Omarchy theme`
  const halfNote = (half: ThemeAppearance): string => half === resolved
    ? t`Painting the window now.`
    : shown.appearance === 'system'
      ? half === 'light' ? t`Used when ${system} turns light.` : t`Used when ${system} turns dark.`
      : half === 'light' ? t`Used when you switch to Light.` : t`Used when you switch to Dark.`

  const scheme: ReadonlyArray<{ value: ThemeMode; label: string }> = [
    { value: 'light', label: i18n._(HALF_TITLES.light) },
    { value: 'system', label: t`Match ${system}` },
    { value: 'dark', label: i18n._(HALF_TITLES.dark) },
  ]

  return (
    <>
      <div className="settings-rows">
        <div className="tt-field appearance-scheme">
          <p className="tt-field__label"><Trans>Color scheme</Trans></p>
          <SegmentedControl setting="color-scheme" label={t`Color scheme`} value={shown.appearance} options={scheme} onChange={value => onChooseMode(value as ThemeMode)} />
        </div>
      </div>

      {/* Find a setting's Themes leads here: the tiles and the switch that splits them. */}
      <div data-setting="themes" role="group" aria-label={t({ message: 'Themes', comment: 'The theme tiles on Settings > Appearance' })}>
      <div className="appearance-themes">
        {split
          ? (['light', 'dark'] as const).map(half => {
              const themes = all.filter(theme => theme === omarchy || getThemeModes(theme).includes(half))
              const chosen = half === 'light' ? shown.lightTheme : shown.darkTheme
              return (
                <TileGrid
                  key={half}
                  half={half}
                  title={i18n._(HALF_TITLES[half])}
                  note={halfNote(half)}
                  label={half === 'light' ? t`Light theme` : t`Dark theme`}
                  live={half === resolved}
                  tiles={themes.map(theme => {
                    const isOmarchy = theme === omarchy
                    const waiting = isOmarchy && omarchyMode !== half
                    return {
                      theme,
                      halves: waiting ? 'waiting' : half,
                      checked: theme.id === chosen,
                      label: isOmarchy ? `Omarchy ${waiting ? waitsFor(half) : omarchyName}` : undefined,
                      detail: isOmarchy ? (waiting ? waitsFor(half) : omarchyName) : undefined,
                    }
                  })}
                  onPick={theme => onSelect(assignHalfPatch(half, theme.id))}
                />
              )
            })
          : (
              <TileGrid
                label={t({ message: 'Theme', comment: 'The theme tiles that each paint both the light and the dark color scheme' })}
                tiles={all.map(theme => {
                  const isOmarchy = theme === omarchy
                  const modes = getThemeModes(theme)
                  const halves: TileHalves = isOmarchy ? omarchyMode ?? 'waiting' : modes.length === 2 ? 'both' : modes[0]!
                  const waitsForAny = t`Waits for an Omarchy theme`
                  return {
                    theme,
                    halves,
                    checked: theme.id === bothChosen,
                    label: isOmarchy ? `Omarchy ${omarchyName ?? waitsForAny}` : undefined,
                    detail: isOmarchy ? omarchyName ?? waitsForAny : undefined,
                    only: !isOmarchy && modes.length === 1 ? (modes[0] === 'light' ? t`Light only` : t`Dark only`) : undefined,
                  }
                })}
                onPick={pickBoth}
              />
            )}
      </div>

      <div className="settings-rows">
        <Toggle label={t({ message: 'A different theme when dark', comment: 'A switch on Settings > Appearance: on, the light and the dark color schemes each get their own theme' })}
          checked={split} onCheckedChange={chooseSplit}
          description={split ? t`Choose the light theme and the dark theme on their own.` : t`Off, one theme paints light and dark.`} />
      </div>
      </div>

      <div className="appearance-themes__foot">
        {/* Creating starts from the theme painting the window, which is also how a built-in is duplicated. */}
        <Button variant="ghost" onClick={() => openEditor({ seedThemeId: resolved === 'light' ? shown.lightTheme : shown.darkTheme })}>
          <Paintbrush size={15} aria-hidden="true" /><Trans>Create theme</Trans>
        </Button>
        <Button variant="ghost" onClick={onAddTheme}>
          <Plus size={15} aria-hidden="true" /><Trans>Add theme</Trans>
        </Button>
        {shown.customThemes.length === 0
          ? null
          : (() => {
              const count = shownCount(shown.customThemes.length)
              return (
                <button ref={ownButton} type="button" className="appearance-themes__own tt-focusable" aria-expanded={ownOpen} aria-controls={ownListId} onClick={() => setOwnOpen(open => !open)}
                  onKeyDown={event => { if (event.key === 'Escape' && ownOpen) { event.preventDefault(); setOwnOpen(false) } }}>
                  <Trans comment="Opens the list of the themes the user created or added, with how many there are">Your themes ({count})</Trans>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              )
            })()}
      </div>

      {shown.customThemes.length > 0 && ownOpen
        ? (
            <YourThemes
              id={ownListId}
              themes={shown.customThemes}
              onEdit={theme => openEditor({ editingThemeId: theme.id, seedThemeId: null })}
              // The copy's name stays English: a theme's name is its identity, and a translated suffix would read as the original's.
              onDuplicate={theme => openEditor({ seedThemeId: theme.id, seedName: `${theme.label} copy`.slice(0, 48) })}
              onExport={onExport}
              onRemove={remove}
              onClose={() => { setOwnOpen(false); ownButton.current?.focus() }}
            />
          )
        : null}

      {removal === null
        ? null
        : (() => {
            const collection = removal.theme.collection?.label ?? removal.theme.label
            const name = removal.theme.label
            const count = removeIds.length, selected = shownCount(count)
            return (
            <ConfirmationDialog
              title={removal.collection.length > 1
                ? t`Remove themes from “${collection}”?`
                : t`Remove “${name}”?`}
              description={removal.collection.length > 1
                ? (
                    <>
                      <p className="tt-paragraph"><Trans>Select the variants you want to remove. You can restore them by installing the extension again.</Trans></p>
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
                : t`You can bring it back anytime by importing its JSON file.`}
              confirmLabel={removal.collection.length > 1 ? count > 0 ? plural(count, { other: `Remove selected (${selected})` }) : t`Remove selected` : t`Remove theme`}
              cancelLabel={t`Cancel`}
              confirmDisabled={removeIds.length === 0}
              failureMessage={t`The theme could not be removed. Your themes are unchanged.`}
              onConfirm={() => onRemove(removeIds)}
              onCancel={() => setRemoval(null)}
            />
            )
          })()}
    </>
  )
}

/** Arrow keys walk a radio group and choose as they go, as native radios do; Home and End jump to the ends. */
export function radioStep(event: KeyboardEvent, index: number, count: number): number | null {
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') return (index + 1) % count
  if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') return (index - 1 + count) % count
  if (event.key === 'Home') return 0
  if (event.key === 'End') return count - 1
  return null
}

interface Tile {
  readonly theme: ThemeDefinition
  readonly halves: TileHalves
  readonly checked: boolean
  /** The radio's name where the theme's own name is not all of it (Omarchy, with the desktop theme it follows). */
  readonly label?: string | undefined
  /** A second line under the name. */
  readonly detail?: string | undefined
  /** "Light only" or "Dark only", read with the name, for a one-half theme in the one grid. */
  readonly only?: string | undefined
}

/** One radio group of theme tiles: the one grid, or the Light grid or the Dark grid with its title and note. */
function TileGrid({ label, tiles, onPick, half, title, note, live }: {
  readonly label: string
  readonly tiles: readonly Tile[]
  readonly onPick: (theme: ThemeDefinition) => void
  readonly half?: ThemeAppearance
  readonly title?: string
  readonly note?: string
  readonly live?: boolean
}): ReactNode {
  const noteId = useId()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  // A saved choice that is not listed (a removed theme mid-save) still leaves one tile reachable by Tab.
  const focusable = tiles.find(tile => tile.checked)?.theme.id ?? tiles[0]?.theme.id
  return (
    <div className="appearance-tiles" data-half={half} data-live={live || undefined}>
      {title === undefined ? null : <p className="appearance-tiles__title tt-paragraph"><strong>{title}</strong> <span id={noteId}>{note}</span></p>}
      <div className="appearance-tiles__grid" role="radiogroup" aria-label={label} aria-describedby={title === undefined ? undefined : noteId}>
        {tiles.map((tile, index) => {
          const { theme } = tile
          const onlyId = `${noteId}-${index}`
          return (
            <button
              key={theme.id}
              ref={element => { buttons.current[index] = element }}
              type="button"
              role="radio"
              className="theme-tile tt-focusable"
              data-theme-option={theme.id}
              aria-checked={tile.checked}
              aria-label={tile.label}
              aria-describedby={tile.only === undefined ? undefined : onlyId}
              tabIndex={theme.id === focusable ? 0 : -1}
              // A long imported name is cut to one line; the tooltip reads it whole.
              title={theme.label}
              onClick={() => onPick(theme)}
              onKeyDown={event => {
                const next = radioStep(event, index, tiles.length)
                if (next === null) return
                event.preventDefault()
                buttons.current[next]?.focus()
                onPick(tiles[next]!.theme)
              }}
            >
              <ThemeTileWindow theme={theme} halves={tile.halves} />
              <span className="theme-tile__name">{theme.label}{tile.detail === undefined ? null : <small>{tile.detail}</small>}</span>
              {tile.only === undefined ? null : <span className="tt-visually-hidden" id={onlyId} aria-hidden="true">{tile.only}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The roles a tile draws its small window in, each written to the tile as a custom property. */
const TILE_ROLES = { canvas: 'canvas', sidebar: 'sidebar', row: 'sidebarRowSelected', bubble: 'messageSurface', text: 'text', card: 'surfaceRaised', accent: 'accent' } as const

function tileStyle(theme: ThemeDefinition, half: ThemeAppearance): CSSProperties {
  const colors = halfColors(theme, half)
  return Object.fromEntries(Object.entries(TILE_ROLES).map(([name, role]) => [`--tile-${name}`, colors[role]])) as CSSProperties
}

/**
 * A theme as a small window drawn in its own colours: a sidebar with a selected row, a message, a line of text and the
 * composer with its send button. A theme with both halves is split corner to corner, light above, dark below; a theme
 * with one half shows only that half. Every colour is one of the theme's own roles.
 */
export function ThemeTileWindow({ theme, halves }: { readonly theme: ThemeDefinition; readonly halves: TileHalves }): ReactNode {
  if (halves === 'waiting') return <span className="theme-tile__window theme-tile__window--waiting" aria-hidden="true" />
  const drawn: readonly ThemeAppearance[] = halves === 'both' ? ['light', 'dark'] : [halves]
  return (
    <span className="theme-tile__window" data-halves={halves} aria-hidden="true">
      {drawn.map(half => (
        <span key={half} className="theme-tile__half" data-half={half} style={tileStyle(theme, half)}>
          <i data-part="sidebar" /><i data-part="row" /><i data-part="bubble" /><i data-part="text" /><i data-part="composer" /><i data-part="send" />
        </span>
      ))}
    </span>
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
  return modes.length === 2 ? t`Light and dark` : modes[0] === 'light' ? t`Light only` : t`Dark only`
}

function YourThemes({ id, themes, onEdit, onDuplicate, onExport, onRemove, onClose }: {
  readonly id: string
  readonly themes: readonly ThemeDefinition[]
  readonly onEdit: (theme: ThemeDefinition) => void
  readonly onDuplicate: (theme: ThemeDefinition) => void
  readonly onExport: (theme: ThemeDefinition) => void
  readonly onRemove: (theme: ThemeDefinition) => void
  readonly onClose: () => void
}): ReactNode {
  const { t } = useLingui()
  return (
    <div className="theme-own" id={id} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose() } }}>
      <ul className="theme-own__list" aria-label={t`Your themes`}>
        {themes.map(theme => { const name = theme.label; return (
          <li key={theme.id} className="theme-own__row" data-theme-row={theme.id}>
            <ThemeTileWindow theme={theme} halves={getThemeModes(theme).length === 2 ? 'both' : getThemeModes(theme)[0]!} />
            <span className="theme-own__text">
              <span className="theme-own__name" title={theme.label}>{theme.label}</span>
              <span className="theme-own__modes">{theme.collection === undefined ? modesLabel(theme) : `${modesLabel(theme)} · ${theme.collection.label}`}</span>
            </span>
            <span className="theme-own__actions">
              <Button variant="ghost" iconOnly aria-label={t`Edit ${name}`} onClick={() => onEdit(theme)}><PenLine size={14} aria-hidden="true" /></Button>
              <Button variant="ghost" iconOnly aria-label={t`Duplicate ${name}`} onClick={() => onDuplicate(theme)}><Copy size={14} aria-hidden="true" /></Button>
              <Button variant="ghost" iconOnly aria-label={t`Export ${name}`} onClick={() => onExport(theme)}><Download size={14} aria-hidden="true" /></Button>
              <Button variant="ghost" iconOnly className="theme-own__remove" aria-label={t`Remove ${name}`} onClick={() => onRemove(theme)}><Trash2 size={14} aria-hidden="true" /></Button>
            </span>
          </li>
        ) })}
      </ul>
    </div>
  )
}

/** The file a theme exports to, as T3 Code names it. */
export function themeExportFile(theme: ThemeDefinition): { fileName: string; contents: string } {
  return { fileName: `${theme.id}.json`, contents: serializeThemeFile(theme) }
}
