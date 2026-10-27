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
import type { MessageDescriptor } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { shownCompactCount, shownCount, shownDecimal } from '../../../state/interfaceNumbers'

import { MAX_THEME_FILE_BYTES, OPEN_VSX_SORTS, type OpenVsxThemeExtension, type OpenVsxThemeSort } from '../../../../../shared/themes/bridge'
import { parseJsonc } from '../../../../../shared/themes/jsonc'
import { parseThemeFile, type ThemeDefinition } from '../../../../../shared/themes/library'
import { isVsCodeThemeFile, humanizeThemeName, pairVsCodeThemes, parseVsCodeThemeFile, resolveThemeLabelCollisions } from '../../../../../shared/themes/vscodeImport'
import { Button } from '../../../components/Button'
import { shownWords, type LaterWords } from '../laterWords'
import {
  installThemesPatch,
  replaceCollectionPatch,
  updateThemesPatch,
  useThemePatch,
  versionedCopy,
  ThemeLibraryError,
  type ThemeLibraryWriter,
} from './themeLibrary'

const SORT_LABELS: Readonly<Record<OpenVsxThemeSort, MessageDescriptor>> = {
  downloadCount: msg`Most downloaded`,
  rating: msg`Best rated`,
  timestamp: msg`Newest`,
  relevance: msg`Most relevant`,
}
// Theme names people search for, not words.
const SUGGESTED_SEARCHES = ['Dracula', 'Catppuccin', 'Nord', 'Tokyo Night']
const SEARCH_DEBOUNCE_MS = 350
/** A file size with its number written in the interface language, English ungrouped as before. The units stay as written. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${shownDecimal(bytes / (1024 * 1024), 1)} MB`
  if (bytes >= 1024) return `${shownCount(Math.round(bytes / 1024))} KB`
  return `${shownCount(bytes)} bytes`
}

/** The message for a file too large to be a theme, else null. The size is checked before any byte is read. */
function oversizedThemeFile(bytes: number): MessageDescriptor | null {
  if (bytes <= MAX_THEME_FILE_BYTES) return null
  const size = formatBytes(bytes)
  const limit = formatBytes(MAX_THEME_FILE_BYTES)
  return msg`That file is ${size}. Theme files are only a few KB, so this one was not read (limit ${limit}).`
}

/** The same message, as it reads now. */
export function describeOversizedThemeFile(bytes: number): string | null {
  return shownWords(oversizedThemeFile(bytes))
}

/** What to show for a failure: a refusal Sotto wrote, read when shown; another error's own words; or the fallback. */
function wordsOf(cause: unknown, fallback: MessageDescriptor): LaterWords {
  return cause instanceof ThemeLibraryError ? cause.words : cause instanceof Error ? cause.message : fallback
}

/** Parse pasted or file text as a T3 Code theme file or a VS Code colour theme. Throws a message fit to show. */
export function parseImportedThemeText(text: string): ThemeDefinition {
  const oversized = oversizedThemeFile(new TextEncoder().encode(text).byteLength)
  if (oversized) throw new ThemeLibraryError(oversized)
  let value: unknown
  try {
    value = parseJsonc(text)
  } catch {
    throw new ThemeLibraryError(msg`That is not valid JSON. Check for a missing comma or quote.`)
  }
  return isVsCodeThemeFile(value) ? parseVsCodeThemeFile(value) : parseThemeFile(value)
}

interface ImportableFile { readonly name: string; readonly size: number; readonly text: () => Promise<string> }

export interface ThemeImportDialogProps {
  readonly writer: ThemeLibraryWriter
  readonly onClose: () => void
  readonly onNotice: (message: LaterWords) => void
}

/** One failed file in a batch, its name beside why; or a failure of the whole batch. */
type BatchFailure = LaterWords | { readonly file: string; readonly reason: LaterWords }

export function ThemeImportDialog({ writer, onClose, onNotice }: ThemeImportDialogProps): ReactNode {
  const { t } = useLingui()
  const dialog = useRef<HTMLDialogElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const titleId = useId()
  const jsonId = useId()
  const [json, setJson] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  // A batch keeps each failure apart and joins them as they are shown.
  const [error, setError] = useState<LaterWords | readonly BatchFailure[] | null>(null)
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
    const oversized = oversizedThemeFile(file.size)
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
      if (id === request.current) setError(msg`Could not read that file. Paste the JSON below instead.`)
    } finally {
      if (id === request.current) setBusy(false)
    }
  }

  // Several files import as a batch: VS Code families pair their light and dark
  // variants, and everything installs without being made active.
  const readBatch = async (files: readonly ImportableFile[]): Promise<void> => {
    const id = ++request.current
    setBusy(true)
    const failures: BatchFailure[] = []
    const parsed: Array<{ theme: ThemeDefinition; sourceName: string }> = []
    try {
      for (const file of files.slice(0, 40)) {
        const fileName = file.name
        if (oversizedThemeFile(file.size)) {
          failures.push(msg`${fileName}: too large`)
          continue
        }
        try {
          parsed.push({ sourceName: file.name, theme: parseImportedThemeText(await file.text()) })
        } catch (cause) {
          failures.push({ file: fileName, reason: wordsOf(cause, msg`not a theme file`) })
        }
      }
      const fileCount = files.length, filesShown = shownCount(fileCount)
      if (fileCount > 40) failures.push(msg`${plural(fileCount, { other: `Only the first 40 of ${filesShown} files were read.` })}`)
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
        const names = result.fresh.map(theme => theme.label).join(', ')
        const name = result.fresh[0]?.label ?? ''
        const added = result.fresh.length
        if (!result.saved) failures.push(msg`The themes could not be saved.`)
        else if (result.fresh.length === 1) onNotice(msg`${name} added: ${names}`)
        else if (result.fresh.length > 0) onNotice(msg`${plural(added, { other: `# themes added: ${names}` })}`)
      }
      if (failures.length > 0) setError(failures)
      else if (conflicting.length > 0) setConflicts(conflicting)
      else if (themes.length > 0) onClose()
    } catch (cause) {
      setError(wordsOf(cause, msg`Those themes could not be added.`))
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
      setError(wordsOf(cause, msg`That theme file is invalid.`))
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
        setError(msg`The theme could not be saved. Your saved themes are unchanged.`)
        return
      }
      const name = theme.label
      onNotice(theme.variants ? msg`${name} added. It’s now active.`
        : theme.appearance === 'light' ? msg`${name} added. It’s now your light theme.` : msg`${name} added. It’s now your dark theme.`)
      onClose()
    } catch (cause) {
      setError(wordsOf(cause, msg`That theme could not be added.`))
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
        setError(msg`The themes could not be saved. Your saved themes are unchanged.`)
        return
      }
      const count = result.themes.length
      const name = result.themes[0]?.label ?? ''
      onNotice(mode === 'update'
        ? count === 1 ? msg`${name} updated.` : msg`${plural(count, { other: '# themes updated.' })}`
        : count === 1 ? msg`${name} added.` : msg`${plural(count, { other: '# themes added.' })}`)
      onClose()
    } catch (cause) {
      setError(wordsOf(cause, msg`Those themes could not be saved.`))
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
        <h2 id={titleId}><Trans>Add a theme</Trans></h2>
        <Button variant="ghost" iconOnly aria-label={t`Close Add a theme`} onClick={onClose}><X size={16} aria-hidden="true" /></Button>
      </header>
      <div className="theme-import__body">
        <OpenVsxSearch writer={writer} onInstalled={message => { onNotice(message); onClose() }} />

        <div className="theme-import__divider" aria-hidden="true"><span><Trans>or import a file</Trans></span></div>

        {conflicts
          ? (
              <div className="theme-import__conflicts">
                <p className="theme-import__label"><Trans>Already installed</Trans></p>
                <p className="theme-import__hint">{conflicts.map(theme => theme.label).join(', ')}</p>
                <div className="theme-import__actions">
                  <Button variant="primary" disabled={busy} onClick={() => void resolveConflicts('update')}><Trans>Update existing</Trans></Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void resolveConflicts('copy')}><Trans>Keep both</Trans></Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setConflicts(null)}>{t({ message: 'Back', comment: 'Leaves the choice between updating and keeping both' })}</Button>
                </div>
              </div>
            )
          : (
              <>
                <div className="theme-import__drop" data-drop-target={dropTarget || undefined} {...dropHandlers}>
                  <div>
                    <p className="theme-import__label"><Trans>Theme file</Trans></p>
                    <p className={fileName === null ? 'theme-import__hint tt-paragraph' : 'theme-import__hint'}>{fileName ?? t`Drop T3 Code or VS Code .json files`}</p>
                  </div>
                  <Button variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
                    <Download size={15} aria-hidden="true" />{busy ? t`Reading…` : t`Choose files`}
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
                <label className="theme-import__label" htmlFor={jsonId}><Trans>Theme JSON</Trans></label>
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
                  <Button variant="ghost" onClick={onClose}><Trans>Cancel</Trans></Button>
                  <Button variant="primary" disabled={!json.trim() || busy} onClick={() => void submit()}>
                    <Plus size={15} aria-hidden="true" /><Trans>Add theme</Trans>
                  </Button>
                </div>
              </>
            )}
        {error === null ? null : <p className="theme-import__error tt-paragraph" role="alert">{Array.isArray(error) ? error.map(failureWords).join(' — ') : shownWords(error as LaterWords)}</p>}
      </div>
    </dialog>
  )
}

/** A batch failure as it reads now: a file's name beside why it failed, or the failure itself. */
function failureWords(failure: BatchFailure): string {
  return typeof failure === 'object' && 'file' in failure ? `${failure.file}: ${shownWords(failure.reason)}` : shownWords(failure)
}

function OpenVsxSearch({ writer, onInstalled }: { readonly writer: ThemeLibraryWriter; readonly onInstalled: (message: LaterWords) => void }): ReactNode {
  const { t, i18n } = useLingui()
  const bridge = typeof window === 'undefined' ? undefined : window.sotto?.themes
  const headingId = useId()
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<OpenVsxThemeSort>('downloadCount')
  const [results, setResults] = useState<OpenVsxThemeExtension[] | null>(null)
  const found = results?.length ?? 0
  const [error, setError] = useState<LaterWords | null>(null)
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
      setError(result?.error.message ?? msg`Open VSX search is unavailable right now.`)
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
        setError(result?.error.message ?? msg`That theme could not be added.`)
        return
      }
      const saved = await writer.run(state => ({ patch: replaceCollectionPatch(state, result.value.extension.collectionId, result.value.themes) }))
      if (!saved.saved) {
        setError(msg`The themes could not be saved. Your saved themes are unchanged.`)
        return
      }
      const themes = result.value.themes
      const name = themes[0]?.label ?? ''
      const extensionName = result.value.extension.displayName
      const count = themes.length
      onInstalled(installedAlready
        ? themes.length === 1 ? msg`${name} updated from ${extensionName}.` : msg`${plural(count, { other: `# themes updated from ${extensionName}.` })}`
        : themes.length === 1 ? msg`${name} added from ${extensionName}.` : msg`${plural(count, { other: `# themes added from ${extensionName}.` })}`)
    } catch (cause) {
      setError(wordsOf(cause, msg`That theme could not be added.`))
    } finally {
      setInstalling(null)
    }
  }

  const pendingName = pendingUpdate?.displayName ?? ''
  return (
    <section className="theme-search" aria-labelledby={headingId}>
      <h3 id={headingId}><Trans>Search community themes</Trans></h3>
      <p className="theme-import__hint tt-paragraph"><Trans>Find open-source VS Code color themes on Open VSX. Sotto downloads the extension, checks its checksum and license, and keeps only its colors.</Trans></p>
      {bridge === undefined
        ? <p className="theme-import__hint tt-paragraph" role="status"><Trans>Open VSX search is not available in this window.</Trans></p>
        : (
            <>
              <div className="theme-search__field">
                <Search size={15} aria-hidden="true" />
                <input
                  className="tt-input"
                  type="search"
                  aria-label={t`Search Open VSX themes`}
                  placeholder={t`Search themes…`}
                  maxLength={100}
                  value={query}
                  onChange={event => setQuery(event.currentTarget.value)}
                />
              </div>
              <div className="theme-search__toolbar">
                <span className="theme-import__hint">{t({ message: 'Popular', comment: 'Precedes theme names people often search for' })}</span>
                {SUGGESTED_SEARCHES.map(suggestion => (
                  <Button key={suggestion} variant="ghost" disabled={installing !== null} onClick={() => (query.trim() === suggestion ? void search(suggestion, sortBy) : setQuery(suggestion))}>{suggestion}</Button>
                ))}
                {results && results.length > 0
                  ? (
                      <select className="tt-input theme-search__sort" aria-label={t`Sort themes`} value={sortBy} disabled={installing !== null} onChange={event => setSortBy(event.currentTarget.value as OpenVsxThemeSort)}>
                        {OPEN_VSX_SORTS.map(sort => <option key={sort} value={sort}>{i18n._(SORT_LABELS[sort])}</option>)}
                      </select>
                    )
                  : null}
              </div>
            </>
          )}
      <p className="tt-visually-hidden tt-paragraph" role="status">{searching ? t`Searching themes…` : results ? plural(found, { one: '# supported theme found.', other: '# supported themes found.' }) : ''}</p>
      {error === null ? null : <p className="theme-import__error tt-paragraph" role="alert">{shownWords(error)}</p>}
      {pendingUpdate
        ? (
            <div className="theme-import__conflicts" role="group" aria-label={t`Update ${pendingName}`}>
              <p className="theme-import__label"><Trans>Update “{pendingName}”?</Trans></p>
              <p className="theme-import__hint tt-paragraph"><Trans>This replaces its installed variants, including any local edits. Variants no longer in the extension will be removed.</Trans></p>
              <div className="theme-import__actions">
                <Button variant="primary" onClick={() => void install(pendingUpdate, true)}><Trans>Update theme</Trans></Button>
                <Button variant="ghost" onClick={() => setPendingUpdate(null)}><Trans>Cancel</Trans></Button>
              </div>
            </div>
          )
        : null}
      {searching && results === null ? <p className="theme-import__hint tt-paragraph"><Trans>Searching themes…</Trans></p> : null}
      {results
        ? results.length === 0
          ? <p className="theme-search__empty tt-paragraph"><Trans>No supported open-source themes found. Try a broader search.</Trans></p>
          : (
              <ul className="theme-search__results">
                {results.map(extension => {
                  const installedAlready = isCollectionInstalled(writer, extension.collectionId)
                  const busy = installing === extension.id
                  const extensionName = extension.displayName
                  const downloadCount = extension.downloadCount
                  // A short number, 1.2K: in English the computer's own short form, as it always was.
                  const downloads = shownCompactCount(downloadCount)
                  const label = busy
                    ? installedAlready ? t`Updating ${extensionName}` : t`Installing ${extensionName}`
                    : installedAlready ? t`Update ${extensionName}` : t`Install ${extensionName}`
                  const shown = busy
                    ? installedAlready ? t`Updating…` : t`Installing…`
                    : installedAlready ? t({ message: 'Update', comment: 'Updates an installed theme extension' }) : t({ message: 'Install', comment: 'Installs a theme extension' })
                  return (
                    <li key={extension.id} className="theme-search__result">
                      <div>
                        <h4>{extension.displayName}</h4>
                        <p className="theme-import__hint">{extension.namespace} · {plural(downloadCount, { other: `${downloads} downloads` })} · {extension.license}</p>
                      </div>
                      <p className={extension.description ? 'theme-search__description' : 'theme-search__description tt-paragraph'}>{extension.description || t`A community color theme for your editor.`}</p>
                      <div className="theme-search__result-actions">
                        {extension.sourceUrl && window.sotto?.openExternalLink
                          ? <Button variant="ghost" iconOnly aria-label={t`View source for ${extensionName}`} onClick={() => void window.sotto?.openExternalLink?.(extension.sourceUrl!)}><ExternalLink size={14} aria-hidden="true" /></Button>
                          : null}
                        <Button variant="secondary" aria-label={label} disabled={installing !== null} onClick={() => void install(extension, false)}>
                          {installedAlready ? <RefreshCw size={14} aria-hidden="true" /> : <PackagePlus size={14} aria-hidden="true" />}
                          {shown}
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
