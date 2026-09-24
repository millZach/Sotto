import React, { Fragment, memo, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns2, Copy, FolderTree, GitPullRequestArrow, MessageSquare, Pilcrow, RotateCw, Rows3, WrapText } from 'lucide-react'
import type { GitChangesBridge, GitReviewFile } from '../../../shared/gitChanges'
import type { ToolsError } from '../../../shared/tools'
import { MAX_REVIEW_COMMENTS, reviewCommentStore, reviewLabel, sameReviewLine, useReviewComments, useReviewDraft, type ReviewComment, type ReviewCommentStore, type ReviewDraft, type ReviewLine } from '../agents/reviewComments'
import { Button } from '../components/Button'
import { diffRows, fileHasLine, quotedLines, reviewLine, rowLabel, rowShowing, rowsShowing, selectableRows, type DiffRow } from './diffSelection'
import { ChangesBasePicker, type RefsReader } from './ChangesBasePicker'
import { revealLabel } from './FilePreview'
import { CHANGE_STATUS, collapsedIn, parseUnifiedDiff, scopeKey, turnNumber, useChangesView, useThreadChanges, type ChangesReview, type ChangesScope, type ChangesStore, type ChangesView, type DiffLine, type ThreadChanges } from './changesStore'
import { GitPullRequest } from './GitPullRequest'
import { GitActions } from './GitActions'
import { ToolsChrome } from './ToolsChrome'
import './changes.css'

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
  /** Where review comments wait for the thread's next message; the window's own unless a test passes one. */
  readonly comments?: ReviewCommentStore
}

/**
 * Changes as T3's diff panel: a scope (Working tree, Branch changes against a base, Latest turn or Turn N), the
 * files of that comparison as collapsible blocks with their counts, and a file tree beside them. Review only:
 * committing is the Git action's, and there is no staging, discarding or reverting here (ADR-0027).
 */
export function ChangesSurface({ threadId, store, bridge, platform, onStatus, drafts = true, onOpenFile, refs, comments = reviewCommentStore }: ChangesSurfaceProps): ReactNode {
  const changes = useThreadChanges(store, threadId)
  const view = useChangesView(store)
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
      ? <><div className="files-problem" role="status"><strong>{reviewState.error.message || 'This comparison could not be read.'}</strong>
        <button type="button" className="files-link tt-focusable" onClick={() => void store.refresh(bridge, threadId)}>Try again</button></div>
        <ElsewhereComments threadId={threadId} files={NO_FILES} store={comments} /></>
      : !review ? <p className="files-preview__loading" role="status">{SCOPE_LOADING[changes.scope.kind]}</p>
        : review.notice ? <><div className="files-problem" role="status"><strong>{review.notice}</strong></div><ElsewhereComments threadId={threadId} files={files} store={comments} /></>
          : files.length === 0 ? <><div className="files-problem" role="status"><strong>{emptyWords(changes.scope, review, view)}</strong></div><ElsewhereComments threadId={threadId} files={files} store={comments} /></>
            : <>
              {review.truncated ? <p className="changes-note">Git reported more files than Sotto lists.</p> : null}
              <div className="changes-review" data-tree={tree || undefined}>
                <ChangesFiles key={`${threadId}\n${scopeKey(changes.scope)}`} changes={changes} review={review} view={view} store={store} comments={comments}
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

/** The lines picked in one file's diff, by row position, for the patch and layout they were picked in. */
interface LineSelection {
  readonly path: string
  readonly patch: string
  readonly split: boolean
  readonly anchor: number
  readonly focus: number
}

/** What a file's rows ask of the review comments. Stable for the life of the list, so rows can stay memoised. */
interface ReviewActions {
  readonly select: (selection: LineSelection | null) => void
  readonly comment: (path: string, lines: readonly ReviewLine[]) => void
  readonly editDraft: (text: string) => void
  readonly cancelDraft: () => void
  readonly addDraft: () => void
  readonly remove: (id: string) => void
}

const NO_COMMENTS: readonly ReviewComment[] = []

function ChangesFiles({ changes, review, view, store, comments: commentStore, onCopy, onReveal, onOpenFile, platform }: {
  readonly changes: ThreadChanges; readonly review: ChangesReview; readonly view: ChangesView; readonly store: ChangesStore; readonly comments: ReviewCommentStore
  readonly onCopy: (path: string) => void; readonly onReveal: (path: string) => void; readonly onOpenFile?: ((path: string) => void) | undefined; readonly platform?: string | undefined
}): ReactNode {
  const body = useRef<HTMLDivElement>(null)
  const { threadId } = changes
  const key = scopeKey(changes.scope)
  // The saved position is restored once; refreshed content then keeps whatever the reader has scrolled to.
  const initialTop = useRef(store.scrollOf(threadId, key))
  useLayoutEffect(() => { if (body.current) body.current.scrollTop = initialTop.current }, [])
  const comments = useReviewComments(commentStore, threadId)
  const draft = useReviewDraft(commentStore, threadId)
  const [selection, setSelection] = useState<LineSelection | null>(null)
  // A draft takes focus in the render that opens it, and at no other time: the flag lives for one frame, so a
  // later render of the file (a diff poll, a turn ending) never pulls focus out of wherever the user has gone.
  const focusDraft = useRef(false)
  const actions = useMemo<ReviewActions>(() => ({
    select: next => { setSelection(next); commentStore.closeEmptyDraft(threadId) },
    comment: (path, lines) => {
      focusDraft.current = true
      const { opened } = commentStore.openDraft(threadId, path, lines)
      if (opened) { requestAnimationFrame(() => { focusDraft.current = false }); return }
      // A draft with words in it stays; the user is taken to it rather than left wondering where their press went.
      // A collapsed file opens first; a draft whose lines are not drawn at all is in the list after the files.
      focusDraft.current = false
      const kept = commentStore.draft(threadId)
      const current = store.thread(threadId)
      if (kept && current && collapsedIn(current).has(kept.path)) store.toggleCollapsed(threadId, kept.path)
      requestAnimationFrame(() => {
        const field = body.current?.querySelector<HTMLTextAreaElement>('.changes-comment--draft textarea')
        field?.focus({ preventScroll: true })
        field?.closest('.changes-comment')?.scrollIntoView({ block: 'nearest' })
      })
    },
    editDraft: text => commentStore.editDraft(threadId, text),
    cancelDraft: () => commentStore.closeDraft(threadId),
    addDraft: () => { if (commentStore.addDraft(threadId) !== null) setSelection(null) },
    remove: id => commentStore.remove(threadId, id),
  }), [commentStore, store, threadId])
  const byPath = useMemo(() => {
    const map = new Map<string, ReviewComment[]>()
    for (const comment of comments) map.set(comment.path, [...map.get(comment.path) ?? [], comment])
    return map
  }, [comments])
  const full = comments.length >= MAX_REVIEW_COMMENTS
  const reviews = useRef(new Map<string, FileReview>())
  const reviewOf = (path: string): FileReview => {
    const next: FileReview = { selection: selection?.path === path ? selection : null, draft: draft?.path === path ? draft : null, drafting: draft ? reviewLabel(draft) : null,
      comments: byPath.get(path) ?? NO_COMMENTS, full, actions, focusDraft }
    const previous = reviews.current.get(path)
    if (previous && (Object.keys(next) as (keyof FileReview)[]).every(name => previous[name] === next[name])) return previous
    reviews.current.set(path, next)
    return next
  }
  const collapsed = collapsedIn(changes)
  const labels = changes.scope.kind === 'working' ? ['HEAD', 'Working tree'] : changes.scope.kind === 'branch' ? [review.branch?.base ?? 'Base', review.branch?.head ?? 'Branch'] : ['Before the turn', 'After the turn']
  return <div ref={body} className="changes-files" data-wrap={view.wrap || undefined} data-layout={view.layout} aria-label="Changed files"
    role="region" onScroll={event => store.setScroll(threadId, key, event.currentTarget.scrollTop)}>
    {review.files.map(file => <FileBlock key={file.path} file={file} collapsed={collapsed.has(file.path)} split={view.layout === 'split'} labels={labels}
      onToggle={() => store.toggleCollapsed(threadId, file.path)} onCopy={onCopy} onReveal={onReveal}
      onOpen={onOpenFile && inWorkingCopy(file, changes) ? onOpenFile : undefined} platform={platform}
      review={reviewOf(file.path)} />)}
    <ElsewhereComments threadId={threadId} files={review.files} store={commentStore} />
  </div>
}

const NO_FILES: readonly GitReviewFile[] = []

/** Whether Changes draws lines of this file a comment can sit under: text with at least one added, removed or context line. */
function drawsLines(file: GitReviewFile): boolean {
  return file.content.kind === 'text' && fileLines(file.content.patch).some(line => reviewLine(line) !== null)
}

/**
 * Comments on lines this comparison does not show: a file committed since, a turn that did not touch it, another
 * scope, a file whose only change is its mode or name, or a comparison that could not be read. They still go with
 * the next message, so they stay in sight here, with Delete comment, until then. A draft whose lines are not drawn
 * is here too, with its words, so it can always be finished or cancelled.
 */
function ElsewhereComments({ threadId, files, store }: { readonly threadId: string; readonly files: readonly GitReviewFile[]; readonly store: ReviewCommentStore }): ReactNode {
  const comments = useReviewComments(store, threadId)
  const draft = useReviewDraft(store, threadId)
  const shown = new Set(files.filter(drawsLines).map(file => file.path))
  const elsewhere = comments.filter(comment => !shown.has(comment.path))
  const strayDraft = draft !== null && !shown.has(draft.path) ? draft : null
  const section = useRef<HTMLElement>(null)
  if (elsewhere.length === 0 && strayDraft === null) return null
  /**
   * What leaves the list hands focus on: to the next comment's Delete, the one before it, and when the list is
   * about to empty, to the last file's head or to Refresh diff, so focus never drops to the page.
   */
  const handOff = (from: HTMLElement | null): void => {
    const deletes = [...section.current?.querySelectorAll<HTMLElement>('.changes-comment__delete') ?? []].filter(button => button !== from)
    const index = from === null ? 0 : [...section.current?.querySelectorAll<HTMLElement>('.changes-comment__delete') ?? []].indexOf(from)
    const next = deletes[Math.min(Math.max(index, 0), deletes.length - 1)]
    if (next) { next.focus(); return }
    const surface = section.current?.closest('.changes-surface')
    const heads = surface?.querySelectorAll<HTMLElement>('.changes-file__toggle')
    ;(heads?.[heads.length - 1] ?? surface?.querySelector<HTMLElement>('button[aria-label="Refresh diff"]'))?.focus()
  }
  return <section ref={section} className="changes-elsewhere" aria-labelledby={`changes-elsewhere-${threadId}`}>
    <h3 id={`changes-elsewhere-${threadId}`} className="changes-elsewhere__title">Comments on lines this comparison does not show</h3>
    {strayDraft ? <CommentDraft draft={strayDraft} full={store.full(threadId)} focus={NO_FOCUS} standalone
      onText={text => store.editDraft(threadId, text)} onCancel={() => { handOff(null); store.closeDraft(threadId) }}
      onAdd={() => { if (store.addDraft(threadId)) requestAnimationFrame(() => [...section.current?.querySelectorAll<HTMLElement>('.changes-comment__delete') ?? []].at(-1)?.focus()) }} /> : null}
    {elsewhere.map(comment => <CommentMarker key={comment.id} comment={comment} full note={null} onDelete={button => { handOff(button); store.remove(threadId, comment.id) }} />)}
  </section>
}

/** A draft outside its file's lines never takes focus on its own; the press that sends the user to it does. */
const NO_FOCUS = { current: false }

/** Whether two quotes are the same lines. */
function sameLines(a: readonly ReviewLine[], b: readonly ReviewLine[]): boolean {
  return a.length === b.length && a.every((line, index) => sameReviewLine(line, b[index]!))
}

/** One file's share of the review comments. */
interface FileReview {
  readonly selection: LineSelection | null
  readonly draft: ReviewDraft | null
  /** The name of the draft open anywhere in this thread's Changes; a new pick's Comment waits until it closes. */
  readonly drafting: string | null
  readonly comments: readonly ReviewComment[]
  readonly full: boolean
  readonly actions: ReviewActions
  readonly focusDraft: { current: boolean }
}

const FileBlock = memo(function FileBlock({ file, collapsed, split, labels, onToggle, onCopy, onReveal, onOpen, platform, review }: {
  readonly file: GitReviewFile; readonly collapsed: boolean; readonly split: boolean; readonly labels: readonly string[]
  readonly onToggle: () => void; readonly onCopy: (path: string) => void; readonly onReveal: (path: string) => void
  readonly onOpen?: ((path: string) => void) | undefined; readonly platform?: string | undefined; readonly review: FileReview
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
      <FileBody file={file} split={split} labels={labels} onReveal={() => onReveal(file.path)} platform={platform} review={review} />
    </> : null}
  </section>
})

/** The file's meaningful lines: Git's substantive metadata (mode, rename, similarity) stays; raw patch paths go. */
function fileLines(patch: string): DiffLine[] {
  return parseUnifiedDiff(patch).filter(line => line.kind !== 'meta'
    || !/^(?:diff --git |index [\da-f]+\.\.[\da-f]+(?: \d+)?$|--- |\+\+\+ |(?:new|deleted) file mode \d+$|rename (?:from|to) |similarity index )/u.test(line.text))
}

const NO_KEYS: ReadonlySet<string> = new Set()

/**
 * A file's lines as one grid the keyboard walks: Tab lands on the line last visited, the arrows move, Shift extends,
 * Space picks a line, Enter opens a comment on what is picked and Escape lets go. The mouse picks with a click,
 * extends with Shift and comments straight from a line number. Comments sit under their last line.
 */
function FileBody({ file, split, labels, onReveal, platform, review }: {
  readonly file: GitReviewFile; readonly split: boolean; readonly labels: readonly string[]; readonly onReveal: () => void; readonly platform?: string | undefined
  readonly review: FileReview
}): ReactNode {
  const [all, setAll] = useState(false)
  const [active, setActive] = useState(0)
  const grid = useRef<HTMLDivElement>(null)
  const patch = file.content.kind === 'text' ? file.content.patch : ''
  const lines = useMemo(() => fileLines(patch), [patch])
  const shown = useMemo(() => all ? lines : lines.slice(0, DIFF_ROW_LIMIT), [all, lines])
  const rows = useMemo(() => diffRows(shown, split), [shown, split])
  const selectable = useMemo(() => selectableRows(rows), [rows])
  const { selection: picked, draft, comments, actions } = review
  const draftRows = useMemo(() => draft ? rowsShowing(shown, rows, draft.lines) : NO_KEYS, [draft, rows, shown])
  const notedRows = useMemo(() => comments.length ? rowsShowing(shown, rows, comments.flatMap(comment => comment.lines)) : NO_KEYS, [comments, rows, shown])
  // Each comment sits under the row that shows its last line now. One whose line is past the rows drawn, or has
  // changed since, stays on the diff too, at the end of what is drawn, saying which: it still goes with the message
  // until it is sent or deleted. Every line of the file counts, not only the ones drawn.
  const markers = useMemo(() => {
    const map = new Map<string, { readonly comment: ReviewComment; readonly place: MarkerPlace }[]>()
    // A file with no line a comment can sit under (a mode change alone) leaves its comments to the list after the files.
    if (selectable.length === 0) return map
    const end = rows.at(-1)?.key
    for (const comment of comments) {
      const key = rowShowing(shown, rows, comment.lines.at(-1))?.key
      const place: MarkerPlace = key !== undefined ? 'here' : fileHasLine(lines, comment.lines.at(-1)) ? 'further' : 'changed'
      const at = key ?? end
      if (at !== undefined) map.set(at, [...map.get(at) ?? [], { comment, place }])
    }
    return map
  }, [comments, lines, rows, selectable, shown])
  // An open draft whose lines have moved on keeps its words at the end of the file rather than vanishing.
  const draftAnchor = draft && selectable.length > 0 ? rowShowing(shown, rows, draft.lines.at(-1))?.key ?? rows.at(-1)?.key : undefined

  if (file.content.kind !== 'text') {
    const title = file.content.kind === 'binary' ? 'Binary file: no text diff.' : file.content.kind === 'too-large' ? 'Too large to show as a diff.' : 'No diff is available for this file.'
    return <div className="changes-file__problem" role="note"><strong>{title}</strong>{file.content.message && file.content.message !== title ? <p>{file.content.message}</p> : null}
      {file.status !== 'deleted' ? <button type="button" className="files-link tt-focusable" onClick={onReveal}>{revealLabel(platform)}</button> : null}</div>
  }
  if (lines.length === 0) return <div className="changes-file__problem" role="note"><strong>No line changes.</strong><p>Only the file’s mode or name changed.</p></div>

  const selection = picked && picked.patch === patch && picked.split === split ? picked : null
  const from = selection ? Math.min(selection.anchor, selection.focus) : -1
  const to = selection ? Math.max(selection.anchor, selection.focus) : -1
  const current = Math.max(0, Math.min(active, selectable.length - 1))
  const pick = (anchor: number, focus: number): void => actions.select({ path: file.path, patch, split, anchor, focus })
  const focusRow = (position: number): void => {
    const row = grid.current?.querySelector<HTMLElement>(`[data-position="${position}"]`)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }
  /** Open a draft on the picked lines when this line is one of them, or on this line alone. */
  const commentOn = (position: number): void => {
    const inside = selection !== null && position >= from && position <= to
    if (!inside) pick(position, position)
    actions.comment(file.path, quotedLines(shown, selectable, inside ? from : position, inside ? to : position))
  }
  const rowOf = (target: EventTarget | null): HTMLElement | null => target instanceof Element ? target.closest<HTMLElement>('[data-position]') : null
  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const row = rowOf(event.target)
    if (!row) return
    const position = Number(row.dataset.position)
    setActive(position)
    if ((event.target as Element).closest('.changes-line__number')) { commentOn(position); return }
    // A drag that selected text is the reader copying code, not picking lines.
    const text = window.getSelection()
    if (text && !text.isCollapsed && grid.current?.contains(text.anchorNode)) return
    if (event.shiftKey && selection) pick(selection.anchor, position)
    else if (selection && from === position && to === position) actions.select(null)
    else pick(position, position)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      // Letting go of picked lines is this Escape's whole job; with nothing picked it belongs to the panel.
      if (!selection) return
      event.preventDefault(); event.stopPropagation()
      const back = rowOf(event.target) ? null : to
      actions.select(null)
      if (back !== null) focusRow(back)
      return
    }
    const row = rowOf(event.target)
    if (!row || row !== event.target || event.altKey || event.ctrlKey || event.metaKey) return
    const position = Number(row.dataset.position)
    if (event.key === 'Enter') { event.preventDefault(); commentOn(position); return }
    if (event.key === ' ') {
      event.preventDefault()
      if (event.shiftKey && selection) pick(selection.anchor, position)
      else if (selection && from === position && to === position) actions.select(null)
      else pick(position, position)
      return
    }
    const last = selectable.length - 1
    const next = event.key === 'ArrowDown' ? position + 1 : event.key === 'ArrowUp' ? position - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
    if (next === null) return
    event.preventDefault()
    const target = Math.max(0, Math.min(last, next))
    setActive(target)
    focusRow(target)
    if (event.shiftKey) pick(selection?.anchor ?? position, target)
  }
  // A closed draft or deleted comment takes focus with it; hand it back to the lines, unless something has had it since.
  // Comment is hidden only for the pick the open draft was written on; any other pick shows it, waiting on the draft.
  const pickIsDraft = selection !== null && draft !== null && sameLines(quotedLines(shown, selectable, from, to), draft.lines)
  const done = (position: number): void => {
    requestAnimationFrame(() => { if (document.activeElement === null || document.activeElement === document.body) focusRow(position) })
  }
  const lastPosition = (keys: ReadonlySet<string>): number => rows.reduce((found, row) => row.position !== null && keys.has(row.key) ? row.position : found, current)

  return <div className="changes-diff__body">
    {split ? <div className="changes-split__head" aria-hidden="true"><span>{labels[0]}</span><span>{labels[1]}</span></div> : null}
    <div ref={grid} className="changes-diff__rows" data-layout={split ? 'split' : 'unified'} role="grid" aria-multiselectable="true" aria-label={`Lines of ${file.path}`}
      onMouseDown={event => { if (event.shiftKey && rowOf(event.target)) event.preventDefault() }} onClick={onClick} onKeyDown={onKeyDown}>
      {rows.map(row => {
        // The draft's own lines stay marked while it is open, and a new pick shows beside them.
        const selected = row.position !== null && (row.position >= from && row.position <= to || draft !== null && draftRows.has(row.key))
        return <Fragment key={row.key}>
          <DiffRowView row={row} path={file.path} selected={selected} current={row.position === current} noted={notedRows.has(row.key)} />
          {selection && !pickIsDraft && row.position === to ? <CommentPill label={reviewLabel({ path: file.path, lines: quotedLines(shown, selectable, from, to) })} full={review.full}
            waiting={review.drafting} onPress={() => commentOn(to)} /> : null}
          {markers.get(row.key)?.map(({ comment, place }) => <CommentMarker key={comment.id} comment={comment} note={MARKER_NOTE[place]}
            onDelete={() => { actions.remove(comment.id); done(row.position ?? current) }} />)}
          {draft && draftAnchor === row.key ? <CommentDraft draft={draft} full={review.full} focus={review.focusDraft}
            onText={actions.editDraft} onCancel={() => { const back = lastPosition(draftRows); actions.cancelDraft(); done(back) }}
            onAdd={() => { const back = lastPosition(draftRows); actions.addDraft(); done(back) }} /> : null}
        </Fragment>
      })}
    </div>
    {shown.length < lines.length ? <div className="changes-diff__more"><span>Showing {shown.length.toLocaleString()} of {lines.length.toLocaleString()} lines.</span>
      <button type="button" className="files-link tt-focusable" onClick={() => setAll(true)}>Show all</button></div> : null}
  </div>
}

const sign = (line: DiffLine | undefined): string => line?.kind === 'add' ? '+' : line?.kind === 'remove' ? '−' : ''
const spoken = (line: DiffLine | undefined): ReactNode => line?.kind === 'add' ? <span className="tt-visually-hidden">Added: </span> : line?.kind === 'remove' ? <span className="tt-visually-hidden">Removed: </span> : null
const commentTitle = (number: number | null | undefined): string | undefined => number == null ? undefined : `Comment on line ${number}`

/**
 * One row. Rows carry the file and both line numbers as data; a row a comment can cover is also a grid row the
 * keyboard reaches, with its place among them and what a screen reader hears for it.
 */
const DiffRowView = memo(function DiffRowView({ row, path, selected, current, noted }: {
  readonly row: DiffRow; readonly path: string; readonly selected: boolean; readonly current: boolean; readonly noted: boolean
}): ReactNode {
  const pickable = row.position !== null ? {
    'data-position': row.position, tabIndex: current ? 0 : -1, 'aria-selected': selected, 'aria-label': rowLabel(row), 'data-noted': noted || undefined,
  } : {}
  if (row.line) {
    const { line } = row
    const number = line.newLine ?? line.oldLine
    return <div className="changes-line" role="row" data-kind={line.kind} data-path={path} data-old-line={line.oldLine ?? undefined} data-new-line={line.newLine ?? undefined} {...pickable}>
      <span className="changes-line__number" aria-hidden="true" title={row.position !== null ? commentTitle(line.oldLine ?? number) : undefined}>{line.oldLine ?? ''}</span>
      <span className="changes-line__number" aria-hidden="true" title={row.position !== null ? commentTitle(line.newLine ?? number) : undefined}>{line.newLine ?? ''}</span>
      <span className="changes-line__sign" aria-hidden="true">{sign(line)}</span>
      <span className="changes-line__text" role="gridcell">{spoken(line)}{line.text || ' '}</span>
    </div>
  }
  const cell = (line: DiffLine | undefined, side: 'old' | 'new'): ReactNode => {
    const number = side === 'old' ? line?.oldLine : line?.newLine
    return <div className="changes-split__cell" role="gridcell" data-kind={line?.kind} {...(side === 'old' ? { 'data-old-line': number ?? undefined } : { 'data-new-line': number ?? undefined })}>
      <span className="changes-line__number" aria-hidden="true" title={commentTitle(number)}>{number ?? ''}</span>
      <span className="changes-line__sign" aria-hidden="true">{sign(line)}</span>
      <span className="changes-line__text">{spoken(line)}{line?.text || ' '}</span>
    </div>
  }
  return <div className="changes-split__row" role="row" data-path={path} data-old-line={row.old?.oldLine ?? undefined} data-new-line={row.next?.newLine ?? undefined} {...pickable}>
    {cell(row.old, 'old')}{cell(row.next, 'new')}
  </div>
})

/** Comment, floating at the end of the picked lines. */
function CommentPill({ label, full, waiting, onPress }: {
  readonly label: string; readonly full: boolean
  /** The draft still open elsewhere, whose words would otherwise be replaced. */
  readonly waiting: string | null; readonly onPress: () => void
}): ReactNode {
  const why = waiting !== null ? `Finish or cancel your comment on ${waiting} first.`
    : full ? `A message carries at most ${MAX_REVIEW_COMMENTS} comments. Send it or delete one first.` : undefined
  const reason = useId()
  // Unavailable, it stays in the Tab order with its reason read out; pressed while a draft waits, it goes to that draft.
  return <div className="changes-comment-pill" role="row"><div role="gridcell">
    <button type="button" className="changes-comment-pill__button tt-focusable" aria-label={`Comment on ${label}`}
      title={why} aria-disabled={why !== undefined || undefined} aria-describedby={why !== undefined ? reason : undefined}
      onClick={() => { if (waiting !== null || !full) onPress() }}>
      <MessageSquare size={14} aria-hidden="true" />Comment</button>
    {why !== undefined ? <span id={reason} className="tt-visually-hidden">{why}</span> : null}
  </div></div>
}

/** The draft under its lines: Comment (or Ctrl+Enter) puts it on the composer, Cancel or Escape drops it. */
function CommentDraft({ draft, full, focus, standalone = false, onText, onCancel, onAdd }: {
  readonly draft: ReviewDraft; readonly full: boolean; readonly focus: { current: boolean }
  /** Outside its file's lines the draft names the whole path and is not a row of a grid. */
  readonly standalone?: boolean
  readonly onText: (text: string) => void; readonly onCancel: () => void; readonly onAdd: () => void
}): ReactNode {
  const field = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    if (!focus.current || !field.current) return
    focus.current = false
    field.current.focus({ preventScroll: true })
    field.current.closest('.changes-comment')?.scrollIntoView({ block: 'nearest' })
  })
  const label = reviewLabel(draft, standalone)
  const ready = draft.text.trim() !== '' && !full
  return <div className="changes-comment changes-comment--draft" role={standalone ? undefined : 'row'}><div className="changes-comment__cell" role={standalone ? undefined : 'gridcell'}>
    <div className="changes-comment__label">{label}</div>
    <textarea ref={field} className="changes-comment__field" rows={2} aria-label={`Comment on ${label}`} placeholder="Add a comment…" value={draft.text}
      onChange={event => onText(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
        else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (ready) onAdd() }
      }} />
    {full ? <p className="changes-comment__note">A message carries at most {MAX_REVIEW_COMMENTS} comments. Send it or delete one first.</p> : null}
    <div className="changes-comment__actions">
      <span className="changes-comment__hint" aria-hidden="true">Esc cancels</span>
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" disabled={!ready} onClick={onAdd}>Comment</Button>
    </div>
  </div></div>
}

/** Where a comment's marker is drawn: under its last line, after the rows drawn when its line is further on, or there because its lines have changed. */
type MarkerPlace = 'here' | 'further' | 'changed'
const MARKER_NOTE: Record<MarkerPlace, string | null> = {
  here: null,
  further: 'Its lines are further down. Show all to see them.',
  changed: 'These lines have changed since. The comment still sends them as they were.',
}

/** A comment waiting on the composer, under its last line, until the message goes or it is deleted. */
function CommentMarker({ comment, note, full = false, onDelete }: {
  readonly comment: ReviewComment; readonly note: string | null
  /** Outside its file's lines the marker names the whole path and is not a row of a grid. */
  readonly full?: boolean; readonly onDelete: (button: HTMLElement) => void
}): ReactNode {
  const label = reviewLabel(comment, full)
  return <div className="changes-comment changes-comment--marker" role={full ? undefined : 'row'}><div className="changes-comment__cell" role={full ? undefined : 'gridcell'}>
    <div className="changes-comment__head">
      <MessageSquare size={14} aria-hidden="true" className="changes-comment__icon" />
      <span className="changes-comment__label">{label}</span>
      <Button variant="ghost" className="changes-comment__delete" aria-label={`Delete comment on ${label}`} onClick={event => onDelete(event.currentTarget)}>Delete comment</Button>
    </div>
    <p className="changes-comment__text">{comment.text}</p>
    {note ? <p className="changes-comment__note">{note}</p> : null}
  </div></div>
}

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
