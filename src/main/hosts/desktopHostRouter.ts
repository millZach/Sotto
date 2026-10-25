import type { AgentThreadPrompts, AgentThreadPromptsRequest } from '../../shared/threadPrompts'
import type { AgentActivity } from '../../shared/agentActivity'
import { startsThread, THREAD_STARTS_UNSUPPORTED } from '../../shared/threadStarts'
import { catalogWithoutHeld, modelsWithoutHeld, heldProviderOfCommand, heldProviderOfWatcherRequest, heldProviderRefusedBy, heldWatcherRefusal, rememberDormantProviderThreads, type DormantProviderThread } from '../agents/heldProviderGate'
import { heldProviderRefusal, heldProvidersOption, type HeldProviders } from '../../shared/heldProviders'
import { watcherRoomInputs } from '../agents/watcherRoomInput'
import { visibleWatcherState, watcherThreadVisible, withoutThreads } from '../../shared/watcherVisibility'
import { parsePublicProviderEntityId, providerIdSchema } from '../../shared/agents'
import type { WatcherHostControl, WatcherHostRead, WatcherRemoteHosts } from '../../shared/watcherHost'
import { WATCHER_DISABLED } from '../agents/watcherLaunchProfiles'
import { randomUUID } from 'node:crypto'
import { isAgentThreadDetailDelta } from '../../shared/agentThreadDetail'
import { agentCommandSchema, isImageAttachment, defaultNewThreadModelId, defaultThreadModelId, enabledThreadProviders, MAX_DELIVERED_DRAFTS, HOST_CANNOT_STAGE_SCREENSHOTS, HOST_DISCONNECTED_BEFORE_FILES, SCREENSHOT_WRONG_TYPE, agentShell, isThreadProviderConnected, nameHostInRefusal, type ProviderId, type AgentThread, type AgentAttachmentContent, type AgentAttachmentContentRequest, type AgentAttachmentHandle, type AgentAttachmentStageRequest, type AgentAttachmentUpload, type AgentCommand, type AgentState, type AgentThreadDetail, type AgentThreadDetailUpdate, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult } from '../../shared/agents'
import { clientThreadId, hostEntityKey, mapHostReferences, parseHostEntityKey, projectClientAgentState, type ClientAgentStateProjection } from '../../shared/clientIdentity'
import type { QuestionPageTarget } from '../agents/questionPages'
import { desktopWindowClient, type ClientIdentity, type HostService, type RequestAnswerRecovery } from '../agents/hostService'
import { requestDraftProvider, requestDraftQuestions, type RequestDraftOwner, type RequestDraftTarget } from '../../shared/requestDrafts'
import { requestQuestionsDigest, type BindRequestDraftDecision, type RequestDraftOwnerState, type RequestDraftService } from '../agents/requestDrafts'
import { LEGACY_MANAGEMENT_ALLOWED_COMMANDS, LEGACY_MANAGEMENT_UPDATE, type HostAnswerTarget, type HostClientShell } from '../../shared/hostProtocol'
import { NEW_THREAD_DEFAULT_FIELDS } from '../../shared/newThreadDefaults'
import type { GitRefsPage, GitRefsRequest } from '../../shared/gitRefs'
import type { GitChangedFiles, GitChangedFilesRequest } from '../../shared/gitChangedFiles'
import type { GitPullRequestRead, GitPullRequestRequest } from '../../shared/gitPullRequests'
import type { HostFoldersClientRequest, HostFoldersRequest, HostFoldersResult } from '../../shared/hostFolders'
import type { FileListing, FileListRequest, FilePath, FilePreview, FileRequest, FilesResult } from '../../shared/files'
import type { GitChangeListing, GitPathRequest, GitReview, GitReviewRequest } from '../../shared/gitChanges'
import type { SubagentAssignmentsPage, SubagentAssignmentsRequest, SubagentPage, SubagentPageRequest } from '../../shared/subagents'
import type { ToolListRequest, ToolsResult } from '../../shared/tools'
import type { HostThreadToolReads } from '../agents/threadToolReads'
import { HostConnectionError, REMOTE_COMPOSE_UNSAVED } from '../agents/socketHostService'
import { USAGE_HOSTS_MAX, usageClearQuerySchema, usageDashboardReadSchema, usageLocalClearResultSchema, usageLocalHostReadSchema, usageProviderIdSchema, usageQuerySchema, usageRefreshQuerySchema, type UsageClearQuery, type UsageClearResult, type UsageDashboardRead, type UsageHostRead, type UsageProviderId, type UsageQuery, type UsageRefreshQuery } from '../../shared/usageDashboard'

/** A thread's Files, Changes and Agents reads (ADR-0025, October 5 amendment), by the host's own IDs; absent on a connection that has none. */
export interface DesktopHostConnection extends Partial<HostThreadToolReads> {
  hostId: string
  name: string
  kind: 'local' | 'remote'
  service: Pick<HostService, 'shell' | 'threadKind' | 'command' | 'subscribe' | 'requestAnswerRecovery' | 'checkRequestAnswer' | 'supportsAtomicSend' | 'supportsDraftRevisions' | 'supportsUsage' | 'usageRead' | 'usageRefresh' | 'usageClear' | 'supportsWatcherControl' | 'supportsWatcherReads' | 'supportsWatcherStandingWatch' | 'supportsWatcherWorkSettled' | 'supportsWatcherOutcomes' | 'supportsWatcherMuse' | 'supportsWatcherCursor' | 'supportsHostFacts' | 'hostFacts' | 'supportsThreadStarts' | 'supportsFailureSeen' | 'startHandover' | 'threadPrompts' | 'watcherControl' | 'subscribeWatcher' | 'cachedWatcherProjection' | 'watcherRead' | 'watcherRoomThreads'>
  refreshRequestAnswer?(decisionId: string, target: HostAnswerTarget): Promise<void>
  detail(threadId: string): AgentThreadDetail | null | Promise<AgentThreadDetail | null>
  preview(request: AgentAttachmentPreviewRequest): AgentAttachmentPreviewResult | Promise<AgentAttachmentPreviewResult>
  /** Stages on this host, the one that runs the thread (ADR-0031). */
  stage?(image: AgentAttachmentUpload): Promise<AgentAttachmentHandle>
  content?(digest: string): Promise<AgentAttachmentContent | null>
  gitRefs?(request: GitRefsRequest): Promise<GitRefsPage>
  gitChangedFiles?(request: GitChangedFilesRequest): Promise<GitChangedFiles>
  gitPullRequest?(request: GitPullRequestRequest): Promise<GitPullRequestRead>
  hostFolders?(request: HostFoldersRequest): Promise<HostFoldersResult>
  /** Whether this host lists `client-updates`: only then do its client updates reach the window (#480). */
  offersClientUpdates?(): boolean
  /** Whether this host's `check-client-updates` keeps what an update already run said (ADR-0077, October 21 amendment). */
  keepsClientOutcomes?(): boolean
  /** Whether this host babysits pull requests: only then does the window offer Babysit pull request on its threads (ADR-0061). */
  offersBabysitting?(): boolean
  /** `shown`: false while the desktop's window is behind another app, so the host does not count these threads as shown
   * (ADR-0092). Absent, they are shown. */
  observe?(threadIds: string[], shown?: boolean): Promise<unknown>
  /** One activity record whole, by the host's own thread ID, for a row whose body the host sent cut; absent on this computer. */
  activityBody?(threadId: string, activityId: string): Promise<AgentActivity | null>
  subscribeDetail?(listener: (detail: AgentThreadDetailUpdate) => void): () => void
  available?: () => boolean
  /** What a question page's token opens on this computer's own host (ADR-0085). */
  questionPage?(token: string): QuestionPageTarget | undefined
  /** This computer's host hears that one of its pages was opened, which clears the prototype-ready mark it belongs to (ADR-0108). */
  questionPageOpened?(token: string): void
  /** Where a remote host serves a question page, as this computer's browser reaches it (ADR-0085). */
  pageAddress?(token: string): string | undefined
}

/**
 * How this computer opens one of a question's pages: a file of its own, or an address in the browser (ADR-0085). A file
 * keeps its token and start, so Sotto's browser can open it through the phone access listener instead (ADR-0108).
 */
export type QuestionPageOpening = { readonly kind: 'file'; readonly file: string; readonly token: string; readonly start: string } | { readonly kind: 'url'; readonly url: string }

/** Creation opens its result unless the window selected something else while it ran. */
const SELECTING_COMMANDS: ReadonlySet<AgentCommand['type']> = new Set(['create-thread', 'create-project', 'continue-agent', 'fork-thread'])
/** The commands that may name the machine they act on, which the router reads and never sends on. */
const HOST_NAMED_COMMANDS: ReadonlySet<AgentCommand['type']> = new Set(['connect', 'disconnect', 'refresh', 'check-client-updates', 'update-client', 'queue-client-updates'])
/**
 * A read the window made on its own, when it regained focus or a pane opened, not anything the user pressed. A host that
 * cannot answer one is already shown as disconnected or reconnecting, so it answers with the shell rather than a failure.
 */
const windowRead = (command: AgentCommand): boolean => command.type === 'refresh-thread-worktree' && command.background === true
/** The connection to a host closed under a request; the host itself refused nothing. */
const droppedConnection = (error: unknown): boolean => error instanceof HostConnectionError && error.code === 'disconnected'

/** A state without its client updates, which belong to the machine that runs those clients. */
/**
 * What Dismiss all says when a host kept its failed threads as they were: one that predates the seen record, or one that
 * is out of reach or did not answer. Its threads still say Needs attention; nothing else was touched.
 */
function dismissLeft(left: readonly { readonly name: string; readonly older: boolean }[]): string {
  const [first] = left
  if (left.length === 1 && first) return first.older
    ? `${first.name} runs an older Sotto, so its threads still say Needs attention. Nothing was changed there. Update it in Settings > Hosts & phones, then press Dismiss all again.`
    : `${first.name} did not answer, so its threads still say Needs attention. Nothing was changed there. Connect to it again, then press Dismiss all again.`
  return `${left.map(item => item.name).join(', ')} kept their threads as they were, so those still say Needs attention. Nothing was changed there. Update or connect to each host in Settings > Hosts & phones, then press Dismiss all again.`
}
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

/** One host's threads as a build gave them to the window, and what each was made from. */
interface BuiltThreads {
  readonly from: readonly AgentThread[]
  readonly made: readonly AgentThread[]
  readonly hostLabel: string | undefined
  readonly remoteHost: boolean
  readonly reconnecting: boolean
}
/** What the last publication made of one host's state, for the next build to reuse where nothing changed (#1335). */
interface BuiltHost { readonly projection: ClientAgentStateProjection; readonly threads: BuiltThreads }

type RouterNotice = { message: string; answer?: { hostId: string; decisionId: string; target: HostAnswerTarget }; unsupportedCompose?: DesktopHostConnection }
type RequestDraftRecovery = Pick<RequestDraftService, 'heldThreadAnswers' | 'reconcile'>

/** Numeric requests have no replay. A late clear may have succeeded; the next read supplies its current revision. */
async function usageDeadline<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Usage could not be read.')), 20000) })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** The shortest gap between two answer recovery passes that published states ask for. */
export const REQUEST_DRAFT_PASS_INTERVAL_MS = 500

/** Routing happens in main, before host-local IDs or privileged command schemas are decoded. */
export class DesktopHostRouter {
  /** Saved host identities keep an offline computer visible when it has no live thread connection. */
  private usageSavedHostIds: readonly string[] = []
  private readonly watcherListeners = new Set<(hostId?: string, force?: boolean) => void>()
  /** Watcher, told when the user's answer to a host's card goes from here, so its news says the user answered it. */
  private readonly answerListeners = new Set<(hostId: string, threadId: string, requestId: string) => () => void>()
  watcherHosts(): WatcherRemoteHosts {
    const allowed = () => { if (this.options.watcherEnabled !== true) throw new Error(WATCHER_DISABLED) }
    const connection = (id: string) => {
      allowed()
      const entry = this.hosts.get(id)?.connection
      if (!entry || entry.kind !== 'remote' || this.reconnecting.has(id) || entry.available?.() === false) throw new Error('Watcher host is disconnected.')
      return entry
    }
    const heldProvider = (host: DesktopHostConnection, request: WatcherHostRead | WatcherHostControl) => this.held.size
      ? heldProviderOfWatcherRequest(request, this.held, readView(host.service).host, this.dormantProviderIds.get(host.hostId)) : undefined
    return {
      ...this.options.watcherEnabled === true && this.options.streamingPublishCost === true ? { roomThreads: (id: string, ids: readonly string[]) => {
        const entry = this.hosts.get(id)?.connection
        if (!entry || entry.kind !== 'remote') return undefined
        const connected = !this.reconnecting.has(id) && entry.available?.() !== false
        if (!entry.service.watcherRoomThreads) {
          const snapshot = this.visibleState(readView(entry.service), id).host
          return watcherRoomInputs(snapshot, ids, this.held, this.dormantProviderIds.get(id))
            .map(thread => ({ ...thread, connected: connected && thread.connected }))
        }
        return entry.service.watcherRoomThreads(ids)
          .filter(thread => !this.held.size || !this.dormantProviderIds.get(id)?.has(thread.id))
          .map(thread => ({ ...thread, connected: connected && thread.connected }))
      } } : {},
      hosts: () => this.options.watcherEnabled !== true ? [] : [...this.hosts.values()].filter(item => item.connection.kind === 'remote').map(({ connection: host }) => ({
        hostId: host.hostId, name: host.name, facts: host.service.supportsHostFacts === true && host.service.hostFacts !== undefined, control: host.service.supportsWatcherControl === true, reads: host.service.supportsWatcherReads === true, standingWatch: host.service.supportsWatcherStandingWatch === true,
        workSettled: host.service.supportsWatcherWorkSettled === true, outcomes: host.service.supportsWatcherOutcomes === true,
        muse: host.service.supportsWatcherMuse === true, cursor: host.service.supportsWatcherCursor === true,
        connected: !this.reconnecting.has(host.hostId) && host.available?.() !== false,
        // Read only when asked, and without a copy: Watcher lists hosts on every pass (#1023). The host's own stored default
        // is not the user's: Settings keeps that on this computer (ADR-0074). What the host limits is whether this computer
        // may answer there, and so give a thread a mode that acts without asking.
        get permissionCeiling() { return (readView(host.service) as HostClientShell).clientCapabilities?.mayAnswer === true ? 'full-access' as const : 'approval-required' as const } })),
      snapshot: id => {
        allowed(); const entry = this.hosts.get(id)?.connection
        if (!entry || entry.kind !== 'remote') return undefined
        const snapshot = this.visibleState(readView(entry.service), id).host, connected = !this.reconnecting.has(id) && entry.available?.() !== false
        return { ...snapshot, hostId: id, connected: snapshot.connected && connected,
          threads: snapshot.threads.map(thread => ({ ...thread, hostId: id, ...!connected ? { clientConnected: false } : {} })) }
      },
      projection: (id, master) => connection(id).service.cachedWatcherProjection?.(master),
      read: async (id, request) => {
        const host = connection(id)
        if (!host.service.supportsWatcherReads) throw new Error('Watcher reads are unavailable.')
        const held = heldProvider(host, request)
        if (held) return heldWatcherRefusal(held)
        return host.service.watcherRead!(request, desktopWindowClient())
      },
      control: async (id, request) => {
        const host = connection(id)
        if (!host.service.supportsWatcherControl || !host.service.supportsWatcherReads) throw new Error('Watcher control is unavailable.')
        const held = heldProvider(host, request)
        if (held) return heldWatcherRefusal(held)
        return host.service.watcherControl!(request, desktopWindowClient(), () => {
          const late = heldProvider(connection(id), request)
          if (late) throw new Error(heldWatcherRefusal(late).message)
        })
      },
      subscribe: listener => { this.watcherListeners.add(listener); return () => this.watcherListeners.delete(listener) },
      answering: listener => { this.answerListeners.add(listener); return () => this.answerListeners.delete(listener) },
      settle: async (id, threadId) => {
        const result = await connection(id).service.command({ type: 'settle-thread', threadId }, desktopWindowClient())
        if (result.error) throw new Error('Watcher could not settle this thread.')
      },
      machineFacts: async id => {
        const host = connection(id)
        return host.service.supportsHostFacts === true && host.service.hostFacts ? host.service.hostFacts() : undefined
      },
    }
  }
  private watcherChanged(hostId?: string, force = true): void { for (const listener of this.watcherListeners) listener(hostId, force) }
  /** `run` numbers each connection a host was added with, so a rename, which replaces the connection object, keeps it. */
  private readonly hosts = new Map<string, { connection: DesktopHostConnection; off: (() => void)[]; run: number }>()
  /** Hosts owed a check of their clients that a new version of Sotto asked for, waiting for their update line to empty. */
  private readonly owedClientChecks = new Set<string>()
  private runs = 0
  private readonly listeners = new Set<(state: AgentState) => void>()
  private readonly changeListeners = new Set<() => void>()
  private readonly detailListeners = new Set<(detail: AgentThreadDetailUpdate) => void>()
  /**
   * Each remote thread's revisions as the window is given them. A host counts a thread's revisions in memory, so after
   * it restarts they start again from one, and a window that held the thread at a higher revision threw every newer
   * history away until the count caught up (#1098). A connection's first whole detail of a thread moves that
   * connection's revisions past the last one the window was given; within a connection they all move by that amount.
   * Only numbers are kept, so a host's old connections and their histories are not held here.
   */
  private readonly windowRevisions = new Map<string, { run: number; offset: number; last: number }>()
  private selectedHostId: string | undefined
  /**
   * Whether this computer's window has the focus. Its panes show their threads only while it does (ADR-0046), on a
   * remote host as on this one: each remote host is told with the threads it observes for the window (ADR-0092).
   */
  private windowFocused = true
  /** The threads the window last observed on each host, by the host's own IDs, to send again when the focus moves. */
  private readonly observedOn = new Map<string, string[]>()
  private selectedThreadId: string | null | undefined
  private selectedProjectId: string | null = null
  private notice: RouterNotice | undefined
  /** The visible notice, updated only when a snapshot actually reaches subscribers. */
  private publishedNotice: RouterNotice | undefined
  /** The state last handed to subscribers, for a question asked on every change rather than at a command. */
  private published: AgentState | undefined
  /** What that publication made of each host's state. Nothing in it is written into, so a later build may hand it on. */
  private readonly built = new Map<string, BuiltHost>()
  /** Hosts whose threads read Reconnecting: kept on the page while their host restarts for an update (ADR-0040). */
  private readonly reconnecting = new Set<string>()
  /** Provider identity is immutable for a thread; classify its gated details when its shell arrives. */
  private readonly dormantProviderIds = new Map<string, Map<string, DormantProviderThread>>()
  /** The providers held to Owl on this run, read once at start (ADR-0072). */
  private readonly held: HeldProviders
  /** Counts the window's own selections, so a command that ends after one does not undo it. */
  private selections = 0
  /** Receipt reads share a connection and owner state; no answer is replayed or held draft released. */
  private readonly answerRecovery = new WeakMap<DesktopHostConnection, {
    checks: Map<string, { promise: Promise<void>; pending: boolean }>
    lane: Promise<void>
    window: number
    reads: number
  }>()
  /** The recovery pass published states ask for: whether one is running, the gap after it, and a request waiting on both. */
  private readonly draftPass: { running: boolean; gap: ReturnType<typeof setTimeout> | undefined; wanted: RequestDraftRecovery | undefined; disposed: boolean } =
    { running: false, gap: undefined, wanted: undefined, disposed: false }

  constructor(private readonly empty: () => AgentState, private readonly options: { bindRequestDraftDecision?: BindRequestDraftDecision; watcherEnabled?: boolean;
    /** The providers held to Owl on this run; absent holds every one. `museEnabled` is Muse's answer alone, from before the held set. */
    heldProviders?: HeldProviders; museEnabled?: boolean; streamingPublishCost?: boolean
    /** This desktop's Owl answer for attaching any file (ADR-0131), read once at start: with it off, no host is asked to keep a file. */
    attachAnyFile?: boolean } = {}) {
    this.held = heldProvidersOption(options)
  }

  setUsageSavedHosts(hostIds: readonly string[]): void { this.usageSavedHostIds = [...new Set(hostIds)].slice(0, USAGE_HOSTS_MAX) }
  private usageHostIds(requested?: string[]): string[] {
    return [...new Set(requested ?? [...this.hosts.keys(), ...this.usageSavedHostIds])].slice(0, USAGE_HOSTS_MAX)
  }
  private usageStatus(hostId: string): { connection?: DesktopHostConnection; status?: 'offline' | 'unsupported' } {
    const connection = this.hosts.get(hostId)?.connection
    if (!connection || connection.available?.() === false) return { status: 'offline' }
    if (connection.service.supportsUsage !== true || !connection.service.usageRead || !connection.service.usageRefresh || !connection.service.usageClear) return { status: 'unsupported' }
    return { connection }
  }
  /** Four host reads at a time. One lost or older connection leaves every other host's answer intact. */
  private async usageFanout<T>(hostIds: string[], read: (hostId: string) => Promise<T>): Promise<T[]> {
    const results: T[] = new Array(hostIds.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, hostIds.length) }, async () => {
      while (next < hostIds.length) { const index = next++; results[index] = await read(hostIds[index]!) }
    }))
    return results
  }
  private async usageHostRead(hostId: string, read: (connection: DesktopHostConnection) => Promise<unknown>): Promise<UsageHostRead> {
    const { connection, status } = this.usageStatus(hostId)
    if (!connection) return { hostId, status: status!, quotas: [] }
    try {
      const answer = usageLocalHostReadSchema.parse(await usageDeadline(() => read(connection)))
      // A connection replaced during a read no longer speaks for this host's current session.
      if (this.hosts.get(hostId)?.connection !== connection || connection.available?.() === false) return { hostId, status: 'offline', quotas: [] }
      return { hostId, ...answer }
    } catch { return { hostId, status: connection.available?.() === false ? 'offline' : 'error', quotas: [] } }
  }
  /**
   * The providers a Usage read may name on this run. A provider held to Owl has no usage here (ADR-0072), on this computer
   * or any other, so its rows are not read from a host that counts it.
   */
  private usageProviders(providerIds: readonly UsageProviderId[] | undefined): UsageProviderId[] | undefined {
    if (!usageProviderIdSchema.options.some(id => this.held.has(id))) return providerIds === undefined ? undefined : [...providerIds]
    return (providerIds ?? usageProviderIdSchema.options).filter(id => !this.held.has(id))
  }
  async usageRead(input: UsageQuery): Promise<UsageDashboardRead> {
    const { hostIds, providerIds, ...rest } = usageQuerySchema.parse(input)
    const allowed = this.usageProviders(providerIds)
    const query = { ...rest, ...(allowed ? { providerIds: allowed } : {}) }
    const hosts = await this.usageFanout(this.usageHostIds(hostIds), id => this.usageHostRead(id, connection => connection.service.usageRead!(query)))
    return usageDashboardReadSchema.parse({ hosts })
  }
  async usageRefresh(input: UsageRefreshQuery): Promise<UsageDashboardRead> {
    const { hostIds, providerIds: named, background } = usageRefreshQuerySchema.parse(input)
    const providerIds = this.usageProviders(named)
    const refresh = (service: Pick<HostService, 'usageRefresh'>) => background ? service.usageRefresh!(providerIds, true) : service.usageRefresh!(providerIds)
    const hosts = await this.usageFanout(this.usageHostIds(hostIds), id => this.usageHostRead(id, connection => refresh(connection.service)))
    return usageDashboardReadSchema.parse({ hosts })
  }
  async usageClear(input: UsageClearQuery, client: ClientIdentity = desktopWindowClient()): Promise<UsageClearResult[]> {
    const { hosts } = usageClearQuerySchema.parse(input)
    if (new Set(hosts.map(host => host.hostId)).size !== hosts.length) throw new Error('Choose each computer once before clearing usage.')
    const revisions = new Map(hosts.map(host => [host.hostId, host.expectedRevision]))
    return this.usageFanout<UsageClearResult>(hosts.map(host => host.hostId), async hostId => {
      const { connection, status } = this.usageStatus(hostId)
      if (!connection) return { hostId, status: status! }
      try {
        const answer = usageLocalClearResultSchema.parse(await usageDeadline(() => connection.service.usageClear!({ expectedRevision: revisions.get(hostId)! }, client)))
        return { hostId, ...answer }
      } catch { return { hostId, status: connection.available?.() === false ? 'offline' : 'error' } }
    })
  }

  /** Asks the host for the thread's kind as it is now. Reading its shell for that copied the whole state, and this runs for
   * every detail a streaming thread sends (#917); a host that cannot answer more cheaply is still read that way. */
  private watcherAvailable(connection: DesktopHostConnection, id: string | undefined): boolean {
    if (!id || id === '_') return true
    if (this.held.size && this.dormantProviderIds.get(connection.hostId)?.has(id)) return false
    if (this.options.watcherEnabled === true) return true
    const kind = connection.service.threadKind ? connection.service.threadKind(id) : connection.service.shell().host.threads.find(thread => thread.id === id)?.kind
    return kind !== 'watcher' && kind !== 'watcher-history'
  }
  /**
   * How this computer opens a page of a question the window shows (ADR-0085). The page must be one the host put on that
   * request: a file or loopback page on this computer opens as itself, and a remote host's opens at the address it is
   * served on. Null when the question or page is gone or the host offers no way to reach it. Without a request, the page
   * must be one of the thread's waiting prototype's (ADR-0108).
   */
  questionPageOpening(input: { threadId: string; requestId?: string | undefined; token: string }): QuestionPageOpening | null {
    const key = parseHostEntityKey(input.threadId)
    const connection = this.hosts.get(key?.hostId ?? this.selectedHostId ?? '')?.connection
    if (!connection) return null
    const threadId = key?.id ?? input.threadId
    const thread = connection.service.shell().host.threads.find(item => item.id === threadId)
    const pages = input.requestId === undefined ? thread?.prototypeReady?.pages : thread?.requests.find(request => request.id === input.requestId)?.pages
    const page = pages?.find(item => item.token === input.token)
    if (!page) return null
    if (connection.kind === 'local') {
      const target = connection.questionPage?.(page.token)
      if (!target) return null
      return target.kind === 'file' ? { kind: 'file', file: target.file, token: page.token, start: page.start } : { kind: 'url', url: `${target.origin}/${page.start}` }
    }
    const base = connection.pageAddress?.(page.token)
    return base ? { kind: 'url', url: base + page.start } : null
  }
  /**
   * A page this computer opened (ADR-0108). This computer's host hears it here; a remote host's page opened at the address
   * its own page route serves, which tells that host itself.
   */
  questionPageOpened(input: { threadId: string; token: string }): void {
    const key = parseHostEntityKey(input.threadId)
    const connection = this.hosts.get(key?.hostId ?? this.selectedHostId ?? '')?.connection
    if (connection?.kind === 'local') connection.questionPageOpened?.(input.token)
  }
  /** Saved owner classification stays available even when the public shell omits Watcher. */
  preservesWatcherThread(threadId: string): boolean | undefined {
    if (this.options.watcherEnabled === true) return false
    const key = parseHostEntityKey(threadId)
    if (!key) return false
    const connection = this.hosts.get(key.hostId)?.connection
    const thread = connection?.service.shell().host.threads.find(thread => thread.id === key.id)
    return thread ? thread.kind === 'watcher' || thread.kind === 'watcher-history' : undefined
  }
  preservesDormantThread(threadId: string): boolean | undefined {
    const key = parseHostEntityKey(threadId)
    if (!key) return false
    // Read in place: the answer store asks this for owners it has not classified yet, and a copy of the host's shell
    // for each was a whole-state copy per answered question (#1230).
    const connection = this.hosts.get(key.hostId)?.connection
    const thread = connection ? readView(connection.service).host.threads.find(thread => thread.id === key.id) : undefined
    return thread ? thread.providerId !== undefined && this.held.has(thread.providerId) || this.options.watcherEnabled !== true && (thread.kind === 'watcher' || thread.kind === 'watcher-history') : undefined
  }
  private rememberDormantProviderThreads(state: AgentState, hostId: string): Map<string, DormantProviderThread> {
    const hidden = rememberDormantProviderThreads(this.dormantProviderIds.get(hostId) ?? new Map<string, DormantProviderThread>(), state.host, this.held)
    this.dormantProviderIds.set(hostId, hidden)
    return hidden
  }
  /** A host's default provider as the window is given it: one held to Owl gives way to the first that is not. */
  private visibleProvider(provider: ProviderId): ProviderId {
    return this.held.has(provider) ? providerIdSchema.options.find(item => !this.held.has(item)) ?? 'codex' : provider
  }
  private visibleState(state: AgentState, hostId: string): AgentState {
    const watched = visibleWatcherState(state, this.options.watcherEnabled === true)
    if (!this.held.size) return watched
    const held = this.held
    const hidden = this.rememberDormantProviderThreads(state, hostId)
    const visible = withoutThreads(watched, new Set(hidden.keys()))
    const heldModel = (id: string): boolean => { const provider = parsePublicProviderEntityId(id)?.provider; return provider !== undefined && held.has(provider) }
    return { ...visible, configuration: { ...visible.configuration, provider: this.visibleProvider(visible.configuration.provider),
      ...(visible.configuration.enabledProviders ? { enabledProviders: visible.configuration.enabledProviders.filter(provider => !held.has(provider)) } : {}),
      defaultModelId: heldModel(visible.configuration.defaultModelId) ? '' : visible.configuration.defaultModelId,
      newThreadModelId: heldModel(visible.configuration.newThreadModelId) ? '' : visible.configuration.newThreadModelId },
      host: { ...visible.host, ...catalogWithoutHeld(visible.host, held) },
      ...(visible.installedProviders ? { installedProviders: visible.installedProviders.filter(provider => !held.has(provider)) } : {}),
      ...(visible.clientUpdates ? { clientUpdates: visible.clientUpdates.filter(update => !held.has(update.id)) } : {}),
      ...(visible.clientUpdateRun?.line ? { clientUpdateRun: { ...visible.clientUpdateRun, line: visible.clientUpdateRun.line.filter(provider => !held.has(provider)) } } : {}) }
  }

  requiresManagementUpdate(hostId: string): boolean {
    const connection = this.hosts.get(hostId)?.connection
    if (connection?.kind !== 'remote') return false
    return readView(connection.service).legacyManagement === true
  }

  /**
   * Follows a connection's states and details. A publication this computer's coordinator set off is built from the shell
   * it broadcast rather than from another copy of the same state (#917). A remote host's push carries the histories it
   * has cached, so it is read afresh.
   */
  private watch(connection: DesktopHostConnection): (() => void)[] {
    const signature = (state: AgentState) => {
      if (this.held.size) this.rememberDormantProviderThreads(state, connection.hostId)
      return JSON.stringify([state.stale === true, state.host.connected, connection.service.supportsWatcherControl, connection.service.supportsWatcherReads, connection.service.supportsWatcherStandingWatch])
    }
    let last = signature(connection.service.shell())
    const off = [connection.service.subscribe(state => {
      this.emit(connection.kind === 'local' ? { hostId: connection.hostId, state } : undefined)
      const next = signature(state)
      if (connection.kind === 'remote' && next !== last) { last = next; this.watcherChanged(connection.hostId) }
      // Decided from the state the host just pushed, never a read of its own: this runs on every push while a check is owed.
      if (this.owedClientChecks.size && this.owedClientChecks.has(connection.hostId)) void this.checkHostClients(connection, state)
    })]
    if (connection.kind === 'remote' && connection.service.subscribeWatcher) off.push(connection.service.subscribeWatcher(() => this.watcherChanged(connection.hostId, false)))
    if (connection.subscribeDetail) off.push(connection.subscribeDetail(detail => {
      if (!this.watcherAvailable(connection, detail.threadId)) return
      const scoped = this.toWindowRevisions(connection, this.hosts.get(connection.hostId)?.run, mapHostReferences(detail, id => hostEntityKey(connection.hostId, id)))
      if (scoped) for (const listener of this.detailListeners) listener(scoped)
    }))
    return off
  }
  add(connection: DesktopHostConnection): void {
    if (this.hosts.has(connection.hostId)) throw new Error('This host is already connected.')
    const off = this.watch(connection)
    this.hosts.set(connection.hostId, { connection, off, run: ++this.runs })
    this.watcherChanged(connection.hostId)
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
    const off = this.watch(connection)
    this.hosts.set(connection.hostId, { connection, off, run: ++this.runs })
    this.reconnecting.delete(connection.hostId)
    this.watcherChanged(connection.hostId)
    this.emit()
  }
  /** Marks a connected host's threads as reconnecting, or no longer: while it is set they read Reconnecting, not Disconnected. */
  setReconnecting(hostId: string, value: boolean): void {
    if (value === this.reconnecting.has(hostId) || !this.hosts.has(hostId)) return
    if (value) this.reconnecting.add(hostId); else this.reconnecting.delete(hostId)
    this.watcherChanged(hostId)
    this.emit()
  }
  remove(hostId: string): void {
    this.hosts.get(hostId)?.off.forEach(off => off())
    this.hosts.delete(hostId)
    this.built.delete(hostId)
    this.dormantProviderIds.delete(hostId)
    this.observedOn.delete(hostId)
    this.owedClientChecks.delete(hostId)
    this.watcherChanged(hostId)
    this.reconnecting.delete(hostId)
    if (this.selectedHostId === hostId) this.selectedHostId = this.hosts.keys().next().value
    if (this.selectedThreadId && parseHostEntityKey(this.selectedThreadId)?.hostId === hostId) this.selectedThreadId = null
    this.emit()
  }
  /**
   * Main reports the window's focus as it moves. Each remote host that keeps what is shown hears it with the threads the
   * window observes there, so a thread in a pane behind another app neither reads its finish nor sees its failure; this
   * computer's own host hears it from main directly.
   */
  setWindowFocused(focused: boolean): void {
    if (focused === this.windowFocused) return
    this.windowFocused = focused
    for (const { connection } of this.hosts.values()) {
      if (connection.kind !== 'remote' || connection.available?.() === false || connection.service.supportsFailureSeen !== true || !connection.observe) continue
      const ids = this.observedOn.get(connection.hostId) ?? []
      void (focused ? connection.observe(ids) : connection.observe(ids, false)).catch(() => undefined)
    }
  }
  /**
   * Whether the window shows a thread now (ADR-0046): it has the focus and one of its panes, or the Tools panel's pinned
   * thread, is that thread. `threadId` is the window's ID for it, as published. Desktop notifications ask this so a
   * thread the user is looking at never notifies (ADR-0117).
   */
  windowShows(threadId: string): boolean {
    if (!this.windowFocused) return false
    const key = parseHostEntityKey(threadId)
    const hostId = key?.hostId ?? this.selectedHostId
    return hostId !== undefined && (this.observedOn.get(hostId)?.includes(key?.id ?? threadId) ?? false)
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
  /** Told of every change without a state built for it, for a listener that reads what it needs when it needs it (#917). */
  subscribeChanges(listener: () => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener) }
  subscribeThreadDetail(listener: (detail: AgentThreadDetailUpdate) => void): () => void { this.detailListeners.add(listener); return () => this.detailListeners.delete(listener) }
  get(): AgentState { return this.shell() }
  /** An answer's delivery notice goes once the host has the exact acceptance it was waiting for. */
  private settleAnswerNotice(): void {
    const answer = this.notice?.answer
    if (!answer) return
    const proof = this.hosts.get(answer.hostId)?.connection.service.requestAnswerRecovery?.(answer.target.threadId, answer.target.providerId)
    if (proof?.completed.some(item => item.decisionId === answer.decisionId && item.requestId === answer.target.requestId
      && item.questionsDigest === answer.target.questionsDigest)) this.notice = undefined
  }
  /** Every host's shell read afresh, for a command's reply and any caller that must see the state as it is now. */
  shell(): AgentState { return this.build(connection => connection.service.shell()) }
  /**
   * One host's threads as the router last published them. The host-update and start-at-boot questions ask this on every
   * change; reading every host's shell afresh for it copied the whole state twice per waiting host per update. Before
   * anything is published it reads afresh.
   */
  publishedThreads(hostId: string): readonly AgentThread[] {
    return this.lastPublished().host.threads.filter(thread => thread.hostId === hostId)
  }
  /**
   * Whether a host's client update line is running, as the router last published it: a client waits in it or is
   * updating. A host update asks this on every change, and holds its restart until the line is empty (ADR-0077 decision 2).
   * A host that is not connected has no line running: what it last said is stale, and the window reads it so too.
   */
  clientLineRunning(hostId: string): boolean {
    const entry = this.lastPublished().host.clientHosts?.find(item => item.hostId === hostId)
    if (!entry?.connected) return false
    return entry?.clientUpdateRun !== undefined || entry?.clientUpdates?.some(update => update.state === 'queued' || update.state === 'updating') === true
  }
  /**
   * Asks each connected host that offers client updates to check its clients afresh, when Sotto finds a new version of
   * itself, so Update all lists their updates beside it rather than after the restart (ADR-0077). This computer's own
   * check is the coordinator's, not this. Nothing waits for the answers: what each host finds arrives with its next
   * shell, and a client found behind then joins a press already under way.
   */
  async checkHostClientsAfresh(): Promise<void> {
    await Promise.all([...this.hosts.values()].map(({ connection }) => {
      if (connection.kind !== 'remote') return undefined
      this.owedClientChecks.add(connection.hostId)
      // A host that has yet to send a shell has nothing to read; it is not asked.
      let view: AgentState | undefined
      try { view = connection.available?.() === false ? undefined : readView(connection.service) } catch { view = undefined }
      return this.checkHostClients(connection, view)
    }))
  }
  /**
   * Sends one host the check it is owed, or keeps owing it. A host whose update line is running is asked once the line
   * is empty, when its shell says so. A host that keeps what an update already run said is asked whatever its readings
   * hold; an older one, whose check would set those aside while a press may still be reading them, is left to its own
   * checks while it holds any. A host that is out of reach, cannot update its clients, would check a provider this build
   * holds, refuses, or does not answer is not asked again.
   */
  private async checkHostClients(connection: DesktopHostConnection, view?: AgentState): Promise<void> {
    const command = { type: 'check-client-updates' } as const
    const hostId = connection.hostId
    if (!view || connection.available?.() === false || connection.offersClientUpdates?.() !== true || view.legacyManagement === true) { this.owedClientChecks.delete(hostId); return }
    if (view.clientUpdateRun !== undefined || view.clientUpdates?.some(update => update.state === 'queued' || update.state === 'updating')) return
    this.owedClientChecks.delete(hostId)
    if (connection.keepsClientOutcomes?.() !== true && view.clientUpdates?.some(update => update.state !== 'idle')) return
    if (this.held.size && heldProviderRefusedBy(command, this.held, view.host)) return
    await connection.service.command(command, desktopWindowClient()).catch(() => undefined)
  }
  /** What the router last published, read in place; afresh before anything is published. */
  private lastPublished(): AgentState { return this.published ?? this.shell() }
  /**
   * Builds the window's state from each host's, reusing what the last publication made for a host wherever that host's
   * state holds the same values (#1335). Only a publication is kept for the next build to reuse: `shell()` reads copies,
   * which no later read shares objects with, so it reuses what the last publication made and keeps nothing of its own.
   */
  private build(read: (connection: DesktopHostConnection) => AgentState, publish = false): AgentState {
    this.settleAnswerNotice()
    const multiple = this.hosts.size > 1
    const entries = [...this.hosts.values()].map(({ connection }) => {
      const original = this.visibleState(read(connection), connection.hostId)
      const last = this.built.get(connection.hostId)
      const projection = projectClientAgentState(original, last?.projection)
      const threads = this.windowThreads(connection, original, projection.output, multiple, last)
      if (publish) this.built.set(connection.hostId, { projection, threads })
      return { connection, original, state: projection.output, threads: threads.made }
    })
    const selected = entries.find(item => item.connection.hostId === this.selectedHostId)
    const local = entries.find(item => item.connection.kind === 'local')
    const named = selected ? this.withNewThreadDefaults(this.named(selected.connection, selected.state), selected === local ? undefined : local?.state) : this.empty()
    // The corner card and Settings > Providers are this computer's own clients. A remote host's client updates reach the
    // window only through its `clientHosts` entry, for its tiles in Settings > Hosts & phones (#480). This computer's are on its own
    // entry too, so Update all lists them whichever host is selected (ADR-0077).
    const base = selected?.connection.kind === 'remote' ? withoutClientUpdates(named) : named
    const threads = entries.flatMap(entry => entry.threads)
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
          ...(original.host.providers ? { providers: this.namedProviders(connection, original.host.providers) } : {}),
          ...((connection.kind === 'local' || connection.offersClientUpdates?.()) && original.clientUpdates ? { clientUpdates: original.clientUpdates } : {}),
          ...((connection.kind === 'local' || connection.offersClientUpdates?.()) && original.clientUpdateRun ? { clientUpdateRun: original.clientUpdateRun } : {}),
          ...(connection.offersBabysitting?.() ? { pullRequestBabysit: true as const } : {}),
          projectsDirectory: original.configuration.projectsDirectory,
          // This computer may always answer its own host; a remote one says so in the shell it sends this client.
          mayAnswer: connection.kind === 'local' || (original as HostClientShell).clientCapabilities?.mayAnswer === true,
          // Settings > Providers is this computer's own page, whichever host is selected for new work.
          ...(connection.kind === 'local' ? { enabledProviders: enabledThreadProviders(original.configuration), checkClientUpdates: original.configuration.checkClientUpdates,
            museDisableSandbox: original.configuration.museDisableSandbox,
            agentModelId: defaultThreadModelId(original.configuration, original.host.models, original.reasoningAccounts) } : {}),
        })),
      },
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
  /**
   * One host's threads as the window is given them: each with its host's ID, name and kind, and whether the window shows
   * it connected. A thread whose projected record and every one of those is as the last publication had them is that
   * publication's record; any other is made afresh.
   */
  private windowThreads(connection: DesktopHostConnection, original: AgentState, state: AgentState, multiple: boolean, last: BuiltHost | undefined): BuiltThreads {
    const hostLabel = multiple ? connection.name : undefined, remoteHost = connection.kind === 'remote'
    const reconnecting = connection.available?.() === false && this.reconnecting.has(connection.hostId)
    const before = last?.threads
    const reusable = before !== undefined && before.hostLabel === hostLabel && before.remoteHost === remoteHost && before.reconnecting === reconnecting
    // Where each projected record was in that publication, asked only once a thread has moved.
    let positions: Map<AgentThread, number> | undefined
    const made = state.host.threads.map((thread, index): AgentThread => {
      const clientConnected = windowConnected(connection, original.host, original.host.threads[index]!)
      const at = !reusable ? -1 : before.from[index] === thread ? index : (positions ??= new Map(before.from.map((item, position) => [item, position]))).get(thread) ?? -1
      const prior = reusable && at >= 0 ? before.made[at] : undefined
      if (prior && prior.clientConnected === clientConnected) return prior
      return { ...thread, hostId: connection.hostId, hostLabel, remoteHost, clientConnected, ...(reconnecting ? { clientReconnecting: true } : {}) }
    })
    return { from: state.host.threads, made, hostLabel, remoteHost, reconnecting }
  }
  private target(id?: string): { connection: DesktopHostConnection; id: string | undefined } {
    const key = id ? parseHostEntityKey(id) : null
    const hostId = key?.hostId ?? this.selectedHostId
    const entry = hostId ? this.hosts.get(hostId) : undefined
    if (!entry) throw new Error('Connect a host in Settings > Hosts & phones to continue.')
    const localId = key?.id ?? id
    if (!this.watcherAvailable(entry.connection, localId)) throw new Error(WATCHER_DISABLED)
    return { connection: entry.connection, id: localId }
  }
  async threadDetail(threadId: string): Promise<AgentThreadDetail | null> {
    const { connection, id } = this.target(threadId)
    const run = this.hosts.get(connection.hostId)?.run
    const detail = await connection.detail(id!)
    // An answer from a connection a reconnect has since replaced is that connection's history, not the new one's.
    if (run !== this.hosts.get(connection.hostId)?.run) return null
    return detail ? this.toWindowRevisions(connection, run, mapHostReferences(detail, value => hostEntityKey(connection.hostId, value))) : null
  }
  /**
   * A remote thread's detail or delta from connection `run` with its revisions as the window is given them, or null for a
   * delta no whole detail from that connection came before; this computer's go as they are.
   */
  private toWindowRevisions<T extends AgentThreadDetailUpdate>(connection: DesktopHostConnection, run: number | undefined, update: T): T | null {
    if (connection.kind !== 'remote' || run === undefined) return update
    let line = this.windowRevisions.get(update.threadId)
    if (isAgentThreadDetailDelta(update)) {
      // A delta follows a whole detail on its own connection. One that arrives first is measured from a revision the
      // window cannot tell from the old connection's, so it goes no further; the whole detail that follows carries it.
      if (!line || line.run !== run) return null
      line.last = Math.max(line.last, update.revision + line.offset)
      return line.offset === 0 ? update : { ...update, baseRevision: update.baseRevision + line.offset, revision: update.revision + line.offset }
    }
    if (!line) this.windowRevisions.set(update.threadId, line = { run, offset: 0, last: update.revision })
    else if (line.run !== run) {
      line.run = run
      if (update.revision + line.offset <= line.last) line.offset = line.last + 1 - update.revision
    }
    line.last = Math.max(line.last, update.revision + line.offset)
    return line.offset === 0 ? update : { ...update, revision: update.revision + line.offset }
  }
  requestAnswerRecovery(threadId: string, providerId: ProviderId): RequestAnswerRecovery {
    const { connection, id } = this.target(threadId)
    return connection.service.requestAnswerRecovery?.(id!, providerId) ?? { uncertainRequestIds: [], completed: [] }
  }
  /**
   * One thread the window is given, found on its own host's view in place: the thread as that host sent it, whether the
   * window shows it connected and whether the host counts it busy, each as `shell()` would give them. The answer store
   * looked up its threads in every host's state built afresh, once for every answered question on every save, and that
   * was half of main's time with a few hundred answered (#1230).
   */
  private windowThread(connection: DesktopHostConnection, ownerId: string): { thread: AgentThread | undefined; clientConnected: boolean | undefined; busy: boolean } {
    const state = readView(connection.service)
    const own = state.hostId ?? state.host.hostId
    const busy = state.busyThreadIds?.some(id => clientThreadId(own, id) === ownerId) === true
    const thread = state.host.threads.find(item => clientThreadId(own, item.id, item.hostId) === ownerId)
    // What `visibleState` leaves out of the window: Watcher while it is off, and a provider held to Owl.
    if (!thread || !watcherThreadVisible(thread, this.options.watcherEnabled === true)
      || this.held.size && this.rememberDormantProviderThreads(state, connection.hostId).has(thread.id)) return { thread: undefined, clientConnected: undefined, busy }
    return { thread, clientConnected: windowConnected(connection, state.host, thread), busy }
  }
  /**
   * The provider the window gives a thread that names none: from the selected host's catalog and default, as `shell()`
   * has them, read on that one host in place. A recovery pass asks this for every held answer of such a thread.
   */
  private windowProvider(thread: AgentThread): ProviderId {
    const connection = this.selectedHostId === undefined ? undefined : this.hosts.get(this.selectedHostId)?.connection
    if (!connection) { const empty = this.empty(); return requestDraftProvider(empty.host, thread, empty.configuration.provider) }
    const state = readView(connection.service)
    return requestDraftProvider({ models: modelsWithoutHeld(state.host.models, this.held) }, thread, this.visibleProvider(state.configuration.provider))
  }
  /**
   * Every remote thread the answer store could keep as Watcher or dormant, under each ID a saved owner of it may carry:
   * a Watcher thread, or one of a provider held to Owl. Read in place on each host.
   */
  requestDraftWatcherOwnerIds(): string[] {
    const ids: string[] = []
    for (const { connection } of this.hosts.values()) {
      if (connection.kind === 'local') continue
      const state = readView(connection.service), own = state.hostId ?? state.host.hostId
      for (const thread of state.host.threads) {
        if (thread.kind !== 'watcher' && thread.kind !== 'watcher-history' && !(thread.providerId !== undefined && this.held.has(thread.providerId))) continue
        const stored = hostEntityKey(connection.hostId, thread.id), shown = clientThreadId(own, thread.id, thread.hostId)
        ids.push(stored)
        if (shown !== stored) ids.push(shown)
      }
    }
    return ids
  }
  /** The same owning-host projection is used for remote draft saves and recovery. */
  requestDraftState(owner: RequestDraftOwner): RequestDraftOwnerState | undefined {
    const key = parseHostEntityKey(owner.ownerId)
    const connection = key ? this.hosts.get(key.hostId)?.connection : undefined
    if (!key || !connection || !this.watcherAvailable(connection, key.id)) return undefined
    const recovery = this.requestAnswerRecovery(owner.ownerId, owner.providerId)
    const found = this.windowThread(connection, owner.ownerId)
    const thread = found.thread && (found.thread.providerId ?? this.windowProvider(found.thread)) === owner.providerId ? found.thread : undefined
    // Only the requests handed back are copied, as they are for this computer's own threads.
    return thread ? { connected: found.clientConnected === true,
      ready: thread.historyStatus !== 'loading' && thread.historyStatus !== 'error', requests: structuredClone(thread.requests),
      ...(thread.kind === 'watcher' || thread.kind === 'watcher-history' ? { watcher: true } : {}), ...recovery }
      : recovery.completed.length ? { connected: false, ready: false, requests: [], ...recovery } : undefined
  }
  /**
   * The recovery pass a published state asks for. A provider publishes dozens of times a second while it streams, and a pass
   * looks up every held answer's thread, so passes run one at a time and start at least REQUEST_DRAFT_PASS_INTERVAL_MS apart.
   * Asking while one runs, or before that interval since its start is up, gets one pass when both are over: a slow pass is
   * followed at once. A pass is over once its receipt reads are issued; each read retires its own acceptance when it
   * finishes, so a known acceptance never waits behind another pass's socket read.
   */
  scheduleRequestDraftReconcile(drafts: RequestDraftRecovery): void {
    const pass = this.draftPass
    if (pass.disposed) return
    if (pass.running || pass.gap) { pass.wanted = drafts; return }
    pass.running = true
    const started = Date.now()
    void this.issueRequestDraftChecks(drafts).catch(() => undefined).finally(() => {
      pass.running = false
      if (pass.disposed) return
      pass.gap = setTimeout(() => {
        pass.gap = undefined
        const wanted = pass.wanted
        pass.wanted = undefined
        if (wanted) this.scheduleRequestDraftReconcile(wanted)
      }, Math.max(0, REQUEST_DRAFT_PASS_INTERVAL_MS - (Date.now() - started)))
    })
  }
  async reconcileRequestDrafts(drafts: RequestDraftRecovery): Promise<void> {
    await Promise.all(await this.issueRequestDraftChecks(drafts))
    await drafts.reconcile()
  }
  /** Retires what is already known, then starts or joins a receipt read for each held remote answer, returned unawaited. */
  private async issueRequestDraftChecks(drafts: RequestDraftRecovery): Promise<Promise<void>[]> {
    // Already-known local, personal and remote acceptance must not wait for a socket read.
    await drafts.reconcile()
    const pending: Promise<void>[] = []
    for (const draft of await drafts.heldThreadAnswers()) {
      const owner = draft.target
      const identity = parseHostEntityKey(owner.ownerId)
      const connection = identity ? this.hosts.get(identity.hostId)?.connection : undefined
      if (!identity || !connection || connection.kind !== 'remote' || connection.available?.() === false
        || !connection.refreshRequestAnswer || !draft.decisionId || !this.watcherAvailable(connection, identity.id)) continue
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
      // The held answer's own thread, read on its host in place, once it still needs its receipt and not before.
      const found = this.windowThread(connection, owner.ownerId)
      const request = found.thread?.requests.find(item => item.id === owner.requestId)
      // A negative receipt is checked again when its provider reconnects or the original request
      // changes delivery/liveness or its answer lane finishes. Unrelated streaming updates keep the same read.
      const key = JSON.stringify([owner.ownerId, owner.providerId, owner.requestId, questionsDigest, decisionId,
        found.clientConnected, found.thread?.historyStatus, request?.id ?? null, request?.delivery ?? null, found.busy])
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
          if (this.hosts.get(connection.hostId)?.connection !== connection || connection.available?.() === false || !this.watcherAvailable(connection, identity.id)) {
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
          if (this.hosts.get(connection.hostId)?.connection !== connection || connection.available?.() === false || !this.watcherAvailable(connection, identity.id)) { checks.delete(key); return }
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
    return pending
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
    // Refused here as this computer's own store refuses it, before any host hears of it, whatever that host's own answer.
    if (!isImageAttachment(request.mimeType) && this.options.attachAnyFile !== true) throw new Error(SCREENSHOT_WRONG_TYPE)
    const { connection } = this.target(request.threadId ?? undefined)
    if (!connection.stage) throw new Error(HOST_CANNOT_STAGE_SCREENSHOTS)
    if (connection.available?.() === false) {
      throw new Error(isImageAttachment(request.mimeType) ? 'This host is disconnected. Connect again before attaching images. Nothing was attached.' : HOST_DISCONNECTED_BEFORE_FILES)
    }
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
  async gitPullRequest(request: GitPullRequestRequest): Promise<GitPullRequestRead> {
    const { connection, id } = this.target(request.threadId)
    if (!connection.gitPullRequest) throw new Error('Pull requests are unavailable on this host.')
    if (connection.available?.() === false) throw new Error('This host is disconnected. Connect again to read its pull requests.')
    return connection.gitPullRequest({ ...request, threadId: id! })
  }
  /** The words of a started thread's handover, read on the thread's own host when the user asks to read them (#1028). */
  async startHandover(threadId: string): Promise<{ readonly text: string } | null> {
    const { connection, id } = this.target(threadId)
    if (connection.service.supportsThreadStarts !== true || !connection.service.startHandover) throw new Error(THREAD_STARTS_UNSUPPORTED)
    if (connection.available?.() === false) throw new Error('This host is disconnected. Connect again to read the handover. Nothing was sent.')
    return connection.service.startHandover(id!)
  }
  /**
   * One record of a remote thread whole, read on its host when its row opens (ADR-0025, October 18 amendment). This
   * computer's own threads never carry a cut body, so a thread here answers null.
   */
  async activityBody(request: { readonly threadId: string; readonly activityId: string }): Promise<AgentActivity | null> {
    const { connection, id } = this.target(request.threadId)
    if (!connection.activityBody) return null
    if (connection.available?.() === false) throw new Error('This host is disconnected. Nothing is lost. The rest shows when it reconnects.')
    return connection.activityBody(id!, request.activityId)
  }
  /**
   * Every message the user sent above the window a pane holds, read on the thread's own host for the message scrubber
   * (ADR-0109). Null from a host that cannot say, and while it is disconnected: the scrubber then marks what the window holds.
   */
  async threadPrompts(request: AgentThreadPromptsRequest): Promise<AgentThreadPrompts | null> {
    const { connection, id } = this.target(request.threadId)
    if (!connection.service.threadPrompts || connection.available?.() === false) return null
    return connection.service.threadPrompts(id!, request.beforeMessageId)
  }
  /** The folder browser names its host directly: it has no thread yet to carry a client-scoped key. */
  async hostFolders(request: HostFoldersClientRequest): Promise<HostFoldersResult> {
    const entry = this.hosts.get(request.hostId)
    if (!entry) throw new Error('That computer is not connected. Nothing was changed. Connect it in Settings > Hosts & phones, then try again.')
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
    if (!method) throw new Error(`${surface} is unavailable on this host. Nothing was changed. Check the host in Settings > Hosts & phones.`)
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
    if (input && typeof input === 'object' && 'type' in input && input.type === 'start-thread-session') return this.startThreadSession(input, client)
    const priorNotice = this.notice
    this.notice = undefined
    const type = input && typeof input === 'object' && 'type' in input ? input.type : undefined
    // Showing threads and Dismiss all both name threads on every host: each host hears only its own (ADR-0046, ADR-0092).
    if (type === 'observe-threads' || type === 'dismiss-failures') {
      const parsed = agentCommandSchema.parse(mapHostReferences(input, id => parseHostEntityKey(id)?.id ?? id))
      if (parsed.type !== type) throw new Error(type === 'observe-threads' ? 'The viewed threads could not be read.' : 'The threads to dismiss could not be read.')
      // Dismiss all names each thread with the failure its row showed; showing names threads alone.
      const raw = type === 'observe-threads' ? (input as { threadIds: string[] }).threadIds.map(threadId => ({ threadId, failure: '' }))
        : (input as { failures: { threadId: string; failure: string }[] }).failures
      const left: { name: string; older: boolean }[] = []
      await Promise.all([...this.hosts.values()].map(async ({ connection }) => {
        const mine = raw.filter(item => (parseHostEntityKey(item.threadId)?.hostId ?? this.selectedHostId) === connection.hostId)
          .map(item => ({ ...item, threadId: parseHostEntityKey(item.threadId)?.id ?? item.threadId }))
          .filter(item => this.watcherAvailable(connection, item.threadId))
        const visibleIds = mine.map(item => item.threadId)
        if (type === 'dismiss-failures') {
          if (!mine.length) return
          if (connection.available?.() === false || connection.kind === 'remote' && connection.service.supportsFailureSeen !== true) {
            left.push({ name: connection.name, older: connection.available?.() !== false }); return
          }
          const answer = await connection.service.command({ type: 'dismiss-failures', failures: mine }, client).catch(() => null)
          if (answer === null || answer.error) left.push({ name: connection.name, older: false })
          return
        }
        if (connection.available?.() === false) return
        this.observedOn.set(connection.hostId, visibleIds)
        try {
          if (connection.observe) await (connection.kind === 'remote' && !this.windowFocused ? connection.observe(visibleIds, false) : connection.observe(visibleIds))
          else await connection.service.command({ type: 'observe-threads', threadIds: visibleIds }, client)
        } catch (error) {
          // A connection that drops while the open panes are read is no one's action to report: the host reads the
          // same panes again when it reconnects, and its threads read Reconnecting until then.
          if (!droppedConnection(error)) throw error
        }
      }))
      if (left.length) this.notice = { message: dismissLeft(left) }
      return this.shell()
    }
    const { connection, command, hostNamed } = this.route(input)
    if (this.requiresManagementUpdate(connection.hostId) && !LEGACY_MANAGEMENT_ALLOWED_COMMANDS.has(command.type)) {
      return { ...this.shell(), error: LEGACY_MANAGEMENT_UPDATE }
    }
    // Retained local edits publish before the refusal reply. Keep its visible banner stable while typing.
    if (command.type === 'compose' && command.threadId !== undefined && (connection.service.supportsAtomicSend === false || connection.service.supportsDraftRevisions === false)
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
    if (connection.kind === 'remote' && command.type === 'set-aside-send') return { ...this.shell(), error: 'Continue with a new message on the desktop that owns this thread. Nothing was changed.' }
    if (connection.available?.() === false) {
      if (windowRead(command)) return this.shell()
      throw new Error(`${connection.name} is disconnected. Nothing was sent. Try again once it reconnects.`)
    }
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
    // Continuing an agent or forking at a reply answers where it was asked (#1028): its refusal is this command's alone.
    let inPlace: string | undefined
    // Watcher hears that the user answered a host's card, never what they answered; an answer that did not go is undone.
    const unmark = connection.kind === 'remote' && command.type === 'answer' ? [...this.answerListeners].map(listener => listener(connection.hostId, command.threadId, command.requestId)) : []
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
      // A host from before continuing agents (#1028) would refuse the command as unknown; it is told why here instead.
      const result = startsThread(command) && connection.kind === 'remote' && connection.service.supportsThreadStarts !== true ? { error: THREAD_STARTS_UNSUPPORTED }
        : await (decisionId ? connection.service.command(command as AgentCommand, client, decisionId)
          : connection.service.command(command as AgentCommand, client))
      if (result.error && startsThread(command)) { refused = true; inPlace = this.refusal(connection, result.error) }
      else if (result.error) {
        refused = true
        const unsupportedCompose = command.type === 'compose' && command.threadId !== undefined
          && connection.kind === 'remote' && (connection.service.supportsAtomicSend === false || connection.service.supportsDraftRevisions === false) && result.error === REMOTE_COMPOSE_UNSAVED
        const message = this.refusal(connection, result.error)
        // Compare what is visible now, after the reply. An intervening error or connection change wins.
        repeatedUnsupportedCompose = unsupportedCompose && this.publishedNotice?.unsupportedCompose === connection
          && this.hosts.get(connection.hostId)?.connection === connection && this.publishedNotice.message === message
        this.notice = repeatedUnsupportedCompose ? this.publishedNotice : { message, ...(unsupportedCompose ? { unsupportedCompose: connection } : {}), ...(decisionId && answerTarget
          ? { answer: { hostId: connection.hostId, decisionId, target: answerTarget } } : {}) }
      }
    } catch (error) {
      for (const undo of unmark) undo()
      if (windowRead(command) && droppedConnection(error)) return this.shell()
      // The host refused this action before dispatch. Return its account through the same state error
      // as a coordinator refusal, so a permission chip does not mistake it for a lost provider answer.
      // A dropped connection is still uncertain and must keep the renderer's recovery path.
      if (connection.kind !== 'remote' || !(error instanceof HostConnectionError) || error.code !== 'forbidden') throw error
      refused = true
      if (startsThread(command)) inPlace = this.refusal(connection, error.message)
      else this.notice = { message: this.refusal(connection, error.message) }
    } finally {
      if (SELECTING_COMMANDS.has(command.type) && selections === this.selections) this.follow(connection, { activeThreadId, activeProjectId })
    }
    if (refused) for (const undo of unmark) undo()
    // Only while the window still shows what it did when the creation began: any other move meanwhile wins.
    const unmoved = selections === this.selections && this.selectedHostId === windowShowed.hostId && this.selectedThreadId === windowShowed.threadId
    if (command.type === 'create-thread' && command.threadId !== undefined && connection.kind === 'remote' && !refused && unmoved) {
      await this.openCreated(connection, command.threadId, client)
    }
    if (startsThread(command) && connection.kind === 'remote' && !refused && unmoved) await this.openCreated(connection, command.newThreadId, client)
    if (!repeatedUnsupportedCompose) this.emit()
    const shell = agentShell(this.shell())
    // A settings save, or a command that named its host, may go to a host other than the selected one, so it answers with
    // its own outcome, never with the selected host's last error, which belongs to some other command (ADR-0074). Continue
    // as a thread answers in the agent's row with its own refusal alone (#1028).
    return command.type === 'configure' || hostNamed ? { ...shell, error: refused ? this.notice?.message ?? null : null }
      : startsThread(command) ? { ...shell, error: inPlace ?? null } : shell
  }
  /** Refuses, before it is sent, a command that chooses, owns or would enumerate a held provider on that host. */
  private refuseHeld(command: AgentCommand, connection: DesktopHostConnection): void {
    if (!this.held.size) return
    const held = heldProviderRefusedBy(command, this.held, connection.service.shell().host)
    if (held) throw new Error(heldProviderRefusal(held))
  }
  /** The host a command's references name, or the selected host, and the command in that host's own IDs. */
  private route(input: unknown): { connection: DesktopHostConnection; command: AgentCommand; hostNamed?: true } {
    const references = new Set<string>()
    mapHostReferences(input, value => { const key = parseHostEntityKey(value); if (key) references.add(key.hostId); return value })
    if (references.size > 1) throw new Error('This action includes items from different hosts. Select items from one host.')
    const command = agentCommandSchema.parse(mapHostReferences(input, id => parseHostEntityKey(id)?.id ?? id))
    const named = heldProviderOfCommand(command, this.held)
    if (named) throw new Error(heldProviderRefusal(named))
    if (command.type === 'configure') {
      const routed = this.configurationRoute(command)
      this.refuseHeld(routed.command, routed.connection)
      return routed
    }
    // Update all names the machine whose clients it updates, which need not be the selected one (ADR-0077), and
    // Settings > Providers names this computer for its own clients.
    if (HOST_NAMED_COMMANDS.has(command.type) && 'hostId' in command && command.hostId !== undefined) {
      const { hostId, ...forwarded } = command
      const named = this.hosts.get(hostId)?.connection
      if (!named) throw new Error('This host is not connected. Connect it in Settings > Hosts & phones, then try again. Nothing was changed.')
      this.refuseHeld(forwarded, named)
      return { connection: named, command: forwarded, hostNamed: true }
    }
    const hostId = [...references][0] ?? this.selectedHostId
    const { connection } = this.target(hostId ? hostEntityKey(hostId, '_') : undefined)
    this.refuseHeld(command, connection)
    const threadId = 'threadId' in command ? command.threadId ?? undefined : command.type === 'send' ? command.draft?.threadId : undefined
    const defaultThread = command.type === 'send' || command.type === 'compose' ? connection.service.shell().draftThreadId ?? connection.service.shell().activeThreadId ?? undefined : undefined
    if (!this.watcherAvailable(connection, threadId ?? defaultThread)) throw new Error(WATCHER_DISABLED)
    return { connection, command }
  }
  /**
   * Where a settings patch goes (ADR-0074). New-thread defaults alone go to this computer's own host, since they are
   * this computer's and apply on every host; anything else goes to the host the patch names, or the selected one.
   * The host's ID is read here and never sent on.
   */
  private configurationRoute(command: Extract<AgentCommand, { type: 'configure' }>): { connection: DesktopHostConnection; command: AgentCommand } {
    const { hostId, ...forwarded } = command
    const keys = Object.keys(command.patch)
    const local = [...this.hosts.values()].find(entry => entry.connection.kind === 'local')?.connection
    if (local && keys.length > 0 && keys.every(key => (NEW_THREAD_DEFAULT_FIELDS as readonly string[]).includes(key))) return { connection: local, command: forwarded }
    if (hostId === undefined) return { connection: this.target().connection, command: forwarded }
    const named = this.hosts.get(hostId)?.connection
    if (!named) throw new Error('This host is not connected. Connect it in Settings > Hosts & phones, then try again. Nothing was changed.')
    return { connection: named, command: forwarded }
  }
  /**
   * This computer's own new-thread defaults over another selected host's, so Settings shows and New thread uses the
   * same ones on every host. The model is resolved here from this computer's own settings and accounts, chosen or
   * inherited, and the window takes it as it is: empty means this computer has no model to offer, never a cue to infer
   * one from the selected host's reasoning provider. With this computer selected its settings are already the
   * window's, as saved. With no local host running, the selected host's own apply.
   */
  private withNewThreadDefaults(state: AgentState, local: AgentState | undefined): AgentState {
    if (!local) return state
    const { newThreadRuntimeMode: _mode, ...configuration } = state.configuration
    void _mode
    const own = local.configuration
    return { ...state, configuration: { ...configuration, newThreadModelId: defaultNewThreadModelId(own, local.host.models, local.reasoningAccounts),
      newThreadReasoningEffort: own.newThreadReasoningEffort, ...(own.newThreadRuntimeMode !== undefined ? { newThreadRuntimeMode: own.newThreadRuntimeMode } : {}) } }
  }
  /**
   * Early start (#769) goes to the thread's own host and changes nothing here. It asks for nothing the user must know
   * about, so a host that is away, refuses it or predates it leaves no notice and no error: the send says what it finds.
   */
  private async startThreadSession(input: unknown, client: ClientIdentity): Promise<AgentState> {
    try {
      const { connection, command } = this.route(input)
      if (this.requiresManagementUpdate(connection.hostId)) return { ...agentShell(this.shell()), error: LEGACY_MANAGEMENT_UPDATE }
      if (connection.available?.() !== false) await connection.service.command(command, client)
    } catch { /* The send that follows starts the session itself and reports what it finds. */ }
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
   * client's selection. A selection the user made
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
    const providers = this.namedProviders(connection, state.host.providers)
    const withProviders = providers === state.host.providers ? state : { ...state, host: { ...state.host, providers } }
    return withProviders.error ? { ...withProviders, error: this.refusal(connection, withProviders.error) } : withProviders
  }
  /** A remote host's provider errors with the host named, the way its refusals are (#459). */
  private namedProviders<T extends AgentState['host']['providers']>(connection: DesktopHostConnection, providers: T): T {
    if (connection.kind !== 'remote' || !providers?.some(provider => provider.error)) return providers
    return providers.map(provider => provider.error ? { ...provider, error: this.refusal(connection, provider.error) } : provider) as T
  }
  /**
   * Built when it changed, so what a listener holds is the state of that moment, even if the window takes it later. Only
   * the broadcast that set this publication off stands in for its host's shell: a command can change a coordinator's
   * state without broadcasting, so every other host, and every publication a broadcast did not set off, is read afresh.
   */
  private emit(broadcast?: { hostId: string; state: AgentState }): void {
    if (this.listeners.size) {
      // Built from each host's state as it is, without a copy: what is published is read, never written into.
      const state = this.build(connection => connection.hostId === broadcast?.hostId ? broadcast.state : readView(connection.service), true)
      this.published = state
      for (const listener of this.listeners) listener(state)
    } else {
      // Nothing was built for this change, so what was last published no longer answers for it.
      this.published = undefined
      this.settleAnswerNotice()
    }
    this.publishedNotice = this.notice
    for (const listener of this.changeListeners) listener()
  }
  dispose(): void {
    for (const hostId of [...this.hosts.keys()]) this.remove(hostId)
    this.listeners.clear(); this.changeListeners.clear(); this.detailListeners.clear()
    this.draftPass.disposed = true; clearTimeout(this.draftPass.gap); this.draftPass.gap = undefined; this.draftPass.wanted = undefined
  }
}

/** A host's state for a reader that only reads it: its view where it has one, a copy of its shell where it does not. */
function readView(service: Pick<HostService, 'shell' | 'view'>): AgentState { return service.view?.() ?? service.shell() }
/** Whether the window shows a thread's provider connected: the host's connection is up and the host says its provider is. */
function windowConnected(connection: DesktopHostConnection, host: AgentState['host'], thread: AgentThread): boolean {
  return connection.available?.() !== false && isThreadProviderConnected(host, thread)
}
