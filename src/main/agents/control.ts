import type { AgentSkillReference } from '../../shared/agentSkills'
import type { AgentFileReference } from '../../shared/agentFiles'
import type { AgentActivity } from '../../shared/agentActivity'
import { FollowupStore, followupDigest } from './followups'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  agentAssignmentSchema, agentConfigurationSchema, agentQueueItemSchema, agentAttachmentsSchema, agentThreadOptionsSchema, agentThreadDraftSchema, agentDeliverySchema,
  providerUpgradeSchema, defaultAgentConfiguration, EMPTY_AGENT_HOST, PROVIDER_LABELS, supportsAgentSupervision, isSubscriptionReasoning, agentDeliveryReceiptsSchema, MAX_DELIVERED_DRAFTS, enabledThreadProviders, defaultThreadModelId, capabilitiesForThread, isThreadProviderConnected, providerIdSchema, threadSummaryOf,
  type AgentMessage, type AgentThreadDetail, type AgentThreadDetailDelta, type AgentThreadDetailUpdate, type ProviderId, type AgentAttachment, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult, type AgentAssignment, type AgentCommand, type AgentConfiguration, type AgentDelivery, type AgentThreadDraft, type AgentHostSnapshot, type AgentQueueItem, type AgentState, type AgentThread, type SubscriptionProvider,
} from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { MemoryProfile } from '../memory/profile'
import type { AgentCredentials } from './credentials'
import { approvalWords, classifyRiskyAction, denialWords, mayGrantLocally, UNPAIRED_CLIENT_ERROR, type Authority } from './authority'
import { desktopWindowClient, supervisionClient, type ClientIdentity } from './hostService'
import type { AgentHost, AgentHostCommand } from './host'
import type { AgentPreference, AgentReasoner } from './reasoning'
import { addTurnContext, type ActiveTurn, type TurnRecorder } from './turns'
import { isThreadArchived, isThreadClosed, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { attentionItemKey, isLiveAttention } from '../../shared/agentAttention'
import { maintainProviderRecovery, retireLegacyProvider, stripRetiredEndpoint } from './providerRetirement'
import { validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { AttachmentPreviews } from './attachmentPreviews'
import type { ThreadTitleExchange } from '../llm/threadTitle'
import { requestQuestionsDigest, type BindRequestDraftDecision } from './requestDrafts'
import { requestDraftProvider } from '../../shared/requestDrafts'
import { agentActivitySignature, applyAgentThreadDetailDelta, diffAgentThreadDetail, mergeAgentThreadDetailUpdates } from '../../shared/agentThreadDetail'

/** One shared empty array stands in for every shell thread's history; the clone that follows copies nothing. */
const EMPTY_MESSAGES: AgentMessage[] = []
const EMPTY_ACTIVITIES: AgentActivity[] = []
const RECORDED_COMMAND_TYPES: ReadonlySet<AgentCommand['type']> = new Set([
  'utterance', 'connect', 'refresh', 'send', 'steer', 'manual-send', 'answer', 'create-thread', 'create-project', 'select-project',
  'select-thread', 'select-attention', 'assign', 'unassign', 'resume', 'pause', 'interrupt', 'next', 'later',
  'cancel-draft', 'pause-draft', 'resume-draft', 'cancel-request', 'configure-thread-working-copy', 'configure-thread', 'compact-thread',
])
/**
 * The commands that name one thread and act only on it. Each runs in that thread's own lane, so an
 * action on one thread never waits on an action on another, nor on the global lane.
 *
 * Everything else keeps the one global lane, including commands that carry a `threadId` but reach
 * past the thread they name:
 * - `assign`, `unassign`, `resume`, `pause` move assignment authority and hand the single composer
 *   draft to or from management, which supervision reads across every thread.
 * - `recover-draft` and `resume-draft` rebind that same single composer draft.
 * - `create-thread` has no existing thread to key a lane on, and it also takes the selection.
 * - `settle-project` and `restore-project` move every thread of a project at once.
 * `interrupt`, `select-thread`, `save-thread-draft`, `refresh-thread-skills` and the follow-up queue
 * edits are thread-scoped too, and are absent here because they never enter a lane at all: each one
 * answers before a lane is chosen, which is already the behaviour this list gives the rest, so none of
 * them waits on the global lane or on another thread. They are unchanged.
 */
const THREAD_SCOPED_COMMAND_TYPES: ReadonlySet<AgentCommand['type']> = new Set([
  'manual-send', 'steer', 'answer', 'configure-thread-working-copy', 'configure-thread', 'compact-thread',
  'settle-thread', 'restore-thread', 'retry-thread-worktree', 'refresh-thread-worktree', 'open-thread-folder', 'restore-thread-branch',
  'load-earlier-messages',
])

const savedSchema = z.object({
  providerUpgrade: providerUpgradeSchema.nullable().default(null),
  configuration: z.preprocess(value => typeof value === 'object' && value !== null
    ? { ...defaultAgentConfiguration(), ...stripRetiredEndpoint(value) } : value, agentConfigurationSchema),
  assignments: z.array(agentAssignmentSchema), queue: z.array(agentQueueItemSchema),
  activeThreadId: z.string().nullable(), activeProjectId: z.string().nullable(), draft: z.string(), draftThreadId: z.string().nullable(),
  draftRequestId: z.string().nullable().default(null),
  draftAttachments: agentAttachmentsSchema.default([]),
  manualDraftId: z.uuid().nullable().default(null),
  deliveredDrafts: agentDeliveryReceiptsSchema.default([]),
  deliveredPromptDigests: z.array(z.object({ threadId: z.string(), draftId: z.uuid(), digest: z.string() })).default([]),
  answeredRequests: z.array(z.object({ threadId: z.string(), provider: providerIdSchema, requestId: z.string(), questionsDigest: z.string(), decisionId: z.string().optional() })).max(MAX_DELIVERED_DRAFTS).default([]),
  threadDrafts: z.array(agentThreadDraftSchema).default([]),
  deliveries: z.array(agentDeliverySchema).default([]),
  pendingRequest: z.string().max(20_000).default(''),
  contextSavedAt: z.number().default(0),
  coordinatorConversation: z.boolean().default(false),
  composing: z.boolean(), outbox: z.array(z.object({
    id: z.string(), type: z.enum(['send', 'steer', 'create-project', 'create-thread', 'configure-thread', 'answer', 'interrupt', 'compact-thread']),
    provider: providerIdSchema.optional(),
    threadId: z.string().optional(), messageId: z.string().optional(), entityId: z.string().optional(), requestId: z.string().optional(),
    options: agentThreadOptionsSchema.optional(), draftDigest: z.string().optional(), draftId: z.uuid().optional(),
    questionsDigest: z.string().optional(),
  })),
})
type Saved = z.infer<typeof savedSchema>
class SupersededSupervision extends Error {}
const PRIVACY_CLEANUP_ERROR = 'Could not finish applying history privacy. Sotto will retry when local storage is available.'
/**
 * The first thing asked of a thread and the first answer it got, the only content a generated title is
 * written from. Automatic naming needs the thread to be at its first exchange and settled: a running turn
 * has no finished reply yet, and a thread that has moved on was named or left alone long ago. A requested
 * Regenerate still reads the same first exchange out of a longer history.
 */
function firstExchange(thread: AgentThread, trigger: 'automatic' | 'requested', messages: readonly AgentMessage[]): ThreadTitleExchange | null {
  if (trigger === 'automatic' && (thread.status === 'running' || messages.filter(message => message.role === 'user').length !== 1)) return null
  const prompt = messages.findIndex(message => message.role === 'user' && message.text.trim().length > 0)
  if (prompt === -1) return null
  const reply = messages.slice(prompt + 1).find(message => message.role === 'assistant' && message.text.trim().length > 0)
  if (!reply) return null
  return { prompt: messages[prompt]!.text, reply: reply.text }
}

export interface AgentMembership {
  status(): Promise<AgentState['membership']>
  action(action: 'refresh' | 'signin' | 'checkout' | 'portal'): Promise<AgentState['membership']>
}

/** Owns assignment authority, queue ordering and durable dispatch intent across all host adapters. */
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
  // What the last successful write put on disk. A provider frame that changed no saved fact costs no
  // write. An identical write queued while another is still in flight is not deduplicated on purpose: a
  // persist that skipped it would have to wait on a write it did not issue, and the queue drains it anyway.
  private lastWritten = ''
  private readonly attachmentPreviews: AttachmentPreviews
  private readonly listeners = new Set<(state: AgentState) => void>()
  private readonly deciding = new Set<string>()
  private readonly considered = new Map<string, string>()
  private readonly recoveredQueueIds = new Map<string, Set<string>>()
  private readonly accountChecks = new Map<SubscriptionProvider, Promise<void>>()
  private serial: Promise<unknown> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private reconnect: ReturnType<typeof setTimeout> | null = null
  private readonly providerReconnect = new Map<ProviderId, ReturnType<typeof setTimeout>>()
  private retirementFailure: string | null = null
  private disposed = false
  private membershipTimer: ReturnType<typeof setInterval> | null = null
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
  private deliveredPromptDigests: Saved['deliveredPromptDigests'] = []
  private answeredRequests: Saved['answeredRequests'] = []
  /** Ephemeral view interest; never persisted, selected or granted assignment authority. */
  private viewedThreadIds: readonly string[] = []
  private readonly dispatchTurns = new Map<string, ActiveTurn>()
  private readonly feedbackReady = new Set<ActiveTurn>()
  private broadcastCancel: (() => void) | null = null
  private broadcastOpen = false
  private broadcastPending = false
  private readonly detailListeners = new Set<(update: AgentThreadDetailUpdate) => void>()
  /** Per thread: the signature of the messages last handed out, and the revision that stands for them. */
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
  /** The desktop window on this machine: the only client there is, and what an unattributed call means. */
  private readonly localClient: ClientIdentity = desktopWindowClient()
  /** Sotto's own supervision, so a recorded answer shows it came from Sotto and not from the user. */
  private readonly supervisionClient: ClientIdentity = supervisionClient(this.localClient.user)
  constructor(private readonly dependencies: {
    directory: string; host: AgentHost; credentials: AgentCredentials; reasoner: AgentReasoner; membership: AgentMembership
    bindRequestDraftDecision?: BindRequestDraftDecision
    historyEnabled?: () => boolean
    /** Whether the voice coordinator ships. Off, no thread stays managed across a start (ADR-0012). */
    coordinatorEnabled?: () => boolean
    turns?: TurnRecorder
    authority?: Authority
    preferences?: Pick<MemoryProfile, 'retrieve'>
    openThreadFolder?: (path: string) => Promise<void>
    /**
     * Writes a thread's name from its first exchange. `null` leaves the thread the name it has,
     * which is also what an off switch, a missing key and every failure resolve to. Absent here
     * means no thread is ever named by Sotto.
     */
    writeThreadTitle?: (exchange: ThreadTitleExchange) => Promise<string | null>
    /** Local record of a silent failure; never a banner, never shown to the user. */
    logFailure?: (code: string, detail: string) => void
    /** Defers a coalesced broadcast; injectable so tests own the clock. */
    schedule?: PublishScheduler
  }) {
    this.followupStore = new FollowupStore(dependencies.directory)
    this.state = {
      configuration: defaultAgentConfiguration(), connection: 'disconnected', host: structuredClone(EMPTY_AGENT_HOST),
      assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
      draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [],
      pendingRequest: '',
      globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
      voice: { status: 'off', error: null, action: 'none', revision: 0 },
      credentials: { reasoning: false, grokSpeech: false, secure: false },
      reasoningAccounts: [],
      membership: { status: 'free', label: 'Free dictation', expiresAt: null },
    }
    this.store = new AtomicJsonStore(join(dependencies.directory, 'agents.json'), savedSchema.parse, () => this.saved())
    this.attachmentPreviews = new AttachmentPreviews(dependencies.directory, () => dependencies.historyEnabled?.() !== false)
  }
  async start(): Promise<void> {
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
    this.persistedDrafts = this.draftSignatures(saved.threadDrafts)
    await this.attachmentPreviews.load()
    this.contextActivityAt = saved.contextSavedAt
    const { outbox, contextSavedAt, coordinatorConversation, manualDraftId, deliveredPromptDigests, answeredRequests, ...restored } = saved
    this.coordinatorConversation = coordinatorConversation
    this.queueSelectionPinned = coordinatorConversation
    this.deliveredPromptDigests = deliveredPromptDigests
    this.answeredRequests = answeredRequests
    this.manualDraftId = manualDraftId
    Object.assign(this.state, restored)
    // Upgrade the native singleton in place, never from the currently selected thread.
    this.syncLegacyDraft()
    await this.followupStore.load()
    this.syncFollowups()
    await this.dependencies.host.initialize?.()
    if (this.dependencies.host.workspaceSnapshot) this.state.host = this.dependencies.host.workspaceSnapshot()
    const cutoff = Date.now() - 7 * 86_400_000
    const historyDisabled = this.dependencies.historyEnabled?.() === false
    for (const assignment of this.state.assignments) {
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
        ? item.draftDigest === this.promptDigest(draft.text, draft.attachments, draft.skills, draft.files) : draft.requestId === null))?.draftId ?? randomUUID()
      this.setDelivery(item.threadId, item.draftId, 'uncertain', { commandId: item.id, messageId: item.messageId })
    }
    // Redaction also reaches disk when control is disabled and no reconnect will run.
    await this.persist()
    this.state.membership = await this.dependencies.membership.status()
    this.membershipTimer = setInterval(() => {
      const pendingPrivacy = this.privacyCleanupPending
      void (pendingPrivacy ? this.privacyChanged() : this.attachmentPreviews.maintain()).catch(() => {
        this.state.error = pendingPrivacy ? PRIVACY_CLEANUP_ERROR : 'Could not apply attachment preview retention. Check access to local storage.'
        this.publish()
      })
      void this.dependencies.membership.status().then(status => {
        this.state.membership = status
        if (!['active', 'beta'].includes(status.status)) this.state.assignments.forEach(a => { a.paused = true })
        this.publish()
      }).catch(() => undefined)
    }, 30_000)
    this.updateCredentials()
    if (isSubscriptionReasoning(this.state.configuration.reasoning)) {
      // Native login/model discovery must not hold up dictation or the desktop window.
      void this.checkReasoning(this.state.configuration.reasoning).then(() => this.publish())
    }
    // Subscribe before the first observe: telling the workspace which threads are open now makes it
    // load their history, and that publish has to reach this coordinator (issue #119).
    this.unsubscribe = this.dependencies.host.subscribe(snapshot => this.acceptSnapshot(snapshot))
    this.observe()
    if (this.state.configuration.enabled || (this.dependencies.host.concurrentProviders && this.state.configuration.enabledProviders?.length)) {
      const connection = this.command({ type: 'connect' })
      if (!this.dependencies.host.concurrentProviders) await connection
      // Independent native discovery must not delay constructing the desktop IPC surface.
      else void connection
    }
  }
  hasPendingThreadWork(threadId: string): boolean {
    return this.outbox.some(item => item.threadId === threadId)
      || this.followupStore.get().items.some(item => item.threadId === threadId)
      || this.state.assignments.some(item => item.threadId === threadId && item.mode === 'managed' && !item.paused)
      || (this.state.deliveries ?? []).some(item => item.threadId === threadId && ['queued', 'submitting', 'uncertain'].includes(item.status))
  }
  get(): AgentState {
    const state = structuredClone(this.state)
    state.threadDraftPersistence = this.draftPersistence()
    state.historyEnabled = this.dependencies.historyEnabled?.() !== false
    if (this.busyThreads.size) state.busyThreadIds = [...this.busyThreads.keys()]
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
  shell(): AgentState {
    const threads = this.state.host.threads
    const bare = { ...this.state, host: { ...this.state.host, threads: threads.map(thread => ({
      ...thread, messages: EMPTY_MESSAGES,
      ...(thread.activities === undefined ? {} : { activities: EMPTY_ACTIVITIES }),
      summary: threadSummaryOf(thread),
    })) } }
    const state = structuredClone(bare)
    state.threadDraftPersistence = this.draftPersistence()
    state.historyEnabled = this.dependencies.historyEnabled?.() !== false
    if (this.busyThreads.size) state.busyThreadIds = [...this.busyThreads.keys()]
    return state
  }
  /**
   * One thread's history — its messages and the activity beside them — for a window looking at it.
   * Handing out a whole detail also resets what the deltas that follow are measured from: a window that
   * asked for this one holds exactly this revision, so the next delta is the one that follows it.
   */
  threadDetail(threadId: string): AgentThreadDetail | null {
    const thread = this.state.host.threads.find(item => item.id === threadId)
    if (!thread) return null
    const revision = this.detailRevision(thread)
    const messages = structuredClone(thread.messages)
    // Nothing decorates or edits an activity record on either side of the bridge, so the snapshot and the
    // detail share one copy of it. Messages cannot be shared: decoration rewrites their attachments.
    const activities = thread.activities === undefined ? undefined : structuredClone(thread.activities)
    // The snapshot is the undecorated history: decoration is a fact about the preview store rather than
    // about the thread, and diffing decorated against live would report every image message as changed.
    this.detailSnapshots.set(threadId, { threadId, revision, messages: structuredClone(thread.messages),
      ...(activities === undefined ? {} : { activities }) })
    this.publishedDetail.set(threadId, revision)
    this.attachmentPreviews.decorate({ ...this.state.host, threads: [{ ...thread, messages }] })
    return { threadId, revision, messages, ...(activities === undefined ? {} : { activities }),
      ...(thread.earlierAvailable ? { earlierAvailable: true } : {}) }
  }
  /** Which threads main pushes detail for: what the window says it is looking at, plus work it must see land. */
  private detailTargets(): string[] {
    return [...new Set([
      ...(this.state.activeThreadId ? [this.state.activeThreadId] : []),
      ...this.viewedThreadIds,
      ...(this.state.deliveries ?? []).filter(item => item.status !== 'accepted').map(item => item.threadId),
      ...this.followupStore.get().items.map(item => item.threadId),
      ...this.outbox.flatMap(item => item.threadId ? [item.threadId] : []),
    ])].filter(id => this.state.host.threads.some(thread => thread.id === id))
  }
  /**
   * A revision that changes exactly when a thread's messages do. Built from identity and length rather
   * than the text itself: a streaming chunk must bump it without the cost of copying every message.
   */
  private detailRevision(thread: AgentThread): number {
    const signature = `${thread.historyEpoch ?? ''}|${thread.messages.length}|` + thread.messages
      .map(message => `${message.id}:${message.text.length}:${message.attachments?.length ?? 0}`).join(',')
      + `|${(thread.activities ?? []).map(record => `${record.id}:${agentActivitySignature(record)}`).join(',')}`
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
  /** One submitted image, fetched by the window when it draws the tile rather than pushed with every state. */
  attachmentPreview(request: AgentAttachmentPreviewRequest): AgentAttachmentPreviewResult {
    const dataUrl = this.attachmentPreviews.preview(this.state.host, request.threadId, request.messageId, request.attachmentId)
    return dataUrl === null ? null : { dataUrl }
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
      () => this.attachmentPreviews.maintain(),
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
  private async persist(): Promise<void> {
    if (this.retirementFailure) throw new Error(this.retirementFailure)
    const saved = this.saved()
    const serialized = JSON.stringify(saved)
    if (serialized !== this.lastWritten) {
      const drafts = this.draftSignatures(saved.threadDrafts)
      this.pendingDraftWrites.add(drafts)
      try {
        await this.store.write(saved)
        // AtomicJsonStore serializes writes. Confirm only the snapshot that actually
        // completed, never newer state that changed while this write was outstanding.
        this.persistedDrafts = drafts
        this.lastWritten = serialized
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
  private draftSignatures(drafts: readonly AgentThreadDraft[]): Map<string, string> {
    return new Map(drafts.map(({ threadId, draftId, text, attachments, skills, files, requestId }) => [threadId,
      createHash('sha256').update(JSON.stringify({ draftId, text, attachments, skills, files, requestId })).digest('hex')]))
  }
  /**
   * Records this moment's feedback evidence, then asks for a broadcast. A provider emits dozens of
   * frames a second and every one of them publishes, so the broadcast itself — the full copy of
   * every thread's history each listener receives — coalesces onto one run per window. Commands
   * that `return this.get()` are untouched: their caller still gets the state its command produced.
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
      const delta = diffAgentThreadDetail(held, thread, revision)
      const advanced = delta === null ? null : applyAgentThreadDetailDelta(held, delta)
      if (delta !== null && advanced !== null) {
        this.detailSnapshots.set(thread.id, advanced)
        this.publishedDetail.set(thread.id, revision)
        return this.decorateDetailDelta(thread, delta)
      }
    }
    return this.threadDetail(thread.id)
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
  private observe(...threadIds: string[]): void {
    this.dependencies.host.observeThreads?.([...new Set([...this.state.assignments.map(a => a.threadId),
      ...(this.state.activeThreadId ? [this.state.activeThreadId] : []),
      ...this.viewedThreadIds.filter(id => this.state.host.threads.some(thread => thread.id === id)),
      ...this.followupStore.get().items.map(item => item.threadId), ...this.outbox.flatMap(item => item.threadId ? [item.threadId] : []), ...threadIds])])
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
    this.acceptSnapshot(await this.readThread(threadId))
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
  private canAct(threadId?: string): void {
    if (!['active', 'beta'].includes(this.state.membership.status)) throw new Error('Agent actions require an active Sotto membership. Free dictation remains available.')
    if (this.state.membership.expiresAt && Date.parse(this.state.membership.expiresAt) <= Date.now()) throw new Error('Refresh your Sotto membership before starting more agent actions. Existing provider work continues.')
    if (threadId && !isThreadProviderConnected(this.state.host, this.thread(threadId))) throw new Error('Reconnect this thread provider before sending. Your draft is saved.')
    if (!this.state.host.connected) throw new Error('Reconnect the provider before sending. Your draft is saved.')
  }
  private canCreate(provider?: ProviderId): void {
    this.canAct()
    if (this.outbox.some(item => (item.type === 'create-project' || item.type === 'create-thread') && (!provider || (item.provider ?? this.state.configuration.provider) === provider))) {
      throw new Error('An earlier creation has an unknown result. Reconnect and inspect the provider before creating anything else; select the existing project or thread if it appears.')
    }
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
      const draft = agentThreadDraftSchema.parse({ ...command, attachments: command.attachments ?? [],
        requestId: command.requestId ?? null, updatedAt: new Date().toISOString() })
      if (!this.state.threadDrafts?.some(item => item.threadId === draft.threadId)) this.thread(draft.threadId)
      if (this.state.followupReceipts?.some(item => item.threadId === draft.threadId && item.draftId === draft.draftId) || this.state.deliveredDrafts?.some(item => item.threadId === draft.threadId && item.draftId === draft.draftId)) return this.get()
      const submitted = this.state.deliveries?.find(item => item.threadId === draft.threadId && item.draftId === draft.draftId)
      if (submitted && submitted.status !== 'failed') throw new Error('Use a new draft revision when editing a submitted prompt.')
      const previous = this.state.threadDrafts?.find(item => item.threadId === draft.threadId)
      const sameRevision = previous ? previous.draftId === draft.draftId && previous.text === draft.text && previous.requestId === draft.requestId
        && this.promptDigest(previous.text, previous.attachments, previous.skills, previous.files) === this.promptDigest(draft.text, draft.attachments, draft.skills, draft.files)
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
      this.state.error = null
      await this.persist().catch(() => { throw new Error('Could not save this thread draft. Keep your text and images and retry when storage is available.') })
    } catch (error) { this.state.error = error instanceof z.ZodError ? 'Choose valid draft text and images before saving.' : error instanceof Error ? error.message : 'Could not save this thread draft.' }
    this.publish()
    return this.get()
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
    this.publish(); return this.get()
  }
  /**
   * The thread's new name. It is a state edit alone: no native work is started, interrupted or queued
   * behind, so a thread can be renamed while its agent is still working.
   */
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
    } catch (error) { this.state.error = error instanceof Error ? error.message : 'Could not rename this thread.' }
    this.publish()
    return this.get()
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
      // A thread's history lives in the store, so read it only when this thread has said something new:
      // otherwise a thread that will never be named would be read on every provider frame.
      const messageCount = threadSummaryOf(thread).messageCount
      if (messageCount < 2 || this.titleChecked.get(thread.id) === messageCount) continue
      this.titleChecked.set(thread.id, messageCount)
      const exchange = firstExchange(thread, 'automatic', this.threadHistory(thread))
      if (!exchange) continue
      this.titled.add(thread.id)
      void this.writeThreadTitle(thread.id, exchange)
    }
  }
  /** A thread's whole history: what the pane holds when that is all of it, else the store's own copy. */
  private threadHistory(thread: AgentThread): readonly AgentMessage[] {
    if (thread.messages.length > 0 && thread.earlierAvailable !== true) return thread.messages
    return this.dependencies.host.threadMessages?.(thread.id) ?? thread.messages
  }
  /** Asks for the name and applies it, unless the thread was renamed by hand while the answer was in flight. */
  private async writeThreadTitle(threadId: string, exchange: ThreadTitleExchange): Promise<void> {
    try {
      const title = await this.dependencies.writeThreadTitle!(exchange)
      if (title === null) return
      const thread = this.state.host.threads.find(item => item.id === threadId)
      if (!thread || thread.titleSource === 'user' || isThreadArchived(thread) || thread.title === title) return
      this.acceptSnapshot(await this.dependencies.host.renameThread!(threadId, title, 'generated'))
      await this.persist()
    } catch (error) {
      // A name Sotto offered to write is never worth an error banner: the thread keeps the name it has.
      this.dependencies.logFailure?.('thread-title-failed', error instanceof Error ? error.message : 'unknown')
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
    return this.get()
  }
  /**
   * One client's command. `client` says who sent it, for the record an answer leaves and for the
   * policy check that decides whether a remote client's answer counts as a grant. Absent means the
   * desktop window on this machine, which is the only client that exists today.
   */
  command(command: AgentCommand, client: ClientIdentity = this.localClient): Promise<AgentState> {
    if (command.type !== 'manual-send' && command.type !== 'steer' && command.type !== 'queue-followup') return this.commandUnreserved(command, client)
    const prompt = structuredClone({ ...command, draftId: command.draftId ?? randomUUID() })
    const { threadId, draftId } = prompt
    const key = JSON.stringify([threadId, draftId])
    const digest = this.promptDigest(prompt.text, prompt.attachments, prompt.skills)
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
        this.publish(); return Promise.resolve(this.get())
      }
      if (pending) return pending.task
      if (queued || receipt || delivered || prompt.type === 'queue-followup') return Promise.resolve(this.get())
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
    if (this.retirementFailure) { this.state.error = this.retirementFailure; return Promise.resolve(this.get()) }
    // Provider discovery has independent progress; a stalled account must not own the thread command lane.
    if ((command.type === 'connect' || command.type === 'disconnect' || command.type === 'refresh') && (command.provider || this.dependencies.host.concurrentProviders)) return this.providerCommand(command)
    if (command.type === 'refresh-thread-skills') return this.refreshThreadSkills(command.threadId, command.forceReload)
    // Selection owns no action authority and must not wait for provider actions.
    if (command.type === 'select-thread') return this.navigate(command.threadId)
    if (command.type === 'observe-threads') {
      this.viewedThreadIds = [...new Set(command.threadIds)].filter(id => this.state.host.threads.some(thread => thread.id === id))
      this.observe()
      // A newly viewed thread needs its history now, not at the next provider frame.
      this.broadcastDetail()
      return Promise.resolve(this.get())
    }
    if (command.type === 'save-thread-draft') return this.saveThreadDraft(command)
    // Renaming edits Sotto's own record of the thread, so it never waits on a running turn or any provider action.
    if (command.type === 'rename-thread') return this.renameThread(command)
    // Naming a thread is Sotto's own record too, and it asks a writing model, never the provider.
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
      return this.persist().then(() => this.get(), () => {
        this.state.error = 'Could not save the spoken reply setting. Retry when storage is available.'
        this.publish(); return this.get()
      })
    }
    if (command.type === 'voice-state') {
      this.state.voice.status = command.status; this.state.voice.error = command.error; this.publish()
      return Promise.resolve(this.get())
    }
    if (command.type === 'voice') {
      this.state.voice.action = command.action; this.state.voice.revision += 1; this.publish()
      return Promise.resolve(this.get())
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
      try {
        const admissionError = admission ? await admission : undefined
        if (admissionError instanceof Error) throw admissionError
        await this.execute(command, turn, manualRetryId, selectionRevision, client)
      } catch (error) {
        failure = error instanceof Error ? error.message : 'Sotto could not complete this action.'
        this.state.error = failure
        this.say(failure)
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
        // The user sees the fixed guidance; the raw storage error goes to the turn record only.
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
      await this.finishTurn(turn, failure)
      return this.get()
    })
    if (independent) {
      this.threadActions.set(laneThreadId, task)
      const releasePrompt = command.type === 'manual-send' || command.type === 'steer' ? this.mark(this.threadPrompts, laneThreadId) : (): void => {}
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
      this.state.error = error instanceof Error ? error.message : 'Could not save the follow-up queue.'
      if (command.type === 'queue-followup' && !this.followupStore.get().receipts.some(r => r.threadId === command.threadId && r.draftId === command.draftId)) this.setDelivery(command.threadId, command.draftId, 'failed')
    }
    this.publish(); this.pumpFollowups(); return this.get()
  }
  private followupReady(threadId: string, ownCommandId?: string): boolean {
    const thread = this.state.host.threads.find(t => t.id === threadId)
    const reviewed = thread && this.followupStore.get().items.find(i => i.threadId === threadId)?.resumeAfterTurnId === (thread.lastTurn?.id ?? 'unknown')
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
    const items = this.followupStore.get().items
    for (const threadId of new Set(items.map(item => item.threadId))) {
      // A queued follow-up waits on a prompt of its own thread, as before, not on the thread's other work.
      if (this.pumping.has(threadId) || this.threadPrompts.has(threadId)) continue
      const first = items.find(item => item.threadId === threadId)!
      const thread = this.state.host.threads.find(t => t.id === threadId)
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
            expectedLastUserMessageId: this.thread(threadId).messages.findLast(m => m.role === 'user')?.id ?? null }, turn, validate, item.draftId)
          await this.followupStore.settle(item.id, 'accepted')
        } catch (error) {
          failure = error instanceof Error ? error.message : 'Could not dispatch this follow-up.'
          if (claimed) {
            const item = this.followupStore.get().items.find(i => i.id === first.id)
            const accepted = item?.messageId && this.thread(threadId).messages.some(m => m.role === 'user' && m.id === item.messageId)
            await this.followupStore.settle(first.id, accepted ? 'accepted' : this.outbox.some(o => o.id === item?.commandId) ? 'uncertain' : 'failed', failure)
          }
        } finally { await this.finishTurn(turn, failure) }
      })().catch(() => { this.state.error = 'Could not save follow-up delivery state. Refresh before making changes.' })
        .finally(() => { this.syncFollowups(); this.publish(); this.pumping.delete(threadId); if (this.followupStore.get().items.find(i => i.threadId === threadId)?.id !== first.id) this.pumpFollowups() })
    }
  }
  private async interruptThread(command: Extract<AgentCommand, { type: 'interrupt' }>): Promise<AgentState> {
    const turn = this.beginTurn({ source: 'command', commandType: 'interrupt', text: '', threadId: command.threadId,
      projectId: this.state.host.threads.find(thread => thread.id === command.threadId)?.projectId ?? null })
    let failure: string | undefined
    // Stopping a turn waits for nothing, not even that thread's own lane, but the thread is working on it.
    const release = this.mark(this.busyThreads, command.threadId)
    try {
      this.state.error = null
      this.publish()
      await this.followupStore.pause(command.threadId, 'The turn was interrupted. Review the thread and resume queued follow-ups when ready.')
      this.syncFollowups(); await this.execute(command, turn); await this.persist()
    } catch (error) { failure = error instanceof Error ? error.message : 'Could not interrupt this thread.'; this.state.error = failure }
    release()
    this.publish(); await this.finishTurn(turn, failure); return this.get()
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
      expectedLastUserMessageId: this.thread(command.threadId).messages.findLast(m => m.role === 'user')?.id ?? null }, turn, validate, command.draftId)
    this.say(`Steered ${this.thread(command.threadId).title}.`)
  }
  private async providerCommand(command: Extract<AgentCommand, { type: 'connect' | 'disconnect' | 'refresh' }>): Promise<AgentState> {
    const turn = this.beginTurn({ source: 'command', commandType: command.type, text: '' })
    let failure: string | undefined
    try { this.state.error = null; await this.execute(command, turn); await this.persist() }
    catch (error) { failure = error instanceof Error ? error.message : 'Provider action failed.'; this.state.error = failure }
    await this.finishTurn(turn, failure); this.publish(); return this.get()
  }
  private beginTurn(input: Parameters<TurnRecorder['begin']>[0]): ActiveTurn | undefined {
    try { return this.dependencies.turns?.begin(input) } catch { return undefined }
  }
  private async finishTurn(turn: ActiveTurn | undefined, error?: string): Promise<void> {
    if (!turn) return
    try {
      await this.dependencies.turns?.finish(turn, error !== undefined ? 'failed' : turn.clarified ? 'clarified' : 'completed', error)
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
      this.state.error = failure
      this.publish()
    }
    await this.finishTurn(turn, failure)
    return this.get()
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
        const next = agentConfigurationSchema.parse({ ...this.state.configuration, ...command.patch })
        const before = this.state.configuration
        // Coordinator account selection has no authority over native thread connections.
        if (next.reasoning !== before.reasoning) await this.dependencies.credentials.set('reasoning', '')
        if (next.provider !== before.provider && command.patch.defaultModelId === undefined) next.defaultModelId = ''
        // Preserve an established enabled set when changing only the legacy default choice.
        if (next.provider !== before.provider && next.enabledProviders === undefined && this.state.host.providers) next.enabledProviders = enabledThreadProviders(before)
        if (command.patch.enabledProviders !== undefined) {
          for (const provider of enabledThreadProviders(before)) if (!next.enabledProviders?.includes(provider)) this.dependencies.host.disconnect(provider)
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
      case 'membership':
        this.state.membership = await this.dependencies.membership.action(command.action)
        if (!['active', 'beta'].includes(this.state.membership.status)) this.state.assignments.forEach(a => { a.paused = true })
        return
      case 'connect': {
        if (command.provider) {
          this.state.configuration.enabledProviders = [...new Set([...enabledThreadProviders(this.state.configuration), command.provider])]
          if (!this.dependencies.host.concurrentProviders) this.state.configuration.enabled = true
          await this.persist()
        }
        if (!this.state.host.connected) this.state.connection = 'connecting'
        this.publish(); this.observe()
        try {
          const snapshot = await (command.provider ? this.dependencies.host.connect(command.provider) : this.dependencies.host.connect())
          this.acceptSnapshot(snapshot)
          const requested = command.provider && snapshot.providers?.find(provider => provider.id === command.provider)
          if (requested && requested.connection !== 'connected') throw new Error(requested.error || `${requested.name} did not confirm the connection.`)
          if (!snapshot.connected) throw new Error(snapshot.error || `${PROVIDER_LABELS[this.state.configuration.provider]} did not confirm the connection.`)
          if (!this.dependencies.host.concurrentProviders) this.state.configuration.enabled = true
          this.say(command.provider ? `${PROVIDER_LABELS[command.provider]} connected` : snapshot.providers ? 'Thread providers connected' : `${PROVIDER_LABELS[this.state.configuration.provider]} connected`)
        } catch (error) {
          if (!this.state.host.providers) this.disconnect()
          throw error
        }
        return
      }
      case 'disconnect':
        if (command.provider) {
          this.state.configuration.enabledProviders = enabledThreadProviders(this.state.configuration).filter(provider => provider !== command.provider)
          this.dependencies.host.disconnect(command.provider)
          this.acceptSnapshot(await this.dependencies.host.snapshot(command.provider))
          this.say(`${PROVIDER_LABELS[command.provider]} disconnected.`)
        } else {
          if (this.dependencies.host.concurrentProviders) this.state.configuration.enabledProviders = []
          else this.state.configuration.enabled = false
          this.disconnect(); this.say('Sotto disconnected.')
        }
        return
      case 'refresh': this.observe(); this.acceptSnapshot(await this.dependencies.host.snapshot(command.provider)); return
      case 'check-reasoning': await this.checkReasoning(command.provider); return
      case 'utterance': await this.utterance(command.text.trim(), turn, selectionRevision); return
      case 'compose': {
        if (!this.state.composing) this.startDraft()
        const previous = this.state.threadDrafts?.find(item => item.threadId === this.state.draftThreadId && item.requestId === this.state.draftRequestId)
        if (command.attachments !== undefined) this.state.draftAttachments = agentAttachmentsSchema.parse(command.attachments)
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
      case 'send': await this.sendDraft(turn, manualRetryId, selectionRevision); return
      case 'manual-send': await this.sendManual(command.threadId, command.text, turn, manualRetryId, command.attachments, command.draftId, command.skills, command.files); return
      case 'steer': await this.steer(command, turn); return
      case 'create-project': {
        const provider = command.provider ?? this.state.configuration.provider
        this.canCreate(provider)
        const targetProvider = this.state.host.providers?.find(status => status.id === provider)
        if (targetProvider && targetProvider.connection !== 'connected') throw new Error(`Connect ${PROVIDER_LABELS[provider]} before creating a project.`)
        if (!(targetProvider?.capabilities ?? this.state.host.capabilities).projects) throw new Error('This provider does not support creating projects.')
        if (/[<>:"/\\|?*]/u.test(command.title) || /[. ]$/u.test(command.title) || /^(\.|\.\.|con|prn|aux|nul|com\d|lpt\d)$/iu.test(command.title)) throw new Error('Choose a project name that can be used as a folder name.')
        const target = command.path || (this.state.configuration.projectsDirectory ? join(this.state.configuration.projectsDirectory, command.title) : '')
        if (!target || !isAbsolute(target)) throw new Error('Choose an absolute project folder or configure a default projects directory.')
        const path = resolve(target)
        const existing = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null })
        if (existing && (!existing.isDirectory() || !command.useExisting)) throw new Error('That folder already exists. Select “Use existing folder” to attach it without overwriting its contents.')
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
        this.acceptSnapshot(await this.dependencies.host.loadEarlierMessages(command.threadId))
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
      case 'open-thread-folder': {
        if (!this.dependencies.host.threadWorkingDirectory || !this.dependencies.openThreadFolder) throw new Error('Opening the working folder is unavailable.')
        await this.dependencies.openThreadFolder(await this.dependencies.host.threadWorkingDirectory(command.threadId))
        return
      }
      case 'create-thread': {
        const managed = command.managed !== false
        if (managed && this.state.composing && this.hasDraft()) throw new Error('Send or clear your draft before creating another thread.')
        const model = this.state.host.models.find(model => model.id === command.modelId)
        this.canCreate(model?.providerId)
        if (!this.state.host.capabilities.threads) throw new Error('This provider cannot create threads.')
        if (!this.state.host.projects.some(p => p.id === command.projectId)) throw new Error('Choose an available project.')
        if (!this.state.host.models.some(m => m.id === command.modelId && m.ready)) throw new Error('That model or account is unavailable. Choose a ready model; Sotto will not switch your account.')
        validateThreadOptions(this.state.host, command)
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
            ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}),
            ...(command.runtimeMode !== undefined ? { runtimeMode: command.runtimeMode } : {}) }, turn)
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
        this.canAct()
        if (command.modelId === undefined && command.reasoningEffort === undefined && command.runtimeMode === undefined) throw new Error('Choose a thread setting to change.')
        if (this.thread(command.threadId).nativeSessionStarted !== false && !capabilitiesForThread(this.state.host, this.thread(command.threadId)).configureThread) throw new Error('This provider does not support changing thread settings.')
        this.observe(command.threadId)
        this.acceptSnapshot(await this.readThread(command.threadId))
        const validate = (): void => {
          const thread = this.thread(command.threadId)
          if (thread.status === 'running' || thread.requests.length) throw new Error('Wait for this thread to finish and answer its pending requests before changing settings.')
          if (thread.nativeSessionStarted !== false && command.modelId && thread.providerId && this.state.host.models.find(model => model.id === command.modelId)?.providerId !== thread.providerId) throw new Error('Choose a model from this thread provider. Existing sessions cannot move between providers.')
          validateThreadOptions(this.state.host, command, thread.modelId)
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
        const validate = (): void => {
          this.canAct()
          if (!capabilitiesForThread(this.state.host, this.thread(command.threadId)).interrupt) throw new Error('This connection cannot stop agent work.')
          if (isThreadClosed(this.thread(command.threadId))) throw new Error('This thread is settled or archived. There is no open work to stop.')
        }
        validate()
        const assignment = this.state.assignments.find(item => item.threadId === command.threadId)
        if (assignment) assignment.paused = true
        await this.dispatch({ type: 'interrupt', commandId: randomUUID(), threadId: command.threadId }, turn, validate)
        return
      }
      case 'compact-thread': {
        const validate = (): void => {
          this.canAct(command.threadId)
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
      seenMessageIds: thread.messages.map(m => m.id), ownMessageIds: [], handledRequestIds: [], lastFailure: '' })
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
  /**
   * Whether this client's answer may count as a grant at all. The desktop window on this machine
   * always may; a remote client may only while a policy record names it (ADR-0004). The pairing token
   * says which client is speaking and nothing more, so this asks policy rather than the token.
   */
  private guardClientGrant(client: ClientIdentity): void {
    const verdict = this.dependencies.authority?.mayGrant(client) ?? mayGrantLocally(client)
    if (!verdict.allowed) throw new Error(UNPAIRED_CLIENT_ERROR)
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
      this.dependencies.logFailure?.('thread-answer-attribution-failed', command.threadId)
    }
  }
  private guardAuthority(command: AgentHostCommand, turn?: ActiveTurn): void {
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
  private readThread(threadId?: string, provider?: ProviderId): Promise<AgentHostSnapshot> {
    const host = this.dependencies.host
    return threadId && host.refreshThread ? host.refreshThread(threadId) : provider ? host.snapshot(provider) : host.snapshot()
  }
  private async dispatch(command: AgentHostCommand, turn?: ActiveTurn, validate?: () => void, draftId?: string,
    client: ClientIdentity = this.localClient): Promise<void> {
    if (turn) this.dispatchTurns.set(command.commandId, turn)
    try { await this.dispatchPending(command, turn, validate, draftId, client) }
    finally { this.dispatchTurns.delete(command.commandId) }
  }
  private async dispatchPending(command: AgentHostCommand, turn?: ActiveTurn, validate?: () => void, draftId?: string,
    client: ClientIdentity = this.localClient): Promise<void> {
    this.canAct()
    // Refused here, before an outbox entry exists and long before the provider hears anything.
    if (command.type === 'answer') this.guardClientGrant(client)
    const threadId = 'threadId' in command ? command.threadId : undefined
    const provider = command.type === 'create-project' ? command.provider ?? this.state.configuration.provider
      : command.type === 'create-thread' || (command.type === 'configure-thread' && command.modelId && this.thread(command.threadId).nativeSessionStarted === false)
        ? this.state.host.models.find(model => model.id === command.modelId)?.providerId : command.type === 'answer'
          ? requestDraftProvider(this.state.host, this.thread(command.threadId), this.state.configuration.provider) : this.thread(command.threadId).providerId
    if (threadId && command.type !== 'create-thread' && !(command.type === 'configure-thread' && this.thread(threadId).nativeSessionStarted === false)) this.canAct(threadId)
    if ((command.type === 'send' || command.type === 'steer') || command.type === 'answer') {
      const thread = this.thread(command.threadId); const capabilities = capabilitiesForThread(this.state.host, thread)
      if ((command.type === 'send' || command.type === 'steer') && (!capabilities.submit || !capabilities.reconcile)) throw new Error('This connection cannot safely send and reconcile a prompt.')
      if (command.type === 'answer') {
        const request = thread.requests.find(request => request.id === command.requestId)
        if (request && !(request.kind === 'permission' ? capabilities.permissions : capabilities.questions)) throw new Error('This provider does not support answering this request.')
      }
    }
    if ((command.type === 'send' || command.type === 'steer')) draftId ??= randomUUID()
    if (this.outbox.some(item => threadId ? item.threadId === threadId : item.threadId === undefined && (item.provider ?? this.state.configuration.provider) === provider)) throw new Error('An earlier action has an unknown result. Reconnect and inspect the provider before retrying; Sotto will not send it twice.')
    const answerRequest = command.type === 'answer' ? this.thread(command.threadId).requests.find(item => item.id === command.requestId) : undefined
    this.outbox.push({ id: command.commandId, type: command.type, ...(provider ? { provider } : {}), ...(threadId ? { threadId } : {}),
      ...('messageId' in command ? { messageId: command.messageId } : {}),
      ...('requestId' in command ? { requestId: command.requestId } : {}),
      ...(command.type === 'answer' && this.thread(command.threadId).requests.find(item => item.id === command.requestId)?.questions
        ? { questionsDigest: requestQuestionsDigest(this.thread(command.threadId).requests.find(item => item.id === command.requestId)!.questions!) } : {}),
      ...(command.type === 'configure-thread' ? { options: agentThreadOptionsSchema.parse({ ...command,
        ...(command.modelId !== undefined && command.reasoningEffort === undefined && this.state.host.models.find(model => model.id === command.modelId)?.defaultReasoningEffort
          ? { reasoningEffort: this.state.host.models.find(model => model.id === command.modelId)!.defaultReasoningEffort } : {}) }) } : {}),
      ...((command.type === 'send' || command.type === 'steer') ? { draftDigest: this.promptDigest(command.text, command.attachments, command.skills, command.files), ...(draftId ? { draftId } : {}) } : {}),
      ...(command.type === 'create-project' ? { entityId: command.projectId } : command.type === 'create-thread' ? { entityId: command.threadId } : {}),
    })
    const answerIntent = command.type === 'answer' ? this.outbox.find(item => item.id === command.commandId) : undefined
    if ((command.type === 'send' || command.type === 'steer') && draftId) {
      this.setDelivery(command.threadId, draftId, 'submitting', { commandId: command.commandId, messageId: command.messageId })
      // The message shows as Sending as soon as the intent exists, not after the disk write.
      // Durability still gates dispatch: the outbox entry is persisted below, before host.execute.
      this.publish()
    }
    try { await this.persist() }
    catch (error) {
      // Nothing crossed the adapter boundary. Do not leave phantom uncertain intent.
      this.outbox = this.outbox.filter(item => item.id !== command.commandId)
      if ((command.type === 'send' || command.type === 'steer') && draftId) { this.setDelivery(command.threadId, draftId, 'failed'); this.publish() }
      throw error
    }
    let result
    if ((command.type === 'send' || command.type === 'steer') || command.type === 'answer') addTurnContext(turn, (command.type === 'send' || command.type === 'steer') ? command.text : command.answer)
    let providerLatencyMs: number | undefined
    try {
      this.canAct(); this.guardAuthority(command, turn); validate?.()
      if ((command.type === 'send' || command.type === 'steer') && command.attachments?.length) {
        const attachments = validatePromptAttachments(this.state.host, this.thread(command.threadId).modelId, command.attachments)
        await this.attachmentPreviews.remember(command.threadId, command.messageId, command.commandId, attachments)
      }
      if (command.type === 'answer' && answerRequest?.questions?.length && provider) {
        await this.dependencies.bindRequestDraftDecision?.({ kind: 'thread', ownerId: command.threadId, providerId: provider, requestId: command.requestId, questions: answerRequest.questions }, command.commandId, command.questionAnswers)
        this.canAct(); this.guardAuthority(command, turn); validate?.()
      }
      const providerStartedAt = Date.now()
      try { result = await this.dependencies.host.execute(command) }
      finally { providerLatencyMs = Math.max(0, Date.now() - providerStartedAt) }
    } catch (error) {
      this.outbox = this.outbox.filter(o => o.id !== command.commandId)
      if ((command.type === 'send' || command.type === 'steer') && draftId) this.setDelivery(command.threadId, draftId, 'failed')
      await this.persist()
      if ((command.type === 'send' || command.type === 'steer') && command.attachments?.length) await this.attachmentPreviews.forget(command.threadId, command.messageId, command.commandId)
      throw error
    } finally {
      if (turn) turn.delegationMs += providerLatencyMs ?? 0
      if ((command.type === 'send' || command.type === 'steer') && draftId && providerLatencyMs !== undefined) {
        const delivery = this.state.deliveries?.find(item => item.threadId === command.threadId && item.draftId === draftId)
        this.setDelivery(command.threadId, draftId, delivery?.status ?? 'submitting', { providerLatencyMs })
      }
    }
    // An exact native message already reconciled this outbox item. Delivery is
    // settled even if its running turn prevents a later display/history read.
    if ((command.type === 'send' || command.type === 'steer') && !this.outbox.some(item => item.id === command.commandId)) {
      await this.persist()
      return
    }
    if ((command.type === 'send' || command.type === 'steer') && draftId) this.setDelivery(command.threadId, draftId, result.accepted || result.uncertain ? 'uncertain' : 'failed')
    if (result.uncertain && this.outbox.some(o => o.id === command.commandId)) throw new Error('The provider did not confirm the result. Sotto will reconcile the existing action when reconnected; it will not resend it.')
    if ((command.type === 'configure-thread' || (command.type === 'send' || command.type === 'steer')) && result.accepted) {
      try { this.acceptSnapshot(await this.readThread(threadId)) }
      catch (error) {
        // The exact echo can arrive while this required reconciliation read is
        // in flight. Keep its receipt; an unconfirmed command still fails here.
        if ((command.type !== 'send' && command.type !== 'steer') || this.outbox.some(item => item.id === command.commandId)) throw error
      }
      await this.persist()
      if (this.outbox.some(item => item.id === command.commandId)) throw new Error((command.type === 'send' || command.type === 'steer')
        ? 'The provider has not confirmed this user message in its state. Refresh to reconcile the existing send; it will not be replayed.'
        : 'The provider has not confirmed these thread settings in its state. Refresh to reconcile the existing save; it will not be replayed.')
      return
    }
    if ((command.type === 'send' || command.type === 'steer') && !result.accepted && !result.uncertain && command.attachments?.length) {
      await this.attachmentPreviews.forget(command.threadId, command.messageId, command.commandId)
    }
    if (command.type === 'answer' && result.accepted) {
      if (!result.uncertain && answerIntent) this.recordAnsweredRequest(answerIntent)
      // The user gave this answer whether or not the provider confirmed taking it, so who gave it is recorded either way.
      this.recordAnswerAttribution(command, client)
    }
    this.outbox = this.outbox.filter(o => o.id !== command.commandId)
    await this.persist()
    if (!result.accepted && !result.uncertain) throw new Error('The provider rejected this action. Check its current permissions and account status.')
    this.acceptSnapshot(await this.readThread(threadId, provider))
  }
  private async sendManual(threadId: string, text: string, turn?: ActiveTurn, retryId?: string, attachments: AgentAttachment[] = [], draftId?: string, skills?: AgentSkillReference[], files?: AgentFileReference[]): Promise<void> {
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
    attachments = agentAttachmentsSchema.parse(attachments)
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
    this.acceptSnapshot(await this.readThread(threadId))
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
    await this.dispatch({ type: 'send', commandId: randomUUID(), threadId, messageId, text: text.trim(), ...(skills ? { skills } : {}), ...(files ? { files } : {}), ...(attachments.length ? { attachments } : {}), expectedLastUserMessageId: thread.messages.findLast(m => m.role === 'user')?.id ?? null }, turn, validate, draftId)
    this.state.queue = this.state.queue.filter(item => item.threadId !== threadId || item.requestId)
    this.say(`Sent to ${thread.title}.`)
    this.observe()
  }
  private async sendDraft(turn?: ActiveTurn, retryId?: string, selectionRevision = this.selectionRevision): Promise<void> {
    const pendingId = retryId ?? this.outbox.find(item => item.threadId === this.state.draftThreadId)?.id
    if (pendingId) {
      this.canAct()
      this.observe(); this.acceptSnapshot(await this.readThread(this.state.draftThreadId ?? undefined))
      if (this.outbox.some(item => item.id === pendingId)) throw new Error('An earlier action has an unknown result. Reconnect and inspect the provider before retrying; Sotto will not send it twice.')
      this.say('Reconciled the earlier action. No new prompt was sent.')
      return
    }
    if (turn) {
      turn.threadId = this.state.draftThreadId
      turn.projectId = this.state.host.threads.find(thread => thread.id === this.state.draftThreadId)?.projectId ?? null
    }
    this.canAct()
    this.observe()
    this.acceptSnapshot(await this.readThread(this.state.draftThreadId ?? undefined))
    const thread = this.thread(this.state.draftThreadId)
    if (!this.hasDraft()) throw new Error('There is no prompt to send.')
    const attachments = validatePromptAttachments(this.state.host, thread.modelId, this.state.draftAttachments)
    const assignment = this.assignment(thread.id)
    const text = this.state.draft.trim()
    this.syncLegacyDraft()
    const draftId = this.manualDraftId ?? undefined
    const savedDraft = this.state.threadDrafts?.find(item => item.threadId === thread.id && item.draftId === draftId)
    const skills = savedDraft?.skills
    const files = savedDraft?.files
    if (this.state.draftRequestId) {
      if (attachments.length) throw new Error('Images cannot answer a pending question. Remove the images and answer it explicitly.')
      const requestId = this.state.draftRequestId
      if (!thread.requests.some(request => request.id === requestId && request.kind === 'question')) throw new Error('This question is no longer pending. Your answer is saved; review it before starting a new prompt.')
      await this.execute({ type: 'answer', threadId: thread.id, requestId, answer: text }, turn, undefined, selectionRevision)
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
    await this.dispatch({ type: 'send', commandId: randomUUID(), threadId: thread.id, messageId, text, ...(skills ? { skills } : {}), ...(files ? { files } : {}), ...(attachments.length ? { attachments } : {}), expectedLastUserMessageId: thread.messages.findLast(message => message.role === 'user')?.id ?? null }, turn, undefined, draftId)
    if (this.manualDraftId === draftId) this.clearDraft()
    this.state.queue = this.state.queue.filter(q => q.threadId !== thread.id || q.kind === 'permission' || q.kind === 'question')
    this.say(`Sent to ${thread.title}.`)
    this.presentQueue(true, selectionRevision)
  }
  private startDraft(threadId = this.state.activeThreadId): void {
    const thread = this.thread(threadId)
    this.coordinatorConversation = false
    this.manualDraftId = null
    const question = this.state.queue.find(item => item.threadId === thread.id && item.kind === 'question' && item.requestId)
    const saved = !this.hasDraft() ? this.state.threadDrafts?.find(item => item.threadId === thread.id) : undefined
    if (saved) {
      this.state.draft = saved.text; this.state.draftAttachments = structuredClone(saved.attachments); this.manualDraftId = saved.draftId
    }
    this.state.draftThreadId = thread.id
    this.state.draftRequestId = saved ? saved.requestId : question?.requestId ?? null
    this.state.composing = true
  }
  private clearDraft(): void {
    this.state.threadDrafts = (this.state.threadDrafts ?? []).filter(item => item.threadId !== this.state.draftThreadId)
    this.manualDraftId = null
    this.state.draftAttachments = []
    this.state.draft = ''; this.state.draftThreadId = null; this.state.draftRequestId = null; this.state.composing = false
  }
  private hasDraft(): boolean { return Boolean(this.state.draft.trim() || this.state.draftAttachments?.length) }
  private promptDigest(text: string, attachments: AgentAttachment[] = [], skills: AgentSkillReference[] = [], files: AgentFileReference[] = []): string {
    return followupDigest({ text, attachments, skills, files })
  }
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
      intent = await this.dependencies.reasoner.intent(request, this.state.host, this.state.activeProjectId, defaultThreadModelId(this.state.configuration, this.state.host.models), this.state.activeThreadId, preferences)
      if (turn) turn.intentResolvedAtMs = Date.now()
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
  private acceptSnapshot(snapshot: AgentHostSnapshot): void {
    if (this.disposed) return
    const connecting = this.state.connection === 'connecting'
    this.state.host = snapshot
    this.scheduleProviderReconnects()
    if (this.state.activeProjectId) this.state.activeProjectId = this.dependencies.host.resolveProjectId?.(this.state.activeProjectId) ?? this.state.activeProjectId
    if (this.state.configuration.defaultModelId) this.state.configuration.defaultModelId = this.dependencies.host.resolveModelId?.(this.state.configuration.defaultModelId) ?? this.state.configuration.defaultModelId
    this.state.connection = snapshot.connected ? 'connected' : connecting ? 'connecting' : 'disconnected'
    if (!snapshot.connected) {
      if (!snapshot.providers && !connecting && this.state.configuration.enabled && enabledThreadProviders(this.state.configuration).length && !this.reconnect) this.reconnect = setTimeout(() => {
        this.reconnect = null
        void this.command({ type: 'connect' }).then(s => { if (s.connection !== 'connected') this.acceptSnapshot({ ...s.host, connected: false }) })
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
      // A disappeared question does not prove that our answer was accepted.
      // Only the exact adapter acknowledgement above can retire retained content.
      const turn = this.dispatchTurns.get(item.id)
      if (turn) this.feedbackReady.add(turn)
      // Match both representations while the selected skills and revision owner still exist.
      const clearsLegacyDraft = message && (!item.draftId || item.draftId === this.manualDraftId) && this.state.draftThreadId === thread?.id && (item.draftDigest
        ? item.draftDigest === this.promptDigest(this.state.draft, this.state.draftAttachments, this.state.threadDrafts?.find(d => d.threadId === this.state.draftThreadId && d.draftId === this.manualDraftId)?.skills)
        : !this.state.draftAttachments?.length && this.state.draft.trim() === message.text)
      this.outbox = this.outbox.filter(o => o.id !== item.id)
      if (message && item.draftId && item.threadId) {
        this.setDelivery(item.threadId, item.draftId, 'accepted', { commandId: item.id, messageId: item.messageId })
        this.state.deliveredDrafts = [...(this.state.deliveredDrafts ?? []).filter(receipt => receipt.threadId !== item.threadId || receipt.draftId !== item.draftId),
          { threadId: item.threadId, draftId: item.draftId }].slice(-MAX_DELIVERED_DRAFTS)
        if (item.draftDigest) this.deliveredPromptDigests = [...this.deliveredPromptDigests.filter(r => r.threadId !== item.threadId || r.draftId !== item.draftId),
          { threadId: item.threadId, draftId: item.draftId, digest: item.draftDigest }].slice(-MAX_DELIVERED_DRAFTS)
        this.state.threadDrafts = (this.state.threadDrafts ?? []).filter(draft => draft.threadId !== item.threadId || draft.draftId !== item.draftId
          || item.draftDigest !== this.promptDigest(draft.text, draft.attachments, draft.skills, draft.files))
      }
      if (clearsLegacyDraft) {
        this.clearDraft()
      }
    }
    let announcedManualControl = false
    for (const assignment of this.state.assignments) {
      const thread = snapshot.threads.find(t => t.id === assignment.threadId)
      if (!thread || isThreadClosed(thread) || !isThreadProviderConnected(snapshot, thread)) continue
      const fresh = thread.messages.filter(m => !assignment.seenMessageIds.includes(m.id))
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
      assignment.seenMessageIds = [...new Set([...assignment.seenMessageIds, ...thread.messages.map(m => m.id)])].slice(-2000)
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
    void this.persist().catch(() => { this.state.assignments.forEach(a => { a.paused = true }); this.state.error = 'Agent state could not be saved. Management paused.'; this.publish() })
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
      const decision = await this.dependencies.reasoner.decide(assignment.instruction, structuredClone(thread), preferences)
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
      this.acceptSnapshot(await this.readThread(thread.id))
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
        await this.dispatch({ type: 'send', commandId: randomUUID(), threadId: thread.id, messageId, text: decision.text, expectedLastUserMessageId: latest.messages.findLast(m => m.role === 'user')?.id ?? null }, turn, validate)
      }
    } catch (error) {
      if (error instanceof SupersededSupervision) { failure = error.message; return }
      assignment.paused = true
      assignment.stopReason = 'error'; assignment.stoppedAt = new Date().toISOString()
      failure = error instanceof Error ? error.message : 'Sotto needs your attention to continue.'
      this.enqueue(thread, 'blocked', failure)
    } finally {
      await this.persist().catch(error => {
        assignment.paused = true
        if (assignment.stopReason === 'none') {
          assignment.stopReason = 'error'; assignment.stoppedAt = new Date().toISOString()
        }
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
          if (retryable(provider)) void this.command({ type: 'connect', provider })
        }, 5000))
      }
    }
  }
  dispose(): void {
    this.disposed = true
    // A held broadcast dies with the control: its listeners are going away, and a run that
    // escapes the cancel still finds `disposed` and does nothing.
    this.broadcastCancel?.()
    this.broadcastCancel = null
    this.broadcastOpen = false
    this.broadcastPending = false
    if (this.membershipTimer) clearInterval(this.membershipTimer)
    this.unsubscribe?.()
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
 */
export function coalesceAgentThreadDetailPublishes(send: (update: AgentThreadDetailUpdate) => void,
  options: { intervalMs?: number; schedule?: PublishScheduler } = {}): CoalescedThreadDetailPublisher {
  const intervalMs = options.intervalMs ?? AGENT_STATE_PUBLISH_INTERVAL_MS
  const schedule = options.schedule ?? realPublishScheduler
  const lanes = new Map<string, { cancel: (() => void) | null; pending: AgentThreadDetailUpdate[] }>()
  let disposed = false
  const flushLane = (threadId: string): void => {
    const lane = lanes.get(threadId) ?? { cancel: null, pending: [] }
    lanes.set(threadId, lane)
    lane.cancel?.()
    const queued = lane.pending
    lane.pending = []
    for (const update of queued) send(update)
    lane.cancel = schedule(() => { lane.cancel = null; if (lane.pending.length > 0) flushLane(threadId) }, intervalMs)
  }
  return {
    publish: update => {
      if (disposed) return
      const lane = lanes.get(update.threadId)
      if (lane?.cancel) {
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
