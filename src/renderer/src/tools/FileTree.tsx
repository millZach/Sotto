import React, { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight, File, FileImage, FileText, FileX, Folder, FolderOpen } from 'lucide-react'
import type { FilesBridge } from '../../../shared/files'
import { visibleRows, type FilesBrowserStore, type ThreadFiles, type TreeRow } from './filesBrowser'

const IMAGE = /\.(?:png|jpe?g|gif|webp)$/iu
const TEXT = /\.(?:md|markdown|mdx|txt|rst)$/iu

function EntryIcon({ row }: { row: TreeRow }): ReactNode {
  const entry = row.entry!
  if (entry.kind === 'unavailable') return <FileX size={16} aria-hidden="true" />
  if (entry.kind === 'directory') return row.expanded ? <FolderOpen size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />
  if (IMAGE.test(entry.name)) return <FileImage size={16} aria-hidden="true" />
  if (TEXT.test(entry.name)) return <FileText size={16} aria-hidden="true" />
  return <File size={16} aria-hidden="true" />
}

function missingFolder(row: TreeRow): boolean {
  return row.error?.code === 'path-unavailable' || row.error?.code === 'not-directory'
}

export interface FileTreeProps {
  readonly files: ThreadFiles
  readonly store: FilesBrowserStore
  readonly bridge: FilesBridge | undefined
  readonly label: string
}

/** One lazily listed folder level at a time, as a keyboard treeview with a single tab stop. */
export function FileTree({ files, store, bridge, label }: FileTreeProps): ReactNode {
  const { threadId } = files
  const rows = useMemo(() => visibleRows(files), [files])
  const entries = useMemo(() => rows.filter(row => row.kind === 'entry'), [rows])
  const scroller = useRef<HTMLDivElement>(null)
  const items = useRef(new Map<string, HTMLDivElement>())
  const focusIn = useRef(false)
  const tabStop = entries.find(row => row.entry!.path === files.focusedPath)?.entry!.path ?? entries[0]?.entry!.path

  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = store.scrollOf(threadId).tree
  }, [store, threadId])

  // Moving focus with the keyboard follows the row into view once it has rendered.
  useEffect(() => {
    if (!focusIn.current || tabStop === undefined || !(document.activeElement instanceof HTMLElement && document.activeElement.getAttribute('role') === 'treeitem')) return
    const element = items.current.get(tabStop)
    if (element && document.activeElement !== element) element.focus()
  }, [tabStop, rows])

  const open = (row: TreeRow): void => {
    const entry = row.entry!
    if (entry.kind === 'directory') store.toggleDirectory(bridge, threadId, entry.path)
    else if (entry.kind === 'file') store.openFile(bridge, threadId, entry.path)
    else store.focusPath(threadId, entry.path)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: TreeRow): void => {
    const entry = row.entry!
    const index = entries.indexOf(row)
    const move = (target: TreeRow | undefined): void => {
      if (!target) return
      event.preventDefault()
      store.focusPath(threadId, target.entry!.path)
    }
    switch (event.key) {
      case 'ArrowDown': return move(entries[index + 1])
      case 'ArrowUp': return move(entries[index - 1])
      case 'Home': return move(entries[0])
      case 'End': return move(entries[entries.length - 1])
      case 'ArrowRight':
        if (entry.kind !== 'directory') return
        event.preventDefault()
        if (!row.expanded) store.toggleDirectory(bridge, threadId, entry.path, true)
        else if (entries[index + 1]?.parent === entry.path) store.focusPath(threadId, entries[index + 1]!.entry!.path)
        return
      case 'ArrowLeft':
        event.preventDefault()
        if (entry.kind === 'directory' && row.expanded) store.toggleDirectory(bridge, threadId, entry.path, false)
        else if (row.parent) store.focusPath(threadId, row.parent)
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        open(row)
    }
  }

  return <div ref={scroller} className="files-tree" onScroll={event => store.setScroll(threadId, 'tree', event.currentTarget.scrollTop)}
    onFocus={() => { focusIn.current = true }} onBlur={event => { focusIn.current = event.currentTarget.contains(event.relatedTarget as Node | null) }}>
    <div role="tree" aria-label={label} className="files-tree__list">
      {rows.map(row => {
        const indent = { '--files-depth': row.depth } as React.CSSProperties
        if (row.kind !== 'entry') {
          return <div key={row.key} role="none" className="files-tree__status" data-kind={row.kind} style={indent}>
            {row.kind === 'loading' ? <span className="files-tree__loading">Loading…</span>
              : row.kind === 'empty' ? 'Empty folder'
                : row.kind === 'truncated' ? 'Showing the first 1,000 items'
                  : <><span>{missingFolder(row) ? 'This folder is no longer here.' : 'This folder could not be read.'}</span>
                    <button type="button" className="files-link tt-focusable" onClick={() => missingFolder(row)
                      ? store.recoverMissing(bridge, threadId, row.parent)
                      : store.reloadDirectory(bridge, threadId, row.parent)}>{missingFolder(row) ? 'Refresh' : 'Retry'}</button></>}
          </div>
        }
        const entry = row.entry!
        const selected = entry.kind === 'file' && files.selectedPath === entry.path
        return <div key={row.key} ref={element => { if (element) items.current.set(entry.path, element); else items.current.delete(entry.path) }}
          role="treeitem" className="files-tree__item" style={indent} data-kind={entry.kind} data-selected={selected || undefined}
          aria-level={row.depth + 1} aria-setsize={row.setSize} aria-posinset={row.position}
          aria-expanded={entry.kind === 'directory' ? row.expanded : undefined} aria-selected={entry.kind === 'file' ? selected : undefined}
          aria-disabled={entry.kind === 'unavailable' || undefined}
          title={entry.kind === 'unavailable' ? `${entry.name} is unavailable` : entry.path}
          tabIndex={entry.path === tabStop ? 0 : -1}
          onClick={() => open(row)} onKeyDown={event => onKeyDown(event, row)}>
          <span className="files-tree__chevron" aria-hidden="true">{entry.kind === 'directory' ? <ChevronRight size={14} /> : null}</span>
          <EntryIcon row={row} />
          <span className="files-tree__name">{entry.name}</span>
        </div>
      })}
    </div>
  </div>
}
