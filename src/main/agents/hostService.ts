import type { AgentThreadPrompts } from '../../shared/threadPrompts'
import { startHandoverPrefix } from '../../shared/threadStarts'
import type { AgentActivity } from '../../shared/agentActivity'
import { userInfo } from 'node:os'
import type { WatcherHostControl, WatcherHostRead, WatcherHostProjection, WatcherRoomThreadInput } from '../../shared/watcherHost'
import { watcherResultForHostV1, type WatcherIdentity } from '../../shared/watcher'
import type { WatcherService } from './watcher'
import type { WatcherPhoneService } from './watcherPhone'

import { HOST_CANNOT_STAGE_SCREENSHOTS, type ProviderId, type AgentAttachmentContent, type AgentAttachmentHandle, type AgentAttachmentUpload, type AgentCommand, type AgentState, type AgentThread, type AgentThreadDetail, type AgentThreadDetailUpdate, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult, type AgentProject } from '../../shared/agents'
import type { StoredThreadEvent } from '../../shared/threadEvents'
import type { GitRefsPage, GitRefsRequest } from '../../shared/gitRefs'
import type { GitChangedFiles, GitChangedFilesRequest } from '../../shared/gitChangedFiles'
import type { GitPullRequestRead, GitPullRequestRequest } from '../../shared/gitPullRequests'
import type { HostFoldersRequest, HostFoldersResult } from '../../shared/hostFolders'
import type { FileListing, FileListRequest, FilePreview, FileRequest, FilesResult } from '../../shared/files'
import type { GitChangeListing, GitReview, GitReviewRequest } from '../../shared/gitChanges'
import type { SubagentAssignmentsPage, SubagentAssignmentsRequest, SubagentPage, SubagentPageRequest } from '../../shared/subagents'
import type { HostThreadDelegations } from '../../shared/agentsView'
import type { ToolListRequest, ToolsResult } from '../../shared/tools'
import { listHostFolders } from './hostFolders'
import type { HostThreadToolReads } from './threadToolReads'
import type { HostAnswerTarget, HostAttachmentFile, HostAttachmentFileRequest, HostErrorCode } from '../../shared/hostProtocol'
import { mayGrantLocally, REMOTE_PERMISSION_DENIED } from './authority'
import type { HostMachineReport } from '../../shared/hostFacts'
import type { ProjectOrigins } from '../../shared/workerMachine'
import type { DesktopDefaultsInput, DesktopDefaultsReceipt } from '../../shared/desktopDefaults'
import type { DelegationBrief, DelegationsRead } from '../../shared/delegation'
import type { DelegationViews } from './delegationIpc'
import type { QuestionPageTarget } from './questionPages'
import { usageLocalClearRequestSchema, usageLocalQuerySchema, usageProviderIdSchema, type UsageLocalClearRequest, type UsageLocalClearResult, type UsageLocalHostRead, type UsageLocalQuery, type UsageProviderId } from '../../shared/usageDashboard'

type RequestAnswerCheckRefusalReason = 'stale-question' | 'provider-disconnected' | 'forbidden' | 'unsupported' | 'answer-in-progress' | 'answer-changed'
const requestAnswerCheckRefusals: Record<RequestAnswerCheckRefusalReason, { code: HostErrorCode; message: string }> = {
  'stale-question': { code: 'stale_request', message: 'The original question changed or is no longer pending. Your saved answer is kept.' },
  'provider-disconnected': { code: 'unavailable', message: 'Reconnect the original provider before checking this answer.' },
  forbidden: { code: 'forbidden', message: `${REMOTE_PERMISSION_DENIED} Your saved answer is kept.` },
  unsupported: { code: 'invalid_request', message: 'Update this host before checking an unconfirmed answer.' },
  'answer-in-progress': { code: 'busy', message: 'This answer is still being sent. Wait for it to finish before checking it again. Your saved answer is kept.' },
  'answer-changed': { code: 'stale_request', message: 'Another answer started during this check. Check again. Your saved answer is kept.' },
}

/** Only these host-owned refusals may cross the socket as answer Check guidance. Provider errors remain private. */
export class RequestAnswerCheckRefusal extends Error {
  readonly hostCode: HostErrorCode
  constructor(reason: RequestAnswerCheckRefusalReason) {
    const refusal = requestAnswerCheckRefusals[reason]
    super(refusal.message)
    this.hostCode = refusal.code
  }
}

/**
 * Who is speaking to the host. The desktop window on this machine is `ipc`; a paired remote client
 * would be `socket`. It is evidence about a command, never authority in itself (ADR-0004): policy
 * records decide whether a client may grant, and `Authority.mayGrant` is where that is asked.
 *
 * `user` is the local account name, recorded in a thread's own log so a record says who answered. It
 * is never logged and never sent anywhere.
 */
export interface ClientIdentity {
  readonly clientId: string
  readonly user: string
  readonly transport: 'ipc' | 'socket'
  readonly selectedThreadId?: string | null
}

/**
 * Everything a client may use, and nothing else. The host owns the providers, the worktrees and the
 * event store (ADR-0016); a client reads the stream and sends commands, and holds no provider
 * identity of its own. Today the only client is the app's window over IPC, so the only implementation
 * is `LocalHostService`; the interface exists so a second transport is a new client rather than a
 * rewrite. Threads are addressed by Sotto thread ID either way (ADR-0002).
 */
export interface HostService {
  readonly watcherPhone?: WatcherPhoneService | undefined
  watcherPhoneExclusions?(): { threadIds: string[]; projectIds: string[] }
  /** Numeric usage belongs to this host and exists only when its own startup gate is on. */
  readonly supportsUsage?: boolean
  usageRead?(query: UsageLocalQuery): Promise<UsageLocalHostRead>
  /** `background` is a refresh Usage made on its own when it opened, which may be answered from a recent reading. */
  usageRefresh?(providerIds?: ProviderId[], background?: boolean): Promise<UsageLocalHostRead>
  usageClear?(request: UsageLocalClearRequest, client: ClientIdentity): Promise<UsageLocalClearResult>
  readonly supportsWatcherControl?: boolean
  readonly supportsWatcherReads?: boolean
  readonly supportsWatcherStandingWatch?: boolean
  /** The host's threads report the background work counts work-settled news needs; without it they are unknown. */
  readonly supportsWatcherWorkSettled?: boolean
  /** The host's exact operation reads carry a delegation's outcome and reply; without it a desktop reads them as unknown. */
  readonly supportsWatcherOutcomes?: boolean
  /** The host takes requests from a Watcher on Muse; without it a desktop whose Watcher is on Muse leaves the host alone. */
  readonly supportsWatcherMuse?: boolean
  /** The host lists `watcher-cursor`: it takes Watcher requests whose identity names Cursor (ADR-0128). */
  readonly supportsWatcherCursor?: boolean
  subscribeWatcher?(listener: (projection: WatcherHostProjection) => void): () => void
  cachedWatcherProjection?(master: WatcherIdentity): WatcherHostProjection | undefined
  watcherRoomThreads?(threadIds: readonly string[]): WatcherRoomThreadInput[]
  watcherControl?(request: WatcherHostControl, client: ClientIdentity, guard: () => void, mayAnswer?: () => boolean): Promise<unknown>
  watcherRead?(request: WatcherHostRead, client: ClientIdentity, guard?: () => void, mayAnswer?: () => boolean): Promise<unknown>
  watcherProjection?(request: WatcherHostRead, client: ClientIdentity): WatcherHostProjection
  /** This service admits and sends an optional `send.draft` payload together, and saves a targeted Compose. */
  readonly supportsAtomicSend?: boolean
  /** Stable draft IDs, exact recovery revision guards and private socket save outcomes. */
  readonly supportsDraftRevisions?: boolean
  /** The host babysits pull requests and takes the user's Babysit pull request and Stop babysitting (ADR-0061). */
  readonly supportsBabysitting?: boolean
  /** The host reports its machine's host facts and how many of its threads are running (#1031); without it they read unknown. */
  readonly supportsHostFacts?: boolean
  hostFacts?(): Promise<HostMachineReport>
  /**
   * The host reports the GitHub repository of each of its projects (#1032), present only when its Owl answer turns on Work
   * across machines; without it a desktop cannot match this machine's projects by repository.
   */
  readonly supportsProjectOrigins?: boolean
  projectOrigins?(): Promise<ProjectOrigins>
  /**
   * The host runs delegation for its own threads and keeps the desktop defaults a desktop sends it (#1310), present only
   * on a headless host whose Owl answer turns on Work across machines. On a desktop's connection to such a host,
   * `desktopDefaults` sends them; on the host, it keeps them for the client that sent them.
   */
  readonly supportsHostDelegation?: boolean
  desktopDefaults?(defaults: DesktopDefaultsInput, client?: ClientIdentity): Promise<DesktopDefaultsReceipt>
  /**
   * The host answers the desktop window's read of its own threads' delegations (#1310), present only where it runs
   * delegation for them: what a thread delegated and was sent, and a delegated thread's newest brief, never a reply. Thread
   * IDs are the host's own. `subscribeDelegationViews` hears the threads whose delegations changed; on a desktop's
   * connection to a host it also hears the connection lost and taken again, after which every read may have moved.
   */
  readonly supportsDelegationViews?: boolean
  delegationViews?(threadId: string): Promise<DelegationsRead>
  delegationBrief?(threadId: string): Promise<DelegationBrief>
  subscribeDelegationViews?(listener: (change: DelegationViewsChange) => void): () => void
  /** The host continues agents as threads and forks at a reply (#1028): it takes `continue-agent` and reads `startHandover`. */
  readonly supportsThreadStarts?: boolean
  /** The host keeps which failed threads have been seen and takes `dismiss-failures` (ADR-0092); without it its failed
   * threads say Needs attention until their next turn. */
  readonly supportsFailureSeen?: boolean
  /** The host offers phones the pull request sheet (#1281, ADR-0102), present only when its Owl answer turns it on. */
  readonly supportsPullRequestView?: boolean
  /** The words of the handover a thread that began from another goes with on its first message, or null when it has none (#1028). */
  startHandover?(threadId: string): Promise<{ readonly text: string } | null>
  /**
   * Every message the user sent before `beforeMessageId`, from the thread's store, for the message scrubber (ADR-0109).
   * Null when the host cannot read its store, or keeps none.
   */
  threadPrompts?(threadId: string, beforeMessageId: string): Promise<AgentThreadPrompts | null>
  /** Everything in the log after this sequence number, for a client catching up after a reconnection. */
  events(afterSeq: number, threadId?: string, limit?: number): StoredThreadEvent[]
  subscribe(listener: (state: AgentState) => void): () => void
  /** One thread's kind as the host holds it now, read without copying any state (#917). Undefined for an unknown thread. */
  threadKind?(threadId: string): AgentThread['kind']
  /** One thread's provider as the host holds it now, read without copying any state (#1107). Undefined for an unknown thread. */
  threadProvider?(threadId: string): ProviderId | undefined
  /** One project's provider as the host holds it now, read without copying any state (#1107). Undefined for an unknown project. */
  projectProvider?(projectId: string): ProviderId | undefined
  /**
   * One activity record of a thread whole, read without copying the thread's history, for `activity-body`. Never edited by
   * the caller. Without it, the host reads the record from the thread's detail.
   */
  threadActivity?(threadId: string, activityId: string): AgentActivity | null
  /** The whole published state, history included. */
  state(): AgentState
  /** The published state without any thread's history: what every client needs on every frame. */
  shell(): AgentState
  /**
   * The shell as the host last published it or would publish it now, for a caller that only reads it: no copy of the
   * host's own state is made for it, so what it holds must never be written into. Absent, read `shell()`.
   */
  view?(): AgentState
  threadDetail(threadId: string): AgentThreadDetail | null
  /** Runs one client's command and answers with the shell, without history. A socket answer's returned
   * error is its own command outcome; it is independent of the published shell's shared error. */
  command(command: AgentCommand, client: ClientIdentity, answerDecisionId?: string): Promise<AgentState>
  requestAnswerRecovery?(threadId: string, providerId: ProviderId): RequestAnswerRecovery
  /** A user's explicit native read of this exact answer, never a send or a background receipt read. */
  checkRequestAnswer?(target: HostAnswerTarget, client: ClientIdentity): Promise<void>
  subscribeThreadDetail?(listener: (update: AgentThreadDetailUpdate) => void): () => void
  /** What a question page's token opens on this host, while its question waits and for an hour after (ADR-0085). */
  questionPage?(token: string): QuestionPageTarget | undefined
  /** A page was opened by its token, which clears the prototype-ready mark it belongs to (ADR-0108). */
  questionPageOpened?(token: string): void
  attachmentPreview?(request: AgentAttachmentPreviewRequest): AgentAttachmentPreviewResult | Promise<AgentAttachmentPreviewResult>
  /** One part of a sent attached file a message carries, for the iPhone's Quick Look (ADR-0131); null for anything else. */
  attachmentFile?(request: HostAttachmentFileRequest): Promise<HostAttachmentFile>
  /** Keeps an image's bytes on this host once and answers with the handle a draft carries instead (ADR-0031). */
  stageAttachment?(image: AgentAttachmentUpload): Promise<AgentAttachmentHandle>
  /** A staged image's bytes, for a composer restoring a chip it has no copy of; null once the host no longer keeps it. */
  attachmentContent?(digest: string): Promise<AgentAttachmentContent | null>
  /** The branches a thread's folder offers, read on request (ADR-0027). */
  gitRefs?(request: GitRefsRequest): Promise<GitRefsPage>
  /** The changed files of a thread's folder, for the commit dialog (ADR-0027). */
  gitChangedFiles?(request: GitChangedFilesRequest): Promise<GitChangedFiles>
  /** One pull request of a thread's, for the Pull request surface and its dialogs (ADR-0027). */
  gitPullRequest?(request: GitPullRequestRequest): Promise<GitPullRequestRead>
  /** One folder's subfolders on this host, for the Add project dialog's folder browser. */
  hostFolders?(request: HostFoldersRequest): Promise<HostFoldersResult>
  /** A folder's entries in a thread's working copy, for Files (ADR-0025, October 5 amendment). */
  threadFiles?(request: FileListRequest): Promise<FilesResult<FileListing>>
  /** One file's preview from a thread's working copy, for Files. */
  threadFilePreview?(request: FileRequest): Promise<FilesResult<FilePreview>>
  /** A thread's changed files as Git's status lists them, for Changes. */
  gitChanges?(request: ToolListRequest): Promise<ToolsResult<GitChangeListing>>
  /** A thread's Working tree or Branch changes comparison, for Changes. */
  gitReview?(request: GitReviewRequest): Promise<ToolsResult<GitReview>>
  /** A page of a thread's agents, for Agents. */
  subagentPage?(request: SubagentPageRequest): Promise<SubagentPage>
  /** One agent's assignments, for Agents. */
  subagentAssignments?(request: SubagentAssignmentsRequest): Promise<SubagentAssignmentsPage>
  /** The host offers the iPhone's Agents view (ADR-0103): its Owl answer turns it on. */
  readonly supportsAgentsView?: boolean
  /** The host keeps attached files that are not images (`file-staging`, ADR-0131): its Owl answer turns it on. */
  readonly supportsFileStaging?: boolean
  /** What delegation's record knows of each thread delegated below one thread, for the iPhone's Agents view (ADR-0103). */
  threadDelegations?(threadId: string): Promise<HostThreadDelegations>
}

/** What a host's delegation reads hear: the threads whose delegations changed, or its connection lost or taken again. */
export type DelegationViewsChange = { readonly threadIds: readonly string[] } | { readonly connected: boolean }

export interface RequestAnswerRecovery {
  uncertainRequestIds: string[]
  completed: { requestId: string; questionsDigest: string; decisionId?: string }[]
}

/** The part of the event store a client is allowed to read through the host. */
export interface ThreadEventSource {
  eventsAfter(seq: number, threadId?: string, limit?: number): StoredThreadEvent[]
}

/** A numeric archive and cached native allowance reads, without provider handles or message text. */
export interface HostUsageReads {
  read(query: UsageLocalQuery): Promise<UsageLocalHostRead>
  refresh(providerIds?: UsageProviderId[], background?: boolean): Promise<UsageLocalHostRead>
  clear(request: UsageLocalClearRequest): Promise<UsageLocalClearResult>
}

export const DESKTOP_WINDOW_CLIENT_ID = 'desktop-window'

/** The account Sotto is running as. Recorded locally; never logged, never sent. */
export function localUser(): string {
  try { return userInfo().username } catch { return '' }
}

export function desktopWindowClient(user: string = localUser()): ClientIdentity {
  return { clientId: DESKTOP_WINDOW_CLIENT_ID, user, transport: 'ipc' }
}

/** What `LocalHostService` needs of the coordinator: the client-facing half of `AgentControl`. */
export interface LocalHostControl {
  get(): AgentState
  watcherPhoneExclusions?(): { threadIds: string[]; projectIds: string[] }
  shell(): AgentState
  /** The shell a broadcast carries: its thread records hold the coordinator's own, so it is read and never written into. */
  broadcastShell?(): AgentState
  threadKind?(threadId: string): AgentThread['kind']
  threadProvider?(threadId: string): ProviderId | undefined
  projectProvider?(projectId: string): ProviderId | undefined
  threadActivity?(threadId: string, activityId: string): AgentActivity | null
  threadDetail(threadId: string): AgentThreadDetail | null
  subscribe(listener: (state: AgentState) => void): () => void
  /** Runs one client's command and answers with the shell, without copying any history. */
  commandShell(command: AgentCommand, client?: ClientIdentity, answerDecisionId?: string): Promise<AgentState>
  requestAnswerRecovery?(threadId: string, providerId: ProviderId): RequestAnswerRecovery
  checkRequestAnswer?(target: HostAnswerTarget, client: ClientIdentity): Promise<void>
  subscribeThreadDetail?(listener: (update: AgentThreadDetailUpdate) => void): () => void
  questionPage?(token: string): QuestionPageTarget | undefined
  questionPageOpened?(token: string): void
  attachmentPreview?(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult>
  attachmentFile?(request: HostAttachmentFileRequest): Promise<HostAttachmentFile>
  stageAttachment?(image: AgentAttachmentUpload): Promise<AgentAttachmentHandle>
  attachmentContent?(digest: string): Promise<AgentAttachmentContent | null>
  gitRefs?(request: GitRefsRequest): Promise<GitRefsPage>
  /** The changed files of a thread's folder, for the commit dialog (ADR-0027). */
  gitChangedFiles?(request: GitChangedFilesRequest): Promise<GitChangedFiles>
  /** One pull request of a thread's, for the Pull request surface and its dialogs (ADR-0027). */
  gitPullRequest?(request: GitPullRequestRequest): Promise<GitPullRequestRead>
  /** The threads some client shows now, for the finished-unread mark (ADR-0046); true when a mark was cleared. */
  showThreads?(threadIds: readonly string[]): boolean
}

/**
 * The host as it stands today: one process, one client, and the IPC the preload bridge already
 * carries between them. Every command arrives with the identity of the client that sent it, so the
 * boundary is the same one a socket would cross.
 */
export class LocalHostService implements HostService {
  watcherPhoneExclusions(): { threadIds: string[]; projectIds: string[] } { return this.control.watcherPhoneExclusions?.() ?? { threadIds: [], projectIds: [] } }
  get watcherPhone(): WatcherPhoneService | undefined { return this.options.watcherPhone }
  readonly supportsUsage: boolean
  get supportsWatcherControl(): boolean { return this.options.watcher !== undefined }
  get supportsWatcherReads(): boolean { return this.options.watcher !== undefined }
  get supportsWatcherStandingWatch(): boolean { return this.options.watcher !== undefined }
  // Answered as host protocol version 1 has them, so a desktop from before #1183 still reads them.
  async watcherControl(request: WatcherHostControl, client: ClientIdentity, guard: () => void, mayAnswer?: () => boolean): Promise<unknown> { return watcherResultForHostV1(await this.options.watcher!.admitRemote(request, client.clientId, guard, mayAnswer)) }
  async watcherRead(request: WatcherHostRead, client: ClientIdentity, guard?: () => void, mayAnswer?: () => boolean): Promise<unknown> { return watcherResultForHostV1(await this.options.watcher!.readRemote(request, client.clientId, guard, mayAnswer)) }
  watcherProjection(request: WatcherHostRead, client: ClientIdentity): WatcherHostProjection { return this.options.watcher!.remoteProjection(request.master, client.clientId) }
  readonly supportsAtomicSend = true
  readonly supportsDraftRevisions = true
  readonly supportsBabysitting: boolean
  private readonly observations = new Map<string, string[]>()
  /** Of each client's observed threads, the ones it shows, where it said that is fewer (`shownThreadIds`). */
  private readonly shownBy = new Map<string, string[]>()
  /**
   * Whether this computer's own window has the focus. Its panes show their threads only while it does (ADR-0046): a
   * thread that finishes behind another app, minimised or hidden to the tray is finished unread. A host with no window
   * to ask leaves it true, and a host without a screen has no window client at all.
   */
  private windowFocused = true
  private readonly control: LocalHostControl
  private readonly eventSource: ThreadEventSource | undefined
  private readonly tools: HostThreadToolReads | undefined
  private readonly usage: HostUsageReads | undefined
  private readonly mayClearUsage: (client: ClientIdentity) => boolean

  /** `tools` are the runtime's reads of its threads' Files, Changes and Agents, for a paired client (ADR-0025, October 5 amendment). */
  /** `facts` reads this machine's report, the same way on the desktop and on a headless host (#1031). */
  constructor(private readonly options: { control: LocalHostControl; events?: ThreadEventSource; tools?: HostThreadToolReads; babysitting?: boolean; usage?: HostUsageReads; mayClearUsage?: (client: ClientIdentity) => boolean; watcher?: WatcherService; watcherPhone?: WatcherPhoneService; facts?: () => Promise<HostMachineReport>
    /** Continuing agents and forking at a reply (#1028), present only when the host's Owl answer turns them on. */
    threadStarts?: { startHandover(threadId: string): { readonly text: string } | undefined }
    /** The prompts the thread store holds above a pane's window, for the message scrubber (ADR-0109). */
    prompts?: { threadPrompts(threadId: string, beforeMessageId: string): AgentThreadPrompts | null }
    /** The iPhone's pull request sheet (#1281), true only when the host's Owl answer turns it on. */
    pullRequestView?: boolean
    /** Attached files that are not images (ADR-0131), true only when the host's Owl answer turns it on. */
    fileStaging?: boolean
    /**
     * The iPhone's Agents view (ADR-0103), present only when the host's Owl answer turns it on. `delegations` is there only
     * where delegation runs (ADR-0081); without it a thread has no delegated threads to read.
     */
    agentsView?: { delegations?(threadId: string, threads: readonly AgentThread[]): HostThreadDelegations }
    /** Each project's GitHub origin (#1032), present only when the host's Owl answer turns on Work across machines. */
    projectOrigins?: (projects: readonly AgentProject[]) => Promise<ProjectOrigins>
    /** Where a headless host keeps the desktop defaults (#1310), present only where it runs delegation for its own threads. */
    desktopDefaults?: { record(clientId: string, defaults: DesktopDefaultsInput): Promise<DesktopDefaultsReceipt> }
    /** Delegation's own record of the host's threads (#1310), present only where a headless host runs delegation for them. */
    delegationViews?: DelegationViews }) {
    this.control = options.control
    this.supportsBabysitting = options.babysitting === true
    this.eventSource = options.events
    this.tools = options.tools
    this.usage = options.usage
    this.supportsUsage = options.usage !== undefined
    this.mayClearUsage = options.mayClearUsage ?? (client => mayGrantLocally(client).allowed)
  }

  get supportsHostFacts(): boolean { return this.options.facts !== undefined }
  get supportsThreadStarts(): boolean { return this.options.threadStarts !== undefined }
  get supportsProjectOrigins(): boolean { return this.options.projectOrigins !== undefined }
  get supportsHostDelegation(): boolean { return this.options.desktopDefaults !== undefined }
  /** Keeps a desktop's defaults for the client that sent them; the socket listener admits only a recorded desktop. */
  desktopDefaults(defaults: DesktopDefaultsInput, client: ClientIdentity): Promise<DesktopDefaultsReceipt> {
    if (!this.options.desktopDefaults) return Promise.reject(new Error('This host does not keep desktop defaults.'))
    return this.options.desktopDefaults.record(client.clientId, defaults)
  }
  get supportsDelegationViews(): boolean { return this.options.delegationViews !== undefined }
  /** Read from delegation's own record, never a snapshot, as the desktop's own window reads this computer's (#1029). */
  async delegationViews(threadId: string): Promise<DelegationsRead> {
    if (!this.options.delegationViews) throw new Error('This host does not run delegation for its threads.')
    const { made, received } = this.options.delegationViews.views(threadId)
    return { threadId, delegations: [...made], received: [...received] }
  }
  async delegationBrief(threadId: string): Promise<DelegationBrief> {
    if (!this.options.delegationViews) throw new Error('This host does not run delegation for its threads.')
    const text = this.options.delegationViews.brief(threadId)
    return text === undefined ? null : { threadId, text }
  }
  subscribeDelegationViews(listener: (change: DelegationViewsChange) => void): () => void {
    return this.options.delegationViews?.onViewsChanged(threadIds => listener({ threadIds })) ?? (() => undefined)
  }
  /** Read from the projects as the host last published them, without copying them. */
  projectOrigins(): Promise<ProjectOrigins> {
    if (!this.options.projectOrigins) return Promise.reject(new Error('This host does not report the repositories of its projects.'))
    return this.options.projectOrigins(this.view().host.projects)
  }
  get supportsPullRequestView(): boolean { return this.options.pullRequestView === true }
  get supportsAgentsView(): boolean { return this.options.agentsView !== undefined }
  get supportsFileStaging(): boolean { return this.options.fileStaging === true }
  /** Reads the threads as the host last published them, without copying them. */
  async threadDelegations(threadId: string): Promise<HostThreadDelegations> {
    if (!this.options.agentsView) throw new Error('The Agents view is unavailable on this host.')
    return this.options.agentsView.delegations?.(threadId, this.view().host.threads) ?? { threadId, threads: [] }
  }
  /** Every coordinator keeps the failures its clients have seen (ADR-0092). */
  readonly supportsFailureSeen = true
  async startHandover(threadId: string): Promise<{ readonly text: string } | null> {
    if (!this.options.threadStarts) throw new Error('Continuing an agent as a thread is unavailable on this host.')
    const built = this.options.threadStarts.startHandover(threadId)
    return built ? { text: startHandoverPrefix(built.text).trimEnd() } : null
  }
  async threadPrompts(threadId: string, beforeMessageId: string): Promise<AgentThreadPrompts | null> {
    return this.options.prompts?.threadPrompts(threadId, beforeMessageId) ?? null
  }
  hostFacts(): Promise<HostMachineReport> {
    if (!this.options.facts) return Promise.reject(new Error('This host does not report its machine facts.'))
    return this.options.facts()
  }

  usageRead(query: UsageLocalQuery): Promise<UsageLocalHostRead> {
    if (!this.usage) return Promise.reject(new Error('Usage is unavailable on this host.'))
    return this.usage.read(usageLocalQuerySchema.parse(query))
  }
  usageRefresh(providerIds?: ProviderId[], background = false): Promise<UsageLocalHostRead> {
    if (!this.usage) return Promise.reject(new Error('Usage is unavailable on this host.'))
    const named = providerIds === undefined ? undefined : usageProviderIdSchema.array().max(usageProviderIdSchema.options.length).parse(providerIds)
    return background ? this.usage.refresh(named, true) : this.usage.refresh(named)
  }
  usageClear(request: UsageLocalClearRequest, client: ClientIdentity): Promise<UsageLocalClearResult> {
    if (!this.usage) return Promise.reject(new Error('Usage is unavailable on this host.'))
    if (!this.mayClearUsage(client)) return Promise.reject(new Error(REMOTE_PERMISSION_DENIED))
    return this.usage.clear(usageLocalClearRequestSchema.parse(request))
  }

  /** Empty when no event source is wired: the window reads history through the thread detail today. */
  events(afterSeq: number, threadId?: string, limit?: number): StoredThreadEvent[] {
    return this.eventSource?.eventsAfter(afterSeq, threadId, limit) ?? []
  }

  subscribe(listener: (state: AgentState) => void): () => void {
    // Watcher publishes on every coordinator broadcast, just before this service hears that same broadcast. Handing on a
    // fresh shell for it copied the whole state a second time per update, so a Watcher change is handed on a microtask
    // later, and only when no broadcast has come since the latest Watcher change. A Watcher change on its own, or one after
    // the broadcast, still reaches clients.
    let sequence = 0, broadcastAt = 0, changedAt = 0, waiting = false, closed = false
    const off = this.control.subscribe(state => { broadcastAt = ++sequence; listener(state) })
    const forward = (): void => {
      changedAt = ++sequence
      if (waiting) return
      waiting = true
      queueMicrotask(() => { waiting = false; if (!closed && changedAt > broadcastAt) listener(this.view()) })
    }
    const watcherOff = this.options.watcher?.subscribe(forward)
    const phoneOff = this.watcherPhone?.subscribe(forward)
    return () => { closed = true; off(); watcherOff?.(); phoneOff?.() }
  }
  state(): AgentState { return this.control.get() }
  shell(): AgentState { return this.control.shell() }
  /** What a broadcast would carry now. A Watcher change handed on with a whole copy of the shell cost what a broadcast did. */
  view(): AgentState { return this.control.broadcastShell?.() ?? this.control.shell() }
  threadKind(threadId: string): AgentThread['kind'] {
    return this.control.threadKind ? this.control.threadKind(threadId) : this.control.shell().host.threads.find(thread => thread.id === threadId)?.kind
  }
  threadProvider(threadId: string): ProviderId | undefined { return this.control.threadProvider?.(threadId) }
  projectProvider(projectId: string): ProviderId | undefined { return this.control.projectProvider?.(projectId) }
  threadDetail(threadId: string): AgentThreadDetail | null { return this.control.threadDetail(threadId) }
  threadActivity(threadId: string, activityId: string): AgentActivity | null {
    return this.control.threadActivity ? this.control.threadActivity(threadId, activityId) : this.control.threadDetail(threadId)?.activities?.find(record => record.id === activityId) ?? null
  }
  async checkRequestAnswer(target: HostAnswerTarget, client: ClientIdentity): Promise<void> {
    if (!this.control.checkRequestAnswer) throw new RequestAnswerCheckRefusal('unsupported')
    await this.control.checkRequestAnswer(target, client)
  }
  subscribeThreadDetail(listener: (update: AgentThreadDetailUpdate) => void): () => void { return this.control.subscribeThreadDetail?.(listener) ?? (() => undefined) }
  questionPage(token: string): QuestionPageTarget | undefined { return this.control.questionPage?.(token) }
  questionPageOpened(token: string): void { this.control.questionPageOpened?.(token) }
  async attachmentPreview(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult> { return await this.control.attachmentPreview?.(request) ?? null }
  async attachmentFile(request: HostAttachmentFileRequest): Promise<HostAttachmentFile> { return await this.control.attachmentFile?.(request) ?? null }
  stageAttachment(image: AgentAttachmentUpload): Promise<AgentAttachmentHandle> {
    if (!this.control.stageAttachment) return Promise.reject(new Error(HOST_CANNOT_STAGE_SCREENSHOTS))
    return this.control.stageAttachment(image)
  }
  async attachmentContent(digest: string): Promise<AgentAttachmentContent | null> { return await this.control.attachmentContent?.(digest) ?? null }
  gitRefs(request: GitRefsRequest): Promise<GitRefsPage> {
    if (!this.control.gitRefs) return Promise.reject(new Error('Branches are unavailable on this host.'))
    return this.control.gitRefs(request)
  }
  gitChangedFiles(request: GitChangedFilesRequest): Promise<GitChangedFiles> {
    if (!this.control.gitChangedFiles) return Promise.reject(new Error('Changed files are unavailable on this host.'))
    return this.control.gitChangedFiles(request)
  }
  gitPullRequest(request: GitPullRequestRequest): Promise<GitPullRequestRead> {
    if (!this.control.gitPullRequest) return Promise.reject(new Error('Pull requests are unavailable on this host.'))
    return this.control.gitPullRequest(request)
  }
  // The folder browser reads this machine, not the coordinator, so it goes straight to the filesystem
  // rather than through `LocalHostControl`.
  hostFolders(request: HostFoldersRequest): Promise<HostFoldersResult> { return listHostFolders(request) }
  requestAnswerRecovery(threadId: string, providerId: ProviderId): RequestAnswerRecovery {
    return this.control.requestAnswerRecovery?.(threadId, providerId) ?? { uncertainRequestIds: [], completed: [] }
  }
  // A thread's Files, Changes and Agents, read as the window's own IPC reads them, with the same bounds.
  async threadFiles(request: FileListRequest): Promise<FilesResult<FileListing>> { return this.reads().threadFiles(request) }
  async threadFilePreview(request: FileRequest): Promise<FilesResult<FilePreview>> { return this.reads().threadFilePreview(request) }
  async gitChanges(request: ToolListRequest): Promise<ToolsResult<GitChangeListing>> { return this.reads().gitChanges(request) }
  async gitReview(request: GitReviewRequest): Promise<ToolsResult<GitReview>> { return this.reads().gitReview(request) }
  async subagentPage(request: SubagentPageRequest): Promise<SubagentPage> { return this.reads().subagentPage(request) }
  async subagentAssignments(request: SubagentAssignmentsRequest): Promise<SubagentAssignmentsPage> { return this.reads().subagentAssignments(request) }
  private reads(): HostThreadToolReads {
    if (!this.tools) throw new Error('Files, Changes and Agents are unavailable on this host.')
    return this.tools
  }
  async command(command: AgentCommand, client: ClientIdentity, answerDecisionId?: string): Promise<AgentState> {
    if (command.type !== 'observe-threads') return answerDecisionId ? this.control.commandShell(command, client, answerDecisionId) : this.control.commandShell(command, client)
    if (command.threadIds.length) this.observations.set(client.clientId, command.threadIds)
    else this.observations.delete(client.clientId)
    if (command.threadIds.length && command.shownThreadIds !== undefined) this.shownBy.set(client.clientId, command.shownThreadIds)
    else this.shownBy.delete(client.clientId)
    // What every client observes is what the host loads and streams, focused or not; only showing waits on the focus.
    const state = await this.control.commandShell({ type: 'observe-threads', threadIds: [...new Set([...this.observations.values()].flat())] }, client)
    return this.control.showThreads?.(this.shownThreads()) ? this.control.shell() : state
  }
  /** Main reports the window's focus as it moves; gaining it shows the window's panes again, which reads their finish. */
  setWindowFocused(focused: boolean): void {
    if (focused === this.windowFocused) return
    this.windowFocused = focused
    this.control.showThreads?.(this.shownThreads())
  }
  /**
   * The threads some client shows: every client's observed threads, the window's only while it has the focus, and a
   * client that said which of its threads it shows (the socket server, for paired desktops behind another app) only those.
   */
  private shownThreads(): string[] {
    return [...new Set([...this.observations].flatMap(([clientId, ids]) => clientId === DESKTOP_WINDOW_CLIENT_ID && !this.windowFocused ? []
      : this.shownBy.get(clientId) ?? ids))]
  }
}
