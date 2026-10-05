import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { isIP } from 'node:net'
import { z } from 'zod'
import type { HostService, ClientIdentity } from '../main/agents/hostService'
import { PairedClients, originAllowed, SESSION_LIFETIME_MS } from '../main/agents/pairing'
import { coalesceAgentStatePublishes, coalesceAgentThreadDetailPublishes } from '../main/agents/control'
import { ModelCatalogRevisions } from '../main/agents/agentStateBroadcast'
import { RefusedImage } from '../main/agents/attachmentStore'
import { shellForProtocolV1, clientUpdateForOlderClient, deltaWithActivitySummaries, detailWithActivitySummaries, HOST_BUSY, HOST_EVENT_PAGE_SIZE, HOST_FEATURES, HOST_MAX_FRAME_BYTES, HOST_SESSION_REJECTED, hostRequestEnvelopeSchema, hostRequestSchema, type HostDescriptor, type HostErrorCode, type HostPush, type HostReceipt, type HostRequest, type HostResponse, type HostClientShell, type HostWireShell } from '../shared/hostProtocol'
import { hostCatalogKey, type AgentCommand, type AgentThreadDetail, type AgentThreadDetailDelta } from '../shared/agents'
import { isAgentThreadDetailDelta } from '../shared/agentThreadDetail'
import { resolveModel } from '../shared/modelCatalog'
import { version as packageVersion } from '../../package.json'
import { REMOTE_PERMISSION_DENIED } from '../main/agents/authority'
import { REMOTE_SIGN_IN_OPERATIONS, remoteCommandRefusal } from './remoteCommands'
import { ProviderSignInRefusal, type ProviderSignIns } from './providerSignIn'
import { SocketFrames } from './socketFrames'
import { hostPhonesCommandSchema, type HostPhonesCommand, type PhonesState } from '../shared/phones'

const errors: Record<HostErrorCode, string> = {
  unauthenticated: HOST_SESSION_REJECTED,
  invalid_request: 'This request is not supported. Update this client and try again.',
  stale_request: 'This request has already changed or been answered. Refresh the thread before answering.',
  forbidden: REMOTE_PERMISSION_DENIED,
  unavailable: 'The host could not complete this request. Refresh the thread before trying again.',
  busy: 'The host has too many pending requests. Wait for them to finish and try again.',
  too_large: 'A thread on this host is too large to send to this device. Nothing on the host was lost, and the thread keeps working there. Your other threads still load here.',
}
/**
 * An oversize message is named by what it carried: one thread's detail, an attachment preview, or the
 * thread list (a shell push, the hello, an event page, or the shell a command answers with). The headless
 * host has no window, so none of these sends the user to the host machine; each says what was kept instead.
 */
type Oversize = 'thread' | 'preview' | 'list'
const TOO_LARGE: Record<Oversize, string> = {
  thread: errors.too_large,
  preview: 'This attachment is too large to preview on this device. Nothing on the host was lost, and the attachment is unchanged there.',
  list: 'The thread list on this host is too large to send to this device. Nothing on the host was lost, and this device keeps the last list it received.',
}
/** A refusal the client reads: its code, and a sentence, which is the code's own unless the refusal says more. */
class Refusal extends Error { constructor(readonly code: HostErrorCode, message = errors[code]) { super(message) } }
/**
 * `deltas` is set by the client's hello: only a client that accepts `detail-delta` is sent one. `clientUpdates` likewise:
 * only a client that accepts `client-updates` is sent the mise channel and the waiting state in its shell's client updates.
 * `catalogRevisions` too: only a client that accepts `model-catalog-revision` is sent a shell without its model catalog,
 * and `catalogSent` is the catalog revision a frame written to this connection last carried whole, or null.
 * `activitySummaries` too: only a client that accepts `activity-summaries` is sent activity records as their summaries.
 *
 * `held` is the revision of each observed thread's detail the client holds, as far as what it was sent says: set by a
 * whole detail that went, moved on by a delta that followed it, and dropped by a push that could not go or a delta that
 * did not follow it. `opening` is each observed thread still owed its first whole detail. `sentAhead` holds each whole
 * detail this client was sent while that copy was still waiting out the coalescing window, so it is not sent again (#700).
 */
interface Peer { frames: SocketFrames; client: ClientIdentity; session: string; observed: Set<string>; held: Map<string, number>; opening: Set<string>; sentAhead: WeakSet<AgentThreadDetail>; inFlight: number; window: number; count: number; pageWindow: number; pages: number; preview: boolean; ready: boolean; afterSeq: number; selectedThreadId: string | null; selectedProjectId: string | null; editingThreadId: string | null; deltas: boolean; messageAliases: boolean; clientUpdates: boolean; activitySummaries: boolean; catalogRevisions: boolean; catalogSent: number | null }
/** A shell ready to write to one peer, and the catalog revision it carries whole, if any, to record once it is written. */
interface WireShell { state: HostWireShell; carries: number | null }
export interface SocketServerOptions {
  service: HostService; pairing: PairedClients; port?: number; origins?: readonly string[]
  mayAnswer?: (client: ClientIdentity) => boolean
  setAnswers?: (clientId: string, allowed: boolean) => void
  /** Tests shorten the replay window and the cap; the host keeps the defaults. */
  receipts?: { lifetimeMs?: number; limit?: number; now?: () => number }
  /** Tests stand in for a host of another Sotto version; the host advertises its own. */
  sottoVersion?: string
  /**
   * False turns the administrative routes off. The desktop administers its phone listener in-process, so
   * it has no admin token to keep; only the headless host, whose own command line uses them, needs them.
   */
  admin?: boolean
  /** The computer's name as paired phones show it, read on each health request (ADR-0033). Health omits it when absent. */
  name?: () => string | undefined
  /** Told once a pairing code is redeemed, so a desktop showing the code can close it and list the new client. */
  onPaired?: (clientId: string) => void
  /** Told when a paired client's socket opens or closes, or a client unpairs itself. */
  onPeersChanged?: () => void
  /**
   * A headless host's providers' own sign-ins, run here for the paired client that asks (ADR-0037). Absent on the
   * desktop's phone listener, which then neither lists `provider-sign-in` nor answers its requests.
   */
  signIns?: Pick<ProviderSignIns, 'start' | 'read' | 'code' | 'cancel'>
  /**
   * The headless host updates its clients for a paired client that asks (`queue-client-updates`, #480). Absent on the
   * desktop's phone listener, which then neither lists `client-updates` nor takes the command.
   */
  clientUpdates?: boolean
  /**
   * The headless host's own phone access (ADR-0050), read and changed on the administrative routes by the desktop that
   * reaches this host over SSH. Absent on the desktop's phone listener, whose administrative routes are off anyway.
   */
  phones?: HostPhonesAdministration
}
/** What the administrative phone routes answer: the state after the command, and Tailscale's page or a refusal when it gave one. */
export interface HostPhonesAnswer { readonly state: PhonesState; readonly url?: string | undefined; readonly error?: string | undefined }
export interface HostPhonesAdministration {
  get(): PhonesState
  command(command: HostPhonesCommand): Promise<HostPhonesAnswer>
}
/**
 * A settled receipt answers a retried command for this long, which covers a reconnect after a lost
 * acknowledgement; after it the entry is dropped, so a host that runs for weeks never fills up.
 */
const RECEIPT_LIFETIME_MS = 5 * 60_000
const RECEIPT_LIMIT = 10_000
/**
 * A peer sending more than this many messages in a second is closed, except for event pages, which are
 * paced instead: a page past its own budget waits for the next second. A client reading a long log one
 * page after another is doing what the protocol asks, and closing it would only have it start again.
 */
const MESSAGES_PER_SECOND = 100
const EVENT_PAGES_PER_SECOND = 100
/**
 * HTTP requests a minute, per endpoint class, so no caller can spend another's budget. Health is not
 * counted: refusing it costs as much as answering it, and the launch script polls it while a host starts.
 * Failed pairing redemptions have a small bucket per caller, checked before redemption. The administrative path, and sessions and revocations per paired
 * client, are counted only after their token is checked, so a loop on a bad token spends nobody's budget.
 */
const HTTP_BUDGETS = { pair: 10, admin: 120, client: 120 } as const
const HTTP_WINDOW_MS = 60_000
/** Selecting and observing only move this client's own view; repeating one is harmless, so they keep no receipt. */
const UNRECEIPTED = new Set<string>(['select-thread', 'select-project', 'observe-threads'])
/** Only this listener owns sockets; clients never get a provider handle or a claimed identity. */
export async function startSocketServer(options: SocketServerOptions) {
  const { service, pairing } = options
  const sottoVersion = options.sottoVersion ?? packageVersion
  const hostId = service.shell().hostId
  if (!hostId) throw new Error('The host must have an identity before listening.')
  const features = HOST_FEATURES.filter(feature => (feature !== 'provider-sign-in' || options.signIns !== undefined)
    && (feature !== 'client-updates' || options.clientUpdates === true))
  const { signIns } = options
  /** A sign-in's own refusal keeps its sentence; anything else is the host's failure to run it. */
  const signingIn = async <T>(op: HostRequest['op'], run: () => T | Promise<T>): Promise<T> => {
    if (!signIns || !(REMOTE_SIGN_IN_OPERATIONS as readonly string[]).includes(op)) throw new Refusal('invalid_request')
    try { return await run() } catch (error) { throw error instanceof ProviderSignInRefusal ? new Refusal('unavailable', error.message) : new Refusal('unavailable') }
  }
  const adminToken = randomBytes(32).toString('base64url')
  const peers = new Set<Peer>(), operations = new Set<Promise<unknown>>()
  const receipts = new Map<string, { digest: string; receipt: HostReceipt; task: Promise<unknown>; settledAt?: number }>()
  const receiptLifetime = options.receipts?.lifetimeMs ?? RECEIPT_LIFETIME_MS, receiptLimit = options.receipts?.limit ?? RECEIPT_LIMIT
  const clock = options.receipts?.now ?? Date.now
  /** Drops receipts settled longer ago than the replay window, then the oldest settled one if still full. Only pending work is busy. */
  const makeRoomForReceipt = (): void => {
    const now = clock()
    for (const [key, entry] of receipts) if (entry.settledAt !== undefined && now - entry.settledAt > receiptLifetime) receipts.delete(key)
    if (receipts.size < receiptLimit) return
    for (const [key, entry] of receipts) if (entry.settledAt !== undefined) { receipts.delete(key); return }
    throw new Refusal('busy')
  }
  let closing = false
  const httpBudgets = new Map<string, { window: number; count: number }>()
  /** Counts one request against a bucket, dropping buckets whose minute has passed, and refuses past its limit. */
  const spend = (bucket: string, limit: number): (() => void) => {
    const now = Date.now()
    for (const [key, entry] of httpBudgets) if (now - entry.window >= HTTP_WINDOW_MS) httpBudgets.delete(key)
    const entry = httpBudgets.get(bucket) ?? { window: now, count: 0 }
    if (!httpBudgets.has(bucket) && httpBudgets.size >= 1024) httpBudgets.delete(httpBudgets.keys().next().value!)
    httpBudgets.set(bucket, entry)
    if (entry.count >= limit) throw new Refusal('busy')
    entry.count++
    return () => { entry.count-- }
  }
  const identity = (clientId: string): ClientIdentity => ({ clientId, user: pairing.list().find(client => client.clientId === clientId)?.name ?? 'Paired client', transport: 'socket' })
  const shell = (peer: Peer) => {
    const state = service.shell()
    const draft = peer.editingThreadId === peer.selectedThreadId
      ? state.threadDrafts?.find(item => item.threadId === peer.selectedThreadId) : undefined
    const composer = draft ? { composing: true, draft: draft.text, draftAttachments: draft.attachments,
      draftThreadId: draft.threadId, draftRequestId: draft.requestId }
      : state.draftThreadId === peer.selectedThreadId ? {}
        : { composing: false, draft: '', draftAttachments: [], draftThreadId: null, draftRequestId: null }
    const own = shellForProtocolV1({ ...state, activeThreadId: peer.selectedThreadId, activeProjectId: peer.selectedProjectId,
      ...composer,
      clientCapabilities: { mayAnswer: options.mayAnswer?.(peer.client) ?? false } })
    // A client from before #480 reads the client updates' channel and state against the values it knows, and one it
    // does not know would make it refuse the whole shell: it is sent them as it knew them.
    return peer.clientUpdates || !state.clientUpdates ? own : { ...own, clientUpdates: state.clientUpdates.map(clientUpdateForOlderClient) }
  }
  /**
   * The catalog revisions this listener names to peers that accept `model-catalog-revision`. One counter for every
   * peer, so a revision names one catalog for as long as the listener runs; what each peer was sent is its own.
   */
  const catalogRevisions = new ModelCatalogRevisions()
  /**
   * A shell as it goes to `peer`, at the moment it is written. A peer that does not accept `model-catalog-revision`
   * gets it whole, as v1 has it. One that does is told the catalog's revision, and sent the catalog itself only when
   * no frame written to this connection has carried that revision whole yet. The caller records `carries` as sent
   * only once its frame was written, never when a too_large error went in its place.
   */
  const wireShell = (peer: Peer, state: HostClientShell): WireShell => {
    if (!peer.catalogRevisions) return { state, carries: null }
    const modelsRevision = catalogRevisions.revisionFor(hostCatalogKey(state.host.hostId), state.host.models)
    const host: HostWireShell['host'] = { ...state.host, modelsRevision }
    if (peer.catalogSent !== modelsRevision) return { state: { ...state, host }, carries: modelsRevision }
    delete host.models
    return { state: { ...state, host }, carries: null }
  }
  const recordCatalog = (peer: Peer, shell: WireShell): void => { if (shell.carries !== null) peer.catalogSent = shell.carries }
  const authenticated = (peer: Peer): boolean => pairing.verifySession(peer.session) === peer.client.clientId
  const fits = (text: string): boolean => Buffer.byteLength(text) <= HOST_MAX_FRAME_BYTES
  /**
   * Sends one message, or an explicit too_large error in its place when it would not fit in a frame, and
   * says whether the message itself went. Closing the socket instead would only have the client reconnect
   * and be sent the same message again.
   */
  const deliver = (peer: Peer, value: HostPush | HostResponse, carried: Oversize): boolean => {
    const text = JSON.stringify(value)
    if (fits(text)) { peer.frames.sendText(text); return true }
    const error = { code: 'too_large' as const, message: TOO_LARGE[carried] }
    const thread = 'event' in value && (value.event === 'detail' || value.event === 'detail-delta')
    peer.frames.send('event' in value ? { v: 1, event: 'error', ...(thread ? { threadId: value.threadId } : {}), error } : { v: 1, id: value.id, ok: false, error })
    return false
  }
  const push = (peer: Peer, value: HostPush): boolean => { if (!authenticated(peer)) { peer.frames.close(); return false } return deliver(peer, value, value.event === 'detail' || value.event === 'detail-delta' ? 'thread' : 'list') }
  const events = (peer: Peer, afterSeq: number, threadId?: string) => {
    const all = service.events(afterSeq, threadId, HOST_EVENT_PAGE_SIZE + 1), page = all.slice(0, HOST_EVENT_PAGE_SIZE)
    return { events: peer.messageAliases ? page : page.filter(row => row.event.kind !== 'message-aliased'), latestSeq: page.at(-1)?.seq ?? afterSeq, hasMore: all.length > page.length }
  }
  const observe = async (): Promise<void> => {
    const ids = [...new Set([...peers].flatMap(peer => [...peer.observed]))]
    await service.command({ type: 'observe-threads', threadIds: ids }, { clientId: 'socket-observations', user: '', transport: 'socket' })
  }
  const track = <T>(task: Promise<T>): Promise<T> => { operations.add(task); void task.finally(() => operations.delete(task)).catch(() => undefined); return task }
  /** A thread let go is no longer kept current for this client, so it starts over when it is observed again. */
  const setObserved = (peer: Peer, threadIds: readonly string[]): void => {
    peer.observed = new Set(threadIds)
    for (const id of peer.held.keys()) if (!peer.observed.has(id)) peer.held.delete(id)
    for (const id of peer.opening) if (!peer.observed.has(id)) peer.opening.delete(id)
  }
  /** Each whole detail's activity summaries, made once however many peers accept them (#701); every other peer is sent it whole. */
  const summarised = new WeakMap<AgentThreadDetail, AgentThreadDetail>()
  const forPeer = (peer: Peer, detail: AgentThreadDetail | null): AgentThreadDetail | null => {
    if (!peer.activitySummaries || detail === null) return detail
    let summary = summarised.get(detail)
    if (!summary) summarised.set(detail, summary = detailWithActivitySummaries(detail))
    return summary
  }
  const sendWhole = (peer: Peer, threadId: string, detail: AgentThreadDetail | null): void => {
    peer.opening.delete(threadId)
    if (push(peer, { v: 1, event: 'detail', threadId, detail: forPeer(peer, detail) }) && detail) peer.held.set(threadId, detail.revision)
    else peer.held.delete(threadId)
  }
  const detail = (peer: Peer, threadId: string): void => { sendWhole(peer, threadId, service.threadDetail(threadId)) }
  // A streaming thread changes the shell many times a second. Pushes go out at most once a window, the
  // same way the desktop's own IPC coalesces them, and each carries the state as it is when it is sent.
  // Details come through their own subscription when the service has one, so a shell change resends no history.
  const detailsFollowShell = service.subscribeThreadDetail === undefined
  // The peer's event cursor moves only once the events have gone or the client has been told to fetch them:
  // a page too large to ride along is left behind and the shell says there is more, so the client reads
  // the events itself from its own cursor instead of never being sent them.
  // A shell goes to a peer only once its socket has drained what it was last sent (#698). A phone on a slow
  // link still reading one shell is owed the next instead, and sent the newest, built then, once it drains:
  // one shell can be a megabyte, and twenty a second would fill the socket until it closed. Its cursor has
  // not moved, so that shell's event page holds every event the skipped ones would have carried. Whole
  // details that follow the shell wait with it, the newest standing for any skipped; detail-delta pushes
  // and responses are never held, so no delta loses the revision it applies to.
  const owedShell = new WeakSet<Peer>()
  const sendShell = (peer: Peer): void => {
    if (!authenticated(peer)) { peer.frames.close(); return }
    if (peer.frames.backlogged) {
      if (owedShell.has(peer)) return
      owedShell.add(peer)
      void track(peer.frames.drained().then(() => { owedShell.delete(peer); if (!closing && !peer.frames.isClosed) sendShell(peer) }))
      return
    }
    const wire = wireShell(peer, shell(peer)), state = wire.state, eventPage = events(peer, peer.afterSeq)
    const full = JSON.stringify({ v: 1, event: 'shell', state, eventPage })
    if (fits(full)) { peer.frames.sendText(full); peer.afterSeq = eventPage.latestSeq; recordCatalog(peer, wire) }
    else if (push(peer, { v: 1, event: 'shell', state, eventPage: { events: [], latestSeq: peer.afterSeq, hasMore: true } })) { peer.afterSeq = eventPage.latestSeq; recordCatalog(peer, wire) }
    if (detailsFollowShell) for (const threadId of peer.observed) detail(peer, threadId)
  }
  const shellPublisher = coalesceAgentStatePublishes(() => {
    for (const peer of peers) {
      if (!authenticated(peer)) { peer.frames.close(); continue }
      if (peer.ready) sendShell(peer)
    }
  })
  // Each observed thread's update goes out as the service published it: a whole detail as one, and a delta
  // (what changed since the revision the client holds) as a detail-delta to every client that accepts
  // one. A client applies a delta only to the revision it was measured from and asks for the whole detail
  // otherwise. A client that never accepted deltas, from before protocol v1 froze, is sent the whole thread.
  // A delta of activity summaries is made once for every peer that accepts both.
  // A client still owed its first copy of a thread is sent no delta: the copy it is about to be sent is current.
  // A delta no newer than what the client holds is already covered, and a whole it was sent ahead goes no second time.
  /** The latest whole detail the service published for each thread that has not gone out yet. */
  const waiting = new Map<string, AgentThreadDetail>()
  const detailPublisher = coalesceAgentThreadDetailPublishes(update => {
    const threadId = update.threadId
    waiting.delete(threadId)
    let whole: AgentThreadDetail | null | undefined = isAgentThreadDetailDelta(update) ? undefined : update
    let summaries: AgentThreadDetailDelta | undefined
    for (const peer of peers) {
      if (!peer.observed.has(threadId)) continue
      if (!isAgentThreadDetailDelta(update)) { if (!peer.sentAhead.has(update)) sendWhole(peer, threadId, update); continue }
      const held = peer.held.get(threadId)
      if (peer.opening.has(threadId) || held !== undefined && update.revision <= held) continue
      if (!peer.deltas) { sendWhole(peer, threadId, whole === undefined ? (whole = service.threadDetail(threadId)) : whole); continue }
      if (push(peer, { v: 1, event: 'detail-delta', threadId, delta: peer.activitySummaries ? (summaries ??= deltaWithActivitySummaries(update)) : update }) && held === update.baseRevision) peer.held.set(threadId, update.revision)
      else peer.held.delete(threadId)
    }
  })
  const unsubscribe = service.subscribe(state => shellPublisher.publish(state))
  // A whole the service published may still be waiting out the coalescing window when a client starts observing
  // its thread. The client is sent that copy before its observe is acknowledged, and it does not follow a second time.
  // An entry lasts only until the thread's next update goes out, which carries or follows it.
  const unsubscribeDetails = service.subscribeThreadDetail?.(update => {
    if (!isAgentThreadDetailDelta(update)) waiting.set(update.threadId, update)
    detailPublisher.publish(update)
  })
  /** The permission settings of a new or changed thread's model that let the provider do nothing unasked. */
  const askingProviderModes = (input: AgentCommand): string[] => {
    if (input.type !== 'create-thread' && input.type !== 'configure-thread') return []
    const host = service.shell().host
    const modelId = input.modelId ?? (input.type === 'configure-thread' ? host.threads.find(thread => thread.id === input.threadId)?.modelId : undefined)
    return resolveModel(host.models, modelId)?.providerModes?.filter(mode => mode.allows === 'nothing').map(mode => mode.id) ?? []
  }
  const command = async (peer: Peer, request: Extract<HostRequest, { op: 'command' }>): Promise<unknown> => {
    const key = peer.client.clientId + ':' + request.id
    const digest = createHash('sha256').update(JSON.stringify(request.command)).digest('hex')
    const previous = receipts.get(key)
    if (previous) {
      if (previous.digest !== digest) throw new Refusal('invalid_request')
      await previous.task
      if (previous.receipt.error) throw new Refusal(previous.receipt.error.code)
      return shell(peer)
    }
    const input = request.command
    const state = service.shell()
    const targetThreadId = peer.selectedThreadId
    const savedDraft = state.draftThreadId !== targetThreadId || !state.composing && !state.draft.trim() && !state.draftAttachments?.length
      ? state.threadDrafts?.find(draft => draft.threadId === targetThreadId) : undefined
    const draftRequestId = state.composing && state.draftThreadId === targetThreadId ? state.draftRequestId
      : savedDraft ? savedDraft.requestId
        : state.queue.find(item => item.threadId === targetThreadId && item.kind === 'question' && item.requestId)?.requestId
    const refusal = remoteCommandRefusal(input, { mayAnswer: options.mayAnswer?.(peer.client) ?? false, askingProviderModes: askingProviderModes(input),
      draftRequestId: input.type === 'send' || input.type === 'compose' ? draftRequestId : undefined,
      clientUpdates: options.clientUpdates === true })
    if (refusal) throw new Refusal(refusal)
    if (input.type === 'preview-reclaim-thread-worktree') {
      const result = await service.command(input, peer.client)
      return { ...shell(peer), error: result.error, ...(result.worktreeReclaimPreview ? { worktreeReclaimPreview: result.worktreeReclaimPreview } : {}) }
    }
    const recorded = !UNRECEIPTED.has(input.type)
    if (recorded) makeRoomForReceipt()
    if (input.type === 'answer') {
      const thread = service.shell().host.threads.find(thread => thread.id === input.threadId)
      if (!thread?.requests.some(item => item.id === input.requestId && !item.delivery)) throw new Refusal('stale_request')
    }
    const receipt: HostReceipt = { status: 'pending' }
    let privateError: string | null | undefined
    const task = (async () => {
      try {
        if (input.type === 'select-thread') {
          const thread = service.shell().host.threads.find(thread => thread.id === input.threadId)
          if (!thread) throw new Refusal('invalid_request')
          peer.selectedThreadId = thread.id; peer.selectedProjectId = thread.projectId
        } else if (input.type === 'select-project') {
          peer.selectedProjectId = input.projectId; peer.selectedThreadId = null
        } else if (input.type === 'observe-threads') {
          setObserved(peer, input.threadIds); await observe()
        } else {
          const previousEditor = peer.editingThreadId
          if (input.type === 'compose') peer.editingThreadId = peer.selectedThreadId
          const result = await service.command(input, { ...peer.client, selectedThreadId: peer.selectedThreadId })
          if (input.type === 'compose' && result.error) peer.editingThreadId = previousEditor
          if (['pause-draft', 'cancel-draft', 'send'].includes(input.type) && !result.error) peer.editingThreadId = null
          if (input.type === 'answer' || input.type === 'send') privateError = result.error
          if (input.type === 'answer' || input.type === 'send' && draftRequestId) {
            receipt.answerDelivered = result.error == null
            if (!receipt.answerDelivered) receipt.error = { code: 'unavailable', message: errors.unavailable }
          }
        }
        receipt.status = 'completed'
      } catch { receipt.status = 'completed'; receipt.error = { code: 'unavailable', message: errors.unavailable }; throw new Refusal('unavailable') }
    })()
    if (recorded) {
      const entry: { digest: string; receipt: HostReceipt; task: Promise<unknown>; settledAt?: number } = { digest, receipt, task }
      receipts.set(key, entry)
      const settle = (): void => { entry.settledAt = clock() }
      void task.then(settle, settle)
    }
    await task
    return privateError === undefined ? shell(peer) : { ...shell(peer), error: privateError }
  }
  const dispatch = async (peer: Peer, request: HostRequest): Promise<unknown> => {
    if (closing) throw new Refusal('unavailable')
    if (request.session !== peer.session || !authenticated(peer)) throw new Refusal('unauthenticated')
    switch (request.op) {
      case 'hello':
        peer.frames.setClientLiveness(request.accepts?.includes('client-liveness') ?? false)
        peer.messageAliases = request.accepts?.includes('message-aliases') ?? false
        peer.afterSeq = request.afterSeq ?? Number.MAX_SAFE_INTEGER; peer.deltas = request.accepts?.includes('detail-delta') ?? false
        peer.clientUpdates = request.accepts?.includes('client-updates') ?? false
        peer.catalogRevisions = request.accepts?.includes('model-catalog-revision') ?? false
        peer.activitySummaries = request.accepts?.includes('activity-summaries') ?? false
        return { hostId, clientId: peer.client.clientId, shell: shell(peer), capabilities: { mayAnswer: options.mayAnswer?.(peer.client) ?? false }, sottoVersion, features: [...features], ...events(peer, peer.afterSeq) }
      case 'shell': return shell(peer)
      case 'detail': return forPeer(peer, service.threadDetail(request.threadId))
      case 'events': return events(peer, request.afterSeq, request.threadId)
      case 'receipt': return receipts.get(peer.client.clientId + ':' + request.commandId)?.receipt ?? { status: 'unknown' }
      case 'observe': {
        // Only a thread this client does not hold is sent whole: one it holds is kept current by the pushes that follow
        // it. The service publishes a newly observed thread whole as it is observed, and that copy is the one sent.
        setObserved(peer, request.threadIds)
        const owed = [...peer.observed].filter(id => !peer.held.has(id))
        for (const id of owed) peer.opening.add(id)
        try { await observe() } catch (error) { for (const id of owed) peer.opening.delete(id); throw error }
        for (const id of owed) {
          if (!peer.opening.has(id)) continue
          await peer.frames.drained(); if (peer.frames.isClosed) break
          if (!peer.opening.has(id)) continue
          // A copy still waiting is sent now in its place, so the thread is neither read again nor sent twice.
          const offered = waiting.get(id)
          if (offered) { peer.sentAhead.add(offered); sendWhole(peer, id, offered) } else detail(peer, id)
        }
        await peer.frames.drained()
        return null
      }
      case 'command': return command(peer, request)
      case 'git-refs':
        if (!service.gitRefs) throw new Refusal('invalid_request')
        try { return await service.gitRefs(request.request) } catch { throw new Refusal('unavailable') }
      case 'git-changed-files':
        if (!service.gitChangedFiles) throw new Refusal('invalid_request')
        try { return await service.gitChangedFiles(request.request) } catch { throw new Refusal('unavailable') }
      case 'git-pull-request':
        if (!service.gitPullRequest) throw new Refusal('invalid_request')
        try { return await service.gitPullRequest(request.request) } catch { throw new Refusal('unavailable') }
      case 'host-folders':
        if (!service.hostFolders) throw new Refusal('invalid_request')
        try { return await service.hostFolders(request.request) } catch { throw new Refusal('unavailable') }
      case 'stage-attachment': {
        if (!service.stageAttachment) throw new Refusal('invalid_request')
        // Up to about 14 MB of base64 in, and 10 MiB held until it is kept: one at a time per peer, on the preview's guard.
        if (peer.preview) throw new Refusal('busy')
        peer.preview = true
        const bytes = Buffer.from(request.image.data, 'base64')
        try {
          return await service.stageAttachment({ name: request.image.name, mimeType: request.image.mimeType, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            ...(request.image.dimensions ? { dimensions: request.image.dimensions } : {}) })
        }
        catch (error) {
          // An image refused for what it is says so; anything else is the host's failure to keep it.
          if (error instanceof RefusedImage) throw new Refusal('invalid_request', error.message)
          throw new Refusal('unavailable')
        } finally { peer.preview = false }
      }
      case 'attachment-content': {
        // Up to about 14 MB of base64: one at a time per peer, on the same guard as a preview.
        if (peer.preview) throw new Refusal('busy')
        peer.preview = true
        try {
          const content = await service.attachmentContent?.(request.digest) ?? null
          return content && { mimeType: content.mimeType, data: Buffer.from(content.bytes).toString('base64') }
        } finally { peer.preview = false }
      }
      // Only the client that started a sign-in reads it, sends its code or cancels it (ADR-0037).
      case 'sign-in-start': return signingIn(request.op, () => signIns!.start(request.provider, peer.client.clientId))
      case 'sign-in-read': return signingIn(request.op, () => signIns!.read(request.signInId, peer.client.clientId))
      case 'sign-in-code': return signingIn(request.op, () => signIns!.code(request.signInId, peer.client.clientId, request.code))
      case 'sign-in-cancel': return signingIn(request.op, () => { signIns!.cancel(request.signInId, peer.client.clientId); return null })
      case 'preview':
        if (peer.preview) throw new Refusal('busy')
        peer.preview = true
        try { return await service.attachmentPreview?.(request.request) ?? null } finally { peer.preview = false }
    }
  }
  const onMessage = (peer: Peer, text: string): void => {
    let raw: unknown
    try { raw = JSON.parse(text) } catch { peer.frames.close(); return }
    const parsed = hostRequestSchema.safeParse(raw)
    const envelope = parsed.success ? parsed.data : hostRequestEnvelopeSchema.safeParse(raw).data
    if (!envelope) { peer.frames.close(); return }
    const now = Date.now()
    // An unreadable request still spends the message budget, so a client cannot loop on one for free.
    let wait = 0
    if (parsed.success && parsed.data.op === 'events') {
      if (now >= peer.pageWindow + 1000) { peer.pageWindow = now; peer.pages = 0 }
      if (peer.pages >= EVENT_PAGES_PER_SECOND) { peer.pageWindow += 1000; peer.pages = 0 }
      peer.pages++; wait = peer.pageWindow - now
    } else {
      if (now - peer.window > 1000) { peer.window = now; peer.count = 0 }
      if (++peer.count > MESSAGES_PER_SECOND) { peer.frames.close(); return }
    }
    if (peer.inFlight >= 32) { peer.frames.close(); return }
    // A request from this session that the host cannot read, such as a client of a newer Sotto version
    // sending an operation or field this one does not know, is refused by its id rather than by closing
    // the socket: the client can then say what happened instead of reconnecting into the same refusal.
    if (!parsed.success) {
      if (envelope.session !== peer.session || !authenticated(peer)) { peer.frames.close(); return }
      peer.frames.send({ v: 1, id: envelope.id, ok: false, error: { code: 'invalid_request', message: errors.invalid_request } }); return
    }
    const request = parsed.data
    peer.inFlight++
    track((async () => {
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      let response: HostResponse
      // The shell a hello, a shell read or a command answers with is encoded for this peer only here, just before it
      // is written, so what this connection was sent of the model catalog follows the order its frames go out in.
      let carried: WireShell | null = null
      try {
        let result = await dispatch(peer, request)
        if (request.op === 'hello') {
          // Hello starts the client's picture afresh, so it carries the catalog whole whatever this connection was sent before.
          const hello = result as { shell: HostClientShell }
          peer.catalogSent = null; carried = wireShell(peer, hello.shell); result = { ...hello, shell: carried.state }
        } else if (request.op === 'shell' || request.op === 'command') { carried = wireShell(peer, result as HostClientShell); result = carried.state }
        response = { v: 1, id: request.id, ok: true, result }
      }
      catch (error) { const code = error instanceof Refusal ? error.code : 'unavailable'; response = { v: 1, id: request.id, ok: false, error: { code, message: error instanceof Refusal ? error.message : errors[code] } } }
      // A revocation while an operation was pending also denies its response.
      if (!authenticated(peer)) { peer.frames.send({ v: 1, id: request.id, ok: false, error: { code: 'unauthenticated', message: errors.unauthenticated } }); peer.frames.close() }
      else if (deliver(peer, response, request.op === 'detail' ? 'thread' : request.op === 'preview' || request.op === 'attachment-content' ? 'preview' : 'list')) {
        if (carried) recordCatalog(peer, carried)
        if (!response.ok) return
        if (request.op === 'detail') {
          // A thread read whole is held at that revision, and the deltas that follow it apply.
          const read = response.result as AgentThreadDetail | null
          if (read && peer.observed.has(request.threadId) && !peer.opening.has(request.threadId)) peer.held.set(request.threadId, read.revision)
        } else if (request.op === 'hello' || (request.op === 'events' && !request.threadId)) {
          if (request.op === 'hello') peer.ready = true
          const latestSeq = (response.result as { latestSeq: number }).latestSeq
          peer.afterSeq = peer.afterSeq === Number.MAX_SAFE_INTEGER ? latestSeq : Math.max(peer.afterSeq, latestSeq)
        }
      }
    })().finally(() => { peer.inFlight-- }))
  }
  const bearer = (request: IncomingMessage): string => /^Bearer ([A-Za-z0-9_.-]{1,2048})$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
  const body = async (request: IncomingMessage): Promise<unknown> => {
    let size = 0; const chunks: Buffer[] = []
    for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 8192) throw new Refusal('invalid_request'); chunks.push(bytes) }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Refusal('invalid_request') }
  }
  const respond = (response: ServerResponse, status: number, result: unknown): void => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(result)) }
  const server = createServer((request, response) => {
    track((async () => {
      try {
        if (closing) throw new Refusal('unavailable')
        if (request.headers.origin && !originAllowed(request.headers.origin, options.origins)) throw new Refusal('unauthenticated')
        if (request.method === 'GET' && request.url === '/v1/health') { const name = options.name?.()?.trim(); respond(response, 200, { ...descriptor, status: 'ready', ...(name ? { name } : {}) }); return }
        if (request.method !== 'POST') throw new Refusal('invalid_request')
        if (request.url?.startsWith('/v1/admin/')) {
          if (options.admin === false) throw new Refusal('invalid_request')
          const token = Buffer.from(bearer(request)), expected = Buffer.from(adminToken)
          if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw new Refusal('unauthenticated')
          spend('admin', HTTP_BUDGETS.admin)
          if (request.url === '/v1/admin/pairing-code') { respond(response, 200, { v: 1, hostId, ...pairing.issuePairingCode() }); return }
          if (request.url === '/v1/admin/phones' || request.url === '/v1/admin/phones-command') {
            if (!options.phones) throw new Refusal('invalid_request')
            if (request.url === '/v1/admin/phones') { z.object({}).strict().parse(await body(request)); respond(response, 200, { v: 1, hostId, state: options.phones.get() }); return }
            const { command } = z.object({ command: hostPhonesCommandSchema }).strict().parse(await body(request))
            respond(response, 200, { v: 1, hostId, ...await options.phones.command(command) }); return
          }
          const input = z.object({ clientId: z.string().min(1).max(512) }).strict().parse(await body(request))
          if (request.url === '/v1/admin/revoke-client') { const revoked = await pairing.revoke(input.clientId); for (const peer of peers) if (!authenticated(peer)) peer.frames.close(); respond(response, 200, { v: 1, hostId, revoked }); return }
          else if (request.url === '/v1/admin/allow-answers' || request.url === '/v1/admin/deny-answers') {
            if (!pairing.list().some(client => client.clientId === input.clientId) || !options.setAnswers) throw new Refusal('invalid_request')
            options.setAnswers(input.clientId, request.url.endsWith('/allow-answers'))
            shellPublisher.publish(service.shell())
          } else throw new Refusal('invalid_request')
          respond(response, 200, { v: 1, hostId, ok: true }); return
        }
        if (request.url === '/v1/pair') {
          const input = z.object({ v: z.literal(1), code: z.string().min(1).max(32), name: z.string().min(1).max(256) }).strict().parse(await body(request))
          // This listener binds only loopback. Serve replaces this header with the device address;
          // direct connections use loopback's budget. Neither address grants client authority.
          const forwarded = request.headers['x-forwarded-for']
          const address = typeof forwarded === 'string' && isIP(forwarded) ? forwarded : request.socket.remoteAddress ?? 'loopback'
          const refund = spend('pair:' + address, HTTP_BUDGETS.pair)
          let paired: Awaited<ReturnType<PairedClients['redeem']>>
          try { paired = await pairing.redeem(input.code, input.name) } catch { throw new Refusal('unauthenticated') }
          refund()
          respond(response, 200, { v: 1, hostId, ...paired }); options.onPaired?.(paired.clientId); return
        }
        if (request.url === '/v1/revoke') {
          const clientId = pairing.verifyToken(bearer(request))
          if (!clientId) throw new Refusal('unauthenticated')
          spend('client:' + clientId, HTTP_BUDGETS.client)
          const revoked = await pairing.revoke(clientId)
          for (const peer of peers) if (!authenticated(peer)) peer.frames.close()
          respond(response, 200, { v: 1, hostId, revoked }); options.onPeersChanged?.(); return
        }
        if (request.url === '/v1/session') {
          const clientId = pairing.verifyToken(bearer(request))
          if (!clientId) throw new Refusal('unauthenticated')
          spend('client:' + clientId, HTTP_BUDGETS.client)
          const at = Date.now()
          respond(response, 200, { v: 1, hostId, clientId, session: pairing.signSession(clientId, at), expiresAt: new Date(at + SESSION_LIFETIME_MS).toISOString() }); return
        }
        throw new Refusal('invalid_request')
      } catch (error) {
        const code = error instanceof Refusal ? error.code : 'invalid_request'
        respond(response, code === 'unauthenticated' ? 401 : code === 'busy' ? 429 : 400, { v: 1, error: { code, message: code === 'busy' ? HOST_BUSY : errors[code] } })
      }
    })())
  })
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000
  server.on('upgrade', (request, stream: Duplex, head) => {
    stream.on('error', () => stream.destroy())
    const reject = (status = '401 Unauthorized'): void => { stream.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\n\r\n') }
    const session = bearer(request), clientId = pairing.verifySession(session)
    const key = request.headers['sec-websocket-key']
    if (request.url !== '/v1/socket' || !clientId || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || (request.headers.origin && !originAllowed(request.headers.origin, options.origins))) { reject(); return }
    if (closing || peers.size >= 32) { reject('503 Service Unavailable'); return }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    stream.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    const frames = new SocketFrames(stream, false, text => onMessage(peer, text))
    const peer: Peer = { frames, client: identity(clientId), session, observed: new Set(), held: new Map(), opening: new Set(), sentAhead: new WeakSet(), inFlight: 0, window: Date.now(), count: 0, pageWindow: 0, pages: 0, preview: false, ready: false, afterSeq: Number.MAX_SAFE_INTEGER, selectedThreadId: null, selectedProjectId: null, editingThreadId: null, messageAliases: false, deltas: false, clientUpdates: false, activitySummaries: false, catalogRevisions: false, catalogSent: null }
    peers.add(peer)
    frames.startHeartbeat()
    frames.onClose(() => { peers.delete(peer); if (!closing) { track(observe().catch(() => undefined)); options.onPeersChanged?.() } })
    frames.feed(head)
    options.onPeersChanged?.()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  server.on('error', () => { console.error('host_listener_error') })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The host listener did not receive a loopback port.')
  // The descriptor is also the body of /v1/health: a client reads the host's Sotto version and features
  // there before it opens a session, so it never has to find out what the host supports by trying it.
  const descriptor: HostDescriptor = { v: 1, hostId, pid: process.pid, port: address.port, sottoVersion, features: [...features] }
  const expiry = setInterval(() => { for (const peer of peers) if (!authenticated(peer)) peer.frames.close() }, 1000)
  expiry.unref()
  const stopServing = (): void => {
    if (closing) return
    closing = true; clearInterval(expiry); unsubscribe(); unsubscribeDetails?.(); shellPublisher.dispose(); detailPublisher.dispose(); waiting.clear()
    server.removeAllListeners('request')
    server.removeAllListeners('upgrade')
    server.removeAllListeners('connection')
    server.on('connection', socket => socket.destroy())
    server.unref()
    for (const peer of peers) peer.frames.close()
    server.closeAllConnections()
  }
  return {
    descriptor, adminToken,
    /** Ends the host protocol while reserving its loopback port for pending cleanup. */
    stopServing,
    /** How many paired clients hold an open socket: the host's measure of a window being in front. */
    peers: (): number => peers.size,
    /** The paired clients holding an open socket now, each once. */
    connectedClients: (): string[] => [...new Set([...peers].map(peer => peer.client.clientId))],
    /** A changed policy is reflected in every client's own next shell without reopening its session. */
    refreshCapabilities: (): void => { shellPublisher.publish(service.shell()) },
    /** Closes at once every socket whose client is no longer paired, after a revocation made outside this listener. */
    dropRevoked: (): void => { for (const peer of peers) if (!authenticated(peer)) peer.frames.close() },
    close: async (): Promise<void> => {
      stopServing()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await Promise.allSettled([...operations]); await pairing.settled()
    },
  }
}
