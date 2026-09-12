import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  agentAssignmentSchema, agentConfigurationSchema, agentQueueItemSchema, agentAttachmentsSchema, agentThreadOptionsSchema,
  providerUpgradeSchema, defaultAgentConfiguration, EMPTY_AGENT_HOST, PROVIDER_LABELS, supportsAgentSupervision, isSubscriptionReasoning, agentDeliveryReceiptsSchema, MAX_DELIVERED_DRAFTS,
  type AgentAttachment, type AgentAssignment, type AgentCommand, type AgentHostSnapshot, type AgentQueueItem, type AgentState, type AgentThread, type SubscriptionProvider,
} from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { MemoryProfile } from '../memory/profile'
import type { AgentCredentials } from './credentials'
import { approvalWords, classifyRiskyAction, denialWords, type Authority } from './authority'
import type { AgentHost, AgentHostCommand } from './host'
import type { AgentPreference, AgentReasoner } from './reasoning'
import { addTurnContext, type ActiveTurn, type TurnRecorder } from './turns'
import { isThreadClosed } from '../../shared/threadActivity'
import { attentionItemKey, isLiveAttention } from '../../shared/agentAttention'
import { maintainProviderRecovery, retireLegacyProvider, stripRetiredEndpoint } from './providerRetirement'
import { validatePromptAttachments, validateThreadOptions } from './threadOptions'

const RECORDED_COMMAND_TYPES: ReadonlySet<AgentCommand['type']> = new Set([
  'utterance', 'connect', 'refresh', 'send', 'manual-send', 'answer', 'create-thread', 'create-project', 'select-project',
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
  pendingRequest: z.string().max(20_000).default(''),
  contextSavedAt: z.number().default(0),
  composing: z.boolean(), outbox: z.array(z.object({
    id: z.string(), type: z.enum(['send', 'create-project', 'create-thread', 'configure-thread', 'answer', 'interrupt']),
    threadId: z.string().optional(), messageId: z.string().optional(), entityId: z.string().optional(), requestId: z.string().optional(),
    options: agentThreadOptionsSchema.optional(), draftDigest: z.string().optional(), draftId: z.uuid().optional(),
  })),
})
type Saved = z.infer<typeof savedSchema>
class SupersededSupervision extends Error {}
export interface AgentMembership {
  status(): Promise<AgentState['membership']>
  action(action: 'refresh' | 'signin' | 'checkout' | 'portal'): Promise<AgentState['membership']>
}

/** Owns assignment authority, queue ordering and durable dispatch intent across all host adapters. */
export class AgentControl {
  private state: AgentState
  private outbox: Saved['outbox'] = []
  private readonly store: AtomicJsonStore<Saved>
  private readonly listeners = new Set<(state: AgentState) => void>()
  private readonly deciding = new Set<string>()
  private readonly considered = new Map<string, string>()
  private readonly recoveredQueueIds = new Map<string, Set<string>>()
  private readonly accountChecks = new Map<SubscriptionProvider, Promise<void>>()
  private serial: Promise<unknown> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private reconnect: ReturnType<typeof setTimeout> | null = null
  private retirementFailure: string | null = null
  private disposed = false
  private membershipTimer: ReturnType<typeof setInterval> | null = null
  private presentedQueueId: string | null = null
  private readonly narratedAttention = new Set<string>()
  private attentionNarration: string | null = null
  private queueSelectionPinned = false
  private speechPreferenceRevision = 0
  private selectionRevision = 0
  private manualDraftId: string | null = null
  private contextActivityAt = Date.now()
  constructor(private readonly dependencies: {
    directory: string; host: AgentHost; credentials: AgentCredentials; reasoner: AgentReasoner; membership: AgentMembership
    historyEnabled?: () => boolean
    turns?: TurnRecorder
    authority?: Authority
    preferences?: Pick<MemoryProfile, 'retrieve'>
  }) {
    this.state = {
      configuration: defaultAgentConfiguration(), connection: 'disconnected', host: structuredClone(EMPTY_AGENT_HOST),
      assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
      draftRequestId: null, draftAttachments: [], deliveredDrafts: [],
      pendingRequest: '',
      busy: false, notice: '', error: null, speech: { id: 0, text: '' },
      voice: { status: 'off', error: null, action: 'none', revision: 0 },
      credentials: { reasoning: false, grokSpeech: false, secure: false },
      reasoningAccounts: [],
      membership: { status: 'free', label: 'Free dictation', expiresAt: null },
    }
    this.store = new AtomicJsonStore(join(dependencies.directory, 'agents.json'), savedSchema.parse, () => this.saved())
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
    this.contextActivityAt = saved.contextSavedAt
    const { outbox, contextSavedAt, manualDraftId, ...restored } = saved
    this.manualDraftId = manualDraftId
    Object.assign(this.state, restored)
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
    this.outbox = outbox
    // Redaction also reaches disk when control is disabled and no reconnect will run.
    await this.persist()
    this.state.membership = await this.dependencies.membership.status()
    this.membershipTimer = setInterval(() => {
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
    if (this.state.configuration.enabled) await this.command({ type: 'connect' })
  }
  get(): AgentState { return structuredClone(this.state) }
  subscribe(listener: (state: AgentState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private saved(): Saved {
    const { configuration, assignments, queue, activeThreadId, activeProjectId, draft, draftThreadId, draftRequestId, composing, pendingRequest } = this.state
    const retainContext = this.dependencies.historyEnabled?.() !== false
    return structuredClone({ configuration, providerUpgrade: this.state.providerUpgrade ?? null,
      assignments: assignments.map(assignment => ({ ...assignment, instruction: retainContext ? assignment.instruction : '', paused: assignment.paused || (!retainContext && Boolean(assignment.instruction)) })),
      queue: queue.map(item => ({ ...item, text: retainContext ? item.text : 'Open the provider to review this pending item.' })),
      activeThreadId, activeProjectId, draft, draftThreadId, draftRequestId, draftAttachments: this.state.draftAttachments ?? [], composing, pendingRequest: retainContext ? pendingRequest : '',
      contextSavedAt: this.contextActivityAt, outbox: this.outbox, manualDraftId: this.manualDraftId, deliveredDrafts: this.state.deliveredDrafts ?? [] })
  }
  async privacyChanged(): Promise<void> {
    await maintainProviderRecovery(this.dependencies.directory, this.dependencies.historyEnabled?.() !== false)
    await this.persist()
  }
  private async persist(): Promise<void> {
    if (this.retirementFailure) throw new Error(this.retirementFailure)
    await this.store.write(this.saved())
  }
  private publish(): void {
    if (this.disposed) return
    const value = this.get()
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
      ...this.outbox.flatMap(item => item.threadId ? [item.threadId] : []), ...threadIds])])
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
  private canAct(): void {
    if (!['active', 'beta'].includes(this.state.membership.status)) throw new Error('Agent actions require an active Sotto membership. Free dictation remains available.')
    if (this.state.membership.expiresAt && Date.parse(this.state.membership.expiresAt) <= Date.now()) throw new Error('Refresh your Sotto membership before starting more agent actions. Existing provider work continues.')
    if (!this.state.host.connected) throw new Error('Reconnect the provider before sending. Your draft is saved.')
  }
  private canCreate(): void {
    this.canAct()
    if (this.outbox.some(item => item.type === 'create-project' || item.type === 'create-thread')) {
      throw new Error('An earlier creation has an unknown result. Reconnect and inspect the provider before creating anything else; select the existing project or thread if it appears.')
    }
  }
  command(command: AgentCommand): Promise<AgentState> {
    if (this.retirementFailure) { this.state.error = this.retirementFailure; return Promise.resolve(this.get()) }
    // Selection owns no action authority and must not wait for provider actions.
    if (command.type === 'select-thread') return this.navigate(command.threadId)
    const selectionRevision = this.selectionRevision
    const manualWhileBusy = command.type === 'manual-send' && this.state.busy
    const manualRetryId = command.type === 'manual-send' ? this.outbox.find(item => item.threadId === command.threadId)?.id
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
    const task = this.serial.then(async () => {
      this.state.busy = true
      this.state.error = null
      this.publish()
      const turn = RECORDED_COMMAND_TYPES.has(command.type)
        ? this.beginTurn({
          source: command.type === 'utterance' ? 'utterance' : 'command',
          commandType: command.type,
          ...(command.type === 'utterance' && command.voiceTiming ? { voiceTiming: command.voiceTiming } : {}),
          text: command.type === 'utterance' ? command.text
            : command.type === 'manual-send' ? command.text : command.type === 'send' ? this.state.draft : command.type === 'answer' ? command.answer : '',
        }) : undefined
      let failure: string | undefined
      try {
        if (manualWhileBusy) throw new Error('Another action is still in progress. Wait before sending this prompt.')
        await this.execute(command, turn, manualRetryId, selectionRevision)
      } catch (error) {
        failure = error instanceof Error ? error.message : 'Sotto could not complete this action.'
        this.state.error = failure
        this.say(failure)
      }
      this.state.busy = false
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
      if (turn) turn.firstFeedbackAtMs = Date.now()
      await this.finishTurn(turn, failure)
      return this.get()
    })
    this.serial = task.catch(() => undefined)
    return task
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
        const providerChanged = next.provider !== this.state.configuration.provider
        if (providerChanged && (this.state.assignments.length || this.outbox.length)) throw new Error('Unassign threads and resolve pending actions before changing the provider.')
        // Delete the old route's key durably before exposing the new route. If
        // either write fails, the old credential cannot reach another provider.
        if (next.reasoning !== this.state.configuration.reasoning) await this.dependencies.credentials.set('reasoning', '')
        if (providerChanged) this.disconnect()
        if (next.provider !== this.state.configuration.provider) {
          if (command.patch.defaultModelId === undefined) next.defaultModelId = ''
          this.state.host = { ...structuredClone(EMPTY_AGENT_HOST), name: PROVIDER_LABELS[next.provider] }
          this.state.activeThreadId = null
          this.state.activeProjectId = null
        }
        if (speechRevision !== this.speechPreferenceRevision) next.speak = this.state.configuration.speak
        this.state.configuration = next
        if (!next.enabled) this.disconnect()
        return
      }
      case 'credential': await this.dependencies.credentials.set(command.slot, command.value.trim()); return
      case 'membership':
        this.state.membership = await this.dependencies.membership.action(command.action)
        if (!['active', 'beta'].includes(this.state.membership.status)) this.state.assignments.forEach(a => { a.paused = true })
        return
      case 'connect': {
        this.state.connection = 'connecting'; this.publish()
        this.observe()
        try {
          const snapshot = await this.dependencies.host.connect()
          this.acceptSnapshot(snapshot)
          if (!snapshot.connected) throw new Error(snapshot.error || `${PROVIDER_LABELS[this.state.configuration.provider]} did not confirm the connection.`)
          this.state.configuration.enabled = true
          this.say(`${PROVIDER_LABELS[this.state.configuration.provider]} connected`)
        } catch (error) {
          this.disconnect()
          throw error
        }
        return
      }
      case 'disconnect': this.state.configuration.enabled = false; this.disconnect(); this.say('Sotto disconnected.'); return
      case 'refresh': this.observe(); this.acceptSnapshot(await this.dependencies.host.snapshot()); return
      case 'check-reasoning': await this.checkReasoning(command.provider); return
      case 'utterance': await this.utterance(command.text.trim(), turn, selectionRevision); return
      case 'compose':
        this.manualDraftId = null
        if (!this.state.composing) this.startDraft()
        if (command.attachments !== undefined) this.state.draftAttachments = agentAttachmentsSchema.parse(command.attachments)
        this.state.draft = command.text
        return
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
      case 'manual-send': await this.sendManual(command.threadId, command.text, turn, manualRetryId, command.attachments, command.draftId); return
      case 'create-project': {
        this.canCreate()
        if (!this.state.host.capabilities.projects) throw new Error('This provider does not support creating projects.')
        if (/[<>:"/\\|?*]/u.test(command.title) || /[. ]$/u.test(command.title) || /^(\.|\.\.|con|prn|aux|nul|com\d|lpt\d)$/iu.test(command.title)) throw new Error('Choose a project name that can be used as a folder name.')
        const target = command.path || (this.state.configuration.projectsDirectory ? join(this.state.configuration.projectsDirectory, command.title) : '')
        if (!target || !isAbsolute(target)) throw new Error('Choose an absolute project folder or configure a default projects directory.')
        const path = resolve(target)
        const existing = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null })
        if (existing && (!existing.isDirectory() || !command.useExisting)) throw new Error('That folder already exists. Select “Use existing folder” to attach it without overwriting its contents.')
        if (!existing) await mkdir(path, { recursive: true })
        const projectId = randomUUID()
        if (turn) { turn.threadId = null; turn.projectId = projectId }
        const previousSelectionPinned = this.queueSelectionPinned
        if (selectionRevision === this.selectionRevision) this.queueSelectionPinned = true
        try {
          await this.dispatch({ type: 'create-project', commandId: randomUUID(), projectId, title: command.title, path }, turn)
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
      case 'select-project':
        if (selectionRevision !== this.selectionRevision) return
        if (!this.state.host.projects.some(p => p.id === command.projectId)) throw new Error('That project is unavailable.')
        this.state.activeProjectId = command.projectId; this.state.activeThreadId = null; this.state.pendingRequest = ''
        this.queueSelectionPinned = true; this.presentedQueueId = null
        this.observe(); return
      case 'create-thread': {
        if (this.state.composing && this.hasDraft()) throw new Error('Send or clear your draft before creating another thread.')
        this.canCreate()
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
            ...(command.reasoningEffort !== undefined ? { reasoningEffort: command.reasoningEffort } : {}),
            ...(command.runtimeMode !== undefined ? { runtimeMode: command.runtimeMode } : {}) }, turn)
        } catch (error) { if (selectionRevision === this.selectionRevision) this.queueSelectionPinned = previousSelectionPinned; throw error }
        if (selectionRevision === this.selectionRevision) {
          this.presentedQueueId = null
          this.state.activeThreadId = threadId; this.state.activeProjectId = command.projectId
        }
        this.observe(); this.acceptSnapshot(await this.dependencies.host.snapshot())
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
        if (!this.state.host.capabilities.configureThread) throw new Error('This provider does not support changing thread settings.')
        this.observe(command.threadId)
        this.acceptSnapshot(await this.dependencies.host.snapshot())
        const validate = (): void => {
          const thread = this.thread(command.threadId)
          if (thread.status === 'running' || thread.requests.length) throw new Error('Wait for this thread to finish and answer its pending requests before changing settings.')
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
        this.canAct()
        this.observe(command.threadId)
        this.acceptSnapshot(await this.dependencies.host.snapshot())
        this.assign(command.threadId, command.instruction ?? '', selectionRevision)
        this.observe()
        return
      }
      case 'unassign':
        this.state.assignments = this.state.assignments.filter(a => a.threadId !== command.threadId)
        this.state.queue = this.state.queue.filter(q => q.threadId !== command.threadId)
        this.observe(); return
      case 'resume': {
        this.canAct()
        const assignment = this.assignment(command.threadId)
        assignment.mode = 'managed'; assignment.paused = false; assignment.followups = 0; assignment.lastFailure = ''
        assignment.stopReason = 'none'; assignment.stoppedAt = ''
        this.considered.delete(command.threadId)
        this.recoveredQueueIds.delete(command.threadId)
        this.state.queue = this.state.queue.filter(q => q.threadId !== command.threadId || q.kind !== 'blocked')
        this.say(`Resumed managing ${this.thread(command.threadId).title}.`)
        this.acceptSnapshot(await this.dependencies.host.snapshot())
        return
      }
      case 'pause': this.assignment(command.threadId).paused = true; this.say(`Paused management of ${this.thread(command.threadId).title}. Provider work continues.`); return
      case 'interrupt': {
        const validate = (): void => {
          this.canAct()
          if (!this.state.host.capabilities.interrupt) throw new Error('This connection cannot stop agent work.')
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
        await this.dispatch({ type: 'answer', commandId: randomUUID(), threadId: command.threadId, requestId: command.requestId, answer: command.answer, ...(command.approved === undefined ? {} : { approved: command.approved }) }, turn)
        assignment?.handledRequestIds.push(command.requestId)
        this.state.queue = this.state.queue.filter(q => q.requestId !== command.requestId)
        if (this.state.draftThreadId === command.threadId && this.state.draftRequestId === command.requestId) this.clearDraft()
        this.say(`Answered ${thread.title}.`)
        this.presentQueue(true, selectionRevision)
        return
      }
    }
  }
  private assign(threadId: string, instruction: string, selectionRevision: number): void {
    if (!supportsAgentSupervision(this.state.host.capabilities)) throw new Error('This connection cannot safely supervise threads. Its available controls remain visible.')
    const thread = this.thread(threadId)
    if (this.state.assignments.some(a => a.threadId === threadId)) return
    this.state.assignments.push({ threadId, mode: 'managed', instruction, followups: 0, paused: false,
      startedAt: new Date().toISOString(), origin: 'unknown', stopReason: 'none', stoppedAt: '',
      contextUpdatedAt: Date.now(),
      seenMessageIds: thread.messages.map(m => m.id), ownMessageIds: [], handledRequestIds: [], lastFailure: '' })
    if (selectionRevision === this.selectionRevision) {
      this.state.activeThreadId = threadId; this.state.activeProjectId = thread.projectId
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
  private readThread(threadId?: string): Promise<AgentHostSnapshot> {
    const host = this.dependencies.host
    return threadId && host.refreshThread ? host.refreshThread(threadId) : host.snapshot()
  }
  private async dispatch(command: AgentHostCommand, turn?: ActiveTurn, validate?: () => void, draftId?: string): Promise<void> {
    this.canAct()
    const threadId = 'threadId' in command ? command.threadId : undefined
    if (this.outbox.some(item => item.threadId === threadId)) throw new Error('An earlier action has an unknown result. Reconnect and inspect the provider before retrying; Sotto will not send it twice.')
    this.outbox.push({ id: command.commandId, type: command.type, ...(threadId ? { threadId } : {}),
      ...('messageId' in command ? { messageId: command.messageId } : {}),
      ...('requestId' in command ? { requestId: command.requestId } : {}),
      ...(command.type === 'configure-thread' ? { options: agentThreadOptionsSchema.parse({ ...command,
        ...(command.modelId !== undefined && command.reasoningEffort === undefined && this.state.host.models.find(model => model.id === command.modelId)?.defaultReasoningEffort
          ? { reasoningEffort: this.state.host.models.find(model => model.id === command.modelId)!.defaultReasoningEffort } : {}) }) } : {}),
      ...(command.type === 'send' ? { draftDigest: this.promptDigest(command.text, command.attachments), ...(draftId ? { draftId } : {}) } : {}),
      ...(command.type === 'create-project' ? { entityId: command.projectId } : command.type === 'create-thread' ? { entityId: command.threadId } : {}),
    })
    await this.persist()
    let result
    if (command.type === 'send' || command.type === 'answer') addTurnContext(turn, command.type === 'send' ? command.text : command.answer)
    const delegatedAt = Date.now()
    try {
      this.canAct(); this.guardAuthority(command, turn); validate?.()
      result = await this.dependencies.host.execute(command)
    } catch (error) {
      this.outbox = this.outbox.filter(o => o.id !== command.commandId)
      await this.persist()
      throw error
    } finally {
      if (turn) turn.delegationMs += Date.now() - delegatedAt
    }
    // An exact native message already reconciled this outbox item. Delivery is
    // settled even if its running turn prevents a later display/history read.
    if (command.type === 'send' && !this.outbox.some(item => item.id === command.commandId)) {
      await this.persist()
      return
    }
    if (result.uncertain && this.outbox.some(o => o.id === command.commandId)) throw new Error('The provider did not confirm the result. Sotto will reconcile the existing action when reconnected; it will not resend it.')
    if ((command.type === 'configure-thread' || command.type === 'send') && result.accepted) {
      try { this.acceptSnapshot(await this.readThread(threadId)) }
      catch (error) {
        // The exact echo can arrive while this required reconciliation read is
        // in flight. Keep its receipt; an unconfirmed command still fails here.
        if (command.type !== 'send' || this.outbox.some(item => item.id === command.commandId)) throw error
      }
      await this.persist()
      if (this.outbox.some(item => item.id === command.commandId)) throw new Error(command.type === 'send'
        ? 'The provider has not confirmed this user message in its state. Refresh to reconcile the existing send; it will not be replayed.'
        : 'The provider has not confirmed these thread settings in its state. Refresh to reconcile the existing save; it will not be replayed.')
      return
    }
    this.outbox = this.outbox.filter(o => o.id !== command.commandId)
    await this.persist()
    if (!result.accepted && !result.uncertain) throw new Error('The provider rejected this action. Check its current permissions and account status.')
    this.acceptSnapshot(await this.readThread(threadId))
  }
  private async sendManual(threadId: string, text: string, turn?: ActiveTurn, retryId?: string, attachments: AgentAttachment[] = [], draftId?: string): Promise<void> {
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
    this.thread(threadId)
    attachments = agentAttachmentsSchema.parse(attachments)
    // Manual composers own their text per thread. A send must not replace the
    // coordinator's saved prompt or answer on a different thread.
    if (!preserveDraft) {
      this.state.draftAttachments = attachments
      this.manualDraftId = draftId ?? null
      this.state.draft = text; this.state.draftThreadId = threadId; this.state.draftRequestId = null; this.state.composing = true
      await this.persist()
    }
    this.canAct()
    this.observe(threadId)
    this.acceptSnapshot(await this.readThread(threadId))
    const validate = (): void => {
      this.canAct()
      const latest = this.thread(threadId)
      if (!text.trim() && !attachments.length) throw new Error('There is no prompt to send.')
      validatePromptAttachments(this.state.host, latest.modelId, attachments)
      if (!this.state.host.capabilities.submit || !this.state.host.capabilities.reconcile) throw new Error('This connection cannot safely send and reconcile a prompt.')
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
    await this.dispatch({ type: 'send', commandId: randomUUID(), threadId, messageId, text: text.trim(), ...(attachments.length ? { attachments } : {}), expectedLastUserMessageId: thread.messages.findLast(m => m.role === 'user')?.id ?? null }, turn, validate, draftId)
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
    await this.dispatch({ type: 'send', commandId: randomUUID(), threadId: thread.id, messageId, text, ...(attachments.length ? { attachments } : {}), expectedLastUserMessageId: thread.messages.findLast(message => message.role === 'user')?.id ?? null }, turn)
    this.clearDraft()
    this.state.queue = this.state.queue.filter(q => q.threadId !== thread.id || q.kind === 'permission' || q.kind === 'question')
    this.say(`Sent to ${thread.title}.`)
    this.presentQueue(true, selectionRevision)
  }
  private startDraft(threadId = this.state.activeThreadId): void {
    const thread = this.thread(threadId)
    this.manualDraftId = null
    const question = this.state.queue.find(item => item.threadId === thread.id && item.kind === 'question' && item.requestId)
    this.state.draftThreadId = thread.id
    this.state.draftRequestId = question?.requestId ?? null
    this.state.composing = true
  }
  private clearDraft(): void {
    this.manualDraftId = null
    this.state.draftAttachments = []
    this.state.draft = ''; this.state.draftThreadId = null; this.state.draftRequestId = null; this.state.composing = false
  }
  private hasDraft(): boolean { return Boolean(this.state.draft.trim() || this.state.draftAttachments?.length) }
  private promptDigest(text: string, attachments: AgentAttachment[] = []): string {
    return createHash('sha256').update(JSON.stringify([text.trim(), attachments])).digest('hex')
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
        await this.execute({ type: 'answer', threadId: activeQuestion.threadId, requestId: activeQuestion.requestId, answer: text, approved: approvalWords.includes(normalized) }, turn, undefined, selectionRevision)
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
  private acceptSnapshot(snapshot: AgentHostSnapshot): void {
    if (this.disposed) return
    const connecting = this.state.connection === 'connecting'
    this.state.host = snapshot
    this.state.connection = snapshot.connected ? 'connected' : connecting ? 'connecting' : 'disconnected'
    if (!snapshot.connected) {
      if (!connecting && this.state.configuration.enabled && !this.reconnect) this.reconnect = setTimeout(() => {
        this.reconnect = null
        void this.command({ type: 'connect' }).then(s => { if (s.connection !== 'connected') this.acceptSnapshot({ ...s.host, connected: false }) })
      }, 5000)
      this.publish(); return
    }
    if (this.reconnect) clearTimeout(this.reconnect)
    this.reconnect = null
    this.state.queue = this.state.queue.filter(item => isLiveAttention(item, snapshot.threads))
    if (this.attentionNarration && !this.state.queue.some(item => attentionItemKey(item) === this.attentionNarration)) {
      this.attentionNarration = null
      this.state.notice = ''; this.state.speech.text = ''
      this.state.voice.action = 'stop-speaking'; this.state.voice.revision += 1
    }
    for (const item of [...this.outbox]) {
      const thread = snapshot.threads.find(t => t.id === item.threadId)
      const message = thread?.messages.find(m => m.role === 'user' && m.id === item.messageId)
      const confirmed = item.type === 'send' ? Boolean(message) : item.type === 'create-project'
        ? snapshot.projects.some(p => p.id === item.entityId) : item.type === 'create-thread'
          ? snapshot.threads.some(t => t.id === item.entityId) : item.type === 'configure-thread'
            ? thread !== undefined && item.options !== undefined && Object.entries(item.options).every(([key, value]) => thread[key as keyof AgentThread] === value) : item.type === 'answer'
            ? thread !== undefined && !thread.requests.some(r => r.id === item.requestId) : thread?.status === 'idle'
      if (!confirmed) continue
      this.outbox = this.outbox.filter(o => o.id !== item.id)
      if (message && item.draftId && item.threadId) {
        this.state.deliveredDrafts = [...(this.state.deliveredDrafts ?? []).filter(receipt => receipt.threadId !== item.threadId || receipt.draftId !== item.draftId),
          { threadId: item.threadId, draftId: item.draftId }].slice(-MAX_DELIVERED_DRAFTS)
      }
      if (message && (!item.draftId || item.draftId === this.manualDraftId) && this.state.draftThreadId === thread?.id && (item.draftDigest
        ? item.draftDigest === this.promptDigest(this.state.draft, this.state.draftAttachments)
        : !this.state.draftAttachments?.length && this.state.draft.trim() === message.text)) {
        this.clearDraft()
      }
    }
    let announcedManualControl = false
    for (const assignment of this.state.assignments) {
      const thread = snapshot.threads.find(t => t.id === assignment.threadId)
      if (!thread || isThreadClosed(thread)) continue
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
        if (assignment.mode === 'manual' || assignment.paused || !assignment.instruction || this.state.configuration.reasoning === 'none') {
          this.enqueue(thread, question ? 'question' : 'ready', question?.text ?? last?.text ?? 'Ready for your next prompt.', question?.id)
          this.considered.set(thread.id, key)
        } else void this.supervise(thread, assignment, key, question?.id)
      }
    }
    // Requests resolved directly in the host leave the queue; skipped requests stay pending.
    this.state.queue = this.state.queue.filter(item => isLiveAttention(item, snapshot.threads))
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
    if (this.deciding.has(thread.id)) return
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
      if (current !== assignment || current.mode !== 'managed' || current.paused || !latest || isThreadClosed(latest) || !this.state.host.connected) return
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
      this.acceptSnapshot(await this.dependencies.host.snapshot())
      const validate = (): void => {
        const current = this.state.assignments.find(item => item.threadId === thread.id)
        const live = this.state.host.threads.find(item => item.id === thread.id)
        if (this.disposed || current !== assignment || current.mode !== 'managed' || current.paused || !live || isThreadClosed(live)
          || !supportsAgentSupervision(this.state.host.capabilities)) throw new SupersededSupervision('Management authority changed before dispatch.')
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
      if (this.state.host.connected && this.state.assignments.includes(assignment) && assignment.mode === 'managed' && !assignment.paused) {
        this.acceptSnapshot(this.state.host)
      } else this.presentQueue(false)
      this.publish()
    }
  }
  private disconnect(): void {
    if (this.reconnect) clearTimeout(this.reconnect)
    this.reconnect = null
    this.dependencies.host.disconnect()
    this.state.connection = 'disconnected'; this.state.host.connected = false
  }
  dispose(): void { this.disposed = true; if (this.membershipTimer) clearInterval(this.membershipTimer); this.unsubscribe?.(); this.disconnect(); this.listeners.clear() }
}
