import { randomUUID } from 'node:crypto'
import { browserAgentActionSchema, browserAgentOpenSchema, browserAnswerActionSchema, browserControlTaskSchema, browserCreateSchema, browserFinishTaskSchema, browserNavigateSchema, browserRequestSchema, browserShareSchema, browserStartTaskSchema, browserTaskRequestSchema, safeBrowserUrl, type BrowserAction, type BrowserAgentResult, type BrowserCapture, type BrowserEvent, type BrowserPage, type BrowserTask } from '../../shared/browser'
import { toolListRequestSchema, toolTargetSchema } from '../../shared/tools'
import type { FileWorkspace } from '../../shared/files'
import type { FilesService } from '../files/service'
import { BrowserGrants, grantCovers } from './browserGrants'
import { ToolOperations, fail, parse, workspace } from './common'
import type { PageAutomation } from './pageAutomation'
import { ThreadFilePages } from './threadFilePages'

type TargetedAction = Extract<BrowserAction, { type: 'click' | 'type' | 'tap' | 'key' }>
export const targeted = (action: BrowserAction): action is TargetedAction => action.type === 'click' || action.type === 'type' || action.type === 'tap' || action.type === 'key'
/** The shortest a swipe may move, so a tap is asked for as a tap. */
const SWIPE_MINIMUM = 24

export type BrowserCreateRequest = ReturnType<typeof browserCreateSchema.parse>
export type BrowserOpenRequest = BrowserCreateRequest & { description: string }

/** One page as the task engine sees it, whichever browser draws it. `madePrivate`: the user pressed Stop sharing. */
export interface TaskPage {
  page: BrowserPage
  generation: number
  initial: boolean
  madePrivate: boolean
  readonly automation: PageAutomation
}

/** What the engine says to the user in the window, in the words of the process that owns the browser. */
export interface BrowserTaskWords {
  /** Share pressed on a page an agent asked to open, before the user answered. */
  readonly openFirst: string
  readonly finished: string
  readonly changedOrExpired: string
  readonly grantNeedsAllow: string
  readonly stillRunning: string
}

export interface BrowserTaskDependencies {
  readonly files: Pick<FilesService, 'resolveWorkspace' | 'hasThread'>
  emit(event: BrowserEvent): void
  /** The live **Let agents use the browser without asking** setting (ADR-0029). */
  byDefault(): boolean
  /** Where a thread's own HTML files are served for its agent to open (ADR-0085's October 27 amendment); one is made when absent. */
  readonly filePages?: ThreadFilePages
  /** Read at each refusal, so the window's language is the one it is in now. */
  words(): BrowserTaskWords
}

/**
 * Browser tasks, the browser grant, the waiting request and sharing (ADR-0020, ADR-0029), whichever browser draws the
 * pages: Electron's on this computer, or a paired host's own Chromium (ADR-0198). A subclass owns its pages' browser:
 * making and closing them, loading an address and stepping through history. Everything an agent or the user may do
 * with a task, and what that needs, is decided here once.
 */
export abstract class BrowserTasks<R extends TaskPage> extends ToolOperations {
  protected readonly pages = new Map<string, R>()
  protected readonly taskRecords = new Map<string, BrowserTask>()
  private readonly pending = new Map<string, { generation: number; url: string; initial: boolean; target?: string }>()
  protected readonly executing = new Set<string>()
  private readonly taskListeners = new Set<() => void>()
  /** Per-thread browser grants: on by default, until the user stops one or turns the setting off (ADR-0029). */
  private readonly grants: BrowserGrants
  /** Threads Tools has listed, so a change of the setting reaches a thread with no page yet. */
  private readonly listed = new Set<string>()
  protected readonly filePages: ThreadFilePages

  constructor(private readonly base: BrowserTaskDependencies) {
    super()
    this.grants = new BrowserGrants(() => base.byDefault())
    this.filePages = base.filePages ?? new ThreadFilePages({ live: threadId => base.files.hasThread(threadId) })
  }

  /** Makes a page for the thread and records it in `pages`. `initial`: an agent asked for it, and it waits to load until it may. */
  protected abstract createPage(request: BrowserCreateRequest, initial?: boolean): Promise<BrowserPage>
  /** Closes the page and forgets it; it calls `endTasks` first. */
  protected abstract destroy(record: R): Promise<void>
  /** Has the page's browser load `url`; `generation` is the load's, so a late failure of an earlier one is ignored. */
  protected abstract startLoading(record: R, url: string, generation: number): void
  protected abstract isGone(record: R): boolean
  /** The address the page's document is at now, as its browser reports it. */
  protected abstract loadedUrl(record: R): string
  /** Brings the page's record up to date with its browser and tells the window. */
  protected abstract publish(record: R): BrowserPage
  protected abstract step(record: R, direction: 'back' | 'forward'): void | Promise<void>
  /** The page navigated or stopped being shared: whatever the subclass keeps for the old page (Point at something) ends. */
  protected abstract pageLeft(record: R, reason: 'navigated' | 'hidden'): void

  /** The thread's working copy. A thread Sotto no longer lists takes its browser grant with it. */
  protected async owner(threadId: string, expected?: string): Promise<FileWorkspace> {
    try { return await workspace(this.base.files, threadId, expected) }
    catch (error) {
      if ((error as { code?: string }).code === 'thread-unavailable') this.forgetThread(threadId)
      throw error
    }
  }
  private grantView(threadId: string): { grantedAt: number; source: 'settings' | 'user' } | null {
    const grant = this.grants.active(threadId)
    return grant ? { grantedAt: grant.grantedAt, source: grant.source } : null
  }
  private forgetThread(threadId: string): void {
    const had = this.grants.active(threadId) !== null
    this.grants.forget(threadId); this.listed.delete(threadId); this.filePages.forget(threadId)
    if (had && !this.disposed) this.base.emit({ type: 'browser-grant', threadId, grant: null })
  }
  list(payload: unknown) { return this.run(async () => {
    const request = parse(toolListRequestSchema, payload)
    const owner = await this.owner(request.threadId, request.workspaceId)
    this.listed.add(owner.threadId)
    return { workspace: owner, pages: [...this.pages.values()].filter(record => record.page.workspace.workspaceId === owner.workspaceId && record.page.workspace.threadId === owner.threadId).map(record => ({ ...record.page })), grant: this.grantView(owner.threadId) }
  }) }
  /** The user's Stop: the thread asks again, whichever its grant's source. Always allowed, even for a thread that has gone. */
  stopGrant(payload: unknown) { return this.run(async () => {
    const request = parse(toolTargetSchema, payload)
    if (this.grants.stop(request.threadId) && !this.disposed) this.base.emit({ type: 'browser-grant', threadId: request.threadId, grant: null })
  }) }
  /** The setting changed; every thread this service still holds pages or tasks for learns its grant again. */
  settingChanged(): void {
    if (this.disposed) return
    const threads = new Set([...this.pages.values()].map(record => record.page.workspace.threadId))
    for (const task of this.taskRecords.values()) threads.add(task.threadId)
    for (const threadId of [...this.grants.threads(), ...this.listed]) threads.add(threadId)
    for (const threadId of threads) {
      const grant = this.grantView(threadId)
      this.base.emit({ type: 'browser-grant', threadId, grant })
      // Turning the setting on shares the thread's pages and answers what was already waiting, as "Allow this thread to use the browser" does.
      if (grant) { this.shareThreadPages(threadId); void this.performWaitingActions(threadId).catch(() => undefined) }
    }
  }
  /**
   * While its thread has a browser grant, a page is shared with that thread the moment it opens, whoever opened it,
   * unless the user made it private (ADR-0029, October 5 amendment). Returns whether this made the page shared.
   */
  protected shareByGrant(record: R): boolean {
    if (record.initial || record.madePrivate || record.page.sharedOrigin || !this.grants.active(record.page.workspace.threadId)) return false
    const url = safeBrowserUrl(record.page.url)
    if (!url) return false
    record.page.sharedOrigin = new URL(url).origin
    record.automation.observe()
    return true
  }
  /** A grant was given: the thread's pages the user has not made private are shared now, not only the next ones. */
  private shareThreadPages(threadId: string): void {
    for (const record of this.pages.values()) if (record.page.workspace.threadId === threadId && this.shareByGrant(record)) this.publish(record)
  }
  /**
   * The page is moving to `url`. While its thread has a browser grant, a shared page stays shared as it goes to
   * another site, a server's redirect included. Without one, sharing ends at the origin it was given for.
   */
  private followSharing(record: R, url: string): void {
    const origin = new URL(url).origin
    if (!record.page.sharedOrigin || record.page.sharedOrigin === origin) return
    if (this.grants.active(record.page.workspace.threadId)) record.page.sharedOrigin = origin
    else this.revoke(record)
  }
  /** The page's main frame is moving to `url`: what waited on the old page lapses, and its sharing follows or ends. */
  protected moved(record: R, url: string): boolean {
    const safe = safeBrowserUrl(url)
    if (!safe) return false
    this.pageLeft(record, 'navigated')
    this.invalidate(record)
    record.generation++
    this.followSharing(record, safe)
    record.page.url = safe
    return true
  }
  create(payload: unknown) { return this.run(async () => this.createPage(parse(browserCreateSchema, payload))) }
  protected load(record: R, url: string): void {
    this.pageLeft(record, 'navigated')
    this.invalidate(record)
    record.automation.clear()
    this.followSharing(record, url)
    record.page.url = url; record.page.status = 'loading'; record.page.error = null
    this.startLoading(record, url, ++record.generation)
  }
  protected async owned(request: ReturnType<typeof browserRequestSchema.parse>, validateDirectory = true): Promise<R> {
    const record = this.pages.get(request.pageId)
    if (!record || record.page.workspace.threadId !== request.threadId || record.page.workspace.workspaceId !== request.workspaceId) return fail('page-unavailable', 'This page belongs to another workspace or was closed.')
    if (validateDirectory) await this.owner(request.threadId, request.workspaceId)
    if (this.disposed || !this.pages.has(request.pageId) || this.isGone(record)) return fail('page-unavailable', 'This browser page has closed.')
    return record
  }
  navigate(payload: unknown) { return this.run(async () => {
    const request = parse(browserNavigateSchema, payload)
    const record = await this.owned(request)
    record.initial = false
    this.load(record, request.url)
    // A page the user loads is the user's own now: under the grant it is shared like any other (ADR-0029).
    this.shareByGrant(record)
    return this.publish(record)
  }) }
  private history(payload: unknown, action: 'back' | 'forward' | 'reload') { return this.run(async () => {
    const record = await this.owned(parse(browserRequestSchema, payload))
    if (action === 'reload') { record.initial = false; this.load(record, record.page.url); this.shareByGrant(record) }
    else await this.step(record, action)
    return this.publish(record)
  }) }
  back(payload: unknown) { return this.history(payload, 'back') }
  forward(payload: unknown) { return this.history(payload, 'forward') }
  reload(payload: unknown) { return this.history(payload, 'reload') }
  close(payload: unknown) { return this.run(async () => {
    const request = parse(browserRequestSchema, payload)
    const record = await this.owned(request, false)
    await this.destroy(record)
    this.base.emit({ type: 'closed', ...request })
  }) }
  /** The page is closing: its unfinished tasks fail and what waited on it lapses. */
  protected endTasks(record: R): void {
    for (const task of this.taskRecords.values()) if (task.pageId === record.page.id && ['working', 'paused'].includes(task.status)) {
      task.status = 'failed'; task.summary = 'This browser page closed.'; task.output = null; task.thumbnail = null; task.evidence = []; this.publishTask(task)
    }
    this.invalidate(record)
  }
  private publishTask(task: BrowserTask): BrowserTask {
    task.updatedAt = Date.now()
    const result = structuredClone(task)
    if (!this.disposed) this.base.emit({ type: 'task', task: result })
    for (const listener of this.taskListeners) listener()
    return result
  }
  private revoke(record: R): void {
    record.page.sharedOrigin = null
    this.invalidate(record)
    this.pageLeft(record, 'hidden')
    record.automation.dispose()
    for (const task of this.taskRecords.values()) if (task.pageId === record.page.id) {
      task.output = null; task.thumbnail = null; task.evidence = []; this.publishTask(task)
    }
  }
  protected invalidate(record: R): void {
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
  private shared(record: R): void {
    const actual = safeBrowserUrl(this.loadedUrl(record))
    if (!actual || !record.page.sharedOrigin || record.page.sharedOrigin !== new URL(record.page.url).origin || record.page.sharedOrigin !== new URL(actual).origin) fail('blocked', 'Ask the user to share this browser page before inspecting or interacting with it.')
  }
  private begin(record: R, description: string): BrowserTask {
    if ([...this.taskRecords.values()].some(task => task.pageId === record.page.id && ['working', 'paused'].includes(task.status))) return fail('busy', 'Finish this page\'s current browser task first.')
    if (this.taskRecords.size >= 64) {
      const oldest = [...this.taskRecords.values()].find(task => ['completed', 'failed'].includes(task.status))
      if (!oldest) return fail('busy', 'Finish a browser task before starting another.')
      this.taskRecords.delete(oldest.id)
    }
    const task: BrowserTask = { id: randomUUID(), threadId: record.page.workspace.threadId, workspaceId: record.page.workspace.workspaceId, pageId: record.page.id, status: 'working', description, updatedAt: Date.now(), steps: [], thumbnail: null, summary: null, unchecked: [], pendingAction: null, output: null, evidence: [], device: record.page.device ?? null }
    this.taskRecords.set(task.id, task)
    return this.publishTask(task)
  }
  tasks(payload: unknown) { return this.run(async () => {
    const request = parse(toolListRequestSchema, payload)
    const owner = await this.owner(request.threadId, request.workspaceId)
    const tasks = [...this.taskRecords.values()].filter(task => task.threadId === owner.threadId && task.workspaceId === owner.workspaceId)
    for (const task of tasks) if (task.pendingAction && task.pendingAction.expiresAt < Date.now()) {
      task.pendingAction = null; this.pending.delete(task.id); task.output = 'This browser action expired. Request it again.'; this.publishTask(task)
    }
    return structuredClone(tasks)
  }) }
  share(payload: unknown) { return this.run(async () => {
    const request = parse(browserShareSchema, payload)
    const record = await this.owned(request)
    if (request.enabled && record.initial) return fail('blocked', this.base.words().openFirst)
    record.page.sharedOrigin = request.enabled ? new URL(record.page.url).origin : null
    record.madePrivate = !request.enabled
    if (request.enabled) record.automation.observe()
    if (!request.enabled) {
      // Detaching from the page turns its overlay off with it.
      this.pageLeft(record, 'hidden')
      record.automation.dispose()
      for (const task of this.taskRecords.values()) if (task.pageId === record.page.id) {
        if (task.status === 'working') task.status = 'paused'
        task.output = null; task.thumbnail = null; task.evidence = []; this.publishTask(task)
      }
      this.invalidate(record)
    }
    return this.publish(record)
  }) }
  startTask(payload: unknown) { return this.run(async () => {
    const request = parse(browserStartTaskSchema, payload)
    const record = await this.owned(request)
    this.shared(record)
    return this.begin(record, request.description)
  }) }
  agentOpen(payload: unknown) { return this.run(async (): Promise<BrowserAgentResult> => this.open(await this.agentRequest(payload))) }
  /**
   * What an agent asked to open, as an address: a web address as it is, or an HTML file in the thread's folder at the
   * loopback address Sotto serves it on (ADR-0085's October 27 amendment). Anything else is refused in words that say what
   * happened and what to do, and opens nothing.
   */
  protected async agentRequest(payload: unknown): Promise<BrowserOpenRequest> {
    const request = parse(browserAgentOpenSchema, payload)
    const url = safeBrowserUrl(request.url)
    if (url) return { ...request, url }
    const owner = await this.owner(request.threadId, request.workspaceId)
    const opening = await this.filePages.open(request.url, owner.threadId, owner.workingDirectory)
    if (!opening) return fail('invalid-request', 'Sotto\'s browser opens an http or https address without a user name or password, or an HTML file in this thread\'s folder. Nothing was opened.')
    if (!opening.ok) return fail('blocked', opening.message)
    return { ...request, url: opening.url }
  }
  protected async open(request: BrowserOpenRequest): Promise<BrowserAgentResult> {
    const page = await this.createPage(request, true)
    const record = this.pages.get(page.id)!
    const created = this.begin(record, request.description)
    const task = this.taskRecords.get(created.id)!
    return this.requestAction(record, task, { type: 'navigate', url: request.url })
  }
  private async requestAction(record: R, task: BrowserTask, action: BrowserAction): Promise<BrowserAgentResult> {
    if (task.pendingAction) return fail('busy', 'A browser action is waiting for the user. Read the task before requesting another action.')
    const generation = record.generation
    const target = targeted(action) ? await record.automation.target(action) : undefined
    this.working(task)
    if (generation !== record.generation || task.pendingAction) return fail('blocked', 'The page changed. Inspect it and request the action again.')
    if (!record.initial) this.shared(record)
    // A browser grant answers navigate, click and type exactly as the user's own one-time answer would (ADR-0029).
    if (grantCovers(action.type) && this.grants.active(record.page.workspace.threadId)) return this.perform(record, task, action, record.initial, target, true)
    const where = record.page.device ? `on the test iPhone at ${record.page.url}` : `on ${record.page.url}`
    const description = action.type === 'navigate' ? `${record.initial ? record.page.device ? 'Open this page on the test iPhone and share it with the thread' : 'Open and share this page with the thread' : 'Navigate this page'}: ${action.url}`
      : action.type === 'click' ? `Click at ${action.x}, ${action.y} ${where}` : action.type === 'tap' ? `Tap at ${action.x}, ${action.y} ${where}`
        : action.type === 'type' ? `Type ${JSON.stringify(action.text)} into the focused field ${where}` : action.type === 'key' ? `Press ${action.key} ${where}` : action.type
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
    if (request.action.type === 'viewport' && record.page.device) return fail('blocked', 'The test iPhone keeps its own size.')
    if (request.action.type === 'swipe' && Math.hypot(request.action.toX - request.action.x, request.action.toY - request.action.y) < SWIPE_MINIMUM) return fail('blocked', `A swipe must move at least ${SWIPE_MINIMUM} pixels. Use tap to tap.`)
    if (this.executing.has(record.page.id)) return fail('busy', 'A browser action is still running.')
    if (grantCovers(request.action.type)) return this.requestAction(record, task, request.action)
    if (task.pendingAction) return fail('busy', 'Answer the pending browser action first.')
    return this.perform(record, task, request.action)
  }) }
  controlTask(payload: unknown) { return this.run(async () => {
    const request = parse(browserControlTaskSchema, payload)
    await this.owned(request)
    const task = this.task(request)
    if (!['working', 'paused'].includes(task.status)) return fail('blocked', this.base.words().finished)
    task.status = request.control === 'pause' ? 'paused' : 'working'
    if (request.control === 'pause') { task.pendingAction = null; this.pending.delete(task.id) }
    return this.publishTask(task)
  }) }
  answerAction(payload: unknown) { return this.run(async () => {
    const request = parse(browserAnswerActionSchema, payload)
    const record = await this.owned(request)
    const task = this.task(request), pending = task.pendingAction, scope = this.pending.get(task.id)
    this.working(task)
    if (!pending || pending.id !== request.actionId || !scope || pending.expiresAt < Date.now() || scope.generation !== record.generation || scope.url !== record.page.url) return fail('blocked', this.base.words().changedOrExpired)
    if (request.forThread && !request.allow) return fail('blocked', this.base.words().grantNeedsAllow)
    if (this.executing.has(record.page.id)) return fail('busy', this.base.words().stillRunning)
    task.pendingAction = null; this.pending.delete(task.id)
    if (!request.allow) { task.output = 'The user declined this action.'; return this.publishTask(task) }
    const threadId = record.page.workspace.threadId
    if (request.forThread) {
      this.grants.grant(threadId)
      this.base.emit({ type: 'browser-grant', threadId, grant: this.grantView(threadId) })
      this.shareThreadPages(threadId)
    }
    try { return (await this.perform(record, task, pending.action, scope.initial, scope.target)).task }
    finally { if (request.forThread) await this.performWaitingActions(threadId) }
  }) }
  /**
   * The grant answers the thread's navigate, click and type requests that were already waiting when it was given,
   * not only later ones: they asked before the grant existed, and leaving them to wait out their expiry would
   * contradict it. Each still has to match the page it asked about; one that no longer does keeps asking, as it
   * would have.
   */
  private async performWaitingActions(threadId: string): Promise<void> {
    for (const task of [...this.taskRecords.values()]) {
      const pending = task.pendingAction, scope = this.pending.get(task.id), record = this.pages.get(task.pageId)
      if (task.threadId !== threadId || task.status !== 'working' || !pending || !grantCovers(pending.action.type) || !scope || !record || pending.expiresAt < Date.now()
        || scope.generation !== record.generation || scope.url !== record.page.url || this.executing.has(record.page.id) || !this.grants.active(threadId)) continue
      task.pendingAction = null; this.pending.delete(task.id)
      // One action failing is that task's own failed step; it does not undo the answer the user just gave.
      await this.perform(record, task, pending.action, scope.initial, scope.target, true).catch(() => undefined)
    }
  }
  private async perform(record: R, task: BrowserTask, action: BrowserAction, initial = false, approvedTarget?: string, granted = false): Promise<BrowserAgentResult> {
    if (this.executing.has(record.page.id)) return fail('busy', 'A browser action is still running.')
    this.executing.add(record.page.id)
    const generation = record.generation
    const observedUrl = action.type === 'navigate' ? action.url : record.page.url
    const guard = (checkGeneration = true): void => {
      this.working(task)
      if (checkGeneration && record.generation !== generation) fail('blocked', 'The page changed. Inspect it before trying again.')
      if (this.isGone(record) || !this.pages.has(record.page.id)) fail('page-unavailable', 'This page closed.')
      if (!initial) this.shared(record)
    }
    try {
      guard()
      if (targeted(action) && (!approvedTarget || await record.automation.target(action) !== approvedTarget)) fail('blocked', 'The target changed. Inspect the page and request the action again.')
      guard()
      let output = '', image: string | undefined, capture: BrowserCapture | undefined
      if (action.type === 'navigate') {
        record.initial = false
        // An agent's new page is shared by its Open and share answer, or by the browser grant that stands for it.
        if (initial) record.page.sharedOrigin = new URL(action.url).origin
        this.load(record, action.url)
        if (record.page.sharedOrigin) record.automation.observe()
        output = 'Navigation started. Inspect the page after it finishes loading.'
      } else if (action.type === 'inspect') output = await record.automation.inspect()
      else if (action.type === 'screenshot') { capture = await record.automation.capture(record.page.url); image = capture.image; output = JSON.stringify({ url: capture.url, width: capture.width, height: capture.height }) }
      else {
        await record.automation.input(action, guard)
        if (action.type === 'viewport') { record.page.viewport = { width: action.width, height: action.height }; this.publish(record) }
        output = `${action.type} completed.`
      }
      if (action.type !== 'navigate') guard(action.type === 'inspect' || action.type === 'screenshot')
      if (capture) {
        const evidence = await record.automation.evidence(capture)
        guard()
        if (evidence) task.evidence = [...(task.evidence ?? []), { id: randomUUID(), at: Date.now(), url: record.page.url, viewport: record.page.viewport ?? null, ...evidence }].slice(-3)
      }
      // Revocation during an asynchronous capture must not release page evidence.
      if (action.type !== 'navigate') guard(action.type === 'inspect' || action.type === 'screenshot')
      const thumbnail = action.type === 'navigate' ? null : await record.automation.thumbnail(image).catch(() => null)
      if (action.type !== 'navigate') guard(action.type === 'inspect' || action.type === 'screenshot')
      if (record.page.sharedOrigin && task.status === 'working') task.thumbnail = thumbnail
      task.output = output
      const grantNote = granted ? ' Not asked: you let this thread use the browser without asking.' : ''
      task.steps.push({ id: randomUUID(), action: action.type, status: 'completed', at: Date.now(), detail: action.type === 'type' ? `Entered text in the focused field.${grantNote}` : action.type === 'key' ? `Pressed ${action.key}.${grantNote}` : action.type === 'inspect' ? 'Inspected the page and recent console and network errors.' : granted ? `${output}${grantNote}` : output.slice(0, 2000), url: observedUrl, viewport: record.page.viewport ?? null })
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
  /** The browser is shutting down: every task, grant and served file goes, and every wait ends. Pages are the subclass's. */
  protected disposeTasks(): void {
    this.taskRecords.clear(); this.pending.clear()
    this.grants.clear()
    this.filePages.dispose()
    for (const listener of this.taskListeners) listener()
    this.taskListeners.clear()
  }
}
