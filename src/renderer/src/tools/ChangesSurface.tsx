import React, { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Columns2, Copy, FolderOutput, RotateCw, X } from 'lucide-react'
import type { GitChange, GitChangesBridge, GitFileDiff } from '../../../shared/gitChanges'
import type { ToolsError } from '../../../shared/tools'
import { revealLabel } from './FilePreview'
import { CHANGE_STATUS, parseUnifiedDiff, useThreadChanges, type ChangesStore, type DiffLine } from './changesStore'

/** A long patch shows this many rows first; the rest is one action away so a huge diff never stalls the panel. */
export const DIFF_ROW_LIMIT = 3_000

function splitPath(path: string): { readonly folder: string; readonly name: string } {
  const index = path.lastIndexOf('/')
  return index < 0 ? { folder: '', name: path } : { folder: path.slice(0, index + 1), name: path.slice(index + 1) }
}

function listProblem(error: ToolsError, bridge: boolean): string {
  if (!bridge) return 'Changes is not available in this window.'
  switch (error.code) {
    case 'not-repository': return 'This working folder is not a Git repository.'
    case 'thread-unavailable': return 'This thread is not available to Changes.'
    case 'workspace-unavailable': return 'The working folder is not available.'
    case 'busy': return 'Git is busy.'
    default: return error.message || 'Changes could not read Git.'
  }
}

export interface ChangesSurfaceProps {
  readonly threadId: string
  readonly store: ChangesStore
  readonly bridge: GitChangesBridge | undefined
  readonly platform?: string | undefined
  readonly onStatus: (message: string) => void
}

/** The working copy's changes against HEAD: the file list beside its selected diff. Review only. */
export function ChangesSurface({ threadId, store, bridge, platform, onStatus }: ChangesSurfaceProps): ReactNode {
  const changes = useThreadChanges(store, threadId)
  const [split, setSplit] = useState(false)
  if (!changes) return <p className="files-preview__loading" role="status">Loading…</p>
  const { list, selectedPath, diff } = changes
  if (list.status === 'loading') return <p className="files-preview__loading" role="status">Reading changes…</p>
  if (list.status === 'error') {
    const repository = list.error.code !== 'not-repository'
    return <div className="files-problem files-problem--root" role="status">
      <strong>{listProblem(list.error, bridge !== undefined)}</strong>
      {bridge && repository ? <button type="button" className="files-link tt-focusable" onClick={() => void store.refresh(bridge, threadId)}>Try again</button> : null}
    </div>
  }
  const copy = (path: string): void => { void store.copyPath(bridge, threadId, path).then(result => onStatus(result.ok ? 'Path copied' : 'Could not copy the path')) }
  const reveal = (path: string): void => { void store.reveal(bridge, threadId, path).then(result => { if (!result.ok) onStatus('Could not open the folder') }) }
  const selected = selectedPath === null ? undefined : list.files.find(file => file.path === selectedPath)
  return <div className="changes-surface" data-diff={selectedPath !== null || undefined}>
    <div className="changes-summary">
      <span className="changes-summary__text">{list.files.length === 0 ? 'No changes' : `${list.files.length}${list.truncated ? '+' : ''} changed ${list.files.length === 1 ? 'file' : 'files'}`}
        {list.branch ? <> on <bdi className="changes-summary__branch">{list.branch}</bdi></> : null}</span>
      <button type="button" className="files-icon files-icon--small tt-focusable" aria-label="Refresh changes" title="Refresh changes" data-busy={changes.refreshing || undefined}
        onClick={() => void store.refresh(bridge, threadId)}><RotateCw size={14} aria-hidden="true" /></button>
    </div>
    {list.files.length === 0
      ? <div className="files-problem" role="status"><strong>The working copy matches HEAD.</strong></div>
      : <ChangeList files={list.files} selectedPath={selectedPath} onSelect={path => store.select(bridge, threadId, path)} />}
    {list.truncated ? <p className="changes-note">Git reported more files than Sotto lists.</p> : null}
    {selectedPath !== null ? <section className="changes-diff" aria-label={`Changes in ${selectedPath}`}>
      <header className="files-preview__head">
        <div className="files-preview__title">
          {selected ? <span className="changes-badge" data-status={selected.status} title={CHANGE_STATUS[selected.status].label}>{CHANGE_STATUS[selected.status].letter}</span> : null}
          <span className="files-preview__name" title={selectedPath}>{splitPath(selectedPath).name}</span>
        </div>
        <div className="files-preview__actions">
          <button type="button" className="files-icon tt-focusable" aria-label="Split view" aria-pressed={split} title={split ? 'Show unified diff' : 'Show split diff'} onClick={() => setSplit(value => !value)}><Columns2 size={16} aria-hidden="true" /></button>
          <button type="button" className="files-icon tt-focusable" aria-label={`Copy path: ${selectedPath}`} title="Copy path" onClick={() => copy(selectedPath)}><Copy size={16} aria-hidden="true" /></button>
          <button type="button" className="files-icon tt-focusable" aria-label={`${revealLabel(platform)}: ${selectedPath}`} title={revealLabel(platform)} onClick={() => reveal(selectedPath)}><FolderOutput size={16} aria-hidden="true" /></button>
          <button type="button" className="files-icon tt-focusable" aria-label="Close diff" title="Close diff" onClick={() => {
            document.querySelector<HTMLElement>(`[data-change-path="${CSS.escape(selectedPath)}"]`)?.focus()
            store.select(bridge, threadId, null)
          }}><X size={16} aria-hidden="true" /></button>
        </div>
      </header>
      {selected?.originalPath ? <p className="changes-note">Renamed from <code>{selected.originalPath}</code></p> : null}
      {diff === null || diff.status === 'loading' && !diff.previous ? <p className="files-preview__loading" role="status">Loading diff…</p>
        : diff.status === 'error' ? <div className="files-problem" role="status"><strong>{diff.error.code === 'path-unavailable' ? 'This file is no longer changed.' : 'The diff could not load.'}</strong>
          <button type="button" className="files-link tt-focusable" onClick={() => store.select(bridge, threadId, selectedPath)}>Try again</button></div>
          : <DiffBody key={`${threadId}\n${selectedPath}`} diff={diff.status === 'ready' ? diff.diff : diff.previous!} scrollTop={store.scrollOf(threadId, selectedPath)}
            split={split} onScroll={top => store.setScroll(threadId, selectedPath, top)} onReveal={() => reveal(selectedPath)} platform={platform} />}
    </section> : null}
  </div>
}

function ChangeList({ files, selectedPath, onSelect }: { readonly files: readonly GitChange[]; readonly selectedPath: string | null; readonly onSelect: (path: string) => void }): ReactNode {
  const list = useRef<HTMLUListElement>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const current = files.some(file => file.path === focused) ? focused : selectedPath ?? files[0]?.path ?? null
  const move = (event: KeyboardEvent<HTMLUListElement>): void => {
    const index = files.findIndex(file => file.path === current)
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? files.length - 1 : null
    if (next === null) return
    event.preventDefault()
    const file = files[Math.max(0, Math.min(files.length - 1, next))]
    if (!file) return
    setFocused(file.path)
    list.current?.querySelector<HTMLElement>(`[data-change-path="${CSS.escape(file.path)}"]`)?.focus()
  }
  // A short window shrinks the list to a row while a diff is open; the selected file stays the row that shows.
  useLayoutEffect(() => {
    const element = list.current
    if (!element || selectedPath === null) return
    const keepSelected = (): void => {
      const row = element.querySelector<HTMLElement>(`[data-change-path="${CSS.escape(selectedPath)}"]`)
      if (!row) return
      const box = element.getBoundingClientRect()
      const item = row.getBoundingClientRect()
      const inset = Number.parseFloat(getComputedStyle(element).paddingTop) || 0
      if (item.top < box.top + inset) element.scrollTop -= box.top + inset - item.top
      else if (item.bottom > box.bottom - inset) element.scrollTop += item.bottom - (box.bottom - inset)
    }
    keepSelected()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(keepSelected)
    observer.observe(element)
    return () => observer.disconnect()
  }, [selectedPath])
  return <ul ref={list} className="changes-list" role="listbox" aria-label="Changed files" onKeyDown={move}>
    {files.map(file => {
      const { folder, name } = splitPath(file.path)
      const status = CHANGE_STATUS[file.status]
      return <li key={file.path} role="option" aria-selected={file.path === selectedPath} tabIndex={file.path === current ? 0 : -1} data-change-path={file.path}
        className="changes-list__item" data-selected={file.path === selectedPath || undefined}
        aria-label={`${name}, ${status.label}${folder ? `, in ${folder}` : ''}`}
        onFocus={() => setFocused(file.path)} onClick={() => onSelect(file.path)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(file.path) } }}>
        <span className="changes-badge" data-status={file.status} aria-hidden="true">{status.letter}</span>
        <span className="changes-list__name">{name}</span>
        {folder ? <span className="changes-list__folder" dir="auto">{folder}</span> : null}
      </li>
    })}
  </ul>
}

const DiffRows = memo(function DiffRows({ lines }: { readonly lines: readonly DiffLine[] }): ReactNode {
  return <>{lines.map((line, index) => <div key={index} className="changes-line" data-kind={line.kind}>
    <span className="changes-line__number" aria-hidden="true">{line.oldLine ?? ''}</span>
    <span className="changes-line__number" aria-hidden="true">{line.newLine ?? ''}</span>
    <span className="changes-line__sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ''}</span>
    <span className="changes-line__text">{line.kind === 'add' ? <span className="tt-visually-hidden">Added: </span> : line.kind === 'remove' ? <span className="tt-visually-hidden">Removed: </span> : null}{line.text || ' '}</span>
  </div>)}</>
})

/** Align each contiguous edit block while leaving hunk boundaries and no-newline notes in their original order. */
const SplitDiffRows = memo(function SplitDiffRows({ lines }: { readonly lines: readonly DiffLine[] }): ReactNode {
  const rows: ReactNode[] = []
  const cell = (line: DiffLine | undefined, side: 'old' | 'new'): ReactNode => <div className="changes-split__cell" data-kind={line?.kind}>
    <span className="changes-line__number" aria-hidden="true">{(side === 'old' ? line?.oldLine : line?.newLine) ?? ''}</span>
    <span className="changes-line__sign" aria-hidden="true">{line?.kind === 'add' ? '+' : line?.kind === 'remove' ? '−' : ''}</span>
    <span className="changes-line__text">{line?.kind === 'add' ? <span className="tt-visually-hidden">Added: </span> : line?.kind === 'remove' ? <span className="tt-visually-hidden">Removed: </span> : null}{line?.text || ' '}</span>
  </div>
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    if (line.kind === 'remove' || line.kind === 'add') {
      const start = index
      const before: DiffLine[] = []
      const after: DiffLine[] = []
      while (index < lines.length && (lines[index]!.kind === 'remove' || lines[index]!.kind === 'add')) {
        const edit = lines[index++]!
        if (edit.kind === 'remove') before.push(edit)
        else after.push(edit)
      }
      for (let offset = 0; offset < Math.max(before.length, after.length); offset++) {
        rows.push(<div key={`${start}-${offset}`} className="changes-split__row">{cell(before[offset], 'old')}{cell(after[offset], 'new')}</div>)
      }
    } else {
      rows.push(line.kind === 'context'
        ? <div key={index} className="changes-split__row">{cell(line, 'old')}{cell(line, 'new')}</div>
        : <DiffRows key={index} lines={[line]} />)
      index++
    }
  }
  return <>{rows}</>
})

function DiffBody({ diff, scrollTop, split, onScroll, onReveal, platform }: {
  readonly diff: GitFileDiff; readonly scrollTop: number; readonly onScroll: (top: number) => void; readonly onReveal: () => void; readonly platform?: string | undefined
  readonly split: boolean
}): ReactNode {
  const body = useRef<HTMLDivElement>(null)
  const [all, setAll] = useState(false)
  const patch = diff.content.kind === 'text' ? diff.content.patch : ''
  // The file is already named by the selected row and preview tab. Keep substantive Git metadata
  // (mode, rename, similarity), but let the first hunk lead instead of repeating raw patch paths.
  const lines = useMemo(() => parseUnifiedDiff(patch).filter(line => line.kind !== 'meta'
    || !/^(?:diff --git |index [\da-f]+\.\.[\da-f]+(?: \d+)?$|--- |\+\+\+ )/u.test(line.text)), [patch])
  // The saved position is restored once; refreshed content then keeps whatever the reader has scrolled to.
  const initialTop = useRef(scrollTop)
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = initialTop.current }, [])
  if (diff.content.kind !== 'text') {
    const title = diff.content.kind === 'binary' ? 'Binary file: no text diff.' : diff.content.kind === 'too-large' ? 'Too large to show as a diff.' : 'No diff is available for this file.'
    return <div className="files-problem" role="status"><strong>{title}</strong>{diff.content.message ? <p>{diff.content.message}</p> : null}
      <button type="button" className="files-link tt-focusable" onClick={onReveal}>{revealLabel(platform)}</button></div>
  }
  if (lines.length === 0) return <div className="files-problem" role="status"><strong>No line changes.</strong><p>Only the file’s mode or name changed.</p></div>
  const shown = all ? lines : lines.slice(0, DIFF_ROW_LIMIT)
  return <div ref={body} className="changes-diff__body" tabIndex={0} aria-label="Diff" onScroll={event => onScroll(event.currentTarget.scrollTop)}>
    {split ? <div className="changes-split__head"><span>Before</span><span>Working copy</span></div> : null}
    <div className="changes-diff__rows" data-layout={split ? 'split' : 'unified'}>{split ? <SplitDiffRows lines={shown} /> : <DiffRows lines={shown} />}</div>
    {shown.length < lines.length ? <div className="changes-diff__more"><span>Showing {shown.length.toLocaleString()} of {lines.length.toLocaleString()} lines.</span>
      <button type="button" className="files-link tt-focusable" onClick={() => setAll(true)}>Show all</button></div> : null}
  </div>
}
