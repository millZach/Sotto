import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { safeBrowserUrl, type BrowserCapture } from '../../shared/browser'
import { EVIDENCE_LIMIT, EVIDENCE_PICTURES, PageAutomation, type PageDebugger, type PageEventListener, type PageEvidence, type PageFrame, type PageInput, type PagePicture } from '../../main/tools/pageAutomation'
import { DevToolsPipe } from './devToolsPipe'
import { findBrowser } from './findBrowser'

/**
 * A host's own browser (ADR-0198): the Chrome, Chromium or Edge installed on the host, started headless by this
 * host's Sotto the first time one of its threads opens a page, and driven over the DevTools pipe. Each workspace gets
 * a browser context of its own, kept in memory, inside one temporary profile that is deleted when the browser closes,
 * so nothing a page stores outlives it. Only http and https documents load; new windows, downloads and permission
 * requests are refused, as in the desktop's browser. Nothing here logs: addresses, titles and pictures are the user's.
 */

/** What a host says when it has no browser to drive. The agent reads it, so it says what to do. */
export const NO_HOST_BROWSER = 'No Chrome, Chromium or Edge is installed on the machine this thread runs on, so Sotto\'s browser can\'t open a page here. Ask the user to install one there. Nothing was opened.'
export const PAGE_UNAVAILABLE = 'This page is unavailable. Check the address or start its local server, then reload.'
export const PAGE_STOPPED = 'This page stopped unexpectedly. Reload to reopen it.'
export const PAGE_BLOCKED = 'This navigation is blocked. Only HTTP and HTTPS pages can open here.'
export const NEW_WINDOW_BLOCKED = 'A new-window request was blocked. Use a link destination action or open this page externally.'
export const DOWNLOAD_BLOCKED = 'Downloads are blocked here. Open this page externally to download.'

/** The permissions a page might ask for, all refused (ADR-0198, as the desktop's browser refuses them). */
/** Every name the Permissions API knows; a name an older Chromium doesn't know is skipped. */
const REFUSED_PERMISSIONS = ['accelerometer', 'ambient-light-sensor', 'background-fetch', 'background-sync', 'camera', 'captured-surface-control', 'clipboard-read', 'clipboard-write', 'display-capture', 'fullscreen', 'geolocation', 'gyroscope', 'idle-detection', 'keyboard-lock', 'local-fonts', 'magnetometer', 'microphone', 'midi', 'nfc', 'notifications', 'payment-handler', 'periodic-background-sync', 'persistent-storage', 'pointer-lock', 'protected-media-identifier', 'screen-wake-lock', 'speaker-selection', 'storage-access', 'system-wake-lock', 'top-level-storage-access', 'web-app-installation', 'window-management']
/** Asks Chromium itself not to call home: no updates, sync, reports or field trials while a host drives it. */
const QUIET_FLAGS = ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--disable-domain-reliability', '--disable-breakpad', '--metrics-recording-only', '--no-pings', '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication', '--password-store=basic', '--use-mock-keychain', '--mute-audio']
/** The size a page starts at, as on the desktop, until a pane or the agent sets another. */
export const HOST_PAGE_SIZE = { width: 1280, height: 800 } as const

export type HostPageStatus = 'loading' | 'ready' | 'unavailable'
export interface HostPageState {
  readonly url: string
  readonly title: string
  readonly status: HostPageStatus
  readonly error: string | null
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}
/** One picture of the page as it changes, for a pane that shows it. JPEG, base64, at the size it was drawn. */
export interface HostPageFrame { readonly data: string; readonly width: number; readonly height: number }
export type HostInputModifiers = number
/** The user's own input in a pane, sent on to the page as Chromium's input events. */
export type HostPageInput =
  | { readonly type: 'mouse'; readonly action: 'move' | 'down' | 'up'; readonly x: number; readonly y: number; readonly button: 'none' | 'left' | 'middle' | 'right'; readonly clickCount: number; readonly modifiers: HostInputModifiers }
  | { readonly type: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number; readonly modifiers: HostInputModifiers }
  | { readonly type: 'key'; readonly action: 'down' | 'up'; readonly key: string; readonly code: string; readonly keyCode: number; readonly text?: string; readonly modifiers: HostInputModifiers }
  | { readonly type: 'text'; readonly text: string }

export interface HostBrowserOptions {
  /** Where the browser is. Looked for in the usual places by default (`findBrowser`). */
  readonly find?: () => Promise<string | undefined>
  /** Where the temporary profile goes. The system's temporary folder by default. */
  readonly profileRoot?: string
  /** Starts the browser. A test can start a fake one; it must give the child pipes on fds 3 and 4. */
  readonly spawn?: (executable: string, args: readonly string[]) => ChildProcess
}

interface Running {
  readonly child: ChildProcess
  readonly pipe: DevToolsPipe
  readonly profile: string
  readonly contexts: Map<string, Promise<string>>
  readonly pages: Map<string, HostBrowserPage>
  ending: Promise<void> | null
}

export class HostBrowser {
  private running: Promise<Running> | null = null
  /** The browser `running` resolves to, known from the moment it starts, so ending it never waits on its own start. */
  private live: Running | null = null
  private disposed = false
  private readonly closeListeners = new Set<() => void>()

  constructor(private readonly options: HostBrowserOptions = {}) {}

  /** Whether the host has a browser to drive, without starting it. */
  async available(): Promise<boolean> { return Boolean(await (this.options.find ?? (() => findBrowser()))()) }

  /** Called when the browser closes, on purpose or not, after every open page has said it closed. */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  /** The pages open now, in the order they opened. */
  async pages(): Promise<HostBrowserPage[]> {
    if (!this.running) return []
    const running = await this.running.catch(() => null)
    return running ? [...running.pages.values()] : []
  }

  /** A new blank page in `workspace`'s browser context, starting the browser when it isn't running. */
  async open(workspace: string, size: { width: number; height: number } = HOST_PAGE_SIZE): Promise<HostBrowserPage> {
    if (this.disposed) throw new Error('The host is stopping.')
    const running = await this.start()
    const contextId = await this.context(running, workspace)
    const { targetId } = await running.pipe.send('Target.createTarget', { url: 'about:blank', browserContextId: contextId }) as { targetId: string }
    const { sessionId } = await running.pipe.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string }
    const page = new HostBrowserPage(running.pipe, targetId, sessionId, workspace, () => this.forget(running, page))
    running.pages.set(targetId, page)
    await page.setUp(size)
    return page
  }

  /** Closes the browser and deletes its profile. A later `open` starts it again unless the host is stopping. */
  async close(): Promise<void> {
    const running = this.running
    this.running = null
    if (!running) return
    const started = await running.catch(() => null)
    if (started) await this.shut(started)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.close()
    this.closeListeners.clear()
  }

  private start(): Promise<Running> {
    if (this.running) return this.running
    const starting = this.launch()
    this.running = starting
    starting.catch(() => { if (this.running === starting) this.running = null })
    return starting
  }

  private async launch(): Promise<Running> {
    const executable = await (this.options.find ?? (() => findBrowser()))()
    if (!executable) throw new HostBrowserMissing()
    const profile = await mkdtemp(join(this.options.profileRoot ?? tmpdir(), 'sotto-host-browser-'))
    const args = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, `--window-size=${HOST_PAGE_SIZE.width},${HOST_PAGE_SIZE.height}`, ...QUIET_FLAGS, 'about:blank']
    let child: ChildProcess
    try {
      child = (this.options.spawn ?? ((file, list) => spawn(file, [...list], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true })))(executable, args)
    } catch (error) {
      await rm(profile, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    const pipe = new DevToolsPipe(child.stdio[3] as Writable, child.stdio[4] as Readable)
    const running: Running = { child, pipe, profile, contexts: new Map(), pages: new Map(), ending: null }
    this.live = running
    child.once('error', () => pipe.close())
    child.once('exit', () => pipe.close())
    pipe.onClose(() => { void this.ended(running) })
    try {
      await pipe.send('Target.setDiscoverTargets', { discover: true })
    } catch (error) {
      await this.shut(running)
      throw error
    }
    pipe.on((method, params, sessionId) => {
      if (sessionId) return
      if (method === 'Target.targetCreated') this.refuseWindow(running, params.targetInfo as { targetId?: string; type?: string; openerId?: string } | undefined)
      if (method === 'Target.targetInfoChanged') {
        const info = params.targetInfo as { targetId?: string } | undefined
        if (info?.targetId) running.pages.get(info.targetId)?.refresh()
      }
      if (method === 'Target.targetDestroyed' && typeof params.targetId === 'string') running.pages.get(params.targetId)?.gone()
      if (method === 'Browser.downloadWillBegin' && typeof params.frameId === 'string') {
        for (const page of running.pages.values()) if (page.ownsFrame(params.frameId)) page.issue(DOWNLOAD_BLOCKED, false)
      }
    })
    return running
  }

  /** A new window a page opened is closed before it shows anything, and its opener says so (as on the desktop). */
  private refuseWindow(running: Running, info: { targetId?: string; type?: string; openerId?: string } | undefined): void {
    if (!info?.targetId || info.type !== 'page' || running.pages.has(info.targetId) || !info.openerId) return
    const opener = running.pages.get(info.openerId)
    if (!opener) return
    void running.pipe.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined)
    opener.issue(NEW_WINDOW_BLOCKED, false)
  }

  private context(running: Running, workspace: string): Promise<string> {
    const existing = running.contexts.get(workspace)
    if (existing) return existing
    const creating = (async () => {
      const { browserContextId } = await running.pipe.send('Target.createBrowserContext', { disposeOnDetach: true }) as { browserContextId: string }
      await running.pipe.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId, eventsEnabled: true }).catch(() => undefined)
      for (const name of REFUSED_PERMISSIONS) await running.pipe.send('Browser.setPermission', { permission: { name }, setting: 'denied', browserContextId }).catch(() => undefined)
      return browserContextId
    })()
    running.contexts.set(workspace, creating)
    creating.catch(() => { if (running.contexts.get(workspace) === creating) running.contexts.delete(workspace) })
    return creating
  }

  /** A page closed: its workspace's context goes with its last page, so nothing it stored is kept. */
  private forget(running: Running, page: HostBrowserPage): void {
    running.pages.delete(page.id)
    if ([...running.pages.values()].some(other => other.workspace === page.workspace)) return
    const context = running.contexts.get(page.workspace)
    running.contexts.delete(page.workspace)
    void context?.then(browserContextId => running.pipe.send('Target.disposeBrowserContext', { browserContextId })).catch(() => undefined)
  }

  private async shut(running: Running): Promise<void> {
    const exited = new Promise<void>(resolve => {
      if (running.child.exitCode !== null || running.child.signalCode !== null) resolve()
      else running.child.once('exit', () => resolve())
    })
    await running.pipe.send('Browser.close').catch(() => undefined)
    running.pipe.close()
    await exited
    await this.ended(running)
  }

  /** The browser is gone or going: every page hears it once, and the profile is deleted once it has exited. */
  private ended(running: Running): Promise<void> {
    running.ending ??= this.end(running)
    return running.ending
  }
  private async end(running: Running): Promise<void> {
    if (this.live === running) { this.live = null; this.running = null }
    const pages = [...running.pages.values()]
    running.pages.clear(); running.contexts.clear()
    for (const page of pages) page.gone()
    // The profile goes only once the browser has exited, or it would write into it again.
    if (running.child.exitCode === null && running.child.signalCode === null) {
      const exited = new Promise<void>(resolve => running.child.once('exit', () => resolve()))
      const timer = setTimeout(() => { running.child.kill('SIGKILL') }, 5_000)
      await exited
      clearTimeout(timer)
    }
    await rm(running.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
    for (const listener of [...this.closeListeners]) listener()
  }
}

/**
 * A page's title as the pane shows it: without controls or bidi marks, as the desktop strips them, and empty when it
 * is only Chromium's stand-in for a page without one, the address without its scheme.
 */
export function pageTitle(title: string, url: string): string {
  // eslint-disable-next-line no-control-regex -- Untrusted title display sanitization.
  const clean = title.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 512)
  return clean === url || clean === url.replace(/^https?:\/\//u, '') ? '' : clean
}

export class HostBrowserMissing extends Error {
  constructor() { super(NO_HOST_BROWSER) }
}

type FrameSubscription = { readonly size: { readonly width: number; readonly height: number }; readonly deliver: (frame: HostPageFrame) => void }

/**
 * One page in a host's browser, with its own DevTools session. Its automation is the desktop's (`PageAutomation`),
 * so an agent's inspect, click, type and capture behave as they do there.
 */
export class HostBrowserPage {
  readonly automation: HostPageAutomation
  private current: HostPageState = { url: 'about:blank', title: '', status: 'ready', error: null, canGoBack: false, canGoForward: false }
  private readonly changeListeners = new Set<(state: HostPageState) => void>()
  private readonly closeListeners = new Set<() => void>()
  private readonly sessionListeners = new Set<PageEventListener>()
  private readonly subscriptions = new Set<FrameSubscription>()
  private screencast: { width: number; height: number } | null = null
  private mainFrame: string | null = null
  private ended = false
  /** Counts navigations, so a late answer about an earlier one can't mark this one failed. */
  private navigation = 0
  private refreshing = false
  private refreshAgain = false
  private lastFrameRefresh = 0
  private streamChanges: Promise<void> = Promise.resolve()
  private readonly unsubscribe: () => void

  constructor(private readonly pipe: DevToolsPipe, readonly id: string, private readonly sessionId: string, readonly workspace: string, private readonly onGone: () => void) {
    this.automation = new HostPageAutomation(this.debugger(), this)
    this.unsubscribe = pipe.on((method, params, session) => {
      if (session !== sessionId) return
      this.observe(method, params)
      for (const listener of [...this.sessionListeners]) listener(method, params)
    })
  }

  get state(): HostPageState { return this.current }
  get closed(): boolean { return this.ended }

  onChange(listener: (state: HostPageState) => void): () => void {
    this.changeListeners.add(listener)
    return () => { this.changeListeners.delete(listener) }
  }
  onClose(listener: () => void): () => void {
    if (this.ended) { listener(); return () => undefined }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  /** @internal Called once by the browser after the session is attached. */
  async setUp(size: { width: number; height: number }): Promise<void> {
    await this.send('Page.enable')
    const tree = await this.send('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } }
    this.mainFrame = tree.frameTree?.frame?.id ?? null
    // Only http and https documents load, in any frame; a frame may still start blank.
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] })
    await this.resize(size).catch(() => undefined)
  }

  /** Loads `url` in the page. An address that isn't http or https is refused before anything loads. */
  async navigate(url: string): Promise<void> {
    const safe = safeBrowserUrl(url)
    if (!safe) { this.issue(PAGE_BLOCKED, false); return }
    const navigation = ++this.navigation
    this.update({ url: safe, status: 'loading', error: null })
    const result = await this.send('Page.navigate', { url: safe }).catch(() => ({ errorText: 'failed' })) as { errorText?: string }
    if (result.errorText && navigation === this.navigation && result.errorText !== 'net::ERR_ABORTED') this.issue(PAGE_UNAVAILABLE, true)
  }
  async back(): Promise<void> { await this.step(-1) }
  async forward(): Promise<void> { await this.step(1) }
  async reload(): Promise<void> {
    this.navigation++
    this.update({ status: 'loading', error: null })
    await this.send('Page.reload')
  }
  async close(): Promise<void> {
    if (this.ended) return
    await this.pipe.send('Target.closeTarget', { targetId: this.id }).catch(() => undefined)
    this.gone()
  }

  /**
   * The size the page lays out at: the pane it is shown in, or the size it opened at. A Chromium too old to size the
   * page's own area has its window sized instead, then corrected by what its stand-in for browser chrome took.
   */
  async resize(size: { width: number; height: number }): Promise<void> {
    const width = Math.round(size.width), height = Math.round(size.height)
    const { windowId } = await this.pipe.send('Browser.getWindowForTarget', { targetId: this.id }) as { windowId: number }
    try { await this.pipe.send('Browser.setContentsSize', { windowId, width, height }); return } catch { /* Older than Chrome 138: size the window. */ }
    await this.pipe.send('Browser.setWindowBounds', { windowId, bounds: { width, height } })
    const metrics = await this.send('Page.getLayoutMetrics') as { cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }
    const inner = metrics.cssLayoutViewport
    if (!inner?.clientWidth || !inner.clientHeight || (inner.clientWidth === width && inner.clientHeight === height)) return
    await this.pipe.send('Browser.setWindowBounds', { windowId, bounds: { width: width * 2 - inner.clientWidth, height: height * 2 - inner.clientHeight } })
  }

  /**
   * Pictures of the page as it changes, for one pane, until the returned stop. Chromium sends the next picture only
   * once the last is acknowledged, so a pane gets the newest rather than a queue. With several panes, pictures are
   * drawn at the largest size any of them asked for.
   */
  watch(size: { width: number; height: number }, deliver: (frame: HostPageFrame) => void): () => void {
    const subscription: FrameSubscription = { size: { width: Math.round(size.width), height: Math.round(size.height) }, deliver }
    this.subscriptions.add(subscription)
    void this.restream()
    return () => {
      if (!this.subscriptions.delete(subscription)) return
      void this.restream()
    }
  }

  /** The user's own click, key, typed text or scroll from a pane. It needs no grant: it is the user acting. */
  async input(event: HostPageInput): Promise<void> {
    try { await this.dispatch(event) } finally { this.refresh() }
  }
  private async dispatch(event: HostPageInput): Promise<void> {
    if (event.type === 'text') { await this.send('Input.insertText', { text: event.text }); return }
    if (event.type === 'wheel') { await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: event.modifiers }); return }
    if (event.type === 'mouse') {
      const type = event.action === 'move' ? 'mouseMoved' : event.action === 'down' ? 'mousePressed' : 'mouseReleased'
      await this.send('Input.dispatchMouseEvent', { type, x: event.x, y: event.y, button: event.button, clickCount: event.clickCount, modifiers: event.modifiers })
      return
    }
    const type = event.action === 'up' ? 'keyUp' : event.text ? 'keyDown' : 'rawKeyDown'
    await this.send('Input.dispatchKeyEvent', { type, key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, nativeVirtualKeyCode: event.keyCode, modifiers: event.modifiers, ...(event.text && event.action === 'down' ? { text: event.text, unmodifiedText: event.text } : {}) })
  }

  /** @internal */ send(method: string, params: Record<string, unknown> = {}): Promise<unknown> { return this.pipe.send(method, params, this.sessionId) }
  /** @internal */ ownsFrame(frameId: string): boolean { return frameId === this.mainFrame }
  /**
   * Reads the page's history again for its title and whether it can go back or forward. Chromium sends no event when
   * a script changes the title, so this runs after a load, after input, and at most twice a second while a pane is
   * watching; a burst of calls makes one read.
   */
  refresh(): void {
    if (this.ended) return
    if (this.refreshing) { this.refreshAgain = true; return }
    this.refreshing = true
    void this.history().finally(() => {
      this.refreshing = false
      if (!this.refreshAgain) return
      this.refreshAgain = false
      this.refresh()
    })
  }
  /** @internal Something went wrong on the page; `failed` marks it unavailable until it loads again. */
  issue(error: string, failed: boolean): void { this.update({ error, ...(failed ? { status: 'unavailable' as const } : {}) }) }
  /** @internal The page's target is gone: every listener hears it once. */
  gone(): void {
    if (this.ended) return
    this.ended = true
    this.subscriptions.clear()
    this.unsubscribe()
    this.automation.dispose()
    this.onGone()
    for (const listener of [...this.closeListeners]) listener()
    this.closeListeners.clear(); this.changeListeners.clear(); this.sessionListeners.clear()
  }

  private debugger(): PageDebugger {
    let attached = true
    let generation = 0
    return {
      isGone: () => this.ended,
      url: () => this.current.url,
      isAttached: () => attached && !this.ended,
      attach: () => { if (this.ended) throw new Error('This page closed.'); attached = true },
      // Electron's detach rejects what is still waiting; here an answer from before a detach is dropped the same way.
      detach: () => { attached = false; generation++ },
      sendCommand: async (method, params) => {
        const sent = generation
        const result = await this.send(method, params ?? {})
        if (sent !== generation) throw new Error('The page\'s debugger was detached.')
        return result
      },
      onEvent: listener => { this.sessionListeners.add(listener) },
      offEvent: listener => { this.sessionListeners.delete(listener) },
    }
  }

  private async step(delta: -1 | 1): Promise<void> {
    const history = await this.send('Page.getNavigationHistory') as { currentIndex: number; entries: { id: number }[] }
    const entry = history.entries[history.currentIndex + delta]
    if (!entry) return
    this.navigation++
    this.update({ status: 'loading', error: null })
    await this.send('Page.navigateToHistoryEntry', { entryId: entry.id })
  }

  /**
   * Starts, resizes or stops the picture stream for whoever watches now. Changes run one after another, each reading
   * the subscriptions when its turn comes, so a stream nobody watches any more is never started again.
   */
  private restream(): Promise<void> {
    this.streamChanges = this.streamChanges.then(() => this.applyStream(), () => this.applyStream())
    return this.streamChanges
  }
  private async applyStream(): Promise<void> {
    if (this.ended) return
    const wanted = this.subscriptions.size ? { width: Math.max(...[...this.subscriptions].map(subscription => subscription.size.width)), height: Math.max(...[...this.subscriptions].map(subscription => subscription.size.height)) } : null
    if (wanted?.width === this.screencast?.width && wanted?.height === this.screencast?.height) return
    const was = this.screencast
    this.screencast = wanted
    if (was) await this.send('Page.stopScreencast').catch(() => undefined)
    if (wanted) await this.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: wanted.width, maxHeight: wanted.height, everyNthFrame: 1 }).catch(() => undefined)
  }

  private observe(method: string, params: Record<string, unknown>): void {
    if (method === 'Page.screencastFrame') {
      const session = params.sessionId
      const metadata = params.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined
      if (typeof params.data === 'string') {
        const frame: HostPageFrame = { data: params.data, width: Math.round(metadata?.deviceWidth ?? 0), height: Math.round(metadata?.deviceHeight ?? 0) }
        for (const subscription of [...this.subscriptions]) subscription.deliver(frame)
        if (Date.now() - this.lastFrameRefresh >= 500) { this.lastFrameRefresh = Date.now(); this.refresh() }
      }
      if (typeof session === 'number') void this.send('Page.screencastFrameAck', { sessionId: session }).catch(() => undefined)
      return
    }
    if (method === 'Fetch.requestPaused') {
      const requestId = params.requestId as string
      const request = params.request as { url?: string } | undefined
      if (safeBrowserUrl(request?.url ?? '')) { void this.send('Fetch.continueRequest', { requestId }).catch(() => undefined); return }
      void this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined)
      if (params.frameId === this.mainFrame) this.issue(PAGE_BLOCKED, false)
      return
    }
    if (method === 'Page.frameNavigated') {
      const frame = params.frame as { id?: string; parentId?: string; url?: string; urlFragment?: string } | undefined
      if (!frame) return
      if (frame.parentId) { this.blankUnsafeFrame(frame.id, frame.url ?? ''); return }
      this.mainFrame = frame.id ?? this.mainFrame
      const url = safeBrowserUrl(`${frame.url ?? ''}${frame.urlFragment ?? ''}`)
      if (url && url !== this.current.url) this.update({ url })
      this.refresh()
      return
    }
    if (method === 'Page.navigatedWithinDocument') {
      if (params.frameId !== this.mainFrame) return
      const url = safeBrowserUrl(typeof params.url === 'string' ? params.url : '')
      if (url) this.update({ url, status: 'ready' })
      this.refresh()
      return
    }
    if (method === 'Page.frameStartedLoading' && params.frameId === this.mainFrame) {
      if (this.current.status !== 'loading') this.update({ status: 'loading', error: null })
      return
    }
    if (method === 'Page.domContentEventFired') { this.refresh(); return }
    if (method === 'Page.loadEventFired' || (method === 'Page.frameStoppedLoading' && params.frameId === this.mainFrame)) {
      if (this.current.status === 'loading') this.update({ status: 'ready' })
      this.refresh()
      return
    }
    if (method === 'Inspector.targetCrashed') this.issue(PAGE_STOPPED, true)
  }

  /**
   * A frame that reached a document other than http, https or a blank one goes blank, as the desktop's browser refuses
   * it. DevTools' request interception never sees a `data:` document, so this is the barrier for one; it acts once the
   * frame has arrived, where the desktop's acts before.
   */
  private blankUnsafeFrame(frameId: string | undefined, url: string): void {
    if (!frameId || safeBrowserUrl(url) || url === 'about:blank' || url === 'about:srcdoc') return
    void this.send('Page.navigate', { url: 'about:blank', frameId }).catch(() => undefined)
  }
  private async history(): Promise<void> {
    const history = await this.send('Page.getNavigationHistory').catch(() => null) as { currentIndex: number; entries: { url?: string; title?: string }[] } | null
    if (!history || this.ended) return
    // The blank page a new page starts on is not somewhere to go back to, as on the desktop.
    const first = history.entries.findIndex(entry => safeBrowserUrl(entry.url ?? '') !== null)
    const canGoBack = first !== -1 && history.currentIndex > first, canGoForward = history.currentIndex < history.entries.length - 1
    const title = pageTitle(history.entries[history.currentIndex]?.title ?? '', this.current.url)
    if (canGoBack !== this.current.canGoBack || canGoForward !== this.current.canGoForward || title !== this.current.title) this.update({ canGoBack, canGoForward, title })
  }

  private update(change: Partial<HostPageState>): void {
    if (this.ended) return
    this.current = { ...this.current, ...change }
    for (const listener of [...this.changeListeners]) listener(this.current)
  }
}

/**
 * A host page's automation. Pictures stay as Chromium returned them, since a host has no image library: the agent's
 * capture is the PNG, and the smaller evidence and thumbnail pictures are Chromium's own JPEGs at a smaller scale,
 * drawn a moment after the capture rather than made from it.
 */
export class HostPageAutomation extends PageAutomation {
  constructor(debuggerFor: PageDebugger, private readonly host: HostBrowserPage) { super(debuggerFor) }
  /** An agent's click, typing or scroll can change the title with no event for it, so the page reads it again. */
  override async input(action: PageInput, guard: () => void): Promise<void> {
    try { await super.input(action, guard) } finally { this.host.refresh() }
  }
  protected picture(frame: PageFrame): PagePicture {
    return { empty: frame.data.length === 0 || frame.width === 0 || frame.height === 0, width: frame.width, height: frame.height, dataUrl: `data:image/${frame.format};base64,${frame.data}` }
  }
  /** The evidence pictures the desktop keeps for a task (`EVIDENCE_PICTURES`), asked of Chromium. */
  async evidence(capture: BrowserCapture): Promise<PageEvidence | null> {
    if (this.host.closed || !capture.width) return null
    for (const step of EVIDENCE_PICTURES) {
      const frame = await this.snapshot(undefined, { format: 'jpeg', quality: step.quality, scale: Math.min(1, step.width / capture.width) }).catch(() => null)
      if (!frame) return null
      const image = `data:image/jpeg;base64,${frame.data}`
      if (image.length <= EVIDENCE_LIMIT) return { image, width: capture.width, height: capture.height }
    }
    return null
  }
  /** A JPEG of the page 320 wide, as the desktop's task thumbnail. */
  async thumbnail(): Promise<string | null> {
    if (this.host.closed) return null
    const layout = await this.host.send('Page.getLayoutMetrics').catch(() => null) as { cssVisualViewport?: { clientWidth?: number } } | null
    const width = layout?.cssVisualViewport?.clientWidth
    if (!width) return null
    const frame = await this.snapshot(undefined, { format: 'jpeg', quality: 65, scale: Math.min(1, 320 / width) }).catch(() => null)
    return frame ? `data:image/jpeg;base64,${frame.data}` : null
  }
}
