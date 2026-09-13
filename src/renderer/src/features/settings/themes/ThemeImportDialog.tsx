/*
 * "Add a theme": search Open VSX, or import T3 Code and VS Code theme files.
 *
 * Follows T3 Code's apps/web/src/components/settings/ThemeImportDialog.tsx and
 * ThemeSearchSection.tsx at commit d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3
 * (MIT, Copyright (c) 2026 T3 Tools Inc.; see THIRD_PARTY_NOTICES.md).
 * Differences: search and download run in the main process (the renderer has
 * no network), extension icons are not loaded, and the JSON box is a plain
 * text area rather than T3's highlighted overlay.
 */

import React, { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Download, ExternalLink, PackagePlus, Plus, RefreshCw, Search, X } from 'lucide-react'

import { MAX_THEME_FILE_BYTES, OPEN_VSX_SORTS, type OpenVsxThemeExtension, type OpenVsxThemeSort } from '../../../../../shared/themes/bridge'
import { parseThemeFile, type ThemeDefinition } from '../../../../../shared/themes/library'
import { isVsCodeThemeFile, humanizeThemeName, pairVsCodeThemes, parseVsCodeThemeFile, resolveThemeLabelCollisions } from '../../../../../shared/themes/vscodeImport'
import { Button } from '../../../components/Button'
import {
  installThemesPatch,
  replaceCollectionPatch,
  updateThemesPatch,
  useThemePatch,
  versionedCopy,
  type ThemeLibraryWriter,
} from './themeLibrary'

const SORT_LABELS: Readonly<Record<OpenVsxThemeSort, string>> = {
  downloadCount: 'Most downloaded',
  rating: 'Best rated',
  timestamp: 'Newest',
  relevance: 'Most relevant',
}
const SUGGESTED_SEARCHES = ['Dracula', 'Catppuccin', 'Nord', 'Tokyo Night']
const SEARCH_DEBOUNCE_MS = 350
const DOWNLOADS = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} bytes`
}

/** The message for a file too large to be a theme, else null. The size is checked before any byte is read. */
export function describeOversizedThemeFile(bytes: number): string | null {
  if (bytes <= MAX_THEME_FILE_BYTES) return null
  return `That file is ${formatBytes(bytes)}. Theme files are only a few KB, so this one was not read (limit ${formatBytes(MAX_THEME_FILE_BYTES)}).`
}

/** Parse pasted or file text as a T3 Code theme file or a VS Code colour theme. Throws a message fit to show. */
export function parseImportedThemeText(text: string): ThemeDefinition {
  const oversized = describeOversizedThemeFile(new TextEncoder().encode(text).byteLength)
  if (oversized) throw new Error(oversized)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('That is not valid JSON. Check for a missing comma or quote.')
  }
  return isVsCodeThemeFile(value) ? parseVsCodeThemeFile(value) : parseThemeFile(value)
}

interface ImportableFile { readonly name: string; readonly size: number; readonly text: () => Promise<string> }

export interface ThemeImportDialogProps {
  readonly writer: ThemeLibraryWriter
  readonly onClose: () => void
  readonly onNotice: (message: string) => void
}

export function ThemeImportDialog({ writer, onClose, onNotice }: ThemeImportDialogProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const jsonId = useId()
  const [json, setJson] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dropTarget, setDropTarget] = useState(false)
  // Imports whose id is already saved wait here for an update-or-copy decision.
  const [conflicts, setConflicts] = useState<ThemeDefinition[] | null>(null)
  const request = useRef(0)

  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    if (element?.showModal) element.showModal()
    else element?.setAttribute('open', '')
    return () => {
      request.current += 1
      element?.close?.()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  const readSingle = async (file: ImportableFile): Promise<void> => {
    const oversized = describeOversizedThemeFile(file.size)
    if (oversized) {
      setError(oversized)
      return
    }
    const id = ++request.current
    setBusy(true)
    try {
      const text = await file.text()
      if (id !== request.current) return
      setJson(text)
      setFileName(file.name)
      setError(null)
    } catch {
      if (id === request.current) setError('Could not read that file. Paste the JSON below instead.')
    } finally {
      if (id === request.current) setBusy(false)
    }
  }

  // Several files import as a batch: VS Code families pair their light and dark
  // variants, and everything installs without being made active.
  const readBatch = async (files: readonly ImportableFile[]): Promise<void> => {
    const id = ++request.current
    setBusy(true)
    const failures: string[] = []
    const parsed: Array<{ theme: ThemeDefinition; sourceName: string }> = []
    try {
      for (const file of files.slice(0, 40)) {
        const oversized = describeOversizedThemeFile(file.size)
        if (oversized) {
          failures.push(`${file.name}: too large`)
          continue
        }
        try {
          parsed.push({ sourceName: file.name, theme: parseImportedThemeText(await file.text()) })
        } catch (cause) {
          failures.push(`${file.name}: ${cause instanceof Error ? cause.message : 'not a theme file'}`)
        }
      }
      if (files.length > 40) failures.push(`Only the first 40 of ${files.length} files were read.`)
      if (id !== request.current) return
      const themes = pairVsCodeThemes(resolveThemeLabelCollisions(parsed))
      let conflicting: ThemeDefinition[] = []
      if (themes.length > 0) {
        const result = await writer.run(state => {
          const saved = new Set(state.customThemes.map(theme => theme.id))
          conflicting = themes.filter(theme => saved.has(theme.id))
          const fresh = themes.filter(theme => !saved.has(theme.id))
          return { patch: fresh.length > 0 ? installThemesPatch(state, fresh) : {}, fresh }
        })
        if (!result.saved) failures.push('The themes could not be saved.')
        else if (result.fresh.length > 0) onNotice(`${result.fresh.length === 1 ? `${result.fresh[0]!.label} added` : `${result.fresh.length} themes added`}: ${result.fresh.map(theme => theme.label).join(', ')}`)
      }
      if (failures.length > 0) setError(failures.join(' — '))
      else if (conflicting.length > 0) setConflicts(conflicting)
      else if (themes.length > 0) onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Those themes could not be added.')
    } finally {
      if (id === request.current) setBusy(false)
    }
  }

  const readFiles = (files: readonly ImportableFile[]): void => {
    if (files.length === 0) return
    if (files.length === 1) void readSingle(files[0]!)
    else void readBatch(files)
  }

  const submit = async (): Promise<void> => {
    let theme: ThemeDefinition
    try {
      theme = parseImportedThemeText(json)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That theme file is invalid.')
      return
    }
    setBusy(true)
    try {
      const result = await writer.run(state => {
        if (state.customThemes.some(existing => existing.id === theme.id)) return { patch: {}, conflict: true }
        // A one-appearance theme takes its own half; a full theme becomes active for both.
        return { patch: { ...installThemesPatch(state, [theme]), ...useThemePatch(theme) }, conflict: false }
      })
      if (result.conflict) {
        setError(null)
        setConflicts([theme])
        return
      }
      if (!result.saved) {
        setError('The theme could not be saved. Your saved themes are unchanged.')
        return
      }
      const modes = theme.variants ? 'It’s now active.' : `It’s now your ${theme.appearance} theme.`
      onNotice(`${theme.label} added. ${modes}`)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That theme could not be added.')
    } finally {
      setBusy(false)
    }
  }

  const resolveConflicts = async (mode: 'update' | 'copy'): Promise<void> => {
    if (!conflicts) return
    setBusy(true)
    const preferredName = conflicts.length === 1 && fileName ? humanizeThemeName(fileName.replace(/\.[^.]+$/u, '')) : null
    try {
      const result = await writer.run(state => {
        if (mode === 'update') {
          const updates = conflicts.map(theme => {
            const existing = state.customThemes.find(candidate => candidate.id === theme.id)
            return existing?.collection ? { ...theme, collection: existing.collection } : theme
          })
          return { patch: updateThemesPatch(state, updates), themes: updates }
        }
        let working = state
        const copies: ThemeDefinition[] = []
        for (const theme of conflicts) {
          const copy = versionedCopy(theme, working, preferredName)
          copies.push(copy)
          working = { ...working, customThemes: [...working.customThemes, copy] }
        }
        return { patch: installThemesPatch(state, copies), themes: copies }
      })
      if (!result.saved) {
        setError('The themes could not be saved. Your saved themes are unchanged.')
        return
      }
      onNotice(`${result.themes.length === 1 ? result.themes[0]!.label : `${result.themes.length} themes`} ${mode === 'update' ? 'updated' : 'added'}.`)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Those themes could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const dropHandlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDropTarget(true) },
    onDragOver: (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDropTarget(true) },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(false)
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDropTarget(false)
      readFiles([...event.dataTransfer.files])
    },
  }

  return (
    <dialog ref={dialog} className="theme-import" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose() }}>
      <header className="theme-import__head">
        <h2 id={titleId}>Add a theme</h2>
        <Button variant="ghost" iconOnly aria-label="Close Add a theme" onClick={onClose}><X size={16} aria-hidden="true" /></Button>
      </header>
      <div className="theme-import__body">
        <OpenVsxSearch writer={writer} onInstalled={message => { onNotice(message); onClose() }} />

        <div className="theme-import__divider" aria-hidden="true"><span>or import a file</span></div>

        {conflicts
          ? (
              <div className="theme-import__conflicts">
                <p className="theme-import__label">Already installed</p>
                <p className="theme-import__hint">{conflicts.map(theme => theme.label).join(', ')}</p>
                <div className="theme-import__actions">
                  <Button variant="primary" disabled={busy} onClick={() => void resolveConflicts('update')}>Update existing</Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void resolveConflicts('copy')}>Keep both</Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setConflicts(null)}>Back</Button>
                </div>
              </div>
            )
          : (
              <>
                <div className="theme-import__drop" data-drop-target={dropTarget || undefined} {...dropHandlers}>
                  <div>
                    <p className="theme-import__label">Theme file</p>
                    <p className="theme-import__hint">{fileName ?? 'Drop T3 Code or VS Code .json files'}</p>
                  </div>
                  <Button variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
                    <Download size={15} aria-hidden="true" />{busy ? 'Reading…' : 'Choose files'}
                  </Button>
                  <input
                    ref={fileInput}
                    className="theme-import__file"
                    type="file"
                    accept=".json,application/json"
                    multiple
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={event => {
                      const files = [...(event.currentTarget.files ?? [])]
                      event.currentTarget.value = ''
                      readFiles(files)
                    }}
                  />
                </div>
                <label className="theme-import__label" htmlFor={jsonId}>Theme JSON</label>
                <textarea
                  id={jsonId}
                  className="tt-input theme-import__json"
                  spellCheck={false}
                  rows={8}
                  placeholder={'{\n  "version": 1,\n  "name": "Aurora",\n  "appearance": "light",\n  "colors": { ... }\n}'}
                  value={json}
                  aria-invalid={error !== null || undefined}
                  onChange={event => {
                    setJson(event.currentTarget.value)
                    setError(null)
                  }}
                />
                <div className="theme-import__actions theme-import__actions--end">
                  <Button variant="ghost" onClick={onClose}>Cancel</Button>
                  <Button variant="primary" disabled={!json.trim() || busy} onClick={() => void submit()}>
                    <Plus size={15} aria-hidden="true" />Add theme
                  </Button>
                </div>
              </>
            )}
        {error === null ? null : <p className="theme-import__error" role="alert">{error}</p>}
      </div>
    </dialog>
  )
}

function OpenVsxSearch({ writer, onInstalled }: { readonly writer: ThemeLibraryWriter; readonly onInstalled: (message: string) => void }): ReactNode {
  const bridge = typeof window === 'undefined' ? undefined : window.sotto?.themes
  const headingId = useId()
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<OpenVsxThemeSort>('downloadCount')
  const [results, setResults] = useState<OpenVsxThemeExtension[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [pendingUpdate, setPendingUpdate] = useState<OpenVsxThemeExtension | null>(null)
  const searchId = useRef(0)

  const search = async (text: string, sort: OpenVsxThemeSort): Promise<void> => {
    const trimmed = text.trim()
    const id = ++searchId.current
    if (!trimmed || !bridge) {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    setError(null)
    const result = await bridge.searchOpenVsx({ query: trimmed, sortBy: sort }).catch(() => null)
    if (id !== searchId.current) return
    setSearching(false)
    if (result?.ok) setResults(result.value)
    else {
      setResults(null)
      setError(result?.error.message ?? 'Open VSX search is unavailable right now.')
    }
  }

  useEffect(() => {
    if (installing !== null) return
    const timer = setTimeout(() => void search(query, sortBy), query.trim() ? SEARCH_DEBOUNCE_MS : 0)
    return () => clearTimeout(timer)
  }, [query, sortBy])

  useEffect(() => () => { searchId.current += 1 }, [])

  const install = async (extension: OpenVsxThemeExtension, allowUpdate: boolean): Promise<void> => {
    if (!bridge) return
    const installedAlready = window.sotto !== undefined && isCollectionInstalled(writer, extension.collectionId)
    if (installedAlready && !allowUpdate) {
      setPendingUpdate(extension)
      return
    }
    setPendingUpdate(null)
    setError(null)
    setInstalling(extension.id)
    try {
      const result = await bridge.installOpenVsx({ namespace: extension.namespace, name: extension.name }).catch(() => null)
      if (!result?.ok) {
        setError(result?.error.message ?? 'That theme could not be added.')
        return
      }
      const saved = await writer.run(state => ({ patch: replaceCollectionPatch(state, result.value.extension.collectionId, result.value.themes) }))
      if (!saved.saved) {
        setError('The themes could not be saved. Your saved themes are unchanged.')
        return
      }
      const themes = result.value.themes
      onInstalled(`${themes.length === 1 ? themes[0]!.label : `${themes.length} themes`} ${installedAlready ? 'updated' : 'added'} from ${result.value.extension.displayName}.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That theme could not be added.')
    } finally {
      setInstalling(null)
    }
  }

  return (
    <section className="theme-search" aria-labelledby={headingId}>
      <h3 id={headingId}>Search community themes</h3>
      <p className="theme-import__hint">Find open-source VS Code color themes on Open VSX. Sotto downloads the extension, checks its checksum and license, and keeps only its colors.</p>
      {bridge === undefined
        ? <p className="theme-import__hint" role="status">Open VSX search is not available in this window.</p>
        : (
            <>
              <div className="theme-search__field">
                <Search size={15} aria-hidden="true" />
                <input
                  className="tt-input"
                  type="search"
                  aria-label="Search Open VSX themes"
                  placeholder="Search themes…"
                  maxLength={100}
                  value={query}
                  onChange={event => setQuery(event.currentTarget.value)}
                />
              </div>
              <div className="theme-search__toolbar">
                <span className="theme-import__hint">Popular</span>
                {SUGGESTED_SEARCHES.map(suggestion => (
                  <Button key={suggestion} variant="ghost" disabled={installing !== null} onClick={() => (query.trim() === suggestion ? void search(suggestion, sortBy) : setQuery(suggestion))}>{suggestion}</Button>
                ))}
                {results && results.length > 0
                  ? (
                      <select className="tt-input theme-search__sort" aria-label="Sort themes" value={sortBy} disabled={installing !== null} onChange={event => setSortBy(event.currentTarget.value as OpenVsxThemeSort)}>
                        {OPEN_VSX_SORTS.map(sort => <option key={sort} value={sort}>{SORT_LABELS[sort]}</option>)}
                      </select>
                    )
                  : null}
              </div>
            </>
          )}
      <p className="tt-visually-hidden" role="status">{searching ? 'Searching themes…' : results ? `${results.length} supported ${results.length === 1 ? 'theme' : 'themes'} found.` : ''}</p>
      {error === null ? null : <p className="theme-import__error" role="alert">{error}</p>}
      {pendingUpdate
        ? (
            <div className="theme-import__conflicts" role="group" aria-label={`Update ${pendingUpdate.displayName}`}>
              <p className="theme-import__label">Update “{pendingUpdate.displayName}”?</p>
              <p className="theme-import__hint">This replaces its installed variants, including any local edits. Variants no longer in the extension will be removed.</p>
              <div className="theme-import__actions">
                <Button variant="primary" onClick={() => void install(pendingUpdate, true)}>Update theme</Button>
                <Button variant="ghost" onClick={() => setPendingUpdate(null)}>Cancel</Button>
              </div>
            </div>
          )
        : null}
      {searching && results === null ? <p className="theme-import__hint">Searching themes…</p> : null}
      {results
        ? results.length === 0
          ? <p className="theme-search__empty">No supported open-source themes found. Try a broader search.</p>
          : (
              <ul className="theme-search__results">
                {results.map(extension => {
                  const installedAlready = isCollectionInstalled(writer, extension.collectionId)
                  const busy = installing === extension.id
                  const action = installedAlready ? 'Update' : 'Install'
                  return (
                    <li key={extension.id} className="theme-search__result">
                      <div>
                        <h4>{extension.displayName}</h4>
                        <p className="theme-import__hint">{extension.namespace} · {DOWNLOADS.format(extension.downloadCount)} downloads · {extension.license}</p>
                      </div>
                      <p className="theme-search__description">{extension.description || 'A community color theme for your editor.'}</p>
                      <div className="theme-search__result-actions">
                        {extension.sourceUrl && window.sotto?.openExternalLink
                          ? <Button variant="ghost" iconOnly aria-label={`View source for ${extension.displayName}`} onClick={() => void window.sotto?.openExternalLink?.(extension.sourceUrl!)}><ExternalLink size={14} aria-hidden="true" /></Button>
                          : null}
                        <Button variant="secondary" aria-label={`${busy ? (installedAlready ? 'Updating' : 'Installing') : action} ${extension.displayName}`} disabled={installing !== null} onClick={() => void install(extension, false)}>
                          {installedAlready ? <RefreshCw size={14} aria-hidden="true" /> : <PackagePlus size={14} aria-hidden="true" />}
                          {busy ? `${installedAlready ? 'Updating' : 'Installing'}…` : action}
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )
        : null}
    </section>
  )
}

function isCollectionInstalled(writer: ThemeLibraryWriter, collectionId: string): boolean {
  return writer.current().customThemes.some(theme => theme.collection?.id === collectionId)
}
