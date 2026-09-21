import { randomUUID } from 'node:crypto'
import { BaseWindow, screen, WebContentsView, nativeImage, session, type BrowserWindow, type Session } from 'electron'
import { browserCreateSchema, browserRequestSchema, browserNavigateSchema, browserMountSchema, browserOpenLinkSchema, safeBrowserUrl, type BrowserPage, type BrowserEvent, type BrowserBounds, browserShareSchema, browserViewportSchema, browserCaptureSchema, browserStartTaskSchema, browserAgentOpenSchema, browserAgentActionSchema, browserControlTaskSchema, browserAnswerActionSchema, browserFinishTaskSchema, browserTaskRequestSchema, type BrowserTask, type BrowserAction, type BrowserAgentResult, type BrowserCapture } from '../../shared/browser'
import { toolListRequestSchema } from '../../shared/tools'
import type { FilesService } from '../files/service'
import { BrowserAutomation } from './browserAutomation'
import { ToolOperations, fail, parse, workspace } from './common'

interface CaptureLease { count: number; window: BaseWindow; bounds: BrowserBounds; throttling: boolean; temporary: boolean }
interface PageRecord { page: BrowserPage; view: WebContentsView; generation: number; automation: BrowserAutomation; initial: boolean; selection: { id: string; generation: number; capture: BrowserCapture; expiresAt: number } | null }
export interface BrowserDependencies {
  files: FilesService
  getWindow(): BrowserWindow | null
  emit(event: BrowserEvent): void
  destination(): Promise<'external' | 'embedded'>
  openExternal(url: string): Promise<void>
}

/** Untrusted browsing is wholly separate from the application renderer and its session. */
export class BrowserService extends ToolOperations {
  private readonly pages = new Map<string, PageRecord>()
  private readonly sessions = new Map<string, Session>()
  private readonly namespace = randomUUID()
  private readonly taskRecords = new Map<string, BrowserTask>()
  private readonly pending = new Map<string, { generation: number; url: string; initial: boolean; target?: string }>()
  private readonly executing = new Set<string>()
  private readonly taskListeners = new Set<() => void>()
  private readonly captureLeases = new Map<PageRecord, CaptureLease>()
  private mounted: { record: PageRecord; window: BrowserWindow; cleanup(): void } | null = null
  private mountVersion = 0
  private desiredPageId: string | null = null
  constructor(private readonly dependencies: BrowserDependencies) { super() }
  private publish(record: PageRecord): BrowserPage {
    if (!record.view.webContents.isDestroyed()) {
      const contents = record.view.webContents
      const url = safeBrowserUrl(contents.getURL())
      if (url && record.page.status !== 'loading' && record.page.status !== 'unavailable') record.page.url = url
      record.page.canGoBack = contents.navigationHistory.canGoBack()
      record.page.canGoForward = contents.navigationHistory.canGoForward()
    }
    const page = { ...record.page }
    if (!this.disposed && this.pages.has(record.page.id)) this.dependencies.emit({ type: 'page', page })
    return page
  }
  private issue(record: PageRecord, message: string, unavailable = false): void {
    if (!this.pages.has(record.page.id) || this.disposed) return
    if (unavailable) record.page.status = 'unavailable'
    record.page.error = message
    this.publish(record)
  }
  private browserSession(workspaceId: string): Session {
    const existing = this.sessions.get(workspaceId)
    if (existing) return existing
    const isolated = session.fromPartition(`sotto-browser-${this.namespace}-${workspaceId}`)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.setDevicePermissionHandler(() => false)
    isolated.on('will-download', (event, _item, contents) => {
      event.preventDefault()
      const record = [...this.pages.values()].find(record => record.view.webContents === contents)
      if (record) this.issue(record, 'Downloads are blocked here. Open this page externally to download.')
    })
    // No file://, Sotto custom protocols, application assets or OS protocol handlers.
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false
      try { allowed = ['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:'].includes(new URL(details.url).protocol) } catch { /* Reject malformed URLs. */ }
      callback({ cancel: !allowed })
    })
    this.sessions.set(workspaceId, isolated)
    return isolated
  }
  list(payload: unknown) { return this.run(async () => {
    const request = parse(toolListRequestSchema, payload)
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    return { workspace: owner, pages: [...this.pages.values()].filter(record => record.page.workspace.workspaceId === owner.workspaceId && record.page.workspace.threadId === owner.threadId).map(record => ({ ...record.page })) }
  }) }
  create(payload: unknown) { return this.run(async () => this.createPage(parse(browserCreateSchema, payload))) }
  private async createPage(request: ReturnType<typeof browserCreateSchema.parse>, initial = false): Promise<BrowserPage> {
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    if (this.disposed) return fail('unavailable', 'Browser is shutting down.')
    if (this.pages.size >= 32) return fail('busy', 'Close a browser page before opening another (32 maximum).')
    const view = new WebContentsView({ webPreferences: {
      session: this.browserSession(owner.workspaceId), contextIsolation: true, sandbox: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
      navigateOnDragDrop: false, safeDialogs: true, backgroundThrottling: true,
      // Deliberately no preload and no Sotto renderer-role arguments.
    } })
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
    const record: PageRecord = { view, generation: 0, automation: new BrowserAutomation(view.webContents, () => this.prepareCapture(record)), initial, selection: null, page: { id: randomUUID(), workspace: owner, url: request.url, title: '', status: 'loading', error: null, canGoBack: false, canGoForward: false, sharedOrigin: null, viewport: null } }
    this.pages.set(record.page.id, record)
    const contents = view.webContents
    const blocked = (event: { preventDefault(): void }, url: string): void => {
      if (safeBrowserUrl(url)) return
      event.preventDefault()
      this.issue(record, 'This navigation is blocked. Only HTTP and HTTPS pages can open here.')
    }
    contents.on('will-navigate', (event, url) => blocked(event, url))
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame && event.url === 'about:blank') return
      blocked(event, event.url)
    })
    contents.on('will-redirect', (event, url) => blocked(event, url))
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.setWindowOpenHandler(() => {
      this.issue(record, 'A new-window request was blocked. Use a link destination action or open this page externally.')
      return { action: 'deny' }
    })
    contents.on('did-start-navigation', (_event, url, _inPlace, mainFrame) => {
      if (!mainFrame || !safeBrowserUrl(url)) return
      this.invalidate(record)
      record.generation++
      record.automation.clear()
      if (record.page.sharedOrigin && record.page.sharedOrigin !== new URL(url).origin) this.revoke(record)
      record.page.url = safeBrowserUrl(url)!
      record.page.status = 'loading'; record.page.error = null
      this.publish(record)
    })
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
      if (!mainFrame || !safeBrowserUrl(url)) return
      this.invalidate(record)
      record.generation++
      if (record.page.sharedOrigin && record.page.sharedOrigin !== new URL(url).origin) this.revoke(record)
      record.page.url = safeBrowserUrl(url)!; record.page.status = 'ready'
      this.publish(record)
    })
    contents.on('did-finish-load', () => {
      // Chromium can finish its internal error document after did-fail-load.
      // That is not successful navigation to the requested application.
      if (record.page.status === 'unavailable' || safeBrowserUrl(contents.getURL()) !== record.page.url) return
      record.page.status = 'ready'; record.page.error = null
      this.publish(record)
    })
    contents.on('page-title-updated', (_event, title) => {
      // Strip controls/bidi marks; URL always remains separately visible in app chrome.
      // eslint-disable-next-line no-control-regex -- Untrusted title display sanitization.
      record.page.title = title.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 512)
      this.publish(record)
    })
    contents.on('did-fail-load', (_event, code, _description, url, mainFrame) => {
      if (!mainFrame || code === -3 || (safeBrowserUrl(url) && url !== record.page.url)) return
      this.issue(record, 'This page is unavailable. Check the address or start its local server, then reload.', true)
    })
    contents.on('render-process-gone', () => this.issue(record, 'This page stopped unexpectedly. Reload to reopen it.', true))
    if (!initial) this.load(record, request.url)
    else record.page.error = 'Waiting for you to open and share this page.'
    return this.publish(record)
  }
  private load(record: PageRecord, url: string): void {
    this.invalidate(record)
    record.automation.clear()
    if (record.page.sharedOrigin && record.page.sharedOrigin !== new URL(url).origin) this.revoke(record)
    record.page.url = url; record.page.status = 'loading'; record.page.error = null
    const generation = ++record.generation
    void record.view.webContents.loadURL(url).catch((error: unknown) => {
      if (record.generation === generation && (error as { code?: string }).code !== 'ERR_ABORTED') this.issue(record, 'This page is unavailable. Check the address or start its local server, then reload.', true)
    })
  }
  private async owned(request: ReturnType<typeof browserRequestSchema.parse>, validateDirectory = true): Promise<PageRecord> {
    const record = this.pages.get(request.pageId)
    if (!record || record.page.workspace.threadId !== request.threadId || record.page.workspace.workspaceId !== request.workspaceId) return fail('page-unavailable', 'This page belongs to another workspace or was closed.')
    if (validateDirectory) await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    if (this.disposed || !this.pages.has(request.pageId) || record.view.webContents.isDestroyed()) return fail('page-unavailable', 'This browser page has closed.')
    return record
  }
  navigate(payload: unknown) { return this.run(async () => {
    const request = parse(browserNavigateSchema, payload)
    const record = await this.owned(request)
    record.initial = false
    this.load(record, request.url)
    return this.publish(record)
  }) }
  private history(payload: unknown, action: 'back' | 'forward' | 'reload') { return this.run(async () => {
    const record = await this.owned(parse(browserRequestSchema, payload))
    const history = record.view.webContents.navigationHistory
    if (action === 'reload') { record.initial = false; this.load(record, record.page.url) }
    else if (action === 'back' && history.canGoBack()) history.goBack()
    else if (action === 'forward' && history.canGoForward()) history.goForward()
    return this.publish(record)
  }) }
  back(payload: unknown) { return this.history(payload, 'back') }
  forward(payload: unknown) { return this.history(payload, 'forward') }
  reload(payload: unknown) { return this.history(payload, 'reload') }
  openLink(payload: unknown) { return this.run(async () => {
    const request = parse(browserOpenLinkSchema, payload)
    const destination = request.destination ?? await this.dependencies.destination()
    if (destination === 'external') {
      await this.dependencies.openExternal(request.url)
      return { destination }
    }
    if (!request.target) return fail('workspace-unavailable', 'Select a thread before opening an embedded page.')
    return { destination, page: await this.createPage({ ...request.target, url: request.url }) }
  }) }
  mount(payload: unknown) { return this.run(async () => {
    const request = parse(browserMountSchema, payload)
    // Binding validation does disk IO. Last requested page wins even if earlier IO finishes later.
    const version = request.bounds !== null ? ++this.mountVersion : this.mountVersion
    if (request.bounds !== null) this.desiredPageId = request.pageId
    else if (this.desiredPageId === request.pageId) { this.desiredPageId = null; this.mountVersion++ }
    const record = await this.owned(request, request.bounds !== null)
    if (request.bounds === null) { if (this.mounted?.record === record) this.removeMountedView(); return }
    if (version !== this.mountVersion) return
    const window = this.dependencies.getWindow()
    if (!window || window.isDestroyed()) return fail('unavailable', 'The main window is unavailable.')
    this.removeMountedView()
    this.desiredPageId = request.pageId
    this.setBounds(record, window, request.bounds)
    const detach = (): void => this.detach()
    // Detach on host reload/crash so native content cannot obscure a recovered app screen.
    window.webContents.on('did-start-loading', detach)
    window.webContents.on('render-process-gone', detach)
    window.webContents.on('destroyed', detach)
    window.on('closed', detach)
    window.on('resize', detach)
    this.mounted = { record, window, cleanup: () => {
      window.webContents.removeListener('did-start-loading', detach)
      window.webContents.removeListener('render-process-gone', detach)
      window.webContents.removeListener('destroyed', detach)
      window.removeListener('closed', detach)
      window.removeListener('resize', detach)
    } }
    window.contentView.addChildView(record.view)
  }) }
  private setBounds(record: PageRecord, window: BrowserWindow, bounds: BrowserBounds): void {
    const zoom = window.webContents.getZoomFactor()
    const [width = 0, height = 0] = window.getContentSize()
    const x = Math.min(width, Math.round(bounds.x * zoom)), y = Math.min(height, Math.round(bounds.y * zoom))
    record.view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width * zoom))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height * zoom))) })
  }
  detach(): void {
    this.mountVersion++
    this.desiredPageId = null
    this.removeMountedView()
  }
  private removeMountedView(): void {
    const mounted = this.mounted; this.mounted = null
    if (!mounted) return
    mounted.cleanup()
    if (!mounted.window.isDestroyed()) {
      mounted.window.contentView.removeChildView(mounted.record.view)
      const lease = this.captureLeases.get(mounted.record)
      if (lease) this.parkCapture(mounted.record, lease)
    }
  }
  private parkCapture(record: PageRecord, lease: CaptureLease): void {
    if (lease.temporary) {
      if (lease.window.isDestroyed()) return fail('page-unavailable', 'The capture window closed.')
      lease.window.contentView.addChildView(record.view)
      record.view.setBounds({ x: 0, y: 0, width: lease.bounds.width, height: lease.bounds.height })
      return
    }
    const displays = screen.getAllDisplays()
    const x = Math.max(0, ...displays.map(display => display.bounds.x + display.bounds.width)) + 100
    const y = Math.max(0, ...displays.map(display => display.bounds.y + display.bounds.height)) + 100
    const window = new BaseWindow({ x, y, width: Math.max(1, lease.bounds.width), height: Math.max(1, lease.bounds.height), show: false, frame: false, focusable: false, skipTaskbar: true, resizable: false })
    lease.window = window; lease.temporary = true
    window.contentView.addChildView(record.view)
    record.view.setBounds({ x: 0, y: 0, width: lease.bounds.width, height: lease.bounds.height })
    window.showInactive()
  }
  private prepareCapture(record: PageRecord): () => void {
    if (this.disposed || record.view.webContents.isDestroyed()) return fail('page-unavailable', 'This browser page closed.')
    const existing = this.captureLeases.get(record)
    if (existing) existing.count++
    else {
      const window = this.dependencies.getWindow()
      // Headless service consumers have no native surface to lend. CDP remains
      // usable in their own environment; desktop captures always have a window.
      if (!window || window.isDestroyed()) return () => undefined
      const contents = record.view.webContents
      const lease: CaptureLease = { count: 1, window, bounds: record.view.getBounds(), throttling: contents.getBackgroundThrottling(), temporary: false }
      this.captureLeases.set(record, lease)
      contents.setBackgroundThrottling(false)
      if (this.mounted?.record !== record) {
        this.parkCapture(record, lease)
      }
    }
    const lease = this.captureLeases.get(record)!
    let released = false
    return () => {
      if (released || this.captureLeases.get(record) !== lease) return
      released = true
      if (--lease.count > 0) return
      this.captureLeases.delete(record)
      if (!record.view.webContents.isDestroyed()) {
        record.view.webContents.setBackgroundThrottling(lease.throttling)
        if (this.mounted?.record !== record) {
          if (!lease.window.isDestroyed()) lease.window.contentView.removeChildView(record.view)
          record.view.setBounds(lease.bounds)
        }
      }
      if (lease.temporary && !lease.window.isDestroyed()) lease.window.destroy()
    }
  }
  close(payload: unknown) { return this.run(async () => {
    const request = parse(browserRequestSchema, payload)
    const record = await this.owned(request, false)
    await this.destroy(record)
    this.dependencies.emit({ type: 'closed', ...request })
  }) }
  private destroy(record: PageRecord): Promise<void> {
    if (this.desiredPageId === record.page.id) { this.desiredPageId = null; this.mountVersion++ }
    if (this.mounted?.record === record) this.removeMountedView()
    for (const task of this.taskRecords.values()) if (task.pageId === record.page.id && ['working', 'paused'].includes(task.status)) {
      task.status = 'failed'; task.summary = 'This browser page closed.'; task.output = null; task.thumbnail = null; task.evidence = []; this.publishTask(task)
    }
    this.invalidate(record)
    record.automation.dispose()
    const lease = this.captureLeases.get(record)
    this.captureLeases.delete(record)
    if (lease && !lease.window.isDestroyed()) { lease.window.contentView.removeChildView(record.view); if (lease.temporary) lease.window.destroy() }
    this.pages.delete(record.page.id); record.generation++
    const contents = record.view.webContents
    if (contents.isDestroyed()) return Promise.resolve()
    return new Promise(resolve => {
      contents.once('destroyed', () => resolve())
      contents.close({ waitForBeforeUnload: false })
    })
  }
  private publishTask(task: BrowserTask): BrowserTask {
    task.updatedAt = Date.now()
    const result = structuredClone(task)
    if (!this.disposed) this.dependencies.emit({ type: 'task', task: result })
    for (const listener of this.taskListeners) listener()
    return result
  }
  private revoke(record: PageRecord): void {
    record.page.sharedOrigin = null
    this.invalidate(record)
    record.automation.dispose()
    for (const task of this.taskRecords.values()) if (task.pageId === record.page.id) {
      task.output = null; task.thumbnail = null; task.evidence = []; this.publishTask(task)
    }
  }
  private invalidate(record: PageRecord): void {
    for (const task of this.taskRecords.values()) if (task.pageId === record.page.id && task.pendingAction) {
      task.pendingAction = null; this.pending.delete(task.id)
      task.output = 'The page changed. Request the action again.'
      this.publishTask(task)
    }
  }
  private task(request: ReturnType<typeof browserTaskRequestSchema.parse>): BrowserTask {
    const task = this.taskRecords.get(request.taskId)
    if (!task || task.threadId !== request.threadId || task.workspaceId !== request.workspaceId || task.pageId !== request.pageId) return fail('blocked', 'This browser task belongs to another thread or page.')
    return task
  }
  private working(task: BrowserTask): void {
    if (task.status !== 'working') fail('blocked', task.status === 'paused' ? 'Browser actions are paused. The user can resume them.' : 'This browser task has finished.')
  }
  private shared(record: PageRecord): void {
    const actual = safeBrowserUrl(record.view.webContents.getURL())
    if (!actual || !record.page.sharedOrigin || record.page.sharedOrigin !== new URL(record.page.url).origin || record.page.sharedOrigin !== new URL(actual).origin) fail('blocked', 'Ask the user to share this browser page before inspecting or interacting with it.')
  }
  private begin(record: PageRecord, description: string): BrowserTask {
    if ([...this.taskRecords.values()].some(task => task.pageId === record.page.id && ['working', 'paused'].includes(task.status))) return fail('busy', 'Finish this page\'s current browser task first.')
    if (this.taskRecords.size >= 64) {
      const oldest = [...this.taskRecords.values()].find(task => ['completed', 'failed'].includes(task.status))
      if (!oldest) return fail('busy', 'Finish a browser task before starting another.')
      this.taskRecords.delete(oldest.id)
    }
    const task: BrowserTask = { id: randomUUID(), threadId: record.page.workspace.threadId, workspaceId: record.page.workspace.workspaceId, pageId: record.page.id, status: 'working', description, updatedAt: Date.now(), steps: [], thumbnail: null, summary: null, unchecked: [], pendingAction: null, output: null, evidence: [] }
    this.taskRecords.set(task.id, task)
    return this.publishTask(task)
  }
  tasks(payload: unknown) { return this.run(async () => {
    const request = parse(toolListRequestSchema, payload)
    const owner = await workspace(this.dependencies.files, request.threadId, request.workspaceId)
    const tasks = [...this.taskRecords.values()].filter(task => task.threadId === owner.threadId && task.workspaceId === owner.workspaceId)
    for (const task of tasks) if (task.pendingAction && task.pendingAction.expiresAt < Date.now()) {
      task.pendingAction = null; this.pending.delete(task.id); task.output = 'This browser action expired. Request it again.'; this.publishTask(task)
    }
    return structuredClone(tasks)
  }) }
  share(payload: unknown) { return this.run(async () => {
    const request = parse(browserShareSchema, payload)
    const record = await this.owned(request)
    if (request.enabled && record.initial) return fail('blocked', 'Answer the request to open this page first.')
    record.page.sharedOrigin = request.enabled ? new URL(record.page.url).origin : null
    if (request.enabled) record.automation.observe()
    if (!request.enabled) {
      record.automation.dispose()
      for (const task of this.taskRecords.values()) if (task.pageId === record.page.id) {
        if (task.status === 'working') task.status = 'paused'
        task.output = null; task.thumbnail = null; task.evidence = []; this.publishTask(task)
      }
      this.invalidate(record)
    }
    return this.publish(record)
  }) }
  viewport(payload: unknown) { return this.run(async () => {
    const request = parse(browserViewportSchema, payload)
    const record = await this.owned(request)
    if ('reset' in request) {
      await record.automation.resetViewport()
      record.page.viewport = null
      record.generation++
      this.invalidate(record)
      return this.publish(record)
    }
    await record.automation.input({ type: 'viewport', width: request.width, height: request.height }, () => {
      if (record.view.webContents.isDestroyed()) fail('page-unavailable', 'This page closed.')
    })
    record.page.viewport = { width: request.width, height: request.height }
    record.generation++
    this.invalidate(record)
    return this.publish(record)
  }) }
  capture(payload: unknown) { return this.run(async () => {
    const request = parse(browserCaptureSchema, payload)
    const record = await this.owned(request)
    const generation = record.generation
    if (request.point || request.region) {
      const selection = record.selection
      if (!request.captureId || !selection || selection.id !== request.captureId || selection.expiresAt < Date.now()) return fail('blocked', 'Capture the page again before selecting feedback.')
      const original = selection.capture
      const image = nativeImage.createFromDataURL(original.image)
      if (request.region) {
        const region = { x: Math.round(request.region.x), y: Math.round(request.region.y), width: Math.round(request.region.width), height: Math.round(request.region.height) }
        if (region.width < 1 || region.height < 1 || region.x + region.width > original.width || region.y + region.height > original.height) return fail('blocked', 'Select a region inside the captured page.')
        // Feedback annotates the immutable image the user selected, even if the live page animates.
        return { ...original, captureId: selection.id, image: image.crop(region).toDataURL(), width: region.width, height: region.height, element: null }
      }
      if (selection.generation !== generation) return fail('blocked', 'The page changed. Use Region to comment on the saved screenshot, or capture it again.')
      const selected = await record.automation.elementAt(request.point!)
      if (!selected) return fail('blocked', 'No element is available there. Use Region to comment on the saved screenshot.')
      const x = Math.max(0, Math.floor(selected.bounds.x)), y = Math.max(0, Math.floor(selected.bounds.y))
      const region = { x, y, width: Math.min(original.width, Math.ceil(selected.bounds.x + selected.bounds.width)) - x, height: Math.min(original.height, Math.ceil(selected.bounds.y + selected.bounds.height)) - y }
      if (region.width <= 0 || region.height <= 0) return fail('blocked', 'That element is outside the captured page.')
      const after = await record.automation.elementAt(request.point!)
      if (record.generation !== generation || JSON.stringify(after) !== JSON.stringify(selected)) return fail('blocked', 'That element changed. Use Region to comment on the saved screenshot, or capture it again.')
      return { ...original, captureId: selection.id, element: selected.element }
    }
    const full = await record.automation.capture(record.page.url)
    if (record.generation !== generation) return fail('blocked', 'The page changed. Capture it again.')
    record.selection = { id: randomUUID(), generation, capture: full, expiresAt: Date.now() + 5 * 60_000 }
    return { ...full, captureId: record.selection.id }
  }) }
  startTask(payload: unknown) { return this.run(async () => {
    const request = parse(browserStartTaskSchema, payload)
    const record = await this.owned(request)
    this.shared(record)
    return this.begin(record, request.description)
  }) }
  agentOpen(payload: unknown) { return this.run(async (): Promise<BrowserAgentResult> => {
    const request = parse(browserAgentOpenSchema, payload)
    const page = await this.createPage(request, true)
    const record = this.pages.get(page.id)!
    const created = this.begin(record, request.description)
    const task = this.taskRecords.get(created.id)!
    return this.requestAction(record, task, { type: 'navigate', url: request.url })
  }) }
  private async requestAction(record: PageRecord, task: BrowserTask, action: BrowserAction): Promise<BrowserAgentResult> {
    if (task.pendingAction) return fail('busy', 'A browser action is waiting for the user. Read the task before requesting another action.')
    const generation = record.generation
    const target = action.type === 'click' || action.type === 'type' ? await record.automation.target(action) : undefined
    this.working(task)
    if (generation !== record.generation || task.pendingAction) return fail('blocked', 'The page changed. Inspect it and request the action again.')
    if (!record.initial) this.shared(record)
    const description = action.type === 'navigate' ? `${record.initial ? 'Open and share this page with the thread' : 'Navigate this page'}: ${action.url}` : action.type === 'click' ? `Click at ${action.x}, ${action.y} on ${record.page.url}` : action.type === 'type' ? `Type ${JSON.stringify(action.text)} into the focused field on ${record.page.url}` : action.type
    task.pendingAction = { id: randomUUID(), action, description, expiresAt: Date.now() + 5 * 60_000 }
    this.pending.set(task.id, { generation: record.generation, url: record.page.url, initial: record.initial, ...(target ? { target } : {}) })
    return { task: this.publishTask(task), approvalRequired: true }
  }
  action(payload: unknown) { return this.run(async (): Promise<BrowserAgentResult> => {
    const request = parse(browserAgentActionSchema, payload)
    const record = await this.owned(request)
    const task = this.task(request)
    this.working(task)
    if (request.action.type !== 'navigate' || !record.initial) this.shared(record)
    if (this.executing.has(record.page.id)) return fail('busy', 'A browser action is still running.')
    if (['navigate', 'click', 'type'].includes(request.action.type)) return this.requestAction(record, task, request.action)
    if (task.pendingAction) return fail('busy', 'Answer the pending browser action first.')
    return this.perform(record, task, request.action)
  }) }
  controlTask(payload: unknown) { return this.run(async () => {
    const request = parse(browserControlTaskSchema, payload)
    await this.owned(request)
    const task = this.task(request)
    if (!['working', 'paused'].includes(task.status)) return fail('blocked', 'This browser task has finished.')
    task.status = request.control === 'pause' ? 'paused' : 'working'
    if (request.control === 'pause') { task.pendingAction = null; this.pending.delete(task.id) }
    return this.publishTask(task)
  }) }
  answerAction(payload: unknown) { return this.run(async () => {
    const request = parse(browserAnswerActionSchema, payload)
    const record = await this.owned(request)
    const task = this.task(request), pending = task.pendingAction, scope = this.pending.get(task.id)
    this.working(task)
    if (!pending || pending.id !== request.actionId || !scope || pending.expiresAt < Date.now() || scope.generation !== record.generation || scope.url !== record.page.url) return fail('blocked', 'This browser request changed or expired. Ask the agent to try again.')
    if (this.executing.has(record.page.id)) return fail('busy', 'A browser action is still running.')
    task.pendingAction = null; this.pending.delete(task.id)
    if (!request.allow) { task.output = 'The user declined this action.'; return this.publishTask(task) }
    const result = await this.perform(record, task, pending.action, scope.initial, scope.target)
    return result.task
  }) }
  private async perform(record: PageRecord, task: BrowserTask, action: BrowserAction, initial = false, approvedTarget?: string): Promise<BrowserAgentResult> {
    if (this.executing.has(record.page.id)) return fail('busy', 'A browser action is still running.')
    this.executing.add(record.page.id)
    const generation = record.generation
    const observedUrl = action.type === 'navigate' ? action.url : record.page.url
    const guard = (checkGeneration = true): void => {
      this.working(task)
      if (checkGeneration && record.generation !== generation) fail('blocked', 'The page changed. Inspect it before trying again.')
      if (record.view.webContents.isDestroyed() || !this.pages.has(record.page.id)) fail('page-unavailable', 'This page closed.')
      if (!initial) this.shared(record)
    }
    try {
      guard()
      if ((action.type === 'click' || action.type === 'type') && (!approvedTarget || await record.automation.target(action) !== approvedTarget)) fail('blocked', 'The target changed. Inspect the page and request the action again.')
      guard()
      let output = '', image: string | undefined
      if (action.type === 'navigate') {
        record.initial = false
        // Only an explicit Open and share answer creates an observation grant.
        if (initial) record.page.sharedOrigin = new URL(action.url).origin
        this.load(record, action.url)
        if (record.page.sharedOrigin) record.automation.observe()
        output = 'Navigation started. Inspect the page after it finishes loading.'
      } else if (action.type === 'inspect') output = await record.automation.inspect()
      else if (action.type === 'screenshot') { const capture = await record.automation.capture(record.page.url); image = capture.image; output = JSON.stringify({ url: capture.url, width: capture.width, height: capture.height }) }
      else {
        await record.automation.input(action, guard)
        if (action.type === 'viewport') { record.page.viewport = { width: action.width, height: action.height }; this.publish(record) }
        output = `${action.type} completed.`
      }
      if (action.type !== 'navigate') guard(action.type === 'inspect' || action.type === 'screenshot')
      if (action.type === 'screenshot') {
        const evidence = record.automation.evidence(image!)
        guard()
        if (evidence) task.evidence = [...(task.evidence ?? []), { id: randomUUID(), at: Date.now(), url: record.page.url, viewport: record.page.viewport ?? null, ...evidence }].slice(-3)
      }
      // Revocation during an asynchronous capture must not release page evidence.
      if (action.type !== 'navigate') guard(action.type === 'inspect' || action.type === 'screenshot')
      const thumbnail = action.type === 'navigate' ? null : await record.automation.thumbnail(image).catch(() => null)
      if (action.type !== 'navigate') guard(action.type === 'inspect' || action.type === 'screenshot')
      if (record.page.sharedOrigin && task.status === 'working') task.thumbnail = thumbnail
      task.output = output
      task.steps.push({ id: randomUUID(), action: action.type, status: 'completed', at: Date.now(), detail: action.type === 'type' ? 'Entered text in the focused field.' : action.type === 'inspect' ? 'Inspected the page and recent console and network errors.' : output.slice(0, 2000), url: observedUrl, viewport: record.page.viewport ?? null })
      task.steps = task.steps.slice(-40)
      return { task: this.publishTask(task), output, ...(image ? { image } : {}), approvalRequired: false }
    } catch (error) {
      task.output = 'The browser action did not finish. Inspect the page before trying again.'
      task.steps.push({ id: randomUUID(), action: action.type, status: 'failed', at: Date.now(), detail: task.output, url: observedUrl, viewport: record.page.viewport ?? null })
      task.steps = task.steps.slice(-40); this.publishTask(task)
      throw error
    } finally { this.executing.delete(record.page.id); for (const listener of this.taskListeners) listener() }
  }
  waitForAction(taskId: string, actionId: string): Promise<BrowserTask | null> {
    return new Promise(resolve => {
      const check = (): void => {
        if (this.disposed) { this.taskListeners.delete(check); clearTimeout(timer); resolve(null); return }
        const task = this.taskRecords.get(taskId)
        if (!this.disposed && task?.pendingAction?.id === actionId && task.pendingAction.expiresAt > Date.now()) return
        const expired = task?.pendingAction?.id === actionId
        if (expired) { task.pendingAction = null; this.pending.delete(taskId); task.output = 'This browser request expired. Ask the user before requesting it again.' }
        if (task && this.executing.has(task.pageId)) return
        this.taskListeners.delete(check)
        if (timer) clearTimeout(timer)
        if (expired && task) this.publishTask(task)
        resolve(task ? structuredClone(task) : null)
      }
      this.taskListeners.add(check)
      const timer = setTimeout(check, Math.max(0, (this.taskRecords.get(taskId)?.pendingAction?.expiresAt ?? Date.now()) - Date.now()) + 1)
      check()
    })
  }
  finishTask(payload: unknown) { return this.run(async () => {
    const request = parse(browserFinishTaskSchema, payload)
    await this.owned(request)
    const task = this.task(request)
    this.working(task)
    if (this.executing.has(task.pageId) || task.pendingAction) return fail('busy', 'Finish the pending browser action first.')
    task.status = request.status; task.summary = request.summary; task.unchecked = request.unchecked
    task.pendingAction = null; this.pending.delete(task.id)
    return this.publishTask(task)
  }) }
  dispose(): void {
    this.disposed = true
    this.detach()
    for (const record of this.pages.values()) void this.destroy(record)
    for (const isolated of this.sessions.values()) {
      isolated.removeAllListeners('will-download')
      void isolated.closeAllConnections().catch(() => undefined)
    }
    this.sessions.clear()
    this.taskRecords.clear(); this.pending.clear()
    for (const listener of this.taskListeners) listener()
    this.taskListeners.clear()
  }
}
