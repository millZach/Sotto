import React, { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns2, Copy, FolderTree, GitPullRequestArrow, Pilcrow, RotateCw, Rows3, WrapText } from 'lucide-react'
import type { GitChangesBridge, GitReviewFile } from '../../../shared/gitChanges'
import type { ToolsError } from '../../../shared/tools'
import { ChangesBasePicker, type RefsReader } from './ChangesBasePicker'
import { revealLabel } from './FilePreview'
import { CHANGE_STATUS, collapsedIn, parseUnifiedDiff, scopeKey, turnNumber, useChangesView, useThreadChanges, type ChangesReview, type ChangesScope, type ChangesStore, type ChangesView, type DiffLine, type ThreadChanges } from './changesStore'
import { GitPullRequest } from './GitPullRequest'
import { GitActions } from './GitActions'
import { ToolsChrome } from './ToolsChrome'
import './changes.css'
import { useDiffPreferences } from '../state/gitSettings'

/** A long file shows this many rows first; the rest is one action away so a huge diff never stalls the panel. */
const DIFF_ROW_LIMIT = 3_000

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

const SCOPE_LOADING: Record<ChangesScope['kind'], string> = { working: 'Reading the working tree…', branch: 'Reading branch changes…', turn: 'Reading the turn’s checkpoint…' }

export interface ChangesSurfaceProps {
  readonly threadId: string
  readonly store: ChangesStore
  readonly bridge: GitChangesBridge | undefined
  readonly platform?: string | undefined
  readonly onStatus: (message: string) => void
  /** Whether the thread's provider writes Git drafts (ADR-0026); a Devin thread's forms offer none. */
  readonly drafts?: boolean
  /** Opens a file of the working folder in Files; absent, a file's name is only its name. */
  readonly onOpenFile?: ((path: string) => void) | undefined
  /** Reads the branches Branch changes can compare against; tests pass their own. */
  readonly refs?: RefsReader | undefined
}

/**
 * Changes as T3's diff panel: a scope (Working tree, Branch changes against a base, Latest turn or Turn N), the
 * files of that comparison as collapsible blocks with their counts, and a file tree beside them. Review only:
 * committing is the Git action's, and there is no staging, discarding or reverting here (ADR-0027).
 */
export function ChangesSurface({ threadId, store, bridge, platform, onStatus, drafts = true, onOpenFile, refs }: ChangesSurfaceProps): ReactNode {
  const changes = useThreadChanges(store, threadId)
  const view = useChangesView(store)
  // Diff layout, Hide whitespace changes and Default diff file state say where the view starts (ADR-0027, #271).
  const preferences = useDiffPreferences()
  const startLayout = preferences?.layout, startHidden = preferences?.hideWhitespace, startFileState = preferences?.fileState
  useLayoutEffect(() => {
    if (startLayout !== undefined && startHidden !== undefined && startFileState !== undefined) store.applyStartingView({ layout: startLayout, ignoreWhitespace: startHidden, collapsed: startFileState === 'collapsed' })
  }, [store, startLayout, startHidden, startFileState])
  const [pullRequestOpen, setPullRequestOpen] = useState(false)
  // Checkpoints draws its toggle into the line of chrome.
  const [toggleSlot, setToggleSlot] = useState<HTMLElement | null>(null)
  if (!changes) return <><ToolsChrome title="Changes" /><p className="files-preview__loading" role="status">Loading…</p></>
  const { list } = changes
  if (list.status === 'loading') return <><ToolsChrome title="Changes" /><p className="files-preview__loading" role="status">Reading changes…</p></>
  if (list.status === 'error') {
    const repository = list.error.code !== 'not-repository'
    return <><ToolsChrome title="Changes" /><div className="files-problem files-problem--root" role="status">
      <strong>{listProblem(list.error, bridge !== undefined)}</strong>
      {bridge && repository ? <button type="button" className="files-link tt-focusable" onClick={() => void store.refresh(bridge, threadId)}>Try again</button> : null}
    </div></>
  }
  if (pullRequestOpen && bridge && changes.workspace) return <div className="changes-surface">
    <GitPullRequest key={`${threadId}:${changes.workspace.workspaceId}`} threadId={threadId} workspaceId={changes.workspace.workspaceId} bridge={bridge} drafts={drafts} onBack={() => setPullRequestOpen(false)} />
  </div>
  const reviewState = changes.review
  const review = reviewState?.status === 'ready' ? reviewState.review : reviewState?.status === 'loading' ? reviewState.previous : undefined
  const files = review?.files ?? []
  const collapsed = collapsedIn(changes)
  const allCollapsed = files.length > 0 && files.every(file => collapsed.has(file.path))
  const totals = files.reduce((sum, file) => ({ additions: sum.additions + (file.additions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }), { additions: 0, deletions: 0 })
  const tree = view.fileTree && files.length > 0
  const copy = (path: string): void => { void store.copyPath(bridge, threadId, path).then(result => onStatus(result.ok ? 'Path copied' : 'Could not copy the path')) }
  const reveal = (path: string): void => { void store.reveal(bridge, threadId, path).then(result => { if (!result.ok) onStatus('Could not open the folder') }) }
  const setScope = (scope: ChangesScope): void => store.setScope(bridge, threadId, scope)
  const toggle = (key: keyof Pick<ChangesView, 'wrap' | 'ignoreWhitespace' | 'fileTree'>): void => store.setView({ [key]: !view[key] })

  return <div className="changes-surface">
    <div className="changes-summary tools-chrome">
      {/* The scope keeps its words; the counts beside it show whole or drop to a line the lead never shows. */}
      <span className="changes-lead">
        <ScopePicker changes={changes} onChange={setScope} />
        {files.length > 0 ? <Totals {...totals} place="chrome" /> : null}
      </span>
      <div className="tools-chrome__actions">
        <span className="changes-summary__git" ref={setToggleSlot} />
        {bridge?.reviewPullRequest ? <button type="button" className="tools-chrome__button tt-focusable" title="Pull request" onClick={() => setPullRequestOpen(true)}>
          <GitPullRequestArrow size={16} aria-hidden="true" /><span className="tools-chrome__button-label">Pull request</span></button> : null}
        <button type="button" className="files-icon tt-focusable" aria-label="Refresh diff" title="Refresh diff" data-busy={changes.refreshing || reviewState?.status === 'loading' || undefined}
          onClick={() => void store.refresh(bridge, threadId)}><RotateCw size={15} aria-hidden="true" /></button>
      </div>
    </div>
    <GitActions key={threadId} threadId={threadId} changes={changes} bridge={bridge} store={store} toggleSlot={toggleSlot} />
    <div className="changes-bar">
      {changes.scope.kind === 'branch'
        ? <ChangesBasePicker key={threadId} threadId={threadId} selected={changes.scope.base} resolved={review?.branch} refs={refs} onPick={base => setScope({ kind: 'branch', base })} />
        : <span className="changes-bar__fact">{changes.scope.kind === 'working' ? 'Against HEAD' : review?.turn ? turnWhen(review.turn.checkpoint.createdAt) : ''}</span>}
      <div className="changes-bar__view" role="group" aria-label="Diff view">
        {files.length > 0 ? <Totals {...totals} place="bar" /> : null}
        <button type="button" className="files-icon files-icon--small tt-focusable" disabled={files.length === 0}
          aria-label={allCollapsed ? 'Expand all files' : 'Collapse all files'} title={allCollapsed ? 'Expand all files' : 'Collapse all files'}
          onClick={() => store.setAllCollapsed(threadId, !allCollapsed)}>{allCollapsed ? <ChevronsUpDown size={15} aria-hidden="true" /> : <ChevronsDownUp size={15} aria-hidden="true" />}</button>
        <span className="changes-bar__segment">
          <button type="button" className="files-icon files-icon--small tt-focusable" aria-label="Stacked diff view" title="Stacked diff view" aria-pressed={view.layout === 'stacked'} onClick={() => store.setView({ layout: 'stacked' })}><Rows3 size={15} aria-hidden="true" /></button>
          <button type="button" className="files-icon files-icon--small tt-focusable" aria-label="Split diff view" title="Split diff view" aria-pressed={view.layout === 'split'} onClick={() => store.setView({ layout: 'split' })}><Columns2 size={15} aria-hidden="true" /></button>
        </span>
        <button type="button" className="files-icon files-icon--small tt-focusable" data-on={view.wrap || undefined}
          aria-label={view.wrap ? 'Disable line wrapping' : 'Enable line wrapping'} title={view.wrap ? 'Disable line wrapping' : 'Enable line wrapping'}
          onClick={() => toggle('wrap')}><WrapText size={15} aria-hidden="true" /></button>
        <button type="button" className="files-icon files-icon--small tt-focusable" data-on={view.ignoreWhitespace || undefined}
          aria-label={view.ignoreWhitespace ? 'Show whitespace changes' : 'Hide whitespace changes'} title={view.ignoreWhitespace ? 'Show whitespace changes' : 'Hide whitespace changes'}
          onClick={() => toggle('ignoreWhitespace')}><Pilcrow size={15} aria-hidden="true" /></button>
        <button type="button" className="files-icon files-icon--small tt-focusable" data-on={view.fileTree || undefined} disabled={files.length === 0}
          aria-label={view.fileTree ? 'Hide file tree' : 'Show file tree'} title={view.fileTree ? 'Hide file tree' : 'Show file tree'}
          onClick={() => toggle('fileTree')}><FolderTree size={15} aria-hidden="true" /></button>
      </div>
    </div>
    {reviewState?.status === 'error'
      ? <div className="files-problem" role="status"><strong>{reviewState.error.message || 'This comparison could not be read.'}</strong>
        <button type="button" className="files-link tt-focusable" onClick={() => void store.refresh(bridge, threadId)}>Try again</button></div>
      : !review ? <p className="files-preview__loading" role="status">{SCOPE_LOADING[changes.scope.kind]}</p>
        : review.notice ? <div className="files-problem" role="status"><strong>{review.notice}</strong></div>
          : files.length === 0 ? <div className="files-problem" role="status"><strong>{emptyWords(changes.scope, review, view)}</strong></div>
            : <>
              {review.truncated ? <p className="changes-note">Git reported more files than Sotto lists.</p> : null}
              <div className="changes-review" data-tree={tree || undefined}>
                <ChangesFiles key={`${threadId}\n${scopeKey(changes.scope)}`} changes={changes} review={review} view={view} store={store}
                  onCopy={copy} onReveal={reveal} onOpenFile={onOpenFile} platform={platform} />
                {tree ? <ChangesTree files={files} onPick={path => showFile(changes, store, path)} /> : null}
              </div>
            </>}
  </div>
}

/**
 * The comparison's `+adds −dels`. It sits on the line of chrome; in a narrow panel the chrome has no room beside
 * the window's own controls, so CSS shows the copy at the head of the view bar instead. Only one is ever displayed.
 */
function Totals({ additions, deletions, place }: { readonly additions: number; readonly deletions: number; readonly place: 'chrome' | 'bar' }): ReactNode {
  return <span className={`changes-counts changes-counts--${place}`} title={`${additions} lines added, ${deletions} removed`}>
    <span aria-hidden="true"><span className="changes-counts__add">+{additions}</span> <span className="changes-counts__remove">−{deletions}</span></span>
    <span className="tt-visually-hidden">{additions} lines added, {deletions} removed</span>
  </span>
}

function turnWhen(createdAt: string): string {
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime()) ? '' : `Started ${date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}

function emptyWords(scope: ChangesScope, review: ChangesReview, view: ChangesView): string {
  const whitespace = view.ignoreWhitespace ? ' Whitespace changes are hidden.' : ''
  if (scope.kind === 'working') return `The working copy matches HEAD.${whitespace}`
  if (scope.kind === 'branch') {
    if (!review.branch?.base) return 'Sotto found no base branch to compare with. Choose one.'
    return `This branch has no changes against ${review.branch.base}.${whitespace}`
  }
  return `This turn changed no files.${whitespace}`
}

/** Scroll a file's block into view, open it if it was collapsed, and put focus on its name. */
function showFile(changes: ThreadChanges, store: ChangesStore, path: string): void {
  if (collapsedIn(changes).has(path)) store.toggleCollapsed(changes.threadId, path)
  requestAnimationFrame(() => {
    const block = document.querySelector<HTMLElement>(`.changes-file[data-file-path="${CSS.escape(path)}"]`)
    block?.scrollIntoView({ block: 'start' })
    block?.querySelector<HTMLElement>('.changes-file__toggle')?.focus({ preventScroll: true })
  })
}

/** T3's scope menu, as the platform's own select: Working tree, Branch changes, Latest turn, then each turn. */
function ScopePicker({ changes, onChange }: { readonly changes: ThreadChanges; readonly onChange: (scope: ChangesScope) => void }): ReactNode {
  const { scope, turns } = changes
  const value = scope.kind === 'turn' ? scope.checkpointId === null ? 'latest' : `turn:${scope.checkpointId}` : scope.kind
  return <label className="changes-scope">
    <span className="tt-visually-hidden">Diff scope</span>
    <select className="changes-scope__select tt-focusable" value={value} onChange={event => {
      const next = event.target.value
      onChange(next === 'working' ? { kind: 'working' } : next === 'branch' ? { kind: 'branch', base: null } : next === 'latest' ? { kind: 'turn', checkpointId: null } : { kind: 'turn', checkpointId: next.slice('turn:'.length) })
    }}>
      <option value="working">Working tree</option>
      <option value="branch">Branch changes</option>
      <option value="latest">Latest turn</option>
      {turns.length > 0 ? <optgroup label="Turn">
        {turns.map(turn => <option key={turn.id} value={`turn:${turn.id}`}>Turn {turnNumber(turns, turn.id)}{turn.status === 'unavailable' ? ' (unavailable)' : ''}</option>)}
      </optgroup> : null}
    </select>
    <ChevronDown size={14} aria-hidden="true" className="changes-scope__chevron" />
  </label>
}

/**
 * Whether a file of the comparison is in the working folder now, so Files can open it: not deleted by the
 * comparison unless it has come back since, and not deleted in the working copy since.
 */
export function inWorkingCopy(file: GitReviewFile, changes: ThreadChanges): boolean {
  const now = changes.list.status === 'ready' ? changes.list.files.find(item => item.path === file.path)?.status : undefined
  if (changes.scope.kind === 'working') return file.status !== 'deleted'
  if (now === 'deleted') return false
  return file.status !== 'deleted' || now === 'added' || now === 'untracked'
}

function ChangesFiles({ changes, review, view, store, onCopy, onReveal, onOpenFile, platform }: {
  readonly changes: ThreadChanges; readonly review: ChangesReview; readonly view: ChangesView; readonly store: ChangesStore
  readonly onCopy: (path: string) => void; readonly onReveal: (path: string) => void; readonly onOpenFile?: ((path: string) => void) | undefined; readonly platform?: string | undefined
}): ReactNode {
  const body = useRef<HTMLDivElement>(null)
  const key = scopeKey(changes.scope)
  // The saved position is restored once; refreshed content then keeps whatever the reader has scrolled to.
  const initialTop = useRef(store.scrollOf(changes.threadId, key))
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = initialTop.current }, [])
  const collapsed = collapsedIn(changes)
  const labels = changes.scope.kind === 'working' ? ['HEAD', 'Working tree'] : changes.scope.kind === 'branch' ? [review.branch?.base ?? 'Base', review.branch?.head ?? 'Branch'] : ['Before the turn', 'After the turn']
  return <div ref={body} className="changes-files" data-wrap={view.wrap || undefined} data-layout={view.layout} aria-label="Changed files"
    role="region" onScroll={event => store.setScroll(changes.threadId, key, event.currentTarget.scrollTop)}>
    {review.files.map(file => <FileBlock key={file.path} file={file} collapsed={collapsed.has(file.path)} split={view.layout === 'split'} labels={labels}
      onToggle={() => store.toggleCollapsed(changes.threadId, file.path)} onCopy={onCopy} onReveal={onReveal}
      onOpen={onOpenFile && inWorkingCopy(file, changes) ? onOpenFile : undefined} platform={platform} />)}
  </div>
}

const FileBlock = memo(function FileBlock({ file, collapsed, split, labels, onToggle, onCopy, onReveal, onOpen, platform }: {
  readonly file: GitReviewFile; readonly collapsed: boolean; readonly split: boolean; readonly labels: readonly string[]
  readonly onToggle: () => void; readonly onCopy: (path: string) => void; readonly onReveal: (path: string) => void
  readonly onOpen?: ((path: string) => void) | undefined; readonly platform?: string | undefined
}): ReactNode {
  const { folder, name } = splitPath(file.path)
  const status = CHANGE_STATUS[file.status]
  const title = <>{folder ? <span className="changes-file__folder"><bdi>{folder}</bdi></span> : null}<span className="changes-file__base">{name}</span></>
  return <section className="changes-file" data-file-path={file.path} data-collapsed={collapsed || undefined} role="group" aria-label={file.path}>
    <div className="changes-file__head">
      <button type="button" className="changes-file__toggle files-icon files-icon--small tt-focusable" aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`} title={collapsed ? 'Expand diff' : 'Collapse diff'} onClick={onToggle}>
        {collapsed ? <ChevronRight size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
      </button>
      <span className="changes-badge" data-status={file.status} role="img" aria-label={status.label} title={status.label}>{status.letter}</span>
      {onOpen ? <button type="button" className="changes-file__name tt-focusable" aria-label={`Open ${file.path}`} title={`Open ${file.path} in Files`} onClick={() => onOpen(file.path)}>{title}</button>
        : <span className="changes-file__name" title={file.path}>{title}</span>}
      {file.additions !== null && file.deletions !== null ? <span className="changes-counts changes-counts--file">
        <span aria-hidden="true"><span className="changes-counts__add">+{file.additions}</span> <span className="changes-counts__remove">−{file.deletions}</span></span>
        <span className="tt-visually-hidden">{file.additions} added, {file.deletions} removed</span>
      </span> : null}
      <button type="button" className="files-icon files-icon--small tt-focusable" aria-label={`Copy path: ${file.path}`} title="Copy path" onClick={() => onCopy(file.path)}><Copy size={14} aria-hidden="true" /></button>
    </div>
    {!collapsed ? <>
      {file.originalPath ? <p className="changes-note">Renamed from <code>{file.originalPath}</code></p> : null}
      <FileBody file={file} split={split} labels={labels} onReveal={() => onReveal(file.path)} platform={platform} />
    </> : null}
  </section>
})

function FileBody({ file, split, labels, onReveal, platform }: { readonly file: GitReviewFile; readonly split: boolean; readonly labels: readonly string[]; readonly onReveal: () => void; readonly platform?: string | undefined }): ReactNode {
  const [all, setAll] = useState(false)
  const patch = file.content.kind === 'text' ? file.content.patch : ''
  // The file is already named by its head. Keep substantive Git metadata (mode, rename, similarity), but let the
  // first hunk lead instead of repeating raw patch paths.
  const lines = useMemo(() => parseUnifiedDiff(patch).filter(line => line.kind !== 'meta'
    || !/^(?:diff --git |index [\da-f]+\.\.[\da-f]+(?: \d+)?$|--- |\+\+\+ |(?:new|deleted) file mode \d+$|rename (?:from|to) |similarity index )/u.test(line.text)), [patch])
  if (file.content.kind !== 'text') {
    const title = file.content.kind === 'binary' ? 'Binary file: no text diff.' : file.content.kind === 'too-large' ? 'Too large to show as a diff.' : 'No diff is available for this file.'
    return <div className="changes-file__problem" role="note"><strong>{title}</strong>{file.content.message && file.content.message !== title ? <p>{file.content.message}</p> : null}
      {file.status !== 'deleted' ? <button type="button" className="files-link tt-focusable" onClick={onReveal}>{revealLabel(platform)}</button> : null}</div>
  }
  if (lines.length === 0) return <div className="changes-file__problem" role="note"><strong>No line changes.</strong><p>Only the file’s mode or name changed.</p></div>
  const shown = all ? lines : lines.slice(0, DIFF_ROW_LIMIT)
  return <div className="changes-diff__body">
    {split ? <div className="changes-split__head" aria-hidden="true"><span>{labels[0]}</span><span>{labels[1]}</span></div> : null}
    <div className="changes-diff__rows" data-layout={split ? 'split' : 'unified'}>{split ? <SplitDiffRows lines={shown} path={file.path} /> : <DiffRows lines={shown} path={file.path} />}</div>
    {shown.length < lines.length ? <div className="changes-diff__more"><span>Showing {shown.length.toLocaleString()} of {lines.length.toLocaleString()} lines.</span>
      <button type="button" className="files-link tt-focusable" onClick={() => setAll(true)}>Show all</button></div> : null}
  </div>
}

const sign = (line: DiffLine | undefined): string => line?.kind === 'add' ? '+' : line?.kind === 'remove' ? '−' : ''
const spoken = (line: DiffLine | undefined): ReactNode => line?.kind === 'add' ? <span className="tt-visually-hidden">Added: </span> : line?.kind === 'remove' ? <span className="tt-visually-hidden">Removed: </span> : null

/** Rows carry the file and both line numbers as data, so a later selection on this diff can name exactly what it covers. */
const DiffRows = memo(function DiffRows({ lines, path }: { readonly lines: readonly DiffLine[]; readonly path: string }): ReactNode {
  return <>{lines.map((line, index) => <div key={index} className="changes-line" data-kind={line.kind} data-path={path}
    data-old-line={line.oldLine ?? undefined} data-new-line={line.newLine ?? undefined}>
    <span className="changes-line__number" aria-hidden="true">{line.oldLine ?? ''}</span>
    <span className="changes-line__number" aria-hidden="true">{line.newLine ?? ''}</span>
    <span className="changes-line__sign" aria-hidden="true">{sign(line)}</span>
    <span className="changes-line__text">{spoken(line)}{line.text || ' '}</span>
  </div>)}</>
})

/** Align each contiguous edit block while leaving hunk boundaries and no-newline notes in their original order. */
const SplitDiffRows = memo(function SplitDiffRows({ lines, path }: { readonly lines: readonly DiffLine[]; readonly path: string }): ReactNode {
  const rows: ReactNode[] = []
  const cell = (line: DiffLine | undefined, side: 'old' | 'new'): ReactNode => {
    const number = side === 'old' ? line?.oldLine : line?.newLine
    return <div className="changes-split__cell" data-kind={line?.kind} {...(side === 'old' ? { 'data-old-line': number ?? undefined } : { 'data-new-line': number ?? undefined })}>
      <span className="changes-line__number" aria-hidden="true">{number ?? ''}</span>
      <span className="changes-line__sign" aria-hidden="true">{sign(line)}</span>
      <span className="changes-line__text">{spoken(line)}{line?.text || ' '}</span>
    </div>
  }
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
        const old = before[offset], next = after[offset]
        rows.push(<div key={`${start}-${offset}`} className="changes-split__row" data-path={path} data-old-line={old?.oldLine ?? undefined} data-new-line={next?.newLine ?? undefined}>{cell(old, 'old')}{cell(next, 'new')}</div>)
      }
    } else {
      rows.push(line.kind === 'context'
        ? <div key={index} className="changes-split__row" data-path={path} data-old-line={line.oldLine ?? undefined} data-new-line={line.newLine ?? undefined}>{cell(line, 'old')}{cell(line, 'new')}</div>
        : <DiffRows key={index} lines={[line]} path={path} />)
      index++
    }
  }
  return <>{rows}</>
})

/**
 * The file tree aside: the comparison's files under their folders, one list the arrow keys walk. Picking a file
 * brings its block into view.
 */
function ChangesTree({ files, onPick }: { readonly files: readonly GitReviewFile[]; readonly onPick: (path: string) => void }): ReactNode {
  const list = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const groups = useMemo(() => {
    const byFolder = new Map<string, GitReviewFile[]>()
    for (const file of files) {
      const { folder } = splitPath(file.path)
      byFolder.set(folder, [...byFolder.get(folder) ?? [], file])
    }
    return [...byFolder].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  }, [files])
  const order = groups.flatMap(([, items]) => items.map(item => item.path))
  const current = order.includes(focused ?? '') ? focused : order[0] ?? null
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = order.indexOf(current ?? '')
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : null
    if (next === null) return
    event.preventDefault()
    const path = order[Math.max(0, Math.min(order.length - 1, next))]
    if (path === undefined) return
    setFocused(path)
    list.current?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(path)}"]`)?.focus()
  }
  return <nav className="changes-tree" aria-label="File tree">
    <div ref={list} className="changes-tree__list" role="listbox" aria-label="Files in this comparison" onKeyDown={move}>
      {groups.map(([folder, items]) => <div key={folder} role="group" aria-label={folder || 'Working folder'} className="changes-tree__group">
        {folder ? <div className="changes-tree__folder" aria-hidden="true"><bdi>{folder}</bdi></div> : null}
        {items.map(file => {
          const status = CHANGE_STATUS[file.status]
          const { name } = splitPath(file.path)
          return <div key={file.path} role="option" aria-selected={file.path === current} tabIndex={file.path === current ? 0 : -1} data-tree-path={file.path}
            className="changes-tree__item" data-nested={folder !== '' || undefined} aria-label={`${name}, ${status.label}${folder ? `, in ${folder}` : ''}`}
            onFocus={() => setFocused(file.path)} onClick={() => onPick(file.path)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPick(file.path) } }}>
            <span className="changes-badge" data-status={file.status} aria-hidden="true">{status.letter}</span>
            <span className="changes-tree__name">{name}</span>
          </div>
        })}
      </div>)}
    </div>
  </nav>
}
