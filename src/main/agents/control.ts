import { CheckoutSendRefusal, type CheckoutPendingWork } from './checkoutMutations'
import type { ShortTextPurpose, ShortTextFailureReason } from '../llm/shortTextWriter'
import type { AgentSkillReference } from '../../shared/agentSkills'
import type { AgentFileReference } from '../../shared/agentFiles'
import type { AgentActivity } from '../../shared/agentActivity'
import { isImmutableActivities, subscribeActivitySnapshots } from './activitySnapshots'
import { FollowupStore, followupDigest } from './followups'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  agentAssignmentSchema, agentConfigurationSchema, agentQueueItemSchema, agentAttachmentHandlesSchema, agentAttachmentHandleSchema, agentAttachmentSchema, attachmentDigestSchema, AGENT_MAX_ATTACHMENTS, agentThreadOptionsSchema, agentThreadDraftSchema, agentDeliverySchema,
  providerUpgradeSchema, defaultAgentConfiguration, PROVIDER_REJECTED_ACTION, PROVIDER_RESULT_UNCONFIRMED, PROJECT_FOLDER_MISSING, THREAD_SETTINGS_UNRECONCILED, EMPTY_AGENT_HOST, PROVIDER_LABELS, supportsAgentSupervision, isSubscriptionReasoning, agentDeliveryReceiptsSchema, MAX_DELIVERED_DRAFTS, enabledThreadProviders, defaultNewThreadModelId, capabilitiesForThread, isThreadProviderConnected, providerIdSchema, threadSummaryOf, lastUserMessageIdOf, noProviderRefusal,
  type AgentMessage, type AgentThreadDetail, type AgentThreadDetailDelta, type AgentThreadDetailUpdate, type ProviderId, type AgentModel, type AgentRuntimeMode, type AgentAttachmentHandle, type AgentAttachmentUpload, type AgentAttachmentContent, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult, type AgentAssignment, type AgentCommand, type AgentConfiguration, type AgentDelivery, type AgentThreadDraft, type AgentHostSnapshot, type AgentProject, type AgentQueueItem, type AgentState, type AgentThread, type ProviderClientUpdate, type SubscriptionProvider,
} from '../../shared/agents'
import { nearestReasoningEffort, resolveNewThreadPermission } from '../../shared/newThreadDefaults'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { MemoryProfile } from '../memory/profile'
import type { AgentCredentials } from './credentials'
import { approvalWords, classifyRiskyAction, denialWords, mayGrantLocally, REMOTE_PERMISSION_DENIED, UNPAIRED_CLIENT_ERROR, type Authority } from './authority'
import { desktopWindowClient, supervisionClient, type ClientIdentity } from './hostService'
import type { AgentHost, AgentHostCommand, PromptImage, ThreadReadPurpose } from './host'
import type { AgentPreference, AgentReasoner } from './reasoning'
import { addTurnContext, type ActiveTurn, type TurnRecorder } from './turns'
import { isThreadArchived, isThreadClosed, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { attentionItemKey, isLiveAttention } from '../../shared/agentAttention'
import { maintainProviderRecovery, retireLegacyProvider, stripRetiredEndpoint } from './providerRetirement'
import { clientVersionOf } from './clientVersions'
import { locateClient as locateClientOnDisk, ProviderClients } from './providerClients'
import { resolveModel } from '../../shared/modelCatalog'
import { validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { AttachmentPreviews } from './attachmentPreviews'
import { AttachmentStore, inlineStager, type StageInline } from './attachmentStore'
import type { ThreadTitleExchange } from '../llm/threadTitle'
import { requestQuestionsDigest, type BindRequestDraftDecision } from './requestDrafts'
import { requestDraftProvider, requestDraftQuestions } from '../../shared/requestDrafts'
import { agentActivitySignature, applyAgentThreadDetailDelta, diffAgentThreadDetail, mergeAgentThreadDetailUpdates } from '../../shared/agentThreadDetail'
import { resolveFilesBinding } from '../files/binding'
import { THREAD_SCOPED_COMMAND_TYPES } from '../../shared/threadLanes'
import type { FilesBinding } from '../files/service'
import { isSottoRequest, withSottoRequests, type SottoThreadRequests } from './sottoRequests'
import { FinishedUnread } from './finishedUnread'

/** One shared empty array stands in for every shell thread's history; the clone that follows copies nothing. */
const EMPTY_MESSAGES: AgentMessage[] = []

/** Tracks late answer completion and keeps socket uncertainty in the calling client’s receipt. */
class AnswerDeliveryUnconfirmed extends Error {
  delivered = false
}
const EMPTY_ACTIVITIES: AgentActivity[] = []
const RECORDED_COMMAND_TYPES: ReadonlySet<AgentCommand['type']> = new Set([
  'utterance', 'connect', 'refresh', 'send', 'steer', 'steer-followup', 'manual-send', 'answer', 'create-thread', 'create-project', 'select-project',
  'select-thread', 'select-attention', 'assign', 'unassign', 'resume', 'pause', 'interrupt', 'next', 'later',
  'cancel-draft', 'pause-draft', 'resume-draft', 'cancel-request', 'configure-thread-working-copy', 'configure-thread', 'compact-thread',
])

/** A draft's images as the coordinator saves them: handles, or inline as versions before ADR-0031 saved them, staged at start. */
const savedAttachmentsSchema = z.array(z.union([agentAttachmentHandleSchema, agentAttachmentSchema])).max(AGENT_MAX_ATTACHMENTS)
type WithHandles<C> = Omit<C, 'attachments'> & { readonly attachments?: readonly AgentAttachmentHandle[] }
/** A send or steer as `dispatch` holds it: its images still handles, read only at the provider boundary. */
type PromptWithHandles = WithHandles<Extract<AgentHostCommand, { type: 'send' }>> | WithHandles<Extract<AgentHostCommand, { type: 'steer' }>>
/** What `dispatch` is handed: any host command, with a send's or steer's images as handles. */
type DispatchCommand = Exclude<AgentHostCommand, { type: 'send' | 'steer' }> | PromptWithHandles
/** The send or steer a command is, or null for any other: what `dispatch` asks, once, of every command. */
function promptOf(command: DispatchCommand): PromptWithHandles | null {
  return command.type === 'send' || command.type === 'steer' ? command : null
}
/** A draft saved without an image its window still showed: the text is kept, the image is not. */
export const DRAFT_IMAGE_NOT_SAVED = 'An image in this draft is no longer kept, so the draft was saved without it. Your text was saved. Remove the image and attach it again.'
const savedSchema = z.object({
  providerUpgrade: providerUpgradeSchema.nullable().default(null),
  configuration: z.preprocess(value => typeof value === 'object' && value !== null
    ? { ...defaultAgentConfiguration(), ...stripRetiredEndpoint(value) } : value, agentConfigurationSchema),
  assignments: z.array(agentAssignmentSchema), queue: z.array(agentQueueItemSchema),
  activeThreadId: z.string().nullable(), activeProjectId: z.string().nullable(), draft: z.string(), draftThreadId: z.string().nullable(),
  draftRequestId: z.string().nullable().default(null),
  draftAttachments: savedAttachmentsSchema.default([]),
  manualDraftId: z.uuid().nullable().default(null),
  deliveredDrafts: agentDeliveryReceiptsSchema.default([]),
  deliveredPromptDigests: z.array(z.object({ threadId: z.string(), draftId: z.uuid(), digest: z.string() })).default([]),
  answeredRequests: z.array(z.object({ threadId: z.string(), provider: providerIdSchema, requestId: z.string(), questionsDigest: z.string(), decisionId: z.string().optional() })).max(MAX_DELIVERED_DRAFTS).default([]),
  threadDrafts: z.array(agentThreadDraftSchema.extend({ attachments: savedAttachmentsSchema })).default([]),
  deliveries: z.array(agentDeliverySchema).default([]),
  pendingRequest: z.string().max(20_000).default(''),
  contextSavedAt: z.number().default(0),
  coordinatorConversation: z.boolean().default(false),
  /** The threads that finished while no client showed them, oldest first (ADR-0046). */
  finishedUnread: z.array(z.string()).default([]),
  composing: z.boolean(), outbox: z.array(z.object({
    id: z.string(), type: z.enum(['send', 'steer', 'create-project', 'create-thread', 'configure-thread', 'answer', 'interrupt', 'compact-thread']),
    provider: providerIdSchema.optional(),
    threadId: z.string().optional(), messageId: z.string().optional(), entityId: z.string().optional(), requestId: z.string().optional(),
    options: agentThreadOptionsSchema.optional(), draftDigest: z.string().optional(), draftId: z.uuid().optional(),
    questionsDigest: z.string().optional(),
    /** The images a send or steer carried: while its result is unknown, it owns their content (ADR-0031). */
    attachmentDigests: z.array(attachmentDigestSchema).max(AGENT_MAX_ATTACHMENTS).optional(),
  })),
})
type Saved = z.infer<typeof savedSchema>
const MAX_SEEN_MESSAGE_IDS = 2000
/** A write handed to the store: the state it carries, serialized and by outbox, and its landing. */
type QueuedWrite = { serialized: string; outbox: Saved['outbox']; written: Promise<void> }
class SupersededSupervision extends Error {}
class RefusedInterrupt extends Error {}
const PRIVACY_CLEANUP_ERROR = 'Could not finish applying history privacy. Sotto will retry when local storage is available.'
/** The 30-second upkeep of previews and staged images failed: nothing anyone still needs was touched. */
const ATTACHMENT_UPKEEP_ERROR = 'Could not remove screenshots Sotto no longer needs. Nothing was lost. Check access to local storage.'
/**
 * The first thing asked of a thread and the first answer it got, the only content a generated title is
 * written from. Automatic naming needs the thread to be at its first exchange and settled: a running turn
 * has no finished reply yet, and a thread that has moved on was named or left alone long ago. A requested
 * Regenerate still reads the same first exchange out of a longer history.
 */
/** A thread still on the stand-in or a provider's name; absent on threads saved before Sotto recorded it. */
function carriesDefaultTitle(thread: AgentThread): boolean {
  return thread.titleSource === undefined || thread.titleSource === 'default'
}
function firstExchange(thread: AgentThread, trigger: 'automatic' | 'requested', messages: readonly AgentMessage[]): ThreadTitleExchange | null {
  if (trigger === 'automatic' && thread.status === 'running') return null
  // A first-message title says Sotto saw this thread begin, so a steer or a queued follow-up sent during the
  // first turn does not stop it being named; any other thread is named only while it has said one thing.
  if (trigger === 'automatic' && thread.titledFromFirstMessage !== true && messages.filter(message => message.role === 'user').length !== 1) return null
  const prompt = messages.findIndex(message => message.role === 'user' && message.text.trim().length > 0)
  if (prompt === -1) return null
  const reply = messages.slice(prompt + 1).find(message => message.role === 'assistant' && message.text.trim().length > 0)
  if (!reply) return null
  return { prompt: messages[prompt]!.text, reply: reply.text }
}

/**
 * The providers the user has turned off once `off` are turned off and `on` turned on, in the stable provider order.
 * What a headless host leaves alone when it starts (ADR-0036).
 */
function turnedOff(configuration: AgentConfiguration, off: readonly ProviderId[], on: readonly ProviderId[]): ProviderId[] {
  const next = new Set([...(configuration.disconnectedProviders ?? []), ...off])
  for (const provider of on) next.delete(provider)
  return providerIdSchema.options.filter(provider => next.has(provider))
}
/** The configuration with its turned-off record replaced; an empty record is left out, as one never written. */
function withTurnedOff(configuration: AgentConfiguration, off: readonly ProviderId[]): AgentConfiguration {
  const next = { ...configuration }
  if (off.length) next.disconnectedProviders = [...off]
  else delete next.disconnectedProviders
  return next
}
/** What a snapshot says about a connection that was refused, or undefined if it
 * connected. An adapter may report a refusal in the snapshot rather than by
 * throwing, so accepting one is not on its own evidence that it connected. */
function connectionRefusal(snapshot: AgentHostSnapshot, provider: ProviderId | undefined, fallback: string): string | undefined {
  const requested = provider && snapshot.providers?.find(entry => entry.id === provider)
  if (requested && requested.connection !== 'connected') return requested.error || `${requested.name} did not confirm the connection.`
  if (!snapshot.connected) return snapshot.error || fallback
  return undefined
}
/** Where a client's last update left it, carried over a new reading: its state and what that run said. */
function outcomeOf(before: ProviderClientUpdate): Partial<ProviderClientUpdate> {
  const kept: Partial<ProviderClientUpdate> = { state: before.state }
  for (const key of ['error', 'ranAt', 'step', 'failure', 'printed'] as const) if (before[key] !== undefined) Object.assign(kept, { [key]: before[key] })
  return kept
}
/**
 * Whether a client's last update still describes a new reading of it: the same version installed, measured against the
 * same release. A newer release makes the client behind again, and "is now 2.1.287" would hide 2.1.288. A registry that
 * could not be read moves nothing.
 */
const outcomeHolds = (before: ProviderClientUpdate, reading: ProviderClientUpdate): boolean =>
  before.installed === reading.installed && (reading.published === undefined || reading.published === before.published)
/** A new reading with a client's last update on it. A registry not read this time leaves the release that update was measured against. */
const withOutcome = (reading: ProviderClientUpdate, before: ProviderClientUpdate): ProviderClientUpdate => ({
  ...reading, ...reading.published === undefined && before.published !== undefined ? { published: before.published } : {}, ...outcomeOf(before),
})

/** Owns assignment authority, queue ordering and durable dispatch intent across all host adapters. */
import type { GitRefsPage, GitRefsRequest } from '../../shared/gitRefs'
import type { GitChangedFiles, GitChangedFilesRequest } from '../../shared/gitChangedFiles'
import type { GitPullRequestDetail, GitPullRequestRequest } from '../../shared/gitPullRequests'

const GIT_COMMAND_TYPES = ['git-action', 'git-pull', 'git-switch-branch', 'git-init', 'git-publish', 'git-pull-request-action', 'git-link-pull-request', 'git-unlink-pull-request', 'git-checkout-pull-request'] as const
type GitCommand = Extract<AgentCommand, { type: (typeof GIT_COMMAND_TYPES)[number] }>
const isGitCommand = (command: AgentCommand): command is GitCommand => (GIT_COMMAND_TYPES as readonly string[]).includes(command.type)

export class AgentControl {
  private readonly followupStore: FollowupStore
  private readonly threadActions = new Map<string, Promise<unknown>>()
  /** How many lanes of each thread's own work are running; ephemeral, like the global lane's own flag. */
  private readonly busyThreads = new Map<string, number>()
  /**
   * Threads with a prompt of their own — a manual send or a steer — admitted and not yet finished.
   * Send admission and the follow-up pump read this rather than the lane, so a thread action that is
   * not a prompt never diverts a send into the queue or holds a queued follow-up back.
   */
  private readonly threadPrompts = new Map<string, number>()
  private readonly pumping = new Set<string>()
  private state: AgentState
  private outbox: Saved['outbox'] = []
  private readonly store: AtomicJsonStore<Saved>
  private persistedDrafts = new Map<string, string>()
  private readonly pendingDraftWrites = new Set<Map<string, string>>()
  private readonly emptyDraftRevisions = new Map<string, string>()
  private publishedDraftPersistence = ''
  /**
   * The newest write handed to the store, finished or not. The store writes in order, so this is what the disk
   * holds once every queued write lands. State that matches it waits for that write instead of writing again; it
   * is compared with the newest write rather than the last finished one, because an older queued write could
   * otherwise overwrite a newer state that happens to match the last completed save.
   */
  private queuedWrite: QueuedWrite | undefined
  /** Thread settings changes being dispatched now: the outbox entries that were added inside this dispatch. */
  private readonly settingsDispatching = new Set<string>()
  /**
   * Settings entries the provider confirmed inside their own dispatch, whose removal is not on disk yet. Dropping
   * one is the only change such a write would carry, so it waits for the next write that carries anything else.
   * Until then the entry stays on disk, where a restart reconciles it against the thread's settings.
   */
  private readonly settledSettings = new Set<string>()
  private readonly attachmentPreviews: AttachmentPreviews
  /** This host's staged images (ADR-0031); what keeps each one is `ownedAttachments()`. */
  private readonly attachments: AttachmentStore
  private readonly listeners = new Set<(state: AgentState) => void>()
  private readonly deciding = new Set<string>()
  private readonly considered = new Map<string, string>()
  private readonly recoveredQueueIds = new Map<string, Set<string>>()
  private readonly accountChecks = new Map<SubscriptionProvider, Promise<void>>()
  private readonly clients: ProviderClients
  private updatingClient: ProviderId | null = null
  /** The client updates waiting behind `updatingClient`, one at a time on this machine (#480). */
  private readonly clientLine: ProviderId[] = []
  /** Whoever waits for a client's update to end: an `update-client` command, which answers when it has run. */
  private readonly clientWaiters = new Map<ProviderId, { resolve: () => void; reject: (error: unknown) => void }[]>()
  private clientLineRunning = false
  /** Where each waiting client stood before it joined the line, so Cancel update puts it back. */
  private readonly clientLineBefore = new Map<ProviderId, ProviderClientUpdate>()
  private serial: Promise<unknown> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private reconnect: ReturnType<typeof setTimeout> | null = null
  private readonly providerReconnect = new Map<ProviderId, ReturnType<typeof setTimeout>>()
  private retirementFailure: string | null = null
  private disposed = false
  private readonly earlierMessageBoundaries = new Map<string, string | undefined>()
  /** Requests Sotto owns, merged into their threads (ADR-0035); absent until main gives the coordinator some. */
  private sottoRequests: SottoThreadRequests | undefined
  private unsubscribeSottoRequests: (() => void) | undefined
  private visibleCommandError: unknown
  private setCommandError(error: unknown, message: string | null): void {
    this.visibleCommandError = error; this.state.error = message
  }
  private readonly activeCommands = new Set<Promise<AgentState>>()
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null
  private privacyCleanupPending = false
  private privacyRevision = 0
  private presentedQueueId: string | null = null
  private readonly narratedAttention = new Set<string>()
  private attentionNarration: string | null = null
  private queueSelectionPinned = false
  private coordinatorConversation = false
  private speechPreferenceRevision = 0
  private selectionRevision = 0
  private manualDraftId: string | null = null
  private readonly promptAdmissions = new Map<string, { digest: string; task: Promise<AgentState> }>()
  /**
   * The whole-state answer `command()` built over each shell answer, keyed on the shell answer itself. A
   * repeated prompt is answered with the task already admitted for it, so every caller of that prompt shares
   * one shell answer, and through this map one whole-state answer too.
   */
  private readonly sharedWholeStateReplies = new WeakMap<Promise<AgentState>, Promise<AgentState>>()
  private deliveredPromptDigests: Saved['deliveredPromptDigests'] = []
  private answeredRequests: Saved['answeredRequests'] = []
  /** Ephemeral view interest; never persisted, selected or granted assignment authority. */
  private viewedThreadIds: readonly string[] = []
  /** Threads that finished while no client showed them; what a client shows is what it observes (ADR-0046). */
  private finishedUnread = new FinishedUnread()
  private readonly dispatchTurns = new Map<string, ActiveTurn>()
  private readonly feedbackReady = new Set<ActiveTurn>()
  private broadcastCancel: (() => void) | null = null
  private broadcastOpen = false
  private broadcastPending = false
  private readonly detailListeners = new Set<(update: AgentThreadDetailUpdate) => void>()
  /** Per thread: the signature of the messages last handed out, and the revision that stands for them. */
  private readonly activityDetailSignatures = new WeakMap<readonly AgentActivity[], string>()
  private readonly detailRevisions = new Map<string, { signature: string; revision: number }>()
  /** The message count a thread's first exchange was last looked for at, so it is looked for once per arrival. */
  private readonly titleChecked = new Map<string, number>()
  private readonly publishedDetail = new Map<string, number>()
  /**
   * The history each detail target was last sent, undecorated, to diff the next one against. Bounded by
   * the targets themselves: a thread that leaves the viewed set frees its snapshot on the next broadcast.
   */
  private readonly detailSnapshots = new Map<string, AgentThreadDetail>()
  private contextActivityAt = Date.now()
  /** Threads already asked about this run, so a failure is not retried on every provider frame. */
  private readonly titled = new Set<string>()
  private readonly titleWrites = new Set<Promise<void>>()
  /** Threads seen this run with nothing said yet: their first message, when it comes, gives them a first-message title. */
  private readonly awaitingFirstMessage = new Set<string>()
  /** The desktop window on this machine: the only client there is, and what an unattributed call means. */
  private readonly localClient: ClientIdentity = desktopWindowClient()
  /** Sotto's own supervision, so a recorded answer shows it came from Sotto and not from the user. */
  private readonly supervisionClient: ClientIdentity = supervisionClient(this.localClient.user)
  constructor(private readonly dependencies: {
    directory: string; host: AgentHost; credentials: AgentCredentials; reasoner: AgentReasoner
    bindRequestDraftDecision?: BindRequestDraftDecision
    historyEnabled?: () => boolean
    /** Whether the voice coordinator ships. Off, no thread stays managed across a start (ADR-0012). */
    coordinatorEnabled?: () => boolean
    observeActiveThread?: boolean
    turns?: TurnRecorder
    authority?: Authority
    preferences?: Pick<MemoryProfile, 'retrieve'>
    openThreadFolder?: (path: string) => Promise<void>
    /**
     * Writes a thread's name from its first exchange, asking that thread's own provider on the side
     * (ADR-0026). `null` leaves the thread the name it has, which is also what an off switch, a provider
     * that writes nothing and every failure resolve to. Absent here means no thread is ever named by Sotto.
     */
    writeThreadTitle?: (threadId: string, exchange: ThreadTitleExchange) => Promise<string | null>
    /**
     * The first-message title for a thread's first message: its opening words, given the moment it is sent so
     * the thread is not "New thread" while its first turn runs. `null` (generation off) leaves the stand-in;
     * absent here means no thread is given one.
     */
    writeFirstMessageTitle?: (prompt: string) => Promise<string | null>
    /** Local record of a silent failure; never a banner, never shown to the user. */
    logFailure?: (code: 'client-update-handoff-failed' | 'thread-title-failed' | 'thread-answer-attribution-failed' | 'short-writing-failed', detail: ProviderId | 'failed' | `${ShortTextPurpose} ${ShortTextFailureReason}`) => void
    /** Defers a coalesced broadcast; injectable so tests own the clock. */
    schedule?: PublishScheduler
    /** What each installed client publishes, and the press that installs it. */
    clients?: ProviderClients
    /** Where a client is installed. Injected so a test never reads the machine's real PATH. */
    locateClient?: (provider: ProviderId) => Promise<string | undefined>
    /**
     * Anything else in this process running a client, told once an install has put a new one on disk so it
     * moves its processes to it as they go idle (ADR-0042). Personal chats hold their own copy of each client.
     */
    clientUpdated?: (provider: ProviderId) => Promise<void>
    /** The sentence a send is refused with when an image it names is no longer kept; a headless host names itself. */
    missingAttachment?: string
    /**
     * Which process this coordinator runs in. The headless host (`src/host/index.ts`) connects every provider
     * that is installed and signed in when it starts, except the ones the user turned off, and its refusals point
     * at Settings → Hosts on whichever desktop shows them (ADR-0036). Absent means the desktop, which connects the
     * providers the user connected in Settings → Providers.
     */
    runsAs?: 'desktop' | 'headless-host'
  }) {
    this.followupStore = new FollowupStore(dependencies.directory)
    this.clients = dependencies.clients ?? new ProviderClients()
    this.state = {
      configuration: defaultAgentConfiguration(), connection: 'disconnected', host: structuredClone(EMPTY_AGENT_HOST),
      assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
      draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [],
      pendingRequest: '',
      globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
      voice: { status: 'off', error: null, action: 'none', revision: 0 },
      credentials: { reasoning: false, grokSpeech: false, secure: false },
      reasoningAccounts: [],
    }
    this.store = new AtomicJsonStore(join(dependencies.directory, 'agents.json'), savedSchema.parse, () => this.saved())
    this.attachments = new AttachmentStore(dependencies.directory, { historyEnabled: () => dependencies.historyEnabled?.() !== false, missing: dependencies.missingAttachment })
    this.stageInline = inlineStager(this.attachments)
    this.attachmentPreviews = new AttachmentPreviews(dependencies.directory, this.attachments, () => dependencies.historyEnabled?.() !== false)
  }
  async start(): Promise<void> {
    await this.dependencies.turns?.initialize()
    // Remove retired ciphertext without decrypting it, including while the vault is locked.
    for (const slot of ['membership', 'membership-cache']) {
      try {
        if (this.dependencies.credentials.has(slot)) await this.dependencies.credentials.set(slot, '')
      } catch {
        console.warn('retired-credential-clear-failed')
      }
    }

    try {
      await retireLegacyProvider({ directory: this.dependencies.directory, parse: savedSchema.parse,
        historyEnabled: this.dependencies.historyEnabled?.() !== false, credentials: this.dependencies.credentials })
      this.retirementFailure = null
    } catch (error) {
      this.retirementFailure = 'Could not safely recover the previous provider state. No provider was connected. Restart after restoring access to local storage.'
      this.state.error = this.retirementFailure
      throw error
    }
    const saved = await this.store.read()
    // The store comes first: previews, drafts and the queue each name content it keeps, and older files carry
    // their images inline, which are staged here before anything reads them (ADR-0031).
    await this.attachments.load()
    const images = await this.adoptSavedImages(saved)
    this.persistedDrafts = this.draftSignatures(images.threadDrafts)
    await this.attachmentPreviews.load(this.stageInline)
    this.contextActivityAt = saved.contextSavedAt
    const { outbox, contextSavedAt, coordinatorConversation, manualDraftId, deliveredPromptDigests, answeredRequests, finishedUnread, ...restored } = saved
    this.coordinatorConversation = coordinatorConversation
    this.finishedUnread.restore(finishedUnread)
    this.queueSelectionPinned = coordinatorConversation
    this.deliveredPromptDigests = deliveredPromptDigests
    this.answeredRequests = answeredRequests
    this.manualDraftId = manualDraftId
    // The drafts' images as adopted above replace what the file held.
    Object.assign(this.state, restored, { draftAttachments: images.draftAttachments, threadDrafts: images.threadDrafts })
    // Upgrade the native singleton in place, never from the currently selected thread.
    this.syncLegacyDraft()
    await this.followupStore.load(this.stageInline, handle => this.attachments.has(handle.digest))
    this.syncFollowups()
    await this.dependencies.host.initialize?.()
    if (this.dependencies.host.workspaceSnapshot) this.state.host = this.withSottoRequests(this.dependencies.host.workspaceSnapshot())
    const cutoff = Date.now() - 7 * 86_400_000
    const historyDisabled = this.dependencies.historyEnabled?.() === false
    // Startup can defer a failed history-store open until this coordinator can run maintenance.
    this.privacyCleanupPending ||= historyDisabled
    for (const assignment of this.state.assignments) {
      assignment.seenMessageIds = assignment.seenMessageIds.slice(-MAX_SEEN_MESSAGE_IDS)
      if (assignment.contextUpdatedAt < cutoff || historyDisabled) {
        if (assignment.instruction) assignment.paused = true
        assignment.instruction = ''
      }
      if (!/^[a-f0-9]{64}$/u.test(assignment.lastFailure)) assignment.lastFailure = ''
    }
    // With the coordinator hidden nothing can stop management, so a thread an earlier build left managed would refuse
    // every draft and send while Sotto kept supervising it. Management ends here instead, queue rows and all.
    if (this.dependencies.coordinatorEnabled?.() === false && this.state.assignments.length > 0) {
      const managed = new Set(this.state.assignments.map(assignment => assignment.threadId))
      this.state.assignments = []
      this.state.queue = this.state.queue.filter(item => !managed.has(item.threadId))
    }
    if (contextSavedAt < cutoff || historyDisabled) {
      this.state.pendingRequest = ''
    }
    this.state.queue = this.state.queue.filter(item => item.requestId || (!historyDisabled && Date.parse(item.createdAt) > cutoff))
      .map(item => historyDisabled ? { ...item, text: 'Open the provider to review this pending request.' } : item)
    // A durable attention item means its observation already reached a result.
    // Do not persist the in-flight `considered` map: a crash must retry unfinished work.
    for (const item of this.state.queue) {
      this.narratedAttention.add(attentionItemKey(item))
      if (item.kind === 'permission') continue
      const ids = this.recoveredQueueIds.get(item.threadId) ?? new Set<string>()
      ids.add(item.id)
      this.recoveredQueueIds.set(item.threadId, ids)
    }
    // Before independent providers, every durable pending action belonged to the restored native provider.
    this.outbox = outbox.map(item => ({ ...item, provider: item.provider ?? this.state.configuration.provider }))
    for (const delivery of this.state.deliveries ?? []) {
      if (delivery.status === 'queued' || delivery.status === 'submitting') {
        delivery.status = this.outbox.some(item => item.threadId === delivery.threadId && item.draftId === delivery.draftId) ? 'uncertain' : 'failed'
        delivery.updatedAt = new Date().toISOString()
      }
    }
    for (const item of this.outbox) {
      if ((item.type !== 'send' && item.type !== 'steer') || !item.threadId) continue
      item.draftId ??= this.state.threadDrafts?.find(draft => draft.threadId === item.threadId && (item.draftDigest
        ? item.draftDigest === followupDigest(draft) : draft.requestId === null))?.draftId ?? randomUUID()
      this.setDelivery(item.threadId, item.draftId, 'uncertain', { commandId: item.id, messageId: item.messageId })
    }
    // A headless host connects every provider that is installed and signed in, except the ones the user turned off
    // (ADR-0036). Trying one is how Sotto learns whether it is installed and signed in: a provider that is not
    // ends in its own error and is not retried, and the host stays up for the ones that are.
    if (this.dependencies.runsAs === 'headless-host' && this.dependencies.host.concurrentProviders) {
      // A host saved before the record existed wrote an empty enabled set only for Disconnect with no provider,
      // which no default produces: that was the user turning every provider off, and it stays so.
      if (this.state.configuration.disconnectedProviders === undefined && this.state.configuration.enabledProviders?.length === 0) {
        this.state.configuration = withTurnedOff(this.state.configuration, [...providerIdSchema.options])
      }
      const off = new Set(this.state.configuration.disconnectedProviders ?? [])
      this.state.configuration.enabledProviders = providerIdSchema.options.filter(provider => !off.has(provider))
    }
    // Redaction also reaches disk when control is disabled and no reconnect will run.
    await this.persist()
    await this.attachments.sweep(() => this.ownedAttachments())
    this.maintenanceTimer = setInterval(() => {
      const pendingPrivacy = this.privacyCleanupPending
      void (pendingPrivacy ? this.privacyChanged() : this.maintainAttachments()).catch(() => {
        this.state.error = pendingPrivacy ? PRIVACY_CLEANUP_ERROR : ATTACHMENT_UPKEEP_ERROR
        this.publish()
      })
    }, 30_000)
    this.updateCredentials()
    if (isSubscriptionReasoning(this.state.configuration.reasoning)) {
      // Native login/model discovery must not hold up dictation or the desktop window.
      void this.checkReasoning(this.state.configuration.reasoning).then(() => this.publish())
    }
    // Subscribe before the first observe: telling the workspace which threads are open now makes it
    // load their history, and that publish has to reach this coordinator (issue #119).
    this.unsubscribe = subscribeActivitySnapshots(this.dependencies.host, snapshot => this.acceptSnapshot(snapshot))
    this.observe()
    if (this.state.configuration.enabled || (this.dependencies.host.concurrentProviders && this.state.configuration.enabledProviders?.length)) {
      const connection = this.commandShell({ type: 'connect' })
      if (!this.dependencies.host.concurrentProviders) await connection
      // Independent native discovery must not delay constructing the desktop IPC surface.
      else void connection
    }
  }
  /**
   * Requests Sotto itself puts in a thread, such as the host setup thread's "Add forge as a host?" (ADR-0035). They
   * sit among the thread's requests from now on, and the user's answer goes back to them rather than to a provider.
   */
  useSottoRequests(requests: SottoThreadRequests): void {
    this.unsubscribeSottoRequests?.()
    this.sottoRequests = requests
    // A change is taken like a new snapshot, so the request reaches the attention queue as a provider's does.
    this.unsubscribeSottoRequests = requests.subscribe(() => this.acceptSnapshot(this.state.host))
  }
  private withSottoRequests(snapshot: AgentHostSnapshot): AgentHostSnapshot {
    return this.sottoRequests ? withSottoRequests(snapshot, this.sottoRequests.requests()) : snapshot
  }
  /**
   * The threads some client shows now (ADR-0046). The host service says which: every client's observed threads, the
   * desktop window's only while it has the focus. Showing a thread is what reads its finish, on every client at once,
   * and the cleared mark is saved so a restart keeps it read. True when a mark was cleared.
   */
  showThreads(threadIds: readonly string[]): boolean {
    if (!this.finishedUnread.show(threadIds)) return false
    this.publish()
    void this.persist().catch(() => undefined)
    return true
  }
  hasPendingThreadWork(threadId: string): boolean {
    return this.pendingThreadWorkReason(threadId) !== null
  }
  /** The existing pending-work guard's reason, so a refusal offers the recovery this work actually needs. */
  pendingThreadWorkReason(threadId: string): CheckoutPendingWork | null {
    const items = this.followupStore.peek().items.filter(item => item.threadId === threadId)
    const deliveries = (this.state.deliveries ?? []).filter(item => item.threadId === threadId)
    const assignment = this.state.assignments.find(item => item.threadId === threadId && item.mode === 'managed')
    if (items.some(item => item.status === 'uncertain') || deliveries.some(item => item.status === 'uncertain')) return 'uncertain-send'
    if (items.some(item => item.status === 'failed')) return 'failed-followups'
    if (items.length && assignment?.paused) return 'paused-assignment'
    if (items.some(item => item.status === 'paused')) return 'paused-followups'
    if (assignment && !assignment.paused) return 'managed-assignment'
    if (items.length || this.outbox.some(item => item.threadId === threadId) || deliveries.some(item => ['queued', 'submitting'].includes(item.status))) return 'pending-work'
    return null
  }
  /**
   * Where one thread's files are, from the live state. Files, Git changes, the terminal and the browser
   * ask this several times per listing and every couple of seconds per watched workspace; answering from
   * `get()` copied every loaded history to read six fields. The binding is a new object of strings.
   */
  filesBinding(threadId: string): FilesBinding | null { return resolveFilesBinding(this.state.host, threadId) }
  /** The projects alone, as a copy, for callers that need nothing else from the state. */
  projects(): AgentProject[] { return structuredClone(this.state.host.projects) }
  /**
   * The whole state, every loaded thread's history included, with attachment preview markers placed.
   * It copies every history and walks every message, so it is for a caller that reads histories;
   * a client's command is answered with `shell()` instead (issue #313).
   */
  get(): AgentState {
    const state = structuredClone(this.state)
    state.host.threads = state.host.threads.map(thread => this.finishedUnread.publish(thread))
    state.hostId = state.host.hostId
    state.threadDraftPersistence = this.draftPersistence()
    state.historyEnabled = this.dependencies.historyEnabled?.() !== false
    if (this.busyThreads.size) state.busyThreadIds = [...this.busyThreads.keys()]
    const unconfirmedSettings = this.unconfirmedSettings()
    if (unconfirmedSettings.length) state.unconfirmedSettings = unconfirmedSettings
    this.attachmentPreviews.decorate(state.host)
    return state
  }
  /**
   * Counts one thread into a live set until the returned release is called. Releasing is idempotent,
   * so a lane can release when it finishes and its cleanup can release again for a lane that never
   * reached that point. `globalLaneBusy` stands for the one global lane alone, so work running
   * in a thread's own lane marks itself here instead.
   */
  private mark(counts: Map<string, number>, threadId: string): () => void {
    counts.set(threadId, (counts.get(threadId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (counts.get(threadId) ?? 1) - 1
      if (remaining > 0) counts.set(threadId, remaining)
      else counts.delete(threadId)
    }
  }
  /**
   * The published state without any thread's history: every thread the window lists, each one carrying the
   * summary its sidebar row reads instead of the messages behind it. A thread's messages are a few hundred
   * kilobytes and a provider publishes dozens of times a second; the shell is what every window needs, and
   * only the threads it has declared viewed also receive `threadDetail`.
   */
  /** The settings changes kept in the outbox with no result, as the window marks them on the thread's chips. */
  private unconfirmedSettings(): NonNullable<AgentState['unconfirmedSettings']> {
    // An entry whose dispatch is still running has no result yet; the chips are already waiting on it.
    return this.outbox.flatMap(item => item.type === 'configure-thread' && item.threadId && item.options && !this.settingsDispatching.has(item.id)
      ? [{ ...item.options, threadId: item.threadId }] : [])
  }
  shell(): AgentState {
    const threads = this.state.host.threads
    const bare = { ...this.state, host: { ...this.state.host, threads: threads.map(thread => this.finishedUnread.publish({
      ...thread, messages: EMPTY_MESSAGES,
      ...(thread.activities === undefined ? {} : { activities: EMPTY_ACTIVITIES }),
      summary: threadSummaryOf(thread),
    })) } }
    const state = structuredClone(bare)
    state.hostId = state.host.hostId
    state.threadDraftPersistence = this.draftPersistence()
    state.historyEnabled = this.dependencies.historyEnabled?.() !== false
    if (this.busyThreads.size) state.busyThreadIds = [...this.busyThreads.keys()]
    const unconfirmedSettings = this.unconfirmedSettings()
    if (unconfirmedSettings.length) state.unconfirmedSettings = unconfirmedSettings
    return state
  }
  /**
   * One thread's history — its messages and the activity beside them — for a window looking at it.
   * Handing out a whole detail also resets what the deltas that follow are measured from: a window that
   * asked for this one holds exactly this revision, so the next delta is the one that follows it.
   *
   * Every other listener still holds the revision last broadcast. When the thread has moved on since, a
   * change still waiting in the coalescing window is sent to them first, measured from what they hold,
   * so the reset never leaves them a delta they cannot apply and a read by one client never sets off a
   * whole read by another.
   */
  threadDetail(threadId: string): AgentThreadDetail | null {
    const thread = this.state.host.threads.find(item => item.id === threadId)
    if (!thread) return null
    const revision = this.detailRevision(thread)
    if (this.detailListeners.size && this.detailSnapshots.has(threadId) && this.publishedDetail.get(threadId) !== revision) {
      const update = this.detailUpdate(thread, revision)
      if (update) for (const listener of this.detailListeners) listener(update)
    }
    return this.wholeDetail(thread, revision)
  }
  /** The whole of a thread's history at a revision, which becomes the base the next delta is measured from. */
  private wholeDetail(thread: AgentThread, revision: number): AgentThreadDetail {
    const threadId = thread.id
    const messages = structuredClone(thread.messages)
    // Nothing decorates or edits an activity record on either side of the bridge, so the snapshot and the
    // detail share one copy of it. Messages cannot be shared: decoration rewrites their attachments.
    const pane = this.paneActivities(thread)
    const activities = pane === undefined ? undefined : structuredClone(pane) as AgentActivity[]
    // The snapshot is the undecorated history: decoration is a fact about the preview store rather than
    // about the thread, and diffing decorated against live would report every image message as changed.
    this.detailSnapshots.set(threadId, { threadId, revision, messages: structuredClone(thread.messages),
      ...(activities === undefined ? {} : { activities }) })
    this.publishedDetail.set(threadId, revision)
    this.attachmentPreviews.decorate({ ...this.state.host, threads: [{ ...thread, messages }] })
    return { threadId, revision, messages, ...(activities === undefined ? {} : { activities }),
      ...(thread.earlierAvailable ? { earlierAvailable: true } : {}) }
  }
  /**
   * The activity a detail carries beside the thread's messages. The host keeps back the work of turns above
   * the loaded window, which waits there with their messages; everything else in main reads every record.
   */
  private paneActivities(thread: AgentThread): readonly AgentActivity[] | undefined {
    if (thread.activities === undefined) return undefined
    return this.dependencies.host.paneActivities?.(thread.id, thread.activities) ?? thread.activities
  }
  /** Which threads main pushes detail for: what the window says it is looking at, plus work it must see land. */
  private detailTargets(): string[] {
    return [...new Set([
      ...(this.dependencies.observeActiveThread !== false && this.state.activeThreadId ? [this.state.activeThreadId] : []),
      ...this.viewedThreadIds,
      ...(this.state.deliveries ?? []).filter(item => item.status !== 'accepted').map(item => item.threadId),
      ...this.followupStore.peek().items.map(item => item.threadId),
      ...this.outbox.flatMap(item => item.threadId ? [item.threadId] : []),
    ])].filter(id => this.state.host.threads.some(thread => thread.id === id))
  }
  /**
   * A revision that changes exactly when a thread's messages do. Built from identity and length rather
   * than the text itself: a streaming chunk must bump it without the cost of copying every message.
   */
  private detailRevision(thread: AgentThread): number {
    const activities = this.paneActivities(thread)
    let activitySignature = activities && this.activityDetailSignatures.get(activities)
    if (activitySignature === undefined) {
      activitySignature = (activities ?? []).map(record => `${record.id}:${agentActivitySignature(record)}`).join(',')
      if (activities && isImmutableActivities(activities)) this.activityDetailSignatures.set(activities, activitySignature)
    }
    const signature = `${thread.historyEpoch ?? ''}|${thread.messages.length}|` + thread.messages
      .map(message => `${message.id}:${message.text.length}:${message.attachments?.length ?? 0}`).join(',')
      + `|${activitySignature}`
    const held = this.detailRevisions.get(thread.id)
    if (held && held.signature === signature) return held.revision
    const revision = (held?.revision ?? 0) + 1
    this.detailRevisions.set(thread.id, { signature, revision })
    return revision
  }
  subscribeThreadDetail(listener: (update: AgentThreadDetailUpdate) => void): () => void {
    this.detailListeners.add(listener)
    return () => this.detailListeners.delete(listener)
  }
  /** The branches a thread's folder offers, read on request rather than pushed with every state. */
  gitRefs(request: GitRefsRequest): Promise<GitRefsPage> {
    if (!this.dependencies.host.listThreadRefs) throw new Error('Branches are unavailable on this host.')
    return this.dependencies.host.listThreadRefs(request)
  }
  /** The changed files the commit dialog lists, read when it opens rather than pushed with every state. */
  gitChangedFiles(request: GitChangedFilesRequest): Promise<GitChangedFiles> {
    if (!this.dependencies.host.listThreadChangedFiles) throw new Error('Changed files are unavailable on this host.')
    return this.dependencies.host.listThreadChangedFiles(request)
  }
  /** One pull request of a thread's, read when the Pull request surface or a pull request dialog asks for it (ADR-0027). */
  gitPullRequest(request: GitPullRequestRequest): Promise<GitPullRequestDetail | null> {
    if (!this.dependencies.host.readThreadPullRequest) throw new Error('Pull requests are unavailable on this host.')
    return this.dependencies.host.readThreadPullRequest(request)
  }
  /** One submitted image, fetched by the window when it draws the tile rather than pushed with every state. */
  async attachmentPreview(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult> {
    const dataUrl = await this.attachmentPreviews.preview(this.state.host, request.threadId, request.messageId, request.attachmentId)
    return dataUrl === null ? null : { dataUrl }
  }
  /**
   * Keeps an image's bytes once, on this host, and answers with the handle a draft carries instead of them
   * (ADR-0031). The content is unowned until a draft or follow-up that names it is saved.
   */
  stageAttachment(image: AgentAttachmentUpload): Promise<AgentAttachmentHandle> {
    return this.attachments.stage(image)
  }
  /** A staged image's bytes, for a composer restoring a chip it holds no copy of; null once this host no longer keeps it. */
  async attachmentContent(digest: string): Promise<AgentAttachmentContent | null> {
    const mimeType = this.attachments.mimeType(digest)
    const bytes = mimeType ? await this.attachments.read(digest) : null
    // A copy of exactly these bytes: a view would carry its whole backing buffer across IPC, which for a small image can be shared.
    return mimeType && bytes ? { mimeType, bytes: new Uint8Array(bytes) } : null
  }
  /** Stages one image an older version saved inline, keeping its attachment ID: drafts, the queue and previews all use it. */
  private readonly stageInline: StageInline
  /**
   * The saved drafts' images as handles: inline ones staged, and any whose content is gone (kept in memory while
   * history was off) dropped, so no draft comes back pointing at content that is not there. An inline image that is
   * not the image it claims, which earlier versions saved unchecked, is dropped too; failing to keep one stops start.
   */
  private async adoptSavedImages(saved: Saved): Promise<{ draftAttachments: AgentAttachmentHandle[]; threadDrafts: AgentThreadDraft[] }> {
    const adopt = async (items: Saved['draftAttachments']): Promise<AgentAttachmentHandle[]> => {
      const handles: AgentAttachmentHandle[] = []
      for (const item of items) {
        const handle = 'dataUrl' in item ? await this.stageInline(item) : this.attachments.has(item.digest) ? item : null
        if (handle) handles.push(handle)
      }
      return handles
    }
    const threadDrafts: AgentThreadDraft[] = []
    for (const draft of saved.threadDrafts) threadDrafts.push({ ...draft, attachments: await adopt(draft.attachments) })
    return { draftAttachments: await adopt(saved.draftAttachments), threadDrafts }
  }
  /** Every content something still owns: a draft, the coordinator's draft, a queued follow-up, an unsettled send or a preview. */
  private ownedAttachments(): Set<string> {
    const owned = this.attachmentPreviews.digests()
    const add = (items: readonly AgentAttachmentHandle[] | undefined): void => { for (const item of items ?? []) owned.add(item.digest) }
    add(this.state.draftAttachments)
    for (const draft of this.state.threadDrafts ?? []) add(draft.attachments)
    for (const item of this.followupStore.peek().items) add(item.attachments)
    for (const entry of this.outbox) for (const digest of entry.attachmentDigests ?? []) owned.add(digest)
    return owned
  }
  /**
   * Preview retention first, then the content nothing owns any more. With `historyOff`, content only previews kept
   * goes at once; anything else unowned, such as an image staged for a draft not yet saved, keeps its grace. That
   * includes content a preview names that was staged again since, for a draft.
   */
  private async maintainAttachments(historyOff = false): Promise<void> {
    const previewed = historyOff ? this.attachmentPreviews.named() : undefined
    await this.attachmentPreviews.maintain()
    await this.attachments.sweep(() => this.ownedAttachments(), undefined, previewed)
  }
  /** A staged image as the adapter receives it: the handle, and its bytes read from the store only when asked. */
  private promptImage(handle: AgentAttachmentHandle): PromptImage {
    const { id, name, mimeType, sizeBytes, digest } = handle
    return { id, name, mimeType, sizeBytes, digest, read: async () => {
      const bytes = await this.attachments.read(digest)
      if (!bytes) throw new Error(this.attachments.missing)
      return bytes
    } }
  }
  /** Configuration alone. get() copies every thread's history, which is costly on every provider event. */
  configuration(): AgentConfiguration {
    return structuredClone(this.state.configuration)
  }
  private draftPersistence(): NonNullable<AgentState['threadDraftPersistence']> {
    const drafts = this.state.threadDrafts ?? []
    const current = this.draftSignatures(drafts)
    const revisions = new Map(this.emptyDraftRevisions)
    for (const draft of drafts) revisions.set(draft.threadId, draft.draftId)
    return [...revisions].map(([threadId, draftId]) => {
      const signature = current.get(threadId)
      return { threadId, draftId, status: this.persistedDrafts.get(threadId) === signature ? 'saved'
        : [...this.pendingDraftWrites].some(write => write.get(threadId) === signature) ? 'saving' : 'unsaved' }
    })
  }
  subscribe(listener: (state: AgentState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private saved(): Saved {
    this.syncLegacyDraft()
    const { configuration, assignments, queue, activeThreadId, activeProjectId, draft, draftThreadId, draftRequestId, composing, pendingRequest } = this.state
    const retainContext = this.dependencies.historyEnabled?.() !== false
    return structuredClone({ configuration, providerUpgrade: this.state.providerUpgrade ?? null,
      assignments: assignments.map(assignment => ({ ...assignment, instruction: retainContext ? assignment.instruction : '', paused: assignment.paused || (!retainContext && Boolean(assignment.instruction)) })),
      queue: queue.map(item => ({ ...item, text: retainContext ? item.text : 'Open the provider to review this pending item.' })),
      activeThreadId, activeProjectId, draft, draftThreadId, draftRequestId, draftAttachments: this.state.draftAttachments ?? [], composing, pendingRequest: retainContext ? pendingRequest : '',
      contextSavedAt: this.contextActivityAt, outbox: this.outbox, manualDraftId: this.manualDraftId, deliveredDrafts: this.state.deliveredDrafts ?? [],
      coordinatorConversation: this.coordinatorConversation,
      finishedUnread: this.finishedUnread.saved(),
      deliveredPromptDigests: this.deliveredPromptDigests,
      answeredRequests: this.answeredRequests,
      threadDrafts: this.state.threadDrafts ?? [], deliveries: this.state.deliveries ?? [] })
  }
  async privacyChanged(): Promise<void> {
    const revision = ++this.privacyRevision
    this.privacyCleanupPending = true
    // Attachment previews are decoration, not history, so a thread's revision does not move when they go.
    // Forget what every window holds: the next broadcast sends whole details, without the markers.
    this.publishedDetail.clear()
    this.detailSnapshots.clear()
    // A failed store must not prevent the remaining stores from honoring the
    // privacy change. Preserve the failure for the caller after every cleanup runs.
    const cleanup = [
      // Turning history off removes at once the content only previews kept.
      () => this.maintainAttachments(this.dependencies.historyEnabled?.() === false),
      () => maintainProviderRecovery(this.dependencies.directory, this.dependencies.historyEnabled?.() !== false),
      () => this.dependencies.host.privacyChanged?.(),
      () => this.persist(),
    ]
    const results = await Promise.allSettled(cleanup.map(operation => Promise.resolve().then(operation)))
    const failure = results.find(result => result.status === 'rejected')
    if (revision === this.privacyRevision) {
      this.privacyCleanupPending = failure !== undefined
      if (failure) this.state.error = PRIVACY_CLEANUP_ERROR
      else if (this.state.error === PRIVACY_CLEANUP_ERROR) this.state.error = null
    }
    this.publish()
    if (failure?.status === 'rejected') throw failure.reason
  }
  /** `closing`: the last write before Sotto stops, which leaves no confirmed settings entry behind on disk. */
  private async persist(closing = false): Promise<void> {
    if (this.retirementFailure) throw new Error(this.retirementFailure)
    const saved = this.saved()
    const serialized = JSON.stringify(saved)
    const outbox = [...saved.outbox]
    const queued = this.queuedWrite
    if (queued && (serialized === queued.serialized || (!closing && this.onlySettledSettings(saved, outbox, queued)))) {
      // The newest queued write already carries this state, so it is durable when that write lands. A write
      // still in flight is waited for rather than repeated, and its failure is this call's failure.
      await queued.written
    } else {
      const drafts = this.draftSignatures(saved.threadDrafts)
      this.pendingDraftWrites.add(drafts)
      const written = this.store.write(saved)
      const current: QueuedWrite = { serialized, outbox, written }
      this.queuedWrite = current
      try {
        await written
        // AtomicJsonStore serializes writes. Confirm only the snapshot that actually
        // completed, never newer state that changed while this write was outstanding.
        this.persistedDrafts = drafts
        for (const id of this.settledSettings) if (!outbox.some(item => item.id === id)) this.settledSettings.delete(id)
      } catch (error) {
        // The disk still holds an older state, so the next persist writes whatever it has.
        if (this.queuedWrite === current) this.queuedWrite = undefined
        throw error
      } finally {
        this.pendingDraftWrites.delete(drafts)
      }
    }
    // Some full-state writes are fire-and-forget; a fresh renderer still needs
    // their completion evidence, even when no command response reaches it.
    // Most writes follow host snapshots and change no evidence; republishing
    // every thread's history for them backs up the main process.
    if (JSON.stringify(this.draftPersistence()) !== this.publishedDraftPersistence) this.publish()
  }
  /**
   * True when the state differs from the newest queued write only by settings entries confirmed inside their own
   * dispatch. The entry's add was the write that mattered; its removal rides on the next write.
   */
  private onlySettledSettings(saved: Saved, outbox: Saved['outbox'], queued: QueuedWrite): boolean {
    if (!this.settledSettings.size) return false
    const kept = queued.outbox.filter(item => !this.settledSettings.has(item.id))
    if (kept.length === queued.outbox.length || JSON.stringify(kept) !== JSON.stringify(outbox)) return false
    return JSON.stringify({ ...saved, outbox: queued.outbox }) === queued.serialized
  }
  private draftSignatures(drafts: readonly Saved['threadDrafts'][number][]): Map<string, string> {
    return new Map(drafts.map(({ threadId, draftId, text, attachments, skills, files, requestId }) => [threadId,
      createHash('sha256').update(JSON.stringify({ draftId, text, attachments, skills, files, requestId })).digest('hex')]))
  }
  /**
   * Records this moment's feedback evidence, then asks for a broadcast. A provider emits dozens of
   * frames a second and every one of them publishes, so listener notifications coalesce onto
   * one run per window. Commands
   * still return the state their action produced. Draft saves and voice-status reports return the
   * shell directly so a routine reply never copies histories the desktop router will discard.
   */
  private publish(feedback?: { receivedAt: number; threadId: string; draftId: string }): void {
    if (this.disposed) return
    // Timing evidence belongs to the moment publish was called, not to the run that carries it out;
    // recording it on this.state now means the copy the broadcast makes later already holds it.
    if (feedback) {
      const localFeedbackMs = performance.now() - feedback.receivedAt
      const delivery = this.state.deliveries?.find(item => item.threadId === feedback.threadId && item.draftId === feedback.draftId)
      if (delivery) delivery.localFeedbackMs = localFeedbackMs
    }
    for (const turn of this.feedbackReady) turn.firstFeedbackAtMs ??= Date.now()
    this.feedbackReady.clear()
    // The first publish of a burst is never held back; anything during the window rides the trailing run.
    if (this.broadcastOpen) this.broadcastPending = true
    else this.broadcast()
  }
  private broadcast(): void {
    if (this.disposed) return
    this.broadcastPending = false
    const value = this.shell()
    this.publishedDraftPersistence = JSON.stringify(value.threadDraftPersistence)
    for (const listener of this.listeners) listener(value)
    this.broadcastDetail()
    // Keep the window open after every broadcast: a burst that continues must keep coalescing.
    this.broadcastOpen = true
    const cancel = (this.dependencies.schedule ?? realPublishScheduler)(() => {
      this.broadcastOpen = false
      this.broadcastCancel = null
      if (this.broadcastPending) this.broadcast()
    }, AGENT_STATE_BROADCAST_INTERVAL_MS)
    // A scheduler that runs its work immediately (tests) has already closed the window.
    if (this.broadcastOpen) this.broadcastCancel = cancel
  }
  /**
   * Detail rides the shell's own coalescing window, one send per thread whose messages actually changed.
   * A thread nobody is looking at is never copied at all, and one whose revision the window already holds
   * is skipped, so a streaming burst costs one thread's history rather than every thread's.
   *
   * Once a window holds a revision, what follows is the difference from it: the chunk a message grew by
   * and the activity records that moved, never the thread again. A record updated five times inside one
   * window is diffed once, at the end, because the diff is taken here rather than as each event lands.
   */
  private broadcastDetail(): void {
    if (!this.detailListeners.size) return
    const targets = this.detailTargets()
    for (const threadId of this.publishedDetail.keys()) if (!targets.includes(threadId)) this.publishedDetail.delete(threadId)
    for (const threadId of this.detailSnapshots.keys()) if (!targets.includes(threadId)) this.detailSnapshots.delete(threadId)
    for (const threadId of targets) {
      const thread = this.state.host.threads.find(item => item.id === threadId)!
      const revision = this.detailRevision(thread)
      if (this.publishedDetail.get(threadId) === revision) continue
      const update = this.detailUpdate(thread, revision)
      if (update) for (const listener of this.detailListeners) listener(update)
    }
  }
  /** The delta from what this thread's window already holds, or the whole detail when no delta can say it. */
  private detailUpdate(thread: AgentThread, revision: number): AgentThreadDetailUpdate | null {
    const held = this.detailSnapshots.get(thread.id)
    if (held !== undefined) {
      const delta = diffAgentThreadDetail(held, { messages: thread.messages, activities: this.paneActivities(thread) }, revision)
      const advanced = delta === null ? null : applyAgentThreadDetailDelta(held, delta)
      if (delta !== null && advanced !== null) {
        this.detailSnapshots.set(thread.id, advanced)
        this.publishedDetail.set(thread.id, revision)
        return this.decorateDetailDelta(thread, delta)
      }
    }
    return this.wholeDetail(thread, revision)
  }
  /** A delta's whole messages carry the same preview markers a full detail's would; its appends carry text alone. */
  private decorateDetailDelta(thread: AgentThread, delta: AgentThreadDetailDelta): AgentThreadDetailDelta {
    const messageDeltas = delta.messageDeltas.map(item => 'appendText' in item ? item : { message: structuredClone(item.message) })
    const messages = messageDeltas.flatMap(item => 'appendText' in item ? [] : [item.message])
    if (messages.length > 0) this.attachmentPreviews.decorate({ ...this.state.host, threads: [{ ...thread, messages }] })
    return { ...delta, messageDeltas }
  }
  private say(text: string, preview = false): void {
    this.attentionNarration = null
    this.state.notice = text
    this.state.speech = { id: this.state.speech.id + 1, text, preview }
  }
  private updateCredentials(): void {
    const vault = this.dependencies.credentials
    this.state.credentials = { reasoning: vault.has('reasoning'), grokSpeech: vault.has('grokSpeech'), secure: vault.available() }
  }
  private async checkReasoning(provider: SubscriptionProvider): Promise<void> {
    const pending = this.accountChecks.get(provider)
    if (pending) return pending
    const check = (async () => {
      const account = await this.dependencies.reasoner.account?.(provider).catch(() => ({
        provider, label: provider, installed: false, ready: false, models: [],
        detail: 'Could not check this subscription. Open the provider app to check its sign-in, then check the connection in Sotto.',
      }))
      if (!this.disposed && account) this.state.reasoningAccounts = [...this.state.reasoningAccounts.filter(item => item.provider !== provider), account]
    })()
    this.accountChecks.set(provider, check)
    try { await check } finally { this.accountChecks.delete(provider) }
  }
  /**
   * What every connected client publishes, against what it is running. A provider that is not
   * connected has no known installed version, so nothing is claimed about it. Findings from an
   * update already run are kept, so "is now 2.1.278" survives the next check, until a newer
   * release is published: then the client is behind again and the old finding would hide it.
   */
  private async checkClientUpdates(fresh = false): Promise<void> {
    if (!this.state.configuration.checkClientUpdates) { delete this.state.clientUpdates; return }
    const previous = this.state.clientUpdates ?? []
    const readings: ProviderClientUpdate[] = []
    for (const provider of this.state.host.providers ?? []) {
      if (provider.connection !== 'connected') continue
      const installed = clientVersionOf(provider.version)
      if (!installed) continue
      const executable = await this.clientPath(provider.id)
      const reading = await this.clients.check(provider.id, installed, executable)
      // A client in the update line keeps where it stands there, even through a fresh check.
      const lined = this.inClientLine(provider.id)
      const before = fresh && !lined ? undefined : previous.find(item => item.id === provider.id)
      readings.push(before && (lined || (before.state !== 'idle' && outcomeHolds(before, reading))) ? withOutcome(reading, before) : reading)
    }
    if (this.disposed) return
    // The update line runs while this check waits on the registry and the disk: whatever it said about a client
    // meanwhile (its step, how it ended) is newer than what the check started from, and wins. How it ended gives way to
    // a newer release the check found, while waiting or running never does.
    const latest = this.state.clientUpdates ?? []
    for (const [index, reading] of readings.entries()) {
      const now = latest.find(item => item.id === reading.id)
      if (now && now !== previous.find(item => item.id === reading.id)
        && (now.state === 'queued' || now.state === 'updating' || reading.published === undefined || reading.published === now.published)) readings[index] = withOutcome(reading, now)
    }
    // A client that updated, failed or did not change still has something to say after its provider
    // drops: losing the record here would take the sentence about it off the card with it.
    for (const before of latest) {
      if (before.state !== 'idle' && !readings.some(item => item.id === before.id)) readings.push(before)
    }
    if (readings.length) this.state.clientUpdates = readings
    else delete this.state.clientUpdates
    if (fresh) delete this.state.clientUpdatesDismissedAt
    else if (this.state.clientUpdatesDismissedAt && readings.some(item => item.behind
      && !previous.some(before => before.id === item.id && before.published === item.published))) delete this.state.clientUpdatesDismissedAt
  }
  private clientPath(provider: ProviderId): Promise<string | undefined> {
    return (this.dependencies.locateClient ?? locateClientOnDisk)(provider)
  }
  /** Changes one client's reading. What the last run said (its step, failure and output) goes unless `patch` says it again. */
  private setClientUpdate(provider: ProviderId, patch: Partial<ProviderClientUpdate>, keepOutcome = true): void {
    this.state.clientUpdates = (this.state.clientUpdates ?? []).map(item => {
      if (item.id !== provider) return item
      const next = { ...item, ...patch }
      if (!keepOutcome) for (const key of ['error', 'step', 'failure', 'printed'] as const) if (!(key in patch)) delete next[key]
      return next
    })
  }
  private inClientLine(provider: ProviderId): boolean { return this.updatingClient === provider || this.clientLine.includes(provider) }
  /** Why a client cannot join the update line, or undefined when it can. */
  private clientUpdateRefusal(provider: ProviderId): string | undefined {
    const label = PROVIDER_LABELS[provider]
    if (this.inClientLine(provider)) return `${label} is already updating. Wait for it to finish.`
    const record = this.state.clientUpdates?.find(item => item.id === provider)
    if (!record) return `Sotto has not checked ${label} yet. Check again, then update it.`
    if (record.canInstall) return undefined
    return record.channel === 'devin-app' ? 'Devin updates with the Devin app.'
      : !record.behind ? `${label} is already at the published version.`
      : record.channel === 'mise' && record.command ? `Sotto could not find mise, so it did not update ${label}. Run ${record.command} yourself.`
      : record.command ? `Sotto did not install ${label}, so it will not replace it. Run ${record.command} yourself.`
      : `Sotto does not know how ${label} was installed, so it will not replace it.`
  }
  /**
   * Puts clients in this machine's update line, one at a time behind whatever is running, and answers at once. A client
   * that cannot join is left out; when none can, the first reason is the refusal. Each reading says how its update went,
   * and a failure does not stop the ones after it: Update all carries on with the rest (#480).
   */
  private queueClientUpdates(providers: readonly ProviderId[]): void {
    const refusals: string[] = []
    let added = 0
    for (const provider of new Set(providers)) {
      const refusal = this.clientUpdateRefusal(provider)
      if (refusal) { refusals.push(refusal); continue }
      this.clientLine.push(provider)
      const record = this.state.clientUpdates?.find(item => item.id === provider)
      if (record) this.clientLineBefore.set(provider, record)
      this.setClientUpdate(provider, { state: 'queued' }, false)
      added += 1
    }
    if (!added) throw new Error(refusals[0] ?? 'Nothing to update.')
    const run = this.state.clientUpdateRun
    this.setClientRun(Math.min(64, (run?.total ?? 0) + added), run?.done ?? 0)
    this.publish()
    if (!this.clientLineRunning) { this.clientLineRunning = true; void this.runClientLine() }
  }
  /** Takes clients still waiting out of the update line, as they were before. One already running is left to finish. */
  private cancelClientUpdates(providers: readonly ProviderId[]): void {
    let removed = 0
    for (const provider of new Set(providers)) {
      const at = this.clientLine.indexOf(provider)
      if (at < 0) continue
      this.clientLine.splice(at, 1)
      // Back as it was before it joined the line: behind, or with the failure it had, unless a newer release came out meanwhile.
      const before = this.clientLineBefore.get(provider)
      const record = this.state.clientUpdates?.find(item => item.id === provider)
      this.setClientUpdate(provider, before && record && outcomeHolds(before, record) ? outcomeOf(before) : { state: 'idle' }, false)
      this.clientLineBefore.delete(provider)
      const waiting = this.clientWaiters.get(provider) ?? []
      this.clientWaiters.delete(provider)
      for (const waiter of waiting) waiter.reject(new Error(`The ${PROVIDER_LABELS[provider]} update was cancelled before it started. Nothing was changed.`))
      removed += 1
    }
    if (!removed) {
      const running = providers.find(provider => provider === this.updatingClient)
      throw new Error(running ? `${PROVIDER_LABELS[running]} is already updating, so it cannot be cancelled. Your threads keep working.` : 'That update is not waiting any more. Nothing was changed.')
    }
    const run = this.state.clientUpdateRun
    if (run) this.setClientRun(Math.max(run.done + 1, run.total - removed), run.done)
  }
  /** The line's count, and the order its waiting clients will run in, which a waiting tile names. */
  private setClientRun(total: number, done: number): void {
    this.state.clientUpdateRun = { total, done: Math.min(total, done), ...(this.clientLine.length ? { line: [...this.clientLine] } : {}) }
  }
  /** The update line, one client at a time, until it is empty. Each ends by telling whoever waits for it. */
  private async runClientLine(): Promise<void> {
    while (!this.disposed) {
      const provider = this.clientLine.shift()
      if (!provider) break
      this.clientLineBefore.delete(provider)
      const started = this.state.clientUpdateRun
      if (started) this.setClientRun(started.total, started.done)
      let failure: unknown
      try { await this.updateOneClient(provider) } catch (error) { failure = error }
      const run = this.state.clientUpdateRun
      if (run) this.setClientRun(run.total, run.done + 1)
      const waiting = this.clientWaiters.get(provider) ?? []
      this.clientWaiters.delete(provider)
      for (const waiter of waiting) { if (failure === undefined) waiter.resolve(); else waiter.reject(failure) }
      if (!this.disposed) this.publish()
    }
    // Cleared in the same turn as the last look at the line, so a client queued from now on starts a new run.
    this.clientLineRunning = false
    delete this.state.clientUpdateRun
    if (!this.disposed) this.publish()
  }
  /** Update one client and wait for it, in the same line as every other update on this machine. */
  private async updateClient(provider: ProviderId): Promise<void> {
    const done = new Promise<void>((resolve, reject) => { this.clientWaiters.set(provider, [...this.clientWaiters.get(provider) ?? [], { resolve, reject }]) })
    try { this.queueClientUpdates([provider]) } catch (error) {
      const waiting = this.clientWaiters.get(provider)?.slice(0, -1) ?? []
      if (waiting.length) this.clientWaiters.set(provider, waiting); else this.clientWaiters.delete(provider)
      void done.catch(() => undefined)
      throw error
    }
    await done
  }
  /**
   * Replace one client while everything keeps running, the way T3 Code does (ADR-0042). The installer puts the
   * new client beside the one in use: Windows lets a running executable's folder be renamed, and every channel
   * Sotto drives does that or replaces the file for itself. Nothing disconnects and no turn is stopped. After a
   * good install each host is told, and moves each thread to the new client as it goes idle; a failed install
   * changes nothing, so there is nothing to put back.
   */
  private async updateOneClient(provider: ProviderId): Promise<void> {
    const label = PROVIDER_LABELS[provider]
    const record = this.state.clientUpdates?.find(item => item.id === provider)
    if (!record) throw new Error(`Sotto has not checked ${label} yet. Check again, then update it.`)
    this.updatingClient = provider
    this.setClientUpdate(provider, { state: 'updating', ...(record.steps && record.steps > 1 ? { step: 1 } : {}) }, false)
    this.publish()
    try {
      const result = await this.clients.install(provider, await this.clientPath(provider), process.env, step => {
        if (step > 1 && !this.disposed) { this.setClientUpdate(provider, { step }); this.publish() }
      })
      if (!result.ok) {
        this.setClientUpdate(provider, { state: 'failed', ranAt: new Date().toISOString(), ...(result.detail ? { error: result.detail } : {}),
          ...(result.step && record.steps && record.steps > 1 ? { step: result.step } : {}), ...(result.failure ? { failure: result.failure } : {}),
          ...(result.printed ? { printed: result.printed } : {}) }, false)
        throw new Error(result.failure === 'install-step'
          ? `mise installed ${label}${record.published ? ` ${record.published}` : ''}, but its install step did not finish${result.detail ? ` (${result.detail})` : ''}. Sotto still starts ${record.installed}, and your threads kept working.`
          : `${label} did not update${result.detail ? `. ${result.detail}` : '.'} Your installed version is unchanged, and your threads kept working.`)
      }
      // Each host finds the new client and reads its version. One that cannot says why, stays on the client it
      // has, and keeps its threads running; its sentence is the one the update reports.
      const told = await Promise.allSettled([this.dependencies.host.clientUpdated?.(provider), this.dependencies.clientUpdated?.(provider)])
      const refused = told.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      if (refused) this.dependencies.logFailure?.('client-update-handoff-failed', provider)
      const handoff = refused ? refused.reason instanceof Error && refused.reason.message ? refused.reason.message
        : `${label} was updated, but Sotto could not move to the new version. Threads that are working carry on and nothing was lost. Connect ${label} again to try the new version.` : undefined
      // The version the host now reads from disk, taken in before the check compares it.
      const snapshot = await this.dependencies.host.snapshot(provider).catch(() => undefined)
      if (snapshot && !this.disposed) this.acceptSnapshot(snapshot)
      const connected = this.state.host.providers?.some(item => item.id === provider && item.connection === 'connected') ?? false
      if (!connected) {
        // Nothing of this provider is running to read the version from; the next connection reads it.
        this.setClientUpdate(provider, { state: 'idle', ranAt: new Date().toISOString() }, false)
        this.say(`The installer finished. Connect ${label} to see the version it runs now.`)
        return
      }
      await this.checkClientUpdates()
      // The installer can finish and the client on disk still answer with the version it did before: a second
      // copy found first, or an install script npm did not run. Saying "updated" then would be a lie the user can
      // check, so the reading says what the client actually reports.
      const running = this.state.clientUpdates?.find(item => item.id === provider)?.installed
      const moved = running !== undefined && running !== record.installed
      this.setClientUpdate(provider, { state: moved ? 'updated' : 'unchanged', ranAt: new Date().toISOString(), ...(handoff ? { error: handoff } : {}) }, false)
      if (handoff) throw new Error(handoff)
      if (!moved) {
        throw new Error(`The installer finished, but ${label} still reports ${record.installed}. Nothing was lost and your threads kept working. ${record.command ? `Run ${record.command} in a terminal to see what the installer says.` : `Check how ${label} was installed, then try again.`}`)
      }
      // Threads still working finish on the client they have and move over when idle; that is true without
      // being said, so the notice says only what changed (the user's pick, ADR-0042).
      this.say(`${label} updated.`)
    } finally { this.updatingClient = null }
  }
  private observe(...threadIds: string[]): void {
    this.dependencies.host.observeThreads?.([...new Set([...this.state.assignments.map(a => a.threadId),
      ...(this.dependencies.observeActiveThread !== false && this.state.activeThreadId ? [this.state.activeThreadId] : []),
      ...this.viewedThreadIds.filter(id => this.state.host.threads.some(thread => thread.id === id)),
      ...this.followupStore.peek().items.map(item => item.threadId), ...this.outbox.flatMap(item => item.threadId ? [item.threadId] : []), ...threadIds])])
  }
  private thread(id: string | null): AgentThread {
    const thread = this.state.host.threads.find(t => t.id === id)
    if (!thread) throw new Error('Select an available thread first.')
    return thread
  }

  /** Main-only evidence for request drafts; no answer or question text is retained in receipts. */
  requestAnswerRecovery(threadId: string, provider: ProviderId): { uncertainRequestIds: string[]; completed: { requestId: string; questionsDigest: string; decisionId?: string }[] } {
    return {
      uncertainRequestIds: this.outbox.filter(item => item.type === 'answer' && item.threadId === threadId
        && (item.provider ?? this.state.configuration.provider) === provider).flatMap(item => item.requestId ? [item.requestId] : []),
      completed: this.answeredRequests.filter(item => item.threadId === threadId && item.provider === provider).map(({ requestId, questionsDigest, decisionId }) => ({ requestId, questionsDigest, ...(decisionId ? { decisionId } : {}) })),
    }
  }

  async refreshRequestDraft(threadId: string): Promise<void> {
    const thread = this.thread(threadId)
    if (!isThreadProviderConnected(this.state.host, thread)) throw new Error('Reconnect the original provider before checking this answer.')
    this.acceptSnapshot(await this.readThread(threadId, undefined, { retryUncertainAnswers: true }))
    const checked = this.thread(threadId)
    if (requestDraftProvider(this.state.host, checked, this.state.configuration.provider) === 'claude') {
      const retryable = new Set(checked.requests.filter(request => request.answerRetryReady).map(request => request.id))
      // This user check releases only the old answer reservation. It dispatches nothing;
      // Claude keeps its durable uncertain-answer evidence until the user chooses again.
      this.outbox = this.outbox.filter(item => item.type !== 'answer' || item.threadId !== threadId || !item.requestId || !retryable.has(item.requestId))
    }
    await this.persist()
    this.publish()
  }

  private recordAnsweredRequest(item: Saved['outbox'][number]): void {
    if (item.type !== 'answer' || !item.threadId || !item.requestId || !item.questionsDigest) return
    const receipt = { threadId: item.threadId, provider: item.provider ?? this.state.configuration.provider,
      requestId: item.requestId, questionsDigest: item.questionsDigest, decisionId: item.id }
    this.answeredRequests = [...this.answeredRequests.filter(previous => JSON.stringify(previous) !== JSON.stringify(receipt)), receipt].slice(-MAX_DELIVERED_DRAFTS)
  }
  private assignment(id: string): AgentAssignment {
    const assignment = this.state.assignments.find(a => a.threadId === id)
    if (!assignment) throw new Error('Assign this thread to Sotto first.')
    return assignment
  }
  /** `draftKept` is whether what the user was doing survives a refusal as a saved draft: true for a send, false for a create. */
  private canAct(threadId?: string, draftKept = true): void {
    if (this.disposed) throw new Error('Sotto is stopping. Your draft is saved.')
    // Nothing connected at all names the machine and the page that connects one (#459); one thread's provider
    // being down while others are connected is that thread's own refusal.
    if (!this.state.host.connected) throw new Error(noProviderRefusal(this.dependencies.runsAs === 'headless-host' ? 'host' : 'desktop', draftKept))
    if (threadId && !isThreadProviderConnected(this.state.host, this.thread(threadId))) throw new Error(`Reconnect this thread provider before sending.${draftKept ? ' Your draft is saved.' : ''}`)
  }
  private canCreate(provider?: ProviderId): void {
    this.canAct(undefined, false)
    if (this.outbox.some(item => (item.type === 'create-project' || item.type === 'create-thread') && (!provider || (item.provider ?? this.state.configuration.provider) === provider))) {
      throw new Error('An earlier creation has an unknown result. Reconnect and inspect the provider before creating anything else; select the existing project or thread if it appears.')
    }
  }
  /**
   * The effort, runtime mode and provider mode a create-thread ends up on: the caller's own choice where it made
   * one, Settings → Agents' new-thread defaults otherwise, each fit to what `model` actually offers (issue #347).
   * An install with no new-thread defaults saved leaves every option the caller left unset alone, which is
   * today's behaviour: the model's own default effort and the provider's own starting permission mode.
   */
  private newThreadOptionDefaults(command: Extract<AgentCommand, { type: 'create-thread' }>, model: AgentModel | undefined): { reasoningEffort?: string; runtimeMode?: AgentRuntimeMode; providerMode?: string } {
    const configuration = this.state.configuration
    let reasoningEffort = command.reasoningEffort
    if (reasoningEffort === undefined && configuration.newThreadReasoningEffort) {
      const reference = resolveModel(this.state.host.models, configuration.newThreadModelId)?.reasoningEfforts ?? model?.reasoningEfforts ?? []
      reasoningEffort = nearestReasoningEffort(configuration.newThreadReasoningEffort, reference, model?.reasoningEfforts ?? [])
    }
    let runtimeMode = command.runtimeMode
    let providerMode = command.providerMode
    if (runtimeMode === undefined && providerMode === undefined) {
      const resolved = resolveNewThreadPermission(model, configuration.newThreadRuntimeMode)
      runtimeMode = resolved.runtimeMode
      providerMode = resolved.providerMode
    }
    return { ...(reasoningEffort !== undefined ? { reasoningEffort } : {}), ...(runtimeMode !== undefined ? { runtimeMode } : {}), ...(providerMode !== undefined ? { providerMode } : {}) }
  }
  private putThreadDraft(draft: AgentThreadDraft): void {
    this.state.threadDrafts = (this.state.threadDrafts ?? []).filter(item => item.threadId !== draft.threadId)
    if (draft.text.length || draft.attachments.length) {
      this.emptyDraftRevisions.delete(draft.threadId)
      this.state.threadDrafts.push(structuredClone(draft))
    } else this.emptyDraftRevisions.set(draft.threadId, draft.draftId)
  }
  private syncLegacyDraft(): void {
    if (!this.state.draftThreadId) return
    if (!this.state.draft.length && !this.state.draftAttachments?.length) {
      this.state.threadDrafts = (this.state.threadDrafts ?? []).filter(item => item.threadId !== this.state.draftThreadId)
      return
    }
    const previous = this.state.threadDrafts?.find(item => item.threadId === this.state.draftThreadId)
    const attachments = this.state.draftAttachments ?? []
    if (this.manualDraftId && previous && previous.text === this.state.draft && previous.requestId === this.state.draftRequestId
      && JSON.stringify(previous.attachments) === JSON.stringify(attachments)) {
      this.manualDraftId = previous.draftId
      return
    }
    this.manualDraftId ??= randomUUID()
    this.putThreadDraft({ threadId: this.state.draftThreadId, draftId: this.manualDraftId, text: this.state.draft,
      attachments, skills: previous?.draftId === this.manualDraftId ? previous.skills : undefined, files: previous?.draftId === this.manualDraftId ? previous.files : undefined, requestId: this.state.draftRequestId, updatedAt: new Date().toISOString() })
  }
  private setDelivery(threadId: string, draftId: string, status: AgentDelivery['status'], patch: Partial<AgentDelivery> = {}): void {
    const previous = this.state.deliveries?.find(item => item.threadId === threadId && item.draftId === draftId)
    const now = new Date().toISOString()
    const delivery: AgentDelivery = { threadId, draftId, createdAt: previous?.createdAt ?? now, ...previous,
      ...patch, status: previous?.status === 'accepted' ? 'accepted' : status, updatedAt: now }
    const others = (this.state.deliveries ?? []).filter(item => item !== previous)
    const settled = [...others, delivery].filter(item => item.status === 'accepted' || item.status === 'failed').slice(-MAX_DELIVERED_DRAFTS)
    this.state.deliveries = [...others, delivery].filter(item => item.status !== 'accepted' && item.status !== 'failed' || settled.includes(item))
  }
  private async saveThreadDraft(command: Extract<AgentCommand, { type: 'save-thread-draft' }>): Promise<AgentState> {
    try {
      // An image no longer kept (a refused prompt restored after its hour, say) is left out, and the text saved.
      const attachments = (command.attachments ?? []).filter(handle => this.attachments.keeps(handle))
      const lostImage = attachments.length !== (command.attachments ?? []).length
      const draft = agentThreadDraftSchema.parse({ ...command, attachments,
        requestId: command.requestId ?? null, updatedAt: new Date().toISOString() })
      if (!this.state.threadDrafts?.some(item => item.threadId === draft.threadId)) this.thread(draft.threadId)
      if (this.state.followupReceipts?.some(item => item.threadId === draft.threadId && item.draftId === draft.draftId) || this.state.deliveredDrafts?.some(item => item.threadId === draft.threadId && item.draftId === draft.draftId)) return this.shell()
      const submitted = this.state.deliveries?.find(item => item.threadId === draft.threadId && item.draftId === draft.draftId)
      if (submitted && submitted.status !== 'failed') throw new Error('Use a new draft revision when editing a submitted prompt.')
      const previous = this.state.threadDrafts?.find(item => item.threadId === draft.threadId)
      const sameRevision = previous ? previous.draftId === draft.draftId && previous.text === draft.text && previous.requestId === draft.requestId
        && followupDigest(previous) === followupDigest(draft)
        : this.emptyDraftRevisions.get(draft.threadId) === draft.draftId && !draft.text.length && !draft.attachments.length
      if (command.composer === 'manual' && !sameRevision && this.state.assignments.some(item => item.threadId === draft.threadId && item.mode === 'managed')) {
        throw new Error('This draft now belongs to the managed composer. Your manual edit was not saved over it. Stop managing before saving that edit.')
      }
      if (previous?.requestId && previous.requestId !== draft.requestId && (draft.text.length || draft.attachments.length)) {
        throw new Error('Clear the existing answer before starting a different draft.')
      }
      this.putThreadDraft(draft)
      if (this.state.draftThreadId === draft.threadId) {
        this.state.draft = draft.text; this.state.draftAttachments = draft.attachments
        this.state.draftRequestId = draft.requestId; this.manualDraftId = draft.draftId
      }
      this.state.error = lostImage ? DRAFT_IMAGE_NOT_SAVED : null
      await this.persist().catch(() => { throw new Error('Could not save this thread draft. Keep your text and images and retry when storage is available.') })
    } catch (error) { this.setCommandError(error, error instanceof z.ZodError ? 'Choose valid draft text and images before saving.' : error instanceof Error ? error.message : 'Could not save this thread draft.') }
    this.publish()
    // Saving text needs exact revision/durability evidence, not a copy of every loaded history.
    // The desktop router discards those histories anyway; copying them here blocks native input.
    return this.shell()
  }
  private readonly skillReads = new Map<string, number>()
  private async refreshThreadSkills(threadId: string, forceReload = false): Promise<AgentState> {
    const revision = (this.skillReads.get(threadId) ?? 0) + 1
    this.skillReads.set(threadId, revision)
    try {
      const thread = this.thread(threadId)
      if (!isThreadProviderConnected(this.state.host, thread) || !capabilitiesForThread(this.state.host, thread).skills || !this.dependencies.host.listThreadSkills) throw new Error('Reconnect this thread provider to browse its native skills.')
      const catalog = await this.dependencies.host.listThreadSkills(threadId, forceReload)
      if (!this.disposed && this.skillReads.get(threadId) === revision) {
        this.state.skillCatalogs = [...(this.state.skillCatalogs ?? []).filter(item => item.threadId !== threadId), catalog]
      }
    } catch (error) {
      if (!this.disposed && this.skillReads.get(threadId) === revision) this.state.skillCatalogs = [
        ...(this.state.skillCatalogs ?? []).filter(item => item.threadId !== threadId),
        { threadId, providerId: this.state.host.threads.find(thread => thread.id === threadId)?.providerId ?? 'codex', cwd: '', status: 'error', skills: [], errors: [], error: error instanceof Error ? error.message : 'Skills could not be listed.' },
      ]
    }
    this.publish(); return this.shell()
  }
  /**
   * The thread's new name. It is a state edit alone: no native work is started, interrupted or queued
   * behind, so a thread can be renamed while its agent is still working.
   */
  /** T3's Git commands, answered in the host's words: a refusal is the notice, never a thrown error the window has to guess at. */
  private async gitCommand(command: GitCommand): Promise<AgentState> {
    const host = this.dependencies.host
    try {
      this.thread(command.threadId)
      switch (command.type) {
        case 'git-action': {
          if (!host.runGitAction) throw new Error('Git actions are unavailable.')
          this.acceptSnapshot(await host.runGitAction(command))
          const outcome = this.state.host.threads.find(thread => thread.id === command.threadId)?.gitAction
          if (outcome?.actionId === command.actionId && outcome.status === 'failed') this.state.error = outcome.error ?? 'The Git action failed.'
          else this.state.error = null
          break
        }
        case 'git-pull': {
          if (!host.pullThreadBranch) throw new Error('Pull is unavailable.')
          const { snapshot, result } = await host.pullThreadBranch(command.threadId)
          this.acceptSnapshot(snapshot)
          this.state.notice = result.status === 'pulled' ? `Pulled. Updated ${result.branch} from ${result.upstream ?? 'its upstream'}.` : `Already up to date. ${result.branch} matches ${result.upstream ?? 'its upstream'}.`
          this.state.error = null
          break
        }
        case 'git-switch-branch': {
          if (!host.switchThreadBranch) throw new Error('Switching branches is unavailable.')
          this.acceptSnapshot(await host.switchThreadBranch(command.threadId, command.ref, command.create === true))
          this.state.notice = command.create ? `Created and switched to ${command.ref}.` : `Switched to ${command.ref}.`
          this.state.error = null
          break
        }
        case 'git-init': {
          if (!host.initThreadRepository) throw new Error('Initializing Git is unavailable.')
          this.acceptSnapshot(await host.initThreadRepository(command.threadId))
          this.state.notice = 'Git initialized.'
          this.state.error = null
          break
        }
        case 'git-publish': {
          if (!host.publishThreadRepository) throw new Error('Publishing is unavailable.')
          const { snapshot, url } = await host.publishThreadRepository(command.threadId, { repository: command.repository, visibility: command.visibility })
          this.acceptSnapshot(snapshot)
          this.state.notice = `Repository published at ${url}.`
          this.state.error = null
          break
        }
        case 'git-pull-request-action': {
          if (!host.runPullRequestAction) throw new Error('Pull requests are unavailable.')
          const { snapshot, notice } = await host.runPullRequestAction({ threadId: command.threadId, url: command.url, action: command.action, method: command.method })
          this.acceptSnapshot(snapshot)
          this.state.notice = notice
          this.state.error = null
          break
        }
        case 'git-link-pull-request': {
          if (!host.linkThreadPullRequest) throw new Error('Linking pull requests is unavailable.')
          const { snapshot, link } = await host.linkThreadPullRequest(command.threadId, command.reference)
          this.acceptSnapshot(snapshot)
          this.state.notice = `Linked PR #${link.number}.`
          this.state.error = null
          break
        }
        case 'git-unlink-pull-request': {
          if (!host.unlinkThreadPullRequest) throw new Error('Linking pull requests is unavailable.')
          this.acceptSnapshot(await host.unlinkThreadPullRequest(command.threadId, command.url))
          this.state.notice = 'Unlinked the pull request from this thread.'
          this.state.error = null
          break
        }
        case 'git-checkout-pull-request': {
          if (!host.checkoutThreadPullRequest) throw new Error('Checking out pull requests is unavailable.')
          const { snapshot, notice } = await host.checkoutThreadPullRequest(command.threadId, command.reference, command.mode)
          this.acceptSnapshot(snapshot)
          this.state.notice = notice
          this.state.error = null
          break
        }
      }
    } catch (error) { this.setCommandError(error, error instanceof Error ? error.message : 'The Git command failed.') }
    this.publish()
    return this.shell()
  }
  private async renameThread(command: Extract<AgentCommand, { type: 'rename-thread' }>): Promise<AgentState> {
    const title = command.title.trim()
    try {
      const thread = this.thread(command.threadId)
      if (title === '') throw new Error('Type a name for this thread.')
      if (isThreadArchived(thread)) throw new Error('Archived threads keep the name they were archived under.')
      if (!this.dependencies.host.renameThread) throw new Error('Renaming a thread is unavailable.')
      if (title !== thread.title) this.acceptSnapshot(await this.dependencies.host.renameThread(command.threadId, title))
      this.state.error = null
      await this.persist().catch(() => { throw new Error('Could not save the new name. Retry when storage is available.') })
    } catch (error) { this.setCommandError(error, error instanceof Error ? error.message : 'Could not rename this thread.') }
    this.publish()
    return this.shell()
  }
  /**
   * A thread names itself once, from its first exchange. Only a thread still carrying a stand-in or
   * provider name is named, so a name typed in the New thread dialog or a later rename is left alone,
   * and a thread is only ever asked about once per run: a failure leaves the stand-in name rather than
   * asking again on the next provider frame.
   */
  private generateTitles(): void {
    if (!this.dependencies.writeThreadTitle || !this.dependencies.host.renameThread) return
    // Local history off means Sotto keeps no thread content; none of it is sent to name a thread either.
    if (this.dependencies.historyEnabled?.() === false) return
    for (const thread of this.state.host.threads) {
      if (this.titled.has(thread.id) || thread.titleSource === 'user' || thread.titleSource === 'generated') continue
      this.giveFirstMessageTitle(thread)
      // A client shows the first reply while its turn is still running and ends the turn on a later frame
      // that adds no message, so a running thread is not yet checked: checking it would record this count
      // and skip the frame that finishes the turn.
      if (thread.status === 'running') continue
      // A thread's history lives in the store, so read it only when this thread has said something new:
      // otherwise a thread that will never be named would be read on every provider frame.
      const messageCount = threadSummaryOf(thread).messageCount
      if (messageCount < 2 || this.titleChecked.get(thread.id) === messageCount) continue
      this.titleChecked.set(thread.id, messageCount)
      const exchange = firstExchange(thread, 'automatic', this.threadHistory(thread))
      if (!exchange) continue
      this.titled.add(thread.id)
      const pending = this.writeThreadTitle(thread.id, exchange)
      this.titleWrites.add(pending)
      void pending.finally(() => this.titleWrites.delete(pending)).catch(() => undefined)
    }
  }
  /**
   * A thread Sotto saw begin, empty and still on a `default` name, takes the opening words of its first message as
   * soon as that message is in, while the turn still runs. A thread that already had history when this run first
   * saw it, an older or imported one, keeps the name it has.
   */
  private giveFirstMessageTitle(thread: AgentThread): void {
    if (!this.dependencies.writeFirstMessageTitle || !carriesDefaultTitle(thread) || thread.titledFromFirstMessage) return
    if (threadSummaryOf(thread).messageCount === 0) { this.awaitingFirstMessage.add(thread.id); return }
    if (!this.awaitingFirstMessage.has(thread.id)) return
    // The first message, even when a steer is already beside it on the frame that brings it.
    const first = this.threadHistory(thread).find(message => message.role === 'user' && message.text.trim().length > 0)
    if (!first) return
    this.awaitingFirstMessage.delete(thread.id)
    const pending = this.offerTitle(thread.id, () => this.dependencies.writeFirstMessageTitle!(first.text), 'first-message')
    this.titleWrites.add(pending)
    void pending.finally(() => this.titleWrites.delete(pending)).catch(() => undefined)
  }
  /** A thread's whole history: what the pane holds when that is all of it, else the store's own copy. */
  private threadHistory(thread: AgentThread): readonly AgentMessage[] {
    if (thread.messages.length > 0 && thread.earlierAvailable !== true) return thread.messages
    return this.dependencies.host.threadMessages?.(thread.id) ?? thread.messages
  }
  /** Asks for the name and applies it, unless the thread was renamed by hand while the answer was in flight. */
  private writeThreadTitle(threadId: string, exchange: ThreadTitleExchange): Promise<void> {
    return this.offerTitle(threadId, () => this.dependencies.writeThreadTitle!(threadId, exchange), 'generated')
  }
  /**
   * Works out a name Sotto offers a thread and applies it, unless the thread was renamed by hand while it was
   * worked out. A first-message title also yields to a generated one that landed first.
   */
  private async offerTitle(threadId: string, write: () => Promise<string | null>, source: 'generated' | 'first-message'): Promise<void> {
    if (this.disposed) return
    try {
      const title = await write()
      if (this.disposed || title === null) return
      const thread = this.state.host.threads.find(item => item.id === threadId)
      if (!thread || thread.titleSource === 'user' || isThreadArchived(thread) || thread.title === title) return
      if (source === 'first-message' && (!carriesDefaultTitle(thread) || thread.titledFromFirstMessage)) return
      this.acceptSnapshot(await this.dependencies.host.renameThread!(threadId, title, source))
      await this.persist()
    } catch {
      // A name Sotto offered to write is never worth an error banner: the thread keeps the name it has.
      this.dependencies.logFailure?.('thread-title-failed', 'failed')
    }
  }
  /** Ask again for a thread's name, replacing a generated or stand-in one on explicit request. */
  private async regenerateThreadTitle(threadId: string): Promise<AgentState> {
    const thread = this.state.host.threads.find(item => item.id === threadId)
    // The same rule as automatic naming: with local history off, no thread content is sent to name it.
    const exchange = thread && this.dependencies.historyEnabled?.() !== false ? firstExchange(thread, 'requested', this.threadHistory(thread)) : null
    if (thread && exchange) {
      this.titled.add(thread.id)
      await this.writeThreadTitle(threadId, exchange)
    }
    this.publish()
    return this.shell()
  }
  /**
   * One client's command, answered with the whole state: every loaded history copied in, as `get()`
   * gives it. It is for a caller that reads histories from the answer. A client's command runs through
   * `commandShell`, which runs the same command without the copy.
   */
  command(command: AgentCommand, client: ClientIdentity = this.localClient): Promise<AgentState> {
    const reply = this.commandShell(command, client)
    let whole = this.sharedWholeStateReplies.get(reply)
    if (!whole) { whole = reply.then(shell => ({ ...this.get(), error: shell.error, ...(shell.worktreeReclaimPreview ? { worktreeReclaimPreview: shell.worktreeReclaimPreview } : {}) })); this.sharedWholeStateReplies.set(reply, whole) }
    return whole
  }
  /**
   * One client's command, answered with the shell. `client` says who sent it, for the record an answer
   * leaves and for the policy check that decides whether a remote client's answer counts as a grant.
   * Absent means the desktop window on this machine.
   *
   * No history rides on the answer: a window reads a thread's history through `threadDetail`, and
   * copying every history into an answer the window strips again held up main on every command,
   * a draft save included (issue #313).
   */
  commandShell(command: AgentCommand, client: ClientIdentity = this.localClient): Promise<AgentState> {
    if (this.disposed) return Promise.resolve({ ...this.shell(), error: 'Sotto is stopping. Restart it before sending another command.' })
    // A handle is the window's claim; the store is what it is checked against, before the command does anything.
    // A draft save is the exception: it keeps the text and drops what is gone (saveThreadDraft), so typing is never lost.
    try { if (command.type !== 'save-thread-draft') this.attachments.verify('attachments' in command ? command.attachments : undefined) }
    catch (error) {
      this.setCommandError(error, error instanceof Error ? error.message : this.attachments.missing)
      if ((command.type === 'manual-send' || command.type === 'steer' || command.type === 'queue-followup') && command.draftId) this.setDelivery(command.threadId, command.draftId, 'failed')
      this.publish()
      return Promise.resolve(this.shell())
    }
    const pending = this.commandWhileRunning(command, client)
    this.activeCommands.add(pending)
    void pending.then(() => this.activeCommands.delete(pending), () => this.activeCommands.delete(pending))
    return pending
  }
  private commandWhileRunning(command: AgentCommand, client: ClientIdentity): Promise<AgentState> {
    if (command.type !== 'manual-send' && command.type !== 'steer' && command.type !== 'queue-followup') return this.commandUnreserved(command, client)
    const prompt = structuredClone({ ...command, draftId: command.draftId ?? randomUUID() })
    const { threadId, draftId } = prompt
    const key = JSON.stringify([threadId, draftId])
    const digest = followupDigest(prompt)
    const pending = this.promptAdmissions.get(key)
    const queue = this.followupStore.get()
    const matches = (item: { threadId?: string | undefined; draftId?: string | undefined }): boolean => item.threadId === threadId && item.draftId === draftId
    const queued = queue.items.find(matches)
    const receipt = queue.receipts.find(matches)
    const delivered = this.state.deliveredDrafts?.some(matches)
    const outbox = this.outbox.find(matches)
    const ownedDigest = pending?.digest ?? receipt?.digest ?? (queued ? followupDigest(queued) : undefined)
      ?? this.deliveredPromptDigests.find(matches)?.digest ?? outbox?.draftDigest
    if (pending || queued || receipt || delivered || outbox) {
      if (ownedDigest !== digest) {
        this.state.error = 'This revision already belongs to a submitted prompt. Use a new draft revision for different content.'
        this.publish(); return Promise.resolve(this.shell())
      }
      if (pending) return pending.task
      if (queued || receipt || delivered || prompt.type === 'queue-followup') return Promise.resolve(this.shell())
      // An explicit retry of an uncertain manual send/steer only reconciles the outbox.
    }
    let resolve!: (state: AgentState) => void; let reject!: (error: unknown) => void
    const task = new Promise<AgentState>((done, fail) => { resolve = done; reject = fail })
    // Reserve before publishing feedback or starting any asynchronous persistence.
    this.promptAdmissions.set(key, { digest, task })
    try { this.commandUnreserved(prompt, client).then(resolve, reject) } catch (error) { reject(error) }
    void task.finally(() => this.promptAdmissions.delete(key)).catch(() => undefined)
    return task
  }
  private commandUnreserved(command: AgentCommand, client: ClientIdentity = this.localClient): Promise<AgentState> {
    if (this.retirementFailure) { this.state.error = this.retirementFailure; return Promise.resolve(this.shell()) }
    // Provider discovery has independent progress; a stalled account must not own the thread command lane.
    if ((command.type === 'connect' || command.type === 'disconnect' || command.type === 'refresh') && (command.provider || this.dependencies.host.concurrentProviders)) return this.providerCommand(command)
    // An install runs for as long as npm takes. It belongs on the provider lane with connect and
    // disconnect, never on the one global lane, which would lock every other surface while it ran.
    if (command.type === 'update-client' || command.type === 'queue-client-updates' || command.type === 'cancel-client-updates' || command.type === 'check-client-updates' || command.type === 'dismiss-client-updates') return this.providerCommand(command)
    if (command.type === 'refresh-thread-skills') return this.refreshThreadSkills(command.threadId, command.forceReload)
    if (command.type === 'preview-reclaim-thread-worktree') {
      const preview = this.dependencies.host.previewThreadWorktreeReclaim
      if (!preview) return Promise.resolve({ ...this.shell(), error: 'Checking this worktree is unavailable. Nothing was removed. Update this host and try again.' })
      return preview.call(this.dependencies.host, command.threadId).then(worktreeReclaimPreview => ({ ...this.shell(), error: null, worktreeReclaimPreview }),
        () => ({ ...this.shell(), error: 'The folder could not be checked. Nothing was removed. Check the host connection and try again.' }))
    }
    // Selection owns no action authority and must not wait for provider actions.
    if (command.type === 'select-thread') return this.navigate(command.threadId)
    if (command.type === 'observe-threads') {
      this.viewedThreadIds = [...new Set(command.threadIds)].filter(id => this.state.host.threads.some(thread => thread.id === id))
      this.observe()
      // A newly viewed thread needs its history now, not at the next provider frame.
      this.broadcastDetail()
      return Promise.resolve(this.shell())
    }
    if (command.type === 'save-thread-draft') return this.saveThreadDraft(command)
    // A Git action runs as long as its hooks and its push take, on the thread's own lane in the host, never on the global one.
    if (isGitCommand(command)) return this.gitCommand(command)
    // Renaming edits Sotto's own record of the thread, so it never waits on a running turn or any provider action.
    if (command.type === 'rename-thread') return this.renameThread(command)
    // Naming a thread is Sotto's own record too: the thread's provider is asked on the side, never inside the thread.
    if (command.type === 'regenerate-thread-title') return this.regenerateThreadTitle(command.threadId)
    if (command.type === 'queue-followup' || command.type === 'edit-followup' || command.type === 'remove-followup' || command.type === 'reorder-followups' || command.type === 'resume-followups') return this.followupCommand(command)
    // A create-thread carries the ID the window minted, which no lane can be keyed on until the thread exists.
    const actionThreadId = 'threadId' in command && command.type !== 'create-thread' ? command.threadId : ''
    const actionDraftId = 'draftId' in command ? command.draftId : undefined
    const reconcilingDraft = command.type === 'manual-send' && this.outbox.some(item => item.threadId === actionThreadId && item.draftId === actionDraftId)
    if (command.type === 'manual-send' && !reconcilingDraft && (this.threadPrompts.has(actionThreadId) || this.pumping.has(actionThreadId) || this.state.host.threads.find(t => t.id === actionThreadId)?.status === 'running' || this.followupStore.get().items.some(item => item.threadId === actionThreadId))) {
      return this.followupCommand({ ...command, type: 'queue-followup', draftId: command.draftId ?? randomUUID() })
    }
    if (command.type === 'interrupt') return this.interruptThread(command)
    const receivedAt = performance.now()
    let admission: Promise<Error | undefined> | undefined
    if ((command.type === 'manual-send' || command.type === 'steer')) {
      command = { ...command, draftId: command.draftId ?? randomUUID() }
      const { threadId } = command
      if (!this.outbox.some(item => item.threadId === threadId)) {
        const current = this.state.threadDrafts?.find(item => item.threadId === threadId)
        // An explicit answer retains its owner and request; manual prompt validation will reject it.
        if (!current?.requestId) {
          this.putThreadDraft({ threadId: command.threadId, draftId: command.draftId!, text: command.text,
            attachments: command.attachments ?? [], skills: command.skills, files: command.files, requestId: null, updatedAt: new Date().toISOString() })
          if (this.state.draftThreadId === command.threadId && !this.state.draftRequestId) {
            this.state.draft = command.text; this.state.draftAttachments = command.attachments ?? []; this.manualDraftId = command.draftId!
          }
        }
        this.setDelivery(command.threadId, command.draftId!, 'queued')
        this.publish({ receivedAt, threadId: command.threadId, draftId: command.draftId! })
        // Catch immediately even if the existing command lane is blocked for a long time.
        admission = this.persist().then(() => undefined, () => new Error('Could not save this prompt. No new prompt was sent.'))
      }
    }
    const selectionRevision = this.selectionRevision
    const manualRetryId = (command.type === 'manual-send' || command.type === 'steer') ? this.outbox.find(item => item.threadId === command.threadId)?.id
      : command.type === 'send' ? this.outbox.find(item => item.threadId === this.state.draftThreadId)?.id : undefined
    if (command.type === 'configure' && typeof command.patch.speak === 'boolean' && Object.keys(command.patch).length === 1) {
      this.state.configuration.speak = command.patch.speak
      this.speechPreferenceRevision += 1
      if (!command.patch.speak) { this.state.voice.action = 'stop-speaking'; this.state.voice.revision += 1 }
      this.publish()
      return this.persist().then(() => this.shell(), () => {
        this.state.error = 'Could not save the spoken reply setting. Retry when storage is available.'
        this.publish(); return this.shell()
      })
    }
    if (command.type === 'voice-state') {
      this.state.voice.status = command.status; this.state.voice.error = command.error; this.publish()
      return Promise.resolve(this.shell())
    }
    if (command.type === 'voice') {
      this.state.voice.action = command.action; this.state.voice.revision += 1; this.publish()
      return Promise.resolve(this.shell())
    }
    // Host observations bypass this lane: a direct provider send must revoke authority even during model reasoning.
    const laneThreadId = actionThreadId && THREAD_SCOPED_COMMAND_TYPES.has(command.type) ? actionThreadId : ''
    const independent = laneThreadId !== ''
    let releaseThread = (): void => {}
    const task = (independent ? this.threadActions.get(laneThreadId) ?? Promise.resolve() : this.serial).catch(() => undefined).then(async () => {
      if (independent) releaseThread = this.mark(this.busyThreads, laneThreadId)
      else this.state.globalLaneBusy = true
      this.state.error = null
      this.publish()
      const turn = RECORDED_COMMAND_TYPES.has(command.type)
        ? this.beginTurn({
          source: command.type === 'utterance' ? 'utterance' : 'command',
          commandType: command.type,
          ...(command.type === 'utterance' && command.voiceTiming ? { voiceTiming: command.voiceTiming } : {}),
          text: command.type === 'utterance' ? command.text
            : (command.type === 'manual-send' || command.type === 'steer') ? command.text : command.type === 'send' ? this.state.draft : command.type === 'answer' ? command.answer : '',
        }) : undefined
      let failure: string | undefined
      let unconfirmedAnswer: AnswerDeliveryUnconfirmed | undefined
      try {
        const admissionError = admission ? await admission : undefined
        if (admissionError instanceof Error) throw admissionError
        await this.execute(command, turn, manualRetryId, selectionRevision, client)
      } catch (error) {
        if (error instanceof AnswerDeliveryUnconfirmed) unconfirmedAnswer = error
        failure = error instanceof AnswerDeliveryUnconfirmed && error.delivered ? undefined
          : error instanceof CheckoutSendRefusal && (command.type === 'manual-send' || command.type === 'steer' || command.type === 'send') ? error.draftMessage()
          : error instanceof Error ? error.message : 'Sotto could not complete this action.'
        if (!(error instanceof AnswerDeliveryUnconfirmed)) this.setCommandError(error, failure!)
        if (failure !== undefined && !(error instanceof AnswerDeliveryUnconfirmed && client.transport === 'socket')) this.say(failure)
      }
      if ((command.type === 'manual-send' || command.type === 'steer') && command.draftId) {
        const delivery = this.state.deliveries?.find(item => item.threadId === command.threadId && item.draftId === command.draftId)
        if (delivery && delivery.status !== 'accepted') {
          this.setDelivery(command.threadId, command.draftId, this.outbox.some(item => item.threadId === command.threadId && item.draftId === command.draftId) ? 'uncertain' : 'failed')
        }
      }
      if (independent) releaseThread()
      else this.state.globalLaneBusy = false
      this.updateCredentials()
      await this.persist().catch(error => {
        // The user sees fixed guidance; diagnostics keep only the storage failure category.
        if (turn) turn.failureCode = 'storage-failed'
        unconfirmedAnswer = undefined
        failure = error instanceof Error ? error.message : 'Could not save agent state.'
        this.state.error = 'Could not save agent state. Pause management until storage is available.'
        this.state.assignments.forEach(a => { a.paused = true })
      })
      if (turn) {
        if (turn.threadId === undefined) turn.threadId = this.state.activeThreadId
        if (turn.projectId === undefined) turn.projectId = this.state.activeProjectId
      }
      this.publish()
      if (turn) turn.firstFeedbackAtMs ??= Date.now()
      await this.finishTurn(turn, unconfirmedAnswer?.delivered ? undefined : failure)
      // Completion can settle during persistence or diagnostics, after the catch observed uncertainty.
      if (unconfirmedAnswer?.delivered) failure = undefined
      // Socket replies and receipts keep the command's outcome, including Send answering a question draft.
      // Keep the published shell and desktop response as they are.
      return (command.type === 'answer' || command.type === 'send') && client.transport === 'socket'
        ? { ...this.shell(), error: failure ?? null } : this.shell()
    })
    if (independent) {
      this.threadActions.set(laneThreadId, task)
      const releasePrompt = command.type === 'manual-send' || command.type === 'steer' || command.type === 'steer-followup' ? this.mark(this.threadPrompts, laneThreadId) : (): void => {}
      void task.finally(() => {
        releasePrompt(); releaseThread()
        if (this.threadActions.get(laneThreadId) === task) this.threadActions.delete(laneThreadId)
        this.pumpFollowups()
      }).catch(() => undefined)
    } else this.serial = task.catch(() => undefined)
    return task
  }
  private syncFollowups(): void {
    const { items, receipts } = this.followupStore.get()
    this.state.followups = items; this.state.followupReceipts = receipts.map(({ threadId, draftId }) => ({ threadId, draftId }))
    // A crash between the two stores leaves both copies. Durable queue ownership wins
    // only for the submitted revision; newer draft revisions are never touched.
    const owned = [...receipts, ...items]
    this.state.deliveries = (this.state.deliveries ?? []).filter(d => d.status !== 'queued' || !owned.some(r => r.threadId === d.threadId && r.draftId === d.draftId))
    this.state.threadDrafts = (this.state.threadDrafts ?? []).filter(draft => !owned.some(r => r.threadId === draft.threadId && r.draftId === draft.draftId))
    if (owned.some(r => r.threadId === this.state.draftThreadId && r.draftId === this.manualDraftId)) {
      this.state.draft = ''; this.state.draftAttachments = []; this.state.draftThreadId = null
      this.state.draftRequestId = null; this.manualDraftId = null; this.state.composing = false
    }
  }
  private manualHandoff(threadId: string): void {
    const assignment = this.state.assignments.find(a => a.threadId === threadId)
    if (assignment) { assignment.mode = 'manual'; assignment.stopReason = 'none'; assignment.stoppedAt = '' }
  }
  private async followupCommand(command: Extract<AgentCommand, { type: 'queue-followup' | 'edit-followup' | 'remove-followup' | 'reorder-followups' | 'resume-followups' }>): Promise<AgentState> {
    try {
      const thread = this.thread(command.threadId)
      this.state.error = null
      if (command.type === 'queue-followup' || command.type === 'edit-followup') {
        const existing = command.type === 'edit-followup' ? this.followupStore.get().items.find(item => item.threadId === thread.id && item.id === command.itemId) : undefined
        if (!command.text.trim() && !(command.attachments ?? existing?.attachments)?.length) throw new Error('There is no prompt to queue.')
        if (command.type === 'queue-followup') {
          if (thread.archivedAt) throw new Error('This thread is archived. Reopen it before queuing a prompt.')
          if (this.state.threadDrafts?.find(d => d.threadId === thread.id)?.requestId) throw new Error('Send or clear the existing answer before queuing a prompt.')
          this.manualHandoff(thread.id)
          const receivedAt = performance.now()
          this.setDelivery(thread.id, command.draftId, 'queued')
          this.publish({ receivedAt, threadId: thread.id, draftId: command.draftId })
          await this.followupStore.enqueue({ threadId: thread.id, draftId: command.draftId, text: command.text,
            attachments: command.attachments ?? [], skills: command.skills, files: command.files, ...(thread.status === 'idle' && !thread.requests.length ? { resumeAfterTurnId: thread.lastTurn?.id ?? 'unknown' } : {}) })
        } else {
          await this.followupStore.edit(thread.id, command.itemId, { text: command.text, attachments: command.attachments ?? existing?.attachments ?? [], skills: command.skills ?? existing?.skills, files: command.files ?? existing?.files })
        }
      } else if (command.type === 'remove-followup') await this.followupStore.edit(thread.id, command.itemId)
      else if (command.type === 'reorder-followups') await this.followupStore.reorder(thread.id, command.itemIds)
      else {
        this.canAct(thread.id)
        if (isThreadClosed(thread) || isWorkspaceThreadSettled(thread, this.state.host.projects.find(p => p.id === thread.projectId))) throw new Error('Restore this thread and project before resuming queued follow-ups.')
        this.manualHandoff(thread.id); await this.followupStore.resume(thread.id, thread.lastTurn?.id ?? 'unknown')
      }
      this.syncFollowups(); this.observe(); await this.persist()
    } catch (error) {
      this.setCommandError(error, error instanceof Error ? error.message : 'Could not save the follow-up queue.')
      if (command.type === 'queue-followup' && !this.followupStore.get().receipts.some(r => r.threadId === command.threadId && r.draftId === command.draftId)) this.setDelivery(command.threadId, command.draftId, 'failed')
    }
    this.publish(); this.pumpFollowups(); return this.shell()
  }
  private followupReady(threadId: string, ownCommandId?: string): boolean {
    const thread = this.state.host.threads.find(t => t.id === threadId)
    const reviewed = thread && this.followupStore.peek().items.find(i => i.threadId === threadId)?.resumeAfterTurnId === (thread.lastTurn?.id ?? 'unknown')
    return Boolean(thread && isThreadProviderConnected(this.state.host, thread) && (thread.status === 'idle' || thread.status === 'error' && reviewed)
      && thread.lastTurn?.status !== 'running'
      && (thread.nativeSessionStarted === false || thread.lastTurn?.status === 'completed' || reviewed) && !thread.requests.length
      && (!thread.historyStatus || thread.historyStatus === 'ready') && !isThreadClosed(thread)
      && !isWorkspaceThreadSettled(thread, this.state.host.projects.find(p => p.id === thread.projectId))
      && !this.state.assignments.some(a => a.threadId === threadId && a.mode === 'managed')
      && !this.outbox.some(item => item.threadId === threadId && item.id !== ownCommandId))
  }
  private pumpFollowups(): void {
    if (this.disposed) return
    // Read, not copied: this runs for every host snapshot. `first` below may be held across the dispatch
    // awaits, which is safe because the store replaces its state rather than editing it.
    const items = this.followupStore.peek().items
    for (const threadId of new Set(items.map(item => item.threadId))) {
      // A queued follow-up waits on a prompt of its own thread, as before, not on the thread's other work.
      if (this.pumping.has(threadId) || this.threadPrompts.has(threadId)) continue
      const thread = this.state.host.threads.find(t => t.id === threadId)
      // A steer may have selected any queue item. Reconcile its late echo before the queue head.
      const first = items.find(item => item.threadId === threadId && item.messageId && thread?.messages.some(message => message.role === 'user' && message.id === item.messageId))
        ?? items.find(item => item.threadId === threadId)!
      // Native idle status can precede turn/completed. A still-running outcome is
      // neither permission to dispatch nor a terminal failure requiring review.
      const terminalBlocked = thread && thread.status !== 'running' && thread.lastTurn?.status !== 'running'
        && (thread.lastTurn ? thread.lastTurn.status !== 'completed' && first.resumeAfterTurnId !== thread.lastTurn.id : first.resumeAfterTurnId !== 'unknown')
      if (first.status === 'queued' && terminalBlocked) {
        this.pumping.add(threadId)
        let paused = false
        void this.followupStore.pause(threadId, 'The last turn did not confirm completion. Review the thread and resume queued follow-ups when ready.')
          .then(() => { paused = true })
          .catch(() => { this.state.error = 'Could not pause the follow-up queue.' })
          .finally(() => { this.syncFollowups(); this.publish(); this.pumping.delete(threadId); if (paused) this.pumpFollowups() })
        continue
      }
      const confirmed = first.messageId && thread?.messages.some(m => m.role === 'user' && m.id === first.messageId)
      if (!confirmed && (first.status !== 'queued' || !this.followupReady(threadId))) continue
      this.pumping.add(threadId)
      void (async () => {
        if (confirmed) { await this.followupStore.settle(first.id, 'accepted'); return }
        let claimed = false
        const turn = this.beginTurn({ source: 'command', commandType: 'manual-send', text: first.text })
        let failure: string | undefined
        try {
          this.canAct(threadId)
          await this.followupStore.claim(first.id); claimed = true
          this.syncFollowups(); this.publish()
          const item = this.followupStore.get().items.find(item => item.id === first.id)!
          const validate = (): void => {
            if (this.disposed || !this.followupReady(threadId, item.commandId)) throw new Error('The thread is no longer ready. Review it and explicitly resume queued follow-ups.')
            const latest = this.thread(threadId)
            if (latest.status === 'running' || latest.requests.length || isThreadClosed(latest)
              || isWorkspaceThreadSettled(latest, this.state.host.projects.find(p => p.id === latest.projectId))
              || this.state.assignments.some(a => a.threadId === threadId && a.mode === 'managed')) throw new Error('The thread changed before dispatch. Review it and resume the queue.')
            this.canAct(threadId)
            validatePromptAttachments(this.state.host, latest.modelId, item.attachments)
          }
          validate()
          if (turn) { turn.threadId = threadId; turn.projectId = this.thread(threadId).projectId }
          await this.dispatch({ type: 'send', commandId: item.commandId!, threadId, messageId: item.messageId!, text: item.text.trim(), attachments: item.attachments, ...(item.skills ? { skills: item.skills } : {}), ...(item.files ? { files: item.files } : {}),
            expectedLastUserMessageId: lastUserMessageIdOf(this.thread(threadId)) }, turn, validate, item.draftId)
          await this.followupStore.settle(item.id, 'accepted')
        } catch (error) {
          failure = error instanceof CheckoutSendRefusal ? error.queuedMessage() : error instanceof Error ? error.message : 'Could not dispatch this follow-up.'
          if (claimed) {
            const item = this.followupStore.get().items.find(i => i.id === first.id)
            const accepted = item?.messageId && this.thread(threadId).messages.some(m => m.role === 'user' && m.id === item.messageId)
            await this.followupStore.settle(first.id, accepted ? 'accepted' : this.outbox.some(o => o.id === item?.commandId) ? 'uncertain' : 'failed', failure)
          }
        } finally { await this.finishTurn(turn, failure) }
      })().catch(() => { this.state.error = 'Could not save follow-up delivery state. Refresh before making changes.' })
        .finally(() => { this.syncFollowups(); this.publish(); this.pumping.delete(threadId); if (this.followupStore.peek().items.find(i => i.threadId === threadId)?.id !== first.id) this.pumpFollowups() })
    }
  }
  private async interruptThread(command: Extract<AgentCommand, { type: 'interrupt' }>): Promise<AgentState> {
    const turn = this.beginTurn({ source: 'command', commandType: 'interrupt', text: '', threadId: command.threadId,
      projectId: this.state.host.threads.find(thread => thread.id === command.threadId)?.projectId ?? null })
    let failure: string | undefined
    const assignment = this.state.assignments.find(item => item.threadId === command.threadId)
    const wasPaused = assignment?.paused
    // Stopping a turn waits for nothing, not even that thread's own lane, but the thread is working on it.
    const release = this.mark(this.busyThreads, command.threadId)
    try {
      this.setCommandError(undefined, null)
      this.publish()
      this.validateInterrupt(command.threadId)
      if (assignment) assignment.paused = true
      let pauseFailure: string | undefined
      try { await this.followupStore.pause(command.threadId, 'The turn was interrupted. Review the thread and resume queued follow-ups when ready.') }
      catch { pauseFailure = 'Stop was sent, but the queue pause could not be saved. Your queued messages are still saved. Check them before sending another message.' }
      this.syncFollowups(); await this.execute(command, turn); await this.persist()
      if (pauseFailure) this.setCommandError(undefined, pauseFailure)
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Could not interrupt this thread.'
      if (error instanceof RefusedInterrupt && assignment && wasPaused !== undefined && assignment.paused !== wasPaused) {
        assignment.paused = wasPaused
        try { await this.persist() }
        catch { failure = 'Stop was refused, and the previous management state could not be saved. Refresh before resuming management.' }
      }
      this.setCommandError(error, failure)
    }
    release()
    this.publish(); await this.finishTurn(turn, failure); return this.shell()
  }
  private validateInterrupt(threadId: string): void {
    try {
      this.canAct(undefined, false)
      const thread = this.thread(threadId)
      if (!capabilitiesForThread(this.state.host, thread).interrupt) throw new Error('This connection cannot stop agent work.')
      if (isThreadClosed(thread)) throw new Error('This thread is settled or archived. There is no open work to stop.')
    } catch (error) { throw new RefusedInterrupt(error instanceof Error ? error.message : 'Could not interrupt this thread.') }
  }
  private async steerFollowup(command: Extract<AgentCommand, { type: 'steer-followup' }>, turn?: ActiveTurn): Promise<void> {
    const queued = this.followupStore.get().items.find(item => item.threadId === command.threadId && item.id === command.itemId)
    if (!queued) return // Already delivered or removed; a repeated click never creates another prompt.
    const validate = (): void => {
      this.canAct(command.threadId)
      const thread = this.thread(command.threadId)
      if (!capabilitiesForThread(this.state.host, thread).steer) throw new Error('This provider does not support native steering. Leave the message queued instead.')
      if (thread.status !== 'running') throw new Error('There is no running turn to steer. The message is still queued.')
      if (thread.requests.length) throw new Error('Answer the pending question or permission explicitly before steering.')
      if (isThreadClosed(thread) || isWorkspaceThreadSettled(thread, this.state.host.projects.find(p => p.id === thread.projectId))) throw new Error('Restore this thread and project before steering.')
    }
    validate()
    if (this.outbox.some(item => item.threadId === command.threadId) || this.pumping.has(command.threadId)) throw new Error('Wait for the pending delivery before steering this message.')
    await this.followupStore.claim(queued.id, 'steer')
    this.syncFollowups(); this.publish()
    const item = this.followupStore.get().items.find(item => item.id === queued.id)!
    try {
      const validatePrompt = (): void => {
        validate()
        validatePromptAttachments(this.state.host, this.thread(command.threadId).modelId, item.attachments)
      }
      validatePrompt(); this.manualHandoff(command.threadId)
      if (turn) { turn.threadId = command.threadId; turn.projectId = this.thread(command.threadId).projectId }
      await this.dispatch({ type: 'steer', threadId: item.threadId, commandId: item.commandId!, messageId: item.messageId!,
        text: item.text.trim(), attachments: item.attachments, ...(item.skills ? { skills: item.skills } : {}), ...(item.files ? { files: item.files } : {}),
        expectedLastUserMessageId: lastUserMessageIdOf(this.thread(item.threadId)) }, turn, validatePrompt, item.draftId)
      await this.followupStore.settle(item.id, 'accepted')
    } catch (error) {
      const accepted = this.thread(item.threadId).messages.some(message => message.role === 'user' && message.id === item.messageId)
      await this.followupStore.settle(item.id, accepted ? 'accepted' : this.outbox.some(entry => entry.id === item.commandId) ? 'uncertain' : 'failed',
        error instanceof Error ? error.message : 'Could not steer this message.')
      throw error
    } finally { this.syncFollowups(); this.publish() }
  }
  private async steer(command: Extract<AgentCommand, { type: 'steer' }>, turn?: ActiveTurn): Promise<void> {
    if (this.state.deliveredDrafts?.some(r => r.threadId === command.threadId && r.draftId === command.draftId)) return
    if (this.outbox.some(item => item.threadId === command.threadId)) {
      this.acceptSnapshot(await this.readThread(command.threadId))
      if (this.outbox.some(item => item.threadId === command.threadId)) throw new Error('An earlier action is uncertain. Refresh to reconcile it; it will not be replayed.')
      return
    }
    const validate = (): void => {
      this.canAct(command.threadId)
      const thread = this.thread(command.threadId)
      if (!capabilitiesForThread(this.state.host, thread).steer) throw new Error('This provider does not support native steering. Queue a follow-up instead.')
      if (thread.status !== 'running') throw new Error('There is no running turn to steer. Send or queue this prompt instead.')
      if (thread.requests.length) throw new Error('Answer the pending question or permission explicitly before steering.')
      if (thread.archivedAt) throw new Error('This thread is archived. Reopen it before steering.')
      if (!command.text.trim() && !command.attachments?.length) throw new Error('There is no prompt to steer with.')
      validatePromptAttachments(this.state.host, thread.modelId, command.attachments)
    }
    validate(); this.manualHandoff(command.threadId)
    if (turn) { turn.threadId = command.threadId; turn.projectId = this.thread(command.threadId).projectId }
    await this.dispatch({ type: 'steer', threadId: command.threadId, commandId: randomUUID(), messageId: randomUUID(), text: command.text.trim(),
      ...(command.attachments ? { attachments: command.attachments } : {}), ...(command.skills ? { skills: command.skills } : {}), ...(command.files ? { files: command.files } : {}),
      expectedLastUserMessageId: lastUserMessageIdOf(this.thread(command.threadId)) }, turn, validate, command.draftId)
    this.say(`Steered ${this.thread(command.threadId).title}.`)
  }
  private async providerCommand(command: Extract<AgentCommand, { type: 'connect' | 'disconnect' | 'refresh' | 'update-client' | 'queue-client-updates' | 'cancel-client-updates' | 'check-client-updates' | 'dismiss-client-updates' }>): Promise<AgentState> {
    const turn = this.beginTurn({ source: 'command', commandType: command.type, text: '' })
    let failure: string | undefined
    try { this.state.error = null; await this.execute(command, turn); await this.persist() }
    catch (error) { failure = error instanceof Error ? error.message : 'Provider action failed.'; this.setCommandError(error, failure) }
    await this.finishTurn(turn, failure); this.publish()
    // Provider commands overlap, so each answers with its own outcome and not a refusal another one met meanwhile.
    const state = this.shell()
    return failure === undefined ? { ...state, error: null } : state
  }
  private beginTurn(input: Parameters<TurnRecorder['begin']>[0]): ActiveTurn | undefined {
    try { return this.dependencies.turns?.begin(input) } catch { return undefined }
  }
  private async finishTurn(turn: ActiveTurn | undefined, error?: string): Promise<void> {
    if (!turn) return
    try {
      await this.dependencies.turns?.finish(turn, error !== undefined ? 'failed' : turn.clarified ? 'clarified' : 'completed')
    } catch { /* recording must never throw into the command path */ }
  }
  private async navigate(threadId: string): Promise<AgentState> {
    const turn = this.beginTurn({ source: 'command', commandType: 'select-thread', text: '' })
    let failure: string | undefined
    try {
      const thread = this.thread(threadId)
      if (turn) { turn.threadId = thread.id; turn.projectId = thread.projectId }
      this.selectionRevision += 1
      this.selectThread(threadId, this.selectionRevision)
      this.state.error = null
      this.publish()
      await this.persist()
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Could not select this thread.'
      this.setCommandError(error, failure)
      this.publish()
    }
    await this.finishTurn(turn, failure)
    return this.shell()
  }
  private selectThread(threadId: string, revision: number): void {
    if (revision !== this.selectionRevision) return
    const thread = this.thread(threadId)
    this.coordinatorConversation = false
    this.state.activeThreadId = thread.id; this.state.activeProjectId = thread.projectId
    const waiting = this.state.queue.find(q => q.threadId === thread.id)
    this.presentedQueueId = waiting?.id ?? null
    this.queueSelectionPinned = true
    if (waiting && !this.state.composing) this.narrateAttention(waiting)
    this.observe()
    this.state.pendingRequest = ''
  }
  private async execute(command: AgentCommand, turn?: ActiveTurn, manualRetryId?: string, selectionRevision = this.selectionRevision,
    client: ClientIdentity = this.localClient): Promise<void> {
    if (this.disposed) throw new Error('Sotto is stopping. Your draft is saved.')
    if (client.transport === 'socket' && ['compose', 'send', 'cancel-draft', 'pause-draft', 'cancel-request'].includes(command.type)) {
      const thread = this.thread(client.selectedThreadId ?? null)
      const saved = this.state.threadDrafts?.find(draft => draft.threadId === thread.id)
      if (command.type === 'compose') {
        const requestId = saved ? saved.requestId : this.state.queue.find(item => item.threadId === thread.id && item.kind === 'question')?.requestId ?? null
        if (requestId) this.guardClientGrant(client)
        await this.saveThreadDraft({ type: 'save-thread-draft', threadId: thread.id, draftId: randomUUID(), text: command.text,
          attachments: command.attachments ?? saved?.attachments ?? [], skills: saved?.skills, files: saved?.files, requestId })
      } else if (command.type === 'send') {
        await this.sendDraft(turn, undefined, selectionRevision, client, thread.id)
      } else if (command.type === 'cancel-draft') {
        if (this.state.draftThreadId === thread.id) this.clearDraft()
        else this.state.threadDrafts = (this.state.threadDrafts ?? []).filter(draft => draft.threadId !== thread.id)
      } else if (command.type === 'pause-draft' && this.state.draftThreadId === thread.id) {
        this.syncLegacyDraft()
        this.manualDraftId = null; this.state.draft = ''; this.state.draftAttachments = []
        this.state.draftThreadId = null; this.state.draftRequestId = null; this.state.composing = false
      } else if (command.type === 'cancel-request' && this.state.activeThreadId === thread.id) this.state.pendingRequest = ''
      return
    }
    // Explicit targets survive host observations and queue-driven selection changes.
    if (turn && 'threadId' in command) {
      turn.threadId = command.threadId
      turn.projectId = this.state.host.threads.find(thread => thread.id === command.threadId)?.projectId ?? null
    } else if (turn && 'projectId' in command) {
      turn.threadId = null
      turn.projectId = command.projectId
    }
    if (['utterance', 'compose', 'assign', 'send', 'manual-send', 'answer'].includes(command.type)) this.contextActivityAt = Date.now()
    switch (command.type) {
      case 'preview-voice': this.say('Hi, I’m Sotto. Your agents are ready when you are.', true); return
      case 'cancel-request': this.state.pendingRequest = ''; this.say('Pending request cleared.'); return
      case 'voice': this.state.voice.action = command.action; this.state.voice.revision += 1; return
      case 'voice-state': this.state.voice.status = command.status; this.state.voice.error = command.error; return
      case 'configure': {
        const speechRevision = this.speechPreferenceRevision
        let next = agentConfigurationSchema.parse({ ...this.state.configuration, ...command.patch })
        const before = this.state.configuration
        // Coordinator account selection has no authority over native thread connections.
        if (next.reasoning !== before.reasoning) await this.dependencies.credentials.set('reasoning', '')
        if (next.provider !== before.provider && command.patch.defaultModelId === undefined) next.defaultModelId = ''
        // Preserve an established enabled set when changing only the legacy default choice.
        if (next.provider !== before.provider && next.enabledProviders === undefined && this.state.host.providers) next.enabledProviders = enabledThreadProviders(before)
        if (command.patch.enabledProviders !== undefined) {
          const removed = enabledThreadProviders(before).filter(provider => !next.enabledProviders?.includes(provider))
          for (const provider of removed) this.dependencies.host.disconnect(provider)
          // What the new set leaves out is turned off, and what it puts back is on again (ADR-0036).
          if (command.patch.disconnectedProviders === undefined) next = withTurnedOff(next, turnedOff(before, removed, next.enabledProviders ?? []))
        }
        if (speechRevision !== this.speechPreferenceRevision) next.speak = this.state.configuration.speak
        this.state.configuration = next
        // The newly chosen account's models and efforts fill Settings; check it without holding up the save.
        if (next.reasoning !== before.reasoning && isSubscriptionReasoning(next.reasoning)) void this.checkReasoning(next.reasoning).then(() => this.publish())
        this.scheduleProviderReconnects()
        if (command.patch.enabled === false && !this.dependencies.host.concurrentProviders) this.disconnect()
        return
      }
      case 'credential': await this.dependencies.credentials.set(command.slot, command.value.trim()); return
      case 'connect': {
        if (command.provider) {
          this.state.configuration.enabledProviders = [...new Set([...enabledThreadProviders(this.state.configuration), command.provider])]
          this.state.configuration = withTurnedOff(this.state.configuration, turnedOff(this.state.configuration, [], [command.provider]))
          if (!this.dependencies.host.concurrentProviders) this.state.configuration.enabled = true
          await this.persist()
        }
        if (!this.state.host.connected) this.state.connection = 'connecting'
        this.publish(); this.observe()
        try {
          if (this.disposed) throw new Error('Sotto is stopping. Reconnect after restarting it.')
          const snapshot = command.provider ? await this.dependencies.host.connect(command.provider) : await this.dependencies.host.connect()
          this.acceptSnapshot(snapshot)
          const refusal = connectionRefusal(snapshot, command.provider, `${PROVIDER_LABELS[this.state.configuration.provider]} did not confirm the connection.`)
          if (refusal) throw new Error(refusal)
          if (!this.dependencies.host.concurrentProviders) this.state.configuration.enabled = true
          this.say(command.provider ? `${PROVIDER_LABELS[command.provider]} connected` : snapshot.providers ? 'Thread providers connected' : `${PROVIDER_LABELS[this.state.configuration.provider]} connected`)
          // Asking the registry must not hold up the connection the user is waiting on, and a check
          // during an install would race the reading the install is about to take.
          if (!this.updatingClient) void this.checkClientUpdates().then(() => this.publish()).catch(() => undefined)
        } catch (error) {
          if (!this.state.host.providers) this.disconnect()
          // Intermediate publishes keep `connecting` until this attempt finishes. A failure has to release it.
          else if (this.state.connection === 'connecting') this.state.connection = 'disconnected'
          throw error
        }
        return
      }
      case 'disconnect':
        if (command.provider) {
          this.state.configuration.enabledProviders = enabledThreadProviders(this.state.configuration).filter(provider => provider !== command.provider)
          this.state.configuration = withTurnedOff(this.state.configuration, turnedOff(this.state.configuration, [command.provider], []))
          this.dependencies.host.disconnect(command.provider)
          this.acceptSnapshot(await this.dependencies.host.snapshot(command.provider))
          this.say(`${PROVIDER_LABELS[command.provider]} disconnected.`)
        } else {
          if (this.dependencies.host.concurrentProviders) {
            this.state.configuration.enabledProviders = []
            this.state.configuration = withTurnedOff(this.state.configuration, [...providerIdSchema.options])
          } else this.state.configuration.enabled = false
          this.disconnect(); this.say('Sotto disconnected.')
        }
        return
      case 'refresh':
        this.observe()
        // Check again on a host's provider tile (ADR-0037): a provider whose last connect failed, because it was not
        // installed, not signed in or not startable, is tried again. Nothing about which providers are turned on changes.
        if (command.provider && this.state.host.providers?.find(status => status.id === command.provider)?.connection === 'error') {
          this.acceptSnapshot(await this.dependencies.host.connect(command.provider)); return
        }
        this.acceptSnapshot(await this.dependencies.host.snapshot(command.provider)); return
      case 'check-reasoning': await this.checkReasoning(command.provider); return
      case 'check-client-updates': await this.checkClientUpdates(true); return
      // `force` is still accepted and means nothing: an update no longer stops a working thread (ADR-0042).
      case 'update-client': await this.updateClient(command.provider); return
      case 'queue-client-updates': this.queueClientUpdates(command.providers); return
      case 'cancel-client-updates': this.cancelClientUpdates(command.providers); return
      case 'dismiss-client-updates': this.state.clientUpdatesDismissedAt = new Date().toISOString(); return
      case 'utterance': await this.utterance(command.text.trim(), turn, selectionRevision); return
      case 'compose': {
        const requestId = this.state.composing ? this.state.draftRequestId : this.draftRequestId(this.state.activeThreadId)
        if (requestId) this.guardClientGrant(client)
        if (!this.state.composing) this.startDraft()
        const previous = this.state.threadDrafts?.find(item => item.threadId === this.state.draftThreadId && item.requestId === this.state.draftRequestId)
        if (command.attachments !== undefined) this.state.draftAttachments = agentAttachmentHandlesSchema.parse(command.attachments)
        this.state.draft = command.text
        this.manualDraftId = randomUUID()
        if (this.state.draftThreadId) this.putThreadDraft({ threadId: this.state.draftThreadId, draftId: this.manualDraftId, text: this.state.draft,
          attachments: this.state.draftAttachments ?? [], skills: previous?.skills, files: previous?.files, requestId: this.state.draftRequestId, updatedAt: new Date().toISOString() })
        return
      }
      case 'cancel-draft': this.clearDraft(); this.say('Draft cleared.'); return
      case 'pause-draft':
        if (!this.state.composing) return
        if (this.hasDraft() && !this.state.draftThreadId) throw new Error('Choose a thread for this recovered draft before pausing it.')
        this.syncLegacyDraft()
        this.manualDraftId = null
        this.state.draft = ''; this.state.draftAttachments = []
        this.state.draftThreadId = null; this.state.draftRequestId = null; this.state.composing = false
        this.state.activeThreadId = null; this.state.pendingRequest = ''
        this.coordinatorConversation = true
        this.queueSelectionPinned = true; this.presentedQueueId = null
        this.attentionNarration = null
        this.say('Draft saved. What would you like to do?')
        return
      case 'resume-draft':
        if (this.state.composing && this.state.draftThreadId === command.threadId) return
        if (this.hasDraft() && this.state.draftThreadId !== command.threadId) throw new Error('Pause or clear your current draft before resuming another.')
        if (!this.state.threadDrafts?.some(draft => draft.threadId === command.threadId)) throw new Error('This saved draft is no longer available.')
        this.selectThread(command.threadId, selectionRevision)
        this.startDraft(command.threadId)
        return
      case 'recover-draft': {
        this.canAct()
        if (!this.state.providerUpgrade || this.state.draftThreadId !== null || !this.hasDraft()) throw new Error('There is no unbound recovered draft to use.')
        const target = this.thread(command.threadId)
        if (target.archivedAt || target.requests.length) throw new Error('Choose an open thread without a pending question or permission before using the recovered draft.')
        this.startDraft(target.id)
        this.say(`Recovered draft ready in ${target.title}. Review it before sending.`)
        return
      }
      case 'send': await this.sendDraft(turn, manualRetryId, selectionRevision, client); return
      case 'manual-send': await this.sendManual(command.threadId, command.text, turn, manualRetryId, command.attachments, command.draftId, command.skills, command.files); return
      case 'steer-followup': await this.steerFollowup(command, turn); return
      case 'steer': await this.steer(command, turn); return
      case 'create-project': {
        const provider = command.provider ?? this.state.configuration.provider
        this.canCreate(provider)
        const targetProvider = this.state.host.providers?.find(status => status.id === provider)
        if (targetProvider && targetProvider.connection !== 'connected') throw new Error(`Connect ${PROVIDER_LABELS[provider]} before creating a project.`)
        if (!(targetProvider?.capabilities ?? this.state.host.capabilities).projects) throw new Error('This provider does not support creating projects.')
        // The name is a folder's on this host, so this host's own rules decide it: Windows refuses more than Linux or macOS.
        const unusableName = process.platform === 'win32'
          ? /[<>:"/\\|?*]/u.test(command.title) || /[. ]$/u.test(command.title) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/iu.test(command.title)
          : command.title.includes('/') || /^\.\.?$/u.test(command.title)
        if (unusableName) throw new Error('Choose a project name that can be used as a folder name.')
        const target = command.path || (this.state.configuration.projectsDirectory ? join(this.state.configuration.projectsDirectory, command.title) : '')
        if (!target || !isAbsolute(target)) throw new Error('Choose an absolute project folder or configure a default projects directory.')
        const path = resolve(target)
        const existing = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null })
        if (existing && !existing.isDirectory()) throw new Error('A file with that name is already there. Nothing was added. Choose another name.')
        if (existing && !command.useExisting) throw new Error('That folder already exists. Nothing was added. Choose another folder, or add this one with Add project to use it as it is.')
        if (command.useExisting && !existing) throw new Error(PROJECT_FOLDER_MISSING)
        const folderKey = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
        const known = command.useExisting ? this.state.host.projects.find(project => folderKey(project.path) === folderKey(path) && (!project.providerId || project.providerId === provider)) : undefined
        if (known) {
          if (selectionRevision === this.selectionRevision) {
            this.state.activeProjectId = known.id; this.state.activeThreadId = null
            this.queueSelectionPinned = true; this.presentedQueueId = null
          }
          this.state.pendingRequest = ''; this.observe(); this.say(`Opened ${known.title}.`)
          return
        }
        if (!existing) await mkdir(path, { recursive: true })
        const projectId = this.dependencies.host.createProjectId?.(provider) ?? randomUUID()
        if (turn) { turn.threadId = null; turn.projectId = projectId }
        const previousSelectionPinned = this.queueSelectionPinned
        if (selectionRevision === this.selectionRevision) this.queueSelectionPinned = true
        try {
          await this.dispatch({ type: 'create-project', commandId: randomUUID(), projectId, title: command.title, path, ...(this.state.host.providers ? { provider } : {}) }, turn)
        } catch (error) { if (selectionRevision === this.selectionRevision) this.queueSelectionPinned = previousSelectionPinned; throw error }
        if (selectionRevision === this.selectionRevision) {
          this.state.activeProjectId = projectId; this.state.activeThreadId = null
          this.presentedQueueId = null
        }
        this.observe()
        this.state.pendingRequest = ''
        this.say(`Created ${command.title} in ${path}.`)
        return
      }
      case 'settle-project':
      case 'restore-project':
      case 'settle-thread':
      case 'restore-thread': {
        const host = this.dependencies.host
        if (!host.setWorkspaceSettled) throw new Error('Workspace organization is unavailable.')
        const project = 'projectId' in command
        this.acceptSnapshot(await host.setWorkspaceSettled(project ? 'project' : 'thread', project ? command.projectId : command.threadId, command.type.startsWith('settle-')))
        this.state.notice = command.type.startsWith('settle-') ? 'Moved to Settled.' : 'Restored.'
        return
      }
      case 'select-project':
        if (selectionRevision !== this.selectionRevision) return
        if (!this.state.host.projects.some(p => p.id === command.projectId)) throw new Error('That project is unavailable.')
        this.state.activeProjectId = command.projectId; this.state.activeThreadId = null; this.state.pendingRequest = ''
        this.queueSelectionPinned = true; this.presentedQueueId = null
        this.observe(); return
      case 'load-earlier-messages': {
        if (!this.dependencies.host.loadEarlierMessages) throw new Error('Earlier messages could not be read. Nothing was lost; refresh and open the thread again.')
        this.earlierMessageBoundaries.set(command.threadId, this.thread(command.threadId).messages.at(-1)?.id)
        try { this.acceptSnapshot(await this.dependencies.host.loadEarlierMessages(command.threadId)) }
        finally { this.earlierMessageBoundaries.delete(command.threadId) }
        return
      }
      case 'retry-thread-worktree':
      case 'refresh-thread-worktree': {
        if (!this.dependencies.host.updateThreadWorktree) throw new Error('Working-copy status is unavailable.')
        this.acceptSnapshot(await this.dependencies.host.updateThreadWorktree(command.threadId, command.type === 'retry-thread-worktree'))
        return
      }
      case 'configure-thread-working-copy': {
        if (!this.dependencies.host.configureThreadWorkingCopy) throw new Error('Changing the working copy is unavailable.')
        this.acceptSnapshot(await this.dependencies.host.configureThreadWorkingCopy(command.threadId, command))
        return
      }
      case 'restore-thread-branch': {
        if (!this.dependencies.host.restoreThreadBranch) throw new Error('Switching this thread’s branch is unavailable.')
        this.acceptSnapshot(await this.dependencies.host.restoreThreadBranch(command.threadId, command.withUncommittedChanges === true))
        this.state.notice = 'Branch restored.'
        return
      }
      case 'reclaim-thread-worktree': {
        if (!this.dependencies.host.reclaimThreadWorktree) throw new Error('Removing this thread’s worktree is unavailable.')
        this.acceptSnapshot(await this.dependencies.host.reclaimThreadWorktree(command.threadId, { withUncommittedChanges: command.withUncommittedChanges === true, ...(command.confirmedIgnored ? { confirmedIgnored: command.confirmedIgnored } : {}), ...(command.confirmedItems ? { confirmedItems: command.confirmedItems } : {}), ...(command.confirmedRepositories ? { confirmedRepositories: command.confirmedRepositories } : {}) }))
        this.state.notice = 'Worktree removed. The branch is kept.'
        return
      }
      case 'open-thread-folder': {
        if (!this.dependencies.host.threadWorkingDirectory || !this.dependencies.openThreadFolder) throw new Error('Opening the working folder is unavailable.')
        await this.dependencies.openThreadFolder(await this.dependencies.host.threadWorkingDirectory(command.threadId))
        return
      }
      case 'create-thread': {
        const managed = command.managed !== false
        if (managed && this.state.composing && this.hasDraft()) throw new Error('Send or clear your draft before creating another thread.')
        const model = resolveModel(this.state.host.models, command.modelId)
        this.canCreate(model?.providerId)
        if (!this.state.host.capabilities.threads) throw new Error('This provider cannot create threads.')
        if (!this.state.host.projects.some(p => p.id === command.projectId)) throw new Error('Choose an available project.')
        if (!model?.ready) throw new Error('That model or account is unavailable. Choose a ready model; Sotto will not switch your account.')
        // A create-thread that leaves an option unset takes Settings → Agents' new-thread defaults instead,
        // so the coordinator's and voice's own threads follow them too; a caller's explicit choice still wins.
        const defaults = this.newThreadOptionDefaults(command, model)
        validateThreadOptions(this.state.host, { modelId: command.modelId, ...defaults })
        const validatePermission = (): void => this.guardThreadPermission(client, defaults, model)
        validatePermission()
        // The window may already be showing this thread under an ID it minted; main adopts it so nothing has to move.
        if (command.threadId !== undefined && this.state.host.threads.some(thread => thread.id === command.threadId)) {
          throw new Error('This thread already exists. Select it instead of creating it again.')
        }
        const threadId = command.threadId ?? randomUUID()
        if (turn) { turn.threadId = threadId; turn.projectId = command.projectId }
        const previousSelectionPinned = this.queueSelectionPinned
        if (selectionRevision === this.selectionRevision) this.queueSelectionPinned = true
        try {
          await this.dispatch({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: command.projectId, title: command.title, modelId: command.modelId,
            ...(command.titleSource ? { titleSource: command.titleSource } : {}),
            ...(command.workingCopy ? { workingCopy: command.workingCopy } : {}),
            ...(command.baseBranch ? { baseBranch: command.baseBranch } : {}),
            ...(command.startFromOrigin !== undefined ? { startFromOrigin: command.startFromOrigin } : {}),
            ...(command.existingWorktreePath ? { existingWorktreePath: command.existingWorktreePath } : {}),
            ...defaults }, turn, validatePermission)
        } catch (error) { if (selectionRevision === this.selectionRevision) this.queueSelectionPinned = previousSelectionPinned; throw error }
        if (selectionRevision === this.selectionRevision) {
          this.presentedQueueId = null
          this.state.activeThreadId = threadId; this.state.activeProjectId = command.projectId
        }
        this.observe(); this.acceptSnapshot(await this.readThread(threadId))
        if (selectionRevision === this.selectionRevision) this.state.activeProjectId = this.thread(threadId).projectId
        // A manual thread owns its composer. Creating it must neither consume nor retarget
        // the coordinator's saved prompt or answer, even when that surface is hidden.
        if (managed) {
          this.assign(threadId, '', selectionRevision)
          if (!(this.state.providerUpgrade && this.state.draftThreadId === null && this.hasDraft())) {
            this.clearDraft(); this.startDraft(threadId)
          }
          this.state.pendingRequest = ''
        }
        this.say(managed ? `Opened ${command.title}. Tell me your prompt, then say send it.` : `Opened ${command.title}.`)
        return
      }
      case 'select-thread': {
        this.selectThread(command.threadId, selectionRevision)
        return
      }
      case 'configure-thread': {
        this.canAct(undefined, false)
        if (command.modelId === undefined && command.reasoningEffort === undefined && command.runtimeMode === undefined && command.providerMode === undefined) throw new Error('Choose a thread setting to change.')
        if (this.thread(command.threadId).nativeSessionStarted !== false && !capabilitiesForThread(this.state.host, this.thread(command.threadId)).configureThread) throw new Error('This provider does not support changing thread settings.')
        // Checked against the thread as Sotto holds it, without opening it: watching or reading a reaped Claude
        // thread starts its CLI only for the adapter to restart it with the new settings. Each adapter checks
        // the thread's status, requests and model itself before it changes anything.
        const validate = (): void => {
          const thread = this.thread(command.threadId)
          if (thread.status === 'running' || thread.requests.length) throw new Error('Wait for this thread to finish and answer its pending requests before changing settings.')
          if (thread.nativeSessionStarted !== false && command.modelId && thread.providerId && resolveModel(this.state.host.models, command.modelId)?.providerId !== thread.providerId) throw new Error('Choose a model from this thread provider. Existing sessions cannot move between providers.')
          validateThreadOptions(this.state.host, command, thread.modelId)
          this.guardThreadPermission(client, command, resolveModel(this.state.host.models, command.modelId ?? thread.modelId))
        }
        validate()
        // The thread interface exposes two distinct commands. Each has its own durable identity;
        // a partial or uncertain save cannot be mistaken for an atomic update.
        if (command.modelId !== undefined || command.reasoningEffort !== undefined) {
          await this.dispatch({ type: 'configure-thread', commandId: randomUUID(), threadId: command.threadId,
            ...(command.modelId !== undefined ? { modelId: command.modelId } : {}),
            ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}) }, turn, validate)
        }
        if (command.runtimeMode !== undefined) await this.dispatch({ type: 'configure-thread', commandId: randomUUID(), threadId: command.threadId, runtimeMode: command.runtimeMode }, turn, validate)
        // A provider that names its own permission modes takes them on their own command, as runtimeMode does.
        if (command.providerMode !== undefined) await this.dispatch({ type: 'configure-thread', commandId: randomUUID(), threadId: command.threadId, providerMode: command.providerMode }, turn, validate)
        this.say('Thread settings saved.')
        this.observe()
        return
      }
      case 'select-attention': {
        const item = this.state.queue.find(entry => entry.id === command.itemId)
        if (!item || !isLiveAttention(item, this.state.host.threads)) throw new Error('This attention item is no longer pending. Review the current queue.')
        // Queue order is also the renderer's request order. Selecting an item must
        // bind its identity for speech without resolving or deferring any request.
        this.state.queue = [item, ...this.state.queue.filter(entry => entry !== item)]
        await this.execute({ type: 'select-thread', threadId: item.threadId }, turn, undefined, selectionRevision)
        return
      }
      case 'assign': {
        this.canAct(command.threadId)
        this.observe(command.threadId)
        this.acceptSnapshot(await this.readThread(command.threadId))
        this.checkManagedDraftHandoff(command.threadId, command.expectedDraftId)
        this.assign(command.threadId, command.instruction ?? '', selectionRevision)
        this.observe()
        return
      }
      case 'unassign':
        this.state.assignments = this.state.assignments.filter(a => a.threadId !== command.threadId)
        this.state.queue = this.state.queue.filter(q => q.threadId !== command.threadId)
        this.observe(); return
      case 'resume': {
        this.canAct(command.threadId)
        if (!supportsAgentSupervision(capabilitiesForThread(this.state.host, this.thread(command.threadId)))) throw new Error('This connection cannot safely supervise threads.')
        const assignment = this.assignment(command.threadId)
        this.checkManagedDraftHandoff(command.threadId, command.expectedDraftId)
        assignment.mode = 'managed'; assignment.paused = false; assignment.followups = 0; assignment.lastFailure = ''
        assignment.stopReason = 'none'; assignment.stoppedAt = ''
        this.restoreManagedDraft(command.threadId)
        this.considered.delete(command.threadId)
        this.recoveredQueueIds.delete(command.threadId)
        this.state.queue = this.state.queue.filter(q => q.threadId !== command.threadId || q.kind !== 'blocked')
        this.say(`Resumed managing ${this.thread(command.threadId).title}.`)
        this.acceptSnapshot(await this.readThread(command.threadId))
        return
      }
      case 'pause': this.assignment(command.threadId).paused = true; this.say(`Paused management of ${this.thread(command.threadId).title}. Provider work continues.`); return
      case 'interrupt': {
        const validate = (): void => this.validateInterrupt(command.threadId)
        validate()
        const assignment = this.state.assignments.find(item => item.threadId === command.threadId)
        if (assignment) assignment.paused = true
        await this.dispatch({ type: 'interrupt', commandId: randomUUID(), threadId: command.threadId }, turn, validate)
        return
      }
      case 'compact-thread': {
        const validate = (): void => {
          this.canAct(command.threadId, false)
          const thread = this.thread(command.threadId)
          if (!capabilitiesForThread(this.state.host, thread).compact || thread.manualCompactionSupported === false) throw new Error('Native manual compaction is unavailable for this thread.')
          if (isThreadClosed(thread) || thread.nativeSessionStarted === false || thread.status === 'running' || thread.requests.length) throw new Error('Wait for this thread to finish and answer its requests before compacting.')
        }
        validate()
        await this.dispatch({ type: 'compact-thread', commandId: randomUUID(), threadId: command.threadId }, turn, validate)
        return
      }
      case 'later': case 'next': {
        if (this.state.composing && this.hasDraft()) throw new Error('Send or clear your draft before moving to another queued thread.')
        this.coordinatorConversation = false
        if (this.state.composing) this.clearDraft()
        const current = this.state.queue.find(q => q.threadId === this.state.activeThreadId)
        if (current) { this.state.queue = this.state.queue.filter(q => q.id !== current.id); current.deferred = true; this.state.queue.push(current) }
        this.presentQueue(true, selectionRevision); return
      }
      case 'answer': {
        this.canAct()
        this.guardClientGrant(client)
        const assignment = this.state.assignments.find(item => item.threadId === command.threadId)
        const thread = this.thread(command.threadId)
        if (isThreadClosed(thread)) throw new Error('This thread is settled or archived. Reopen it before answering an old request.')
        const request = thread.requests.find(r => r.id === command.requestId)
        if (!request) throw new Error('This request is no longer pending. Refresh the thread.')
        if (request.kind === 'permission' && command.approved === undefined) throw new Error('Choose Allow or Deny for this permission request.')
        const answerDraft = this.state.threadDrafts?.find(draft => draft.threadId === command.threadId && draft.requestId === command.requestId
          && draft.text.trim() === command.answer.trim() && !draft.attachments.length)
        if (request.delivery === 'uncertain') throw new Error('This answer may already have arrived. Refresh the original request; it will not be resent.')
        if (isSottoRequest(request.id)) {
          // Sotto's own request: the answer is Sotto's to act on, and no provider hears it. Only a client that may
          // grant reaches here (guardClientGrant above), as for every other request (ADR-0004).
          if (!this.sottoRequests) throw new Error('This request is no longer pending. Refresh the thread.')
          this.sottoRequests.answer(command.threadId, command.requestId, command.approved === true)
          this.recordAnswerAttribution({ type: 'answer', commandId: randomUUID(), threadId: command.threadId, requestId: command.requestId, answer: command.answer,
            ...(command.approved === undefined ? {} : { approved: command.approved }), ...(command.permissionChoice ? { permissionChoice: command.permissionChoice } : {}) }, client)
          this.state.queue = this.state.queue.filter(q => q.requestId !== command.requestId)
          this.say(`Answered ${thread.title}.`)
          this.presentQueue(true, selectionRevision)
          return
        }
        await this.dispatch({ type: 'answer', commandId: randomUUID(), threadId: command.threadId, requestId: command.requestId, answer: command.answer, ...(command.approved === undefined ? {} : { approved: command.approved }), ...(command.questionAnswers ? { questionAnswers: command.questionAnswers } : {}), ...(command.permissionChoice ? { permissionChoice: command.permissionChoice } : {}) }, turn, undefined, undefined, client)
        assignment?.handledRequestIds.push(command.requestId)
        this.state.queue = this.state.queue.filter(q => q.requestId !== command.requestId)
        if (answerDraft) {
          this.state.threadDrafts = (this.state.threadDrafts ?? []).filter(draft => draft.threadId !== command.threadId || draft.draftId !== answerDraft.draftId)
        }
        if (this.state.draftThreadId === command.threadId && this.state.draftRequestId === command.requestId
          && (!answerDraft || this.manualDraftId === answerDraft.draftId)) this.clearDraft()
        this.say(`Answered ${thread.title}.`)
        this.presentQueue(true, selectionRevision)
        return
      }
    }
  }
  private assign(threadId: string, instruction: string, selectionRevision: number): void {
    if (!supportsAgentSupervision(capabilitiesForThread(this.state.host, this.thread(threadId)))) throw new Error('This connection cannot safely supervise threads. Its available controls remain visible.')
    const thread = this.thread(threadId)
    if (this.state.assignments.some(a => a.threadId === threadId)) return
    this.state.assignments.push({ threadId, mode: 'managed', instruction, followups: 0, paused: false,
      startedAt: new Date().toISOString(), origin: 'unknown', stopReason: 'none', stoppedAt: '',
      contextUpdatedAt: Date.now(),
      seenMessageIds: thread.messages.slice(-MAX_SEEN_MESSAGE_IDS).map(m => m.id), ownMessageIds: [], handledRequestIds: [], lastFailure: '' })
    if (selectionRevision === this.selectionRevision) {
      this.state.activeThreadId = threadId; this.state.activeProjectId = thread.projectId
      this.restoreManagedDraft(threadId)
    }
  }
  private restoreManagedDraft(threadId: string): void {
    // The managed composer is another view of the same saved draft. A draft
    // belonging to a different thread keeps its explicit owner and notice.
    if (!this.hasDraft() && this.state.threadDrafts?.some(item => item.threadId === threadId)) this.startDraft(threadId)
  }
  private checkManagedDraftHandoff(threadId: string, expectedDraftId: string | null | undefined): void {
    if (expectedDraftId === undefined) return // Existing voice/management commands keep their authority contract.
    const draft = this.state.threadDrafts?.find(item => item.threadId === threadId)
    const currentId = draft?.draftId ?? this.emptyDraftRevisions.get(threadId) ?? null
    if (currentId !== expectedDraftId) throw new Error('The thread draft changed before management could take it. Keep your edit and retry the handoff.')
    if (this.outbox.some(item => item.threadId === threadId)
      || this.state.deliveries?.some(item => item.threadId === threadId && ['queued', 'submitting', 'uncertain'].includes(item.status))) {
      throw new Error('An earlier submission is still pending. Refresh to reconcile it before handing the draft to management.')
    }
    if (this.persistedDrafts.get(threadId) !== this.draftSignatures(draft ? [draft] : []).get(threadId)) {
      throw new Error('Save the current thread draft before handing it to management.')
    }
  }
  /** Defaults and provider profiles are preferences, never a remote client's policy grant. */
  private guardThreadPermission(client: ClientIdentity, options: { runtimeMode?: AgentRuntimeMode | undefined; providerMode?: string | undefined }, model: AgentModel | undefined): void {
    if ((options.runtimeMode !== undefined && options.runtimeMode !== 'approval-required')
      || (options.providerMode !== undefined && !model?.providerModes?.some(mode => mode.id === options.providerMode && mode.allows === 'nothing'))) {
      this.guardClientGrant(client, REMOTE_PERMISSION_DENIED)
    }
  }
  /**
   * Whether this client's answer may count as a grant at all. The desktop window on this machine
   * always may; a remote client may only while a policy record names it (ADR-0004). The pairing token
   * says which client is speaking and nothing more, so this asks policy rather than the token.
   */
  private guardClientGrant(client: ClientIdentity, refusal = UNPAIRED_CLIENT_ERROR): void {
    const verdict = this.dependencies.authority?.mayGrant(client) ?? mayGrantLocally(client)
    if (!verdict.allowed) throw new Error(refusal)
  }
  /**
   * Writes who answered into the thread's own log. The answer's words are deliberately left out — an
   * answer can read like a prompt — so the record is the request, the choice and the client. A failed
   * write costs the record alone; the answer itself already reached the provider.
   */
  private recordAnswerAttribution(command: Extract<AgentHostCommand, { type: 'answer' }>, client: ClientIdentity): void {
    const record = this.dependencies.host.recordAnswer
    if (!record) return
    const optionIds = command.questionAnswers === undefined ? []
      : [...new Set(Object.values(command.questionAnswers).flatMap(answer => answer.optionIds))]
    try {
      record.call(this.dependencies.host, command.threadId, {
        kind: 'answer-given', at: new Date().toISOString(), requestId: command.requestId,
        ...(command.approved === undefined ? {} : { approved: command.approved }),
        ...(command.permissionChoice === undefined ? {} : { permissionChoice: command.permissionChoice }),
        ...(optionIds.length === 0 ? {} : { questionOptionIds: optionIds }),
        attribution: { clientId: client.clientId, ...(client.user ? { user: client.user } : {}), transport: client.transport },
      })
    } catch {
      // Never the user's problem and never a lost answer; the log says so by a stable name alone.
      this.dependencies.logFailure?.('thread-answer-attribution-failed', 'failed')
    }
  }
  private guardAuthority(command: DispatchCommand, turn?: ActiveTurn): void {
    if (command.type !== 'answer') return
    const thread = this.thread(command.threadId)
    const request = thread.requests.find(r => r.id === command.requestId)
    if (request?.kind !== 'permission') return
    if (turn?.source === 'supervision') throw new Error('Permissions are never answered automatically. This request stays in your attention queue.')
    if (command.approved !== true) return
    // Every risky class is checked against policy. The user's explicit Allow is the confirmation an
    // always-confirm boundary requires, so no verdict rejects a user-sourced approval; boundaries stay in force.
    const at = new Date().toISOString()
    for (const action of classifyRiskyAction(request)) this.dependencies.authority?.authorizes({ action, resource: '*', scope: thread.projectId, at })
  }
  /**
   * Read a thread back from its host. `purpose` says what the read is for: the read immediately before a send
   * passes `{ beforeSend: true }`, which an adapter may make lighter than a whole read when it can show nothing
   * changed (Codex's newest-turn check, ADR-0005). What the send then checks is the same.
   */
  private readThread(threadId?: string, provider?: ProviderId, purpose?: ThreadReadPurpose): Promise<AgentHostSnapshot> {
    const host = this.dependencies.host
    return threadId && host.refreshThread ? host.refreshThread(threadId, purpose) : provider ? host.snapshot(provider) : host.snapshot()
  }
  private async dispatch(command: DispatchCommand, turn?: ActiveTurn, validate?: () => void, draftId?: string,
    client: ClientIdentity = this.localClient): Promise<void> {
    if (turn) this.dispatchTurns.set(command.commandId, turn)
    try { await this.dispatchPending(command, turn, validate, draftId, client) }
    finally { this.dispatchTurns.delete(command.commandId); this.settingsDispatching.delete(command.commandId) }
  }
  private async dispatchPending(command: DispatchCommand, turn?: ActiveTurn, validate?: () => void, draftId?: string,
    client: ClientIdentity = this.localClient): Promise<void> {
    // A prompt or an answer stays as a draft when this refuses; a create, a setting or a stop has none.
    const draftKept = promptOf(command) !== null || command.type === 'answer'
    this.canAct(undefined, draftKept)
    // Refused here, before an outbox entry exists and long before the provider hears anything.
    if (command.type === 'answer') this.guardClientGrant(client)
    const threadId = 'threadId' in command ? command.threadId : undefined
    const prompt = promptOf(command)
    const provider = command.type === 'create-project' ? command.provider ?? this.state.configuration.provider
      : command.type === 'create-thread' || (command.type === 'configure-thread' && command.modelId && this.thread(command.threadId).nativeSessionStarted === false)
        ? resolveModel(this.state.host.models, command.modelId)?.providerId : command.type === 'answer'
          ? requestDraftProvider(this.state.host, this.thread(command.threadId), this.state.configuration.provider) : this.thread(command.threadId).providerId
    if (threadId && command.type !== 'create-thread' && !(command.type === 'configure-thread' && this.thread(threadId).nativeSessionStarted === false)) this.canAct(threadId, draftKept)
    const toThread = prompt ?? (command.type === 'answer' ? command : null)
    if (toThread) {
      const thread = this.thread(toThread.threadId); const capabilities = capabilitiesForThread(this.state.host, thread)
      if (prompt && (!capabilities.submit || !capabilities.reconcile)) throw new Error('This connection cannot safely send and reconcile a prompt.')
      if (command.type === 'answer') {
        const request = thread.requests.find(request => request.id === command.requestId)
        if (request && !(request.kind === 'permission' ? capabilities.permissions : capabilities.questions)) throw new Error('This provider does not support answering this request.')
      }
    }
    if (prompt) draftId ??= randomUUID()
    // Stop has its own intent and may pass an unresolved prompt; it cannot settle or replay that prompt.
    if (command.type !== 'interrupt' && this.outbox.some(item => threadId ? item.threadId === threadId : item.threadId === undefined && (item.provider ?? this.state.configuration.provider) === provider)) throw new Error('An earlier action has an unknown result. Reconnect and inspect the provider before retrying; Sotto will not send it twice.')
    const answerRequest = command.type === 'answer' ? this.thread(command.threadId).requests.find(item => item.id === command.requestId) : undefined
    const answerQuestions = answerRequest ? requestDraftQuestions(answerRequest) : []
    // A model change that names no effort is saved with the new model's default, as the provider will start it on.
    const startingEffort = command.type === 'configure-thread' && command.modelId !== undefined && command.reasoningEffort === undefined
      ? resolveModel(this.state.host.models, command.modelId)?.defaultReasoningEffort : undefined
    this.outbox.push({ id: command.commandId, type: command.type, ...(provider ? { provider } : {}), ...(threadId ? { threadId } : {}),
      ...('messageId' in command ? { messageId: command.messageId } : {}),
      ...('requestId' in command ? { requestId: command.requestId } : {}),
      ...(answerQuestions.length ? { questionsDigest: requestQuestionsDigest(answerQuestions) } : {}),
      ...(command.type === 'configure-thread' ? { options: agentThreadOptionsSchema.parse({ ...command, ...(startingEffort ? { reasoningEffort: startingEffort } : {}) }) } : {}),
      ...(prompt ? { draftDigest: followupDigest(prompt), ...(draftId ? { draftId } : {}),
        ...(prompt.attachments?.length ? { attachmentDigests: prompt.attachments.map(image => image.digest) } : {}) } : {}),
      ...(command.type === 'create-project' ? { entityId: command.projectId } : command.type === 'create-thread' ? { entityId: command.threadId } : {}),
    })
    const answerIntent = command.type === 'answer' ? this.outbox.find(item => item.id === command.commandId) : undefined
    if (command.type === 'configure-thread') this.settingsDispatching.add(command.commandId)
    if (prompt && draftId) {
      this.setDelivery(prompt.threadId, draftId, 'submitting', { commandId: prompt.commandId, messageId: prompt.messageId })
      // The message shows as Sending as soon as the intent exists, not after the disk write.
      // Durability still gates dispatch: the outbox entry is persisted below, before host.execute.
      this.publish()
    }
    try { await this.persist() }
    catch (error) {
      // Nothing crossed the adapter boundary. Do not leave phantom uncertain intent.
      this.outbox = this.outbox.filter(item => item.id !== command.commandId)
      if (prompt && draftId) { this.setDelivery(prompt.threadId, draftId, 'failed'); this.publish() }
      throw error
    }
    let result
    if (prompt) addTurnContext(turn, prompt.text)
    else if (command.type === 'answer') addTurnContext(turn, command.answer)
    let providerLatencyMs: number | undefined
    let previewAttachments: AgentAttachmentHandle[] = []
    try {
      this.canAct(undefined, draftKept); this.guardAuthority(command, turn); validate?.()
      if (prompt?.attachments?.length) {
        // Checked again now the outbox entry owns the content: a sweep that runs from here on keeps it, and one
        // that ran while this waited behind a running lane is caught here rather than at the adapter.
        this.attachments.verify(prompt.attachments)
        // Checked before the provider hears anything; kept as a preview only once it has.
        previewAttachments = validatePromptAttachments(this.state.host, this.thread(prompt.threadId).modelId, prompt.attachments)
      }
      if (command.type === 'answer' && answerRequest && answerQuestions.length && provider) {
        const draftAnswers = answerRequest.questions?.length ? command.questionAnswers : { [answerRequest.id]: { optionIds: [command.answer] } }
        await this.dependencies.bindRequestDraftDecision?.({ kind: 'thread', ownerId: command.threadId, providerId: provider, requestId: command.requestId, questions: answerQuestions }, command.commandId, draftAnswers)
        this.canAct(undefined, draftKept); this.guardAuthority(command, turn); validate?.()
      }
      const providerStartedAt = Date.now()
      // The images become the adapter's to read here, at the provider boundary, and not before (ADR-0031).
      const hostCommand = (prompt?.attachments?.length
        ? { ...prompt, attachments: prompt.attachments.map(image => this.promptImage(image)) } : command) as AgentHostCommand
      try {
        this.canAct(undefined, draftKept)
        result = await this.dependencies.host.execute(hostCommand).catch(error => {
          if (turn) turn.failureCode = 'provider-failed'
          throw error
        })
      }
      finally { providerLatencyMs = Math.max(0, Date.now() - providerStartedAt) }
    } catch (error) {
      this.outbox = this.outbox.filter(o => o.id !== command.commandId)
      if (prompt && draftId) this.setDelivery(prompt.threadId, draftId, 'failed')
      await this.persist()
      throw error
    } finally {
      if (turn) turn.delegationMs += providerLatencyMs ?? 0
      if (prompt && draftId && providerLatencyMs !== undefined) {
        const delivery = this.state.deliveries?.find(item => item.threadId === prompt.threadId && item.draftId === draftId)
        this.setDelivery(prompt.threadId, draftId, delivery?.status ?? 'submitting', { providerLatencyMs })
      }
    }
    // Previews are decoration, not history: the provider hears the prompt first, and a definitive refusal records nothing.
    if (prompt && previewAttachments.length
      && (result.accepted || result.uncertain || !this.outbox.some(item => item.id === command.commandId))) {
      this.rememberPreviews(prompt.threadId, prompt.messageId, prompt.commandId, previewAttachments)
    }
    // An exact native message already reconciled this outbox item. Delivery is
    // settled even if its running turn prevents a later display/history read.
    if (prompt && !this.outbox.some(item => item.id === command.commandId)) {
      await this.persist()
      return
    }
    if (prompt && draftId) this.setDelivery(prompt.threadId, draftId, result.accepted || result.uncertain ? 'uncertain' : 'failed')
    if (command.type === 'answer' && (result.accepted || result.uncertain)) {
      // The user gave this answer whether or not the provider confirmed taking it, so who gave it is recorded either way.
      this.recordAnswerAttribution(command, client)
    }
    // An adapter that knows more about what an unconfirmed action cost says it; the intent is kept either way.
    const uncertaintyError = command.type === 'answer' && result.uncertain && (result.answerCompletion || client.transport === 'socket')
      ? new AnswerDeliveryUnconfirmed(result.error ?? PROVIDER_RESULT_UNCONFIRMED)
      : new Error(result.error ?? PROVIDER_RESULT_UNCONFIRMED)
    if (uncertaintyError instanceof AnswerDeliveryUnconfirmed && client.transport !== 'socket') this.setCommandError(uncertaintyError, uncertaintyError.message)
    if (command.type === 'answer' && result.answerCompletion) {
      void result.answerCompletion.then(async delivered => {
        if (!delivered) return
        if (uncertaintyError instanceof AnswerDeliveryUnconfirmed) uncertaintyError.delivered = true
        if (answerIntent) this.recordAnsweredRequest(answerIntent)
        if (this.visibleCommandError === uncertaintyError && this.state.error === uncertaintyError.message) {
          this.setCommandError(undefined, null)
        }
        this.outbox = this.outbox.filter(item => item.id !== command.commandId)
        await this.persist(); this.publish()
      }).catch(() => { this.state.error = 'Answer delivery was confirmed, but could not be saved. Restore local storage access and refresh.'; this.publish() })
    }
    if (result.uncertain && this.outbox.some(o => o.id === command.commandId)) throw uncertaintyError
    if ((command.type === 'configure-thread' || prompt) && result.accepted) {
      // A settings change the provider confirmed comes back with the snapshot it produced, which is the
      // reconciliation; the thread is read again only when the adapter has none to give.
      try { this.acceptSnapshot(command.type === 'configure-thread' && result.snapshot ? result.snapshot : await this.readThread(threadId)) }
      catch (error) {
        // The exact echo can arrive while this required reconciliation read is
        // in flight. Keep its receipt; an unconfirmed command still fails here.
        if (!prompt || this.outbox.some(item => item.id === command.commandId)) throw error
      }
      await this.persist()
      if (this.outbox.some(item => item.id === command.commandId)) throw new Error(prompt
        ? 'The provider has not confirmed this user message in its state. Refresh to reconcile the existing send; it will not be replayed.'
        : THREAD_SETTINGS_UNRECONCILED)
      return
    }
    if (command.type === 'answer' && result.accepted) {
      if (!result.uncertain && answerIntent) this.recordAnsweredRequest(answerIntent)
    }
    this.outbox = this.outbox.filter(o => o.id !== command.commandId)
    await this.persist()
    if (!result.accepted && !result.uncertain) {
      if (turn) turn.failureCode = 'provider-failed'
      throw new Error(PROVIDER_REJECTED_ACTION)
    }
    this.acceptSnapshot(await this.readThread(threadId, provider))
    // Request disappearance alone confirms nothing. A late write completion does confirm this
    // answer, and must not be replaced with a fresh uncertainty error for a socket client.
    if (command.type === 'answer' && client.transport === 'socket' && result.uncertain
      && !(uncertaintyError instanceof AnswerDeliveryUnconfirmed && uncertaintyError.delivered)) {
      throw uncertaintyError
    }
  }
  /**
   * Keeps the images of a prompt the provider has taken, without holding the send on the disk write. A failed
   * write leaves the preview unavailable, which is all a lost thumbnail costs; the message was already sent.
   */
  private rememberPreviews(threadId: string, messageId: string, commandId: string, attachments: readonly AgentAttachmentHandle[]): void {
    void this.attachmentPreviews.remember(threadId, messageId, commandId, attachments).catch(() => undefined)
    // The provider's echo of this message can land while it is still being sent, and a window that already
    // holds it undecorated would never be sent it again: the thread goes out whole on the next publish.
    if (this.state.host.threads.find(thread => thread.id === threadId)?.messages.some(message => message.id === messageId)) {
      this.publishedDetail.delete(threadId); this.detailSnapshots.delete(threadId); this.publish()
    }
  }
  private async sendManual(threadId: string, text: string, turn?: ActiveTurn, retryId?: string, attachments: AgentAttachmentHandle[] = [], draftId?: string, skills?: AgentSkillReference[], files?: AgentFileReference[]): Promise<void> {
    if (draftId && this.state.deliveredDrafts?.some(receipt => receipt.threadId === threadId && receipt.draftId === draftId)) return
    const pendingId = retryId ?? this.outbox.find(item => item.threadId === threadId)?.id
    if (pendingId) {
      // A retry may discover that the earlier command already succeeded. It is
      // never a new dispatch and must not replace an edited or recovered draft.
      this.canAct()
      this.observe(threadId)
      this.acceptSnapshot(await this.readThread(threadId))
      if (this.outbox.some(item => item.id === pendingId)) throw new Error('An earlier action has an unknown result. Reconnect and inspect the provider before retrying; Sotto will not send it twice.')
      this.say(`Reconciled the earlier action on ${this.thread(threadId).title}. No new prompt was sent.`)
      this.observe()
      return
    }
    const preserveDraft = this.hasDraft() && this.state.draftThreadId !== threadId
    if (this.hasDraft() && !preserveDraft && this.state.draftRequestId) throw new Error('Send or clear the existing answer before prompting this thread.')
    if (this.state.threadDrafts?.find(item => item.threadId === threadId)?.requestId) throw new Error('Send or clear the existing answer before prompting this thread.')
    this.thread(threadId)
    attachments = agentAttachmentHandlesSchema.parse(attachments)
    // Manual composers own their text per thread. A send must not replace the
    // coordinator's saved prompt or answer on a different thread.
    if (!preserveDraft && this.state.threadDrafts?.find(item => item.threadId === threadId)?.draftId === draftId) {
      this.state.draftAttachments = attachments
      this.manualDraftId = draftId ?? null
      this.state.draft = text; this.state.draftThreadId = threadId; this.state.draftRequestId = null; this.state.composing = true
      // Admission already persisted the complete per-thread draft before entering this lane.
    }
    this.canAct()
    this.observe(threadId)
    this.acceptSnapshot(await this.readThread(threadId, undefined, { beforeSend: true }))
    const validate = (): void => {
      this.canAct()
      const latest = this.thread(threadId)
      if (!text.trim() && !attachments.length) throw new Error('There is no prompt to send.')
      validatePromptAttachments(this.state.host, latest.modelId, attachments)
      if (!capabilitiesForThread(this.state.host, latest).submit || !capabilitiesForThread(this.state.host, latest).reconcile) throw new Error('This connection cannot safely send and reconcile a prompt.')
      // Settlement parks an open thread; explicitly prompting it starts fresh work.
      if (latest.archivedAt && Number.isFinite(Date.parse(latest.archivedAt))) throw new Error('This thread is archived. Reopen it before sending a prompt.')
      if (latest.requests.length) throw new Error('Answer the pending question or permission explicitly before sending a new prompt.')
      if (latest.status === 'running') throw new Error('This thread is still working. Your draft is saved; wait for it to finish.')
      if (this.state.assignments.some(a => a.threadId === threadId && a.mode === 'managed')) throw new Error('Use the managed draft controls for this thread, or stop management before sending a manual prompt.')
    }
    validate()
    const thread = this.thread(threadId)
    const messageId = randomUUID()
    const assignment = this.state.assignments.find(a => a.threadId === threadId)
    assignment?.ownMessageIds.push(messageId)
    await this.dispatch({ type: 'send', commandId: randomUUID(), threadId, messageId, text: text.trim(), ...(skills ? { skills } : {}), ...(files ? { files } : {}), ...(attachments.length ? { attachments } : {}), expectedLastUserMessageId: lastUserMessageIdOf(thread) }, turn, validate, draftId)
    this.state.queue = this.state.queue.filter(item => item.threadId !== threadId || item.requestId)
    this.say(`Sent to ${thread.title}.`)
    this.observe()
  }
  private async sendDraft(turn?: ActiveTurn, retryId?: string, selectionRevision = this.selectionRevision, client = this.localClient, selectedThreadId?: string): Promise<void> {
    const scoped = selectedThreadId !== undefined
    const draftThreadId = selectedThreadId ?? this.state.draftThreadId
    if (!scoped || this.state.draftThreadId === draftThreadId) this.syncLegacyDraft()
    const pickedDraft = this.state.threadDrafts?.find(draft => draft.threadId === draftThreadId)
    const draftText = scoped ? pickedDraft?.text ?? '' : this.state.draft
    const draftAttachments = scoped ? pickedDraft?.attachments ?? [] : this.state.draftAttachments
    const draftRequestId = scoped ? pickedDraft?.requestId : this.state.draftRequestId
    const pickedDraftId = scoped ? pickedDraft?.draftId : this.manualDraftId ?? undefined
    const pendingId = retryId ?? this.outbox.find(item => item.threadId === draftThreadId)?.id
    if (pendingId) {
      this.canAct()
      this.observe(); this.acceptSnapshot(await this.readThread(draftThreadId ?? undefined))
      if (this.outbox.some(item => item.id === pendingId)) throw new Error('An earlier action has an unknown result. Reconnect and inspect the provider before retrying; Sotto will not send it twice.')
      this.say('Reconciled the earlier action. No new prompt was sent.')
      return
    }
    if (turn) {
      turn.threadId = draftThreadId
      turn.projectId = this.state.host.threads.find(thread => thread.id === draftThreadId)?.projectId ?? null
    }
    this.canAct()
    this.observe()
    this.acceptSnapshot(await this.readThread(draftThreadId ?? undefined, undefined, { beforeSend: true }))
    const thread = this.thread(draftThreadId)
    if (!draftText.trim() && !draftAttachments?.length) throw new Error('There is no prompt to send.')
    const attachments = validatePromptAttachments(this.state.host, thread.modelId, draftAttachments)
    const assignment = this.assignment(thread.id)
    const text = draftText.trim()
    const draftId = pickedDraftId
    const savedDraft = this.state.threadDrafts?.find(item => item.threadId === thread.id && item.draftId === draftId)
    const skills = savedDraft?.skills
    const files = savedDraft?.files
    if (draftRequestId) {
      if (attachments.length) throw new Error('Images cannot answer a pending question. Remove the images and answer it explicitly.')
      const requestId = draftRequestId
      if (!thread.requests.some(request => request.id === requestId && request.kind === 'question')) throw new Error('This question is no longer pending. Your answer is saved; review it before starting a new prompt.')
      await this.execute({ type: 'answer', threadId: thread.id, requestId, answer: text }, turn, undefined, selectionRevision, client)
      return
    }
    if (thread.requests.length) throw new Error('Answer the pending question or permission explicitly before sending a new prompt.')
    if (thread.status === 'running') throw new Error('This thread is still working. Your draft is saved; wait for it to finish or explicitly stop the agent.')
    const messageId = randomUUID()
    assignment.ownMessageIds.push(messageId)
    assignment.instruction = text; assignment.followups = 0; assignment.lastFailure = ''
    assignment.origin = turn?.source === 'utterance' ? 'voice' : 'typed'
    assignment.stopReason = 'none'; assignment.stoppedAt = ''
    assignment.contextUpdatedAt = Date.now()
    await this.dispatch({ type: 'send', commandId: randomUUID(), threadId: thread.id, messageId, text, ...(skills ? { skills } : {}), ...(files ? { files } : {}), ...(attachments.length ? { attachments } : {}), expectedLastUserMessageId: lastUserMessageIdOf(thread) }, turn, undefined, draftId)
    if (this.manualDraftId === draftId && this.state.draftThreadId === thread.id) this.clearDraft()
    else this.state.threadDrafts = (this.state.threadDrafts ?? []).filter(draft => draft.threadId !== thread.id || draft.draftId !== draftId)
    this.state.queue = this.state.queue.filter(q => q.threadId !== thread.id || q.kind === 'permission' || q.kind === 'question')
    this.say(`Sent to ${thread.title}.`)
    if (!scoped) this.presentQueue(true, selectionRevision)
  }
  private draftRequestId(threadId: string | null): string | null {
    const thread = this.thread(threadId)
    const saved = !this.hasDraft() ? this.state.threadDrafts?.find(item => item.threadId === thread.id) : undefined
    return saved ? saved.requestId : this.state.queue.find(item => item.threadId === thread.id && item.kind === 'question' && item.requestId)?.requestId ?? null
  }
  private startDraft(threadId = this.state.activeThreadId): void {
    const thread = this.thread(threadId)
    this.coordinatorConversation = false
    this.manualDraftId = null
    const requestId = this.draftRequestId(threadId)
    const saved = !this.hasDraft() ? this.state.threadDrafts?.find(item => item.threadId === thread.id) : undefined
    if (saved) {
      this.state.draft = saved.text; this.state.draftAttachments = structuredClone(saved.attachments); this.manualDraftId = saved.draftId
    }
    this.state.draftThreadId = thread.id
    this.state.draftRequestId = requestId
    this.state.composing = true
  }
  private clearDraft(): void {
    this.state.threadDrafts = (this.state.threadDrafts ?? []).filter(item => item.threadId !== this.state.draftThreadId)
    this.manualDraftId = null
    this.state.draftAttachments = []
    this.state.draft = ''; this.state.draftThreadId = null; this.state.draftRequestId = null; this.state.composing = false
  }
  private hasDraft(): boolean { return Boolean(this.state.draft.trim() || this.state.draftAttachments?.length) }
  private readPreferences(query: string, projectId: string | null, threadId: string | null, turn?: ActiveTurn): AgentPreference[] {
    if (!this.dependencies.preferences) return []
    const started = Date.now()
    try {
      const preferences = this.dependencies.preferences.retrieve({ query,
        ...(projectId === null ? {} : { projectId }), ...(threadId === null ? {} : { threadId }) })
      this.recordPreferences(turn, preferences)
      return preferences
    } finally {
      if (turn) { turn.retrievalMs += Date.now() - started; turn.retrievalCount += 1 }
    }
  }
  private recordPreferences(turn: ActiveTurn | undefined, preferences: AgentPreference[]): void {
    if (!turn || preferences.length === 0) return
    turn.retrievedMemoryIds = [...new Set([...turn.retrievedMemoryIds, ...preferences.map(preference => preference.id)])]
    addTurnContext(turn, JSON.stringify(preferences))
  }
  private async utterance(text: string, turn?: ActiveTurn, selectionRevision = this.selectionRevision): Promise<void> {
    addTurnContext(turn, text)
    const normalized = text.toLocaleLowerCase().replace(/[.!?,]+$/u, '').trim()
    if (this.state.composing && normalized === 'talk to sotto') { await this.execute({ type: 'pause-draft' }, turn, undefined, selectionRevision); return }
    if (!this.state.composing && normalized === 'what needs my attention') {
      const items = this.state.queue
      const summary = items.slice(0, 3).map(item => `${this.state.host.threads.find(thread => thread.id === item.threadId)?.title ?? 'Thread'}: ${item.text.slice(0, 180)}`).join(' ')
      this.state.pendingRequest = ''
      this.say(items.length ? `${items.length} ${items.length === 1 ? 'item' : 'items'} in your attention queue. ${summary}${items.length > 3 ? ` And ${items.length - 3} more.` : ''}` : 'Nothing is queued for your attention.')
      return
    }
    if (normalized === 'send it') { await this.sendDraft(turn, undefined, selectionRevision); return }
    if (normalized === 'cancel draft' || normalized === 'clear draft') { await this.execute({ type: 'cancel-draft' }, turn, undefined, selectionRevision); return }
    if (normalized === 'next' || normalized === 'later') { await this.execute({ type: normalized }, turn, undefined, selectionRevision); return }
    const resume = /^(resume managing|pause managing|manage|select|open) (.+)$/iu.exec(normalized)
    if (resume && !(this.state.pendingRequest && ['select', 'open'].includes(resume[1]!))) {
      const matches = this.state.host.threads.filter(t => t.title.toLocaleLowerCase() === resume[2])
      if (matches.length > 0) {
        if (resume[1] === 'manage' && matches.length === 1 && matches[0]!.id === this.state.draftThreadId
          && !this.state.assignments.some(assignment => assignment.threadId === matches[0]!.id)) {
          await this.execute({ type: 'assign', threadId: matches[0]!.id }, turn, undefined, selectionRevision)
          this.say(`Managing ${matches[0]!.title}. Your draft is ready; say send it when you are ready.`)
          return
        }
        if (this.state.composing && this.hasDraft()) throw new Error('Send or clear your draft before using thread management controls.')
        if (matches.length > 1) throw new Error('More than one thread has that name. Select the thread using the controls.')
        if (this.state.composing) this.clearDraft()
        await this.execute({ type: resume[1] === 'resume managing' ? 'resume' : resume[1] === 'pause managing' ? 'pause' : resume[1] === 'manage' ? 'assign' : 'select-thread', threadId: matches[0]!.id }, turn, undefined, selectionRevision)
        return
      }
    }
    if ((this.state.composing || this.state.activeThreadId) && !this.state.draft.trim() && /^(here[’']?s my prompt|here is my prompt|start prompt|my prompt is)\b/u.test(normalized)) {
      this.manualDraftId = null
      if (!this.state.composing) this.startDraft()
      this.state.draft = text.replace(/^(here[’']?s my prompt|here is my prompt|start prompt|my prompt is)\b[:,.]?\s*/iu, '')
      this.say('I’m listening. Say send it when your prompt is ready.')
      return
    }
    if (this.state.composing) { this.manualDraftId = null; this.state.draft = `${this.state.draft}${this.state.draft ? ' ' : ''}${text}`; return }
    const activeQuestion = this.coordinatorConversation ? undefined : this.state.queue.find(q => q.threadId === this.state.activeThreadId && (q.kind === 'question' || q.kind === 'permission'))
    if (activeQuestion?.requestId) {
      if (activeQuestion.kind === 'permission') {
        if (![...approvalWords, ...denialWords].includes(normalized)) { this.say('Say allow or deny for this permission request.'); return }
        const approved = approvalWords.includes(normalized)
        const choices = this.thread(activeQuestion.threadId).requests.find(request => request.id === activeQuestion.requestId)?.permissionChoices
        const matches = choices?.filter(choice => choice.kind === (approved ? 'allow-once' : 'deny'))
        if (matches && matches.length !== 1) {
          this.say(choices?.length ? 'Choose the permission scope using the request controls.' : 'Answer this permission request in the provider’s app.')
          return
        }
        await this.execute({ type: 'answer', threadId: activeQuestion.threadId, requestId: activeQuestion.requestId, answer: text, approved,
          ...(matches?.[0] ? { permissionChoice: matches[0].id } : {}) }, turn, undefined, selectionRevision)
      } else {
        this.startDraft()
        this.state.draft = text
        this.say('Answer captured. Keep speaking or edit it, then say send it.')
      }
      return
    }
    const request = this.state.pendingRequest ? `${this.state.pendingRequest}\nUser clarification: ${text}` : text
    if (request.length > 18_000) throw new Error('This request is too long. Clear it and start a shorter command; use the prompt editor for project instructions.')
    this.canAct()
    if (this.state.pendingRequest) addTurnContext(turn, `${this.state.pendingRequest}\nUser clarification: `)
    const preferences = this.readPreferences(request, this.state.activeProjectId, this.state.activeThreadId, turn)
    const intentStarted = Date.now()
    let intent
    try {
      intent = await this.dependencies.reasoner.intent(request, this.state.host, this.state.activeProjectId, defaultNewThreadModelId(this.state.configuration, this.state.host.models, this.state.reasoningAccounts), this.state.activeThreadId, preferences)
      if (turn) turn.intentResolvedAtMs = Date.now()
    } catch (error) {
      if (turn) turn.failureCode = 'reasoning-failed'
      throw error
    } finally {
      if (turn) turn.intentMs += Date.now() - intentStarted
    }
    if (turn && intent.type === 'clarify') turn.clarified = true
    if (intent.type === 'clarify') {
      this.state.pendingRequest = `${request}\nSotto clarification: ${intent.text}`.slice(0, 20_000)
      this.say(intent.text)
    } else {
      try {
        if (intent.type === 'compose') {
          if (this.hasDraft()) throw new Error('Send or clear your existing draft before preparing another prompt.')
          await this.execute({ type: 'select-thread', threadId: intent.threadId }, turn, undefined, selectionRevision)
          this.clearDraft(); this.startDraft(intent.threadId); this.state.draft = intent.text
          this.say(this.state.assignments.some(assignment => assignment.threadId === intent.threadId)
            ? `Prompt for ${this.thread(intent.threadId).title}. ${intent.text ? 'Review or keep speaking, then say send it.' : 'Tell me your prompt, then say send it.'}`
            : `Prompt for ${this.thread(intent.threadId).title}. Manage this thread before sending; your draft is saved.`)
        } else await this.execute(intent, turn, undefined, selectionRevision)
        this.state.pendingRequest = ''
      } catch (error) {
        const failure = error instanceof Error ? error.message : 'Sotto could not complete this action.'
        this.state.pendingRequest = `${request}\nSotto action could not complete: ${failure}`.slice(0, 20_000)
        throw error
      }
    }
  }
  private keepPendingAttention(item: AgentQueueItem, snapshot: AgentHostSnapshot): boolean {
    const thread = snapshot.threads.find(thread => thread.id === item.threadId)
    const provider = thread?.providerId ?? this.dependencies.host.providerForThread?.(item.threadId)
    if (provider && snapshot.providers?.find(status => status.id === provider)?.connection !== 'connected') return true
    return isLiveAttention(item, snapshot.threads)
  }
  private processedAssignmentThreads = new Set<string>()

  private acceptSnapshot(incoming: AgentHostSnapshot): void {
    if (this.disposed) return
    const connecting = this.state.connection === 'connecting'
    // Sotto's own requests join the provider's before anything below reads the threads, so the attention queue
    // takes and keeps them the same way (ADR-0035).
    const snapshot = this.withSottoRequests(incoming)
    const previousProcessed = this.processedAssignmentThreads
    this.processedAssignmentThreads = new Set()
    const previousThreads = new Map(this.state.host.threads.map(thread => [thread.id, thread]))
    this.state.host = snapshot
    // Saved with the persist below; a disconnected snapshot changes no mark, so its early return loses nothing.
    this.finishedUnread.track(snapshot)
    this.scheduleProviderReconnects()
    if (this.state.activeProjectId) this.state.activeProjectId = this.dependencies.host.resolveProjectId?.(this.state.activeProjectId) ?? this.state.activeProjectId
    if (this.state.configuration.defaultModelId) this.state.configuration.defaultModelId = this.dependencies.host.resolveModelId?.(this.state.configuration.defaultModelId) ?? this.state.configuration.defaultModelId
    this.state.connection = snapshot.connected ? 'connected' : connecting ? 'connecting' : 'disconnected'
    if (!snapshot.connected) {
      if (!snapshot.providers && !connecting && this.state.configuration.enabled && enabledThreadProviders(this.state.configuration).length && !this.reconnect) this.reconnect = setTimeout(() => {
        this.reconnect = null
        // The answer is the shell, whose threads carry no history: marking the host disconnected reads
        // the live host instead, so a failed reconnect never empties the histories it holds.
        void this.commandShell({ type: 'connect' }).then(s => { if (s.connection !== 'connected') this.acceptSnapshot({ ...this.state.host, connected: false }) })
      }, 5000)
      this.publish(); return
    }
    if (this.reconnect) clearTimeout(this.reconnect)
    this.reconnect = null
    this.state.queue = this.state.queue.filter(item => this.keepPendingAttention(item, snapshot))
    if (this.attentionNarration && !this.state.queue.some(item => attentionItemKey(item) === this.attentionNarration)) {
      this.attentionNarration = null
      this.state.notice = ''; this.state.speech.text = ''
      this.state.voice.action = 'stop-speaking'; this.state.voice.revision += 1
    }
    for (const item of [...this.outbox]) {
      const thread = snapshot.threads.find(t => t.id === item.threadId)
      if (item.provider && snapshot.providers && snapshot.providers.find(provider => provider.id === item.provider)?.connection !== 'connected') continue
      if (thread && !isThreadProviderConnected(snapshot, thread)) continue
      const message = thread?.messages.find(m => m.role === 'user' && m.id === item.messageId)
      const confirmed = (item.type === 'send' || item.type === 'steer') ? Boolean(message) : item.type === 'create-project'
        ? snapshot.projects.some(p => p.id === (this.dependencies.host.resolveProjectId?.(item.entityId ?? '') ?? item.entityId)) : item.type === 'create-thread'
          ? snapshot.threads.some(t => t.id === item.entityId) : item.type === 'compact-thread'
            ? thread?.compaction?.commandId === item.id && ['completed', 'failed'].includes(thread.compaction.status) : item.type === 'configure-thread'
            ? thread !== undefined && item.options !== undefined && Object.entries(item.options).every(([key, value]) => thread[key as keyof AgentThread] === (key === 'modelId' && typeof value === 'string' ? this.dependencies.host.resolveModelId?.(value) ?? value : value)) : item.type === 'answer'
            ? thread !== undefined && isThreadProviderConnected(snapshot, thread) && thread.historyStatus !== 'loading' && thread.historyStatus !== 'error'
              && !thread.requests.some(r => r.id === item.requestId) : thread?.status === 'idle'
      if (!confirmed) continue
      if (item.type === 'configure-thread' && this.settingsDispatching.has(item.id)) this.settledSettings.add(item.id)
      // A disappeared question does not prove that our answer was accepted.
      // Only the exact adapter acknowledgement above can retire retained content.
      const turn = this.dispatchTurns.get(item.id)
      if (turn) this.feedbackReady.add(turn)
      // Match both representations while the selected skills, files and revision owner still exist.
      const savedDraft = this.state.threadDrafts?.find(d => d.threadId === this.state.draftThreadId && d.draftId === this.manualDraftId)
      const clearsLegacyDraft = message && (!item.draftId || item.draftId === this.manualDraftId) && this.state.draftThreadId === thread?.id && (item.draftDigest
        ? item.draftDigest === followupDigest({ text: this.state.draft, attachments: this.state.draftAttachments, skills: savedDraft?.skills, files: savedDraft?.files })
        : !this.state.draftAttachments?.length && this.state.draft.trim() === message.text)
      this.outbox = this.outbox.filter(o => o.id !== item.id)
      if (message && item.draftId && item.threadId) {
        this.setDelivery(item.threadId, item.draftId, 'accepted', { commandId: item.id, messageId: item.messageId })
        this.state.deliveredDrafts = [...(this.state.deliveredDrafts ?? []).filter(receipt => receipt.threadId !== item.threadId || receipt.draftId !== item.draftId),
          { threadId: item.threadId, draftId: item.draftId }].slice(-MAX_DELIVERED_DRAFTS)
        if (item.draftDigest) this.deliveredPromptDigests = [...this.deliveredPromptDigests.filter(r => r.threadId !== item.threadId || r.draftId !== item.draftId),
          { threadId: item.threadId, draftId: item.draftId, digest: item.draftDigest }].slice(-MAX_DELIVERED_DRAFTS)
        this.state.threadDrafts = (this.state.threadDrafts ?? []).filter(draft => draft.threadId !== item.threadId || draft.draftId !== item.draftId
          || item.draftDigest !== followupDigest(draft))
      }
      if (clearsLegacyDraft) {
        this.clearDraft()
      }
    }
    let announcedManualControl = false
    for (const assignment of this.state.assignments) {
      const thread = snapshot.threads.find(t => t.id === assignment.threadId)
      if (!thread || isThreadClosed(thread) || !isThreadProviderConnected(snapshot, thread)) continue
      this.processedAssignmentThreads.add(thread.id)
      const previousMessages = previousProcessed.has(thread.id) ? previousThreads.get(thread.id)?.messages ?? [] : []
      const restoredBoundary = previousMessages.length === 0 ? assignment.seenMessageIds.at(-1) : undefined
      const boundary = this.earlierMessageBoundaries.get(thread.id)
        ?? (restoredBoundary && thread.messages.some(message => message.id === restoredBoundary) ? restoredBoundary : undefined)
      const seenMessageIds = new Set([...assignment.seenMessageIds, ...previousMessages.map(message => message.id)])
      const fresh = thread.messages.slice(boundary ? thread.messages.findIndex(message => message.id === boundary) + 1 : 0)
        .filter(m => !seenMessageIds.has(m.id))
      if (fresh.length) assignment.contextUpdatedAt = Date.now()
      if (assignment.contextUpdatedAt < Date.now() - 7 * 86_400_000 && assignment.instruction) {
        assignment.instruction = ''; assignment.paused = true
      }
      if (fresh.some(m => m.role === 'user' && !assignment.ownMessageIds.includes(m.id))) {
        if (assignment.mode !== 'manual') {
          assignment.stopReason = 'none'; assignment.stoppedAt = ''
          this.say(`You're controlling ${thread.title}. I'll keep watching. Say “resume managing ${thread.title}” when you want me to take over again.`)
          announcedManualControl = true
        }
        assignment.mode = 'manual'
        this.state.queue = this.state.queue.filter(q => q.threadId !== thread.id || q.kind === 'question' || q.kind === 'permission')
      }
      const currentMessageIds = new Set(thread.messages.map(message => message.id))
      assignment.seenMessageIds = [...assignment.seenMessageIds.filter(id => !currentMessageIds.has(id)), ...currentMessageIds].slice(-MAX_SEEN_MESSAGE_IDS)
      assignment.ownMessageIds = assignment.ownMessageIds.slice(-1000)
      assignment.handledRequestIds = assignment.handledRequestIds.slice(-1000)
      for (const request of thread.requests) {
        if (assignment.handledRequestIds.includes(request.id)) continue
        if (request.kind === 'permission' || assignment.mode === 'manual' || assignment.paused) this.enqueue(thread, request.kind, request.text, request.id)
      }
      const last = thread.messages.at(-1)
      const question = thread.requests.find(r => r.kind === 'question' && !assignment.handledRequestIds.includes(r.id))
      const key = question?.id ?? (last?.role === 'assistant' ? last.id : null)
      const recovered = this.recoveredQueueIds.get(thread.id)
      if (key && recovered) {
        const matched = ['ready', 'question', 'blocked'].map(kind => `${thread.id}:${key}:${kind}`).filter(id => recovered.has(id))
        if (matched.length) this.considered.set(thread.id, key)
        // Restore each queued observation once, including another old question
        // exposed after answering the first. New identities remain eligible.
        for (const id of matched) recovered.delete(id)
        if (!recovered.size) this.recoveredQueueIds.delete(thread.id)
      }
      if (key && (question || (thread.status !== 'running' && last && Date.parse(last.createdAt) > Date.now() - 7 * 86_400_000)) && this.considered.get(thread.id) !== key) {
        if (assignment.mode === 'manual' || assignment.paused || !assignment.instruction || this.state.configuration.reasoning === 'none' || !this.state.configuration.enabled) {
          this.enqueue(thread, question ? 'question' : 'ready', question?.text ?? last?.text ?? 'Ready for your next prompt.', question?.id)
          this.considered.set(thread.id, key)
        } else void this.supervise(thread, assignment, key, question?.id)
      }
    }
    // Requests resolved directly in the host leave the queue; skipped requests stay pending.
    this.state.queue = this.state.queue.filter(item => this.keepPendingAttention(item, snapshot))
    this.pumpFollowups()
    this.generateTitles()
    if (!announcedManualControl) this.presentQueue(false)
    void this.persist().catch(() => {
      if (this.disposed) return
      this.state.assignments.forEach(a => { a.paused = true }); this.state.error = 'Agent state could not be saved. Management paused.'; this.publish()
    })
    this.publish()
  }
  private enqueue(thread: AgentThread, kind: AgentQueueItem['kind'], text: string, requestId?: string): void {
    const latest = this.state.host.threads.find(item => item.id === thread.id)
    if (!latest || isThreadClosed(latest)) return
    const id = `${thread.id}:${requestId ?? thread.messages.at(-1)?.id ?? 'idle'}:${kind}`
    const existing = this.state.queue.find(q => q.id === id)
    if (existing) { existing.text = text.slice(0, 12000); return }
    if (!requestId) this.state.queue = this.state.queue.filter(q => q.threadId !== thread.id || q.requestId)
    this.state.queue.push({ id, threadId: thread.id, kind, text: text.slice(0, 12000), ...(requestId ? { requestId } : {}), createdAt: new Date().toISOString(), deferred: false })
  }
  private presentQueue(force: boolean, selectionRevision = this.selectionRevision): void {
    if (selectionRevision !== this.selectionRevision) return
    if (force) this.queueSelectionPinned = false
    else if (this.queueSelectionPinned) return
    if (this.state.composing || !this.state.queue.length) return
    const current = this.state.queue.find(q => q.threadId === this.state.activeThreadId)
    if (!force && current && this.presentedQueueId === current.id) { this.narrateAttention(current); return }
    const first = this.state.queue[0]!
    this.presentedQueueId = first.id
    const thread = this.state.host.threads.find(t => t.id === first.threadId)
    if (!thread) return
    this.state.activeThreadId = thread.id; this.state.activeProjectId = thread.projectId
    this.narrateAttention(first)
  }
  private narrateAttention(item: AgentQueueItem): void {
    if (!isLiveAttention(item, this.state.host.threads)) return
    const key = attentionItemKey(item)
    if (this.narratedAttention.has(key)) return
    this.narratedAttention.add(key)
    const thread = this.thread(item.threadId)
    const project = this.state.host.projects.find(project => project.id === thread.projectId)
    this.say(`${project?.title ?? 'Project'}, ${thread.title}. ${item.text.slice(0, 600)}`)
    this.attentionNarration = key
  }
  private async supervise(thread: AgentThread, assignment: AgentAssignment, key: string, requestId?: string): Promise<void> {
    if (this.deciding.has(thread.id) || !this.state.configuration.enabled) return
    this.deciding.add(thread.id); this.considered.set(thread.id, key)
    let turn: ActiveTurn | undefined
    let failure: string | undefined
    try {
      if (assignment.followups >= this.state.configuration.followupLimit) {
        assignment.stopReason = 'limit'; assignment.stoppedAt = new Date().toISOString()
        assignment.paused = true; this.enqueue(thread, 'blocked', `The ${this.state.configuration.followupLimit} follow-up limit is reached. Review the thread and resume management to authorize more.`); return
      }
      this.canAct()
      turn = this.beginTurn({ source: 'supervision', commandType: 'decide', text: assignment.instruction, threadId: thread.id, projectId: thread.projectId })
      const retrievalStarted = Date.now()
      const preferences = this.readPreferences(assignment.instruction, thread.projectId, thread.id, turn)
      const intentStarted = Date.now()
      const decision = await this.dependencies.reasoner.decide(assignment.instruction, structuredClone(thread), preferences).catch(error => {
        if (turn) turn.failureCode = 'reasoning-failed'
        throw error
      })
        .finally(() => { if (turn) turn.intentMs = Date.now() - intentStarted })
      const current = this.state.assignments.find(a => a.threadId === thread.id)
      const latest = this.state.host.threads.find(t => t.id === thread.id)
      if (current !== assignment || current.mode !== 'managed' || current.paused || !latest || isThreadClosed(latest) || !isThreadProviderConnected(this.state.host, latest) || !this.state.configuration.enabled) return
      const latestKey = latest.requests.find(r => r.kind === 'question' && !current.handledRequestIds.includes(r.id))?.id ?? latest.messages.at(-1)?.id
      if (latestKey !== key || (!requestId && latest.status === 'running')) return
      if (decision.decision !== 'followup') {
        this.enqueue(thread, decision.decision === 'human' ? (requestId ? 'question' : 'blocked') : 'ready', decision.text, requestId); return
      }
      const failure = (thread.messages.at(-1)?.text ?? thread.requests.find(r => r.id === requestId)?.text ?? decision.text).toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
      const failureFingerprint = createHash('sha256').update(failure).digest('hex')
      if (!failure || failureFingerprint === assignment.lastFailure) {
        assignment.stopReason = 'repeat'; assignment.stoppedAt = new Date().toISOString()
        assignment.paused = true; this.enqueue(thread, 'blocked', 'The agent is repeating a failure without progress. Review the thread before resuming.'); return
      }
      if (turn) {
        turn.startedAtMs = retrievalStarted; turn.startedAt = new Date(retrievalStarted).toISOString()
        turn.commandType = 'send'; turn.text = decision.text
      }
      this.canAct()
      assignment.lastFailure = failureFingerprint; assignment.followups += 1
      await this.persist()
      // Refresh immediately before dispatch, so a direct host send revokes this queued reply.
      this.acceptSnapshot(await this.readThread(thread.id, undefined, { beforeSend: true }))
      const validate = (): void => {
        const current = this.state.assignments.find(item => item.threadId === thread.id)
        const live = this.state.host.threads.find(item => item.id === thread.id)
        if (this.disposed || !this.state.configuration.enabled || current !== assignment || current.mode !== 'managed' || current.paused || !live || isThreadClosed(live)
          || !isThreadProviderConnected(this.state.host, live) || !supportsAgentSupervision(capabilitiesForThread(this.state.host, live))) throw new SupersededSupervision('Management authority changed before dispatch.')
        if (requestId && live.requests.some(request => request.id === requestId && request.kind === 'permission')) {
          throw new Error('Permissions are never answered automatically. This request stays in your attention queue.')
        }
        const liveKey = live.requests.find(request => request.kind === 'question' && !current.handledRequestIds.includes(request.id))?.id ?? live.messages.at(-1)?.id
        if (liveKey !== key || live.requests.some(request => request.kind === 'permission')
          || (requestId ? !live.requests.some(request => request.id === requestId && request.kind === 'question') : live.requests.length > 0 || live.status === 'running')) {
          throw new SupersededSupervision('The thread changed before the automatic reply could be sent.')
        }
      }
      validate()
      if (requestId) {
        // Supervision answers questions only — never a permission, which `guardAuthority` refuses — and the
        // record says Sotto sent it rather than the user. Bookkeeping, not a grant.
        await this.dispatch({ type: 'answer', commandId: randomUUID(), threadId: thread.id, requestId, answer: decision.text },
          turn, validate, undefined, this.supervisionClient)
        assignment.handledRequestIds.push(requestId)
      } else {
        const messageId = randomUUID(); assignment.ownMessageIds.push(messageId)
        await this.dispatch({ type: 'send', commandId: randomUUID(), threadId: thread.id, messageId, text: decision.text, expectedLastUserMessageId: lastUserMessageIdOf(latest) }, turn, validate)
      }
    } catch (error) {
      if (error instanceof SupersededSupervision) { failure = error.message; return }
      if (this.disposed) return
      assignment.paused = true
      assignment.stopReason = 'error'; assignment.stoppedAt = new Date().toISOString()
      failure = error instanceof Error ? error.message : 'Sotto needs your attention to continue.'
      this.enqueue(thread, 'blocked', failure)
    } finally {
      await this.persist().catch(error => {
        if (this.disposed) return
        assignment.paused = true
        if (assignment.stopReason === 'none') {
          assignment.stopReason = 'error'; assignment.stoppedAt = new Date().toISOString()
        }
        if (turn) turn.failureCode = 'storage-failed'
        failure = error instanceof Error ? error.message : 'Could not save agent state.'
        this.enqueue(thread, 'blocked', failure)
      })
      await this.finishTurn(turn, failure)
      this.deciding.delete(thread.id)
      // A newer event may have arrived while this lane awaited reasoning,
      // dispatch, or persistence. Reconsider current state once the lane is free.
      if (isThreadProviderConnected(this.state.host, thread) && this.state.assignments.includes(assignment) && assignment.mode === 'managed' && !assignment.paused) {
        this.acceptSnapshot(this.state.host)
      } else this.presentQueue(false)
      this.publish()
    }
  }
  private disconnect(): void {
    if (this.reconnect) clearTimeout(this.reconnect)
    this.reconnect = null
    for (const timer of this.providerReconnect.values()) clearTimeout(timer)
    this.providerReconnect.clear()
    this.dependencies.host.disconnect()
    this.state.connection = 'disconnected'; this.state.host.connected = false
  }
  private scheduleProviderReconnects(): void {
    const retryable = (provider: ProviderId): boolean => !this.disposed
      && enabledThreadProviders(this.state.configuration).includes(provider)
      && this.state.host.providers?.find(status => status.id === provider)?.connection === 'disconnected'
    for (const provider of providerIdSchema.options) {
      const timer = this.providerReconnect.get(provider)
      if (!retryable(provider)) {
        if (timer) clearTimeout(timer)
        this.providerReconnect.delete(provider)
      } else if (!timer) {
        // A stopped transport retries independently; account/discovery errors remain manual Retry.
        this.providerReconnect.set(provider, setTimeout(() => {
          this.providerReconnect.delete(provider)
          if (retryable(provider)) void this.commandShell({ type: 'connect', provider })
        }, 5000))
      }
    }
  }
  /** Called after disconnecting providers, before the headless process releases its stores. */
  async closed(): Promise<void> {
    await Promise.allSettled([...this.activeCommands, this.serial, ...this.threadActions.values(), ...this.titleWrites])
    await this.persist(true)
  }
  dispose(): void {
    this.disposed = true
    // A held broadcast dies with the control: its listeners are going away, and a run that
    // escapes the cancel still finds `disposed` and does nothing.
    this.broadcastCancel?.()
    this.broadcastCancel = null
    this.broadcastOpen = false
    this.broadcastPending = false
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
    this.unsubscribe?.()
    this.unsubscribeSottoRequests?.()
    // Updates still waiting in the line never start; whoever waits for one is told rather than left waiting.
    this.clientLine.length = 0
    for (const [provider, waiting] of this.clientWaiters) {
      const said = provider === this.updatingClient ? 'Sotto stopped while the update ran. Check the client\'s version when Sotto is back.' : 'Sotto is stopping. The update did not start.'
      for (const waiter of waiting) waiter.reject(new Error(said))
    }
    this.clientWaiters.clear()
    this.disconnect()
    this.listeners.clear()
    this.detailListeners.clear()
    this.detailSnapshots.clear()
  }
}

/**
 * One broadcast per animation frame. Below what a person can see, so no state looks late, and
 * far fewer full copies of every thread's history than a streaming provider would otherwise force.
 */
export const AGENT_STATE_BROADCAST_INTERVAL_MS = 16

/**
 * A provider frame publishes the whole agent state, and Claude emits dozens of frames a
 * second, so the renderer and the widget each revalidate every thread's history that often.
 * 50ms caps that at 20 sends a second: still faster than the ~100ms a person reads as
 * instant, and the first state of a burst is never held back at all.
 */
export const AGENT_STATE_PUBLISH_INTERVAL_MS = 50
/** Schedules a deferred run and returns its cancel; injectable so tests own the clock. */
export type PublishScheduler = (run: () => void, ms: number) => () => void
export interface CoalescedAgentStatePublisher {
  publish(state: AgentState): void
  /** Deliver a held state now, for a caller that must not wait out the interval. */
  flush(): void
  dispose(): void
}
const realPublishScheduler: PublishScheduler = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}
/**
 * Coalesces agent-state sends at the IPC boundary rather than inside AgentControl, so
 * in-process listeners (the checkpoint observer) still see every intermediate state and
 * command responses still carry the exact state their command produced.
 */
export function coalesceAgentStatePublishes(send: (state: AgentState) => void,
  options: { intervalMs?: number; schedule?: PublishScheduler } = {}): CoalescedAgentStatePublisher {
  const intervalMs = options.intervalMs ?? AGENT_STATE_PUBLISH_INTERVAL_MS
  const schedule = options.schedule ?? realPublishScheduler
  let cancel: (() => void) | null = null
  let pending: AgentState | null = null
  let disposed = false
  const sendNow = (state: AgentState): void => {
    cancel?.()
    pending = null
    send(state)
    // Keep the window open after every send: a burst that continues must coalesce, and the
    // last state of one always reaches the renderer on this trailing run.
    cancel = schedule(() => { cancel = null; if (pending) sendNow(pending) }, intervalMs)
  }
  return {
    publish: state => {
      if (disposed) return
      // Only the newest state survives an open window, so no stale state follows a newer one.
      if (cancel) pending = state
      else sendNow(state)
    },
    flush: () => { if (!disposed && pending) sendNow(pending) },
    dispose: () => { disposed = true; cancel?.(); cancel = null; pending = null },
  }
}

export interface CoalescedThreadDetailPublisher {
  publish(update: AgentThreadDetailUpdate): void
  dispose(): void
}
/**
 * The same coalescing at the IPC boundary as the shell, but per thread: two threads streaming at once
 * must not hold each other's history back, and only the newest revision of each one reaches the window.
 *
 * A delta cannot simply be dropped the way a whole detail can — the window applies it to the revision it
 * holds — so a lane folds what is waiting into one update where it can (two appends to one message become
 * one) and keeps them in order where it cannot. Whole details still supersede everything before them.
 * A lane that goes quiet is dropped; the next update opens a fresh one.
 */
export function coalesceAgentThreadDetailPublishes(send: (update: AgentThreadDetailUpdate) => void,
  options: { intervalMs?: number; schedule?: PublishScheduler } = {}): CoalescedThreadDetailPublisher {
  const intervalMs = options.intervalMs ?? AGENT_STATE_PUBLISH_INTERVAL_MS
  const schedule = options.schedule ?? realPublishScheduler
  // `sending` holds back an update published while the lane is sending, such as the change a whole read
  // made inside `send` flushes first: sent at once it would reach later listeners ahead of the one being sent.
  const lanes = new Map<string, { cancel: (() => void) | null; pending: AgentThreadDetailUpdate[]; sending?: boolean }>()
  let disposed = false
  const flushLane = (threadId: string): void => {
    const lane = lanes.get(threadId) ?? { cancel: null, pending: [] }
    lanes.set(threadId, lane)
    lane.cancel?.()
    const queued = lane.pending
    lane.pending = []
    lane.sending = true
    try { for (const update of queued) send(update) } finally { lane.sending = false }
    if (disposed) return
    lane.cancel = schedule(() => { lane.cancel = null; if (lane.pending.length > 0) flushLane(threadId); else lanes.delete(threadId) }, intervalMs)
  }
  return {
    publish: update => {
      if (disposed) return
      const lane = lanes.get(update.threadId)
      if (lane?.cancel || lane?.sending) {
        const held = lane.pending.at(-1)
        const merged = held === undefined ? null : mergeAgentThreadDetailUpdates(held, update)
        if (merged === null) lane.pending.push(update)
        else lane.pending[lane.pending.length - 1] = merged
        return
      }
      const open = lane ?? { cancel: null, pending: [] }
      lanes.set(update.threadId, open)
      open.pending.push(update)
      flushLane(update.threadId)
    },
    dispose: () => { disposed = true; for (const lane of lanes.values()) lane.cancel?.(); lanes.clear() },
  }
}
