import { t } from '@lingui/core/macro'
import { randomUUID } from 'node:crypto'
import { BaseWindow, screen, WebContentsView, nativeImage, session, type BrowserWindow, type Session } from 'electron'
import { browserMountSchema, browserOpenLinkSchema, safeBrowserUrl, type BrowserPage, type BrowserEvent, type BrowserBounds, browserViewportSchema, browserCaptureSchema, browserPointModeSchema, BROWSER_WAITING_TO_OPEN, TEST_IPHONE, type BrowserAgentResult, type BrowserCapture, type BrowserPointState } from '../../shared/browser'
import type { FileWorkspace } from '../../shared/files'
import type { FilesService } from '../files/service'
import { BrowserAutomation, type PointTarget } from './browserAutomation'
import { BrowserTasks, type BrowserCreateRequest, type BrowserTaskWords } from './browserTasks'
import { fail, parse } from './common'
import type { ThreadFilePages } from './threadFilePages'
import { blockSpellcheckDictionaryDownloads } from '../security'

interface CaptureLease { count: number; window: BaseWindow; bounds: BrowserBounds; throttling: boolean; temporary: boolean }
/**
 * `madePrivate`: the user pressed Stop sharing, so the thread's browser grant leaves the page private until the user
 * shares it again. `point`: the user turned on Point at something for this page (ADR-0154), one session per turn on. It is `live`
 * once Chromium's inspect overlay is on, which waits until the pane shows the page, and it lasts through a pick until
 * the picture is sent to the window, so hiding the page or a navigation meanwhile ends the pick with it.
 */
interface PageRecord { page: BrowserPage; view: WebContentsView; generation: number; automation: BrowserAutomation; initial: boolean; selection: { id: string; generation: number; capture: BrowserCapture; expiresAt: number } | null; zoom: number; madePrivate: boolean; point: PointSession | null }
interface PointSession { readonly session: number; readonly color: { r: number; g: number; b: number }; live: boolean; picking: boolean }
type PointEnd = Extract<BrowserPointState, { state: 'ended' }>['reason']
/** Where a page is drawn: the Tools pane or the Browser player for an ordinary page, the phone player for the test iPhone. One of each can show at once. */
type MountSlot = 'pane' | 'phone'
const slotOf = (record: PageRecord): MountSlot => record.page.device ? 'phone' : 'pane'
/** The phone's page never shows a desktop scrollbar; an iPhone draws none. */
const PHONE_CSS = 'html { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }'
const browserWords = (): BrowserTaskWords => ({
  openFirst: t`Answer the request to open this page first.`,
  finished: t`This browser task has finished.`,
  changedOrExpired: t`This browser request changed or expired. Ask the agent to try again.`,
  grantNeedsAllow: t`Only an allowed action can be granted for the whole thread. Answer this one once.`,
  stillRunning: t`A browser action is still running.`,
})
export interface BrowserDependencies {
  files: FilesService
  /** That the user or a thread opened a page or a test iPhone (ADR-0179). */
  featureUsed?(feature: 'browser' | 'test-iphone'): void
  getWindow(): BrowserWindow | null
  emit(event: BrowserEvent): void
  destination(): Promise<'external' | 'embedded'>
  openExternal(url: string): Promise<void>
  /** The live **Let agents use the browser without asking** setting (ADR-0029). */
  byDefault(): boolean
  /** Point at something is on: the `quiet-browser` Owl answer, read once at start (ADR-0072). Off, it is refused. */
  readonly pointAtSomething?: boolean
  /** Where a thread's own HTML files are served for its agent to open (ADR-0085's October 27 amendment); one is made when absent. */
  filePages?: ThreadFilePages
}

/** Untrusted browsing is wholly separate from the application renderer and its session. */
export class BrowserService extends BrowserTasks<PageRecord> {
  private readonly sessions = new Map<string, Session>()
  private readonly namespace = randomUUID()
  private readonly captureLeases = new Map<PageRecord, CaptureLease>()
  private readonly mounted = new Map<MountSlot, { record: PageRecord; window: BrowserWindow; cleanup(): void }>()
  private readonly mountVersion: Record<MountSlot, number> = { pane: 0, phone: 0 }
  private readonly desiredPageId: Record<MountSlot, string | null> = { pane: null, phone: null }
  /** Point sessions, and the newest point request per page, so an Off that overtakes an On wins. */
  private pointSessions = 0
  private readonly pointRequests = new Map<string, number>()
  constructor(private readonly dependencies: BrowserDependencies) {
    super({ files: dependencies.files, emit: event => dependencies.emit(event), byDefault: () => dependencies.byDefault(), words: browserWords,
      ...dependencies.filePages ? { filePages: dependencies.filePages } : {} })
  }
  protected publish(record: PageRecord): BrowserPage {
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
  /**
   * One session per working copy for ordinary pages. The test iPhone has a session of its own per thread: it keeps
   * its own storage, as a separate device does, and Chromium keeps page zoom per origin within a session, so the
   * phone's zoom (which fits its 393-pixel page into the player) never reaches a page in Tools.
   */
  private browserSession(workspace: FileWorkspace, phone: boolean): Session {
    const key = phone ? `phone:${workspace.threadId}:${workspace.workspaceId}` : workspace.workspaceId
    const existing = this.sessions.get(key)
    if (existing) return existing
    const isolated = session.fromPartition(phone ? `sotto-phone-${this.namespace}-${randomUUID()}` : `sotto-browser-${this.namespace}-${workspace.workspaceId}`)
    blockSpellcheckDictionaryDownloads(isolated)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.setDevicePermissionHandler(() => false)
    isolated.on('will-download', (event, _item, contents) => {
      event.preventDefault()
      const record = [...this.pages.values()].find(record => record.view.webContents === contents)
      if (record) this.issue(record, t`Downloads are blocked here. Open this page externally to download.`)
    })
    // No file://, Sotto custom protocols, application assets or OS protocol handlers.
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false
      try { allowed = ['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:'].includes(new URL(details.url).protocol) } catch { /* Reject malformed URLs. */ }
      callback({ cancel: !allowed })
    })
    this.sessions.set(key, isolated)
    return isolated
  }
  protected async createPage(request: BrowserCreateRequest, initial = false): Promise<BrowserPage> {
    const owner = await this.owner(request.threadId, request.workspaceId)
    if (this.disposed) return fail('unavailable', 'Browser is shutting down.')
    if (this.pages.size >= 32) return fail('busy', 'Close a browser page before opening another (32 maximum).')
    const phone = request.device === 'iphone'
    if (phone && this.phoneOf(owner)) return fail('busy', 'This thread already has a test iPhone. Open the address on it instead.')
    this.dependencies.featureUsed?.(phone ? 'test-iphone' : 'browser')
    const view = new WebContentsView({ webPreferences: {
      session: this.browserSession(owner, phone), contextIsolation: true, sandbox: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
      navigateOnDragDrop: false, safeDialogs: true, backgroundThrottling: true,
      // Deliberately no preload and no Sotto renderer-role arguments.
    } })
    // A phone starts at its own size, so a capture before the player ever draws it is already 393 pixels wide.
    view.setBounds(phone ? { x: 0, y: 0, width: TEST_IPHONE.width, height: TEST_IPHONE.height } : { x: 0, y: 0, width: 1280, height: 800 })
    const record: PageRecord = { view, generation: 0, automation: new BrowserAutomation(view.webContents, () => this.prepareCapture(record), phone), initial, selection: null, zoom: 1, madePrivate: false, point: null, page: { id: randomUUID(), workspace: owner, url: request.url, title: '', status: 'loading', error: null, canGoBack: false, canGoForward: false, sharedOrigin: null, viewport: null, device: phone ? 'iphone' : null } }
    this.pages.set(record.page.id, record)
    const contents = view.webContents
    if (phone) {
      contents.setUserAgent(TEST_IPHONE.userAgent)
      // Each new origin starts at the session's default zoom, so the phone's fit is put back on every document.
      contents.on('did-navigate', () => { if (!contents.isDestroyed()) contents.setZoomFactor(record.zoom) })
      contents.on('dom-ready', () => {
        if (contents.isDestroyed()) return
        contents.setZoomFactor(record.zoom)
        void contents.insertCSS(PHONE_CSS).catch(() => undefined)
      })
    }
    const blocked = (event: { preventDefault(): void }, url: string): void => {
      if (safeBrowserUrl(url)) return
      event.preventDefault()
      this.issue(record, t`This navigation is blocked. Only HTTP and HTTPS pages can open here.`)
    }
    contents.on('will-navigate', (event, url) => blocked(event, url))
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame && event.url === 'about:blank') return
      blocked(event, event.url)
    })
    contents.on('will-redirect', (event, url) => blocked(event, url))
    contents.on('will-attach-webview', event => event.preventDefault())
    // Escape pressed while the page has the keyboard leaves Point at something, as it does in Sotto's own window.
    // Enter picks the element the keyboard is on, as a click picks the one under the pointer; the page does not get it.
    contents.on('before-input-event', (event, input) => {
      if (!record.point || input.type !== 'keyDown') return
      if (input.key === 'Enter') { if (record.automation.pickFocused()) event.preventDefault(); return }
      if (input.key !== 'Escape') return
      event.preventDefault()
      // The keyboard goes back to Sotto's window, where the Point button takes it.
      this.focusWindow(record)
      this.endPoint(record, 'escape')
    })
    contents.setWindowOpenHandler(() => {
      this.issue(record, t`A new-window request was blocked. Use a link destination action or open this page externally.`)
      return { action: 'deny' }
    })
    const moving = (url: string, mainFrame: boolean): boolean => mainFrame && this.moved(record, url)
    contents.on('did-start-navigation', (_event, url, _inPlace, mainFrame) => {
      if (!moving(url, mainFrame)) return
      record.automation.clear()
      record.page.status = 'loading'; record.page.error = null
      this.publish(record)
    })
    // A server's redirect is the same navigation going somewhere else. Without this the page kept the address it
    // started from, never finished loading, and a shared page could not be inspected at the address it reached.
    contents.on('did-redirect-navigation', (_event, url, _inPlace, mainFrame) => { if (moving(url, mainFrame)) this.publish(record) })
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
      if (!moving(url, mainFrame)) return
      record.page.status = 'ready'
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
      this.issue(record, t`This page is unavailable. Check the address or start its local server, then reload.`, true)
    })
    contents.on('render-process-gone', () => this.issue(record, t`This page stopped unexpectedly. Reload to reopen it.`, true))
    if (!initial) { this.load(record, request.url); this.shareByGrant(record) }
    else record.page.error = BROWSER_WAITING_TO_OPEN
    return this.publish(record)
  }
  protected startLoading(record: PageRecord, url: string, generation: number): void {
    void record.view.webContents.loadURL(url).catch((error: unknown) => {
      if (record.generation === generation && (error as { code?: string }).code !== 'ERR_ABORTED') this.issue(record, t`This page is unavailable. Check the address or start its local server, then reload.`, true)
    })
  }
  protected isGone(record: PageRecord): boolean { return record.view.webContents.isDestroyed() }
  protected loadedUrl(record: PageRecord): string { return record.view.webContents.getURL() }
  protected step(record: PageRecord, direction: 'back' | 'forward'): void {
    const history = record.view.webContents.navigationHistory
    if (direction === 'back' && history.canGoBack()) history.goBack()
    else if (direction === 'forward' && history.canGoForward()) history.goForward()
  }
  protected pageLeft(record: PageRecord, reason: 'navigated' | 'hidden'): void { this.endPoint(record, reason) }
  /** The thread's test iPhone, if it has opened one; a thread has at most one. */
  private phoneOf(owner: FileWorkspace): PageRecord | undefined {
    return [...this.pages.values()].find(record => record.page.device === 'iphone' && record.page.workspace.threadId === owner.threadId && record.page.workspace.workspaceId === owner.workspaceId)
  }
  private isMounted(record: PageRecord): boolean { return this.mounted.get(slotOf(record))?.record === record }
  openLink(payload: unknown) { return this.run(async () => {
    const request = parse(browserOpenLinkSchema, payload)
    const destination = request.destination ?? await this.dependencies.destination()
    if (destination === 'external') {
      await this.dependencies.openExternal(request.url)
      return { destination }
    }
    if (!request.target) return fail('workspace-unavailable', t`Select a thread before opening an embedded page.`)
    return { destination, page: await this.createPage({ ...request.target, url: request.url }) }
  }) }
  mount(payload: unknown) { return this.run(async () => {
    const request = parse(browserMountSchema, payload)
    // A page's slot follows from its kind. An unknown page is refused by `owned` below; until then it counts as the pane's.
    const known = this.pages.get(request.pageId)
    const slot: MountSlot = known ? slotOf(known) : 'pane'
    // Binding validation does disk IO. Last requested page wins even if earlier IO finishes later.
    const version = request.bounds !== null ? ++this.mountVersion[slot] : this.mountVersion[slot]
    if (request.bounds !== null) this.desiredPageId[slot] = request.pageId
    else if (this.desiredPageId[slot] === request.pageId) { this.desiredPageId[slot] = null; this.mountVersion[slot]++ }
    const record = await this.owned(request, request.bounds !== null)
    // A page nobody shows leaves Point at something.
    if (request.bounds === null) { if (this.isMounted(record)) this.removeMountedView(slot); this.endPoint(record, 'hidden'); return }
    if (version !== this.mountVersion[slot]) return
    const window = this.dependencies.getWindow()
    if (!window || window.isDestroyed()) return fail('unavailable', t`The main window is unavailable.`)
    const shown = this.mounted.get(slot)
    // The same page in the same window only moves, as when the line over the page appears with Point at something: it
    // keeps its place on the window, and with it the keyboard focus main may just have given it.
    if (shown?.record === record && shown.window === window) {
      this.desiredPageId[slot] = request.pageId
      this.setBounds(record, window, request.bounds)
      this.startPoint(record)
      return
    }
    const previous = shown?.record
    this.removeMountedView(slot)
    if (previous && previous !== record) this.endPoint(previous, 'hidden')
    this.desiredPageId[slot] = request.pageId
    this.setBounds(record, window, request.bounds)
    const detach = (): void => this.detach()
    // A hidden or minimized window shows no page, and the window's own frame loop stops while it is hidden. Ending it
    // makes a start still being checked stale too, so it cannot finish on the hidden window.
    const hidden = (): void => this.endPoint(record, 'hidden')
    // Detach on host reload/crash so native content cannot obscure a recovered app screen.
    window.webContents.on('did-start-loading', detach)
    window.webContents.on('render-process-gone', detach)
    window.webContents.on('destroyed', detach)
    window.on('closed', detach)
    window.on('resize', detach)
    window.on('hide', hidden)
    window.on('minimize', hidden)
    this.mounted.set(slot, { record, window, cleanup: () => {
      window.webContents.removeListener('did-start-loading', detach)
      window.webContents.removeListener('render-process-gone', detach)
      window.webContents.removeListener('destroyed', detach)
      window.removeListener('closed', detach)
      window.removeListener('resize', detach)
      window.removeListener('hide', hidden)
      window.removeListener('minimize', hidden)
    } })
    window.contentView.addChildView(record.view)
    this.startPoint(record)
  }) }
  private setBounds(record: PageRecord, window: BrowserWindow, bounds: BrowserBounds): void {
    const zoom = window.webContents.getZoomFactor()
    const [width = 0, height = 0] = window.getContentSize()
    const x = Math.min(width, Math.round(bounds.x * zoom)), y = Math.min(height, Math.round(bounds.y * zoom))
    const view = { x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width * zoom))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height * zoom))) }
    record.view.setBounds(view)
    if (!record.page.device) return
    // The phone's page lays out at 393 CSS pixels however large the player draws it: page zoom, not device
    // emulation, whose scale moves CDP input away from the point asked for (ADR-0045).
    record.zoom = Math.max(0.25, view.width / TEST_IPHONE.width)
    if (!record.view.webContents.isDestroyed()) record.view.webContents.setZoomFactor(record.zoom)
    record.view.setBorderRadius(Math.round(view.width * 0.12))
  }
  detach(): void {
    for (const slot of ['pane', 'phone'] as const) {
      this.mountVersion[slot]++
      this.desiredPageId[slot] = null
      const shown = this.mounted.get(slot)?.record
      this.removeMountedView(slot)
      if (shown) this.endPoint(shown, 'hidden')
    }
  }
  private removeMountedView(slot: MountSlot): void {
    const mounted = this.mounted.get(slot); this.mounted.delete(slot)
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
      if (!this.isMounted(record)) {
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
        if (!this.isMounted(record)) {
          if (!lease.window.isDestroyed()) lease.window.contentView.removeChildView(record.view)
          record.view.setBounds(lease.bounds)
        }
      }
      if (lease.temporary && !lease.window.isDestroyed()) lease.window.destroy()
    }
  }
  protected destroy(record: PageRecord): Promise<void> {
    const slot = slotOf(record)
    if (this.desiredPageId[slot] === record.page.id) { this.desiredPageId[slot] = null; this.mountVersion[slot]++ }
    if (this.isMounted(record)) this.removeMountedView(slot)
    // Closing says so with its own event; point mode simply goes with the page.
    record.point = null
    this.pointRequests.delete(record.page.id)
    this.endTasks(record)
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
  viewport(payload: unknown) { return this.run(async () => {
    const request = parse(browserViewportSchema, payload)
    const record = await this.owned(request)
    if (record.page.device) return fail('blocked', t`The test iPhone keeps its own size.`)
    if ('reset' in request) {
      await record.automation.resetViewport()
      record.page.viewport = null
      record.generation++
      this.invalidate(record)
      return this.publish(record)
    }
    await record.automation.input({ type: 'viewport', width: request.width, height: request.height }, () => {
      if (record.view.webContents.isDestroyed()) fail('page-unavailable', t`This page closed.`)
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
      if (!request.captureId || !selection || selection.id !== request.captureId || selection.expiresAt < Date.now()) return fail('blocked', t`Capture the page again before selecting feedback.`)
      const original = selection.capture
      const image = nativeImage.createFromDataURL(original.image)
      if (request.region) {
        const region = { x: Math.round(request.region.x), y: Math.round(request.region.y), width: Math.round(request.region.width), height: Math.round(request.region.height) }
        if (region.width < 1 || region.height < 1 || region.x + region.width > original.width || region.y + region.height > original.height) return fail('blocked', t`Select a region inside the captured page.`)
        // Feedback annotates the immutable image the user selected, even if the live page animates.
        return { ...original, captureId: selection.id, image: image.crop(region).toDataURL(), width: region.width, height: region.height, element: null }
      }
      if (selection.generation !== generation) return fail('blocked', t`The page changed. Use Region to comment on the saved screenshot, or capture it again.`)
      const selected = await record.automation.elementAt(request.point!)
      if (!selected) return fail('blocked', t`No element is available there. Use Region to comment on the saved screenshot.`)
      const x = Math.max(0, Math.floor(selected.bounds.x)), y = Math.max(0, Math.floor(selected.bounds.y))
      const region = { x, y, width: Math.min(original.width, Math.ceil(selected.bounds.x + selected.bounds.width)) - x, height: Math.min(original.height, Math.ceil(selected.bounds.y + selected.bounds.height)) - y }
      if (region.width <= 0 || region.height <= 0) return fail('blocked', t`That element is outside the captured page.`)
      const after = await record.automation.elementAt(request.point!)
      if (record.generation !== generation || JSON.stringify(after) !== JSON.stringify(selected)) return fail('blocked', t`That element changed. Use Region to comment on the saved screenshot, or capture it again.`)
      return { ...original, captureId: selection.id, element: selected.element }
    }
    const full = await record.automation.capture(record.page.url)
    if (record.generation !== generation) return fail('blocked', t`The page changed. Capture it again.`)
    record.selection = { id: randomUUID(), generation, capture: full, expiresAt: Date.now() + 5 * 60_000 }
    return { ...full, captureId: record.selection.id }
  }) }
  /**
   * Point at something (ADR-0154): the user's own action, so it needs neither sharing nor the browser grant. It
   * turns on for a page the pane shows or is about to show; a page nobody shows answers false and nothing starts.
   * Requests for a page are answered in the order they were made: an Off made while an On is still being checked
   * leaves the On with nothing to do.
   */
  point(payload: unknown) { return this.run(async () => {
    const request = parse(browserPointModeSchema, payload)
    if (!this.dependencies.pointAtSomething) return fail('unavailable', t`Point at something is not available in this version of Sotto.`)
    const ticket = ++this.pointSessions
    this.pointRequests.set(request.pageId, ticket)
    const record = await this.owned(request, request.on)
    if (!request.on) { this.endPoint(record, null); return { pointing: false } }
    if (this.pointRequests.get(request.pageId) !== ticket) return { pointing: false }
    if (!request.color) return fail('blocked', t`Point at something needs the theme's accent colour from the window.`)
    const shown = this.isMounted(record) || this.desiredPageId.pane === record.page.id
    if (record.page.device || record.page.status === 'unavailable' || !shown) return { pointing: false }
    record.point ??= { session: ticket, color: request.color, live: false, picking: false }
    this.startPoint(record)
    return { pointing: true }
  }) }
  private emitPoint(record: PageRecord, point: BrowserPointState): void {
    if (this.disposed || !this.pages.has(record.page.id)) return
    const { threadId, workspaceId } = record.page.workspace
    this.dependencies.emit({ type: 'point', threadId, workspaceId, pageId: record.page.id, point })
  }
  private focusWindow(record: PageRecord): void {
    const shown = this.mounted.get('pane')
    if (shown?.record === record && !shown.window.isDestroyed()) shown.window.webContents.focus()
  }
  /**
   * Turns the overlay on for a page the user asked to point at, once the pane shows it, and gives the page the
   * keyboard, so Tab moves through its own elements and Enter picks one.
   */
  private startPoint(record: PageRecord): void {
    const point = record.point
    if (!point || point.live || !this.isMounted(record)) return
    // A window hidden or minimized before the page was shown in it shows no page either.
    const shown = this.mounted.get(slotOf(record))
    if (!shown || shown.window.isDestroyed() || !shown.window.isVisible() || shown.window.isMinimized()) { this.endPoint(record, 'hidden'); return }
    point.live = true
    const current = (): boolean => record.point === point
    void record.automation.point(point.color, {
      hover: element => { if (current() && !point.picking) this.emitPoint(record, { state: 'hover', ...element }) },
      pick: target => { if (current() && !point.picking) { point.picking = true; void this.pick(record, point, target) } },
    }).then(() => { if (current() && !point.picking && !record.view.webContents.isDestroyed()) record.view.webContents.focus() },
      () => { if (current()) this.endPoint(record, 'unavailable') })
  }
  /** Point mode off. `reason` tells the window why, when it was not the window's own doing. */
  private endPoint(record: PageRecord, reason: PointEnd | null): void {
    // Whatever ends pointing, a navigation, a hide or Off, also makes a start still being checked for this page stale,
    // so it cannot turn the overlay on once it is checked.
    if (this.pages.has(record.page.id)) this.pointRequests.set(record.page.id, ++this.pointSessions)
    const point = record.point
    if (!point) return
    record.point = null
    if (point.live) void record.automation.unpoint()
    if (reason) this.emitPoint(record, { state: 'ended', reason })
  }
  /**
   * The user clicked an element, or pressed Enter on one: the overlay goes, the window gets the keyboard back for the
   * comment, and the page is captured as it looks now, kept as the page's selection the way Comment on page keeps its
   * capture. The session lasts until the picture is sent, so a hide, a navigation or Off meanwhile ends it, and
   * nothing is sent for a page nobody shows.
   */
  private async pick(record: PageRecord, point: PointSession, target: PointTarget): Promise<void> {
    const current = (): boolean => record.point === point && this.isMounted(record) && !record.view.webContents.isDestroyed()
    try {
      await record.automation.unpoint()
      if (!current()) return
      this.focusWindow(record)
      const pointed = await record.automation.pointed(target)
      if (!current()) return
      if (!pointed) { this.endPoint(record, 'unavailable'); return }
      const full = await record.automation.capture(record.page.url)
      if (!current()) return
      record.point = null
      record.selection = { id: randomUUID(), generation: record.generation, capture: { ...full, element: pointed.element }, expiresAt: Date.now() + 5 * 60_000 }
      this.emitPoint(record, { state: 'picked', capture: { ...full, captureId: record.selection.id, element: pointed.element }, box: pointed.box })
    } catch { if (record.point === point) this.endPoint(record, 'unavailable') }
  }
  /**
   * `iphone_open`: the agent opens a URL on the thread's test iPhone (ADR-0045). A thread has one phone, so a phone
   * it already has is replaced by the new one, which asks or is granted exactly as a new page is; one with a task
   * still working or paused on it is left alone.
   */
  phoneOpen(payload: unknown) { return this.run(async (): Promise<BrowserAgentResult> => {
    // A file that cannot open is refused before the phone it would replace is closed.
    const request = await this.agentRequest(payload)
    const owner = await this.owner(request.threadId, request.workspaceId)
    const existing = this.phoneOf(owner)
    if (existing) {
      if ([...this.taskRecords.values()].some(task => task.pageId === existing.page.id && ['working', 'paused'].includes(task.status))) return fail('busy', 'Finish the test iPhone\'s current browser task first.')
      await this.destroy(existing)
      this.dependencies.emit({ type: 'closed', threadId: owner.threadId, workspaceId: owner.workspaceId, pageId: existing.page.id })
    }
    return this.open({ ...request, device: 'iphone' })
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
    this.disposeTasks()
  }
}
