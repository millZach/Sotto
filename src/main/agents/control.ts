import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import {
  agentAssignmentSchema, agentConfigurationSchema, agentQueueItemSchema,
  defaultAgentConfiguration, EMPTY_AGENT_HOST, supportsAgentSupervision, isSubscriptionReasoning,
  type AgentAssignment, type AgentCommand, type AgentHostSnapshot, type AgentQueueItem, type AgentState, type AgentThread, type SubscriptionProvider,
} from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentCredentials } from './credentials'
import type { AgentHost, AgentHostCommand } from './host'
import type { AgentReasoner } from './reasoning'
import { addTurnContext, type ActiveTurn, type TurnRecorder } from './turns'

const RECORDED_COMMAND_TYPES: ReadonlySet<AgentCommand['type']> = new Set([
  'utterance', 'connect', 'refresh', 'send', 'answer', 'create-thread', 'create-project', 'select-project',
  'select-thread', 'assign', 'unassign', 'resume', 'pause', 'interrupt', 'next', 'later',
  'cancel-draft', 'cancel-request',
])

const savedSchema = z.object({
  configuration: z.preprocess(value => typeof value === 'object' && value !== null
    ? { ...defaultAgentConfiguration(), ...value } : value, agentConfigurationSchema),
  assignments: z.array(agentAssignmentSchema), queue: z.array(agentQueueItemSchema),
  activeThreadId: z.string().nullable(), activeProjectId: z.string().nullable(), draft: z.string(), draftThreadId: z.string().nullable(),
  draftRequestId: z.string().nullable().default(null),
  pendingRequest: z.string().max(20_000).default(''),
  contextSavedAt: z.number().default(0),
  composing: z.boolean(), outbox: z.array(z.object({
    id: z.string(), type: z.enum(['send', 'create-project', 'create-thread', 'answer', 'interrupt']),
    threadId: z.string().optional(), messageId: z.string().optional(), entityId: z.string().optional(), requestId: z.string().optional(),
  })),
})
type Saved = z.infer<typeof savedSchema>
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
  private disposed = false
  private membershipTimer: ReturnType<typeof setInterval> | null = null
  private presentedQueueId: string | null = null
  private queueSelectionPinned = false
  private contextActivityAt = Date.now()
  constructor(private readonly dependencies: {
    directory: string; host: AgentHost; credentials: AgentCredentials; reasoner: AgentReasoner; membership: AgentMembership
    historyEnabled?: () => boolean
    turns?: TurnRecorder
  }) {
    this.state = {
      configuration: defaultAgentConfiguration(), connection: 'disconnected', host: structuredClone(EMPTY_AGENT_HOST),
      assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
      draftRequestId: null,
      pendingRequest: '',
      busy: false, notice: '', error: null, speech: { id: 0, text: '' },
      voice: { status: 'off', error: null, action: 'none', revision: 0 },
      credentials: { t3: false, reasoning: false, grokSpeech: false, secure: false },
      reasoningAccounts: [],
      membership: { status: 'free', label: 'Free dictation', expiresAt: null },
    }
    this.store = new AtomicJsonStore(join(dependencies.directory, 'agents.json'), savedSchema.parse, () => this.saved())
  }
  async start(): Promise<void> {
    const saved = await this.store.read()
    this.contextActivityAt = saved.contextSavedAt
    const { outbox, contextSavedAt, ...restored } = saved
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
      .map(item => historyDisabled ? { ...item, text: 'Open T3 to review this pending request.' } : item)
    // A durable attention item means its observation already reached a result.
    // Do not persist the in-flight `considered` map: a crash must retry unfinished work.
    for (const item of this.state.queue) {
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
    return structuredClone({ configuration,
      assignments: assignments.map(assignment => ({ ...assignment, instruction: retainContext ? assignment.instruction : '', paused: assignment.paused || (!retainContext && Boolean(assignment.instruction)) })),
      queue: queue.map(item => ({ ...item, text: retainContext ? item.text : 'Open T3 to review this pending item.' })),
      activeThreadId, activeProjectId, draft, draftThreadId, draftRequestId, composing, pendingRequest: retainContext ? pendingRequest : '',
      contextSavedAt: this.contextActivityAt, outbox: this.outbox })
  }
  async privacyChanged(): Promise<void> { await this.persist() }
  private async persist(): Promise<void> { await this.store.write(this.saved()) }
  private publish(): void {
    if (this.disposed) return
    const value = this.get()
    for (const listener of this.listeners) listener(value)
  }
  private say(text: string, preview = false): void {
    this.state.notice = text
    this.state.speech = { id: this.state.speech.id + 1, text, preview }
  }
  private updateCredentials(): void {
    const vault = this.dependencies.credentials
    this.state.credentials = { t3: vault.has('t3'), reasoning: vault.has('reasoning'), grokSpeech: vault.has('grokSpeech'), secure: vault.available() }
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
  private observe(): void {
    this.dependencies.host.observeThreads?.([...new Set([...this.state.assignments.map(a => a.threadId), ...(this.state.activeThreadId ? [this.state.activeThreadId] : [])])])
  }
  private thread(id: string | null): AgentThread {
    const thread = this.state.host.threads.find(t => t.id === id)
    if (!thread) throw new Error('Select an available T3 thread first.')
    return thread
  }
  private assignment(id: string): AgentAssignment {
    const assignment = this.state.assignments.find(a => a.threadId === id)
    if (!assignment) throw new Error('Assign this thread to Sotto first.')
    return assignment
  }
  private canAct(): void {
    if (!['active', 'beta'].includes(this.state.membership.status)) throw new Error('Agent actions require an active Sotto membership. Free dictation remains available.')
    if (this.state.membership.expiresAt && Date.parse(this.state.membership.expiresAt) <= Date.now()) throw new Error('Refresh your Sotto membership before starting more agent actions. Existing T3 work continues.')
    if (!this.state.host.connected) throw new Error('Reconnect T3 before sending. Your draft is saved.')
  }
  private canCreate(): void {
    this.canAct()
    if (this.outbox.some(item => item.type === 'create-project' || item.type === 'create-thread')) {
      throw new Error('An earlier creation has an unknown result. Reconnect and inspect T3 before creating anything else; select the existing project or thread if it appears.')
    }
  }
  command(command: AgentCommand): Promise<AgentState> {
    if (command.type === 'voice-state') {
      this.state.voice.status = command.status; this.state.voice.error = command.error; this.publish()
      return Promise.resolve(this.get())
    }
    if (command.type === 'voice') {
      this.state.voice.action = command.action; this.state.voice.revision += 1; this.publish()
      return Promise.resolve(this.get())
    }
    // Host observations bypass this lane: a direct T3 send must revoke authority even during model reasoning.
    const task = this.serial.then(async () => {
      this.state.busy = true
      this.state.error = null
      this.publish()
      const turn = RECORDED_COMMAND_TYPES.has(command.type)
        ? this.beginTurn({
          source: command.type === 'utterance' ? 'utterance' : 'command',
          commandType: command.type,
          text: command.type === 'utterance' ? command.text
            : command.type === 'send' ? this.state.draft : command.type === 'answer' ? command.answer : '',
        }) : undefined
      let failure: string | undefined
      try { await this.execute(command, turn) } catch (error) {
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
      await this.finishTurn(turn, failure)
      this.publish()
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
  private async execute(command: AgentCommand, turn?: ActiveTurn): Promise<void> {
    // Explicit targets survive host observations and queue-driven selection changes.
    if (turn && 'threadId' in command) {
      turn.threadId = command.threadId
      turn.projectId = this.state.host.threads.find(thread => thread.id === command.threadId)?.projectId ?? null
    } else if (turn && 'projectId' in command) {
      turn.threadId = null
      turn.projectId = command.projectId
    }
    if (['utterance', 'compose', 'assign', 'send', 'answer'].includes(command.type)) this.contextActivityAt = Date.now()
    switch (command.type) {
      case 'preview-voice': this.say('Hi, I’m Sotto. Your agents are ready when you are.', true); return
      case 'cancel-request': this.state.pendingRequest = ''; this.say('Pending request cleared.'); return
      case 'voice': this.state.voice.action = command.action; this.state.voice.revision += 1; return
      case 'voice-state': this.state.voice.status = command.status; this.state.voice.error = command.error; return
      case 'configure': {
        const next = agentConfigurationSchema.parse({ ...this.state.configuration, ...command.patch })
        if (next.endpoint !== this.state.configuration.endpoint && (this.state.assignments.length || this.outbox.length)) throw new Error('Unassign threads and resolve pending actions before changing the T3 server.')
        // Delete the old route's key durably before exposing the new route. If
        // either write fails, the old credential cannot reach another provider.
        if (next.reasoning !== this.state.configuration.reasoning) await this.dependencies.credentials.set('reasoning', '')
        if (next.endpoint !== this.state.configuration.endpoint) {
          await this.dependencies.credentials.set('t3', '')
          this.disconnect()
        }
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
          const snapshot = await this.dependencies.host.connect({ endpoint: this.state.configuration.endpoint, credential: this.dependencies.credentials.get('t3') })
          this.acceptSnapshot(snapshot)
          if (!snapshot.connected) throw new Error('T3 did not confirm the connection.')
          this.state.configuration.enabled = true
          this.say('T3 Code connected')
        } catch (error) {
          this.disconnect()
          throw error
        }
        return
      }
      case 'disconnect': this.state.configuration.enabled = false; this.disconnect(); this.say('Sotto disconnected. T3 work continues.'); return
      case 'refresh': this.observe(); this.acceptSnapshot(await this.dependencies.host.snapshot()); return
      case 'check-reasoning': await this.checkReasoning(command.provider); return
      case 'utterance': await this.utterance(command.text.trim(), turn); return
      case 'compose':
        if (!this.state.composing) this.startDraft()
        this.state.draft = command.text
        return
      case 'cancel-draft': this.clearDraft(); this.say('Draft cleared.'); return
      case 'send': await this.sendDraft(turn); return
      case 'create-project': {
        this.canCreate()
        if (!this.state.host.capabilities.projects) throw new Error('This T3 version does not support creating projects.')
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
        this.queueSelectionPinned = true
        try {
          await this.dispatch({ type: 'create-project', commandId: randomUUID(), projectId, title: command.title, path }, turn)
        } catch (error) { this.queueSelectionPinned = previousSelectionPinned; throw error }
        this.state.activeProjectId = projectId; this.state.activeThreadId = null
        this.presentedQueueId = null
        this.observe()
        this.state.pendingRequest = ''
        this.say(`Created ${command.title} in ${path}.`)
        return
      }
      case 'select-project':
        if (!this.state.host.projects.some(p => p.id === command.projectId)) throw new Error('That project is unavailable.')
        this.state.activeProjectId = command.projectId; this.state.activeThreadId = null; this.state.pendingRequest = ''
        this.queueSelectionPinned = true; this.presentedQueueId = null
        this.observe(); return
      case 'create-thread': {
        if (this.state.composing && this.state.draft.trim()) throw new Error('Send or clear your draft before creating another thread.')
        this.canCreate()
        if (!this.state.host.capabilities.threads) throw new Error('This T3 version cannot create threads.')
        if (!this.state.host.projects.some(p => p.id === command.projectId)) throw new Error('Choose an available project.')
        if (!this.state.host.models.some(m => m.id === command.modelId && m.ready)) throw new Error('That model or account is unavailable. Choose a ready model; Sotto will not switch your account.')
        const threadId = randomUUID()
        if (turn) { turn.threadId = threadId; turn.projectId = command.projectId }
        const previousSelectionPinned = this.queueSelectionPinned
        this.queueSelectionPinned = true
        try {
          await this.dispatch({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: command.projectId, title: command.title, modelId: command.modelId }, turn)
        } catch (error) { this.queueSelectionPinned = previousSelectionPinned; throw error }
        this.presentedQueueId = null
        this.state.activeThreadId = threadId; this.state.activeProjectId = command.projectId
        this.observe(); this.acceptSnapshot(await this.dependencies.host.snapshot())
        this.assign(threadId, '')
        this.clearDraft(); this.startDraft()
        this.state.pendingRequest = ''
        this.say(`Opened ${command.title}. Tell me your prompt, then say send it.`)
        return
      }
      case 'select-thread': {
        const thread = this.thread(command.threadId)
        this.state.activeThreadId = thread.id; this.state.activeProjectId = thread.projectId
        const waiting = this.state.queue.find(q => q.threadId === thread.id)
        this.presentedQueueId = waiting?.id ?? null
        this.queueSelectionPinned = true
        if (waiting && !this.state.composing) this.say(`${this.state.host.projects.find(p => p.id === thread.projectId)?.title ?? 'Project'}, ${thread.title}. ${waiting.text.slice(0, 600)}`)
        this.observe()
        this.state.pendingRequest = ''
        return
      }
      case 'assign': {
        this.canAct()
        this.dependencies.host.observeThreads?.([...this.state.assignments.map(a => a.threadId), command.threadId])
        this.acceptSnapshot(await this.dependencies.host.snapshot())
        this.assign(command.threadId, command.instruction ?? '')
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
        this.considered.delete(command.threadId)
        this.recoveredQueueIds.delete(command.threadId)
        this.state.queue = this.state.queue.filter(q => q.threadId !== command.threadId || q.kind !== 'blocked')
        this.say(`Resumed managing ${this.thread(command.threadId).title}.`)
        this.acceptSnapshot(await this.dependencies.host.snapshot())
        return
      }
      case 'pause': this.assignment(command.threadId).paused = true; this.say(`Paused management of ${this.thread(command.threadId).title}. T3 work continues.`); return
      case 'interrupt': this.canAct(); this.assignment(command.threadId).paused = true; await this.dispatch({ type: 'interrupt', commandId: randomUUID(), threadId: command.threadId }, turn); return
      case 'later': case 'next': {
        if (this.state.composing && this.state.draft.trim()) throw new Error('Send or clear your draft before moving to another queued thread.')
        if (this.state.composing) this.clearDraft()
        const current = this.state.queue.find(q => q.threadId === this.state.activeThreadId)
        if (current) { this.state.queue = this.state.queue.filter(q => q.id !== current.id); current.deferred = true; this.state.queue.push(current) }
        this.presentQueue(true); return
      }
      case 'answer': {
        this.canAct()
        const assignment = this.assignment(command.threadId)
        const thread = this.thread(command.threadId)
        const request = thread.requests.find(r => r.id === command.requestId)
        if (!request) throw new Error('This request is no longer pending. Refresh the thread.')
        if (request.kind === 'permission' && command.approved === undefined) throw new Error('Choose Allow or Deny for this permission request.')
        await this.dispatch({ type: 'answer', commandId: randomUUID(), threadId: command.threadId, requestId: command.requestId, answer: command.answer, ...(command.approved === undefined ? {} : { approved: command.approved }) }, turn)
        assignment.handledRequestIds.push(command.requestId)
        this.state.queue = this.state.queue.filter(q => q.requestId !== command.requestId)
        if (this.state.draftThreadId === command.threadId && this.state.draftRequestId === command.requestId) this.clearDraft()
        this.say(`Answered ${thread.title}.`)
        this.presentQueue(true)
        return
      }
    }
  }
  private assign(threadId: string, instruction: string): void {
    if (!supportsAgentSupervision(this.state.host.capabilities)) throw new Error('This connection cannot safely supervise threads. Its available controls remain visible.')
    const thread = this.thread(threadId)
    if (this.state.assignments.some(a => a.threadId === threadId)) return
    this.state.assignments.push({ threadId, mode: 'managed', instruction, followups: 0, paused: false,
      contextUpdatedAt: Date.now(),
      seenMessageIds: thread.messages.map(m => m.id), ownMessageIds: [], handledRequestIds: [], lastFailure: '' })
    this.state.activeThreadId = threadId; this.state.activeProjectId = thread.projectId
  }
  private async dispatch(command: AgentHostCommand, turn?: ActiveTurn): Promise<void> {
    this.canAct()
    const threadId = 'threadId' in command ? command.threadId : undefined
    if (this.outbox.some(item => item.threadId === threadId)) throw new Error('An earlier action has an unknown result. Reconnect and inspect T3 before retrying; Sotto will not send it twice.')
    this.outbox.push({ id: command.commandId, type: command.type, ...(threadId ? { threadId } : {}),
      ...('messageId' in command ? { messageId: command.messageId } : {}),
      ...('requestId' in command ? { requestId: command.requestId } : {}),
      ...(command.type === 'create-project' ? { entityId: command.projectId } : command.type === 'create-thread' ? { entityId: command.threadId } : {}),
    })
    await this.persist()
    let result
    if (command.type === 'send' || command.type === 'answer') addTurnContext(turn, command.type === 'send' ? command.text : command.answer)
    const delegatedAt = Date.now()
    try { result = await this.dependencies.host.execute(command) } catch (error) {
      this.outbox = this.outbox.filter(o => o.id !== command.commandId)
      await this.persist()
      throw error
    } finally {
      if (turn) turn.delegationMs += Date.now() - delegatedAt
    }
    if (result.uncertain && this.outbox.some(o => o.id === command.commandId)) throw new Error('T3 did not confirm the result. Sotto will reconcile the existing action when reconnected; it will not resend it.')
    this.outbox = this.outbox.filter(o => o.id !== command.commandId)
    await this.persist()
    if (!result.accepted && !result.uncertain) throw new Error('T3 rejected this action. Check its current permissions and account status.')
    this.acceptSnapshot(await this.dependencies.host.snapshot())
  }
  private async sendDraft(turn?: ActiveTurn): Promise<void> {
    if (turn) {
      turn.threadId = this.state.draftThreadId
      turn.projectId = this.state.host.threads.find(thread => thread.id === this.state.draftThreadId)?.projectId ?? null
    }
    this.canAct()
    const thread = this.thread(this.state.draftThreadId)
    if (!this.state.draft.trim()) throw new Error('There is no prompt to send.')
    const assignment = this.assignment(thread.id)
    const text = this.state.draft.trim()
    if (this.state.draftRequestId) {
      const requestId = this.state.draftRequestId
      if (!thread.requests.some(request => request.id === requestId && request.kind === 'question')) throw new Error('This question is no longer pending. Your answer is saved; review it before starting a new prompt.')
      await this.execute({ type: 'answer', threadId: thread.id, requestId, answer: text }, turn)
      return
    }
    if (thread.status === 'running') throw new Error('This thread is still working. Your draft is saved; wait for it to finish or explicitly stop the agent.')
    const messageId = randomUUID()
    assignment.ownMessageIds.push(messageId)
    assignment.instruction = text; assignment.followups = 0; assignment.lastFailure = ''
    assignment.contextUpdatedAt = Date.now()
    await this.dispatch({ type: 'send', commandId: randomUUID(), threadId: thread.id, messageId, text }, turn)
    this.clearDraft()
    this.state.queue = this.state.queue.filter(q => q.threadId !== thread.id || q.kind === 'permission' || q.kind === 'question')
    this.say(`Sent to ${thread.title}.`)
    this.presentQueue(true)
  }
  private startDraft(): void {
    const thread = this.thread(this.state.activeThreadId)
    const question = this.state.queue.find(item => item.threadId === thread.id && item.kind === 'question' && item.requestId)
    this.state.draftThreadId = thread.id
    this.state.draftRequestId = question?.requestId ?? null
    this.state.composing = true
  }
  private clearDraft(): void {
    this.state.draft = ''; this.state.draftThreadId = null; this.state.draftRequestId = null; this.state.composing = false
  }
  private async utterance(text: string, turn?: ActiveTurn): Promise<void> {
    addTurnContext(turn, text)
    const normalized = text.toLocaleLowerCase().replace(/[.!?,]+$/u, '').trim()
    if (normalized === 'send it') { await this.sendDraft(turn); return }
    if (normalized === 'cancel draft' || normalized === 'clear draft') { await this.execute({ type: 'cancel-draft' }, turn); return }
    if (normalized === 'next' || normalized === 'later') { await this.execute({ type: normalized }, turn); return }
    const resume = /^(resume managing|pause managing|manage|select|open) (.+)$/iu.exec(normalized)
    if (resume && !(this.state.pendingRequest && ['select', 'open'].includes(resume[1]!))) {
      const matches = this.state.host.threads.filter(t => t.title.toLocaleLowerCase() === resume[2])
      if (matches.length > 0) {
        if (resume[1] === 'manage' && matches.length === 1 && matches[0]!.id === this.state.draftThreadId
          && !this.state.assignments.some(assignment => assignment.threadId === matches[0]!.id)) {
          await this.execute({ type: 'assign', threadId: matches[0]!.id }, turn)
          this.say(`Managing ${matches[0]!.title}. Your draft is ready; say send it when you are ready.`)
          return
        }
        if (this.state.composing && this.state.draft.trim()) throw new Error('Send or clear your draft before using thread management controls.')
        if (matches.length > 1) throw new Error('More than one thread has that name. Select the thread using the controls.')
        if (this.state.composing) this.clearDraft()
        await this.execute({ type: resume[1] === 'resume managing' ? 'resume' : resume[1] === 'pause managing' ? 'pause' : resume[1] === 'manage' ? 'assign' : 'select-thread', threadId: matches[0]!.id }, turn)
        return
      }
    }
    if ((this.state.composing || this.state.activeThreadId) && !this.state.draft.trim() && /^(here[’']?s my prompt|here is my prompt|start prompt|my prompt is)\b/u.test(normalized)) {
      if (!this.state.composing) this.startDraft()
      this.state.draft = text.replace(/^(here[’']?s my prompt|here is my prompt|start prompt|my prompt is)\b[:,.]?\s*/iu, '')
      this.say('I’m listening. Say send it when your prompt is ready.')
      return
    }
    if (this.state.composing) { this.state.draft = `${this.state.draft}${this.state.draft ? ' ' : ''}${text}`; return }
    const activeQuestion = this.state.queue.find(q => q.threadId === this.state.activeThreadId && (q.kind === 'question' || q.kind === 'permission'))
    if (activeQuestion?.requestId) {
      if (activeQuestion.kind === 'permission') {
        if (!['allow', 'deny', 'approve', 'reject'].includes(normalized)) { this.say('Say allow or deny for this permission request.'); return }
        await this.execute({ type: 'answer', threadId: activeQuestion.threadId, requestId: activeQuestion.requestId, answer: text, approved: ['allow', 'approve'].includes(normalized) }, turn)
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
    const intentStarted = Date.now()
    let intent
    try {
      intent = await this.dependencies.reasoner.intent(request, this.state.host, this.state.activeProjectId, this.state.configuration.defaultModelId, this.state.activeThreadId)
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
          if (this.state.draft.trim()) throw new Error('Send or clear your existing draft before preparing another prompt.')
          await this.execute({ type: 'select-thread', threadId: intent.threadId }, turn)
          this.clearDraft(); this.startDraft(); this.state.draft = intent.text
          this.say(this.state.assignments.some(assignment => assignment.threadId === intent.threadId)
            ? `Prompt for ${this.thread(intent.threadId).title}. ${intent.text ? 'Review or keep speaking, then say send it.' : 'Tell me your prompt, then say send it.'}`
            : `Prompt for ${this.thread(intent.threadId).title}. Manage this thread before sending; your draft is saved.`)
        } else await this.execute(intent, turn)
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
    this.state.host = snapshot
    this.state.connection = snapshot.connected ? 'connected' : 'disconnected'
    if (!snapshot.connected) {
      if (this.state.configuration.enabled && !this.reconnect) this.reconnect = setTimeout(() => {
        this.reconnect = null
        void this.command({ type: 'connect' }).then(s => { if (s.connection !== 'connected') this.acceptSnapshot({ ...s.host, connected: false }) })
      }, 5000)
      this.publish(); return
    }
    for (const item of [...this.outbox]) {
      const thread = snapshot.threads.find(t => t.id === item.threadId)
      const message = thread?.messages.find(m => m.id === item.messageId)
      const confirmed = item.type === 'send' ? Boolean(message) : item.type === 'create-project'
        ? snapshot.projects.some(p => p.id === item.entityId) : item.type === 'create-thread'
          ? snapshot.threads.some(t => t.id === item.entityId) : item.type === 'answer'
            ? thread !== undefined && !thread.requests.some(r => r.id === item.requestId) : thread?.status === 'idle'
      if (!confirmed) continue
      this.outbox = this.outbox.filter(o => o.id !== item.id)
      if (message && this.state.draftThreadId === thread?.id && this.state.draft.trim() === message.text) {
        this.clearDraft()
      }
    }
    let announcedManualControl = false
    for (const assignment of this.state.assignments) {
      const thread = snapshot.threads.find(t => t.id === assignment.threadId)
      if (!thread) continue
      const fresh = thread.messages.filter(m => !assignment.seenMessageIds.includes(m.id))
      if (fresh.length) assignment.contextUpdatedAt = Date.now()
      if (assignment.contextUpdatedAt < Date.now() - 7 * 86_400_000 && assignment.instruction) {
        assignment.instruction = ''; assignment.paused = true
      }
      if (fresh.some(m => m.role === 'user' && !assignment.ownMessageIds.includes(m.id))) {
        if (assignment.mode !== 'manual') {
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
    this.state.queue = this.state.queue.filter(q => q.requestId
      ? snapshot.threads.some(t => t.id === q.threadId && t.requests.some(r => r.id === q.requestId))
      : Date.parse(q.createdAt) > Date.now() - 7 * 86_400_000)
    if (!announcedManualControl) this.presentQueue(false)
    void this.persist().catch(() => { this.state.assignments.forEach(a => { a.paused = true }); this.state.error = 'Agent state could not be saved. Management paused.'; this.publish() })
    this.publish()
  }
  private enqueue(thread: AgentThread, kind: AgentQueueItem['kind'], text: string, requestId?: string): void {
    const id = `${thread.id}:${requestId ?? thread.messages.at(-1)?.id ?? 'idle'}:${kind}`
    const existing = this.state.queue.find(q => q.id === id)
    if (existing) { existing.text = text.slice(0, 12000); return }
    if (!requestId) this.state.queue = this.state.queue.filter(q => q.threadId !== thread.id || q.requestId)
    this.state.queue.push({ id, threadId: thread.id, kind, text: text.slice(0, 12000), ...(requestId ? { requestId } : {}), createdAt: new Date().toISOString(), deferred: false })
  }
  private presentQueue(force: boolean): void {
    if (force) this.queueSelectionPinned = false
    else if (this.queueSelectionPinned) return
    if (this.state.composing || !this.state.queue.length) return
    const current = this.state.queue.find(q => q.threadId === this.state.activeThreadId)
    if (!force && current && this.presentedQueueId === current.id) return
    const first = this.state.queue[0]!
    this.presentedQueueId = first.id
    const thread = this.state.host.threads.find(t => t.id === first.threadId)
    if (!thread) return
    this.state.activeThreadId = thread.id; this.state.activeProjectId = thread.projectId
    const project = this.state.host.projects.find(p => p.id === thread.projectId)
    this.say(`${project?.title ?? 'Project'}, ${thread.title}. ${first.text.slice(0, 600)}`)
  }
  private async supervise(thread: AgentThread, assignment: AgentAssignment, key: string, requestId?: string): Promise<void> {
    if (this.deciding.has(thread.id)) return
    this.deciding.add(thread.id); this.considered.set(thread.id, key)
    let turn: ActiveTurn | undefined
    let failure: string | undefined
    try {
      if (assignment.followups >= this.state.configuration.followupLimit) {
        assignment.paused = true; this.enqueue(thread, 'blocked', `The ${this.state.configuration.followupLimit} follow-up limit is reached. Review the thread and resume management to authorize more.`); return
      }
      this.canAct()
      const decision = await this.dependencies.reasoner.decide(assignment.instruction, structuredClone(thread))
      const current = this.state.assignments.find(a => a.threadId === thread.id)
      const latest = this.state.host.threads.find(t => t.id === thread.id)
      if (current !== assignment || current.mode !== 'managed' || current.paused || !latest || !this.state.host.connected) return
      const latestKey = latest.requests.find(r => r.kind === 'question' && !current.handledRequestIds.includes(r.id))?.id ?? latest.messages.at(-1)?.id
      if (latestKey !== key || (!requestId && latest.status === 'running')) return
      if (decision.decision !== 'followup') {
        this.enqueue(thread, decision.decision === 'human' ? (requestId ? 'question' : 'blocked') : 'ready', decision.text, requestId); return
      }
      const failure = (thread.messages.at(-1)?.text ?? thread.requests.find(r => r.id === requestId)?.text ?? decision.text).toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
      const failureFingerprint = createHash('sha256').update(failure).digest('hex')
      if (!failure || failureFingerprint === assignment.lastFailure) {
        assignment.paused = true; this.enqueue(thread, 'blocked', 'The agent is repeating a failure without progress. Review the thread before resuming.'); return
      }
      turn = this.beginTurn({ source: 'supervision', commandType: 'send', text: decision.text, threadId: thread.id, projectId: thread.projectId })
      this.canAct()
      assignment.lastFailure = failureFingerprint; assignment.followups += 1
      await this.persist()
      // Refresh immediately before dispatch, so a direct host send revokes this queued reply.
      this.acceptSnapshot(await this.dependencies.host.snapshot())
      if (assignment.mode !== 'managed' || assignment.paused || !this.state.assignments.includes(assignment)) return
      if (requestId) {
        await this.dispatch({ type: 'answer', commandId: randomUUID(), threadId: thread.id, requestId, answer: decision.text }, turn)
        assignment.handledRequestIds.push(requestId)
      } else {
        const messageId = randomUUID(); assignment.ownMessageIds.push(messageId)
        await this.dispatch({ type: 'send', commandId: randomUUID(), threadId: thread.id, messageId, text: decision.text, expectedLastUserMessageId: latest.messages.findLast(m => m.role === 'user')?.id ?? null }, turn)
      }
    } catch (error) {
      assignment.paused = true
      failure = error instanceof Error ? error.message : 'Sotto needs your attention to continue.'
      this.enqueue(thread, 'blocked', failure)
    } finally {
      await this.persist().catch(error => {
        assignment.paused = true
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
