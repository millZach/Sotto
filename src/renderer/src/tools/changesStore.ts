import { useCallback, useSyncExternalStore } from 'react'
import type { Checkpoint } from '../../../shared/checkpoints'
import type { FileWorkspace } from '../../../shared/files'
import type { GitChange, GitChangesBridge, GitReviewFile } from '../../../shared/gitChanges'
import type { ToolsError, ToolsResult } from '../../../shared/tools'
import { turnPatch } from './turnDiff'

export type ChangesListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly branch: string | null; readonly revision: string; readonly files: readonly GitChange[]; readonly truncated: boolean }
  | { readonly status: 'error'; readonly error: ToolsError }

/**
 * What Changes compares, T3's scopes: the working tree against HEAD, the branch against a base (`null` is
 * Automatic), or one turn from Sotto's checkpoints (`null` is the latest turn, whichever it is when read).
 */
export type ChangesScope =
  | { readonly kind: 'working' }
  | { readonly kind: 'branch'; readonly base: string | null }
  | { readonly kind: 'turn'; readonly checkpointId: string | null }

/** How the files are drawn. Local to this session; the settings that keep them are a later ticket (#271). */
export interface ChangesView {
  readonly layout: 'stacked' | 'split'
  readonly wrap: boolean
  readonly ignoreWhitespace: boolean
  readonly fileTree: boolean
}
export const DEFAULT_CHANGES_VIEW: ChangesView = { layout: 'stacked', wrap: true, ignoreWhitespace: false, fileTree: false }

/** A comparison as read: its files, and what it compared (the resolved base, or which turn). */
export interface ChangesReview {
  readonly key: string
  readonly files: readonly GitReviewFile[]
  readonly truncated: boolean
  readonly branch?: { readonly base: string | null; readonly automatic: boolean; readonly head: string | null }
  readonly turn?: { readonly number: number; readonly checkpoint: Checkpoint }
  /** Why there is nothing to show, when the comparison itself could not be made: no turns yet, a checkpoint unavailable. */
  readonly notice?: string
}

export type ChangesReviewState =
  | { readonly status: 'loading'; readonly previous?: ChangesReview }
  | { readonly status: 'ready'; readonly review: ChangesReview }
  | { readonly status: 'error'; readonly error: ToolsError }

/** One thread's review, retained for the session while focus moves. */
export interface ThreadChanges {
  readonly threadId: string
  readonly workspace: FileWorkspace | null
  readonly list: ChangesListState
  readonly scope: ChangesScope
  readonly review: ChangesReviewState | null
  /** The thread's checkpoints, newest first, as the scope menu offers them. */
  readonly turns: readonly Checkpoint[]
  /** Collapsed files by comparison, so each scope keeps its own. */
  readonly collapsed: ReadonlyMap<string, ReadonlySet<string>>
  readonly refreshing: boolean
}

const unavailable: ToolsError = { code: 'unavailable', message: 'Changes is not available in this window.' }
const NO_FILES: ReadonlySet<string> = new Set()

/** The key a comparison is kept under: scope, base or turn, and whether whitespace is hidden. */
export function scopeKey(scope: ChangesScope, ignoreWhitespace = false): string {
  const base = scope.kind === 'working' ? 'working' : scope.kind === 'branch' ? `branch:${scope.base ?? ''}` : `turn:${scope.checkpointId ?? ''}`
  return `${base}${ignoreWhitespace ? ':w' : ''}`
}

/** A checkpoint's turn number: its place among the thread's checkpoints in this working copy, oldest first. */
export function turnNumber(turns: readonly Checkpoint[], checkpointId: string): number {
  const index = turns.findIndex(turn => turn.id === checkpointId)
  return index < 0 ? 0 : turns.length - index
}

/** The files collapsed in the comparison on screen. */
export function collapsedIn(changes: ThreadChanges): ReadonlySet<string> {
  return changes.collapsed.get(scopeKey(changes.scope)) ?? NO_FILES
}

/**
 * Per-thread Git changes and every request they make. Each reply is checked against the thread's current
 * request token, so a late list or comparison for an older refresh, another thread or a replaced working folder
 * is dropped. Refreshes keep what is shown until the new reply lands.
 */
export class ChangesStore {
  private readonly threads = new Map<string, ThreadChanges>()
  private readonly listeners = new Set<() => void>()
  private readonly tokens = new Map<string, { list: number; review: number }>()
  private readonly scroll = new Map<string, number>()
  private viewState: ChangesView = DEFAULT_CHANGES_VIEW
  private watched: { threadId: string; workspaceId: string } | null = null
  private active: { threadId: string; bridge: GitChangesBridge | undefined } | null = null
  private unsubscribe: (() => void) | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  thread(threadId: string): ThreadChanges | undefined { return this.threads.get(threadId) }
  view = (): ChangesView => this.viewState

  /** Scroll by thread and comparison, outside the snapshot so scrolling never re-renders. */
  scrollOf(threadId: string, key: string): number { return this.scroll.get(`${threadId}\n${key}`) ?? 0 }
  setScroll(threadId: string, key: string, top: number): void { this.scroll.set(`${threadId}\n${key}`, top) }

  /** Show a thread's changes and watch its working copy until `deactivate`. */
  activate(bridge: GitChangesBridge | undefined, threadId: string): void {
    this.active = { threadId, bridge }
    if (!this.threads.has(threadId)) this.set({ threadId, workspace: null, list: { status: 'loading' }, scope: { kind: 'working' }, review: null, turns: [], collapsed: new Map(), refreshing: false })
    if (bridge && this.unsubscribe === null) {
      this.unsubscribe = bridge.onChanged(event => {
        const current = this.threads.get(event.threadId)
        if (!current || current.workspace?.workspaceId !== event.workspaceId) return
        if (current.list.status === 'ready' && current.list.revision === event.revision) return
        void this.refresh(bridge, event.threadId, false)
      })
    }
    void this.refresh(bridge, threadId)
  }

  /** Stop watching: the surface was hidden, the panel closed or the target changed. */
  deactivate(bridge: GitChangesBridge | undefined): void {
    this.active = null
    const watched = this.watched
    this.watched = null
    if (watched && bridge) void bridge.watch({ ...watched, enabled: false }).catch(() => undefined)
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /**
   * Read the change list, the thread's turns and the comparison on screen again. A refresh the watch started
   * (`asked` false) leaves a turn's comparison alone unless the turns themselves changed.
   */
  async refresh(bridge: GitChangesBridge | undefined, threadId: string, asked = true): Promise<void> {
    const current = this.threads.get(threadId)
    if (!current) return
    if (!bridge) { this.set({ ...current, list: { status: 'error', error: unavailable }, refreshing: false }); return }
    const token = this.bump(threadId, 'list')
    this.set({ ...current, refreshing: true })
    const result = await settle(bridge.list({ threadId, ...(current.workspace ? { workspaceId: current.workspace.workspaceId } : {}) }))
    if (this.token(threadId, 'list') !== token) return
    const latest = this.threads.get(threadId)!
    if (!result.ok) {
      if (result.error.code === 'workspace-changed' && latest.workspace !== null) {
        // The working folder was replaced: start over against the new one rather than reusing stale paths.
        this.set({ ...latest, workspace: null, list: { status: 'loading' }, review: null, turns: [], collapsed: new Map(), refreshing: false })
        return this.refresh(bridge, threadId, asked)
      }
      this.set({ ...latest, list: { status: 'error', error: result.error }, refreshing: false })
      return
    }
    const { workspace, branch, revision, files, truncated } = result.value
    const replaced = latest.workspace !== null && latest.workspace.workspaceId !== workspace.workspaceId
    this.set({ ...latest, workspace, list: { status: 'ready', branch, revision, files, truncated }, ...(replaced ? { review: null, collapsed: new Map() } : {}), refreshing: false })
    // Only the displayed working copy owns the watcher, including after its folder is replaced.
    void this.watch(bridge, threadId)
    const turnsChanged = await this.loadTurns(bridge, threadId)
    const now = this.threads.get(threadId)
    if (!now || this.token(threadId, 'list') !== token) return
    if (asked || now.scope.kind !== 'turn' || turnsChanged || now.review === null) void this.loadReview(bridge, threadId)
  }

  /** Compare something else: another scope, base or turn. What each scope had collapsed stays with it. */
  setScope(bridge: GitChangesBridge | undefined, threadId: string, scope: ChangesScope): void {
    const current = this.threads.get(threadId)
    if (!current) return
    this.set({ ...current, scope, review: null })
    void this.loadReview(bridge, threadId)
  }

  /** Change how files are drawn. Hiding or showing whitespace reads the comparison on screen again. */
  setView(patch: Partial<ChangesView>): void {
    const before = this.viewState
    this.viewState = { ...before, ...patch }
    this.emit()
    if (before.ignoreWhitespace !== this.viewState.ignoreWhitespace && this.active) void this.loadReview(this.active.bridge, this.active.threadId)
  }

  toggleCollapsed(threadId: string, path: string): void {
    const current = this.threads.get(threadId)
    if (!current) return
    const next = new Set(collapsedIn(current))
    if (next.has(path)) next.delete(path); else next.add(path)
    this.set({ ...current, collapsed: new Map(current.collapsed).set(scopeKey(current.scope), next) })
  }

  /** Collapse every file of the comparison on screen, or expand them all. */
  setAllCollapsed(threadId: string, collapsed: boolean): void {
    const current = this.threads.get(threadId)
    if (!current) return
    const review = current.review?.status === 'ready' ? current.review.review : current.review?.status === 'loading' ? current.review.previous : undefined
    const next = collapsed ? new Set(review?.files.map(file => file.path) ?? []) : new Set<string>()
    this.set({ ...current, collapsed: new Map(current.collapsed).set(scopeKey(current.scope), next) })
  }

  async copyPath(bridge: GitChangesBridge | undefined, threadId: string, path: string): Promise<ToolsResult<unknown>> {
    return this.pathAction(bridge, threadId, path, 'copyPath')
  }

  async reveal(bridge: GitChangesBridge | undefined, threadId: string, path: string): Promise<ToolsResult<unknown>> {
    return this.pathAction(bridge, threadId, path, 'reveal')
  }

  private async pathAction(bridge: GitChangesBridge | undefined, threadId: string, path: string, action: 'copyPath' | 'reveal'): Promise<ToolsResult<unknown>> {
    const workspace = this.threads.get(threadId)?.workspace
    if (!bridge || !workspace) return { ok: false, error: unavailable }
    return settle(bridge[action]({ threadId, workspaceId: workspace.workspaceId, path }))
  }

  /** The thread's checkpoints for the scope menu. Resolves true when they changed. */
  private async loadTurns(bridge: GitChangesBridge, threadId: string): Promise<boolean> {
    const current = this.threads.get(threadId)
    if (!current?.workspace || !bridge.checkpoints) return false
    const workspaceId = current.workspace.workspaceId
    const result = await settle(bridge.checkpoints({ threadId, workspaceId }))
    const latest = this.threads.get(threadId)
    if (!latest || latest.workspace?.workspaceId !== workspaceId || !result.ok) return false
    const turns = result.value.checkpoints
    const changed = JSON.stringify(turns.map(turn => [turn.id, turn.status])) !== JSON.stringify(latest.turns.map(turn => [turn.id, turn.status]))
    if (changed) this.set({ ...latest, turns })
    return changed
  }

  private async loadReview(bridge: GitChangesBridge | undefined, threadId: string): Promise<void> {
    const current = this.threads.get(threadId)
    if (!current) return
    if (!current.workspace || !bridge) { this.set({ ...current, review: { status: 'error', error: unavailable } }); return }
    const token = this.bump(threadId, 'review')
    const { scope } = current
    const ignoreWhitespace = this.viewState.ignoreWhitespace
    const key = scopeKey(scope, ignoreWhitespace)
    const shown = current.review?.status === 'ready' ? current.review.review : current.review?.status === 'loading' ? current.review.previous : undefined
    // What is on screen stays while the same comparison is read again; another comparison starts empty.
    const previous = shown && shown.key.replace(/:w$/u, '') === key.replace(/:w$/u, '') ? shown : undefined
    this.set({ ...current, review: { status: 'loading', ...(previous ? { previous } : {}) } })
    const target = { threadId, workspaceId: current.workspace.workspaceId }
    let next: ChangesReviewState
    if (scope.kind !== 'turn') {
      const result = await settle(bridge.review({ ...target, scope, ignoreWhitespace }))
      next = !result.ok ? { status: 'error', error: result.error } : {
        status: 'ready', review: { key, files: result.value.files, truncated: result.value.truncated,
          ...(result.value.scope.kind === 'branch' ? { branch: { base: result.value.scope.base, automatic: result.value.scope.automatic, head: result.value.scope.head } } : {}) },
      }
    } else next = await this.readTurn(bridge, target, scope.checkpointId, key, ignoreWhitespace)
    const latest = this.threads.get(threadId)
    if (!latest || this.token(threadId, 'review') !== token) return
    this.set({ ...latest, review: next })
  }

  /** A turn's comparison from its checkpoint; a checkpoint that cannot be read says so rather than showing nothing. */
  private async readTurn(bridge: GitChangesBridge, target: { threadId: string; workspaceId: string }, checkpointId: string | null, key: string, ignoreWhitespace: boolean): Promise<ChangesReviewState> {
    if (!bridge.checkpoints || !bridge.inspectCheckpoint) return { status: 'error', error: { code: 'unavailable', message: 'Checkpoints are unavailable in this window.' } }
    const listing = await settle(bridge.checkpoints(target))
    if (!listing.ok) return { status: 'error', error: listing.error }
    const turns = listing.value.checkpoints
    const latest = this.threads.get(target.threadId)
    if (latest && JSON.stringify(turns.map(turn => [turn.id, turn.status])) !== JSON.stringify(latest.turns.map(turn => [turn.id, turn.status]))) this.set({ ...latest, turns })
    const checkpoint = checkpointId === null ? turns[0] : turns.find(turn => turn.id === checkpointId)
    if (!checkpoint) return { status: 'ready', review: { key, files: [], truncated: false, notice: checkpointId === null ? 'No completed turns yet.' : 'This turn is no longer listed.' } }
    const number = turnNumber(turns, checkpoint.id)
    const unavailableTurn = (reason: string | undefined): ChangesReviewState => ({ status: 'ready', review: { key, files: [], truncated: false, turn: { number, checkpoint },
      notice: `Turn ${number}’s checkpoint is unavailable, so its changes cannot be shown.${reason ? ` ${reason}` : ''}` } })
    if (checkpoint.status === 'unavailable') return unavailableTurn(checkpoint.reason)
    const inspection = await settle(bridge.inspectCheckpoint({ ...target, checkpointId: checkpoint.id }))
    if (!inspection.ok) return unavailableTurn(inspection.error.message)
    const change = new Map(inspection.value.checkpoint.files.map(file => [file.path, file.change]))
    const files: GitReviewFile[] = []
    for (const patch of inspection.value.patches) {
      const status = change.get(patch.path) ?? 'modified'
      if (patch.binary) { files.push({ path: patch.path, status, additions: null, deletions: null, content: { kind: 'binary', message: 'Binary or larger than 256 KiB: no text diff.' } }); continue }
      const built = turnPatch(patch.path, status === 'added' ? null : patch.before ?? '', status === 'deleted' ? null : patch.after ?? '', ignoreWhitespace)
      if (!built.patch) continue
      files.push({ path: patch.path, status, additions: built.additions, deletions: built.deletions, content: { kind: 'text', patch: built.patch } })
    }
    return { status: 'ready', review: { key, files, truncated: false, turn: { number, checkpoint: inspection.value.checkpoint } } }
  }

  private async watch(bridge: GitChangesBridge | undefined, threadId: string): Promise<void> {
    const workspace = this.threads.get(threadId)?.workspace
    if (!bridge || !workspace || this.unsubscribe === null || this.active?.threadId !== threadId || this.active.bridge !== bridge) return
    const next = { threadId, workspaceId: workspace.workspaceId }
    if (this.watched?.threadId === next.threadId && this.watched.workspaceId === next.workspaceId) return
    if (this.watched) void bridge.watch({ ...this.watched, enabled: false }).catch(() => undefined)
    this.watched = next
    await settle(bridge.watch({ ...next, enabled: true }))
  }

  private bump(threadId: string, kind: 'list' | 'review'): number {
    const tokens = this.tokens.get(threadId) ?? { list: 0, review: 0 }
    tokens[kind] += 1
    this.tokens.set(threadId, tokens)
    return tokens[kind]
  }

  private token(threadId: string, kind: 'list' | 'review'): number { return this.tokens.get(threadId)?.[kind] ?? 0 }

  private set(next: ThreadChanges): void {
    this.threads.set(next.threadId, next)
    this.emit()
  }

  private emit(): void { for (const listener of [...this.listeners]) listener() }
}

async function settle<T>(request: Promise<ToolsResult<T>>): Promise<ToolsResult<T>> {
  try { return await request } catch { return { ok: false, error: { code: 'unavailable', message: 'Sotto did not answer.' } } }
}

export function useThreadChanges(store: ChangesStore, threadId: string | null): ThreadChanges | undefined {
  const read = useCallback(() => threadId === null ? undefined : store.thread(threadId), [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
}

export function useChangesView(store: ChangesStore): ChangesView {
  return useSyncExternalStore(store.subscribe, store.view)
}

export interface DiffLine {
  readonly kind: 'meta' | 'hunk' | 'context' | 'add' | 'remove' | 'note'
  readonly text: string
  readonly oldLine: number | null
  readonly newLine: number | null
}

/** A unified patch as numbered rows. Headers before the first hunk are kept as meta rows; nothing is reordered. */
export function parseUnifiedDiff(patch: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  const source = patch.endsWith('\n') ? patch.slice(0, -1) : patch
  if (source === '') return lines
  for (const text of source.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      lines.push({ kind: 'hunk', text, oldLine: null, newLine: null })
    } else if (!inHunk) lines.push({ kind: 'meta', text, oldLine: null, newLine: null })
    else if (text.startsWith('+')) lines.push({ kind: 'add', text: text.slice(1), oldLine: null, newLine: newLine++ })
    else if (text.startsWith('-')) lines.push({ kind: 'remove', text: text.slice(1), oldLine: oldLine++, newLine: null })
    else if (text.startsWith('\\')) lines.push({ kind: 'note', text: text.slice(1).trim(), oldLine: null, newLine: null })
    else if (text.startsWith('diff --git')) { inHunk = false; lines.push({ kind: 'meta', text, oldLine: null, newLine: null }) }
    else lines.push({ kind: 'context', text: text.startsWith(' ') ? text.slice(1) : text, oldLine: oldLine++, newLine: newLine++ })
  }
  return lines
}

export const CHANGE_STATUS: Record<GitChange['status'], { readonly letter: string; readonly label: string }> = {
  modified: { letter: 'M', label: 'Modified' }, added: { letter: 'A', label: 'Added' }, deleted: { letter: 'D', label: 'Deleted' },
  renamed: { letter: 'R', label: 'Renamed' }, untracked: { letter: 'U', label: 'Untracked' }, conflicted: { letter: 'C', label: 'Conflicted' },
  'type-changed': { letter: 'T', label: 'Type changed' },
}
