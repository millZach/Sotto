import { randomUUID } from 'node:crypto'
import { WebContentsView, session, type BrowserWindow, type Session } from 'electron'
import { browserCreateSchema, browserRequestSchema, browserNavigateSchema, browserMountSchema, browserOpenLinkSchema, safeBrowserUrl, type BrowserPage, type BrowserEvent, type BrowserBounds } from '../../shared/browser'
import { toolListRequestSchema } from '../../shared/tools'
import type { FilesService } from '../files/service'
import { ToolOperations, fail, parse, workspace } from './common'

interface PageRecord { page: BrowserPage; view: WebContentsView; generation: number }
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
    return { workspace: owner, pages: [...this.pages.values()].filter(record => record.page.workspace.workspaceId === owner.workspaceId).map(record => ({ ...record.page })) }
  }) }
  create(payload: unknown) { return this.run(async () => this.createPage(parse(browserCreateSchema, payload))) }
  private async createPage(request: ReturnType<typeof browserCreateSchema.parse>): Promise<BrowserPage> {
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
    const record: PageRecord = { view, generation: 0, page: { id: randomUUID(), workspace: owner, url: request.url, title: '', status: 'loading', error: null, canGoBack: false, canGoForward: false } }
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
      record.page.url = safeBrowserUrl(url)!
      record.page.status = 'loading'; record.page.error = null
      this.publish(record)
    })
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
      if (!mainFrame || !safeBrowserUrl(url)) return
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
    this.load(record, request.url)
    return this.publish(record)
  }
  private load(record: PageRecord, url: string): void {
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
    this.load(record, request.url)
    return this.publish(record)
  }) }
  private history(payload: unknown, action: 'back' | 'forward' | 'reload') { return this.run(async () => {
    const record = await this.owned(parse(browserRequestSchema, payload))
    const history = record.view.webContents.navigationHistory
    if (action === 'reload') this.load(record, record.page.url)
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
    if (request.bounds === null) { if (this.mounted?.record === record) this.detach(); return }
    if (version !== this.mountVersion) return
    const window = this.dependencies.getWindow()
    if (!window || window.isDestroyed()) return fail('unavailable', 'The main window is unavailable.')
    this.detach()
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
    const mounted = this.mounted; this.mounted = null
    if (!mounted) return
    mounted.cleanup()
    if (!mounted.window.isDestroyed()) mounted.window.contentView.removeChildView(mounted.record.view)
  }
  close(payload: unknown) { return this.run(async () => {
    const request = parse(browserRequestSchema, payload)
    const record = await this.owned(request, false)
    await this.destroy(record)
    this.dependencies.emit({ type: 'closed', ...request })
  }) }
  private destroy(record: PageRecord): Promise<void> {
    if (this.mounted?.record === record) this.detach()
    this.pages.delete(record.page.id); record.generation++
    const contents = record.view.webContents
    if (contents.isDestroyed()) return Promise.resolve()
    return new Promise(resolve => {
      contents.once('destroyed', () => resolve())
      contents.close({ waitForBeforeUnload: false })
    })
  }
  dispose(): void {
    this.disposed = true
    this.detach()
    for (const record of this.pages.values()) void this.destroy(record)
    for (const isolated of this.sessions.values()) {
      isolated.removeAllListeners('will-download')
      void isolated.closeAllConnections().catch(() => undefined)
    }
    this.sessions.clear()
  }
}
