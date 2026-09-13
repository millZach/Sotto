import { randomUUID } from 'node:crypto'
import { requestQuestionsDigest, type BindRequestDraftDecision } from './requestDrafts'
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { personalChatSchema, personalDraftInputSchema, personalSendInputSchema, personalAnswerInputSchema, type PersonalChat, type PersonalChatState, type PersonalChatCommand } from '../../shared/personalChats'
import type { AgentHostSnapshot } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { CodexAppServerHost, type CodexPersonalConversation } from './codex'
import type { MemoryProfile } from '../memory/profile'
import { MAX_AGENT_ACTIVITIES } from '../../shared/agentActivity'

const savedSchema = z.object({ selectedChatId: personalChatSchema.shape.id.nullable(), chats: z.array(personalChatSchema) })
  .refine(saved => new Set(saved.chats.map(chat => chat.id)).size === saved.chats.length, 'Personal chat IDs must be unique.')
type Saved = z.infer<typeof savedSchema>
const storageWarning = 'Personal chat storage is read-only because chats.json could not be fully read. The original file is unchanged; no backup was created. Restore or repair that file and restart before editing or connecting.'
const recoveryWarning = 'Some saved observations could not be read. This is partial cached history; the original chats.json is unchanged.'
const recoveryCoreSchema = personalChatSchema.omit({ messages: true, activities: true, requests: true, title: true, status: true, historyStatus: true, historyError: true, lastTurn: true })

/** Read-only salvage: never infer identities, drafts or delivery records, and
 * never replace the source with this partial view. Ambiguous IDs stay on disk. */
function recoverSaved(input: unknown): Saved {
  const envelope = z.object({ chats: z.array(z.unknown()), selectedChatId: z.unknown().optional() }).safeParse(input)
  if (!envelope.success) return { selectedChatId: null, chats: [] }
  const chats: PersonalChat[] = []
  const idCounts = new Map<string, number>()
  for (const value of envelope.data.chats) {
    const identity = z.object({ id: z.string() }).safeParse(value)
    if (identity.success) idCounts.set(identity.data.id, (idCounts.get(identity.data.id) ?? 0) + 1)
  }
  for (const value of envelope.data.chats) {
    const fields = z.record(z.string(), z.unknown()).safeParse(value)
    if (!fields.success) continue
    const full = personalChatSchema.safeParse(value)
    if (full.success) { chats.push(full.data); continue }
    // A decision's cached request is an observation, distinct from the exact
    // answer and delivery IDs. Omit only an unreadable request in this view.
    const decisions = z.array(z.record(z.string(), z.unknown())).safeParse(fields.data.decisions)
    const decisionSchema = personalChatSchema.shape.decisions.unwrap().element
    const recoveredFields = { ...fields.data }
    if (decisions.success) recoveredFields.decisions = decisions.data.map(decision => {
      if (decisionSchema.shape.request.safeParse(decision.request).success) return decision
      const copy = { ...decision }; delete copy.request; return copy
    })
    const core = recoveryCoreSchema.safeParse(recoveredFields)
    if (!core.success) continue
    const messages = z.array(z.unknown()).safeParse(fields.data.messages)
    const activities = z.array(z.unknown()).safeParse(fields.data.activities)
    const title = personalChatSchema.shape.title.safeParse(fields.data.title)
    chats.push({ ...core.data, title: title.success ? title.data : 'Personal chat', status: 'idle', requests: [],
      messages: messages.success ? messages.data.flatMap(item => {
        const parsed = personalChatSchema.shape.messages.element.safeParse(item); return parsed.success ? [parsed.data] : []
      }) : [],
      activities: activities.success ? activities.data.flatMap(item => {
        const parsed = personalChatSchema.shape.activities.unwrap().element.safeParse(item); return parsed.success ? [parsed.data] : []
      }).slice(-MAX_AGENT_ACTIVITIES) : [],
      historyStatus: 'error', historyError: recoveryWarning })
  }
  const unique = chats.filter(chat => idCounts.get(chat.id) === 1)
  return { chats: unique, selectedChatId: unique.find(chat => chat.id === envelope.data.selectedChatId)?.id ?? null }
}
function definedFields<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> }
}
type PersonalConversationHost = Pick<CodexAppServerHost, 'closed' | 'connect' | 'createPersonalConversation' | 'disconnect' | 'execute' | 'listThreadSkills' | 'personalSnapshot' | 'refreshThread' | 'sendPersonalConversation' | 'subscribe'>
export interface PersonalChatOptions {
  userDataPath: string
  configuration: () => { reasoning: string; reasoningModel: string; reasoningEffort: string }
  host?: PersonalConversationHost
  preferences?: Pick<MemoryProfile, 'retrieve'>
  bindRequestDraftDecision?: BindRequestDraftDecision
  historyEnabled?: () => boolean
}
/** A separate durable conversation aggregate. No project registry, policy writer,
 * coordinator command parser or management capability is reachable from here. */
export class PersonalChatService {
  private saved: Saved = { selectedChatId: null, chats: [] }
  private readonly store: AtomicJsonStore<Saved>
  private readonly host: PersonalConversationHost
  private readonly cwd: string
  private readonly directory: string
  private readonly listeners = new Set<(state: PersonalChatState) => void>()
  private readonly jobs = new Set<Promise<void>>()
  private readonly busy = new Set<string>()
  private writing: Promise<unknown> = Promise.resolve()
  private connected = false
  private connecting = false
  private error: string | undefined
  private storageError: string | undefined
  private readonly unreadableNativeState = new Set<string>()
  private generation = 0
  private configurationKey = ''
  private unsubscribe: (() => void) | undefined
  constructor(private readonly options: PersonalChatOptions) {
    const directory = this.directory = join(options.userDataPath, 'personal-chat')
    this.cwd = join(directory, 'native-workspace')
    this.store = new AtomicJsonStore(join(directory, 'chats.json'), savedSchema.parse, () => ({ selectedChatId: null, chats: [] }))
    this.host = options.host ?? new CodexAppServerHost({ userDataPath: directory })
  }
  async start(): Promise<void> {
    // AtomicJsonStore.peek intentionally treats invalid and missing alike. This
    // cache must distinguish them without creating extra plaintext backups.
    try {
      const contents = await readFile(join(this.directory, 'chats.json'), 'utf8')
      let raw: unknown
      try { raw = JSON.parse(contents) } catch { this.storageError = storageWarning }
      if (!this.storageError) {
        const parsed = savedSchema.safeParse(raw)
        if (parsed.success) this.saved = parsed.data
        else {
          this.saved = recoverSaved(raw)
          this.storageError = `${storageWarning} Recovered ${this.saved.chats.length} readable chats in memory; other content remains in the original file.`
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.storageError = storageWarning
    }
    // Remove only this cache's abandoned atomic copies; never native histories.
    if (!this.storageError) for (const name of await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return [] })) {
      if (/^chats\.json\.tmp-\d+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name)) await unlink(join(this.directory, name))
    }
    if (!this.saved.chats.some(c => c.id === this.saved.selectedChatId)) this.saved.selectedChatId = null
    for (const chat of this.saved.chats) {
      chat.requests = []; chat.status = 'idle'
      if (chat.nativeState === 'starting') chat.nativeState = 'uncertain'
      for (const decision of chat.decisions ?? []) if (decision.status === 'submitting') decision.status = 'uncertain'
      for (const submission of chat.submissions) if (submission.status === 'submitting') submission.status = 'uncertain'
      if (this.options.historyEnabled?.() === false) { chat.messages = []; chat.title = 'Personal chat'; delete chat.activities }
    }
    if (this.storageError) {
      if (this.options.historyEnabled?.() === false) this.storageError += ' Local history is off, but the unreadable original has not been redacted.'
      this.emit(); return
    }
    await this.mutate(() => undefined)
    this.unsubscribe = this.host.subscribe(snapshot => {
      const conversations = this.host.personalSnapshot()
      this.connected = snapshot.connected
      void this.accept(snapshot, conversations).catch(() => { this.error = 'Personal chat history could not be saved. Restore local storage access and refresh.'; this.emit() })
    })
  }
  configurationChanged(): void {
    const key = JSON.stringify(this.options.configuration())
    if (key !== this.configurationKey) { this.configurationKey = key; this.emit() }
  }
  get(): PersonalChatState {
    const provider = this.options.configuration().reasoning
    return structuredClone({ ...this.saved, connected: this.connected, connecting: this.connecting,
      ...(this.storageError || this.error ? { error: this.storageError || this.error } : {}),
      availability: { provider, supported: provider === 'codex', ...(provider === 'codex' ? {} : { reason: `Personal conversations with ${provider} are not available yet. Select Codex in coordinator settings for new chats.` }) } })
  }
  subscribe(listener: (state: PersonalChatState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { for (const listener of this.listeners) listener(this.get()) }
  private chat(id: string, saved = this.saved): PersonalChat {
    const chat = saved.chats.find(c => c.id === id)
    if (!chat) throw new Error('This personal conversation is unavailable.')
    return chat
  }
  /** Only local atomic commits share a lane. Network waits never hold draft saves. */
  private mutate(change: (saved: Saved) => void): Promise<void> {
    if (this.storageError) return Promise.reject(new Error(this.storageError))
    const work = this.writing.catch(() => undefined).then(async () => {
      if (this.storageError) throw new Error(this.storageError)
      const next = structuredClone(this.saved); change(next)
      // Validate the same JSON representation consumed on restart and by IPC.
      // A TypeScript host snapshot is not runtime validation of native content.
      const validated = savedSchema.parse(JSON.parse(JSON.stringify(next)))
      const disk = structuredClone(validated)
      if (this.options.historyEnabled?.() === false) for (const chat of disk.chats) {
        chat.messages = []; chat.requests = []; chat.title = 'Personal chat'; delete chat.activities
        for (const submission of chat.submissions) { submission.text = ''; submission.skills = [] }
        // Delivery identity is durable even without history: answer() commits
        // this reservation before writing to the native pipe. Allowlist only
        // recovery metadata so request/structured-answer content (including
        // diagnostics that may echo it) cannot return on a later native event.
        chat.decisions = chat.decisions?.map(({ id, requestId, questionsDigest, status, createdAt, error }) => ({
          id, requestId, status, createdAt, answer: '',
          ...(questionsDigest !== undefined ? { questionsDigest } : {}),
          ...(error !== undefined ? { error: 'Answer could not be confirmed. Local history is off.' } : {}),
        }))
      }
      await this.store.write(savedSchema.parse(disk))
      this.saved = validated; this.emit()
    })
    this.writing = work; return work
  }
  async privacyChanged(): Promise<void> { await this.mutate(() => undefined) }
  private accept(snapshot: AgentHostSnapshot, conversations: CodexPersonalConversation[]): Promise<void> {
    return this.mutate(saved => {
      for (const native of conversations) {
        const chat = saved.chats.find(c => c.id === native.id)
        if (!chat) continue // Never adopt arbitrary native/project conversations.
        const invalid: string[] = []
        chat.nativeState = 'ready'
        const status = personalChatSchema.shape.status.safeParse(native.status)
        chat.status = snapshot.connected && status.success ? status.data : 'idle'
        if (!status.success) invalid.push('status')
        const requests = personalChatSchema.shape.requests.safeParse(native.requests)
        chat.requests = snapshot.connected && requests.success ? requests.data : []
        if (!requests.success) invalid.push('requests')
        if (!requests.success || !status.success) this.unreadableNativeState.add(chat.id)
        else this.unreadableNativeState.delete(chat.id)
        const messages = personalChatSchema.shape.messages.safeParse(native.messages)
        if (!messages.success) invalid.push('messages')
        if (native.historyStatus !== 'loading' && !(native.historyStatus === 'error' && messages.success && !messages.data.length)) {
          const activities = personalChatSchema.shape.activities.safeParse(native.activities)
          if (messages.success) chat.messages = messages.data
          if (activities.success) chat.activities = activities.data
          else invalid.push('activities')
        }
        const historyStatus = personalChatSchema.shape.historyStatus.safeParse(native.historyStatus)
        const historyError = personalChatSchema.shape.historyError.safeParse(native.historyError)
        if (!historyStatus.success || !historyError.success) invalid.push('history metadata')
        chat.historyStatus = invalid.length ? 'error' : historyStatus.success ? historyStatus.data : undefined
        chat.historyError = invalid.length ? `Native ${invalid.join(', ')} could not be read safely. Last valid cached history is retained and may be incomplete. Refresh to retry; no answer was truncated or invented.` : historyError.success ? historyError.data : undefined
        for (const submission of chat.submissions) if (chat.messages.some(m => m.id === submission.messageId && m.commandId === submission.id)) {
          submission.status = 'accepted'; delete submission.error
          if (chat.draft.revision === submission.revision) chat.draft = { revision: chat.draft.revision, text: '', skills: [] }
        }
      }
    })
  }
  async connect(): Promise<PersonalChatState> {
    if (this.storageError) return this.get()
    if (this.connecting || this.connected) return this.get()
    const generation = this.generation
    this.connecting = true; this.error = undefined; this.emit()
    try {
      await mkdir(this.cwd, { recursive: true })
      if (generation !== this.generation) return this.get()
      const snapshot = await this.host.connect()
      if (generation === this.generation) { this.connected = snapshot.connected; await this.accept(snapshot, this.host.personalSnapshot()) }
    } catch (error) { if (generation === this.generation) { this.connected = false; this.error = error instanceof Error ? error.message : 'Codex could not connect.' } }
    finally { if (generation === this.generation) { this.connecting = false; this.emit() } }
    return this.get()
  }
  async disconnect(): Promise<PersonalChatState> {
    this.generation++; this.connecting = false; this.connected = false; this.host.disconnect()
    if (this.storageError) return this.get()
    await this.mutate(saved => { for (const chat of saved.chats) {
      chat.requests = []; chat.status = 'idle'
      if (chat.nativeState === 'starting') chat.nativeState = 'uncertain'
      for (const decision of chat.decisions ?? []) if (decision.status === 'submitting') decision.status = 'uncertain'
      for (const submission of chat.submissions) if (submission.status === 'submitting') submission.status = 'uncertain'
    } })
    return this.get()
  }
  async create(): Promise<PersonalChatState> {
    const config = { ...this.options.configuration() }
    if (config.reasoning !== 'codex') throw new Error(this.get().availability.reason)
    if (!config.reasoningModel.trim()) throw new Error('Choose a Codex coordinator model before starting a chat.')
    const at = new Date().toISOString(), id = randomUUID()
    await this.mutate(saved => { saved.chats.unshift({ id, kind: 'personal', providerId: 'codex', title: 'New chat', modelId: config.reasoningModel,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}), createdAt: at, updatedAt: at, nativeState: 'unstarted', status: 'idle',
      messages: [], requests: [], draft: { revision: 0, text: '', skills: [] }, submissions: [] }); saved.selectedChatId = id })
    return this.get()
  }
  async select(id: string | null): Promise<PersonalChatState> {
    if (this.storageError) {
      if (id !== null) this.chat(id)
      this.saved.selectedChatId = id; this.emit(); return this.get()
    }
    await this.mutate(saved => { if (id !== null) this.chat(id, saved); saved.selectedChatId = id }); return this.get()
  }
  async saveDraft(input: z.infer<typeof personalDraftInputSchema>): Promise<PersonalChatState> {
    const draft = personalDraftInputSchema.parse(input)
    await this.mutate(saved => {
      const chat = this.chat(draft.chatId, saved)
      if (draft.revision < chat.draft.revision) return
      const next = { revision: draft.revision, text: draft.text, skills: draft.skills }
      if (draft.revision === chat.draft.revision) {
        if (JSON.stringify(next) !== JSON.stringify(chat.draft)) throw new Error('This draft revision has already been saved. Use a newer revision.')
        return
      }
      chat.draft = next
    }); return this.get()
  }
  async send(input: z.infer<typeof personalSendInputSchema>): Promise<PersonalChatState> {
    const { chatId, revision } = personalSendInputSchema.parse(input)
    let submissionId: string | undefined
    await this.mutate(saved => {
      const chat = this.chat(chatId, saved)
      if (chat.submissions.some(s => s.revision === revision)) return
      if (!this.connected) throw new Error('Connect Codex before sending this personal chat.')
      if (this.unreadableNativeState.has(chatId)) throw new Error('Native requests or status could not be read safely. Refresh before sending.')
      if (this.busy.has(chatId) || chat.status === 'running' || chat.requests.length) throw new Error('Wait for this chat and answer its pending requests before sending.')
      if (chat.nativeState === 'uncertain' || chat.submissions.some(s => s.status === 'submitting' || s.status === 'uncertain')) throw new Error('Delivery is uncertain. Refresh and review the existing conversation; it will not be replayed.')
      if (chat.draft.revision !== revision || !chat.draft.text.trim()) throw new Error('Save a nonempty current draft before sending.')
      submissionId = randomUUID()
      chat.submissions.push({ ...chat.draft, id: submissionId, messageId: randomUUID(), status: 'submitting', createdAt: new Date().toISOString() })
      chat.updatedAt = new Date().toISOString()
      if (chat.title === 'New chat') chat.title = chat.draft.text.trim().slice(0, 80)
      if (chat.nativeState === 'unstarted' || chat.nativeState === 'error') chat.nativeState = 'starting'
    })
    if (submissionId) {
      this.busy.add(chatId)
      const job = this.dispatch(chatId, submissionId).catch(() => { this.error = 'Personal chat delivery or local persistence is uncertain. Restore access and refresh before continuing.'; this.emit() }).finally(() => { this.busy.delete(chatId); this.jobs.delete(job) })
      this.jobs.add(job)
    }
    return this.get()
  }
  private async dispatch(chatId: string, submissionId: string): Promise<void> {
    const chat = structuredClone(this.chat(chatId)), submission = chat.submissions.find(s => s.id === submissionId)!
    const generation = this.generation
    let accepted = false, uncertain = false, error: string | undefined
    try {
      const memories = this.options.preferences?.retrieve({ query: submission.text }) ?? []
      if (chat.nativeState === 'starting') {
        const result = await this.host.createPersonalConversation({ commandId: submissionId, threadId: chatId, title: 'Personal chat', modelId: chat.modelId,
          ...(chat.reasoningEffort ? { reasoningEffort: chat.reasoningEffort } : {}), workingDirectory: this.cwd }, memories)
        if (!result.accepted) { uncertain = result.uncertain === true; throw new Error('Native conversation creation is uncertain. Refresh without creating a replacement.') }
        await this.mutate(saved => { this.chat(chatId, saved).nativeState = 'ready' })
      }
      if (generation !== this.generation || !this.connected) { uncertain = true; throw new Error('Codex disconnected before submission completed. Refresh to verify history.') }
      const result = await this.host.sendPersonalConversation({ type: 'send', commandId: submission.id, threadId: chatId, messageId: submission.messageId,
        text: submission.text, skills: submission.skills }, memories)
      accepted = result.accepted; uncertain = result.uncertain === true
    } catch (caught) { error = caught instanceof Error ? caught.message : 'Personal chat submission failed.' }
    await this.mutate(saved => {
      const current = this.chat(chatId, saved), sent = current.submissions.find(s => s.id === submissionId)!
      // Streamed native identity is stronger evidence than a lost acknowledgement.
      if (sent.status !== 'accepted') sent.status = accepted ? 'accepted' : uncertain ? 'uncertain' : 'failed'
      if (error && sent.status !== 'accepted') sent.error = error
      if (current.nativeState === 'starting') current.nativeState = uncertain ? 'uncertain' : 'error'
      if (sent.status === 'accepted' && current.draft.revision === sent.revision) current.draft = { revision: sent.revision, text: '', skills: [] }
    })
  }
  async skills(chatId: string, forceReload = false) {
    this.chat(chatId)
    if (!this.connected) throw new Error('Connect Codex before browsing skills.')
    return this.host.listThreadSkills(chatId, forceReload, { providerId: 'codex', workingDirectory: this.cwd })
  }
  async refresh(chatId: string): Promise<PersonalChatState> {
    const chat = this.chat(chatId)
    if (!this.connected) throw new Error('Connect Codex before refreshing this conversation.')
    if (chat.nativeState !== 'unstarted' && chat.nativeState !== 'error') {
      const snapshot = await this.host.refreshThread(chatId); await this.accept(snapshot, this.host.personalSnapshot())
    }
    return this.get()
  }
  async interrupt(chatId: string): Promise<PersonalChatState> {
    this.chat(chatId)
    if (!this.connected) throw new Error('Connect Codex before interrupting.')
    await this.host.execute({ type: 'interrupt', commandId: randomUUID(), threadId: chatId })
    await this.writing; return this.get()
  }
  async answer(input: z.infer<typeof personalAnswerInputSchema>): Promise<PersonalChatState> {
    const { chatId, ...answer } = personalAnswerInputSchema.parse(input)
    const decisionId = randomUUID()
    await this.mutate(saved => {
      const chat = this.chat(chatId, saved)
      const request = chat.requests.find(r => r.id === answer.requestId)
      if (!this.connected || !request) throw new Error('This request is no longer pending in this conversation.')
      if (chat.decisions?.some(d => d.requestId === answer.requestId && (d.status === 'submitting' || d.status === 'uncertain'))) throw new Error('Answer delivery is uncertain. Refresh without replaying the answer.')
      const decisions = chat.decisions ??= []
      decisions.push({ ...answer, request, ...(request.questions?.length ? { questionsDigest: requestQuestionsDigest(request.questions) } : {}), id: decisionId, status: 'submitting', createdAt: new Date().toISOString() })
    })
    let status: 'accepted' | 'uncertain' | 'failed' = 'uncertain'
    let failure: unknown
    try {
      const request = this.chat(chatId).decisions!.find(d => d.id === decisionId)!.request!
      if (request.questions?.length) await this.options.bindRequestDraftDecision?.({ kind: 'personal', ownerId: chatId, providerId: 'codex', requestId: request.id, questions: request.questions }, decisionId, answer.questionAnswers)
      const result = await this.host.execute({ ...definedFields(answer), type: 'answer', commandId: decisionId, threadId: chatId })
      status = result.accepted && !result.uncertain ? 'accepted' : 'uncertain'
      if (!result.accepted) this.error = 'Answer delivery is uncertain. Refresh the conversation; the answer will not be replayed.'
    } catch (error) { status = 'failed'; failure = error }
    await this.mutate(saved => {
      const decision = this.chat(chatId, saved).decisions!.find(d => d.id === decisionId)!
      decision.status = status
      if (failure) decision.error = failure instanceof Error ? failure.message : 'Answer could not be sent.'
    })
    if (failure) throw failure
    return this.get()
  }

  async command(command: PersonalChatCommand): Promise<PersonalChatState> {
    switch (command.type) {
      case 'create': return this.create()
      case 'select': return this.select(command.chatId)
      case 'connect': return this.connect()
      case 'disconnect': return this.disconnect()
      case 'draft': { const { type, ...draft } = command; void type; return this.saveDraft(draft) }
      case 'send': return this.send({ chatId: command.chatId, revision: command.revision })
      case 'refresh': return this.refresh(command.chatId)
      case 'interrupt': return this.interrupt(command.chatId)
      case 'answer': { const { type, ...answer } = command; void type; return this.answer(answer) }
    }
  }
  async settled(): Promise<void> { await Promise.all(this.jobs); await this.writing }
  async close(): Promise<void> { await this.disconnect(); await this.settled(); this.unsubscribe?.(); await this.host.closed() }
}
