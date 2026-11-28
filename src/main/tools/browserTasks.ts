import { randomUUID } from 'node:crypto'
import { BROWSER_OUTPUT_MAX, BROWSER_TITLE_MAX, PARITY_ONLY_ACTIONS, browserAgentActionSchema, browserAgentCloseSchema, browserAgentOpenSchema, browserAnswerActionSchema, browserControlTaskSchema, browserCreateSchema, browserDialogAnswerSchema, browserEmulateSchema, browserFinishTaskSchema, browserNavigateSchema, browserParityOpenSchema, browserRequestSchema, browserShareSchema, browserStableActionSchema, browserStartTaskSchema, browserTaskRequestSchema, parityOpenUrl, presetSize, safeBrowserUrl, type BrowserAction, type BrowserAgentResult, type BrowserCapture, type BrowserEvent, type BrowserPage, type BrowserTask } from '../../shared/browser'
import { toolListRequestSchema, toolTargetSchema } from '../../shared/tools'
import type { FileWorkspace } from '../../shared/files'
import type { FilesService } from '../files/service'
import { BrowserGrants, alwaysAsks, grantCovers } from './browserGrants'
import { uploadPaths, type BrowserFiles, type StagedUpload } from './browserFiles'
import { ToolFailure, ToolOperations, fail, parse, workspace } from './common'
import { SECRET_SPENT, isTargeted, type PageAutomation, type TargetedAction } from './pageAutomation'
import type { SecretSite } from '../../shared/secretRequests'
import { ThreadFilePages } from './threadFilePages'

const targeted = (action: BrowserAction): action is TargetedAction => isTargeted(action)
/** How long after the user's own click, key or wheel an agent's input waits (ADR-0220, decision 8). */
export const USER_ACTIVE_MS = 750
/** How long a navigation's readiness wait lasts when the agent names none. */
const NAVIGATION_WAIT_MS = 15_000
/** The actions that only read or wait, which a page in the user's hands still answers. */
const READS = new Set(['inspect', 'snapshot', 'screenshot', 'wait_for', 'record_stop'])
/** How long after an agent's action a download it set off still counts as the agent's (ADR-0222). */
export const AGENT_DOWNLOAD_MS = 3_000
/**
 * How far a swipe must travel. Shorter, Chromium reads it as a tap and clicks what it started on, and a swipe asks
 * nothing, so a short one would be a tap the browser grant never covered.
 */
const SWIPE_MINIMUM = 24
/**
 * Why a type stopped once its secretRef was spent, saying the reference is used (ADR-0219). The typing's own refusals
 * say so already; anything after it means the secret was typed and the action failed later.
 */
function spentWords(error: unknown): string {
  const words = error instanceof ToolFailure ? error.message : 'The browser action did not finish.'
  return words.includes(SECRET_SPENT) ? words : `${words} The secret was typed, and ${SECRET_SPENT}`
}
/** A failure once a secret request's value was taken: the agent's words say the reference is used (ADR-0219). */
class SecretSpent extends ToolFailure {}
/** The user's words for it, where the window gives none of its own: a host, which takes no secret, never says it. */
const SECRET_SPENT_FOR_USER = 'This action didn\'t finish, and the secret it was given can\'t be used again. If the agent still needs it, it will ask you for it again.'

const sizeOf = (preset: Parameters<typeof presetSize>[0], orientation?: Parameters<typeof presetSize>[1]): { width: number; height: number } => {
  const { width, height } = presetSize(preset, orientation)
  return { width, height }
}
export type BrowserCreateRequest = ReturnType<typeof browserCreateSchema.parse>
export type BrowserOpenRequest = BrowserCreateRequest & { description: string; background?: boolean | undefined }

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
  /** "Allow this thread" pressed for an action that asks every time, such as upload. */
  readonly asksEveryTime?: string
  /** An upload's copies changed between asking and Allow. */
  readonly filesChanged?: string
  /** A type the user allowed failed once its secret was taken: the secret cannot be used again. */
  readonly secretSpent?: string
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
  /**
   * A secret request's value for its one-use reference (ADR-0219), taken as it is typed and gone from Sotto once
   * typed; null when the reference is unknown, used, expired or another thread's. Absent, no secret is typed here.
   */
  secret?(threadId: string, ref: string): Promise<string | null>
  /**
   * The site a reference's card named, without using the reference: the value is typed only on a page at that origin,
   * and a card that named none asks the user every time. Null for a reference that is unknown, used, expired or another
   * thread's. Absent, every secret asks.
   */
  secretSite?(threadId: string, ref: string): Promise<SecretSite | null>
  /**
   * The full catalog (ADR-0220), from the `browser-parity` Owl answer read once at start. Off, its actions are refused
   * in words and pages behave exactly as before it.
   */
  readonly parity?: boolean
  /** Where screenshots and recordings an agent saves are kept (ADR-0220); absent, saving is refused in words. */
  readonly browserFiles?: BrowserFiles
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
  private readonly pending = new Map<string, { generation: number; url: string; initial: boolean; target?: string; staged?: StagedUpload }>()
  /** Upload copies a page was given, kept while it may still read them and deleted when it closes (ADR-0220, decision 5). */
  private readonly givenUploads = new Map<string, StagedUpload[]>()
  /**
   * When an agent's action that can set off a download last ended on each page, so the pane says a download it set off
   * is the agent's (ADR-0222). It says nothing of what the agent is told: that follows the page's sharing alone.
   */
  private readonly agentActedAt = new Map<string, number>()
  /** Pages running an agent's action that can set off a download: not one that only reads the page (`READS`). */
  private readonly acting = new Set<string>()
  /** Each page's timer for the end of the user's hold, moved on by every input (ADR-0220, decision 8). */
  private readonly userTimers = new Map<string, ReturnType<typeof setTimeout>>()
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
  /** Brings the page's record up to date with what its browser knows now: where it is, and whether it can go back or forward. */
  protected abstract readPage(record: R): void
  /** Starts recording the page to a video (ADR-0220); a browser that cannot record leaves it out. */
  protected startRecording?(record: R): Promise<void>
  /** Stops the page's recording and answers where the video is. */
  /** Stops a page's recording and keeps the video. `keep` holds its path for the agent's record_stop: the user stopped it. */
  protected stopRecordingOf?(record: R, keep?: boolean): Promise<string>
  /** Words added to an action's output about what it set off on the page since `since`, such as a download (ADR-0222). */
  protected actionNote?(record: R, since: number): string | undefined
  /** The last time the user's own click, key or wheel reached each page (ADR-0220, decision 8). */
  private readonly userInput = new Map<string, number>()
  /** Whether this browser offers the full catalog (ADR-0220). */
  protected get parity(): boolean { return this.base.parity === true }
  /**
   * Called by the subclass for each page it makes, before anything attaches to it: the page's automation learns the
   * catalog, and a dialog or file chooser opening or closing publishes the page.
   */
  protected track(record: R): void {
    record.automation.parity = this.parity
    record.automation.inProfile = Boolean(record.page.profile)
    record.automation.onChange = () => { if (this.pages.has(record.page.id) && !this.disposed) this.publish(record) }
  }
  /**
   * The user's own click, key press or wheel reached the page (ADR-0220, decision 8): for a moment an agent's input waits,
   * and the refs it holds are forgotten the first time, since the user may have moved things.
   */
  protected userUsed(record: R): void {
    if (!this.parity) return
    const was = this.userActive(record)
    this.userInput.set(record.page.id, Date.now())
    // Every input moves the hold's end, so the page is told free once the user has really stopped, not 750 ms after they began.
    const timer = this.userTimers.get(record.page.id)
    if (timer) clearTimeout(timer)
    this.userTimers.set(record.page.id, setTimeout(() => {
      this.userTimers.delete(record.page.id)
      if (this.pages.has(record.page.id) && !this.disposed && !this.userActive(record)) this.publish(record)
    }, USER_ACTIVE_MS + 20))
    if (was) return
    record.automation.forgetRefs()
    this.publish(record)
  }
  /** Whether a download that starts on this page now was set off by an agent's action (ADR-0222). */
  protected agentCaused(pageId: string): boolean {
    return this.acting.has(pageId) || Date.now() - (this.agentActedAt.get(pageId) ?? 0) < AGENT_DOWNLOAD_MS
  }
  /** What the engine keeps for a page goes with it. */
  private forgetPage(pageId: string): void {
    this.userInput.delete(pageId)
    this.agentActedAt.delete(pageId)
    const timer = this.userTimers.get(pageId)
    if (timer) clearTimeout(timer)
    this.userTimers.delete(pageId)
    for (const staged of this.givenUploads.get(pageId) ?? []) void this.base.browserFiles?.discard(staged)
    this.givenUploads.delete(pageId)
  }
  /** A waiting request is forgotten, and the upload copies it made with it unless the page was given them. */
  private forgetPending(taskId: string, given = false): void {
    const scope = this.pending.get(taskId)
    this.pending.delete(taskId)
    if (scope?.staged && !given) void this.base.browserFiles?.discard(scope.staged)
  }
  private userActive(record: R): boolean { return Date.now() - (this.userInput.get(record.page.id) ?? 0) < USER_ACTIVE_MS }
  protected abstract step(record: R, direction: 'back' | 'forward'): void | Promise<void>
  /** The page navigated or stopped being shared: whatever the subclass keeps for the old page (Point at something) ends. */
  protected abstract pageLeft(record: R, reason: 'navigated' | 'hidden'): void

  /** The page as it is now, told to the window while the page is still open. */
  protected publish(record: R): BrowserPage {
    this.readPage(record)
    if (this.parity) {
      record.page.dialog = record.automation.dialog()
      record.page.appearance = record.automation.colorScheme()
      record.page.userActive = this.userActive(record)
    }
    const page = this.view(record)
    if (!this.disposed && this.pages.has(record.page.id)) this.base.emit({ type: 'page', page })
    return page
  }
  /**
   * A page as it leaves the engine, for the window and the agent alike: a secret typed into it is masked in its title
   * and in its address after the origin, as a page that echoes it there, or a sign-in form sent by GET, would otherwise
   * pass it on (ADR-0219). Whether the agent may see the page is decided from the page itself, not this view
   * (`observable`).
   */
  private view(record: R): BrowserPage {
    return { ...record.page, url: record.automation.maskedUrl(record.page.url), title: record.automation.told(record.page.title, BROWSER_TITLE_MAX, 'title') }
  }
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
    return { workspace: owner, pages: [...this.pages.values()].filter(record => record.page.workspace.workspaceId === owner.workspaceId && record.page.workspace.threadId === owner.threadId).map(record => this.view(record)), grant: this.grantView(owner.threadId) }
  }) }
  /** Whether a page of the thread is shared with its agent now: not one the user made private, nor one never shared. */
  protected sharedNow(pageId: string, threadId: string): boolean {
    const record = this.pages.get(pageId)
    return record !== undefined && record.page.workspace.threadId === threadId && !record.madePrivate && record.page.sharedOrigin !== null
  }
  /**
   * Whether the thread's agent may see a page now: shared with it, and at the origin it was shared for. Decided here, from
   * the page's own address, and not from the masked view the agent is given, whose address can hold a mask (ADR-0219).
   */
  observable(pageId: string, threadId: string): boolean {
    if (!this.sharedNow(pageId, threadId)) return false
    const record = this.pages.get(pageId)!
    try { return record.page.sharedOrigin === new URL(record.page.url).origin } catch { return false }
  }
  /** `text` about a page, its address or title, with any secret typed into that page masked, as the agent is told it (ADR-0219). */
  masked(pageId: string, text: string): string { return this.pages.get(pageId)?.automation.masked(text) ?? text }
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
      // A thread Sotto no longer lists takes its grant with it, and nothing it left waiting runs (ADR-0029).
      if (!this.base.files.hasThread(threadId)) { this.forgetThread(threadId); continue }
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
    // A page in a browser profile is signed in as the user. Its sharing stays with the site the user shared, grant or
    // not: leaving that site makes the page private again, until the user shares it or answers an agent's navigate
    // there (ADR-0221, November 27 amendment).
    if (record.page.profile) { this.revoke(record); record.madePrivate = true; return }
    if (this.grants.active(record.page.workspace.threadId)) record.page.sharedOrigin = origin
    else this.revoke(record)
  }
  /**
   * Whether an action asks the user every time, whatever grant the thread holds: an upload (ADR-0220, decision 5), and an
   * agent's navigate that takes a page in a browser profile to another site (ADR-0221, November 27 amendment).
   */
  private asksEveryTime(record: R, action: BrowserAction): boolean {
    if (alwaysAsks(action.type)) return true
    if (action.type !== 'navigate' || !record.page.profile || record.initial) return false
    try { return new URL(action.url).origin !== record.page.sharedOrigin } catch { return true }
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
    this.forgetPage(record.page.id)
    this.base.emit({ type: 'closed', ...request })
  }) }
  /**
   * `browser_close` (ADR-0220): an agent closes a page it opened. A page the user opened stays the user's to close; a
   * recording on it stops and is kept.
   */
  agentClose(payload: unknown) { return this.run(async () => {
    this.fullBrowser()
    const request = parse(browserAgentCloseSchema, payload)
    const record = await this.owned(request, false)
    if (!record.page.agentOpened) return fail('blocked', 'This page was opened by the user, so it stays open. Finish your task on it instead.')
    // The user holding the page, by Take over, Stop sharing or using it now, keeps it open as it keeps out every other action.
    if ([...this.taskRecords.values()].some(task => task.pageId === record.page.id && task.status === 'paused')) return fail('blocked', 'The user took this page over, so it stays open. Wait until they hand it back.')
    if (!record.initial && (record.madePrivate || !record.page.sharedOrigin)) return fail('blocked', 'The user stopped sharing this page, so it stays open. Ask them to share it, or leave it to them.')
    if (this.parity && this.userActive(record)) return fail('busy', 'The user is using this page right now, so it stays open. Wait a moment, then try again.')
    if (this.executing.has(record.page.id)) return fail('busy', 'A browser action is still running.')
    const kept = record.page.recording && this.stopRecordingOf ? await this.stopRecordingOf(record).catch(() => null) : null
    await this.destroy(record)
    this.forgetPage(record.page.id)
    this.base.emit({ type: 'closed', ...request })
    return { closed: request.pageId, ...(kept ? { recording: kept } : {}) }
  }) }
  /** The pane's full-browser requests are refused, as the agent's are, while `browser-parity` is off (ADR-0220, decision 1). */
  protected fullBrowser(): void {
    if (!this.parity) fail('unavailable', 'The full browser is not on in this version of Sotto. Nothing was changed.')
  }
  /** The user answers the page's own dialog in the pane (ADR-0220): their action, so it needs no sharing or grant. */
  answerDialog(payload: unknown) { return this.run(async () => {
    this.fullBrowser()
    const request = parse(browserDialogAnswerSchema, payload)
    const record = await this.owned(request)
    await record.automation.answerDialog(request.accept, request.promptText)
    return this.publish(record)
  }) }
  /** The pane's colour scheme and device menus (ADR-0220): the user's own action on the page's emulation. */
  emulate(payload: unknown) { return this.run(async () => {
    this.fullBrowser()
    const request = parse(browserEmulateSchema, payload)
    const record = await this.owned(request)
    if (record.page.device) return fail('blocked', 'The test iPhone keeps its own size.')
    if (request.appearance !== undefined) await record.automation.emulateAppearance(request.appearance)
    if (request.preset) {
      await record.automation.input({ type: 'viewport', preset: request.preset, ...(request.orientation ? { orientation: request.orientation } : {}) }, () => { if (this.isGone(record)) fail('page-unavailable', 'This page closed.') })
      record.page.viewport = { ...sizeOf(request.preset, request.orientation), preset: request.preset, orientation: request.orientation ?? 'portrait' }
      record.generation++
      this.invalidate(record)
    }
    return this.publish(record)
  }) }
  /** The user's Stop on a recording an agent started: the video is kept where the agent was told. */
  stopRecording(payload: unknown) { return this.run(async () => {
    this.fullBrowser()
    const record = await this.owned(parse(browserRequestSchema, payload))
    if (record.page.recording && this.stopRecordingOf) await this.stopRecordingOf(record, true)
    return this.publish(record)
  }) }
  /** The page is closing: its unfinished tasks fail and what waited on it lapses. */
  protected endTasks(record: R): void {
    for (const task of this.taskRecords.values()) if (task.pageId === record.page.id && ['working', 'paused'].includes(task.status)) {
      task.status = 'failed'; task.summary = 'This browser page closed.'; task.output = null; task.thumbnail = null; task.evidence = []; this.publishTask(task)
    }
    this.invalidate(record)
    this.forgetPage(record.page.id)
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
    // The page is the user's again: a download that starts on it now is not the agent's, however lately it acted.
    this.agentActedAt.delete(record.page.id)
    this.invalidate(record)
    this.pageLeft(record, 'hidden')
    record.automation.dispose()
    for (const task of this.taskRecords.values()) if (task.pageId === record.page.id) {
      task.output = null; task.thumbnail = null; task.evidence = []; this.publishTask(task)
    }
  }
  protected invalidate(record: R): void {
    for (const task of this.taskRecords.values()) if (task.pageId === record.page.id && task.pendingAction) {
      task.pendingAction = null; this.forgetPending(task.id)
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
      task.pendingAction = null; this.forgetPending(task.id); task.output = 'This browser action expired. Request it again.'; this.publishTask(task)
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
      this.agentActedAt.delete(record.page.id)
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
  /** Whether an action is one this build offers: the full catalog's only with `browser-parity` on (ADR-0220). */
  private offered(action: unknown): void {
    if (this.parity) return
    const type = (action as { type?: unknown } | null)?.type
    if (typeof type === 'string' && PARITY_ONLY_ACTIONS.has(type)) fail('invalid-request', `This version of Sotto's browser has no ${type} action. Use inspect, screenshot, click, type, key, scroll or viewport.`)
    if (!browserStableActionSchema.safeParse(action).success) fail('invalid-request', 'This browser request is invalid. Use the tool\'s documented arguments.')
  }
  /**
   * What an agent asked to open, as an address: a web address as it is, or an HTML file in the thread's folder at the
   * loopback address Sotto serves it on (ADR-0085's October 27 amendment). Anything else is refused in words that say what
   * happened and what to do, and opens nothing.
   */
  protected async agentRequest(payload: unknown): Promise<BrowserOpenRequest> {
    const parsed = this.parity ? parse(browserParityOpenSchema, payload) : parse(browserAgentOpenSchema, payload)
    const request = { threadId: parsed.threadId, workspaceId: parsed.workspaceId, description: parsed.description, url: parityOpenUrl(parsed), ...('background' in parsed && parsed.background ? { background: true } : {}) }
    const url = safeBrowserUrl(request.url)
    if (url) return { ...request, url }
    const owner = await this.owner(request.threadId, request.workspaceId)
    const opening = await this.filePages.open(request.url, owner.threadId, owner.workingDirectory)
    if (!opening) return fail('invalid-request', 'Sotto\'s browser opens an http or https address without a user name or password, or an HTML file in this thread\'s folder. Nothing was opened.')
    if (!opening.ok) return fail('blocked', opening.message)
    return { ...request, url: opening.url }
  }
  protected async open(request: BrowserOpenRequest): Promise<BrowserAgentResult> {
    const { background, ...create } = request
    const page = await this.createPage(create, true)
    const record = this.pages.get(page.id)!
    record.page.agentOpened = true
    if (background) record.page.background = true
    const created = this.begin(record, request.description)
    const task = this.taskRecords.get(created.id)!
    if (background) task.background = true
    return this.requestAction(record, task, { type: 'navigate', url: request.url })
  }
  private async requestAction(record: R, task: BrowserTask, action: BrowserAction, staged?: StagedUpload): Promise<BrowserAgentResult> {
    let target: string | undefined
    // The site a secret reference is for, or null when its card named none; undefined for anything else.
    let secretFor: string | null | undefined
    try {
      if (task.pendingAction) return fail('busy', 'A browser action is waiting for the user. Read the task before requesting another action.')
      const generation = record.generation
      target = targeted(action) ? await record.automation.target(action) : undefined
      // Checked before anything is asked, and the reference is not used.
      if (action.type === 'type' && action.secretRef) secretFor = await this.secretSite(record, action.secretRef)
      this.working(task)
      if (generation !== record.generation || task.pendingAction) return fail('blocked', 'The page changed. Inspect it and request the action again.')
      if (!record.initial) this.shared(record)
    } catch (error) { if (staged) void this.base.browserFiles?.discard(staged); throw error }
    // A secret whose card named no site asks every time: only the user can say this page is where it goes.
    const everyTime = this.asksEveryTime(record, action) || secretFor === null
    // A browser grant answers navigate, click and type exactly as the user's own one-time answer would (ADR-0029).
    if (grantCovers(action.type) && !everyTime && this.grants.active(record.page.workspace.threadId)) return this.perform(record, task, action, record.initial, target, true)
    const description = record.automation.masked(this.describe(record, action, staged, secretFor))
    task.pendingAction = { id: randomUUID(), action, description, expiresAt: Date.now() + 5 * 60_000, ...(everyTime ? { everyTime: true } : {}) }
    this.pending.set(task.id, { generation: record.generation, url: record.page.url, initial: record.initial, ...(target ? { target } : {}), ...(staged ? { staged } : {}) })
    return { task: this.publishTask(task), approvalRequired: true }
  }
  /**
   * Where a secret reference may be typed (ADR-0219, decision 7): the site its card named, which must be this page's,
   * or null when the card named none, which asks the user every time. Refused in words for a reference that is
   * unknown, used or expired, and for a page on another site. The reference is not used.
   */
  private async secretSite(record: R, ref: string): Promise<string | null> {
    if (!this.base.secret) return fail('blocked', 'Secret references are typed only in Sotto\'s browser on this computer.')
    const site = this.base.secretSite ? await this.base.secretSite(record.page.workspace.threadId, ref) : { origin: null }
    if (!site) return fail('blocked', 'This secretRef is unknown, used or expired. Ask for it again with request_secret.')
    let here = ''
    try { here = new URL(record.page.url).origin } catch { /* Not a web address: no site matches it. */ }
    if (site.origin !== null && site.origin !== here) return fail('blocked', `This secret is for ${site.origin}, and this page is on ${here || 'no site'}, so nothing was typed. Open ${site.origin} and type it there.`)
    return site.origin
  }
  /**
   * No picture of a page whose document could show a typed secret goes to the agent (`showsSecret`): a page can show
   * what a password field holds, and a site can write the secret back into a later document. An open dialog is refused
   * first, by the capture, since it has to be answered before anything else, and the page is not read while one is open.
   */
  private async noPicture(record: R): Promise<void> {
    // The stable catalog reads a page with inspect; snapshot is the full catalog's (ADR-0220).
    if (!record.automation.dialog() && await record.automation.showsSecret()) fail('blocked', `This page holds a secret you saved, and a page can show what a password field holds, so no picture of it goes to you while it holds one. Use ${this.parity ? 'snapshot' : 'inspect'}, whose words are masked.`)
  }
  /** The pending request's words: what will happen, where, and for upload which files. */
  private describe(record: R, action: BrowserAction, staged?: StagedUpload, secretFor?: string | null): string {
    const where = record.page.device ? `on the test iPhone at ${record.page.url}` : `on ${record.page.url}`
    const at = (target: { x?: number | undefined; y?: number | undefined; ref?: string | undefined; selector?: string | undefined }): string =>
      target.ref ? `element ${target.ref}` : target.selector ? `the element ${JSON.stringify(target.selector)}` : `${target.x}, ${target.y}`
    switch (action.type) {
      case 'navigate': return `${record.initial ? record.page.device ? 'Open this page on the test iPhone and share it with the thread' : 'Open and share this page with the thread' : this.asksEveryTime(record, action) ? `Take this page, signed in with your ${record.page.profile?.name ?? 'browser'} profile, to another site and share it there` : 'Navigate this page'}: ${action.url}`
      case 'click': return `${action.clickCount === 2 ? 'Double-click' : action.clickCount === 3 ? 'Triple-click' : action.button === 'right' ? 'Right-click' : action.button === 'middle' ? 'Middle-click' : 'Click'} ${action.x !== undefined ? 'at ' : ''}${at(action)} ${where}`
      case 'tap': return `Tap at ${action.x}, ${action.y} ${where}`
      case 'type': {
        if (!action.secretRef) return `Type ${JSON.stringify(action.text)} into ${action.ref || action.selector ? at(action) : 'the focused field'} ${where}`
        const field = action.ref || action.selector ? `the password field ${at(action)}` : 'the focused password field'
        return secretFor ? `Type the secret you saved for ${secretFor} into ${field} ${where}` : `Type a secret you saved into ${field} ${where}. Its card named no site, so Sotto asks each time.`
      }
      case 'key': return `Press ${[...action.modifiers ?? [], action.key].join('+')} ${where}`
      case 'select': return `Choose ${action.values.map(value => JSON.stringify(value)).join(', ')} in ${at(action)} ${where}`
      case 'drag': return `Drag from ${at(action.from)} to ${at(action.to)} ${where}`
      case 'upload': return action.paths.length
        ? `Give ${record.page.url} ${action.paths.length === 1 ? 'a copy of this file' : `copies of these ${action.paths.length} files`}, made when the agent asked: ${(staged?.files ?? []).map(file => `${file.name} (${file.source})`).join(', ') || action.paths.join(', ')}`
        : `Cancel the page's file chooser ${where}`
      case 'evaluate': return `Run this script in the page ${where}: ${action.expression.slice(0, 600)}${action.expression.length > 600 ? '…' : ''}`
      case 'dialog': return `${action.accept ? 'Accept' : 'Dismiss'} the page's dialog${action.promptText !== undefined ? ` with ${JSON.stringify(action.promptText)}` : ''} ${where}`
      default: return action.type
    }
  }
  action(payload: unknown) { return this.run(async (): Promise<BrowserAgentResult> => {
    const request = parse(browserAgentActionSchema, payload)
    this.offered((payload as { action?: unknown }).action)
    const record = await this.owned(request)
    const task = this.task(request)
    this.working(task)
    if (request.action.type !== 'navigate' || !record.initial) this.shared(record)
    if (request.action.type === 'viewport' && record.page.device) return fail('blocked', 'The test iPhone keeps its own size.')
    if (request.action.type === 'swipe' && Math.hypot(request.action.toX - request.action.x, request.action.toY - request.action.y) < SWIPE_MINIMUM) return fail('blocked', `A swipe must move at least ${SWIPE_MINIMUM} pixels. Use tap to tap.`)
    if (this.executing.has(record.page.id)) return fail('busy', 'A browser action is still running.')
    if (request.action.type === 'upload') {
      if (request.action.paths.length === 0) return this.requestAction(record, task, request.action)
      // Checked, then copied into Sotto's own folder before asking: the user is asked about those copies, and only they
      // are given, so changing or relinking the files meanwhile changes nothing (ADR-0220, decision 5).
      const files = this.base.browserFiles ?? fail('unavailable', 'Giving a page files is not available here.')
      const owner = await this.owner(request.threadId, request.workspaceId)
      const checked = await uploadPaths(request.action.paths, owner.workingDirectory, files.folder(owner.threadId))
      if (!checked.ok) return fail('blocked', checked.message)
      const staged = await files.stage(checked.paths, [owner.workingDirectory, files.folder(owner.threadId)])
      if (!staged.ok) return fail('blocked', staged.message)
      return this.requestAction(record, task, { ...request.action, paths: staged.upload.files.map(file => file.path) }, staged.upload)
    }
    if (grantCovers(request.action.type)) return this.requestAction(record, task, request.action)
    if (task.pendingAction) return fail('busy', 'Answer the pending browser action first.')
    return this.perform(record, task, request.action)
  }) }
  controlTask(payload: unknown) { return this.run(async () => {
    const request = parse(browserControlTaskSchema, payload)
    const record = await this.owned(request)
    const task = this.task(request)
    if (!['working', 'paused'].includes(task.status)) return fail('blocked', this.base.words().finished)
    task.status = request.control === 'pause' ? 'paused' : 'working'
    // Taking the page over, or handing it back, moves its elements as far as the agent knows (ADR-0220, decision 8).
    record.automation.forgetRefs()
    if (request.control === 'pause') { task.pendingAction = null; this.forgetPending(task.id) }
    return this.publishTask(task)
  }) }
  answerAction(payload: unknown) { return this.run(async () => {
    const request = parse(browserAnswerActionSchema, payload)
    const record = await this.owned(request)
    const task = this.task(request), pending = task.pendingAction, scope = this.pending.get(task.id)
    this.working(task)
    if (!pending || pending.id !== request.actionId || !scope || pending.expiresAt < Date.now() || scope.generation !== record.generation || scope.url !== record.page.url) return fail('blocked', this.base.words().changedOrExpired)
    if (request.forThread && !request.allow) return fail('blocked', this.base.words().grantNeedsAllow)
    // An action that asks every time is answered once: it never becomes the thread's grant.
    if (request.forThread && (pending.everyTime || this.asksEveryTime(record, pending.action))) return fail('blocked', this.base.words().asksEveryTime ?? 'This action asks every time, so it cannot be allowed for the whole thread. Answer it once.')
    if (this.executing.has(record.page.id)) return fail('busy', this.base.words().stillRunning)
    task.pendingAction = null
    if (!request.allow) { this.forgetPending(task.id); task.output = 'The user declined this action.'; return this.publishTask(task) }
    this.pending.delete(task.id)
    const threadId = record.page.workspace.threadId
    if (request.forThread) {
      this.grants.grant(threadId)
      this.base.emit({ type: 'browser-grant', threadId, grant: this.grantView(threadId) })
      this.shareThreadPages(threadId)
    }
    try { return (await this.perform(record, task, pending.action, scope.initial, scope.target, false, scope.staged)).task } catch (error) {
      // The user is told in their words; the agent, waiting on the task, reads the reference is used in its output.
      if (error instanceof SecretSpent) return fail(error.code, this.base.words().secretSpent ?? SECRET_SPENT_FOR_USER)
      throw error
    } finally { if (request.forThread) await this.performWaitingActions(threadId) }
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
      if (task.threadId !== threadId || task.status !== 'working' || !pending || !grantCovers(pending.action.type) || pending.everyTime || !scope || !record || this.asksEveryTime(record, pending.action) || pending.expiresAt < Date.now()
        || scope.generation !== record.generation || scope.url !== record.page.url || this.executing.has(record.page.id) || !this.grants.active(threadId)) continue
      task.pendingAction = null; this.forgetPending(task.id)
      // One action failing is that task's own failed step; it does not undo the answer the user just gave.
      await this.perform(record, task, pending.action, scope.initial, scope.target, true).catch(() => undefined)
    }
  }
  private async perform(record: R, task: BrowserTask, action: BrowserAction, initial = false, approvedTarget?: string, granted = false, staged?: StagedUpload): Promise<BrowserAgentResult> {
    if (this.executing.has(record.page.id)) { if (staged) void this.base.browserFiles?.discard(staged); return fail('busy', 'A browser action is still running.') }
    this.executing.add(record.page.id)
    const generation = record.generation, startedAt = Date.now()
    // An action that only reads the page, or sets how it looks or is recorded, cannot set off a download.
    const reading = READS.has(action.type) || action.type === 'appearance' || action.type === 'record_start'
    if (!reading) this.acting.add(record.page.id)
    const observedUrl = action.type === 'navigate' ? action.url : record.page.url
    // Set once a secret request's value is taken: from then on a failure says the reference is used (ADR-0219).
    let spent = false
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
      // The user is clicking or typing in this page right now; an agent's input, a navigate included, waits until they stop (ADR-0220).
      if (!READS.has(action.type) && this.userActive(record)) fail('busy', 'The user is using this page right now. Wait a moment, take a snapshot, then try again.')
      let output = '', image: string | undefined, capture: BrowserCapture | undefined
      if (action.type === 'navigate') {
        record.initial = false
        // An agent's new page is shared by its Open and share answer, or by the browser grant that stands for it. A page
        // in a profile is shared with another site only by the user's answer to this navigate (ADR-0221).
        if (initial || (record.page.profile && !granted)) record.page.sharedOrigin = new URL(action.url).origin
        this.load(record, action.url)
        if (record.page.sharedOrigin) record.automation.observe()
        output = this.parity ? await this.loaded(record, action.waitUntil ?? 'load', action.timeoutMs ?? NAVIGATION_WAIT_MS) : 'Navigation started. Inspect the page after it finishes loading.'
      } else if (action.type === 'inspect') output = await record.automation.inspect()
      else if (action.type === 'snapshot') {
        output = await record.automation.snapshotText()
        if (action.includeImage && await record.automation.showsSecret()) output = `${output}\n\n(No picture: this page holds a secret you saved, and a page can show what a password field holds. Pictures come back once it loads a document that holds none.)`
        else if (action.includeImage) { capture = await record.automation.capture(record.page.url); image = capture.image }
      } else if (action.type === 'screenshot') {
        await this.noPicture(record)
        capture = await record.automation.capture(record.page.url, undefined, undefined, action.fullPage === true); image = capture.image
        let saved: string | undefined
        if (action.save) {
          const files = this.base.browserFiles ?? fail('unavailable', 'Saving screenshots is not available here. The picture is in this result.')
          saved = await files.save(record.page.workspace.threadId, 'screenshot', 'png', Buffer.from(capture.image.slice(capture.image.indexOf(',') + 1), 'base64'))
        }
        output = JSON.stringify({ url: capture.url, width: capture.width, height: capture.height, ...(saved ? { path: saved } : {}) })
      } else if (action.type === 'wait_for') output = await record.automation.waitFor(action, () => guard())
      else if (action.type === 'evaluate') output = await record.automation.evaluate(action.expression, action.awaitPromise === true)
      else if (action.type === 'dialog') {
        const answered = await record.automation.answerDialog(action.accept, action.promptText)
        output = `${action.accept ? 'Accepted' : 'Dismissed'} the ${answered.type} dialog.${answered.type === 'prompt' && action.promptText === undefined && action.accept ? ' It was given its default text.' : ''}`
      } else if (action.type === 'upload') {
        if (action.paths.length) {
          // The copies the user was asked about, looked at again now: one changed or swapped since is not given.
          const files = this.base.browserFiles
          if (!staged || !files) fail('blocked', 'This upload was not copied when it was asked for. Ask again.')
          if (!await files!.verify(staged!)) fail('blocked', this.base.words().filesChanged ?? 'The files changed after you were asked. Nothing was given to the page. Ask the agent to try again.')
        }
        output = await record.automation.upload(action, action.paths, guard)
        if (staged) { this.givenUploads.set(record.page.id, [...this.givenUploads.get(record.page.id) ?? [], staged]); staged = undefined }
      }
      else if (action.type === 'appearance') {
        await record.automation.emulateAppearance(action.colorScheme === 'auto' ? null : action.colorScheme)
        this.publish(record)
        output = action.colorScheme === 'auto' ? 'The page follows the computer\'s colour scheme again.' : `The page sees prefers-color-scheme: ${action.colorScheme}.`
      } else if (action.type === 'record_start') {
        if (!this.startRecording) fail('unavailable', 'Recording is not available on the machine this thread runs on.')
        if (record.page.recording) fail('busy', 'This page is already recording. Stop it with record_stop.')
        await this.startRecording!(record)
        this.publish(record)
        output = 'Recording. Stop it with record_stop; it stops by itself at 50 MB.'
      } else if (action.type === 'record_stop') {
        if (!this.stopRecordingOf) fail('blocked', 'This page is not recording.')
        output = JSON.stringify({ path: await this.stopRecordingOf!(record) })
        this.publish(record)
      }
      else if (action.type === 'type' && action.secretRef) {
        // Checked again now, and the value taken only as it is typed, after every other check: a declined, lapsed or
        // refused action spends nothing. A card that named no site goes where the user said yes, this page's site.
        const ref = action.secretRef, threadId = record.page.workspace.threadId
        const site = await this.secretSite(record, ref) ?? new URL(record.page.url).origin
        guard()
        const take = async (): Promise<string | null> => { const value = await this.base.secret!(threadId, ref); spent = value !== null; return value }
        await record.automation.typeSecret(take, guard, action, action.clear === true, site)
        output = 'type completed.'
      } else {
        const said = await record.automation.input(action, guard)
        if (action.type === 'viewport') {
          record.page.viewport = action.fill ? null : action.preset ? { ...sizeOf(action.preset, action.orientation), preset: action.preset, orientation: action.orientation ?? 'portrait' } : { width: action.width!, height: action.height! }
          this.publish(record)
        }
        output = said ? `${action.type} completed. ${said}` : `${action.type} completed.`
      }
      if (action.type !== 'navigate') guard(reading)
      if (capture) {
        const evidence = await record.automation.evidence(capture)
        guard()
        if (evidence) task.evidence = [...(task.evidence ?? []), { id: randomUUID(), at: Date.now(), url: record.automation.maskedUrl(record.page.url), viewport: record.page.viewport ?? null, ...evidence }].slice(-3)
      }
      // Revocation during an asynchronous capture must not release page evidence.
      if (action.type !== 'navigate') guard(reading)
      // A page with a dialog open draws no new picture until it is answered, and one a secret was typed into keeps none
      // while it is open: a later document can show it again, and it is not read for that after every action.
      const thumbnail = action.type === 'navigate' || (this.parity && record.automation.dialog()) || record.automation.typedSecret() ? null : await record.automation.thumbnail(image).catch(() => null)
      if (action.type !== 'navigate') guard(reading)
      if (record.page.sharedOrigin && task.status === 'working') task.thumbnail = thumbnail
      const note = this.actionNote?.(record, startedAt)
      if (note) output = `${output} ${note}`
      // Whatever the page says back, its address included, goes on with a secret typed into it masked (ADR-0219).
      output = record.automation.masked(output)
      // The window takes so much of it, and what it is cut from is masked already, so only the end of a mask can go.
      task.output = output.slice(0, BROWSER_OUTPUT_MAX)
      const grantNote = granted ? ' Not asked: you let this thread use the browser without asking.' : ''
      task.steps.push({ id: randomUUID(), action: action.type, status: 'completed', at: Date.now(), detail: this.stepDetail(action, output, grantNote), url: record.automation.maskedUrl(observedUrl), viewport: record.page.viewport ?? null })
      task.steps = task.steps.slice(-40)
      return { task: this.publishTask(task), output, ...(image ? { image } : {}), approvalRequired: false }
    } catch (error) {
      // A spent reference is said in the task too: an action the user allowed answers the agent with the task, not the
      // error. The step the user reads in Tools says it in the user's words, with no tool's name in them.
      const said = spent ? record.automation.masked(spentWords(error)) : null
      task.output = said ?? 'The browser action did not finish. Inspect the page before trying again.'
      const detail = said === null ? task.output : this.base.words().secretSpent ?? SECRET_SPENT_FOR_USER
      task.steps.push({ id: randomUUID(), action: action.type, status: 'failed', at: Date.now(), detail, url: record.automation.maskedUrl(observedUrl), viewport: record.page.viewport ?? null })
      task.steps = task.steps.slice(-40); this.publishTask(task)
      if (said !== null) throw new SecretSpent(error instanceof ToolFailure ? error.code : 'unavailable', said)
      throw error
    } finally {
      this.executing.delete(record.page.id)
      this.acting.delete(record.page.id)
      // A page the user stopped sharing while the action ran is theirs again, so a download it starts next is theirs too.
      if (!reading && this.sharedNow(record.page.id, record.page.workspace.threadId)) this.agentActedAt.set(record.page.id, Date.now())
      // Copies made for an upload that was not given go now.
      if (staged) void this.base.browserFiles?.discard(staged)
      for (const listener of this.taskListeners) listener()
    }
  }
  /** A completed step as the user reads it in Tools: what happened, never a value typed or read back. */
  private stepDetail(action: BrowserAction, output: string, grantNote: string): string {
    if (action.type === 'type') return action.secretRef ? `Entered a secret you saved in the focused password field.${grantNote}` : `Entered text in ${action.ref || action.selector ? 'a field' : 'the focused field'}.${grantNote}`
    if (action.type === 'key') return `Pressed ${[...action.modifiers ?? [], action.key].join('+')}.${grantNote}`
    if (action.type === 'inspect') return 'Inspected the page and recent console and network errors.'
    if (action.type === 'snapshot') return 'Read the page: its elements, words, console and errors.'
    if (action.type === 'evaluate') return `Ran a script in the page.${grantNote}`
    if (action.type === 'upload') return action.paths.length ? `Gave the page ${action.paths.length} file${action.paths.length === 1 ? '' : 's'}.` : 'Cancelled the page\'s file chooser.'
    return grantNote ? `${output.slice(0, 1800)}${grantNote}` : output.slice(0, 2000)
  }
  /**
   * After a navigation, waits until the page has loaded as far as `waitUntil` says, or `timeoutMs` passes. A page that
   * is still loading then is not a failure: the agent is told, and may wait on.
   */
  private async loaded(record: R, waitUntil: 'load' | 'domContentLoaded' | 'none', timeoutMs: number): Promise<string> {
    if (waitUntil === 'none') return 'Navigation started. Inspect the page after it finishes loading.'
    const started = Date.now()
    for (;;) {
      if (!this.pages.has(record.page.id) || this.isGone(record)) return 'The page closed while loading.'
      if (record.page.status === 'unavailable') return `The page did not load: ${record.page.error ?? 'it is unavailable'}.`
      if (record.page.status === 'ready' || (waitUntil === 'domContentLoaded' && record.automation.domContentSince(started))) return `Loaded ${record.page.url} in ${Date.now() - started} ms.`
      if (record.automation.dialog()) return `The page opened a ${record.automation.dialog()!.type} dialog while loading. Answer it with the dialog action.`
      if (Date.now() - started >= timeoutMs) return `Still loading after ${timeoutMs} ms. Wait with wait_for, or take a snapshot to see what is there.`
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  waitForAction(taskId: string, actionId: string): Promise<BrowserTask | null> {
    return new Promise(resolve => {
      const check = (): void => {
        if (this.disposed) { this.taskListeners.delete(check); clearTimeout(timer); resolve(null); return }
        const task = this.taskRecords.get(taskId)
        if (!this.disposed && task?.pendingAction?.id === actionId && task.pendingAction.expiresAt > Date.now()) return
        const expired = task?.pendingAction?.id === actionId
        if (expired) { task.pendingAction = null; this.forgetPending(taskId); task.output = 'This browser request expired. Ask the user before requesting it again.' }
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
    task.pendingAction = null; this.forgetPending(task.id)
    return this.publishTask(task)
  }) }
  /** The browser is shutting down: every task, grant and served file goes, and every wait ends. Pages are the subclass's. */
  protected disposeTasks(): void {
    for (const taskId of [...this.pending.keys()]) this.forgetPending(taskId)
    for (const pageId of [...this.givenUploads.keys(), ...this.userTimers.keys()]) this.forgetPage(pageId)
    this.taskRecords.clear(); this.pending.clear(); this.userInput.clear(); this.agentActedAt.clear()
    this.grants.clear()
    this.filePages.dispose()
    for (const listener of this.taskListeners) listener()
    this.taskListeners.clear()
  }
}
