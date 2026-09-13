import type { FileListing, FilePath, FilePreview, FileWorkspace, FilesBridge, FilesError, FilesResult } from '../../../shared/files'

export type FileEntry = FileListing['entries'][number]
export type ListingState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly entries: readonly FileEntry[]; readonly truncated: boolean }
  | { readonly status: 'error'; readonly error: FilesError }
export type PreviewState =
  | { readonly status: 'loading'; readonly path: string }
  | { readonly status: 'ready'; readonly path: string; readonly preview: FilePreview }
  | { readonly status: 'error'; readonly path: string; readonly error: FilesError }

/** One thread's browsing, retained for the session while focus moves between threads. */
export interface ThreadFiles {
  readonly threadId: string
  /** Advances whenever the working folder is replaced; replies from an older generation are dropped. */
  readonly generation: number
  readonly workspace: FileWorkspace | null
  readonly listings: ReadonlyMap<string, ListingState>
  readonly expanded: ReadonlySet<string>
  /** The file shown in the preview. */
  readonly selectedPath: string | null
  /** The tree row that holds keyboard focus. */
  readonly focusedPath: string | null
  readonly preview: PreviewState | null
  readonly markdownView: 'rendered' | 'source'
  /** Set once when the working folder was replaced, so the reset is explained rather than silent. */
  readonly workspaceChanged: boolean
  readonly refreshing: boolean
}

export type PathAction = 'copyPath' | 'reveal'

const ROOT = ''
const unavailableBridge: FilesError = { code: 'unavailable', message: 'Files is not available in this window.' }

function freshThread(threadId: string, generation = 0, workspaceChanged = false): ThreadFiles {
  return {
    threadId, generation, workspace: null, listings: new Map([[ROOT, { status: 'loading' }]]), expanded: new Set(),
    selectedPath: null, focusedPath: null, preview: null, markdownView: 'rendered', workspaceChanged, refreshing: false,
  }
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? ROOT : path.slice(0, index)
}

/**
 * Per-thread Files state and every request it makes. The workspace ID from the first root listing is
 * sent with every later request; a different ID or a `workspace-changed` reply clears that thread's
 * tree, selection and preview and lists the new root. A stale relative path is never retried.
 */
export class FilesBrowserStore {
  private readonly threads = new Map<string, ThreadFiles>()
  private readonly listeners = new Set<() => void>()
  private readonly scroll = new Map<string, { tree: number; preview: number }>()
  private readonly inflight = new Set<string>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  thread(threadId: string): ThreadFiles | undefined { return this.threads.get(threadId) }

  /** Scroll offsets are kept outside the snapshot so scrolling never re-renders the panel. */
  scrollOf(threadId: string): { tree: number; preview: number } { return this.scroll.get(threadId) ?? { tree: 0, preview: 0 } }
  setScroll(threadId: string, region: 'tree' | 'preview', top: number): void {
    this.scroll.set(threadId, { ...this.scrollOf(threadId), [region]: top })
  }

  /** Show a thread: first time lists its root; afterwards shows what was retained and revalidates it. */
  activate(bridge: FilesBridge | undefined, threadId: string): void {
    if (!this.threads.has(threadId)) {
      this.set(freshThread(threadId))
      void this.loadRoot(bridge, threadId)
      return
    }
    void this.refresh(bridge, threadId)
  }

  /** Re-list the root (without the token, to detect a replaced folder), every open folder and the preview. */
  async refresh(bridge: FilesBridge | undefined, threadId: string): Promise<void> {
    const current = this.threads.get(threadId)
    if (!current) return this.activate(bridge, threadId)
    if (this.inflight.has(threadId)) return
    this.inflight.add(threadId)
    this.patch(threadId, current.generation, { refreshing: true })
    try {
      const changed = await this.loadRoot(bridge, threadId)
      const latest = this.threads.get(threadId)
      if (changed || !latest?.workspace) return
      await Promise.all([
        ...[...latest.expanded].map(path => this.loadDirectory(bridge, threadId, path)),
        ...(latest.selectedPath === null ? [] : [this.loadPreview(bridge, threadId, latest.selectedPath, true)]),
      ])
    } finally {
      this.inflight.delete(threadId)
      const latest = this.threads.get(threadId)
      if (latest?.refreshing) this.patch(threadId, latest.generation, { refreshing: false })
    }
  }

  toggleDirectory(bridge: FilesBridge | undefined, threadId: string, path: string, open?: boolean): void {
    const current = this.threads.get(threadId)
    if (!current) return
    const expanded = new Set(current.expanded)
    const next = open ?? !expanded.has(path)
    if (next === expanded.has(path)) return
    if (next) expanded.add(path)
    else expanded.delete(path)
    this.patch(threadId, current.generation, { expanded, focusedPath: path })
    const listing = current.listings.get(path)
    if (next && listing?.status !== 'ready') void this.loadDirectory(bridge, threadId, path)
  }

  reloadDirectory(bridge: FilesBridge | undefined, threadId: string, path: string): void {
    void this.loadDirectory(bridge, threadId, path)
  }

  focusPath(threadId: string, path: string): void {
    const current = this.threads.get(threadId)
    if (current && current.focusedPath !== path) this.patch(threadId, current.generation, { focusedPath: path })
  }

  openFile(bridge: FilesBridge | undefined, threadId: string, path: string): void {
    const current = this.threads.get(threadId)
    if (!current) return
    if (current.selectedPath !== path) this.scroll.set(threadId, { ...this.scrollOf(threadId), preview: 0 })
    this.patch(threadId, current.generation, { selectedPath: path, focusedPath: path, preview: { status: 'loading', path } })
    void this.loadPreview(bridge, threadId, path, false)
  }

  closePreview(threadId: string): void {
    const current = this.threads.get(threadId)
    if (current) this.patch(threadId, current.generation, { selectedPath: null, preview: null })
  }

  setMarkdownView(threadId: string, markdownView: ThreadFiles['markdownView']): void {
    const current = this.threads.get(threadId)
    if (current) this.patch(threadId, current.generation, { markdownView })
  }

  dismissWorkspaceChanged(threadId: string): void {
    const current = this.threads.get(threadId)
    if (current?.workspaceChanged) this.patch(threadId, current.generation, { workspaceChanged: false })
  }

  /** A path that disappeared: forget the preview and list its folder again. */
  recoverMissing(bridge: FilesBridge | undefined, threadId: string, path: string): void {
    const current = this.threads.get(threadId)
    if (!current) return
    const folder = parentPath(path)
    this.patch(threadId, current.generation, current.selectedPath === path ? { selectedPath: null, preview: null, focusedPath: folder || null } : {})
    void (folder === ROOT ? this.refresh(bridge, threadId) : this.loadDirectory(bridge, threadId, folder))
  }

  /** Copy or reveal through main. Resolves to the main result; a replaced folder resets the thread. */
  async pathAction(bridge: FilesBridge | undefined, threadId: string, action: PathAction, path: string): Promise<FilesResult<FilePath>> {
    const current = this.threads.get(threadId)
    if (!bridge) return { ok: false, error: unavailableBridge }
    if (!current?.workspace) return { ok: false, error: { code: 'workspace-unavailable', message: 'Refresh Files first.' } }
    const { generation, workspace } = current
    const result = await this.call(() => bridge[action]({ threadId, path, workspaceId: workspace.workspaceId }))
    this.checkWorkspace(bridge, threadId, generation, result)
    return result
  }

  // Lists the root without a token. Resolves true when the working folder was replaced.
  private async loadRoot(bridge: FilesBridge | undefined, threadId: string): Promise<boolean> {
    const start = this.threads.get(threadId)
    if (!start) return false
    if (!bridge) {
      this.patch(threadId, start.generation, { listings: withListing(start.listings, ROOT, { status: 'error', error: unavailableBridge }) })
      return false
    }
    const result = await this.call(() => bridge.list({ threadId, path: ROOT }))
    const current = this.threads.get(threadId)
    if (!current || current.generation !== start.generation) return false
    if (!result.ok) {
      // A missing folder is shown in place of the tree; what was open is kept for when it returns.
      this.patch(threadId, current.generation, { listings: withListing(current.listings, ROOT, { status: 'error', error: result.error }) })
      return false
    }
    const { workspace } = result.value
    if (current.workspace && current.workspace.workspaceId !== workspace.workspaceId) {
      this.set({ ...freshThread(threadId, current.generation + 1, true), workspace, listings: new Map([[ROOT, ready(result.value)]]) })
      return true
    }
    this.patch(threadId, current.generation, { workspace, listings: withListing(current.listings, ROOT, ready(result.value)) })
    return false
  }

  private async loadDirectory(bridge: FilesBridge | undefined, threadId: string, path: string): Promise<void> {
    const start = this.threads.get(threadId)
    if (!start) return
    if (!bridge || !start.workspace) {
      if (!start.workspace && bridge) await this.loadRoot(bridge, threadId)
      return
    }
    const { generation, workspace } = start
    if (start.listings.get(path)?.status !== 'ready') this.patch(threadId, generation, { listings: withListing(start.listings, path, { status: 'loading' }) })
    const result = await this.call(() => bridge.list({ threadId, path, workspaceId: workspace.workspaceId }))
    if (this.checkWorkspace(bridge, threadId, generation, result)) return
    const current = this.threads.get(threadId)
    if (!current || current.generation !== generation) return
    this.patch(threadId, generation, { listings: withListing(current.listings, path, result.ok ? ready(result.value) : { status: 'error', error: result.error }) })
  }

  private async loadPreview(bridge: FilesBridge | undefined, threadId: string, path: string, quiet: boolean): Promise<void> {
    const start = this.threads.get(threadId)
    if (!start) return
    if (!bridge || !start.workspace) {
      this.patch(threadId, start.generation, { preview: { status: 'error', path, error: bridge ? { code: 'workspace-unavailable', message: '' } : unavailableBridge } })
      return
    }
    const { generation, workspace } = start
    const result = await this.call(() => bridge.preview({ threadId, path, workspaceId: workspace.workspaceId }))
    if (this.checkWorkspace(bridge, threadId, generation, result)) return
    const current = this.threads.get(threadId)
    if (!current || current.generation !== generation || current.selectedPath !== path) return
    // A quiet refresh keeps the readable preview when only a transient busy reply came back.
    if (quiet && !result.ok && result.error.code === 'busy' && current.preview?.status === 'ready') return
    this.patch(threadId, generation, { preview: result.ok ? { status: 'ready', path, preview: result.value } : { status: 'error', path, error: result.error } })
  }

  // True when the reply proves the working folder was replaced; the thread is reset and its root listed.
  private checkWorkspace(bridge: FilesBridge, threadId: string, generation: number, result: FilesResult<{ workspace: FileWorkspace }>): boolean {
    const current = this.threads.get(threadId)
    if (!current || current.generation !== generation) return true
    const replaced = result.ok
      ? current.workspace !== null && result.value.workspace.workspaceId !== current.workspace.workspaceId
      : result.error.code === 'workspace-changed'
    if (!replaced) return false
    this.set(freshThread(threadId, generation + 1, true))
    void this.loadRoot(bridge, threadId)
    return true
  }

  private async call<T>(request: () => Promise<FilesResult<T>>): Promise<FilesResult<T>> {
    try { return await request() } catch { return { ok: false, error: { code: 'unavailable', message: 'Files could not be reached.' } } }
  }

  private patch(threadId: string, generation: number, patch: Partial<ThreadFiles>): void {
    const current = this.threads.get(threadId)
    if (!current || current.generation !== generation) return
    this.set({ ...current, ...patch })
  }

  private set(next: ThreadFiles): void {
    this.threads.set(next.threadId, next)
    for (const listener of [...this.listeners]) listener()
  }
}

function ready(listing: FileListing): ListingState {
  return { status: 'ready', entries: listing.entries, truncated: listing.truncated }
}

function withListing(listings: ReadonlyMap<string, ListingState>, path: string, state: ListingState): ReadonlyMap<string, ListingState> {
  const next = new Map(listings)
  next.set(path, state)
  return next
}

export interface TreeRow {
  readonly kind: 'entry' | 'loading' | 'error' | 'truncated' | 'empty'
  readonly key: string
  readonly depth: number
  readonly entry?: FileEntry
  readonly parent: string
  readonly error?: FilesError
  readonly expanded?: boolean | undefined
  readonly setSize?: number
  readonly position?: number
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  const rank = (entry: FileEntry): number => entry.kind === 'directory' ? 0 : 1
  return [...entries].sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The visible tree as flat rows: open folders contribute their children, status rows explain the rest. */
export function visibleRows(files: ThreadFiles): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (path: string, depth: number): void => {
    const listing = files.listings.get(path)
    if (!listing || listing.status === 'loading') { rows.push({ kind: 'loading', key: `${path} loading`, depth, parent: path }); return }
    if (listing.status === 'error') { rows.push({ kind: 'error', key: `${path} error`, depth, parent: path, error: listing.error }); return }
    const entries = sortEntries(listing.entries)
    if (!entries.length) rows.push({ kind: 'empty', key: `${path} empty`, depth, parent: path })
    entries.forEach((entry, index) => {
      const expanded = entry.kind === 'directory' ? files.expanded.has(entry.path) : undefined
      rows.push({ kind: 'entry', key: entry.path, depth, entry, parent: path, expanded, setSize: entries.length, position: index + 1 })
      if (expanded) walk(entry.path, depth + 1)
    })
    if (listing.truncated) rows.push({ kind: 'truncated', key: `${path} truncated`, depth, parent: path })
  }
  walk(ROOT, 0)
  return rows
}
