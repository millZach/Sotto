import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { z } from 'zod'
import { SocketFrames } from '../../host/socketFrames'
import { agentAttachmentHandleSchema, agentThreadDetailResultSchema, agentAttachmentPreviewResultSchema, type AgentAttachmentContent, type AgentAttachmentHandle, type AgentAttachmentUpload, type AgentCommand, type AgentState, type AgentThreadDetail, type AgentThreadDetailDelta, type AgentThreadDetailUpdate, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult } from '../../shared/agents'
import { applyAgentThreadDetailDelta } from '../../shared/agentThreadDetail'
import type { StoredThreadEvent } from '../../shared/threadEvents'
import { gitRefsPageSchema, type GitRefsPage, type GitRefsRequest } from '../../shared/gitRefs'
import { gitChangedFilesSchema, type GitChangedFiles, type GitChangedFilesRequest } from '../../shared/gitChangedFiles'
import { gitPullRequestResultSchema, type GitPullRequestDetail, type GitPullRequestRequest } from '../../shared/gitPullRequests'
import { hostFoldersResultSchema, type HostFoldersRequest, type HostFoldersResult } from '../../shared/hostFolders'
import { fileListingSchema, filePreviewSchema, filesResultSchema, type FileListing, type FileListRequest, type FilePreview, type FileRequest, type FilesResult } from '../../shared/files'
import { gitListingSchema, gitReviewSchema, type GitChangeListing, type GitReview, type GitReviewRequest } from '../../shared/gitChanges'
import { subagentAssignmentsPageSchema, subagentPageSchema, type SubagentAssignmentsPage, type SubagentAssignmentsRequest, type SubagentPage, type SubagentPageRequest } from '../../shared/subagents'
import { toolsResultSchema, type ToolListRequest, type ToolsResult } from '../../shared/tools'
import { hostSignInSchema, type HostSignIn } from '../../shared/hostProviders'
import type { ProviderId } from '../../shared/agents'
import { protocolAgentStateSchema, HOST_BUSY, hostAttachmentContentSchema, hostIsNewer, hostVersionMismatch, hostHealthFeatures, hostPairingSchema, hostSessionSchema, hostHelloSchema, hostEventPageSchema, hostResponseSchema, hostPushSchema, hostReceiptSchema } from '../../shared/hostProtocol'
import type { HostFeature, HostAnswerTarget, HostHello, HostOperation, HostPairing, HostSession, HostResponse, HostPush, HostEventPage, HostReceipt, HostErrorCode } from '../../shared/hostProtocol'
import type { HostService, ClientIdentity, RequestAnswerRecovery } from './hostService'
import { requestDraftProvider, requestDraftQuestions } from '../../shared/requestDrafts'
import { requestQuestionsDigest } from './requestDrafts'
import { version as clientVersion } from '../../../package.json'
import { RetainedDraftStore, type RetainedDraft } from './retainedDraftStore'

export const REMOTE_COMPOSE_UNSAVED = 'This host cannot save this draft yet. Your draft is kept on this computer and has not been saved on the host. Update the host.'
const REMOTE_SEND_UNCERTAIN = 'This draft may already have been sent. Your copy is kept on this computer. Check the original thread before sending again.'

const COMPOSE_WIRE_LIMIT = 2
type TargetedCompose = Extract<AgentCommand, { type: 'compose' }> & { threadId: string }
type ComposeBatch = { command: TargetedCompose; draftId: string; commandId?: string; result: Promise<AgentState>;
  resolve(state: AgentState): void; reject(error: unknown): void }

/** `version_mismatch` is this client's own finding, never a code on the wire: the host speaks a protocol it cannot use. */
export class HostConnectionError extends Error {
  constructor(message: string, readonly code: HostErrorCode | 'disconnected' | 'version_mismatch', readonly commandId?: string, readonly pairingRequired = false) { super(message) }
}
/** The address answered as a host other than the one expected. Nothing of this computer's pairing was sent to its session. */
export class WrongHostError extends HostConnectionError {
  constructor(message = 'This address belongs to a different host. Check the connection before continuing.') { super(message, 'unauthenticated') }
}
export interface SocketHostServiceOptions {
  url: string; token: string; expectedHostId?: string
  retainedDrafts?: RetainedDraftStore
  retainedRegistrationId?: string
  /**
   * How long the health check may take. A tailnet connection allows 5 seconds before it counts the tailnet as not
   * answering (ADR-0053); everything else allows 15.
   */
  healthTimeoutMs?: number
  onConnectionChange?: (connected: boolean) => void
  getSelectedThreadId?: () => string | null
  /** A push the host could not send, such as a thread too large for one frame. The message is plain copy. */
  onPushError?: (message: string) => void
  /** What the last push error was about has since arrived: the thread it named, or the shell when it named none. */
  onPushErrorCleared?: () => void
  /** Whether Sotto started this host, so the version sentence offers Stop host only when it is there to press. */
  owned?: boolean
  /**
   * False for a client with nothing that reads the host's event log, such as the desktop router. It asks
   * for no events when it opens, reads none after a command and follows no catch-up a push offers, so a
   * connect never downloads a log nobody reads. The shell and the observed threads' details still arrive
   * in full on every open, which is what a reconnect needs (ADR-0025). Defaults to true.
   */
  catchUpEvents?: boolean
}
/** The names of this computer, where a forward listens and plain HTTP may go. */
const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost'])
/** An `afterSeq` past any sequence a host can reach: the host has no event after it, so it sends none. */
const NO_EVENTS_AFTER = Number.MAX_SAFE_INTEGER
/**
 * A 429 is the host's request budget, not this device's pairing, so it says to wait rather than to pair again. A 403 keeps
 * the pairing: the host knows this client but will not take it here, as a tailnet listener refuses a client it does not
 * know as a desktop while phone access is off (ADR-0053).
 */
const refusal = (status: number, otherwise: string, code: HostErrorCode, pairingRequired = false): HostConnectionError =>
  status === 429 ? new HostConnectionError(HOST_BUSY, 'busy') : status === 403 ? new HostConnectionError('This host refused this device here. The pairing is kept.', 'forbidden')
    : new HostConnectionError(otherwise, code, undefined, pairingRequired)
/** A transport cache, not a second coordinator. Losing a socket never replays a command. */
export class SocketHostService implements HostService {
  private frames: SocketFrames | undefined
  private session?: HostSession
  private cached?: AgentState
  private readonly details = new Map<string, AgentThreadDetail | null>()
  private readonly storedEvents = new Map<number, StoredThreadEvent>()
  private readonly answerTargets = new Map<string, HostAnswerTarget>()
  private readonly acceptedAnswers = new Map<string, NonNullable<HostReceipt['acceptedAnswer']>>()
  private latestSeq = 0
  private catchup: Promise<void> | undefined
  /** The thread the last push error named, null for the shell, undefined when none is outstanding. */
  private pushErrorThread: string | null | undefined
  /**
   * What the host advertised. A client uses a feature only when this connection's hello lists it: health lists what the
   * listener offers anyone, and a hello what this client may use (ADR-0053). Until a hello arrives, nothing is listed.
   */
  private hostVersion: string | undefined
  private features: readonly string[] = []
  /** Threads being read whole because a delta did not follow the revision held, so a run of them costs one read. */
  private readonly resyncing = new Set<string>()
  /** Threads the host said are too large to send. No delta asks for one again until it is observed again or arrives whole. */
  private readonly tooLarge = new Set<string>()
  private readonly listeners = new Set<(state: AgentState) => void>()
  private readonly detailListeners = new Set<(detail: AgentThreadDetailUpdate) => void>()
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; command: boolean }>()
  private connecting: Promise<HostHello> | undefined
  private observed: string[] = []
  private generation = 0
  private opening: AbortController | undefined
  private previewTail: Promise<unknown> = Promise.resolve()
  private composeBudget: { active: number; queued?: ComposeBatch } = { active: 0 }
  private readonly retainedDrafts: RetainedDraftStore
  private readonly retainedRegistrationId: string | undefined
  private readonly recovering = new Map<string, number>()
  private readonly recoveryAttempts = new Map<string, string>()
  private readonly activeComposeDrafts = new Set<string>()
  private readonly delivering = new Map<string, number>()
  private recoveryError: { threadId: string; draftId: string; message: string } | undefined
  private snapshotEpoch = 0
  private retainedRefresh: Promise<void> | undefined
  private retainedRefreshRequested = false
  private wireAdmission: Promise<void> | undefined
  constructor(private readonly options: SocketHostServiceOptions) {
    this.endpoint('/v1/health'); this.retainedDrafts = options.retainedDrafts ?? new RetainedDraftStore()
    this.retainedRegistrationId = options.retainedRegistrationId
      ?? (options.expectedHostId ? this.retainedDrafts.registrationForHost(options.expectedHostId) : undefined)
  }
  private get catchesUp(): boolean { return this.options.catchUpEvents !== false }
  /**
   * Redeems a pairing code. A desktop pairs only through the SSH connection's forward, on this computer, so a code is never
   * sent to any other address, whatever asks (ADR-0053).
   */
  static async pair(url: string, code: string, name: string): Promise<HostPairing> {
    const endpoint = new SocketHostService({ url, token: '' }).endpoint('/v1/pair')
    if (endpoint.protocol !== 'http:' || !LOOPBACK.has(endpoint.hostname)) throw new Error('This computer pairs with a host only through its SSH connection. Nothing was sent. Connect again over SSH.')
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, code, name }), signal: AbortSignal.timeout(15000), redirect: 'error' })
    if (!response.ok) throw refusal(response.status, 'This pairing code could not be used. Make a new code on the host and try again.', 'unauthenticated')
    return hostPairingSchema.parse(await response.json())
  }
  private endpoint(path: string): URL {
    const url = new URL(path, this.options.url)
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Use a host HTTP or HTTPS address without credentials in its URL.')
    if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) throw new Error('A remote host address must use HTTPS.')
    return url
  }
  connect(): Promise<HostHello> {
    if (this.connecting) return this.connecting
    const task = this.open()
    this.connecting = task
    void task.finally(() => { if (this.connecting === task) this.connecting = undefined }).catch(() => undefined)
    return task
  }
  private async open(): Promise<HostHello> {
    await this.retainedDrafts.load()
    this.resetComposeQueue()
    const selectedThreadId = this.cached?.activeThreadId
    const generation = ++this.generation
    this.opening?.abort()
    const opening = new AbortController(); this.opening = opening
    this.frames?.close()
    // The host says what it speaks before anything is sent to it, so a host of another version is named
    // as one instead of answering a request it cannot read with a refusal or a closed socket.
    const healthResponse = await fetch(this.endpoint('/v1/health'), { signal: AbortSignal.any([opening.signal, AbortSignal.timeout(this.options.healthTimeoutMs ?? 15000)]), redirect: 'error' })
    if (generation !== this.generation) throw new HostConnectionError('This host connection was closed.', 'disconnected')
    if (!healthResponse.ok) throw new HostConnectionError('The host did not answer its health check. Connect again.', 'unavailable')
    const healthBody: unknown = await healthResponse.json().catch(() => null)
    const health = hostHealthFeatures(healthBody)
    if (!health) {
      // A host of another protocol version may still say which Sotto it runs, which decides the way out.
      const advertised = healthBody !== null && typeof healthBody === 'object' && 'sottoVersion' in healthBody ? healthBody.sottoVersion : undefined
      this.hostVersion = typeof advertised === 'string' ? advertised : undefined
      throw new HostConnectionError(this.mismatch(), 'version_mismatch')
    }
    this.hostVersion = health.sottoVersion; this.features = []
    // A host that says it is another one is not sent this device's token at all.
    if (this.options.expectedHostId && health.hostId !== this.options.expectedHostId) throw new WrongHostError()
    const response = await fetch(this.endpoint('/v1/session'), { method: 'POST', headers: { Authorization: 'Bearer ' + this.options.token }, signal: AbortSignal.any([opening.signal, AbortSignal.timeout(15000)]), redirect: 'error' })
    if (generation !== this.generation) throw new HostConnectionError('This host connection was closed.', 'disconnected')
    if (!response.ok) throw refusal(response.status, 'This device needs to connect again or be paired on the host.', 'unauthenticated', response.status === 401)
    const session = hostSessionSchema.parse(await response.json())
    if (session.v !== 1 || typeof session.session !== 'string') throw new HostConnectionError('The host answered with something else. Connect again.', 'unauthenticated')
    if (this.options.expectedHostId && session.hostId !== this.options.expectedHostId) throw new WrongHostError()
    this.session = session
    this.details.clear(); this.tooLarge.clear()
    const url = this.endpoint('/v1/socket'), key = randomBytes(16).toString('base64')
    const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    this.frames = await new Promise<SocketFrames>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { signal: opening.signal, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, Authorization: 'Bearer ' + session.session } })
      request.setTimeout(15000, () => request.destroy(new Error('Host connection timed out.')))
      request.on('error', () => reject(new HostConnectionError('The host connection could not be opened.', 'disconnected')))
      request.on('response', response => { response.resume(); reject(refusal(response.statusCode ?? 503, 'The host refused this connection. Connect again.', 'unavailable')) })
      request.on('upgrade', (response, stream, head) => {
        if (response.headers['sec-websocket-accept'] !== expected) { stream.destroy(); reject(new HostConnectionError('The host did not accept this protocol.', 'invalid_request')); return }
        stream.setTimeout(0)
        const frames = new SocketFrames(stream, true, text => this.receive(text))
        frames.onClose(() => this.disconnected(frames))
        frames.startHeartbeat()
        frames.feed(head)
        resolve(frames)
      })
      request.end()
    })
    if (generation !== this.generation) { this.frames.close(); throw new HostConnectionError('This host connection was closed.', 'disconnected') }
    try {
      const accepted = (['client-liveness', 'detail-delta', 'message-aliases', 'client-updates', 'answer-receipts'] as const).filter(feature => health.features.includes(feature))
      const accepts = { accepts: [...accepted] }
      const hello = this.read(hostHelloSchema, await this.call({ op: 'hello', afterSeq: this.catchesUp ? this.latestSeq : NO_EVENTS_AFTER, ...accepts }))
      if (hello.hostId !== session.hostId) throw new HostConnectionError('The host identity changed. Connect again.', 'unauthenticated')
      this.hostVersion = hello.sottoVersion; this.features = hello.features
      this.publish(this.read(protocolAgentStateSchema, hello.shell), true)
      if (this.catchesUp) {
        this.cacheEvents(hello)
        let page: HostEventPage = hello
        while (page.hasMore) page = await this.readEvents(this.latestSeq)
      }
      await this.observe(this.observed)
      const pickedThreadId = this.options.getSelectedThreadId ? this.options.getSelectedThreadId() : selectedThreadId
      if (pickedThreadId && hello.shell.host.threads.some(thread => thread.id === pickedThreadId)) {
        const selected = this.read(protocolAgentStateSchema, await this.call({ op: 'command', command: { type: 'select-thread', threadId: pickedThreadId } }))
        this.sameGeneration(generation)
        this.publish(selected)
      }
      this.options.onConnectionChange?.(true)
      this.recoverDrafts()
      return hello
    } catch (error) { this.frames?.close(); throw error }
  }
  private disconnected(frames: SocketFrames): void {
    if (this.frames !== frames) return
    this.frames = undefined
    this.resetComposeQueue()
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer)
      item.reject(new HostConnectionError(item.command ? 'The connection closed before the host confirmed this command. Refresh before deciding what to do next.' : 'The host connection closed. Connect again to refresh.', 'disconnected', item.command ? id : undefined))
    }
    this.pending.clear()
    if (this.cached) this.publish({ ...this.cached, stale: true })
    this.options.onConnectionChange?.(false)
  }
  private receive(text: string): void {
    let raw: unknown
    try { raw = JSON.parse(text) } catch { this.frames?.close(); return }
    const parsed = raw !== null && typeof raw === 'object' && 'event' in raw ? hostPushSchema.safeParse(raw) : hostResponseSchema.safeParse(raw)
    if (!parsed.success) { this.unreadable(raw); return }
    const message: HostResponse | HostPush = parsed.data
    try {
      if ('event' in message) {
        if (message.event === 'shell') { if (message.eventPage && this.catchesUp) { this.cacheEvents(message.eventPage); if (message.eventPage.hasMore) this.catchUp() } this.publish(this.read(protocolAgentStateSchema, message.state), true) }
        else if (message.event === 'answer-receipt') { if (this.cacheAcceptedAnswer(message.acceptedAnswer) && this.cached) this.notifyState() }
        else if (message.event === 'detail') this.cacheDetail(message.threadId, agentThreadDetailResultSchema.parse(message.detail))
        else if (message.event === 'detail-delta') this.applyDelta(message.threadId, message.delta)
        else { this.pushErrorThread = message.threadId ?? null; if (message.threadId) this.tooLarge.add(message.threadId); this.options.onPushError?.(message.error.message) }
      } else {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id); clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.result)
        // A host of another version refusing a request as unreadable is version skew, not a bad request.
        else if (message.error.code === 'invalid_request' && this.skewed()) pending.reject(new HostConnectionError(this.mismatch(), 'version_mismatch', pending.command ? message.id : undefined))
        else pending.reject(new HostConnectionError(message.error.message, message.error.code, pending.command ? message.id : undefined))
      }
    } catch { this.frames?.close() }
  }
  /**
   * A message this client cannot read. From a host of the same version it is a broken stream, and the
   * socket closes. From a host of another version it is skew: the request it answered fails with the
   * version sentence, or the sentence is reported the way a push error is, and the connection stays up.
   */
  private unreadable(raw: unknown): void {
    if (!this.skewed()) { this.frames?.close(); return }
    const id = raw !== null && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string' ? raw.id : undefined
    const pending = id === undefined ? undefined : this.pending.get(id)
    // The sentence names no thread and no shell, so no arrival clears it; only a new connection does.
    if (id === undefined || !pending) { this.pushErrorThread = undefined; this.options.onPushError?.(this.mismatch()); return }
    this.pending.delete(id); clearTimeout(pending.timer)
    pending.reject(new HostConnectionError(this.mismatch(), 'version_mismatch', pending.command ? id : undefined))
  }
  /** Whether the host runs another Sotto version than this client, by what it advertised. */
  private skewed(): boolean { return this.hostVersion !== undefined && this.hostVersion !== clientVersion }
  /** The version sentence for this host, which says which side to bring up to date. */
  private mismatch(): string { return hostVersionMismatch(clientVersion, this.hostVersion, this.options.owned ?? false) }
  /** Whether the host last advertised a later Sotto than this client: stopping it would not help. */
  hostIsNewer(): boolean { return hostIsNewer(this.hostVersion, clientVersion) }
  /** The Sotto version the host last advertised on this connection, if it said one. */
  sottoVersion(): string | undefined { return this.hostVersion }
  /** Reads what the host answered; from a host of another version, an answer this client cannot read is named as skew. */
  private read<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value)
    if (parsed.success) return parsed.data
    if (this.skewed()) throw new HostConnectionError(this.mismatch(), 'version_mismatch')
    throw parsed.error
  }
  /**
   * What changed in an observed thread since a revision. It applies only to the revision this client
   * holds, the way the window applies one over IPC, and is then passed on as it came, so the window
   * applies it to that same revision. Anything else reads the whole thread, once however many deltas
   * miss; a delta that what is held already covers is dropped.
   */
  private applyDelta(threadId: string, delta: AgentThreadDetailDelta): void {
    if (delta.threadId !== threadId) throw new HostConnectionError('The host returned a different thread. Refresh before continuing.', 'invalid_request')
    const held = this.details.get(threadId)
    if (held && delta.revision <= held.revision) return
    const applied = held ? applyAgentThreadDetailDelta(held, delta) : null
    if (applied === null) { this.resync(threadId); return }
    this.details.set(threadId, applied)
    for (const listener of this.detailListeners) listener(structuredClone(delta))
    if (this.pushErrorThread === threadId) this.clearPushError()
  }
  /** Reads a thread whole after a delta could not follow it. A thread too large to send is reported, not asked for again. */
  private resync(threadId: string): void {
    if (this.resyncing.has(threadId) || this.tooLarge.has(threadId)) return
    this.resyncing.add(threadId)
    void this.readThreadDetail(threadId).catch((error: unknown) => { this.reportedTooLarge(threadId, error) })
      .finally(() => { this.resyncing.delete(threadId) })
  }
  /** Reports a thread the host said is too large to send, so nothing asks for it again; false for any other failure. */
  private reportedTooLarge(threadId: string, error: unknown): boolean {
    if (!(error instanceof HostConnectionError) || error.code !== 'too_large') return false
    this.tooLarge.add(threadId); this.pushErrorThread = threadId; this.options.onPushError?.(error.message)
    return true
  }
  private catchUp(): void {
    if (this.catchup) return
    const task = (async () => {
      let page = await this.readEvents(this.latestSeq)
      while (page.hasMore) page = await this.readEvents(this.latestSeq)
    })()
    this.catchup = task
    void task.finally(() => { if (this.catchup === task) this.catchup = undefined }).catch(() => undefined)
  }
  private call(operation: HostOperation, id: string = randomUUID(), onPlacement?: () => void): Promise<unknown> {
    const frames = this.frames, session = this.session
    if (!frames || !session) return Promise.reject(new HostConnectionError('The host is disconnected. Connect again before sending.', 'disconnected'))
    if (this.pending.has(id) || this.pending.size >= 32) return Promise.reject(new HostConnectionError('Wait for the pending host request to finish.', 'busy'))
    return new Promise((resolve, reject) => {
      const command = operation.op === 'command'
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HostConnectionError(command ? 'The host has not confirmed this command. Refresh before deciding what to do next.' : 'The host did not answer in time. Try refreshing.', 'disconnected', command ? id : undefined)) }, 120000)
      this.pending.set(id, { resolve, reject, timer, command })
      onPlacement?.()
      if (!frames.send({ v: 1, id, session: session.session, ...operation })) { clearTimeout(timer); this.pending.delete(id); reject(new HostConnectionError('The connection closed before this request could be confirmed.', 'disconnected', command ? id : undefined)) }
    })
  }
  private validateState(state: AgentState): void {
    const hostId = this.session?.hostId
    if (hostId && (state.hostId !== hostId || state.host.hostId !== hostId || state.host.threads.some(thread => thread.hostId && thread.hostId !== hostId) || state.host.projects.some(project => project.hostId && project.hostId !== hostId))) throw new HostConnectionError('The host returned another host identity. Reconnect before continuing.', 'unauthenticated')
  }
  private publish(state: AgentState, authoritative = false): void {
    this.validateState(state)
    delete state.clientScoped; delete state.connections
    if (authoritative) this.snapshotEpoch++
    for (let edit of this.retainedDrafts.list(this.retainedHostId())) {
      const attempt = edit.sendAttempt
      if (attempt?.packetDigest && state.deliveries?.some(item => item.threadId === edit.draft.threadId
        && item.draftId === attempt.draftId && item.status === 'failed' && item.packetDigest === attempt.packetDigest)) {
        const kept = { ...edit }; delete kept.sendAttempt; edit = kept; this.retainedDrafts.put(edit)
      }
      const accepted = [...(state.deliveredDrafts ?? []), ...(state.followupReceipts ?? []),
        ...(state.deliveries ?? []).filter(item => item.status === 'accepted')]
      if (edit.sendAttempt && accepted.some(item => item.threadId === edit.draft.threadId && item.draftId === edit.sendAttempt!.draftId)
        && edit.sendAttempt.draftId !== edit.draft.draftId) {
        const { sendAttempt, ...kept } = edit
        edit = { ...kept, ...(edit.draft.requestId === sendAttempt.requestId ? {
          draft: { ...edit.draft, requestId: null }, questionsDigest: null, saved: false, recovery: true,
        } : {}) }
        this.retainedDrafts.put(edit)
      }
      if ([...accepted, ...(!edit.sendAttempt ? state.obsoleteDrafts ?? [] : [])]
        .some(delivery => delivery.threadId === edit.draft.threadId && (delivery.draftId === edit.draft.draftId
          || edit.saved && delivery.draftId === edit.hostDraftId))) {
        this.retainedDrafts.remove(edit.hostId, edit.draft.threadId, edit.draft.draftId)
      } else if (authoritative && edit.saved && !edit.sendAttempt) {
        const exists = state.host.threads.some(thread => thread.id === edit.draft.threadId)
        const revision = state.threadDrafts?.find(item => item.threadId === edit.draft.threadId)?.draftId
          ?? state.threadDraftPersistence?.find(item => item.threadId === edit.draft.threadId)?.draftId
        if (!exists || revision !== edit.hostDraftId) this.retainedDrafts.remove(edit.hostId, edit.draft.threadId, edit.draft.draftId)
      }
    }
    this.cached = state; this.notifyState()
    if (this.pushErrorThread === null) this.clearPushError()
  }
  /** New acceptance evidence changes recovery, but does not mean an unreadable shell has arrived. */
  private notifyState(): void { for (const listener of this.listeners) listener(this.state()) }
  private clearPushError(): void { this.pushErrorThread = undefined; this.options.onPushErrorCleared?.() }
  private cacheDetail(threadId: string, detail: AgentThreadDetail | null): void {
    if (detail && detail.threadId !== threadId) throw new HostConnectionError('The host returned a different thread. Refresh before continuing.', 'invalid_request')
    const current = this.details.get(threadId)
    if (detail && current && detail.revision < current.revision) return
    this.details.set(threadId, detail); this.tooLarge.delete(threadId)
    if (detail) for (const listener of this.detailListeners) listener(detail)
    if (this.pushErrorThread === threadId) this.clearPushError()
  }
  private sameGeneration(generation: number): void { if (generation !== this.generation) throw new HostConnectionError('This result belongs to an earlier connection. Refresh the host.', 'disconnected') }
  private cacheEvents(page: HostEventPage, advance = true): void {
    for (const event of page.events) this.storedEvents.set(event.seq, event)
    if (advance) this.latestSeq = Math.max(this.latestSeq, page.latestSeq)
    while (this.storedEvents.size > 10000) this.storedEvents.delete(this.storedEvents.keys().next().value!)
  }
  state(): AgentState {
    const shell = this.shell()
    return { ...shell, host: { ...shell.host, threads: shell.host.threads.map(thread => { const detail = this.details.get(thread.id); return detail ? { ...thread, messages: detail.messages, activities: detail.activities } : thread }) } }
  }
  shell(): AgentState {
    if (!this.cached) throw new Error('Connect to the host before reading its state.')
    const state = structuredClone(this.cached)
    for (const edit of this.retainedDrafts.list(this.retainedHostId())) {
      const draft = edit.saved && edit.hostDraftId ? { ...edit.draft, draftId: edit.hostDraftId } : edit.draft
      state.threadDrafts = [...(state.threadDrafts ?? []).filter(draft => draft.threadId !== edit.draft.threadId), draft]
      if (edit.saved && edit.hostDraftId) state.threadDraftPersistence = [...(state.threadDraftPersistence ?? []).filter(item => item.threadId !== draft.threadId),
        { threadId: draft.threadId, draftId: edit.hostDraftId, status: 'saved' }]
      if ((state.draftThreadId ?? state.activeThreadId) === edit.draft.threadId && edit.editing !== false) {
        state.composing = true; state.draftThreadId = edit.draft.threadId; state.draftRequestId = edit.draft.requestId
        state.draft = edit.draft.text; state.draftAttachments = edit.draft.attachments
      }
    }
    const refusal = this.recoveryError
    if (refusal && !state.error) {
      const edit = this.retainedDrafts.get(this.retainedHostId(), refusal.threadId)
      if (edit && !edit.saved && edit.draft.draftId === refusal.draftId) state.error = refusal.message
    }
    if (!state.error && this.retainedDrafts.list(this.retainedHostId()).some(edit => edit.sendAttempt)) state.error = REMOTE_SEND_UNCERTAIN
    return state
  }
  threadDetail(threadId: string): AgentThreadDetail | null { return structuredClone(this.details.get(threadId) ?? null) }
  events(afterSeq: number, threadId?: string): StoredThreadEvent[] { return structuredClone([...this.storedEvents.values()].filter(event => event.seq > afterSeq && (!threadId || event.threadId === threadId)).sort((a, b) => a.seq - b.seq)) }
  subscribe(listener: (state: AgentState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  subscribeThreadDetail(listener: (detail: AgentThreadDetailUpdate) => void): () => void { this.detailListeners.add(listener); return () => this.detailListeners.delete(listener) }
  async readShell(): Promise<AgentState> { const generation = this.generation, epoch = this.snapshotEpoch; const state = this.read(protocolAgentStateSchema, await this.call({ op: 'shell' })); this.sameGeneration(generation); if (epoch === this.snapshotEpoch) this.publish(state, true); return this.shell() }
  /** An intervening push can precede a queued save or follow it. Only a read after its ACK settles that order. */
  private refreshRetainedShell(): void {
    this.retainedRefreshRequested = true
    if (this.retainedRefresh) return
    const generation = this.generation
    const task = (async () => {
      while (this.retainedRefreshRequested && generation === this.generation) {
        this.retainedRefreshRequested = false
        try { await this.readShell() } catch { break } // Keep the exact acknowledged copy until a later observation.
      }
    })()
    this.retainedRefresh = task
    void task.finally(() => { if (this.retainedRefresh === task) this.retainedRefresh = undefined }).catch(() => undefined)
  }
  async checkRequestAnswer(answer: HostAnswerTarget, _client?: ClientIdentity): Promise<void> {
    void _client // The socket's authenticated pairing supplies authority on the host.
    if (!this.features.includes('answer-check')) throw new Error('Update the host before checking this unconfirmed answer. Your saved answer is kept.')
    this.flushCompose()
    const generation = this.generation
    const state = this.read(protocolAgentStateSchema, await this.call({ op: 'check-answer', answer }))
    this.sameGeneration(generation); this.publish(state)
  }
  async readThreadDetail(threadId: string): Promise<AgentThreadDetail | null> { const generation = this.generation; const detail = this.read(agentThreadDetailResultSchema, await this.call({ op: 'detail', threadId })); this.sameGeneration(generation); this.cacheDetail(threadId, detail); return this.threadDetail(threadId) }
  async readEvents(afterSeq: number, threadId?: string): Promise<HostEventPage> { const page = this.read(hostEventPageSchema, await this.call({ op: 'events', afterSeq, ...(threadId ? { threadId } : {}) })); this.cacheEvents(page, threadId === undefined); return page }
  /** Observing a thread again lets one the host found too large be tried again: the host sends whole each observed thread this client does not hold. */
  async observe(threadIds: string[]): Promise<void> { this.observed = [...threadIds]; for (const id of threadIds) this.tooLarge.delete(id); await this.call({ op: 'observe', threadIds }) }
  get supportsAtomicSend(): boolean { return this.features.includes('atomic-send') }
  get supportsDraftRevisions(): boolean { return this.features.includes('draft-revisions') }
  async command(command: AgentCommand, _client?: ClientIdentity, commandId?: string): Promise<AgentState> {
    this.recoveryError = undefined
    const admitted = structuredClone(command)
    if (admitted.type === 'compose' && admitted.threadId !== undefined) {
      const edit = this.retainCompose(admitted as TargetedCompose, commandId)
      if (this.supportsDraftRevisions) return this.queueCompose({ ...admitted, draftId: edit.draft.draftId, attachments: edit.draft.attachments } as TargetedCompose, edit.draft.draftId, commandId)
    }
    // Saves admitted before a command go onto the wire first. Send never waits for their replies.
    this.flushCompose()
    const owner = admitted.type === 'send' ? admitted.draft?.threadId ?? this.shell().draftThreadId ?? this.shell().activeThreadId
      : admitted.type === 'cancel-draft' || admitted.type === 'pause-draft' ? this.shell().draftThreadId ?? this.shell().activeThreadId : undefined
    let edit = owner ? this.retainedDrafts.get(this.retainedHostId(), owner) : undefined
    const priorAdmission = this.wireAdmission
    const generation = this.generation
    let packetPlaced = false
    let releaseAdmission: (() => void) | undefined
    if (admitted.type === 'send' && edit) {
      if (edit.sendAttempt) return { ...this.state(), error: REMOTE_SEND_UNCERTAIN }
      if (!this.supportsDraftRevisions || !this.supportsAtomicSend) return { ...this.state(), error: 'Update the host before sending this draft. Your draft is kept on this computer.' }
      if (edit.draft.requestId && !edit.questionsDigest) return { ...this.state(), error: 'This question is no longer pending or has changed. Your answer is kept; review it before starting a new prompt.' }
      admitted.draft ??= { threadId: edit.draft.threadId, text: edit.draft.text, attachments: structuredClone(edit.draft.attachments) }
      if (admitted.draft.text !== edit.draft.text || JSON.stringify(admitted.draft.attachments ?? []) !== JSON.stringify(edit.draft.attachments)) {
        edit = { ...edit, draft: { ...edit.draft, draftId: randomUUID(), text: admitted.draft.text, attachments: admitted.draft.attachments ?? [] }, saved: false }
      }
      admitted.draft.draftId = edit.draft.draftId
      admitted.draft.binding = { requestId: edit.draft.requestId, questionsDigest: edit.questionsDigest }
      commandId ??= randomUUID()
      const packetDigest = createHash('sha256').update(JSON.stringify([admitted.draft.threadId, admitted.draft.text,
        admitted.draft.attachments === undefined ? null : admitted.draft.attachments.map(image => [image.id, image.name, image.mimeType, image.sizeBytes, image.digest]),
        admitted.draft.binding ? [admitted.draft.binding.requestId, admitted.draft.binding.questionsDigest] : null])).digest('hex')
      edit = { ...edit, saved: false, sendAttempt: { commandId, draftId: edit.draft.draftId, requestId: edit.draft.requestId, packetDigest } }
      this.retainedDrafts.put(edit)
      const hold = new Promise<void>(resolve => { releaseAdmission = resolve })
      const admission = priorAdmission ? priorAdmission.then(() => hold) : hold
      this.wireAdmission = admission
      void admission.then(() => { if (this.wireAdmission === admission) this.wireAdmission = undefined })
    }
    const barrierOwner = owner && (admitted.type === 'send' || admitted.type === 'cancel-draft' || admitted.type === 'pause-draft') ? owner : undefined
    if (barrierOwner) this.delivering.set(barrierOwner, (this.delivering.get(barrierOwner) ?? 0) + 1)
    try {
      if (releaseAdmission) { if (priorAdmission) await priorAdmission; if (this.retainedDrafts.requiresDurableWrites) await this.retainedDrafts.flush(); this.sameGeneration(generation) }
      const executing = this.commandNow(admitted, _client, commandId, undefined, releaseAdmission ? null : this.wireAdmission,
        releaseAdmission ? () => { packetPlaced = true } : undefined)
      releaseAdmission?.()
      const result = await executing
      if (admitted.type === 'preview-reclaim-thread-worktree') return result
      if (result.error === null && edit && (admitted.type === 'send' || admitted.type === 'cancel-draft')) {
        const latest = this.retainedDrafts.get(this.retainedHostId(), edit.draft.threadId)
        this.retainedDrafts.remove(this.retainedHostId(), edit.draft.threadId, edit.draft.draftId)
        if (admitted.type === 'send' && latest && latest.draft.draftId !== edit.draft.draftId && latest.draft.requestId === edit.draft.requestId) {
          const kept = structuredClone(latest); delete kept.sendAttempt
          this.retainedDrafts.put({ ...kept, draft: { ...latest.draft, requestId: null }, questionsDigest: null, saved: false, recovery: true })
        }
        this.notifyState()
      }
      if (result.error && admitted.type === 'send' && edit) {
        const delivery = result.deliveries?.find(item => item.threadId === edit!.draft.threadId && item.draftId === edit!.draft.draftId
          && item.packetDigest === edit!.sendAttempt?.packetDigest)
        if (edit.sendAttempt?.packetDigest && delivery?.status === 'failed') {
          const latest = this.retainedDrafts.get(this.retainedHostId(), edit.draft.threadId)
          if (latest && latest.sendAttempt?.commandId === commandId) {
            const kept = structuredClone(latest); delete kept.sendAttempt
            this.retainedDrafts.put(kept)
          }
        }
      }
      if (result.error === null && (admitted.type === 'pause-draft' || admitted.type === 'resume-draft')) {
        const threadId = admitted.type === 'resume-draft' ? admitted.threadId : owner
        const retained = threadId ? this.retainedDrafts.get(this.retainedHostId(), threadId) : undefined
        if (retained) this.retainedDrafts.put({ ...retained, editing: admitted.type === 'resume-draft' })
      }
      return { ...this.state(), error: result.error }
    } catch (error) {
      if (releaseAdmission && !packetPlaced && edit) {
        const latest = this.retainedDrafts.get(this.retainedHostId(), edit.draft.threadId)
        if (latest && latest.sendAttempt?.commandId === commandId) {
          const kept = structuredClone(latest); delete kept.sendAttempt
          this.retainedDrafts.put(kept)
        }
      }
      throw error
    } finally {
      releaseAdmission?.()
      if (barrierOwner) {
        const remaining = this.delivering.get(barrierOwner)! - 1
        if (remaining) this.delivering.set(barrierOwner, remaining)
        else this.delivering.delete(barrierOwner)
      }
      this.recoverDrafts()
    }
  }
  private queueCompose(command: TargetedCompose, draftId: string, commandId?: string): Promise<AgentState> {
    const budget = this.composeBudget, queued = budget.queued
    if (queued && queued.command.threadId === command.threadId && queued.commandId === undefined && commandId === undefined) {
      // Omission inherits the latest explicit image list; [] deliberately removes images.
      const { attachments, ...latest } = command
      queued.command = { ...queued.command, ...latest, ...(attachments !== undefined ? { attachments } : {}) }
      queued.draftId = draftId
      return queued.result
    }
    // A new owner or an explicit receipt identity seals the older pending save.
    this.flushCompose()
    let resolve!: ComposeBatch['resolve'], reject!: ComposeBatch['reject']
    const result = new Promise<AgentState>((done, fail) => { resolve = done; reject = fail })
    const batch: ComposeBatch = { command, draftId, ...(commandId ? { commandId } : {}), result, resolve, reject }
    if (budget.active === 0) this.dispatchCompose(batch, budget)
    else budget.queued = batch
    return result
  }
  private dispatchCompose(batch: ComposeBatch, budget = this.composeBudget): void {
    const generation = this.generation
    budget.active++
    this.activeComposeDrafts.add(batch.draftId)
    void this.commandNow(batch.command, undefined, batch.commandId, batch.draftId).then(
      state => batch.resolve(state),
      error => batch.reject(error),
    ).finally(() => {
      budget.active--
      if (generation === this.generation) this.activeComposeDrafts.delete(batch.draftId)
      if (budget === this.composeBudget && budget.active < COMPOSE_WIRE_LIMIT) this.flushCompose()
      if (generation === this.generation) this.recoverDrafts()
    })
  }
  private flushCompose(): void {
    const budget = this.composeBudget, queued = budget.queued
    if (!queued) return
    delete budget.queued
    if (budget.active >= COMPOSE_WIRE_LIMIT) {
      this.retainedDrafts.recover(this.retainedHostId())
      const state = { ...this.state(), error: 'The host is still saving earlier edits. Your draft is kept on this computer until it can be saved on the host.' }
      queued.resolve(state)
    } else this.dispatchCompose(queued, budget)
  }
  private resetComposeQueue(): void {
    const queued = this.composeBudget.queued
    this.composeBudget = { active: 0 }
    this.recovering.clear(); this.recoveryAttempts.clear(); this.activeComposeDrafts.clear()
    this.retainedRefresh = undefined; this.retainedRefreshRequested = false
    this.recoveryError = undefined
    if (this.cached?.hostId) this.retainedDrafts.recover(this.cached.hostId)
    queued?.reject(new HostConnectionError(
      'The connection closed before this draft was sent. Your draft is kept on this computer. Reconnect to save it on the host.', 'disconnected'))
  }
  private retainedHostId(): string {
    const hostId = this.session?.hostId ?? this.cached?.hostId ?? this.options.expectedHostId
    if (!hostId) throw new HostConnectionError('Connect to the host before saving this draft.', 'disconnected')
    return hostId
  }
  private retainCompose(command: TargetedCompose, commandId?: string): RetainedDraft {
    const state = this.shell(), previous = this.retainedDrafts.get(this.retainedHostId(), command.threadId)
    // A projected empty local edit is not evidence that a freshly visible question is a prompt.
    const saved = this.cached?.threadDrafts?.find(draft => draft.threadId === command.threadId)
    const thread = state.host.threads.find(item => item.id === command.threadId)
    const question = thread?.requests.find(request => request.kind === 'question')
    const inheritsPrevious = previous && (previous.draft.text.length > 0 || previous.draft.attachments.length > 0 || previous.draft.requestId !== null || !question)
    const requestId = inheritsPrevious ? previous.draft.requestId : saved ? saved.requestId
      : state.composing && state.draftThreadId === command.threadId && (state.draft.length > 0 || state.draftAttachments?.length || !question)
        ? state.draftRequestId : question?.id ?? null
    const boundQuestion = thread?.requests.find(request => request.kind === 'question' && request.id === requestId)
    const baseDraftId = previous ? previous.saved ? previous.hostDraftId ?? previous.baseDraftId ?? null
      : this.activeComposeDrafts.has(previous.draft.draftId)
        || this.composeBudget.active < COMPOSE_WIRE_LIMIT && this.composeBudget.queued?.draftId === previous.draft.draftId
          && (this.composeBudget.queued.commandId !== undefined || commandId !== undefined)
        ? previous.draft.draftId : previous.baseDraftId ?? previous.hostDraftId ?? null
      : saved?.draftId ?? this.cached?.threadDraftPersistence?.find(item => item.threadId === command.threadId)?.draftId ?? null
    const registrationId = this.retainedRegistrationId
    const edit: RetainedDraft = { hostId: this.retainedHostId(), ...(registrationId ? { registrationId } : {}), draft: { threadId: command.threadId, draftId: command.draftId ?? randomUUID(),
      text: command.text, attachments: command.attachments ?? previous?.draft.attachments ?? saved?.attachments
        ?? (state.draftThreadId === command.threadId ? state.draftAttachments : undefined) ?? [],
      skills: previous?.draft.skills ?? saved?.skills, files: previous?.draft.files ?? saved?.files,
      requestId, updatedAt: new Date().toISOString() },
    questionsDigest: inheritsPrevious ? previous.questionsDigest : requestId && boundQuestion ? requestQuestionsDigest(requestDraftQuestions(boundQuestion)) : null,
    saved: false, recovery: previous?.recovery ?? false, editing: true, baseDraftId,
    ...(previous?.sendAttempt ? { sendAttempt: previous.sendAttempt } : {}) }
    this.retainedDrafts.put(edit)
    if (this.retainedDrafts.get(edit.hostId, command.threadId)?.draft.draftId !== edit.draft.draftId) throw new HostConnectionError('This host was forgotten. Nothing was saved.', 'disconnected')
    this.notifyState()
    return edit
  }
  private acknowledgeDraft(threadId: string, draftId: string, state: AgentState, recovery: boolean): void {
    const edit = this.retainedDrafts.get(this.retainedHostId(), threadId)
    if (!edit || edit.draft.draftId !== draftId || state.error || edit.sendAttempt?.draftId === draftId) return
    let acknowledged = state.threadDrafts?.find(draft => draft.threadId === threadId)
    if (!acknowledged && edit.draft.text === '' && edit.draft.attachments.length === 0
      && state.threadDraftPersistence?.some(item => item.threadId === threadId && item.status === 'saved')) {
      this.retainedDrafts.remove(this.retainedHostId(), threadId, draftId)
      return
    }
    if (!acknowledged && state.draftThreadId === threadId && state.composing) {
      const revision = state.threadDraftPersistence?.find(item => item.threadId === threadId && item.status === 'saved')
      if (revision) acknowledged = { ...edit.draft, draftId: revision.draftId, text: state.draft,
        attachments: state.draftAttachments ?? [], requestId: state.draftRequestId }
    }
    if (!acknowledged || !state.threadDraftPersistence?.some(item => item.threadId === threadId && item.draftId === acknowledged.draftId && item.status === 'saved')
      || acknowledged.text !== edit.draft.text
      || JSON.stringify(acknowledged.attachments) !== JSON.stringify(edit.draft.attachments)
      || JSON.stringify(acknowledged.skills ?? []) !== JSON.stringify(edit.draft.skills ?? [])
      || JSON.stringify(acknowledged.files ?? []) !== JSON.stringify(edit.draft.files ?? [])) return
    if (recovery && acknowledged.requestId !== edit.draft.requestId) return
    if (!recovery) {
      const question = state.host.threads.find(thread => thread.id === threadId)?.requests.find(request => request.kind === 'question' && request.id === acknowledged.requestId)
      const questionsDigest = acknowledged.requestId === null ? null : question ? requestQuestionsDigest(requestDraftQuestions(question))
        : acknowledged.requestId === edit.draft.requestId ? edit.questionsDigest : null
      this.retainedDrafts.put({ ...edit, draft: { ...edit.draft, requestId: acknowledged.requestId }, questionsDigest })
    }
    this.retainedDrafts.saved(this.retainedHostId(), threadId, draftId, acknowledged)
  }
  /** Only saved drafts are retried. They carry the original owner/binding and never deliver a prompt or answer. */
  private recoverDrafts(): void {
    if (!this.frames || !this.cached || !this.supportsDraftRevisions || !this.retainedDrafts.storageAvailable || this.composeBudget.active >= COMPOSE_WIRE_LIMIT) return
    const edit = this.retainedDrafts.list(this.retainedHostId()).find(item => {
      if (!item.recovery || item.saved || item.sendAttempt || this.recovering.has(item.draft.threadId) || this.delivering.has(item.draft.threadId)
        || this.recoveryAttempts.get(item.draft.threadId) === item.draft.draftId || this.activeComposeDrafts.has(item.draft.draftId)
        || this.composeBudget.queued?.draftId === item.draft.draftId) return false
      const thread = this.cached!.host.threads.find(thread => thread.id === item.draft.threadId)
      if (!thread) return false
      if (!item.draft.requestId) return true
      const question = thread.requests.find(request => request.kind === 'question' && request.id === item.draft.requestId)
      return question !== undefined && requestQuestionsDigest(requestDraftQuestions(question)) === item.questionsDigest
    })
    if (!edit) return
    const budget = this.composeBudget, generation = this.generation
    budget.active++; this.recovering.set(edit.draft.threadId, generation); this.recoveryAttempts.set(edit.draft.threadId, edit.draft.draftId)
    const { threadId, draftId, text, attachments, skills, files, requestId } = edit.draft
    const refused = (message: string) => {
        if (generation === this.generation && this.cached
          && this.retainedDrafts.get(this.retainedHostId(), threadId)?.draft.draftId === draftId) {
          this.recoveryError = { threadId, draftId, message }; this.notifyState()
        }
    }
    void this.commandNow({ type: 'save-thread-draft', threadId, draftId, text, attachments, skills, files, requestId,
      expectedDraftId: edit.baseDraftId ?? edit.hostDraftId ?? null,
      ...(requestId && edit.questionsDigest ? { questionsDigest: edit.questionsDigest } : {}) }, undefined, undefined, draftId)
      .then(state => { if (state.error) refused(state.error) })
      .catch((error: unknown) => { refused(error instanceof Error ? error.message : 'This draft could not be saved on the host. Reconnect and try again.') })
      .finally(() => {
        budget.active--
        if (this.recovering.get(threadId) === generation) this.recovering.delete(threadId)
        // A refused save remains retained for an explicit edit/reconnect; it is not an endless retry.
        if (generation === this.generation) { this.flushCompose(); this.recoverDrafts() }
      })
    this.recoverDrafts()
  }
  private async commandNow(command: AgentCommand, _client?: ClientIdentity, commandId?: string, retainedId?: string, admission: Promise<void> | null | undefined = this.wireAdmission, onPlacement?: () => void): Promise<AgentState> {
    const admittedGeneration = this.generation
    if (admission) await admission
    this.sameGeneration(admittedGeneration)
    if (command.type === 'compose' && command.threadId !== undefined && !this.supportsDraftRevisions) return { ...this.state(), error: REMOTE_COMPOSE_UNSAVED }
    if (!this.supportsDraftRevisions && (command.type === 'send' && command.draft?.draftId !== undefined
      || command.type === 'save-thread-draft' && command.expectedDraftId !== undefined)) return { ...this.state(), error: 'Update the host before saving or sending this draft. Your draft is kept on this computer.' }
    if (!this.supportsAtomicSend) {
      if (command.type === 'send' && command.draft) return { ...this.state(), error: 'Update the host before sending this draft. Your draft is kept on this computer.' }
      if (command.type === 'compose' && command.threadId !== undefined) return { ...this.state(), error: REMOTE_COMPOSE_UNSAVED }
    }
    if (command.type === 'observe-threads') { await this.observe(command.threadIds); return this.state() }
    commandId ??= randomUUID()
    const before = this.shell()
    const thread = command.type === 'answer' ? before.host.threads.find(item => item.id === command.threadId) : undefined
    const request = command.type === 'answer' ? thread?.requests.find(item => item.id === command.requestId) : undefined
    const questions = request ? requestDraftQuestions(request) : []
    const answer: HostAnswerTarget | undefined = thread && request && questions.length ? { threadId: thread.id,
      providerId: requestDraftProvider(before.host, thread, before.configuration.provider), requestId: request.id,
      questionsDigest: requestQuestionsDigest(questions) } : undefined
    const generation = this.generation, epoch = this.snapshotEpoch
    const operation = { op: 'command' as const, command }
    const state = this.read(protocolAgentStateSchema, await (onPlacement ? this.call(operation, commandId, onPlacement) : this.call(operation, commandId))); this.sameGeneration(generation)
    if (command.type === 'preview-reclaim-thread-worktree') { this.validateState(state); return state }
    if (retainedId && 'threadId' in command && command.threadId
      && this.retainedDrafts.get(this.retainedHostId(), command.threadId)?.draft.draftId !== retainedId) {
      return { ...this.state(), error: state.error }
    }
    if (retainedId && 'threadId' in command && command.threadId) this.acknowledgeDraft(command.threadId, retainedId, state, command.type === 'save-thread-draft')
    if (retainedId && epoch !== this.snapshotEpoch) {
      this.snapshotEpoch++ // A read already in flight cannot retire this newly acknowledged revision.
      this.notifyState()
      this.refreshRetainedShell()
    } else this.publish(state, Boolean(retainedId && !state.error))
    const acknowledged = this.state()
    // Typing changes no history. Its own acknowledgement settles the save; observed pushes update the rest.
    if (command.type === 'compose' || command.type === 'save-thread-draft') {
      try { await this.retainedDrafts.flush() }
      catch { return { ...acknowledged, error: 'This computer could not save your draft. Keep your text and images and try saving again.' } }
      return { ...acknowledged, error: state.error }
    }
    // An early start changes nothing in the thread, and a session it opens shows in the host's next push. Reading the
    // thread here would cost a whole-thread read just before the send and could show an error the start never shows (#769).
    if (command.type === 'start-thread-session') return acknowledged
    // Receipt evidence is optional after acknowledgement. A failed read preserves the command-local
    // outcome and leaves its saved answer held until an exact positive receipt is recovered later.
    if (answer) await this.refreshRequestAnswer(commandId, answer).catch(() => undefined)
    const receipt = this.acceptedAnswers.get(commandId)
    const accepted = answer !== undefined && receipt !== undefined && receipt.threadId === answer.threadId
      && receipt.providerId === answer.providerId && receipt.requestId === answer.requestId
      && receipt.questionsDigest === answer.questionsDigest
    // The host already confirmed the command. Refresh failures must not invite sending it again.
    try {
      if ('threadId' in command && command.threadId) await this.readThreadDetail(command.threadId)
      if (this.catchesUp) { let page = await this.readEvents(this.latestSeq); while (page.hasMore) page = await this.readEvents(this.latestSeq) }
    } catch (error) {
      if (generation === this.generation) {
        const threadId = 'threadId' in command ? command.threadId : undefined
        if (!threadId || !this.reportedTooLarge(threadId, error)) {
          this.pushErrorThread = threadId ?? null
          this.options.onPushError?.('The host confirmed the command, but its latest details could not be read. Nothing was lost. Refresh or reconnect to see them.')
        }
      }
    }
    const refreshed = generation === this.generation ? this.state() : acknowledged
    // State refreshes cannot replace this command's own answer outcome.
    return accepted ? { ...refreshed, error: null }
      : command.type === 'answer' || command.type === 'send' ? { ...refreshed, error: state.error } : refreshed
  }
  async receipt(commandId: string, answer?: HostAnswerTarget): Promise<HostReceipt> {
    return this.read(hostReceiptSchema, await this.call({ op: 'receipt', commandId, ...(answer ? { answer } : {}) }))
  }
  /** Reads an existing attempt's receipt; this never sends the answer again. */
  async refreshRequestAnswer(commandId: string, answer: HostAnswerTarget): Promise<void> {
    if (!this.features.includes('answer-receipts')) return
    const previous = this.answerTargets.get(commandId)
    if (previous && (previous.threadId !== answer.threadId || previous.providerId !== answer.providerId
      || previous.requestId !== answer.requestId || previous.questionsDigest !== answer.questionsDigest)) return
    this.answerTargets.set(commandId, answer)
    while (this.answerTargets.size > 512) this.answerTargets.delete(this.answerTargets.keys().next().value!)
    const generation = this.generation
    const receipt = await this.receipt(commandId, answer)
    this.sameGeneration(generation)
    if (receipt.status === 'completed' && receipt.acceptedAnswer?.decisionId === commandId
      && this.cacheAcceptedAnswer(receipt.acceptedAnswer) && this.cached) this.notifyState()
  }
  /** Replies and opted-in pushes prove the same exact attempt. A negative reply can never undo proof. */
  private cacheAcceptedAnswer(accepted: NonNullable<HostReceipt['acceptedAnswer']>): boolean {
    const target = this.answerTargets.get(accepted.decisionId)
    if (!target || accepted.threadId !== target.threadId || accepted.providerId !== target.providerId
      || accepted.requestId !== target.requestId || accepted.questionsDigest !== target.questionsDigest) return false
    if (this.acceptedAnswers.has(accepted.decisionId)) return false
    this.acceptedAnswers.set(accepted.decisionId, accepted)
    while (this.acceptedAnswers.size > 512) this.acceptedAnswers.delete(this.acceptedAnswers.keys().next().value!)
    return true
  }
  requestAnswerRecovery(threadId: string, providerId: ProviderId): RequestAnswerRecovery {
    return { uncertainRequestIds: this.cached?.host.threads.find(thread => thread.id === threadId)?.requests
      .filter(request => request.delivery === 'uncertain').map(request => request.id) ?? [],
    completed: [...this.acceptedAnswers.values()].filter(item => item.threadId === threadId && item.providerId === providerId)
      .map(({ requestId, questionsDigest, decisionId }) => ({ requestId, questionsDigest, decisionId })) }
  }
  attachmentPreview(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult> {
    const result = this.previewTail.then(async () => this.read(agentAttachmentPreviewResultSchema, await this.call({ op: 'preview', request })))
    this.previewTail = result.catch(() => undefined); return result
  }
  /**
   * Stages an image on the host, which is where the provider reads it (ADR-0031). A host that does not list
   * `attachment-staging` is from before staged images; the version sentence says which side to update, and nothing is
   * sent. Queued behind previews and content reads, since the host takes one of these large frames at a time.
   */
  async stageAttachment(image: AgentAttachmentUpload): Promise<AgentAttachmentHandle> {
    if (!this.features.includes('attachment-staging')) throw new HostConnectionError(this.mismatch(), 'version_mismatch')
    const result = this.previewTail.then(async () => {
      const data = Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString('base64')
      return this.read(agentAttachmentHandleSchema, await this.call({ op: 'stage-attachment', image: { name: image.name, mimeType: image.mimeType, data,
        ...(image.dimensions ? { dimensions: image.dimensions } : {}) } }))
    })
    this.previewTail = result.catch(() => undefined); return result
  }
  /** A staged image's bytes, queued behind previews: the host answers one of these large frames at a time. */
  attachmentContent(digest: string): Promise<AgentAttachmentContent | null> {
    if (!this.features.includes('attachment-staging')) return Promise.resolve(null)
    const result = this.previewTail.then(async () => {
      const content = this.read(hostAttachmentContentSchema, await this.call({ op: 'attachment-content', digest }))
      // A copy of exactly these bytes, never a view on a buffer another value may share.
      return content ? { mimeType: content.mimeType, bytes: new Uint8Array(Buffer.from(content.data, 'base64')) } : null
    })
    this.previewTail = result.catch(() => undefined); return result
  }
  /** A host that does not list `git-refs` is from before the branch picker; the version sentence says which side to bring up to date, and nothing is sent. */
  async gitRefs(request: GitRefsRequest): Promise<GitRefsPage> {
    if (!this.features.includes('git-refs')) throw new HostConnectionError(this.mismatch(), 'version_mismatch')
    return this.read(gitRefsPageSchema, await this.call({ op: 'git-refs', request }))
  }
  async gitChangedFiles(request: GitChangedFilesRequest): Promise<GitChangedFiles> {
    if (!this.features.includes('git-changed-files')) throw new HostConnectionError(this.mismatch(), 'version_mismatch')
    return this.read(gitChangedFilesSchema, await this.call({ op: 'git-changed-files', request }))
  }
  async gitPullRequest(request: GitPullRequestRequest): Promise<GitPullRequestDetail | null> {
    if (!this.features.includes('git-pull-request')) throw new HostConnectionError(this.mismatch(), 'version_mismatch')
    return this.read(gitPullRequestResultSchema, await this.call({ op: 'git-pull-request', request }))
  }
  /** A host that does not list `host-folders` is from before the folder browser; the version sentence says which side to bring up to date, and nothing is sent. */
  async hostFolders(request: HostFoldersRequest): Promise<HostFoldersResult> {
    if (!this.features.includes('host-folders')) throw new HostConnectionError(this.mismatch(), 'version_mismatch')
    return this.read(hostFoldersResultSchema, await this.call({ op: 'host-folders', request }))
  }
  /**
   * A thread's Files, Changes and Agents read on the host (ADR-0025, October 5 amendment). A host that does not list the
   * surface's feature is from before it; the version sentence says which side to bring up to date, and nothing is sent.
   * A file's preview and a comparison can be large, so they queue behind previews: the host takes one at a time.
   */
  async threadFiles(request: FileListRequest): Promise<FilesResult<FileListing>> {
    this.offers('thread-files')
    return this.read(filesResultSchema(fileListingSchema), await this.call({ op: 'thread-files', request }))
  }
  threadFilePreview(request: FileRequest): Promise<FilesResult<FilePreview>> {
    return this.large('thread-files', async () => this.read(filesResultSchema(filePreviewSchema), await this.call({ op: 'thread-file-preview', request })))
  }
  async gitChanges(request: ToolListRequest): Promise<ToolsResult<GitChangeListing>> {
    this.offers('thread-changes')
    return this.read(toolsResultSchema(gitListingSchema), await this.call({ op: 'thread-changes', request }))
  }
  gitReview(request: GitReviewRequest): Promise<ToolsResult<GitReview>> {
    return this.large('thread-changes', async () => this.read(toolsResultSchema(gitReviewSchema), await this.call({ op: 'thread-changes-review', request })))
  }
  async subagentPage(request: SubagentPageRequest): Promise<SubagentPage> {
    this.offers('subagents')
    return this.read(subagentPageSchema, await this.call({ op: 'subagent-page', request }))
  }
  async subagentAssignments(request: SubagentAssignmentsRequest): Promise<SubagentAssignmentsPage> {
    this.offers('subagents')
    return this.read(subagentAssignmentsPageSchema, await this.call({ op: 'subagent-assignments', request }))
  }
  /** Refuses with the version sentence, before anything is sent, a read whose feature this host does not list. */
  private offers(feature: HostFeature): void {
    if (!this.features.includes(feature)) throw new HostConnectionError(this.mismatch(), 'version_mismatch')
  }
  /** A large read, queued behind previews and staged images: the host answers one of these frames at a time per client. */
  private large<T>(feature: HostFeature, read: () => Promise<T>): Promise<T> {
    try { this.offers(feature) } catch (error) { return Promise.reject(error) }
    const result = this.previewTail.then(read)
    this.previewTail = result.catch(() => undefined); return result
  }
  /** Whether the host runs its providers' sign-ins for this client (ADR-0037). */
  offersSignIn(): boolean { return this.features.includes('provider-sign-in') }
  /** Whether the host shows its client updates to this client and runs them for it (#480). */
  offersClientUpdates(): boolean { return this.features.includes('client-updates') }
  /**
   * A provider's own sign-in on the host (ADR-0037). The answer carries the page's address and the code while it waits;
   * the caller hands the window neither the address nor anything to keep. A host that does not list `provider-sign-in`
   * is from before it; the version sentence says which side to bring up to date, and nothing is sent.
   */
  async signIn(operation: { op: 'sign-in-start'; provider: ProviderId } | { op: 'sign-in-read' | 'sign-in-cancel'; signInId: string } | { op: 'sign-in-code'; signInId: string; code: string }): Promise<HostSignIn | null> {
    if (!this.offersSignIn()) throw new HostConnectionError(this.mismatch(), 'version_mismatch')
    return this.read(hostSignInSchema.nullable(), await this.call(operation))
  }
  async revokePairing(): Promise<void> {
    const response = await fetch(this.endpoint('/v1/revoke'), { method: 'POST', headers: { Authorization: 'Bearer ' + this.options.token }, signal: AbortSignal.timeout(15000), redirect: 'error' })
    if (!response.ok) throw refusal(response.status, 'The host could not forget this device. Connect again and retry.', 'unavailable')
    await this.close()
  }
  async close(): Promise<void> { this.resetComposeQueue(); this.generation++; this.opening?.abort(); this.frames?.close() }
}
