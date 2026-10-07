import { useCallback, useSyncExternalStore } from 'react'
import { safeBrowserUrl, type BrowserBounds, type BrowserBridge, type BrowserEvent, type BrowserPage, type BrowserGrantView, type BrowserTask } from '../../../shared/browser'
import type { FileWorkspace } from '../../../shared/files'
import type { ToolsError, ToolsResult } from '../../../shared/tools'

export interface ThreadBrowser {
  readonly threadId: string
  readonly workspace: FileWorkspace | null
  readonly status: 'loading' | 'ready' | 'error'
  readonly error: ToolsError | null
  readonly pages: readonly BrowserPage[]
  readonly activePageId: string | null
  /** A create, navigation or close is on its way. */
  readonly busy: boolean
  /** The last action that failed, in words. */
  readonly notice: string | null
  /** A page main would not show, and why. It stays off the window until the reader tries again. */
  readonly placementProblem: { readonly pageId: string; readonly message: string } | null
  /** The thread's browser grant while it lives: it opens, navigates, clicks and types without asking (ADR-0029). */
  readonly grant: BrowserGrantView | null
}

const unavailable: ToolsError = { code: 'unavailable', message: 'Browser is not available in this window.' }

/** Local development hosts open over plain HTTP; everything else typed without a scheme gets HTTPS. */
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/iu

/** What the address field turns into a page URL, or why it cannot. */
export function normalizeAddress(input: string): { readonly url: string } | { readonly error: string } {
  const value = input.trim()
  if (!value) return { error: 'Enter a web address.' }
  if (/\s/u.test(value)) return { error: 'Enter a web address, such as localhost:5173 or example.com.' }
  const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(value)
  const hasScheme = scheme !== null && (value.slice(scheme[0].length).startsWith('//') || !/^\d/u.test(value.slice(scheme[0].length)))
  if (hasScheme && !/^https?:$/iu.test(scheme[0])) return { error: 'The browser opens HTTP and HTTPS pages only.' }
  const candidate = hasScheme ? value : `${LOCAL_HOST.test(value) ? 'http' : 'https'}://${value}`
  const url = safeBrowserUrl(candidate)
  if (url === null) return { error: 'That is not a web address the browser can open.' }
  return { url }
}

/** The thread's test iPhone (ADR-0045): a page in its browser drawn as a phone, never one of Tools > Browser's tabs. */
export function phonePage(browser: ThreadBrowser | undefined): BrowserPage | undefined {
  return browser?.pages.find(page => page.device === 'iphone')
}
/** The pages Tools > Browser lists: everything but the test iPhone, which has its own surface. */
export function browserPages(pages: readonly BrowserPage[]): readonly BrowserPage[] {
  return pages.filter(page => !page.device)
}
/** Where main draws a page: Tools > Browser and the Browser player share the pane's slot; the test iPhone has its own. */
type MountSlot = 'pane' | 'phone'
interface Placement { bridge: BrowserBridge; threadId: string; workspaceId: string; pageId: string; bounds: BrowserBounds; request: number }

/** How a page reads in its tab: its title, else its host. */
export function pageLabel(page: BrowserPage): string {
  if (page.title.trim()) return page.title.trim()
  try { return new URL(page.url).host || page.url } catch { return page.url }
}

function sameBounds(a: BrowserBounds | null, b: BrowserBounds | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
}

/**
 * Embedded pages per thread. Main owns every page and its native view; the renderer lists them, drives
 * navigation and tells main where the one visible page sits. Pages stay alive while hidden.
 */
export class BrowserStore {
  private tasksSnapshot: readonly BrowserTask[] = []
  private readonly taskThreads = new Set<string>()
  taskSnapshot = (): readonly BrowserTask[] => this.tasksSnapshot
  /** Subscribe before Tools opens, so background browser work can introduce itself in the player. */
  watchTasks(bridge: BrowserBridge | undefined, threadIds: readonly string[]): void {
    if (!bridge) return
    this.listen(bridge)
    const tasks = bridge.tasks
    if (!tasks) return
    for (const threadId of threadIds) {
      if (this.taskThreads.has(threadId)) continue
      this.taskThreads.add(threadId)
      // A bridge that refuses another host's thread throws before the promise exists. That must not
      // skip the rest of the list or unmount the page, and the thread must not stay marked watched.
      let listed: Promise<ToolsResult<readonly BrowserTask[]>>
      try { listed = settle(Promise.resolve(tasks({ threadId }))) } catch { this.taskThreads.delete(threadId); continue }
      void listed.then(result => {
        if (!result.ok) { this.taskThreads.delete(threadId); return }
        for (const task of result.value) this.receiveTask(task)
      })
    }
  }
  async controlTask(bridge: BrowserBridge | undefined, task: BrowserTask, control: 'pause' | 'resume'): Promise<string | null> {
    if (!bridge?.controlTask) return 'Browser control is unavailable.'
    const result = await settle(bridge.controlTask({ threadId: task.threadId, workspaceId: task.workspaceId, pageId: task.pageId, taskId: task.id, control }))
    if (result.ok) { this.receiveTask(result.value); return null }
    return result.error.message
  }
  /** `forThread` also grants the thread the browser without asking for the rest of the session (ADR-0029). */
  async answerAction(bridge: BrowserBridge | undefined, task: BrowserTask, allow: boolean, forThread = false): Promise<string | null> {
    if (!bridge?.answerAction || !task.pendingAction) return 'This action is no longer waiting.'
    const result = await settle(bridge.answerAction({ threadId: task.threadId, workspaceId: task.workspaceId, pageId: task.pageId, taskId: task.id, actionId: task.pendingAction.id, allow, ...(forThread ? { forThread: true as const } : {}) }))
    if (result.ok) { this.receiveTask(result.value); return null }
    return result.error.message
  }
  /** The user's Stop on a browser grant. Main's event clears it too; clearing here keeps the line honest if that event is late. */
  async stopGrant(bridge: BrowserBridge | undefined, threadId: string): Promise<string | null> {
    const workspace = this.threads.get(threadId)?.workspace
    if (!bridge?.stopGrant || !workspace) return 'Browser is not available in this window.'
    const result = await settle(bridge.stopGrant({ threadId, workspaceId: workspace.workspaceId }))
    if (!result.ok) return `Could not stop this thread using the browser without asking; try Stop again. ${result.error.message}`.trim()
    this.patch(threadId, { grant: null })
    return null
  }
  private receiveTask(task: BrowserTask): void {
    const previous = this.tasksSnapshot.find(item => item.id === task.id)
    if (previous && previous.updatedAt > task.updatedAt) return
    this.tasksSnapshot = [...this.tasksSnapshot.filter(item => item.id !== task.id), task].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100)
    this.emit()
  }
  private emit(): void { for (const listener of [...this.listeners]) listener() }
  private readonly threads = new Map<string, ThreadBrowser>()
  private readonly listeners = new Set<() => void>()
  private readonly listTokens = new Map<string, number>()
  private subscribed: BrowserBridge | null = null
  private unsubscribe: (() => void) | null = null
  /** The latest desired page and rectangle in each slot, including a placement waiting for main. */
  private readonly mounted = new Map<MountSlot, Placement>()
  private placements = 0
  private readonly placementPending = new Set<MountSlot>()
  private readonly queuedPlacement = new Map<MountSlot, () => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  thread(threadId: string): ThreadBrowser | undefined { return this.threads.get(threadId) }

  async activate(bridge: BrowserBridge | undefined, threadId: string): Promise<void> {
    if (!this.threads.has(threadId)) this.setThread({ threadId, workspace: null, status: 'loading', error: null, pages: [], activePageId: null, busy: false, notice: null, placementProblem: null, grant: null })
    if (!bridge) { this.patch(threadId, { status: 'error', error: unavailable }); return }
    this.listen(bridge)
    const token = (this.listTokens.get(threadId) ?? 0) + 1
    this.listTokens.set(threadId, token)
    const result = await settle(bridge.list({ threadId }))
    if (this.listTokens.get(threadId) !== token) return
    const latest = this.threads.get(threadId)!
    if (!result.ok) { this.patch(threadId, { status: 'error', error: result.error }); return }
    const { workspace, pages } = result.value
    const listed = browserPages(pages)
    const active = listed.some(page => page.id === latest.activePageId) ? latest.activePageId : listed.at(-1)?.id ?? null
    this.setThread({ ...latest, workspace, status: 'ready', error: null, pages, activePageId: active, grant: result.value.grant ?? null })
  }

  /** The thread's target for main, listing it first when this window has not yet. */
  async target(bridge: BrowserBridge | undefined, threadId: string): Promise<{ threadId: string; workspaceId: string } | null> {
    if (!this.threads.get(threadId)?.workspace) await this.activate(bridge, threadId)
    const workspace = this.threads.get(threadId)?.workspace
    return workspace ? { threadId, workspaceId: workspace.workspaceId } : null
  }

  select(threadId: string, pageId: string): void {
    if (this.threads.get(threadId)?.pages.some(page => page.id === pageId && !page.device)) this.patch(threadId, { activePageId: pageId, notice: null })
  }

  /**
   * A page main opened for this thread elsewhere (a link in its transcript) becomes the active page. The test
   * iPhone is taken in but never becomes Tools > Browser's active page, which it is not one of.
   */
  adopt(page: BrowserPage): void {
    const threadId = page.workspace.threadId
    const thread = this.threads.get(threadId)
    const active = page.device ? undefined : page.id
    if (!thread) {
      this.setThread({ threadId, workspace: page.workspace, status: 'ready', error: null, pages: [page], activePageId: active ?? null, busy: false, notice: null, placementProblem: null, grant: null })
      return
    }
    this.upsert(page)
    this.patch(threadId, { ...(active ? { activePageId: active } : {}), workspace: thread.workspace ?? page.workspace })
  }

  /** Opens a page, or with `device` the thread's test iPhone, which never becomes Tools > Browser's active page. */
  async create(bridge: BrowserBridge | undefined, threadId: string, url: string, device?: 'iphone'): Promise<boolean> {
    const target = await this.target(bridge, threadId)
    if (!bridge || !target) return false
    this.patch(threadId, { busy: true, notice: null })
    const result = await settle(bridge.create({ ...target, url, ...(device ? { device } : {}) }))
    if (!result.ok) { this.fail(bridge, threadId, result.error, device ? 'Could not open the test iPhone.' : 'Could not open the page.'); return false }
    this.upsert(result.value)
    this.patch(threadId, device ? { busy: false } : { busy: false, activePageId: result.value.id })
    return true
  }

  async navigate(bridge: BrowserBridge | undefined, threadId: string, pageId: string, url: string): Promise<boolean> {
    return this.pageAction(bridge, threadId, pageId, target => bridge!.navigate({ ...target, pageId, url }), 'Could not open that address.')
  }

  async history(bridge: BrowserBridge | undefined, threadId: string, pageId: string, action: 'back' | 'forward' | 'reload'): Promise<boolean> {
    return this.pageAction(bridge, threadId, pageId, target => bridge![action]({ ...target, pageId }), action === 'reload' ? 'Could not reload the page.' : 'Could not go there.')
  }

  async close(bridge: BrowserBridge | undefined, threadId: string, pageId: string): Promise<void> {
    const workspace = this.threads.get(threadId)?.workspace
    if (!bridge || !workspace) return
    this.forgetPlacement(pageId)
    this.patch(threadId, { busy: true, notice: null })
    const result = await settle(bridge.close({ threadId, workspaceId: workspace.workspaceId, pageId }))
    if (!result.ok && result.error.code !== 'page-unavailable') { this.fail(bridge, threadId, result.error, 'Could not close the page.'); return }
    this.remove(threadId, pageId)
    this.patch(threadId, { busy: false })
  }

  /**
   * Places the page's native view at `bounds`, or takes it off the window with null. Unchanged bounds send
   * nothing, and hiding a page only ever hides that page, so a stale hide cannot remove a newer one. A page main
   * refused is not asked again until `retryPlacement`, and only the latest request's answer counts.
   */
  mount(bridge: BrowserBridge | undefined, threadId: string, pageId: string, bounds: BrowserBounds | null): void {
    const thread = this.threads.get(threadId)
    const workspace = thread?.workspace
    if (!bridge || !workspace) return
    // Main keeps one page in each slot, so a phone and a page in Tools show at once and never replace each other.
    const slot: MountSlot = thread.pages.find(page => page.id === pageId)?.device ? 'phone' : 'pane'
    const target = { threadId, workspaceId: workspace.workspaceId, pageId }
    const current = this.mounted.get(slot)
    if (bounds === null) {
      if (current?.pageId !== pageId) return
      this.mounted.delete(slot)
      void settle(bridge.mount({ ...target, bounds }))
      return
    }
    if (current?.pageId === pageId && sameBounds(current.bounds, bounds)) return
    if (thread.placementProblem?.pageId === pageId) return
    // Invalidate a pending mount of the previous page before a queued page becomes the desired one.
    if (current !== undefined && current.pageId !== pageId) {
      void settle(current.bridge.mount({ threadId: current.threadId, workspaceId: current.workspaceId, pageId: current.pageId, bounds: null }))
    }
    const request = ++this.placements
    this.mounted.set(slot, { bridge, ...target, bounds, request })
    // A moving panel can report a new rectangle every frame, faster than main validates its folder.
    // Keep only the newest rectangle while that validation is pending; hides still go through immediately.
    const place = (): void => {
      if (this.mounted.get(slot)?.request !== request) return
      this.placementPending.add(slot)
      void settle(bridge.mount({ ...target, bounds })).then(result => {
        if (result.ok || this.mounted.get(slot)?.request !== request) return
        // Main may still draw the page where an earlier request put it, over the explanation.
        this.mounted.delete(slot)
        void settle(bridge.mount({ ...target, bounds: null }))
        this.patch(threadId, { placementProblem: { pageId, message: placementReason(result.error) } })
        if (result.error.code === 'workspace-changed' || result.error.code === 'page-unavailable') void this.activate(bridge, threadId)
      }).finally(() => {
        this.placementPending.delete(slot)
        const queued = this.queuedPlacement.get(slot)
        this.queuedPlacement.delete(slot)
        queued?.()
      })
    }
    if (this.placementPending.has(slot)) this.queuedPlacement.set(slot, place)
    else place()
  }
  /** A closed page holds no slot. */
  private forgetPlacement(pageId: string): void {
    for (const [slot, placement] of this.mounted) if (placement.pageId === pageId) this.mounted.delete(slot)
  }

  /** Lets a refused page ask main again; the surface sends its rectangle on the next frame. */
  retryPlacement(threadId: string, pageId: string): void {
    if (this.threads.get(threadId)?.placementProblem?.pageId === pageId) this.patch(threadId, { placementProblem: null })
  }

  private async pageAction(bridge: BrowserBridge | undefined, threadId: string, pageId: string, run: (target: { threadId: string; workspaceId: string }) => Promise<ToolsResult<BrowserPage>>, words: string): Promise<boolean> {
    const workspace = this.threads.get(threadId)?.workspace
    if (!bridge || !workspace) return false
    this.patch(threadId, { busy: true, notice: null })
    const result = await settle(run({ threadId, workspaceId: workspace.workspaceId }))
    if (!result.ok) { this.fail(bridge, threadId, result.error, words); return false }
    this.upsert(result.value)
    this.patch(threadId, { busy: false })
    return true
  }

  private listen(bridge: BrowserBridge): void {
    if (this.subscribed === bridge) return
    this.unsubscribe?.()
    this.subscribed = bridge
    this.taskThreads.clear()
    this.unsubscribe = bridge.onEvent(event => this.receive(event))
  }

  private receive(event: BrowserEvent): void {
    if (event.type === 'task') { this.receiveTask(event.task); return }
    // A thread this window has not listed learns its grant when it is listed.
    if (event.type === 'browser-grant') { this.patch(event.threadId, { grant: event.grant }); return }
    if (event.type === 'page') {
      const thread = this.threads.get(event.page.workspace.threadId)
      if (!thread || (thread.workspace !== null && thread.workspace.workspaceId !== event.page.workspace.workspaceId)) return
      this.upsert(event.page)
      return
    }
    const thread = this.threads.get(event.threadId)
    if (thread?.pages.some(page => page.id === event.pageId)) {
      this.forgetPlacement(event.pageId)
      this.remove(event.threadId, event.pageId)
    }
  }

  private upsert(page: BrowserPage): void {
    const thread = this.threads.get(page.workspace.threadId)
    if (!thread) return
    const index = thread.pages.findIndex(item => item.id === page.id)
    const pages = index < 0 ? [...thread.pages, page] : thread.pages.map(item => item.id === page.id ? page : item)
    this.setThread({ ...thread, pages })
  }

  private remove(threadId: string, pageId: string): void {
    const thread = this.threads.get(threadId)
    if (!thread) return
    const listed = browserPages(thread.pages)
    const index = listed.findIndex(page => page.id === pageId)
    const pages = thread.pages.filter(page => page.id !== pageId)
    const remaining = browserPages(pages)
    const active = thread.activePageId === pageId ? remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.id ?? null : thread.activePageId
    const placementProblem = thread.placementProblem?.pageId === pageId ? null : thread.placementProblem
    this.setThread({ ...thread, pages, activePageId: active, placementProblem })
  }

  private fail(bridge: BrowserBridge, threadId: string, error: ToolsError, words: string): void {
    const reason = error.code === 'busy' ? 'The browser is busy. Try again in a moment.' : `${words} ${error.message}`.trim()
    this.patch(threadId, { busy: false, notice: reason })
    if (error.code === 'workspace-changed' || error.code === 'page-unavailable') void this.activate(bridge, threadId)
  }

  private patch(threadId: string, patch: Partial<ThreadBrowser>): void {
    const thread = this.threads.get(threadId)
    if (thread) this.setThread({ ...thread, ...patch })
  }

  private setThread(next: ThreadBrowser): void {
    this.threads.set(next.threadId, next)
    this.emit()
  }
}

/** Why main would not show a page, in the browser's words; main's folder messages are written for Files. */
function placementReason(error: ToolsError): string {
  switch (error.code) {
    case 'workspace-unavailable': return 'The working folder is not available.'
    case 'workspace-changed': return 'The working folder changed.'
    case 'busy': return 'The browser is busy.'
    default: return error.message
  }
}

async function settle<T>(request: Promise<ToolsResult<T>>): Promise<ToolsResult<T>> {
  try { return await request } catch { return { ok: false, error: { code: 'unavailable', message: 'Sotto did not answer.' } } }
}

export function useThreadBrowser(store: BrowserStore, threadId: string | null): ThreadBrowser | undefined {
  const read = useCallback(() => threadId === null ? undefined : store.thread(threadId), [store, threadId])
  return useSyncExternalStore(store.subscribe, read)
}

export function useBrowserTasks(store: BrowserStore): readonly BrowserTask[] {
  return useSyncExternalStore(store.subscribe, store.taskSnapshot)
}
