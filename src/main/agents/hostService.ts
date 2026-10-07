import { userInfo } from 'node:os'

import { HOST_CANNOT_STAGE_SCREENSHOTS, type ProviderId, type AgentAttachmentContent, type AgentAttachmentHandle, type AgentAttachmentUpload, type AgentCommand, type AgentState, type AgentThreadDetail, type AgentThreadDetailUpdate, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult } from '../../shared/agents'
import type { StoredThreadEvent } from '../../shared/threadEvents'
import type { GitRefsPage, GitRefsRequest } from '../../shared/gitRefs'
import type { GitChangedFiles, GitChangedFilesRequest } from '../../shared/gitChangedFiles'
import type { GitPullRequestDetail, GitPullRequestRequest } from '../../shared/gitPullRequests'
import type { HostFoldersRequest, HostFoldersResult } from '../../shared/hostFolders'
import type { FileListing, FileListRequest, FilePreview, FileRequest, FilesResult } from '../../shared/files'
import type { GitChangeListing, GitReview, GitReviewRequest } from '../../shared/gitChanges'
import type { SubagentAssignmentsPage, SubagentAssignmentsRequest, SubagentPage, SubagentPageRequest } from '../../shared/subagents'
import type { ToolListRequest, ToolsResult } from '../../shared/tools'
import { listHostFolders } from './hostFolders'
import type { HostThreadToolReads } from './threadToolReads'
import type { HostAnswerTarget, HostErrorCode } from '../../shared/hostProtocol'
import { REMOTE_PERMISSION_DENIED } from './authority'

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
  /** Everything in the log after this sequence number, for a client catching up after a reconnection. */
  events(afterSeq: number, threadId?: string, limit?: number): StoredThreadEvent[]
  subscribe(listener: (state: AgentState) => void): () => void
  /** The whole published state, history included. */
  state(): AgentState
  /** The published state without any thread's history: what every client needs on every frame. */
  shell(): AgentState
  threadDetail(threadId: string): AgentThreadDetail | null
  /** Runs one client's command and answers with the shell, without history. A socket answer's returned
   * error is its own command outcome; it is independent of the published shell's shared error. */
  command(command: AgentCommand, client: ClientIdentity, answerDecisionId?: string): Promise<AgentState>
  requestAnswerRecovery?(threadId: string, providerId: ProviderId): RequestAnswerRecovery
  /** A user's explicit native read of this exact answer, never a send or a background receipt read. */
  checkRequestAnswer?(target: HostAnswerTarget, client: ClientIdentity): Promise<void>
  subscribeThreadDetail?(listener: (update: AgentThreadDetailUpdate) => void): () => void
  attachmentPreview?(request: AgentAttachmentPreviewRequest): AgentAttachmentPreviewResult | Promise<AgentAttachmentPreviewResult>
  /** Keeps an image's bytes on this host once and answers with the handle a draft carries instead (ADR-0031). */
  stageAttachment?(image: AgentAttachmentUpload): Promise<AgentAttachmentHandle>
  /** A staged image's bytes, for a composer restoring a chip it has no copy of; null once the host no longer keeps it. */
  attachmentContent?(digest: string): Promise<AgentAttachmentContent | null>
  /** The branches a thread's folder offers, read on request (ADR-0027). */
  gitRefs?(request: GitRefsRequest): Promise<GitRefsPage>
  /** The changed files of a thread's folder, for the commit dialog (ADR-0027). */
  gitChangedFiles?(request: GitChangedFilesRequest): Promise<GitChangedFiles>
  /** One pull request of a thread's, for the Pull request surface and its dialogs (ADR-0027). */
  gitPullRequest?(request: GitPullRequestRequest): Promise<GitPullRequestDetail | null>
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
}

export interface RequestAnswerRecovery {
  uncertainRequestIds: string[]
  completed: { requestId: string; questionsDigest: string; decisionId?: string }[]
}

/** The part of the event store a client is allowed to read through the host. */
export interface ThreadEventSource {
  eventsAfter(seq: number, threadId?: string, limit?: number): StoredThreadEvent[]
}

export const DESKTOP_WINDOW_CLIENT_ID = 'desktop-window'
/** Sotto's own supervision, so a record shows an answer that came from Sotto rather than the user. */
export const SUPERVISION_CLIENT_ID = 'sotto-supervision'

/** The account Sotto is running as. Recorded locally; never logged, never sent. */
export function localUser(): string {
  try { return userInfo().username } catch { return '' }
}

export function desktopWindowClient(user: string = localUser()): ClientIdentity {
  return { clientId: DESKTOP_WINDOW_CLIENT_ID, user, transport: 'ipc' }
}

/**
 * Supervision answers nothing on the user's behalf (ADR-0004); when it sends a follow-up the record
 * needs to say that Sotto sent it, which is bookkeeping and not a grant.
 */
export function supervisionClient(user: string = localUser()): ClientIdentity {
  return { clientId: SUPERVISION_CLIENT_ID, user, transport: 'ipc' }
}

/** What `LocalHostService` needs of the coordinator: the client-facing half of `AgentControl`. */
export interface LocalHostControl {
  get(): AgentState
  shell(): AgentState
  threadDetail(threadId: string): AgentThreadDetail | null
  subscribe(listener: (state: AgentState) => void): () => void
  /** Runs one client's command and answers with the shell, without copying any history. */
  commandShell(command: AgentCommand, client?: ClientIdentity, answerDecisionId?: string): Promise<AgentState>
  requestAnswerRecovery?(threadId: string, providerId: ProviderId): RequestAnswerRecovery
  checkRequestAnswer?(target: HostAnswerTarget, client: ClientIdentity): Promise<void>
  subscribeThreadDetail?(listener: (update: AgentThreadDetailUpdate) => void): () => void
  attachmentPreview?(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult>
  stageAttachment?(image: AgentAttachmentUpload): Promise<AgentAttachmentHandle>
  attachmentContent?(digest: string): Promise<AgentAttachmentContent | null>
  gitRefs?(request: GitRefsRequest): Promise<GitRefsPage>
  /** The changed files of a thread's folder, for the commit dialog (ADR-0027). */
  gitChangedFiles?(request: GitChangedFilesRequest): Promise<GitChangedFiles>
  /** One pull request of a thread's, for the Pull request surface and its dialogs (ADR-0027). */
  gitPullRequest?(request: GitPullRequestRequest): Promise<GitPullRequestDetail | null>
  /** The threads some client shows now, for the finished-unread mark (ADR-0046); true when a mark was cleared. */
  showThreads?(threadIds: readonly string[]): boolean
}

/**
 * The host as it stands today: one process, one client, and the IPC the preload bridge already
 * carries between them. Every command arrives with the identity of the client that sent it, so the
 * boundary is the same one a socket would cross.
 */
export class LocalHostService implements HostService {
  private readonly observations = new Map<string, string[]>()
  /**
   * Whether this computer's own window has the focus. Its panes show their threads only while it does (ADR-0046): a
   * thread that finishes behind another app, minimised or hidden to the tray is finished unread. A host with no window
   * to ask leaves it true, and a host without a screen has no window client at all.
   */
  private windowFocused = true
  private readonly control: LocalHostControl
  private readonly eventSource: ThreadEventSource | undefined
  private readonly tools: HostThreadToolReads | undefined

  /** `tools` are the runtime's reads of its threads' Files, Changes and Agents, for a paired client (ADR-0025, October 5 amendment). */
  constructor(options: { control: LocalHostControl; events?: ThreadEventSource; tools?: HostThreadToolReads }) {
    this.control = options.control
    this.eventSource = options.events
    this.tools = options.tools
  }

  /** Empty when no event source is wired: the window reads history through the thread detail today. */
  events(afterSeq: number, threadId?: string, limit?: number): StoredThreadEvent[] {
    return this.eventSource?.eventsAfter(afterSeq, threadId, limit) ?? []
  }

  subscribe(listener: (state: AgentState) => void): () => void { return this.control.subscribe(listener) }
  state(): AgentState { return this.control.get() }
  shell(): AgentState { return this.control.shell() }
  threadDetail(threadId: string): AgentThreadDetail | null { return this.control.threadDetail(threadId) }
  async checkRequestAnswer(target: HostAnswerTarget, client: ClientIdentity): Promise<void> {
    if (!this.control.checkRequestAnswer) throw new RequestAnswerCheckRefusal('unsupported')
    await this.control.checkRequestAnswer(target, client)
  }
  subscribeThreadDetail(listener: (update: AgentThreadDetailUpdate) => void): () => void { return this.control.subscribeThreadDetail?.(listener) ?? (() => undefined) }
  async attachmentPreview(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult> { return await this.control.attachmentPreview?.(request) ?? null }
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
  gitPullRequest(request: GitPullRequestRequest): Promise<GitPullRequestDetail | null> {
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
  /** The threads some client shows: every client's observed threads, the window's only while it has the focus. */
  private shownThreads(): string[] {
    return [...new Set([...this.observations].flatMap(([clientId, ids]) => clientId === DESKTOP_WINDOW_CLIENT_ID && !this.windowFocused ? [] : ids))]
  }
}
