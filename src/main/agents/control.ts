import type { AgentSkillReference } from '../../shared/agentSkills'
import { FollowupStore, followupDigest } from './followups'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  agentAssignmentSchema, agentConfigurationSchema, agentQueueItemSchema, agentAttachmentsSchema, agentThreadOptionsSchema, agentThreadDraftSchema, agentDeliverySchema,
  providerUpgradeSchema, defaultAgentConfiguration, EMPTY_AGENT_HOST, PROVIDER_LABELS, supportsAgentSupervision, isSubscriptionReasoning, agentDeliveryReceiptsSchema, MAX_DELIVERED_DRAFTS, enabledThreadProviders, capabilitiesForThread, isThreadProviderConnected, providerIdSchema,
  type ProviderId, type AgentAttachment, type AgentAssignment, type AgentCommand, type AgentDelivery, type AgentThreadDraft, type AgentHostSnapshot, type AgentQueueItem, type AgentState, type AgentThread, type SubscriptionProvider,
} from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { MemoryProfile } from '../memory/profile'
import type { AgentCredentials } from './credentials'
import { approvalWords, classifyRiskyAction, denialWords, type Authority } from './authority'
import type { AgentHost, AgentHostCommand } from './host'
import type { AgentPreference, AgentReasoner } from './reasoning'
import { addTurnContext, type ActiveTurn, type TurnRecorder } from './turns'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { attentionItemKey, isLiveAttention } from '../../shared/agentAttention'
import { maintainProviderRecovery, retireLegacyProvider, stripRetiredEndpoint } from './providerRetirement'
import { validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { AttachmentPreviews } from './attachmentPreviews'

const RECORDED_COMMAND_TYPES: ReadonlySet<AgentCommand['type']> = new Set([
  'utterance', 'connect', 'refresh', 'send', 'steer', 'manual-send', 'answer', 'create-thread', 'create-project', 'select-project',
  'select-thread', 'select-attention', 'assign', 'unassign', 'resume', 'pause', 'interrupt', 'next', 'later',
  'cancel-draft', 'cancel-request', 'configure-thread',
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
  threadDrafts: z.array(agentThreadDraftSchema).default([]),
  deliveries: z.array(agentDeliverySchema).default([]),
  pendingRequest: z.string().max(20_000).default(''),
  contextSavedAt: z.number().default(0),
  composing: z.boolean(), outbox: z.array(z.object({
    id: z.string(), type: z.enum(['send', 'steer', 'create-project', 'create-thread', 'configure-thread', 'answer', 'interrupt']),
    provider: providerIdSchema.optional(),
    threadId: z.string().optional(), messageId: z.string().optional(), entityId: z.string().optional(), requestId: z.string().optional(),
    options: agentThreadOptionsSchema.optional(), draftDigest: z.string().optional(), draftId: z.uuid().optional(),
  })),
})
type Saved = z.infer<typeof savedSchema>
class SupersededSupervision extends Error {}
const PRIVACY_CLEANUP_ERROR = 'Could not finish applying history privacy. Sotto will retry when local storage is available.'
export interface AgentMembership {
  status(): Promise<AgentState['membership']>
  action(action: 'refresh' | 'signin' | 'checkout' | 'portal'): Promise<AgentState['membership']>
}

/** Owns assignment authority, queue ordering and durable dispatch intent across all host adapters. */
export class AgentControl {
  private readonly followupStore: FollowupStore
  private readonly threadActions = new Map<string, Promise<unknown>>()
  private readonly pumping = new Set<string>()
  private state: AgentState
  private outbox: Saved['outbox'] = []
  private readonly store: AtomicJsonStore<Saved>
  private persistedDrafts = new Map<string, string>()
  private readonly pendingDraftWrites = new Set<Map<string, string>>()
  private readonly emptyDraftRevisions = new Map<string, string>()
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
  private speechPreferenceRevision = 0
  private selectionRevision = 0
  private manualDraftId: string | null = null
  private readonly promptAdmissions = new Map<string, { digest: string; task: Promise<AgentState> }>()
  private deliveredPromptDigests: Saved['deliveredPromptDigests'] = []
  /** Ephemeral view interest; never persisted, selected or granted assignment authority. */
  private viewedThreadIds: readonly string[] = []
  private readonly dispatchTurns = new Map<string, ActiveTurn>()
  private readonly feedbackReady = new Set<ActiveTurn>()
  private contextActivityAt = Date.now()
  constructor(private readonly dependencies: {
    directory: string; host: AgentHost; credentials: AgentCredentials; reasoner: AgentReasoner; membership: AgentMembership
    historyEnabled?: () => boolean
    turns?: TurnRecorder
    authority?: Authority
    preferences?: Pick<MemoryProfile, 'retrieve'>
    openThreadFolder?: (path: string) => Promise<void>
  }) {
    this.followupStore = new FollowupStore(dependencies.directory)
    this.state = {
      configuration: defaultAgentConfiguration(), connection: 'disconnected', host: structuredClone(EMPTY_AGENT_HOST),
      assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
      draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [],
      pendingRequest: '',
      busy: false, notice: '', error: null, speech: { id: 0, text: '' },
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
    const { outbox, contextSavedAt, manualDraftId, deliveredPromptDigests, ...restored } = saved
    this.deliveredPromptDigests = deliveredPromptDigests
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
        ? item.draftDigest === this.promptDigest(draft.text, draft.attachments, draft.skills) : draft.requestId === null))?.draftId ?? randomUUID()
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
    this.observe()
    this.unsubscribe = this.dependencies.host.subscribe(snapshot => this.acceptSnapshot(snapshot))
    if (this.state.configuration.enabled || (this.dependencies.host.concurrentProviders && this.state.configuration.enabledProviders?.length)) {
      const connection = this.command({ type: 'connect' })
      if (!this.dependencies.host.concurrentProviders) await connection
      // Independent native discovery must not delay constructing the desktop IPC surface.
      else void connection
    }
  }
  get(): AgentState {
    const state = structuredClone(this.state)
    const current = this.draftSignatures(state.threadDrafts ?? [])
    const revisions = new Map(this.emptyDraftRevisions)
    for (const draft of state.threadDrafts ?? []) revisions.set(draft.threadId, draft.draftId)
    state.threadDraftPersistence = [...revisions].map(([threadId, draftId]) => {
      const signature = current.get(threadId)
      return { threadId, draftId, status: this.persistedDrafts.get(threadId) === signature ? 'saved'
        : [...this.pendingDraftWrites].some(write => write.get(threadId) === signature) ? 'saving' : 'unsaved' }
    })
    this.attachmentPreviews.decorate(state.host)
    return state
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
      deliveredPromptDigests: this.deliveredPromptDigests,
      threadDrafts: this.state.threadDrafts ?? [], deliveries: this.state.deliveries ?? [] })
  }
  async privacyChanged(): Promise<void> {
    const revision = ++this.privacyRevision
    this.privacyCleanupPending = true
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
    const drafts = this.draftSignatures(saved.threadDrafts)
    this.pendingDraftWrites.add(drafts)
    try {
      await this.store.write(saved)
      // AtomicJsonStore serializes writes. Confirm only the snapshot that actually
      // completed, never newer state that changed while this write was outstanding.
      this.persistedDrafts = drafts
    } finally {
      this.pendingDraftWrites.delete(drafts)
      // Some full-state writes are fire-and-forget; a fresh renderer still needs
      // their completion evidence, even when no command response reaches it.
      this.publish()
    }
  }
  private draftSignatures(drafts: readonly AgentThreadDraft[]): Map<string, string> {
    return new Map(drafts.map(({ threadId, draftId, text, attachments, skills, requestId }) => [threadId,
      createHash('sha256').update(JSON.stringify({ draftId, text, attachments, skills, requestId })).digest('hex')]))
  }
  private publish(feedback?: { receivedAt: number; threadId: string; draftId: string }): void {
    if (this.disposed) return
    const value = this.get()
    if (feedback) {
      const localFeedbackMs = performance.now() - feedback.receivedAt
      for (const state of [this.state, value]) {
        const delivery = state.deliveries?.find(item => item.threadId === feedback.threadId && item.draftId === feedback.draftId)
        if (delivery) delivery.localFeedbackMs = localFeedbackMs
      }
    }
    for (const turn of this.feedbackReady) turn.firstFeedbackAtMs ??= Date.now()
    this.feedbackReady.clear()
    for (const listener of this.listeners) listener(value)
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
      attachments, skills: previous?.draftId === this.manualDraftId ? previous.skills : undefined, requestId: this.state.draftRequestId, updatedAt: new Date().toISOString() })
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
        && this.promptDigest(previous.text, previous.attachments, previous.skills) === this.promptDigest(draft.text, draft.attachments, draft.skills)
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
  command(command: AgentCommand): Promise<AgentState> {
    if (command.type !== 'manual-send' && command.type !== 'steer' && command.type !== 'queue-followup') return this.commandUnreserved(command)
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
    try { this.commandUnreserved(prompt).then(resolve, reject) } catch (error) { reject(error) }
    void task.finally(() => this.promptAdmissions.delete(key)).catch(() => undefined)
    return task
  }
  private commandUnreserved(command: AgentCommand): Promise<AgentState> {
    if (this.retirementFailure) { this.state.error = this.retirementFailure; return Promise.resolve(this.get()) }
    // Provider discovery has independent progress; a stalled account must not own the thread command lane.
    if ((command.type === 'connect' || command.type === 'disconnect' || command.type === 'refresh') && (command.provider || this.dependencies.host.concurrentProviders)) return this.providerCommand(command)
    if (command.type === 'refresh-thread-skills') return this.refreshThreadSkills(command.threadId, command.forceReload)
    // Selection owns no action authority and must not wait for provider actions.
    if (command.type === 'select-thread') return this.navigate(command.threadId)
    if (command.type === 'observe-threads') {
      this.viewedThreadIds = [...new Set(command.threadIds)].filter(id => this.state.host.threads.some(thread => thread.id === id))
      this.observe()
      return Promise.resolve(this.get())
    }
    if (command.type === 'save-thread-draft') return this.saveThreadDraft(command)
    if (command.type === 'queue-followup' || command.type === 'edit-followup' || command.type === 'remove-followup' || command.type === 'reorder-followups' || command.type === 'resume-followups') return this.followupCommand(command)
    const actionThreadId = 'threadId' in command ? command.threadId : ''
    const actionDraftId = 'draftId' in command ? command.draftId : undefined
    const reconcilingDraft = command.type === 'manual-send' && this.outbox.some(item => item.threadId === actionThreadId && item.draftId === actionDraftId)
    if (command.type === 'manual-send' && !reconcilingDraft && (this.threadActions.has(actionThreadId) || this.pumping.has(actionThreadId) || this.state.host.threads.find(t => t.id === actionThreadId)?.status === 'running' || this.followupStore.get().items.some(item => item.threadId === actionThreadId))) {
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
            attachments: command.attachments ?? [], skills: command.skills, requestId: null, updatedAt: new Date().toISOString() })
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
    const independent = command.type === 'manual-send' || command.type === 'steer'
    const task = (independent ? this.threadActions.get(actionThreadId) ?? Promise.resolve() : this.serial).catch(() => undefined).then(async () => {
      if (!independent) this.state.busy = true
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
        await this.execute(command, turn, manualRetryId, selectionRevision)
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
      if (!independent) this.state.busy = false
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
      this.threadActions.set(actionThreadId, task)
      void task.finally(() => { if (this.threadActions.get(actionThreadId) === task) this.threadActions.delete(actionThreadId); this.pumpFollowups() }).catch(() => undefined)
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
            attachments: command.attachments ?? [], skills: command.skills, ...(thread.status === 'idle' && !thread.requests.length ? { resumeAfterTurnId: thread.lastTurn?.id ?? 'unknown' } : {}) })
        } else {
          await this.followupStore.edit(thread.id, command.itemId, { text: command.text, attachments: command.attachments ?? existing?.attachments ?? [], skills: command.skills ?? existing?.skills })
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
      if (this.pumping.has(threadId) || this.threadActions.has(threadId)) continue
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
          await this.dispatch({ type: 'send', commandId: item.commandId!, threadId, messageId: item.messageId!, text: item.text.trim(), attachments: item.attachments, ...(item.skills ? { skills: item.skills } : {}),
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
    try {
      this.state.error = null
      await this.followupStore.pause(command.threadId, 'The turn was interrupted. Review the thread and resume queued follow-ups when ready.')
      this.syncFollowups(); await this.execute(command, turn); await this.persist()
    } catch (error) { failure = error instanceof Error ? error.message : 'Could not interrupt this thread.'; this.state.error = failure }
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
      ...(command.attachments ? { attachments: command.attachments } : {}), ...(command.skills ? { skills: command.skills } : {}),
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
    this.state.activeThreadId = thread.id; this.state.activeProjectId = thread.projectId
    const waiting = this.state.queue.find(q => q.threadId === thread.id)
    this.presentedQueueId = waiting?.id ?? null
    this.queueSelectionPinned = true
    if (waiting && !this.state.composing) this.narrateAttention(waiting)
    this.observe()
    this.state.pendingRequest = ''
  }
  private async execute(command: AgentCommand, turn?: ActiveTurn, manualRetryId?: string, selectionRevision = this.selectionRevision): Promise<void> {
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
          attachments: this.state.draftAttachments ?? [], skills: previous?.skills, requestId: this.state.draftRequestId, updatedAt: new Date().toISOString() })
        return
      }
      case 'cancel-draft': this.clearDraft(); this.say('Draft cleared.'); return
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
      case 'manual-send': await this.sendManual(command.threadId, command.text, turn, manualRetryId, command.attachments, command.draftId, command.skills); return
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
      case 'retry-thread-worktree':
      case 'refresh-thread-worktree': {
        if (!this.dependencies.host.updateThreadWorktree) throw new Error('Working-copy status is unavailable.')
        this.acceptSnapshot(await this.dependencies.host.updateThreadWorktree(command.threadId, command.type === 'retry-thread-worktree'))
        return
      }
      case 'open-thread-folder': {
        if (!this.dependencies.host.threadWorkingDirectory || !this.dependencies.openThreadFolder) throw new Error('Opening the working folder is unavailable.')
        await this.dependencies.openThreadFolder(await this.dependencies.host.threadWorkingDirectory(command.threadId))
        return
      }
      case 'create-thread': {
        if (this.state.composing && this.hasDraft()) throw new Error('Send or clear your draft before creating another thread.')
        const model = this.state.host.models.find(model => model.id === command.modelId)
        this.canCreate(model?.providerId)
        if (!this.state.host.capabilities.threads) throw new Error('This provider cannot create threads.')
        if (!this.state.host.projects.some(p => p.id === command.projectId)) throw new Error('Choose an available project.')
        if (!this.state.host.models.some(m => m.id === command.modelId && m.ready)) throw new Error('That model or account is unavailable. Choose a ready model; Sotto will not switch your account.')
        validateThreadOptions(this.state.host, command)
        const threadId = randomUUID()
        if (turn) { turn.threadId = threadId; turn.projectId = command.projectId }
        const previousSelectionPinned = this.queueSelectionPinned
        if (selectionRevision === this.selectionRevision) this.queueSelectionPinned = true
        try {
          await this.dispatch({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: command.projectId, title: command.title, modelId: command.modelId,
            ...(command.workingCopy ? { workingCopy: command.workingCopy } : {}),
            ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}),
            ...(command.runtimeMode !== undefined ? { runtimeMode: command.runtimeMode } : {}) }, turn)
        } catch (error) { if (selectionRevision === this.selectionRevision) this.queueSelectionPinned = previousSelectionPinned; throw error }
        if (selectionRevision === this.selectionRevision) {
          this.presentedQueueId = null
          this.state.activeThreadId = threadId; this.state.activeProjectId = command.projectId
        }
        this.observe(); this.acceptSnapshot(await this.readThread(threadId))
        if (selectionRevision === this.selectionRevision) this.state.activeProjectId = this.thread(threadId).projectId
        if (command.managed !== false) this.assign(threadId, '', selectionRevision)
        if (!(this.state.providerUpgrade && this.state.draftThreadId === null && this.hasDraft())) {
          this.clearDraft(); this.startDraft(threadId)
        }
        this.state.pendingRequest = ''
        this.say(`Opened ${command.title}. Tell me your prompt, then say send it.`)
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
      case 'later': case 'next': {
        if (this.state.composing && this.hasDraft()) throw new Error('Send or clear your draft before moving to another queued thread.')
        if (this.state.composing) this.clearDraft()
        const current = this.state.queue.find(q => q.threadId === this.state.activeThreadId)
        if (current) { this.state.queue = this.state.queue.filter(q => q.id !== current.id); current.deferred = true; this.state.queue.push(current) }
        this.presentQueue(true, selectionRevision); return
      }
      case 'answer': {
        this.canAct()
        const assignment = this.state.assignments.find(item => item.threadId === command.threadId)
        const thread = this.thread(command.threadId)
        if (isThreadClosed(thread)) throw new Error('This thread is settled or archived. Reopen it before answering an old request.')
        const request = thread.requests.find(r => r.id === command.requestId)
        if (!request) throw new Error('This request is no longer pending. Refresh the thread.')
        if (request.kind === 'permission' && command.approved === undefined) throw new Error('Choose Allow or Deny for this permission request.')
        const answerDraft = this.state.threadDrafts?.find(draft => draft.threadId === command.threadId && draft.requestId === command.requestId
          && draft.text.trim() === command.answer.trim() && !draft.attachments.length)
        if (request.delivery === 'uncertain') throw new Error('This answer may already have arrived. Refresh the original request; it will not be resent.')
        await this.dispatch({ type: 'answer', commandId: randomUUID(), threadId: command.threadId, requestId: command.requestId, answer: command.answer, ...(command.approved === undefined ? {} : { approved: command.approved }), ...(command.questionAnswers ? { questionAnswers: command.questionAnswers } : {}), ...(command.permissionChoice ? { permissionChoice: command.permissionChoice } : {}) }, turn)
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
  private async dispatch(command: AgentHostCommand, turn?: ActiveTurn, validate?: () => void, draftId?: string): Promise<void> {
    if (turn) this.dispatchTurns.set(command.commandId, turn)
    try { await this.dispatchPending(command, turn, validate, draftId) }
    finally { this.dispatchTurns.delete(command.commandId) }
  }
  private async dispatchPending(command: AgentHostCommand, turn?: ActiveTurn, validate?: () => void, draftId?: string): Promise<void> {
    this.canAct()
    const threadId = 'threadId' in command ? command.threadId : undefined
    const provider = command.type === 'create-project' ? command.provider ?? this.state.configuration.provider
      : command.type === 'create-thread' || (command.type === 'configure-thread' && command.modelId && this.thread(command.threadId).nativeSessionStarted === false)
        ? this.state.host.models.find(model => model.id === command.modelId)?.providerId : this.thread(command.threadId).providerId
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
    this.outbox.push({ id: command.commandId, type: command.type, ...(provider ? { provider } : {}), ...(threadId ? { threadId } : {}),
      ...('messageId' in command ? { messageId: command.messageId } : {}),
      ...('requestId' in command ? { requestId: command.requestId } : {}),
      ...(command.type === 'configure-thread' ? { options: agentThreadOptionsSchema.parse({ ...command,
        ...(command.modelId !== undefined && command.reasoningEffort === undefined && this.state.host.models.find(model => model.id === command.modelId)?.defaultReasoningEffort
          ? { reasoningEffort: this.state.host.models.find(model => model.id === command.modelId)!.defaultReasoningEffort } : {}) }) } : {}),
      ...((command.type === 'send' || command.type === 'steer') ? { draftDigest: this.promptDigest(command.text, command.attachments, command.skills), ...(draftId ? { draftId } : {}) } : {}),
      ...(command.type === 'create-project' ? { entityId: command.projectId } : command.type === 'create-thread' ? { entityId: command.threadId } : {}),
    })
    if ((command.type === 'send' || command.type === 'steer') && draftId) this.setDelivery(command.threadId, draftId, 'submitting', { commandId: command.commandId, messageId: command.messageId })
    try { await this.persist() }
    catch (error) {
      // Nothing crossed the adapter boundary. Do not leave phantom uncertain intent.
      this.outbox = this.outbox.filter(item => item.id !== command.commandId)
      if ((command.type === 'send' || command.type === 'steer') && draftId) this.setDelivery(command.threadId, draftId, 'failed')
      throw error
    }
    if ((command.type === 'send' || command.type === 'steer') && draftId) {
      this.publish()
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
    this.outbox = this.outbox.filter(o => o.id !== command.commandId)
    await this.persist()
    if (!result.accepted && !result.uncertain) throw new Error('The provider rejected this action. Check its current permissions and account status.')
    this.acceptSnapshot(await this.readThread(threadId, provider))
  }
  private async sendManual(threadId: string, text: string, turn?: ActiveTurn, retryId?: string, attachments: AgentAttachment[] = [], draftId?: string, skills?: AgentSkillReference[]): Promise<void> {
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
    await this.dispatch({ type: 'send', commandId: randomUUID(), threadId, messageId, text: text.trim(), ...(skills ? { skills } : {}), ...(attachments.length ? { attachments } : {}), expectedLastUserMessageId: thread.messages.findLast(m => m.role === 'user')?.id ?? null }, turn, validate, draftId)
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
    const skills = this.state.threadDrafts?.find(item => item.threadId === thread.id && item.draftId === draftId)?.skills
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
    await this.dispatch({ type: 'send', commandId: randomUUID(), threadId: thread.id, messageId, text, ...(skills ? { skills } : {}), ...(attachments.length ? { attachments } : {}), expectedLastUserMessageId: thread.messages.findLast(message => message.role === 'user')?.id ?? null }, turn, undefined, draftId)
    if (this.manualDraftId === draftId) this.clearDraft()
    this.state.queue = this.state.queue.filter(q => q.threadId !== thread.id || q.kind === 'permission' || q.kind === 'question')
    this.say(`Sent to ${thread.title}.`)
    this.presentQueue(true, selectionRevision)
  }
  private startDraft(threadId = this.state.activeThreadId): void {
    const thread = this.thread(threadId)
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
  private promptDigest(text: string, attachments: AgentAttachment[] = [], skills: AgentSkillReference[] = []): string {
    return followupDigest({ text, attachments, skills })
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
    const activeQuestion = this.state.queue.find(q => q.threadId === this.state.activeThreadId && (q.kind === 'question' || q.kind === 'permission'))
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
      intent = await this.dependencies.reasoner.intent(request, this.state.host, this.state.activeProjectId, this.state.configuration.defaultModelId, this.state.activeThreadId, preferences)
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
          ? snapshot.threads.some(t => t.id === item.entityId) : item.type === 'configure-thread'
            ? thread !== undefined && item.options !== undefined && Object.entries(item.options).every(([key, value]) => thread[key as keyof AgentThread] === (key === 'modelId' && typeof value === 'string' ? this.dependencies.host.resolveModelId?.(value) ?? value : value)) : item.type === 'answer'
            ? thread !== undefined && !thread.requests.some(r => r.id === item.requestId) : thread?.status === 'idle'
      if (!confirmed) continue
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
          || item.draftDigest !== this.promptDigest(draft.text, draft.attachments, draft.skills))
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
        await this.dispatch({ type: 'answer', commandId: randomUUID(), threadId: thread.id, requestId, answer: decision.text }, turn, validate)
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
  dispose(): void { this.disposed = true; if (this.membershipTimer) clearInterval(this.membershipTimer); this.unsubscribe?.(); this.disconnect(); this.listeners.clear() }
}
