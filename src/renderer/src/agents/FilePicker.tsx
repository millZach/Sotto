import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { RotateCw } from 'lucide-react'
import type { AgentFileReference } from '../../../shared/agentFiles'
import type { FilesBridge } from '../../../shared/files'
import { detectFileTrigger, fileLimitReached, fileQueryParts, MAX_MENTIONED_FILES, searchFileEntries, unmentionableCount, type FileEntry, type FileTrigger } from './composerFiles'

type Listing =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly FileEntry[]; readonly truncated: boolean }
  | { readonly status: 'error'; readonly message: string }

interface Catalog {
  readonly threadId: string
  /** From the first root listing; every deeper request carries it, so a replaced folder is refused. */
  readonly workspaceId: string | null
  readonly listings: ReadonlyMap<string, Listing>
}

export interface FilePickerModel {
  /** This composer can browse files at all: it is editable and this window has the Files bridge. */
  readonly enabled: boolean
  readonly open: boolean
  readonly trigger: FileTrigger | null
  /** The working-copy folder being listed; '' is the working copy's own root. */
  readonly directory: string
  readonly options: readonly FileEntry[]
  readonly activeIndex: number | null
  readonly listing: Listing | undefined
  readonly truncated: boolean
  readonly move: (offset: 1 | -1) => void
  readonly highlight: (index: number) => void
  readonly close: () => void
  readonly refresh: () => void
  /** The caret or selection moved in the textarea. */
  readonly track: (element: HTMLTextAreaElement) => void
  /** Focus left the composer's text and the picker. */
  readonly leave: () => void
}

/** The Files bridge this window was given; without it the composer says so rather than guessing at paths. */
export function composerFilesBridge(): FilesBridge | undefined {
  return (window.sotto as { files?: FilesBridge } | undefined)?.files
}

const empty = (threadId: string): Catalog => ({ threadId, workspaceId: null, listings: new Map() })
const UNAVAILABLE = 'Files is not available in this window.'

/**
 * The `@` picker's state for one thread's composer. It browses exactly the listing the Files tool
 * shows — main resolves the thread's working copy itself and refuses anything outside it — so this
 * hook never resolves a path of its own. Nothing here edits the draft.
 */
export function useFilePicker({ threadId, bridge, enabled, text }: {
  readonly threadId: string; readonly bridge: FilesBridge | undefined; readonly enabled: boolean; readonly text: string
}): FilePickerModel {
  const [selection, setSelection] = useState<{ readonly start: number; readonly end: number } | null>(null)
  const [active, setActive] = useState<{ readonly key: string; readonly index: number } | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<Catalog>(() => empty(threadId))
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const current = catalog.threadId === threadId ? catalog : empty(threadId)
  // Without the Files bridge this window cannot browse anything, so an @ stays ordinary text.
  const browsable = enabled && bridge !== undefined
  const trigger = browsable && selection !== null ? detectFileTrigger(text, selection.start, selection.end) : null
  const { directory, filter } = fileQueryParts(trigger?.query ?? '')
  const openKey = trigger === null ? null : `${threadId}\n${trigger.start}`
  const open = trigger !== null && dismissed !== openKey
  const listing = open ? current.listings.get(directory) : undefined
  const options = listing?.status === 'ready' ? searchFileEntries(listing.entries, filter) : []
  const queryKey = open ? `${openKey}\n${trigger.query}` : null
  const chosen = active !== null && active.key === queryKey ? active.index : null
  const activeIndex = options.length === 0 ? null : chosen !== null ? Math.min(chosen, options.length - 1) : 0

  const put = useCallback((path: string, state: Listing, workspaceId?: string): void => {
    if (!mounted.current) return
    setCatalog(previous => {
      const base = previous.threadId === threadId ? previous : empty(threadId)
      const listings = new Map(base.listings)
      listings.set(path, state)
      return { threadId, workspaceId: workspaceId ?? base.workspaceId, listings }
    })
  }, [threadId])

  const load = useCallback(async (path: string, workspaceId: string | null): Promise<void> => {
    put(path, { status: 'loading' })
    if (!bridge) { put(path, { status: 'error', message: UNAVAILABLE }); return }
    try {
      // A deeper folder needs the root's workspace token, so the root is always listed first.
      let token = workspaceId
      if (path !== '' && token === null) {
        const root = await bridge.list({ threadId, path: '' })
        if (!root.ok) { put(path, { status: 'error', message: root.error.message }); return }
        token = root.value.workspace.workspaceId
        put('', { status: 'ready', entries: root.value.entries, truncated: root.value.truncated }, token)
      }
      const result = await bridge.list({ threadId, path, ...(path === '' || token === null ? {} : { workspaceId: token }) })
      if (!result.ok) { put(path, { status: 'error', message: result.error.message }); return }
      put(path, { status: 'ready', entries: result.value.entries, truncated: result.value.truncated }, result.value.workspace.workspaceId)
    } catch { put(path, { status: 'error', message: 'Files could not be reached.' }) }
  }, [bridge, put, threadId])

  const known = listing !== undefined
  useEffect(() => {
    if (!open || known) return
    void load(directory, current.workspaceId)
  }, [open, known, directory, load, current.workspaceId])
  const noTrigger = trigger === null
  useEffect(() => { if (noTrigger && dismissed !== null) setDismissed(null) }, [noTrigger, dismissed])

  return {
    enabled: browsable, open, trigger: open ? trigger : null, directory, options, activeIndex, listing,
    truncated: listing?.status === 'ready' && listing.truncated,
    move: offset => {
      if (queryKey === null || options.length === 0) return
      const from = activeIndex ?? (offset === 1 ? -1 : options.length)
      setActive({ key: queryKey, index: (from + offset + options.length) % options.length })
    },
    highlight: index => { if (queryKey !== null) setActive({ key: queryKey, index }) },
    close: () => { if (openKey !== null) setDismissed(openKey) },
    refresh: () => { if (open) void load(directory, current.workspaceId) },
    leave: () => setSelection(null),
    track: element => {
      const next = { start: element.selectionStart, end: element.selectionEnd }
      setSelection(state => state?.start === next.start && state.end === next.end ? state : next)
    },
  }
}

export const fileOptionId = (listId: string, index: number): string => `${listId}-option-${index}`

/**
 * The working copy's files above the composer's text. It wears the composer menu's own styles;
 * it shows what the Files service listed and never filters the working copy on its own.
 */
export function FilePicker({ model, listId, selected = [], onSelect }: {
  readonly model: FilePickerModel
  readonly listId: string
  /** Files already mentioned in this draft, for the per-prompt limit. */
  readonly selected?: readonly AgentFileReference[]
  /** A folder continues browsing; a file is mentioned in the draft. */
  readonly onSelect: (entry: FileEntry) => void
}): ReactNode {
  const list = useRef<HTMLUListElement>(null)
  const { trigger, options, activeIndex, listing, directory } = model
  useLayoutEffect(() => {
    if (activeIndex === null) return
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(fileOptionId(listId, activeIndex))}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, listId])
  if (!model.open || trigger === null) return null
  const failed = listing?.status === 'error' ? listing.message : null
  const { filter } = fileQueryParts(trigger.query)
  const spaced = listing?.status === 'ready' ? unmentionableCount(listing.entries) : 0
  const message = failed !== null ? failed
    : listing === undefined || listing.status !== 'ready' ? 'Loading files…'
      : listing.entries.length === 0 ? `${directory || 'This working copy'} has nothing to mention.`
        : options.length === 0 ? `No files match “${filter}”.` : null
  // The limit is the draft's, not this folder's: entries stay listed, and folders still browse.
  const full = options.some(entry => entry.kind !== 'directory' && fileLimitReached(selected, entry.path))
  return <div className="composer-picker file-picker" data-kind="file">
    {message === null ? <ul ref={list} className="composer-picker__list" role="listbox" id={listId} aria-label="Files">
      {options.map((entry, index) => {
        const over = entry.kind !== 'directory' && fileLimitReached(selected, entry.path)
        return <li key={entry.path} id={fileOptionId(listId, index)} role="option" aria-selected={index === activeIndex} aria-disabled={over || undefined}
          className="composer-picker__option" data-active={index === activeIndex || undefined}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (index !== activeIndex) model.highlight(index) }} onClick={() => { if (!over) onSelect(entry) }}>
          <span className="composer-picker__name">{entry.kind === 'directory' ? `${entry.name}/` : entry.name}</span>
          <span className="composer-picker__description">{entry.path}</span>
        </li>
      })}
    </ul> : null}
    <div className="composer-picker__foot" data-message={message !== null || undefined}>
      <span className="composer-picker__notes">
        {message !== null ? <span className="composer-picker__message" role={failed !== null ? 'alert' : 'status'} data-tone={failed !== null ? 'warning' : undefined}>{message}</span> : null}
        {full ? <span className="composer-picker__limit" role="status">{`A prompt mentions at most ${MAX_MENTIONED_FILES} files. Remove one to mention another.`}</span>
          : message === null ? <span>{options[activeIndex ?? 0]?.kind === 'directory' ? 'Enter or Tab opens the folder' : 'Enter or Tab mentions the file'}</span> : null}
        {model.truncated ? <span data-tone="warning">Only the first entries of this folder are listed. Keep typing to narrow them.</span> : null}
        {spaced > 0 ? <span data-tone="warning">{spaced === 1 ? '1 entry has a space in its name and cannot be mentioned' : `${spaced} entries have spaces in their names and cannot be mentioned`}</span> : null}
      </span>
      <button type="button" className="composer-picker__refresh tt-focusable" data-loading={listing?.status === 'loading' || undefined} disabled={listing?.status === 'loading'}
        onMouseDown={event => event.preventDefault()} onClick={() => model.refresh()}>
        <RotateCw size={14} aria-hidden="true" />{listing?.status === 'loading' ? 'Refreshing' : failed !== null ? 'Try again' : 'Refresh'}
      </button>
    </div>
  </div>
}
