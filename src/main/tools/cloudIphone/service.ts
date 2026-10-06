import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { BrowserWindow, WebContentsView, nativeImage, session, type Session } from 'electron'
import { z } from 'zod'
import {
  CLOUD_IPHONE_BUILD_EXTENSIONS, CLOUD_IPHONE_MAX_BUILD_BYTES, CLOUD_IPHONE_REQUEST_MS,
  cloudAgentActionSchema, cloudAgentFinishSchema, cloudAgentOpenSchema, cloudAnswerSchema, cloudEndReasonSchema,
  cloudKeySchema, cloudMountSchema, cloudSessionRequestSchema,
  type CloudAction, type CloudAgentResult,
  type CloudEvent, type CloudIphoneStatus, type CloudSession, type CloudSessionStatus,
} from '../../../shared/cloudIphone'
import { TEST_IPHONE } from '../../../shared/browser'
/** `cloudEndReasonSchema` has no exported inferred type in the contract; derived locally rather than editing it. */
type CloudEndReason = import('zod').infer<typeof cloudEndReasonSchema>
import { toolListRequestSchema } from '../../../shared/tools'
import type { FileWorkspace } from '../../../shared/files'
import type { FilesService } from '../../files/service'
import type { AgentCredentials } from '../../agents/credentials'
import { ToolOperations, fail, parse, workspace } from '../common'
import { CloudUsageLedger, monthKey } from './usageLedger'
import type { CloudAccessibilityNode, CloudDeviceProvider, CloudInteraction, CloudStartedSession } from './runCloudClient'

/** The radius the player draws the phone's corner at, the same fraction as the test iPhone (ADR-0045). */
const CORNER_FRACTION = 0.12
const MAX_RECORDS = 64
const MAX_INSPECT_CHARS = 200_000
const MAX_SCREENSHOT_SIDE = 2576
const CREDENTIAL_SLOT = 'runcloud'
const TERMINAL_STATUSES: readonly CloudSessionStatus[] = ['ended', 'denied', 'refused', 'failed']
const LIVE_STATUSES: readonly CloudSessionStatus[] = ['asking', 'starting', 'active']
const RUNNING_STATUSES: readonly CloudSessionStatus[] = ['starting', 'active']
const SHARED_TICK_MS = 60_000
/** What remains after a release or a deletion could not finish; plain words, never a claim that it is done. */
const RELEASE_PENDING = 'Sotto could not release the simulator yet; it keeps trying while Sotto is open.'
const DELETE_PENDING = 'Sotto could not delete the upload yet; it keeps trying while Sotto is open.'

interface MountedView { view: WebContentsView; window: BrowserWindow; cleanup(): void }
/** An opaque timer handle; real code uses Node's, a test can use its own. */
type TimerHandle = unknown
interface SessionRecord {
  session: CloudSession
  resolvedBuildPath: string | null
  provider: CloudDeviceProvider | null
  /** run.cloud's own simulator session id. Opaque outside this file (ADR-0047): never shown, logged or compared by shape. */
  deviceHandle: string | null
  /** run.cloud's own uploaded-build id. */
  uploadHandle: string | null
  viewerUrl: string | null
  screenSize: { width: number; height: number } | null
  idleTimer: TimerHandle | null
  expireTimer: TimerHandle | null
  waiters: Set<() => void>
  mounted: MountedView | null
}
export interface CloudIphoneDependencies {
  files: FilesService
  credentials: AgentCredentials
  /** The live **Settings > Cloud iPhone** cap and idle minutes. */
  settings(): { monthlyMinutes: number; idleMinutes: number }
  ledger: CloudUsageLedger
  threadTitle(threadId: string): string
  getWindow(): BrowserWindow | null
  emit(event: CloudEvent): void
  /** run.cloud behind one adapter (ADR-0047); a test supplies a fake instead. */
  provider(key: string): CloudDeviceProvider
  /** Clock and timers, injectable for tests; default to the wall clock and Node's own timers. */
  now?(): number
  setTimer?(callback: () => void, ms: number): TimerHandle
  clearTimer?(handle: TimerHandle): void
}
const messageOf = (error: unknown): string => error instanceof Error ? error.message : 'run.cloud did not say why.'
function describeAction(action: CloudAction): string {
  if (action.type === 'tap') return `Tapped at ${action.x}, ${action.y}.`
  if (action.type === 'swipe') return `Swiped from ${action.x}, ${action.y} to ${action.toX}, ${action.toY}.`
  if (action.type === 'type') return 'Entered text.'
  if (action.type === 'key') return `Pressed ${action.key}.`
  if (action.type === 'button') return `Pressed ${action.button}.`
  if (action.type === 'openUrl') return `Opened ${action.url}.`
  if (action.type === 'inspect') return 'Inspected the screen.'
  return 'Took a screenshot.'
}
function compactNode(node: CloudAccessibilityNode): unknown {
  return {
    role: node.role ?? null, label: node.label ?? null, value: node.value ?? null, identifier: node.identifier ?? null,
    bounds: node.bounds, states: { enabled: (node.states as Record<string, unknown> | undefined)?.enabled ?? null, focused: (node.states as Record<string, unknown> | undefined)?.focused ?? null },
    children: (node.children ?? []).map(compactNode),
  }
}
/** Joins a reason's own problem text with what a cleanup still could not finish, dropping whichever is empty. */
function combineProblem(...parts: (string | null)[]): string | null {
  const joined = parts.filter((part): part is string => Boolean(part)).join(' ')
  return joined.length > 0 ? joined : null
}
/** `https:`, or `http:` only on a loopback address: how a local fake's viewer URL is allowed in a test (ADR-0047). */
function viewerUrlAllowed(url: string): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol === 'https:') return true
  return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
}

/**
 * One cloud iPhone (run.cloud) session per thread at most (ADR-0047). Every lifecycle decision (asking,
 * the monthly cap, the idle timer) lives here; `RunCloudClient` alone knows run.cloud's own wire shapes.
 */
export class CloudIphoneService extends ToolOperations {
  private readonly records = new Map<string, SessionRecord>()
  private readonly namespace = randomUUID()
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void
  /** A session's own `startSession` run, so `dispose` can wait for it: it releases what it made once disposed. */
  private readonly starts = new Map<string, Promise<void>>()
  private sharedTicker: TimerHandle | null = null
  constructor(private readonly dependencies: CloudIphoneDependencies) {
    super()
    this.now = dependencies.now ?? Date.now
    this.setTimer = dependencies.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = dependencies.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout))
    this.scheduleTick()
  }

  private async owner(threadId: string, expected?: string): Promise<FileWorkspace> {
    try { return await workspace(this.dependencies.files, threadId, expected) }
    catch (error) {
      if ((error as { code?: string }).code === 'thread-unavailable') this.forgetThread(threadId)
      throw error
    }
  }
  private liveFor(threadId: string): SessionRecord | undefined {
    return [...this.records.values()].find(record => record.session.threadId === threadId && LIVE_STATUSES.includes(record.session.status))
  }
  private activeFor(threadId: string): SessionRecord {
    const record = [...this.records.values()].find(record => record.session.threadId === threadId && record.session.status === 'active')
    if (!record) return fail('blocked', 'This thread has no active cloud iPhone session. Open one first.')
    return record
  }
  private owned(request: { threadId: string; workspaceId: string; sessionId: string }): SessionRecord {
    const record = this.records.get(request.sessionId)
    if (!record || record.session.threadId !== request.threadId || record.session.workspaceId !== request.workspaceId) return fail('session-unavailable', 'This cloud iPhone session belongs to another workspace or is gone.')
    return record
  }
  private statusSnapshot(): CloudIphoneStatus {
    const now = this.now()
    return {
      keySaved: this.dependencies.credentials.has(CREDENTIAL_SLOT),
      month: monthKey(now),
      monthMinutes: this.dependencies.ledger.monthMinutes(now),
      capMinutes: this.dependencies.settings().monthlyMinutes,
      recent: this.dependencies.ledger.recent(20).map(entry => ({ threadId: entry.threadId, threadTitle: entry.threadTitle, startedAt: entry.startedAt, minutes: entry.minutes })),
    }
  }
  private emitSession(id: string): void {
    const record = this.records.get(id)
    if (!record || this.disposed) return
    this.dependencies.emit({ type: 'session', session: structuredClone(record.session) })
  }
  private emitStatus(): void {
    if (this.disposed) return
    this.dependencies.emit({ type: 'status', status: this.statusSnapshot() })
  }
  private resolveWaiters(record: SessionRecord): void {
    for (const waiter of [...record.waiters]) waiter()
  }
  private clearTimers(record: SessionRecord): void {
    for (const key of ['idleTimer', 'expireTimer'] as const) {
      if (record[key] !== null) { this.clearTimer(record[key]); record[key] = null }
    }
  }
  private evict(): void {
    while (this.records.size > MAX_RECORDS) {
      const entries = [...this.records.entries()].filter(([, record]) => TERMINAL_STATUSES.includes(record.session.status))
      entries.sort((a, b) => (a[1].session.endedAt ?? 0) - (b[1].session.endedAt ?? 0))
      const oldest = entries[0]
      if (!oldest) break
      this.records.delete(oldest[0])
    }
  }
  private place(session: CloudSession, internal: Partial<SessionRecord>): void {
    const record: SessionRecord = { session, resolvedBuildPath: null, provider: null, deviceHandle: null, uploadHandle: null, viewerUrl: null, screenSize: null, idleTimer: null, expireTimer: null, waiters: new Set(), mounted: null, ...internal }
    this.records.set(session.id, record)
    this.evict()
    this.emitSession(session.id)
  }

  private async resolveBuildPath(owner: FileWorkspace, buildPath: string): Promise<{ path: string; bytes: number }> {
    let root: string
    try { root = await realpath(owner.workingDirectory) } catch { return fail('blocked', 'The thread’s working folder is unavailable.') }
    const target = resolve(owner.workingDirectory, buildPath)
    let real: string
    try { real = await realpath(target) } catch { return fail('blocked', 'This build was not found in the thread’s folder.') }
    const relativePath = relative(root, real)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return fail('blocked', 'This build is outside the thread’s folder.')
    const info = await stat(real)
    if (info.isDirectory()) return fail('blocked', 'That path is a folder, not a build file.')
    const lower = real.toLowerCase()
    if (!CLOUD_IPHONE_BUILD_EXTENSIONS.some(ext => lower.endsWith(ext))) return fail('blocked', 'Builds must be a .zip, .tar.gz, .tgz or .ipa simulator build.')
    if (info.size > CLOUD_IPHONE_MAX_BUILD_BYTES) return fail('blocked', 'This build is larger than the 2 GB Sotto uploads. Use a smaller simulator build.')
    return { path: real, bytes: info.size }
  }
  private refuse(owner: FileWorkspace, request: { buildPath: string; description: string }, problem: string): CloudSession {
    const session: CloudSession = { id: randomUUID(), threadId: owner.threadId, workspaceId: owner.workspaceId, status: 'refused', description: request.description, buildPath: request.buildPath, buildBytes: 0, device: null, expiresAt: null, startedAt: null, endedAt: this.now(), endReason: null, minutes: 0, problem, steps: [], summary: null, unchecked: [] }
    this.place(session, {})
    this.emitStatus()
    return structuredClone(session)
  }
  private scheduleExpiry(id: string): void {
    const record = this.records.get(id)
    if (!record || record.session.expiresAt === null) return
    record.expireTimer = this.setTimer(() => this.lapse(id), Math.max(0, record.session.expiresAt - this.now()))
  }
  private lapse(id: string): void {
    const record = this.records.get(id)
    if (!record || record.session.status !== 'asking') return
    this.deny(record, 'The request lapsed. Ask the user before requesting it again.')
  }
  /** The one place `asking` turns into `denied`: a user's No, a lapse, a gone thread, or Sotto quitting mid-ask. */
  private deny(record: SessionRecord, problem: string | null): void {
    this.clearTimers(record)
    record.session.status = 'denied'
    record.session.problem = problem
    record.session.endedAt = this.now()
    this.resolveWaiters(record)
    this.emitSession(record.session.id)
  }
  /** Marks a running session as ending before any teardown await, so a racing `startSession` sees it at once (finding 2, ADR-0047). */
  private beginEnd(record: SessionRecord, reason: CloudEndReason): void {
    record.session.status = 'ended'
    record.session.endReason = reason
  }
  private finishEnd(record: SessionRecord, problem: string | null): void {
    record.session.endedAt = this.now()
    record.session.problem = problem
    this.emitSession(record.session.id)
    this.emitStatus()
  }

  /** `iphone_cloud_open`: creates an `asking` session, or a `refused` one when Sotto will not ask at all. */
  agentOpen(payload: unknown) { return this.run(async (): Promise<CloudSession> => {
    const request = parse(cloudAgentOpenSchema, payload)
    const owner = await this.owner(request.threadId, request.workspaceId)
    if (this.liveFor(owner.threadId)) return fail('busy', 'This thread already has a cloud iPhone session. Finish or end it before starting another.')
    if (!this.dependencies.credentials.has(CREDENTIAL_SLOT)) return this.refuse(owner, request, 'Add a run.cloud key in Settings › Cloud iPhone before starting a cloud iPhone.')
    const now = this.now()
    const cap = this.dependencies.settings().monthlyMinutes
    if (this.dependencies.ledger.monthMinutes(now) >= cap) return this.refuse(owner, request, `This month’s cloud iPhone minutes (${cap}) are already used. Nothing was uploaded. Raise the cap in Settings, or wait for next month.`)
    const { path: resolvedPath, bytes } = await this.resolveBuildPath(owner, request.buildPath)
    const id = randomUUID()
    const session: CloudSession = { id, threadId: owner.threadId, workspaceId: owner.workspaceId, status: 'asking', description: request.description, buildPath: request.buildPath, buildBytes: bytes, device: null, expiresAt: now + CLOUD_IPHONE_REQUEST_MS, startedAt: null, endedAt: null, endReason: null, minutes: 0, problem: null, steps: [], summary: null, unchecked: [] }
    this.place(session, { resolvedBuildPath: resolvedPath })
    this.scheduleExpiry(id)
    return structuredClone(session)
  }) }
  /** Resolves once the session leaves `asking` (answered, or lapsed into `denied`). */
  waitForAnswer(sessionId: string): Promise<CloudSession | null> {
    const record = this.records.get(sessionId)
    if (!record) return Promise.resolve(null)
    if (record.session.status !== 'asking') return Promise.resolve(structuredClone(record.session))
    return new Promise(resolve => {
      const finish = (): void => { record.waiters.delete(finish); resolve(structuredClone(record.session)) }
      record.waiters.add(finish)
    })
  }

  status() { return this.run(async (): Promise<CloudIphoneStatus> => this.statusSnapshot()) }
  setKey(payload: unknown) { return this.run(async (): Promise<{ saved: boolean; problem: string | null }> => {
    const request = parse(cloudKeySchema, payload)
    if (!request.value) {
      await this.dependencies.credentials.set(CREDENTIAL_SLOT, '')
      this.emitStatus()
      return { saved: true, problem: null }
    }
    const provider = this.dependencies.provider(request.value)
    try { await provider.checkKey() }
    catch (error) { return { saved: false, problem: messageOf(error) } }
    await this.dependencies.credentials.set(CREDENTIAL_SLOT, request.value)
    this.emitStatus()
    return { saved: true, problem: null }
  }) }
  sessions(payload: unknown) { return this.run(async (): Promise<CloudSession[]> => {
    const request = parse(toolListRequestSchema, payload)
    return [...this.records.values()].filter(record => record.session.threadId === request.threadId).map(record => structuredClone(record.session))
  }) }

  /** The user's Start or Deny card. Start returns at once; the upload and start continue in the background. */
  answer(payload: unknown) { return this.run(async (): Promise<CloudSession> => {
    const request = parse(cloudAnswerSchema, payload)
    const record = this.owned(request)
    if (record.session.status !== 'asking') return fail('blocked', 'This cloud iPhone request already changed or expired. Ask again.')
    if (!request.allow) { this.deny(record, null); return structuredClone(record.session) }
    this.clearTimers(record)
    record.session.status = 'starting'
    this.emitSession(record.session.id)
    this.resolveWaiters(record)
    const id = record.session.id
    const started = this.startSession(id)
    this.starts.set(id, started)
    void started.finally(() => { if (this.starts.get(id) === started) this.starts.delete(id) })
    return structuredClone(record.session)
  }) }
  /** Tries an action; a failure is queued in the ledger for `resumeCleanup` to retry, rather than lost. */
  private async releaseOrQueue(kind: 'session' | 'asset', handle: string, action: () => Promise<void>): Promise<boolean> {
    try { await action(); await this.dependencies.ledger.removeCleanup(kind, handle); return true }
    catch { await this.dependencies.ledger.addCleanup(kind, handle, this.now()); return false }
  }
  private async startSession(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record || record.session.status !== 'starting') return
    const now = this.now()
    const cap = this.dependencies.settings().monthlyMinutes
    if (this.dependencies.ledger.monthMinutes(now) >= cap) {
      this.refuseStarted(record, `This month’s cloud iPhone minutes (${cap}) are already used. Nothing was uploaded. Raise the cap in Settings, or wait for next month.`)
      return
    }
    // The build is re-checked right before upload: the agent asked about one file, and only that file, at that
    // size, may leave the computer, even if the time between asking and Start let it change underfoot.
    let revalidated: { path: string; bytes: number }
    try {
      const owner = await this.owner(record.session.threadId, record.session.workspaceId)
      revalidated = await this.resolveBuildPath(owner, record.session.buildPath)
    } catch (error) { if (record.session.status === 'starting') this.failStarted(record, `This build is no longer available as it was asked about. Nothing was uploaded. ${messageOf(error)}`); return }
    if (revalidated.path !== record.resolvedBuildPath || revalidated.bytes !== record.session.buildBytes) {
      this.failStarted(record, 'This build changed since you were asked to start it. Nothing was uploaded. Ask again to start a new session with the current build.')
      return
    }
    let key: string
    try { key = this.dependencies.credentials.get(CREDENTIAL_SLOT) }
    catch (error) { this.refuseStarted(record, messageOf(error)); return }
    if (!key) { this.refuseStarted(record, 'Add a run.cloud key in Settings › Cloud iPhone before starting a cloud iPhone.'); return }
    const provider = this.dependencies.provider(key)
    record.provider = provider
    // The user can End a session, or its thread can go, while the build uploads or the simulator starts; whatever
    // was made by then is released rather than left running and billed.
    const stillStarting = (): boolean => record.session.status === 'starting' && !this.disposed
    let uploadHandle: string
    try { uploadHandle = await provider.upload(record.resolvedBuildPath!) }
    catch (error) { if (stillStarting()) this.failStarted(record, `The build could not be uploaded to run.cloud. Nothing was charged. ${messageOf(error)}`); return }
    if (!stillStarting()) { await this.releaseOrQueue('asset', uploadHandle, () => provider.deleteAsset(uploadHandle)); return }
    record.uploadHandle = uploadHandle
    let started: CloudStartedSession
    try { started = await provider.start({ assetId: uploadHandle, displayName: `Sotto ${record.session.id.slice(0, 8)}`, tags: { thread: record.session.threadId } }) }
    catch (error) {
      const deleted = await this.releaseOrQueue('asset', uploadHandle, () => provider.deleteAsset(uploadHandle))
      record.uploadHandle = null
      if (stillStarting()) {
        const deletion = deleted ? 'The build was uploaded and then deleted; nothing was charged for simulator time.' : `The build was uploaded. ${DELETE_PENDING}`
        this.failStarted(record, `The simulator could not start. ${deletion} ${messageOf(error)}`)
      }
      return
    }
    if (!stillStarting()) {
      await this.releaseOrQueue('session', started.id, () => provider.release(started.id))
      await this.releaseOrQueue('asset', uploadHandle, () => provider.deleteAsset(uploadHandle))
      record.uploadHandle = null
      return
    }
    record.deviceHandle = started.id
    record.viewerUrl = started.viewerUrl
    record.session.status = 'active'
    record.session.device = started.device
    record.session.startedAt = this.now()
    record.session.minutes = 0
    // The idle timer starts the moment the session is truly active, not whenever the ledger's disk write
    // happens to finish; that write cannot be allowed to delay or skew the timer's accuracy. The cap, the
    // thread check and minute accounting run on the one shared tick (`onTick`), not a per-session timer.
    this.armIdleTimer(record)
    this.emitSession(id)
    await this.dependencies.ledger.start(id, record.session.threadId, this.dependencies.threadTitle(record.session.threadId), record.session.startedAt)
    this.emitStatus()
  }
  private refuseStarted(record: SessionRecord, problem: string): void {
    record.session.status = 'refused'; record.session.problem = problem; record.session.endedAt = this.now()
    this.emitSession(record.session.id); this.emitStatus()
  }
  private failStarted(record: SessionRecord, problem: string): void {
    record.session.status = 'failed'; record.session.problem = problem; record.session.endedAt = this.now()
    this.emitSession(record.session.id); this.emitStatus()
  }
  private armIdleTimer(record: SessionRecord): void {
    if (record.idleTimer !== null) this.clearTimer(record.idleTimer)
    if (record.session.status !== 'active') return
    const idleMinutes = this.dependencies.settings().idleMinutes
    record.idleTimer = this.setTimer(() => { void this.endForReason(record.session.id, 'idle', `Ended after ${idleMinutes} minute${idleMinutes === 1 ? '' : 's'} with no action or input.`) }, idleMinutes * 60_000)
  }
  private touchIdle(record: SessionRecord): void { this.armIdleTimer(record) }
  private tickInFlight: Promise<void> | null = null
  /**
   * Every session's retry queue, the cap and a gone thread, on one timer rather than one per session (ADR-0047).
   * A tick that is still checking skips the next firing rather than overlap it: each tick's own thread checks
   * share `FilesService`'s small concurrency budget with the agent's own calls, which must not starve.
   */
  private scheduleTick(): void {
    this.sharedTicker = this.setTimer(() => {
      if (!this.tickInFlight) this.tickInFlight = this.onTick().finally(() => { this.tickInFlight = null })
      if (!this.disposed) this.scheduleTick()
    }, SHARED_TICK_MS)
  }
  private async onTick(): Promise<void> {
    await this.resumeCleanup()
    for (const record of [...this.records.values()]) {
      if (!RUNNING_STATUSES.includes(record.session.status)) continue
      const resolved = await this.dependencies.files.resolveWorkspace(record.session.threadId, record.session.workspaceId)
      if (!resolved.ok && resolved.error.code === 'thread-unavailable') { await this.endForReason(record.session.id, 'thread', 'This thread is gone.'); continue }
      if (record.session.status !== 'active') continue
      if (record.provider && record.deviceHandle) {
        try {
          const state = await record.provider.get(record.deviceHandle)
          if (record.session.status === 'active' && ['released', 'failed'].includes(state.status)) { await this.endForReason(record.session.id, 'lost', 'run.cloud ended this session. Anything it was doing stopped there.'); continue }
        } catch { /* a poll failure is not itself a lost session */ }
      }
      if (record.session.status === 'active' && record.session.startedAt !== null) {
        const minutes = Math.ceil((this.now() - record.session.startedAt) / 60_000)
        if (minutes !== record.session.minutes) {
          record.session.minutes = minutes
          // Awaited, not fire-and-forget: `tickInFlight` is what `dispose` waits on before clearing state.
          await this.dependencies.ledger.updateMinutes(record.session.id, minutes)
          this.emitSession(record.session.id)
          this.emitStatus()
        }
      }
    }
    const cap = this.dependencies.settings().monthlyMinutes
    if (this.dependencies.ledger.monthMinutes(this.now()) >= cap) {
      for (const record of [...this.records.values()]) {
        if (record.session.status === 'active') await this.endForReason(record.session.id, 'cap', 'Ended: this month’s cloud iPhone minutes are used.')
      }
    }
  }
  /** Retries a release or a deletion `teardown` could not finish, using the saved key; called at startup and every tick. */
  async resumeCleanup(): Promise<void> {
    const pending = this.dependencies.ledger.pendingCleanup()
    if (pending.length === 0) return
    let key: string
    try { key = this.dependencies.credentials.get(CREDENTIAL_SLOT) } catch { return }
    if (!key) return
    const provider = this.dependencies.provider(key)
    for (const entry of pending) {
      await this.releaseOrQueue(entry.kind, entry.handle, () => entry.kind === 'session' ? provider.release(entry.handle) : provider.deleteAsset(entry.handle))
    }
  }
  private async endForReason(id: string, reason: CloudEndReason, problem: string | null): Promise<void> {
    const record = this.records.get(id)
    if (!record || !RUNNING_STATUSES.includes(record.session.status)) return
    this.beginEnd(record, reason)
    const cleanupProblem = await this.teardown(record)
    this.finishEnd(record, combineProblem(problem, cleanupProblem))
  }
  /**
   * Takes the viewer off the window and keeps it, as `BrowserService` keeps a hidden page: a resize or a hidden
   * player must not reconnect the simulator's stream. `destroy` closes it for good when the session ends.
   */
  private detachMount(record: SessionRecord, destroy = false): void {
    if (!record.mounted) return
    const { view, window } = record.mounted
    if (!window.isDestroyed() && window.contentView.children.includes(view)) window.contentView.removeChildView(view)
    if (!destroy) return
    record.mounted.cleanup()
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
    record.mounted = null
  }
  /** Releases whatever this record made, queuing what it could not, and reports the latest minutes. Returns plain words for anything still left to clean up, or null. */
  private async teardown(record: SessionRecord): Promise<string | null> {
    this.clearTimers(record)
    const provider = record.provider
    const problems: string[] = []
    if (provider && record.deviceHandle) {
      const handle = record.deviceHandle
      if (!(await this.releaseOrQueue('session', handle, () => provider.release(handle)))) problems.push(RELEASE_PENDING)
    }
    if (provider && record.uploadHandle) {
      const handle = record.uploadHandle
      if (!(await this.releaseOrQueue('asset', handle, () => provider.deleteAsset(handle)))) problems.push(DELETE_PENDING)
    }
    const now = this.now()
    if (record.session.startedAt !== null) {
      const minutes = Math.max(record.session.minutes, Math.ceil((now - record.session.startedAt) / 60_000))
      record.session.minutes = minutes
      await this.dependencies.ledger.end(record.session.id, now, minutes).catch(() => undefined)
    }
    record.deviceHandle = null; record.uploadHandle = null; record.viewerUrl = null; record.provider = null
    this.detachMount(record, true)
    return problems.length > 0 ? problems.join(' ') : null
  }

  /** The user's End session. */
  end(payload: unknown) { return this.run(async (): Promise<CloudSession> => {
    const request = parse(cloudSessionRequestSchema, payload)
    const record = this.owned(request)
    if (record.session.status === 'asking') { this.deny(record, null); return structuredClone(record.session) }
    if (!RUNNING_STATUSES.includes(record.session.status)) return fail('blocked', 'This cloud iPhone session has already finished.')
    this.beginEnd(record, 'user')
    const cleanupProblem = await this.teardown(record)
    this.finishEnd(record, cleanupProblem)
    return structuredClone(record.session)
  }) }

  private checkUrl(url: string): void {
    let scheme: string
    try { scheme = new URL(url).protocol.toLowerCase() } catch { return fail('blocked', 'That is not a valid URL.') }
    if (['file:', 'data:', 'javascript:', 'about:'].includes(scheme)) return fail('blocked', 'That kind of link cannot be opened on the cloud iPhone.')
  }
  private async screenSize(record: SessionRecord): Promise<{ width: number; height: number }> {
    if (record.screenSize) return record.screenSize
    const snapshot = await record.provider!.accessibility(record.deviceHandle!)
    record.screenSize = snapshot.screen
    return snapshot.screen
  }
  private async convert(record: SessionRecord, action: Extract<CloudAction, { type: 'tap' | 'swipe' | 'type' | 'key' | 'button' }>): Promise<CloudInteraction> {
    if (action.type === 'tap') { const screen = await this.screenSize(record); return { kind: 'tap', x: action.x / screen.width, y: action.y / screen.height } }
    if (action.type === 'swipe') { const screen = await this.screenSize(record); return { kind: 'swipe', x: action.x / screen.width, y: action.y / screen.height, toX: action.toX / screen.width, toY: action.toY / screen.height } }
    if (action.type === 'type') return { kind: 'type', text: action.text }
    if (action.type === 'key') return { kind: 'key', key: action.key }
    return { kind: 'button', button: action.button }
  }
  private async inspect(record: SessionRecord): Promise<string> {
    const snapshot = await record.provider!.accessibility(record.deviceHandle!)
    record.screenSize = snapshot.screen
    const text = JSON.stringify({ screen: snapshot.screen, roots: snapshot.roots.map(compactNode) })
    return text.length > MAX_INSPECT_CHARS ? text.slice(0, MAX_INSPECT_CHARS) : text
  }
  private async captureScreenshot(record: SessionRecord): Promise<string> {
    const png = await record.provider!.screenshot(record.deviceHandle!)
    const image = nativeImage.createFromBuffer(png)
    const size = image.getSize()
    const longest = Math.max(size.width, size.height)
    const scaled = longest > MAX_SCREENSHOT_SIDE && longest > 0
      ? image.resize({ width: Math.round(size.width * (MAX_SCREENSHOT_SIDE / longest)), height: Math.round(size.height * (MAX_SCREENSHOT_SIDE / longest)) })
      : image
    return scaled.toDataURL()
  }
  private appendStep(record: SessionRecord, action: string, status: 'completed' | 'failed', detail: string): void {
    record.session.steps = [...record.session.steps, { id: randomUUID(), action: action.slice(0, 40), status, at: this.now(), detail: detail.slice(0, 2000) }].slice(-60)
  }

  /** `iphone_cloud_action`: taps, types and the rest do not ask; the session the user started already covers them (ADR-0047). */
  agentAction(payload: unknown) { return this.run(async (): Promise<CloudAgentResult> => {
    const request = parse(cloudAgentActionSchema, payload)
    await this.owner(request.threadId, request.workspaceId)
    const record = this.activeFor(request.threadId)
    if (record.session.workspaceId !== request.workspaceId) return fail('workspace-changed', 'The thread working directory changed. Refresh and try again.')
    const action = request.action
    this.touchIdle(record)
    let output: string | undefined, image: string | undefined
    try {
      if (action.type === 'inspect') output = await this.inspect(record)
      else if (action.type === 'screenshot') image = await this.captureScreenshot(record)
      else if (action.type === 'openUrl') { this.checkUrl(action.url); await record.provider!.openUrl(record.deviceHandle!, action.url); output = `Opened ${action.url}.` }
      else { await record.provider!.interact(record.deviceHandle!, await this.convert(record, action)); output = `${action.type} completed.` }
    } catch (error) {
      this.appendStep(record, action.type, 'failed', messageOf(error))
      this.emitSession(record.session.id)
      return fail('blocked', messageOf(error))
    }
    this.appendStep(record, action.type, 'completed', describeAction(action))
    this.emitSession(record.session.id)
    return { session: structuredClone(record.session), ...(output ? { output } : {}), ...(image ? { image } : {}) }
  }) }
  /** `iphone_cloud_finish`: releases the simulator and deletes the uploaded build. */
  agentFinish(payload: unknown) { return this.run(async (): Promise<CloudSession> => {
    const request = parse(cloudAgentFinishSchema, payload)
    await this.owner(request.threadId, request.workspaceId)
    const record = this.activeFor(request.threadId)
    if (record.session.workspaceId !== request.workspaceId) return fail('workspace-changed', 'The thread working directory changed. Refresh and try again.')
    this.beginEnd(record, 'finished')
    const cleanupProblem = await this.teardown(record)
    record.session.summary = request.status === 'failed' ? `Failed: ${request.summary}` : request.summary
    record.session.unchecked = request.unchecked
    this.finishEnd(record, cleanupProblem)
    return structuredClone(record.session)
  }) }

  private setBounds(record: SessionRecord, window: BrowserWindow, bounds: NonNullable<z.infer<typeof cloudMountSchema>['bounds']>): void {
    if (!record.mounted) return
    const zoom = window.webContents.getZoomFactor()
    const [width = 0, height = 0] = window.getContentSize()
    const x = Math.min(width, Math.round(bounds.x * zoom)), y = Math.min(height, Math.round(bounds.y * zoom))
    const view = { x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width * zoom))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height * zoom))) }
    record.mounted.view.setBounds(view)
    record.mounted.view.setBorderRadius(Math.round(view.width * CORNER_FRACTION))
    // The viewer lays out at an iPhone's width however small the player draws it, as the test iPhone does (ADR-0045).
    if (!record.mounted.view.webContents.isDestroyed() && view.width > 0) record.mounted.view.webContents.setZoomFactor(Math.max(0.25, view.width / TEST_IPHONE.width))
  }
  private ensureMounted(record: SessionRecord, window: BrowserWindow): void {
    if (record.mounted && record.mounted.window === window && !record.mounted.view.webContents.isDestroyed()) {
      if (!window.contentView.children.includes(record.mounted.view)) window.contentView.addChildView(record.mounted.view)
      return
    }
    this.detachMount(record, true)
    const origin = new URL(record.viewerUrl!).origin
    // Its own partition per session, in-memory rather than persisted to disk (no `persist:` prefix).
    const isolated: Session = session.fromPartition(`sotto-cloud-iphone-${this.namespace}-${record.session.id}-${randomUUID()}`)
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    const view = new WebContentsView({ webPreferences: {
      session: isolated, contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true,
      // Deliberately no preload: the viewer is run.cloud's own untrusted page (ADR-0020).
    } })
    const contents = view.webContents
    const blockForeign = (event: { preventDefault(): void }, url: string): void => {
      try { if (new URL(url).origin !== origin) event.preventDefault() } catch { event.preventDefault() }
    }
    contents.on('will-navigate', (event, url) => blockForeign(event, url))
    contents.on('will-redirect', (event, url) => blockForeign(event, url))
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('input-event', () => this.touchIdle(record))
    const separator = record.viewerUrl!.includes('?') ? '&' : '?'
    void contents.loadURL(`${record.viewerUrl}${separator}embed=1`).catch(() => undefined)
    const detach = (): void => this.detachMount(record)
    window.webContents.on('did-start-loading', detach)
    window.webContents.on('render-process-gone', detach)
    window.webContents.on('destroyed', detach)
    window.on('closed', detach)
    window.on('resize', detach)
    record.mounted = { view, window, cleanup: () => {
      window.webContents.removeListener('did-start-loading', detach)
      window.webContents.removeListener('render-process-gone', detach)
      window.webContents.removeListener('destroyed', detach)
      window.removeListener('closed', detach)
      window.removeListener('resize', detach)
    } }
    window.contentView.addChildView(view)
  }
  /** Shows a running session's viewer in its own native view, bounded and clipped like `BrowserService`'s. */
  mount(payload: unknown) { return this.run(async (): Promise<void> => {
    const request = parse(cloudMountSchema, payload)
    const record = this.owned(request)
    if (request.bounds === null) { this.detachMount(record); return }
    if (record.session.status !== 'active' || !record.viewerUrl) return fail('blocked', 'This cloud iPhone session is not running.')
    if (!viewerUrlAllowed(record.viewerUrl)) return fail('blocked', 'The cloud iPhone’s viewer address is not secure enough to show.')
    const window = this.dependencies.getWindow()
    if (!window || window.isDestroyed()) return fail('unavailable', 'The main window is unavailable.')
    this.ensureMounted(record, window)
    this.setBounds(record, window, request.bounds)
  }) }

  /** A thread Sotto no longer lists takes its cloud iPhone session with it (ADR-0047). */
  forgetThread(threadId: string): void {
    for (const record of this.records.values()) {
      if (record.session.threadId !== threadId) continue
      if (record.session.status === 'asking') { this.deny(record, 'This thread is gone.'); continue }
      if (RUNNING_STATUSES.includes(record.session.status)) {
        this.beginEnd(record, 'thread')
        void this.teardown(record).then(cleanupProblem => this.finishEnd(record, combineProblem('This thread is gone.', cleanupProblem))).catch(() => undefined)
      }
    }
  }
  /** Releases every live session, best effort, with a short timeout, so Sotto never leaves a meter running. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.sharedTicker !== null) { this.clearTimer(this.sharedTicker); this.sharedTicker = null }
    const pending: Promise<void>[] = []
    for (const record of this.records.values()) {
      if (record.session.status === 'asking') { this.deny(record, null); continue }
      if (RUNNING_STATUSES.includes(record.session.status)) {
        this.beginEnd(record, 'quit')
        pending.push(this.teardown(record).then(cleanupProblem => { this.finishEnd(record, cleanupProblem) }).catch(() => undefined))
      } else this.detachMount(record, true)
    }
    // A start already in flight sees `disposed` once it next checks `stillStarting` and releases what it made itself.
    pending.push(...this.starts.values())
    // A tick already checking a thread or writing the ledger must finish before the records (and, in a test,
    // the working folder) it is using disappear out from under it.
    if (this.tickInFlight) pending.push(this.tickInFlight.catch(() => undefined))
    await Promise.race([Promise.all(pending), new Promise<void>(resolve => this.setTimer(resolve, 3_000))])
    this.records.clear()
  }
}
