import { useCallback, useSyncExternalStore } from 'react'
import type { FileWorkspace } from '../../../shared/files'
import type { GitChange, GitChangesBridge, GitFileDiff } from '../../../shared/gitChanges'
import type { ToolsError, ToolsResult } from '../../../shared/tools'

export type ChangesListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly branch: string | null; readonly revision: string; readonly files: readonly GitChange[]; readonly truncated: boolean }
  | { readonly status: 'error'; readonly error: ToolsError }

export type ChangesDiffState =
  | { readonly status: 'loading'; readonly path: string; readonly previous?: GitFileDiff }
  | { readonly status: 'ready'; readonly path: string; readonly diff: GitFileDiff }
  | { readonly status: 'error'; readonly path: string; readonly error: ToolsError }

/** One thread's working-copy review, retained for the session while focus moves. */
export interface ThreadChanges {
  readonly threadId: string
  readonly workspace: FileWorkspace | null
  readonly list: ChangesListState
  readonly selectedPath: string | null
  readonly diff: ChangesDiffState | null
  readonly refreshing: boolean
}

const unavailable: ToolsError = { code: 'unavailable', message: 'Changes is not available in this window.' }

/**
 * Per-thread Git changes and every request they make. Each reply is checked against the thread's current
 * request token, so a late list or diff for an older refresh, another thread or a replaced working folder is
 * dropped. Refreshes keep the selection and never clear what is already shown until the new reply lands.
 */
export class ChangesStore {
  private readonly threads = new Map<string, ThreadChanges>()
  private readonly listeners = new Set<() => void>()
  private readonly tokens = new Map<string, { list: number; diff: number }>()
  private readonly scroll = new Map<string, number>()
  private watched: { threadId: string; workspaceId: string } | null = null
  private unsubscribe: (() => void) | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  thread(threadId: string): ThreadChanges | undefined { return this.threads.get(threadId) }

  /** Diff scroll by thread and path, outside the snapshot so scrolling never re-renders. */
  scrollOf(threadId: string, path: string): number { return this.scroll.get(`${threadId}\n${path}`) ?? 0 }
  setScroll(threadId: string, path: string, top: number): void { this.scroll.set(`${threadId}\n${path}`, top) }

  /** Show a thread's changes and watch its working copy until `deactivate`. */
  activate(bridge: GitChangesBridge | undefined, threadId: string): void {
    if (!this.threads.has(threadId)) this.set({ threadId, workspace: null, list: { status: 'loading' }, selectedPath: null, diff: null, refreshing: false })
    if (bridge && this.unsubscribe === null) {
      this.unsubscribe = bridge.onChanged(event => {
        const current = this.threads.get(event.threadId)
        if (!current || current.workspace?.workspaceId !== event.workspaceId) return
        if (current.list.status === 'ready' && current.list.revision === event.revision) return
        void this.refresh(bridge, event.threadId)
      })
    }
    void this.refresh(bridge, threadId).then(() => this.watch(bridge, threadId))
  }

  /** Stop watching: the surface was hidden, the panel closed or the target changed. */
  deactivate(bridge: GitChangesBridge | undefined): void {
    const watched = this.watched
    this.watched = null
    if (watched && bridge) void bridge.watch({ ...watched, enabled: false }).catch(() => undefined)
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  async refresh(bridge: GitChangesBridge | undefined, threadId: string): Promise<void> {
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
        this.set({ threadId, workspace: null, list: { status: 'loading' }, selectedPath: null, diff: null, refreshing: false })
        return this.refresh(bridge, threadId)
      }
      this.set({ ...latest, list: { status: 'error', error: result.error }, refreshing: false })
      return
    }
    const { workspace, branch, revision, files, truncated } = result.value
    const replaced = latest.workspace !== null && latest.workspace.workspaceId !== workspace.workspaceId
    const selectedPath = replaced ? null : latest.selectedPath
    this.set({ ...latest, workspace, list: { status: 'ready', branch, revision, files, truncated }, selectedPath, diff: replaced ? null : latest.diff, refreshing: false })
    if (selectedPath !== null) void this.loadDiff(bridge, threadId, selectedPath, true)
  }

  select(bridge: GitChangesBridge | undefined, threadId: string, path: string | null): void {
    const current = this.threads.get(threadId)
    if (!current) return
    this.set({ ...current, selectedPath: path, diff: null })
    if (path !== null) void this.loadDiff(bridge, threadId, path, false)
    else this.bump(threadId, 'diff')
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

  private async loadDiff(bridge: GitChangesBridge | undefined, threadId: string, path: string, keepShown: boolean): Promise<void> {
    const current = this.threads.get(threadId)
    if (!current?.workspace || !bridge) {
      if (current) this.set({ ...current, diff: { status: 'error', path, error: unavailable } })
      return
    }
    const token = this.bump(threadId, 'diff')
    const shown = current.diff?.status === 'ready' && current.diff.path === path ? current.diff.diff : undefined
    if (!keepShown || !shown) this.set({ ...current, diff: { status: 'loading', path, ...(shown ? { previous: shown } : {}) } })
    const result = await settle(bridge.diff({ threadId, workspaceId: current.workspace.workspaceId, path }))
    const latest = this.threads.get(threadId)
    if (!latest || this.token(threadId, 'diff') !== token || latest.selectedPath !== path) return
    this.set({ ...latest, diff: result.ok ? { status: 'ready', path, diff: result.value } : { status: 'error', path, error: result.error } })
  }

  private async watch(bridge: GitChangesBridge | undefined, threadId: string): Promise<void> {
    const workspace = this.threads.get(threadId)?.workspace
    if (!bridge || !workspace || this.unsubscribe === null) return
    const next = { threadId, workspaceId: workspace.workspaceId }
    if (this.watched?.threadId === next.threadId && this.watched.workspaceId === next.workspaceId) return
    if (this.watched) void bridge.watch({ ...this.watched, enabled: false }).catch(() => undefined)
    this.watched = next
    await settle(bridge.watch({ ...next, enabled: true }))
  }

  private bump(threadId: string, kind: 'list' | 'diff'): number {
    const tokens = this.tokens.get(threadId) ?? { list: 0, diff: 0 }
    tokens[kind] += 1
    this.tokens.set(threadId, tokens)
    return tokens[kind]
  }

  private token(threadId: string, kind: 'list' | 'diff'): number { return this.tokens.get(threadId)?.[kind] ?? 0 }

  private set(next: ThreadChanges): void {
    this.threads.set(next.threadId, next)
    for (const listener of [...this.listeners]) listener()
  }
}

async function settle<T>(request: Promise<ToolsResult<T>>): Promise<ToolsResult<T>> {
  try { return await request } catch { return { ok: false, error: { code: 'unavailable', message: 'Sotto did not answer.' } } }
}

export function useThreadChanges(store: ChangesStore, threadId: string | null): ThreadChanges | undefined {
  const read = useCallback(() => threadId === null ? undefined : store.thread(threadId), [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
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
