import { randomUUID } from 'node:crypto'
import { BROWSER_WAITING_TO_OPEN, safeBrowserUrl, type BrowserPage } from '../../shared/browser'
import { BrowserTasks, type BrowserCreateRequest, type BrowserTaskDependencies, type BrowserTaskWords, type TaskPage } from '../../main/tools/browserTasks'
import { fail, parse } from '../../main/tools/common'
import { toolListRequestSchema } from '../../shared/tools'
import { browserInputSchema, browserWatchSchema, type HostBrowserFrame } from '../../shared/hostBrowser'
import { HostBrowserMissing, NO_HOST_BROWSER, type HostBrowser, type HostBrowserPage, type HostPageAutomation, type HostPageState } from './hostBrowser'

/** `seen`: the page's state as last heard from the browser, so a change is told apart from what Sotto set itself. */
interface HostPageRecord extends TaskPage {
  readonly host: HostBrowserPage
  readonly automation: HostPageAutomation
  seen: HostPageState
}

export interface HostBrowserServiceDependencies extends Omit<BrowserTaskDependencies, 'words' | 'byDefault'> {
  readonly browser: HostBrowser
  /** The last **Let agents use the browser without asking** a desktop sent, as the host's settings file holds it. */
  readonly withoutAsking: boolean
  /** Keeps a new value of the setting in the host's settings file (ADR-0198, decision 3). */
  saveWithoutAsking(value: boolean): Promise<void>
}

/** The host's words for the window: plain English, since a host carries no translations. */
const HOST_WORDS: BrowserTaskWords = {
  openFirst: 'Answer the request to open this page first.',
  finished: 'This browser task has finished.',
  changedOrExpired: 'This browser request changed or expired. Ask the agent to try again.',
  grantNeedsAllow: 'Only an allowed action can be granted for the whole thread. Answer this one once.',
  stillRunning: 'A browser action is still running.',
}
const NOT_STARTED = 'Sotto couldn\'t start the browser on the machine this thread runs on. Nothing was opened. Try again.'

/**
 * Sotto's browser for a paired host's own threads (ADR-0198): the desktop's rules for tasks, the grant, the waiting
 * request and sharing (`BrowserTasks`), over pages in the host's own headless Chromium. A workspace's pages share one
 * browser context. The grant lives in the host's memory and ends when the host's Sotto stops.
 */
export class HostBrowserService extends BrowserTasks<HostPageRecord> {
  /** `saved`: the value the settings file holds, so a save that failed is tried again by the next send of the same value. */
  private readonly setting: { withoutAsking: boolean; saved: boolean }
  constructor(private readonly dependencies: HostBrowserServiceDependencies) {
    const setting = { withoutAsking: dependencies.withoutAsking, saved: dependencies.withoutAsking }
    super({ files: dependencies.files, emit: event => dependencies.emit(event), byDefault: () => setting.withoutAsking, words: () => HOST_WORDS,
      ...dependencies.filePages ? { filePages: dependencies.filePages } : {} })
    this.setting = setting
  }

  /** What this host holds for **Let agents use the browser without asking** now. */
  get withoutAsking(): boolean { return this.setting.withoutAsking }
  /**
   * A desktop sent its **Let agents use the browser without asking**: every thread here learns its grant again, as on
   * the desktop when the setting changes, and the host keeps the value for a restart with no desktop connected.
   */
  async setWithoutAsking(value: boolean): Promise<void> {
    if (value !== this.setting.withoutAsking) {
      this.setting.withoutAsking = value
      this.settingChanged()
    }
    if (value === this.setting.saved) return
    await this.dependencies.saveWithoutAsking(value)
    this.setting.saved = value
  }

  /** Whether this host has a browser for the thread's pages, without starting it (ADR-0198, decision 2). */
  available(payload: unknown) { return this.run(async () => {
    const request = parse(toolListRequestSchema, payload)
    await this.owner(request.threadId, request.workspaceId)
    return { available: await this.dependencies.browser.available() }
  }) }
  /** The user's own click, key, typed text or scroll from a desktop's pane. It needs no grant: it is the user acting. */
  input(payload: unknown) { return this.run(async () => {
    const request = parse(browserInputSchema, payload)
    const record = await this.owned(request)
    await record.host.input(request.input)
  }) }
  /**
   * Pictures of the page for a desktop's pane until the returned stop, newest first (ADR-0198, decision 5). The page lays
   * out at the pane's size, as a page on this computer takes the size of the pane that shows it.
   */
  watch(payload: unknown, deliver: (frame: HostBrowserFrame) => void) { return this.run(async () => {
    const request = parse(browserWatchSchema, payload)
    const record = await this.owned(request)
    await record.host.resize(request.size).catch(() => undefined)
    return record.host.watch(request.size, frame => deliver({ pageId: record.page.id, ...frame }))
  }) }

  protected async createPage(request: BrowserCreateRequest, initial = false): Promise<BrowserPage> {
    const owner = await this.owner(request.threadId, request.workspaceId)
    if (this.disposed) return fail('unavailable', 'Browser is shutting down.')
    if (this.pages.size >= 32) return fail('busy', 'Close a browser page before opening another (32 maximum).')
    if (request.device === 'iphone') return fail('unavailable', 'The test iPhone isn\'t available to a thread on a paired host yet. Nothing was opened.')
    let host: HostBrowserPage
    try { host = await this.dependencies.browser.open(owner.workspaceId) }
    catch (error) { return fail('unavailable', error instanceof HostBrowserMissing ? NO_HOST_BROWSER : NOT_STARTED) }
    if (this.disposed) { await host.close(); return fail('unavailable', 'Browser is shutting down.') }
    const record: HostPageRecord = { host, automation: host.automation, seen: host.state, generation: 0, initial, madePrivate: false,
      page: { id: randomUUID(), workspace: owner, url: request.url, title: '', status: 'loading', error: null, canGoBack: false, canGoForward: false, sharedOrigin: null, viewport: null, device: null } }
    this.pages.set(record.page.id, record)
    host.onChange(state => this.changed(record, state))
    host.onClose(() => this.gone(record))
    if (!initial) { this.load(record, request.url); this.shareByGrant(record) }
    else record.page.error = BROWSER_WAITING_TO_OPEN
    return this.publish(record)
  }
  /**
   * The browser told us something about the page. A navigation starting lapses what waited on the old document, as
   * on the desktop; a new address in the main frame moves the page there, and its sharing follows or ends.
   */
  private changed(record: HostPageRecord, state: HostPageState): void {
    const seen = record.seen
    record.seen = state
    if (!this.pages.has(record.page.id)) return
    if (state.status === 'loading' && seen.status !== 'loading') {
      this.invalidate(record)
      record.generation++
      record.automation.clear()
    }
    if (state.url !== seen.url && safeBrowserUrl(state.url) && state.url !== record.page.url) this.moved(record, state.url)
    if (state.status !== seen.status) record.page.status = state.status
    if (state.error !== seen.error) record.page.error = state.error
    if (state.title !== seen.title) record.page.title = state.title
    this.publish(record)
  }
  /** The page closed on its own, or with the browser: its tasks end and the window hears it closed. */
  private gone(record: HostPageRecord): void {
    if (this.pages.get(record.page.id) !== record) return
    this.endTasks(record)
    this.pages.delete(record.page.id); record.generation++
    if (!this.disposed) this.dependencies.emit({ type: 'closed', threadId: record.page.workspace.threadId, workspaceId: record.page.workspace.workspaceId, pageId: record.page.id })
  }
  protected async destroy(record: HostPageRecord): Promise<void> {
    this.endTasks(record)
    record.automation.dispose()
    this.pages.delete(record.page.id); record.generation++
    await record.host.close()
  }
  protected startLoading(record: HostPageRecord, url: string): void { void record.host.navigate(url).catch(() => undefined) }
  protected isGone(record: HostPageRecord): boolean { return record.host.closed }
  protected loadedUrl(record: HostPageRecord): string { return record.host.state.url }
  protected async step(record: HostPageRecord, direction: 'back' | 'forward'): Promise<void> {
    if (direction === 'back') await record.host.back()
    else await record.host.forward()
  }
  /** A host's page has no Point at something yet (ADR-0198, decision 7), so nothing outlives its document. */
  protected pageLeft(): void { /* Nothing kept per document. */ }
  protected readPage(record: HostPageRecord): void {
    if (!record.host.closed) { record.page.canGoBack = record.host.state.canGoBack; record.page.canGoForward = record.host.state.canGoForward }
  }

  /** The host's Sotto is stopping: every page closes, every grant ends, and the browser's profile is deleted. */
  async shutDown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const closing = [...this.pages.values()].map(record => this.destroy(record).catch(() => undefined))
    this.disposeTasks()
    await Promise.all(closing)
    await this.dependencies.browser.dispose()
  }
}
