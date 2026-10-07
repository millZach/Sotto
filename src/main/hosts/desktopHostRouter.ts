import { randomUUID } from 'node:crypto'
import { agentCommandSchema, MAX_DELIVERED_DRAFTS, HOST_CANNOT_STAGE_SCREENSHOTS, agentShell, isThreadProviderConnected, nameHostInRefusal, type ProviderId, type AgentAttachmentContent, type AgentAttachmentContentRequest, type AgentAttachmentHandle, type AgentAttachmentStageRequest, type AgentAttachmentUpload, type AgentCommand, type AgentState, type AgentThreadDetail, type AgentThreadDetailUpdate, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult } from '../../shared/agents'
import { clientAgentState, hostEntityKey, mapHostReferences, parseHostEntityKey } from '../../shared/clientIdentity'
import { desktopWindowClient, type ClientIdentity, type HostService, type RequestAnswerRecovery } from '../agents/hostService'
import { requestDraftProvider, requestDraftQuestions, type RequestDraftOwner, type RequestDraftTarget } from '../../shared/requestDrafts'
import { requestQuestionsDigest, type BindRequestDraftDecision, type RequestDraftOwnerState, type RequestDraftService } from '../agents/requestDrafts'
import type { HostAnswerTarget } from '../../shared/hostProtocol'
import type { GitRefsPage, GitRefsRequest } from '../../shared/gitRefs'
import type { GitChangedFiles, GitChangedFilesRequest } from '../../shared/gitChangedFiles'
import type { GitPullRequestDetail, GitPullRequestRequest } from '../../shared/gitPullRequests'
import type { HostFoldersClientRequest, HostFoldersRequest, HostFoldersResult } from '../../shared/hostFolders'
import type { FileListing, FileListRequest, FilePath, FilePreview, FileRequest, FilesResult } from '../../shared/files'
import type { GitChangeListing, GitPathRequest, GitReview, GitReviewRequest } from '../../shared/gitChanges'
import type { SubagentAssignmentsPage, SubagentAssignmentsRequest, SubagentPage, SubagentPageRequest } from '../../shared/subagents'
import type { ToolListRequest, ToolsResult } from '../../shared/tools'
import type { HostThreadToolReads } from '../agents/threadToolReads'
import { HostConnectionError, REMOTE_COMPOSE_UNSAVED } from '../agents/socketHostService'

/** A thread's Files, Changes and Agents reads (ADR-0025, October 5 amendment), by the host's own IDs; absent on a connection that has none. */
export interface DesktopHostConnection extends Partial<HostThreadToolReads> {
  hostId: string
  name: string
  kind: 'local' | 'remote'
  service: Pick<HostService, 'shell' | 'command' | 'subscribe' | 'requestAnswerRecovery' | 'checkRequestAnswer' | 'supportsAtomicSend'>
  refreshRequestAnswer?(decisionId: string, target: HostAnswerTarget): Promise<void>
  detail(threadId: string): AgentThreadDetail | null | Promise<AgentThreadDetail | null>
  preview(request: AgentAttachmentPreviewRequest): AgentAttachmentPreviewResult | Promise<AgentAttachmentPreviewResult>
  /** Stages on this host, the one that runs the thread (ADR-0031). */
  stage?(image: AgentAttachmentUpload): Promise<AgentAttachmentHandle>
  content?(digest: string): Promise<AgentAttachmentContent | null>
  gitRefs?(request: GitRefsRequest): Promise<GitRefsPage>
  gitChangedFiles?(request: GitChangedFilesRequest): Promise<GitChangedFiles>
  gitPullRequest?(request: GitPullRequestRequest): Promise<GitPullRequestDetail | null>
  hostFolders?(request: HostFoldersRequest): Promise<HostFoldersResult>
  /** Whether this host lists `client-updates`: only then do its client updates reach the window (#480). */
  offersClientUpdates?(): boolean
  observe?(threadIds: string[]): Promise<unknown>
  subscribeDetail?(listener: (detail: AgentThreadDetailUpdate) => void): () => void
  available?: () => boolean
}

/**
 * The commands whose point is to move the host's selection: Later and Next go to another queued thread, a new thread or
 * project opens, an attention item or a paused draft is taken up, a spoken request picks a thread. Selecting a thread
 * or a project is the window's own and is handled on its own.
 */
const SELECTING_COMMANDS: ReadonlySet<AgentCommand['type']> = new Set(['later', 'next', 'create-thread', 'create-project', 'select-attention', 'resume-draft', 'utterance'])

/** A state without its client updates, which belong to the machine that runs those clients. */
function withoutClientUpdates(state: AgentState): AgentState {
  const { clientUpdates: _updates, clientUpdateRun: _run, clientUpdatesDismissedAt: _dismissed, ...rest } = state
  void _updates; void _run; void _dismissed
  return rest
}

/** Which surface each tool read is for, as its refusals name it. */
const TOOL_SURFACES: Record<keyof HostThreadToolReads, { readonly surface: string; readonly what: string }> = {
  threadFiles: { surface: 'Files', what: 'files' }, threadFilePreview: { surface: 'Files', what: 'files' },
  gitChanges: { surface: 'Changes', what: 'changes' }, gitReview: { surface: 'Changes', what: 'changes' },
  subagentPage: { surface: 'Agents', what: 'agents' }, subagentAssignments: { surface: 'Agents', what: 'agents' },
}

/** Files and Changes show a refusal where the answer would go, so a read the host could not make answers as one. */
async function answeredAsRefusal<T extends { ok: boolean }>(read: () => Promise<T>): Promise<T | { ok: false; error: { code: 'unavailable'; message: string } }> {
  try { return await read() }
  catch (error) { return { ok: false, error: { code: 'unavailable', message: (error instanceof Error ? error.message : '').slice(0, 2000) || 'The host could not be read. Nothing was changed. Try again.' } } }
}

/**
 * A path on a paired host, in that host's own format: its working folder joined with a slash-separated relative path.
 * A Windows folder (`C:\...`, `\\server\...`) joins with the separator it is written with; every other host's with `/`.
 * Nothing is translated to this computer's format, since the path is the host's.
 */
export function hostAbsolutePath(root: string, path: string): string {
  if (path === '') return root
  const separator = (/^[A-Za-z]:/u.test(root) || root.startsWith('\\\\')) && root.includes('\\') ? '\\' : '/'
  return `${root.endsWith(separator) ? root.slice(0, -1) : root}${separator}${path.split('/').join(separator)}`
}

type RouterNotice = { message: string; answer?: { hostId: string; decisionId: string; target: HostAnswerTarget }; unsupportedCompose?: DesktopHostConnection }

/** Routing happens in main, before host-local IDs or privileged command schemas are decoded. */
export class DesktopHostRouter {
  private readonly hosts = new Map<string, { connection: DesktopHostConnection; off: (() => void)[] }>()
  private readonly listeners = new Set<(state: AgentState) => void>()
  private readonly detailListeners = new Set<(detail: AgentThreadDetailUpdate) => void>()
  private selectedHostId: string | undefined
  private selectedThreadId: string | null | undefined
  private selectedProjectId: string | null = null
  private notice: RouterNotice | undefined
  /** The visible notice, updated only when a snapshot actually reaches subscribers. */
  private publishedNotice: RouterNotice | undefined
  /** Hosts whose threads read Reconnecting: kept on the page while their host restarts for an update (ADR-0040). */
  private readonly reconnecting = new Set<string>()
  /** Counts the window's own selections, so a command that ends after one does not undo it. */
  private selections = 0
  /** Receipt reads share a connection and owner state; no answer is replayed or held draft released. */
  private readonly answerRecovery = new WeakMap<DesktopHostConnection, {
    checks: Map<string, { promise: Promise<void>; pending: boolean }>
    lane: Promise<void>
    window: number
    reads: number
  }>()

  constructor(private readonly empty: () => AgentState, private readonly options: { bindRequestDraftDecision?: BindRequestDraftDecision } = {}) {}

  add(connection: DesktopHostConnection): void {
    if (this.hosts.has(connection.hostId)) throw new Error('This host is already connected.')
    const off = [connection.service.subscribe(() => this.emit())]
    if (connection.subscribeDetail) off.push(connection.subscribeDetail(detail => {
      const scoped = mapHostReferences(detail, id => hostEntityKey(connection.hostId, id))
      for (const listener of this.detailListeners) listener(scoped)
    }))
    this.hosts.set(connection.hostId, { connection, off })
    this.selectedHostId ??= connection.hostId
    this.emit()
  }
  /**
   * The same host on a new connection, in place of the one it had: its threads, the selection and the panes showing them
   * stay where they are, as they would not through a remove and an add. Only a host with the same ID can take its place.
   */
  replace(connection: DesktopHostConnection): void {
    const entry = this.hosts.get(connection.hostId)
    if (!entry) { this.add(connection); return }
    entry.off.forEach(off => off())
    const off = [connection.service.subscribe(() => this.emit())]
    if (connection.subscribeDetail) off.push(connection.subscribeDetail(detail => {
      const scoped = mapHostReferences(detail, id => hostEntityKey(connection.hostId, id))
      for (const listener of this.detailListeners) listener(scoped)
    }))
    this.hosts.set(connection.hostId, { connection, off })
    this.reconnecting.delete(connection.hostId)
    this.emit()
  }
  /** Marks a connected host's threads as reconnecting, or no longer: while it is set they read Reconnecting, not Disconnected. */
  setReconnecting(hostId: string, value: boolean): void {
    if (value === this.reconnecting.has(hostId) || !this.hosts.has(hostId)) return
    if (value) this.reconnecting.add(hostId); else this.reconnecting.delete(hostId)
    this.emit()
  }
  remove(hostId: string): void {
    this.hosts.get(hostId)?.off.forEach(off => off())
    this.hosts.delete(hostId)
    this.reconnecting.delete(hostId)
    if (this.selectedHostId === hostId) this.selectedHostId = this.hosts.keys().next().value
    if (this.selectedThreadId && parseHostEntityKey(this.selectedThreadId)?.hostId === hostId) this.selectedThreadId = null
    this.emit()
  }
  select(hostId: string): void {
    if (!this.hosts.has(hostId)) throw new Error('Connect this host before selecting it.')
    this.selectedHostId = hostId; this.selectedThreadId = null; this.selectedProjectId = null; this.selections++; this.emit()
  }
  /** A saved host was renamed: its threads and badges take the new name at once. */
  rename(hostId: string, name: string): void {
    const entry = this.hosts.get(hostId)
    if (!entry) return
    entry.connection = { ...entry.connection, name }
    this.emit()
  }
  subscribe(listener: (state: AgentState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  subscribeThreadDetail(listener: (detail: AgentThreadDetailUpdate) => void): () => void { this.detailListeners.add(listener); return () => this.detailListeners.delete(listener) }
  get(): AgentState { return this.shell() }
  shell(): AgentState {
    const answer = this.notice?.answer
    if (answer) {
      const proof = this.hosts.get(answer.hostId)?.connection.service.requestAnswerRecovery?.(answer.target.threadId, answer.target.providerId)
      if (proof?.completed.some(item => item.decisionId === answer.decisionId && item.requestId === answer.target.requestId
        && item.questionsDigest === answer.target.questionsDigest)) this.notice = undefined
    }
    const entries = [...this.hosts.values()].map(({ connection }) => {
      const original = connection.service.shell()
      return { connection, original, state: clientAgentState(original) }
    })
    const selected = entries.find(item => item.connection.hostId === this.selectedHostId)
    const named = selected ? this.named(selected.connection, selected.state) : this.empty()
    // The corner card and Settings > Providers are this computer's own clients. A remote host's client updates reach the
    // window only through its `clientHosts` entry, for its tiles in Settings > Hosts (#480).
    const base = selected?.connection.kind === 'remote' ? withoutClientUpdates(named) : named
    const multiple = entries.length > 1
    const threads = entries.flatMap(({ connection, original, state }) => state.host.threads.map((thread, index) => {
      const available = connection.available?.() !== false
      return {
        ...thread, hostId: connection.hostId, hostLabel: multiple ? connection.name : undefined, remoteHost: connection.kind === 'remote',
        clientConnected: available && isThreadProviderConnected(original.host, original.host.threads[index]!),
        ...(!available && this.reconnecting.has(connection.hostId) ? { clientReconnecting: true } : {}),
      }
    }))
    return {
      ...base, clientScoped: true,
      connections: entries.map(({ connection }) => ({ hostId: connection.hostId, name: connection.name, kind: connection.kind, connected: connection.available?.() !== false })),
      host: { ...base.host, connected: threads.some(thread => thread.clientConnected) || entries.some(item => item.state.host.connected),
        projects: entries.flatMap(item => item.state.host.projects), threads,
        // The selected host's catalog is the same array as `host.models`, which structured clone sends once:
        // a copy here would put every model on the wire twice with each publish.
        clientHosts: entries.map(({ connection, original, state }) => ({ hostId: connection.hostId,
          connected: connection.available?.() !== false && original.host.connected,
          models: state.host.models, capabilities: original.host.capabilities,
          ...(original.host.providers ? { providers: original.host.providers } : {}),
          ...(connection.offersClientUpdates?.() && original.clientUpdates ? { clientUpdates: original.clientUpdates } : {}),
          ...(connection.offersClientUpdates?.() && original.clientUpdateRun ? { clientUpdateRun: original.clientUpdateRun } : {}),
        })),
      },
      assignments: entries.flatMap(item => item.state.assignments), queue: entries.flatMap(item => item.state.queue),
      threadDrafts: entries.flatMap(item => item.state.threadDrafts ?? []),
      threadDraftPersistence: entries.flatMap(item => item.state.threadDraftPersistence ?? []),
      obsoleteDrafts: entries.flatMap(item => item.state.obsoleteDrafts ?? []).slice(-MAX_DELIVERED_DRAFTS),
      deliveredDrafts: entries.flatMap(item => item.state.deliveredDrafts ?? []).slice(-MAX_DELIVERED_DRAFTS),
      deliveries: entries.flatMap(item => item.state.deliveries ?? []), followups: entries.flatMap(item => item.state.followups ?? []),
      busyThreadIds: entries.flatMap(item => item.state.busyThreadIds ?? []),
      ...(entries.some(item => item.state.unconfirmedSettings?.length) ? { unconfirmedSettings: entries.flatMap(item => item.state.unconfirmedSettings ?? []) } : {}),
      activeThreadId: this.selectedThreadId === undefined ? base.activeThreadId : this.selectedThreadId,
      activeProjectId: this.selectedProjectId ?? base.activeProjectId,
      ...(this.notice ? { error: this.notice.message } : {}),
    }
  }
  private target(id?: string): { connection: DesktopHostConnection; id: string | undefined } {
    const key = id ? parseHostEntityKey(id) : null
    const hostId = key?.hostId ?? this.selectedHostId
    const entry = hostId ? this.hosts.get(hostId) : undefined
    if (!entry) throw new Error('Connect a host in Settings > Hosts to continue.')
    return { connection: entry.connection, id: key?.id ?? id }
  }
  async threadDetail(threadId: string): Promise<AgentThreadDetail | null> {
    const { connection, id } = this.target(threadId)
    const detail = await connection.detail(id!)
    return detail ? mapHostReferences(detail, value => hostEntityKey(connection.hostId, value)) : null
  }
  requestAnswerRecovery(threadId: string, providerId: ProviderId): RequestAnswerRecovery {
    const { connection, id } = this.target(threadId)
    return connection.service.requestAnswerRecovery?.(id!, providerId) ?? { uncertainRequestIds: [], completed: [] }
  }
  /** The same owning-host projection is used for remote draft saves and recovery. */
  requestDraftState(owner: RequestDraftOwner): RequestDraftOwnerState | undefined {
    const key = parseHostEntityKey(owner.ownerId)
    if (!key || !this.hosts.has(key.hostId)) return undefined
    const state = this.shell()
    const recovery = this.requestAnswerRecovery(owner.ownerId, owner.providerId)
    const thread = state.host.threads.find(item => item.id === owner.ownerId
      && requestDraftProvider(state.host, item, state.configuration.provider) === owner.providerId)
    return thread ? { connected: isThreadProviderConnected(state.host, thread),
      ready: thread.historyStatus !== 'loading' && thread.historyStatus !== 'error', requests: thread.requests, ...recovery }
      : recovery.completed.length ? { connected: false, ready: false, requests: [], ...recovery } : undefined
  }
  async reconcileRequestDrafts(drafts: Pick<RequestDraftService, 'heldThreadAnswers' | 'reconcile'>): Promise<void> {
    // Already-known local, personal and remote acceptance must not wait for a socket read.
    await drafts.reconcile()
    const state = this.shell()
    const pending: Promise<void>[] = []
    for (const draft of await drafts.heldThreadAnswers()) {
      const owner = draft.target
      const identity = parseHostEntityKey(owner.ownerId)
      const connection = identity ? this.hosts.get(identity.hostId)?.connection : undefined
      if (!identity || !connection || connection.kind !== 'remote' || connection.available?.() === false
        || !connection.refreshRequestAnswer || !draft.decisionId) continue
      let recovery = this.answerRecovery.get(connection)
      if (!recovery) {
        recovery = { checks: new Map(), lane: Promise.resolve(), window: 0, reads: 0 }
        this.answerRecovery.set(connection, recovery)
      }
      const { checks } = recovery
      const decisionId = draft.decisionId
      const questionsDigest = requestQuestionsDigest(owner.questions)
      const completed = connection.service.requestAnswerRecovery?.(identity.id, owner.providerId).completed
      if (completed?.some(item => item.decisionId === decisionId && item.requestId === owner.requestId
        && item.questionsDigest === questionsDigest)) continue
      const thread = state.host.threads.find(item => item.id === owner.ownerId)
      const request = thread?.requests.find(item => item.id === owner.requestId)
      // A negative receipt is checked again when its provider reconnects or the original request
      // changes delivery/liveness or its answer lane finishes. Unrelated streaming updates keep the same read.
      const key = JSON.stringify([owner.ownerId, owner.providerId, owner.requestId, questionsDigest, decisionId,
        thread?.clientConnected, thread?.historyStatus, request?.id ?? null, request?.delivery ?? null,
        state.busyThreadIds?.includes(owner.ownerId) ?? false])
      let check = checks.get(key)
      if (!check) {
        // Keep both negative memo entries and queued reads bounded. Never evict an in-flight
        // read: repeated shell publications must share it instead of queueing duplicates.
        if (checks.size >= 512) {
          const oldest = [...checks].find(([, entry]) => !entry.pending)
          if (oldest) checks.delete(oldest[0])
          else continue
        }
        const budget = recovery
        const entry = { promise: Promise.resolve(), pending: true }
        entry.promise = budget.lane.then(async () => {
          if (this.hosts.get(connection.hostId)?.connection !== connection || connection.available?.() === false) {
            checks.delete(key)
            return
          }
          // A push or another queued read may already have proved this exact acceptance.
          if (connection.service.requestAnswerRecovery?.(identity.id, owner.providerId).completed.some(item =>
            item.decisionId === decisionId && item.requestId === owner.requestId && item.questionsDigest === questionsDigest)) {
            await drafts.reconcile()
            return
          }
          // Each socket leaves room in its own message budget for the user's commands.
          const elapsed = Date.now() - budget.window
          if (elapsed >= 1000) { budget.window = Date.now(); budget.reads = 0 }
          if (budget.reads >= 16) {
            await new Promise(resolve => setTimeout(resolve, Math.max(0, 1000 - elapsed)))
            budget.window = Date.now(); budget.reads = 0
          }
          budget.reads++
          await connection.refreshRequestAnswer!(decisionId, { threadId: identity.id,
            providerId: owner.providerId, requestId: owner.requestId, questionsDigest })
          // Each host retires its accepted holds as soon as its read finishes, independently
          // of another host whose receipt is still pending.
          await drafts.reconcile()
        }).catch(() => { checks.delete(key) }).finally(() => { entry.pending = false })
        budget.lane = entry.promise
        checks.set(key, entry)
        check = entry
      }
      pending.push(check.promise)
    }
    await Promise.all(pending)
    await drafts.reconcile()
  }

  async refreshRequestDraft(target: RequestDraftTarget, decisionId?: string): Promise<void> {
    const { connection, id } = this.target(target.ownerId)
    const questionsDigest = requestQuestionsDigest(target.questions)
    const reoffered = () => {
      const state = connection.service.shell(), thread = state.host.threads.find(item => item.id === id)
      const request = thread?.requests.find(item => item.id === target.requestId)
      return !!(thread && request && requestDraftProvider(state.host, thread, state.configuration.provider) === target.providerId
        && requestQuestionsDigest(requestDraftQuestions(request)) === questionsDigest && (request.delivery === 'uncertain' || request.answerRetryReady))
    }
    const initialReoffered = reoffered()
    if (decisionId) {
      try { await connection.refreshRequestAnswer?.(decisionId, { threadId: id!, providerId: target.providerId,
        requestId: target.requestId, questionsDigest }) }
      catch (error) { if (!initialReoffered) throw error }
      if (!initialReoffered && !reoffered() && connection.service.requestAnswerRecovery?.(id!, target.providerId).completed.some(item =>
        item.decisionId === decisionId && item.requestId === target.requestId && item.questionsDigest === questionsDigest)) return
    }
    if (!connection.service.checkRequestAnswer) throw new Error('Update the host before checking this unconfirmed answer. Your saved answer is kept.')
    await connection.service.checkRequestAnswer({ threadId: id!, providerId: target.providerId, requestId: target.requestId, questionsDigest }, desktopWindowClient())
  }
  async attachmentPreview(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult> {
    const { connection, id } = this.target(request.threadId)
    return connection.preview({ ...request, threadId: id! })
  }
  /** An image goes to the host that runs the thread it is for, or the selected host for the coordinator's composer. */
  async stageAttachment(request: AgentAttachmentStageRequest): Promise<AgentAttachmentHandle> {
    const { connection } = this.target(request.threadId ?? undefined)
    if (!connection.stage) throw new Error(HOST_CANNOT_STAGE_SCREENSHOTS)
    if (connection.available?.() === false) throw new Error('This host is disconnected. Connect again before attaching images. Nothing was attached.')
    return connection.stage({ name: request.name, mimeType: request.mimeType, bytes: request.bytes, ...(request.dimensions ? { dimensions: request.dimensions } : {}) })
  }
  async attachmentContent(request: AgentAttachmentContentRequest): Promise<AgentAttachmentContent | null> {
    const { connection } = this.target(request.threadId ?? undefined)
    if (!connection.content || connection.available?.() === false) return null
    return connection.content(request.digest)
  }
  async gitRefs(request: GitRefsRequest): Promise<GitRefsPage> {
    const { connection, id } = this.target(request.threadId)
    if (!connection.gitRefs) throw new Error('Branches are unavailable on this host.')
    if (connection.available?.() === false) throw new Error('This host is disconnected. Connect again to read its branches.')
    return connection.gitRefs({ ...request, threadId: id! })
  }
  async gitChangedFiles(request: GitChangedFilesRequest): Promise<GitChangedFiles> {
    const { connection, id } = this.target(request.threadId)
    if (!connection.gitChangedFiles) throw new Error('Changed files are unavailable on this host.')
    if (connection.available?.() === false) throw new Error('This host is disconnected. Connect again to read its changes.')
    return connection.gitChangedFiles({ ...request, threadId: id! })
  }
  async gitPullRequest(request: GitPullRequestRequest): Promise<GitPullRequestDetail | null> {
    const { connection, id } = this.target(request.threadId)
    if (!connection.gitPullRequest) throw new Error('Pull requests are unavailable on this host.')
    if (connection.available?.() === false) throw new Error('This host is disconnected. Connect again to read its pull requests.')
    return connection.gitPullRequest({ ...request, threadId: id! })
  }
  /** The folder browser names its host directly: it has no thread yet to carry a client-scoped key. */
  async hostFolders(request: HostFoldersClientRequest): Promise<HostFoldersResult> {
    const entry = this.hosts.get(request.hostId)
    if (!entry) throw new Error('That computer is not connected. Nothing was changed. Connect it in Settings > Hosts, then try again.')
    const { connection } = entry
    if (connection.available?.() === false) throw new Error('This host is disconnected. Nothing was changed. Connect again to see its folders.')
    if (!connection.hostFolders) throw new Error('This host cannot list its folders yet. Update Sotto on it, then try again.')
    return connection.hostFolders(request.path === undefined ? {} : { path: request.path })
  }
  /**
   * One of a thread's Files, Changes or Agents reads, on the host that runs it (ADR-0025, October 5 amendment). The key's
   * host-local ID goes to that host, and every thread and project ID in its answer comes back as this window's key, so
   * the window's stores keep the key they asked with. A read the host could not make throws a sentence the surface shows:
   * the version sentence for a host from before the read, or what the connection said.
   */
  private async threadToolRead<K extends keyof HostThreadToolReads>(read: K, request: Parameters<HostThreadToolReads[K]>[0]): Promise<Awaited<ReturnType<HostThreadToolReads[K]>>> {
    const { connection, id } = this.target(request.threadId)
    const { surface, what } = TOOL_SURFACES[read]
    const method = connection[read] as ((request: Parameters<HostThreadToolReads[K]>[0]) => ReturnType<HostThreadToolReads[K]>) | undefined
    if (!method) throw new Error(`${surface} is unavailable on this host. Nothing was changed. Check the host in Settings > Hosts.`)
    if (connection.available?.() === false) throw new Error(`This host is disconnected. Nothing was changed. Connect again to read its ${what}.`)
    let answer: Awaited<ReturnType<HostThreadToolReads[K]>>
    try { answer = await method({ ...request, threadId: id! }) }
    catch (error) { throw new Error(error instanceof HostConnectionError ? error.message : `${connection.name} could not read this thread's ${what}. Nothing was changed. Try again.`, { cause: error }) }
    return mapHostReferences(answer, value => hostEntityKey(connection.hostId, value))
  }
  async threadFiles(request: FileListRequest): Promise<FilesResult<FileListing>> { return answeredAsRefusal(() => this.threadToolRead('threadFiles', request)) }
  async threadFilePreview(request: FileRequest): Promise<FilesResult<FilePreview>> { return answeredAsRefusal(() => this.threadToolRead('threadFilePreview', request)) }
  async gitChanges(request: ToolListRequest): Promise<ToolsResult<GitChangeListing>> { return answeredAsRefusal(() => this.threadToolRead('gitChanges', request)) }
  async gitReview(request: GitReviewRequest): Promise<ToolsResult<GitReview>> { return answeredAsRefusal(() => this.threadToolRead('gitReview', request)) }
  subagentPage(request: SubagentPageRequest): Promise<SubagentPage> { return this.threadToolRead('subagentPage', request) }
  subagentAssignments(request: SubagentAssignmentsRequest): Promise<SubagentAssignmentsPage> { return this.threadToolRead('subagentAssignments', request) }
  /**
   * Copy path in Files for a thread on a paired host: the host's own path to the file or folder, in the host's format,
   * once a listing of its folder shows the working folder is still the one the window read and the entry is still there.
   * Copying it is the caller's; nothing on the host is touched.
   */
  async threadFilePath(request: FileRequest): Promise<FilesResult<FilePath>> {
    const folder = request.path.includes('/') ? request.path.slice(0, request.path.lastIndexOf('/')) : ''
    const listing = await this.threadFiles({ threadId: request.threadId, path: folder, workspaceId: request.workspaceId })
    if (!listing.ok) return listing
    const listed = request.path === '' || listing.value.truncated || listing.value.entries.some(entry => entry.path === request.path && entry.kind !== 'unavailable')
    if (!listed) return { ok: false, error: { code: 'path-unavailable', message: 'This path is unavailable or changed. Refresh Files and try again.' } }
    return { ok: true, value: { workspace: listing.value.workspace, path: request.path, absolutePath: hostAbsolutePath(listing.value.workspace.workingDirectory, request.path) } }
  }
  /** Copy path in Changes for a thread on a paired host, the same way, once the change list shows the same working folder. */
  async gitChangesPath(request: GitPathRequest): Promise<ToolsResult<FilePath>> {
    const listing = await this.gitChanges({ threadId: request.threadId, workspaceId: request.workspaceId })
    if (!listing.ok) return listing
    return { ok: true, value: { workspace: listing.value.workspace, path: request.path, absolutePath: hostAbsolutePath(listing.value.workspace.workingDirectory, request.path) } }
  }
  async command(input: unknown, client: ClientIdentity): Promise<AgentState> {
    const priorNotice = this.notice
    this.notice = undefined
    const references = new Set<string>()
    mapHostReferences(input, value => { const key = parseHostEntityKey(value); if (key) references.add(key.hostId); return value })
    const type = input && typeof input === 'object' && 'type' in input ? input.type : undefined
    if (type === 'observe-threads') {
      const parsed = agentCommandSchema.parse(mapHostReferences(input, id => parseHostEntityKey(id)?.id ?? id))
      if (parsed.type !== 'observe-threads') throw new Error('The viewed threads could not be read.')
      const rawIds = (input as { threadIds: string[] }).threadIds
      await Promise.all([...this.hosts.values()].map(async ({ connection }) => {
        if (connection.available?.() === false) return
        const ids = rawIds.filter(id => (parseHostEntityKey(id)?.hostId ?? this.selectedHostId) === connection.hostId).map(id => parseHostEntityKey(id)?.id ?? id)
        if (connection.observe) await connection.observe(ids)
        else await connection.service.command({ type: 'observe-threads', threadIds: ids }, client)
      }))
      return this.shell()
    }
    if (references.size > 1) throw new Error('This action includes items from different hosts. Select items from one host.')
    const hostId = [...references][0] ?? this.selectedHostId
    const { connection } = this.target(hostId ? hostEntityKey(hostId, '_') : undefined)
    const command = agentCommandSchema.parse(mapHostReferences(input, id => parseHostEntityKey(id)?.id ?? id))
    // Retained local edits publish before the refusal reply. Keep its visible banner stable while typing.
    if (command.type === 'compose' && command.threadId !== undefined && connection.service.supportsAtomicSend === false
      && priorNotice === this.publishedNotice && priorNotice?.unsupportedCompose === connection) this.notice = priorNotice
    if (command.type === 'select-thread' || command.type === 'select-project') {
      this.selectedHostId = connection.hostId; this.selections++
      if (command.type === 'select-thread') {
        this.selectedThreadId = command.threadId ? hostEntityKey(connection.hostId, command.threadId) : null
        this.selectedProjectId = this.shell().host.threads.find(thread => thread.id === this.selectedThreadId)?.projectId ?? null
      } else {
        this.selectedProjectId = command.projectId ? hostEntityKey(connection.hostId, command.projectId) : null; this.selectedThreadId = null
      }
      // Forward selection so the remote peer can target its own picked thread.
      if (connection.available?.() !== false) {
        const result = await connection.service.command(command, client)
        if (result.error) this.notice = { message: this.refusal(connection, result.error) }
      }
      this.emit(); return this.shell()
    }
    if (connection.available?.() === false) throw new Error('This host is disconnected. Connect again before sending. No command was sent.')
    if (connection.kind === 'remote' && ['open-thread-folder', 'open-folder'].includes(command.type)) throw new Error('This folder is on the host machine. Open it there.')
    if (command.type === 'preview-reclaim-thread-worktree') {
      try {
        const result = await connection.service.command(command, client)
        if (result.error || !result.worktreeReclaimPreview) return { ...this.shell(), error: 'This host could not check the worktree. Nothing was removed. Update the host and try again.' }
        return { ...this.shell(), error: null, worktreeReclaimPreview: result.worktreeReclaimPreview }
      } catch {
        return { ...this.shell(), error: 'This host could not check the worktree. Nothing was removed. Check its connection or update the host and try again.' }
      }
    }
    // Read as values: a host's shell can be its live state, which the command is about to change.
    const { activeThreadId, activeProjectId } = connection.service.shell()
    const selections = this.selections
    const windowShowed = { hostId: this.selectedHostId, threadId: this.selectedThreadId }
    let refused = false
    let repeatedUnsupportedCompose = false
    try {
      let decisionId: string | undefined
      let answerTarget: HostAnswerTarget | undefined
      if (connection.kind === 'remote' && command.type === 'answer') {
        const state = this.shell()
        const thread = state.host.threads.find(item => item.id === hostEntityKey(connection.hostId, command.threadId))
        const request = thread?.requests.find(item => item.id === command.requestId)
        const questions = request ? requestDraftQuestions(request) : []
        if (thread && request && questions.length) {
          decisionId = randomUUID()
          answerTarget = { threadId: command.threadId, providerId: requestDraftProvider(state.host, thread, state.configuration.provider),
            requestId: request.id, questionsDigest: requestQuestionsDigest(questions) }
          await this.options.bindRequestDraftDecision?.({ kind: 'thread', ownerId: thread.id,
            providerId: requestDraftProvider(state.host, thread, state.configuration.provider), requestId: request.id, questions }, decisionId,
          request.questions?.length ? command.questionAnswers : { [request.id]: { optionIds: [command.answer] } })
        }
      }
      const result = await (decisionId ? connection.service.command(command as AgentCommand, client, decisionId)
        : connection.service.command(command as AgentCommand, client))
      if (result.error) {
        refused = true
        const unsupportedCompose = command.type === 'compose' && command.threadId !== undefined
          && connection.kind === 'remote' && connection.service.supportsAtomicSend === false && result.error === REMOTE_COMPOSE_UNSAVED
        const message = this.refusal(connection, result.error)
        // Compare what is visible now, after the reply. An intervening error or connection change wins.
        repeatedUnsupportedCompose = unsupportedCompose && this.publishedNotice?.unsupportedCompose === connection
          && this.hosts.get(connection.hostId)?.connection === connection && this.publishedNotice.message === message
        this.notice = repeatedUnsupportedCompose ? this.publishedNotice : { message, ...(unsupportedCompose ? { unsupportedCompose: connection } : {}), ...(decisionId && answerTarget
          ? { answer: { hostId: connection.hostId, decisionId, target: answerTarget } } : {}) }
      }
    } catch (error) {
      // The host refused this action before dispatch. Return its account through the same state error
      // as a coordinator refusal, so a permission chip does not mistake it for a lost provider answer.
      // A dropped connection is still uncertain and must keep the renderer's recovery path.
      if (connection.kind !== 'remote' || !(error instanceof HostConnectionError) || error.code !== 'forbidden') throw error
      refused = true; this.notice = { message: this.refusal(connection, error.message) }
    } finally {
      if (SELECTING_COMMANDS.has(command.type) && selections === this.selections) this.follow(connection, { activeThreadId, activeProjectId })
    }
    // Only while the window still shows what it did when the creation began: any other move meanwhile wins.
    const unmoved = selections === this.selections && this.selectedHostId === windowShowed.hostId && this.selectedThreadId === windowShowed.threadId
    if (command.type === 'create-thread' && command.threadId !== undefined && connection.kind === 'remote' && !refused && unmoved) {
      await this.openCreated(connection, command.threadId, client)
    }
    if (!repeatedUnsupportedCompose) this.emit()
    return agentShell(this.shell())
  }
  /**
   * A remote host keeps a selection for each client and leaves it where it was when that client creates a thread, so
   * the window opens the thread it just created itself and tells the host, which then composes and sends there.
   */
  private async openCreated(connection: DesktopHostConnection, threadId: string, client: ClientIdentity): Promise<void> {
    if (this.hosts.get(connection.hostId)?.connection !== connection) return
    const created = connection.service.shell().host.threads.find(thread => thread.id === threadId)
    if (!created) return
    this.moveTo(connection.hostId, threadId, created.projectId)
    // The creation is confirmed either way, and its answer must not read as a refusal: a forward the host refuses or
    // loses leaves it composing for its earlier selection until the window selects again.
    await connection.service.command({ type: 'select-thread', threadId }, client).catch(() => undefined)
  }
  /**
   * The window goes where one of its selecting commands took the host, so the thread it shows is the one the host
   * composes and sends to. It does not follow a move it did not ask for: another thread's turn ending, another
   * client's selection, or the host presenting its next queued thread after an answer. A selection the user made
   * while the command ran wins over the command.
   */
  private follow(connection: DesktopHostConnection, before: Pick<AgentState, 'activeThreadId' | 'activeProjectId'>): void {
    const after = connection.service.shell()
    if (after.activeThreadId === before.activeThreadId && after.activeProjectId === before.activeProjectId) return
    this.moveTo(connection.hostId, after.activeThreadId, after.activeProjectId)
  }
  /** Shows a host's thread and project, given by that host's own IDs. */
  private moveTo(hostId: string, threadId: string | null, projectId: string | null): void {
    this.selectedHostId = hostId
    this.selectedThreadId = threadId === null ? null : hostEntityKey(hostId, threadId)
    this.selectedProjectId = projectId === null ? null : hostEntityKey(hostId, projectId)
  }
  /** A remote host cannot know the name this computer saved it under, so its refusals are given it here (#459). */
  private refusal(connection: DesktopHostConnection, message: string): string {
    return connection.kind === 'remote' ? nameHostInRefusal(message, connection.name) : message
  }
  private named(connection: DesktopHostConnection, state: AgentState): AgentState {
    return state.error ? { ...state, error: this.refusal(connection, state.error) } : state
  }
  private emit(): void { const state = this.shell(); this.publishedNotice = this.notice; for (const listener of this.listeners) listener(state) }
  dispose(): void { for (const hostId of [...this.hosts.keys()]) this.remove(hostId); this.listeners.clear(); this.detailListeners.clear() }
}
