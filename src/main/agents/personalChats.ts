import { randomUUID } from 'node:crypto'
import { mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { personalChatSchema, personalDraftInputSchema, personalSendInputSchema, personalAnswerInputSchema, type PersonalChat, type PersonalChatState, type PersonalChatCommand } from '../../shared/personalChats'
import type { AgentHostSnapshot } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import { CodexAppServerHost, type CodexPersonalConversation } from './codex'
import type { MemoryProfile } from '../memory/profile'

const savedSchema = z.object({ selectedChatId: z.string().nullable(), chats: z.array(personalChatSchema) })
type Saved = z.infer<typeof savedSchema>
function definedFields<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> }
}
type PersonalConversationHost = Pick<CodexAppServerHost, 'closed' | 'connect' | 'createPersonalConversation' | 'disconnect' | 'execute' | 'listThreadSkills' | 'personalSnapshot' | 'refreshThread' | 'sendPersonalConversation' | 'subscribe'>
export interface PersonalChatOptions {
  userDataPath: string
  configuration: () => { reasoning: string; reasoningModel: string; reasoningEffort: string }
  host?: PersonalConversationHost
  preferences?: Pick<MemoryProfile, 'retrieve'>
  historyEnabled?: () => boolean
  nativeEnabled?: boolean
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
    // Remove only this cache's abandoned atomic copies; never native histories.
    for (const name of await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return [] })) {
      if (/^chats\.json\.(?:tmp|corrupt)-\d+-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name)) await unlink(join(this.directory, name))
    }
    // peek avoids making extra plaintext history backups on malformed input.
    this.saved = await this.store.peek()
    if (!this.saved.chats.some(c => c.id === this.saved.selectedChatId)) this.saved.selectedChatId = null
    for (const chat of this.saved.chats) {
      chat.requests = []; chat.status = 'idle'
      if (chat.nativeState === 'starting') chat.nativeState = 'uncertain'
      for (const decision of chat.decisions ?? []) if (decision.status === 'submitting') decision.status = 'uncertain'
      for (const submission of chat.submissions) if (submission.status === 'submitting') submission.status = 'uncertain'
      if (this.options.historyEnabled?.() === false) { chat.messages = []; chat.title = 'Personal chat'; delete chat.activities }
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
      ...(this.error ? { error: this.error } : {}),
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
    const work = this.writing.catch(() => undefined).then(async () => {
      const next = structuredClone(this.saved); change(next)
      const disk = structuredClone(next)
      if (this.options.historyEnabled?.() === false) for (const chat of disk.chats) {
        chat.messages = []; chat.requests = []; chat.title = 'Personal chat'; delete chat.activities
        for (const submission of chat.submissions) { submission.text = ''; submission.skills = [] }
        chat.decisions = []
      }
      await this.store.write(disk)
      this.saved = next; this.emit()
    })
    this.writing = work; return work
  }
  async privacyChanged(): Promise<void> { await this.mutate(() => undefined) }
  private accept(snapshot: AgentHostSnapshot, conversations: CodexPersonalConversation[]): Promise<void> {
    return this.mutate(saved => {
      for (const native of conversations) {
        const chat = saved.chats.find(c => c.id === native.id)
        if (!chat) continue // Never adopt arbitrary native/project conversations.
        chat.nativeState = 'ready'
        chat.status = snapshot.connected ? native.status : 'idle'
        chat.requests = snapshot.connected ? native.requests : []
        if (native.historyStatus !== 'loading' && !(native.historyStatus === 'error' && !native.messages.length)) {
          chat.messages = native.messages; chat.activities = native.activities
        }
        chat.historyStatus = native.historyStatus; chat.historyError = native.historyError
        for (const submission of chat.submissions) if (native.messages.some(m => m.id === submission.messageId && m.commandId === submission.id)) {
          submission.status = 'accepted'; delete submission.error
          if (chat.draft.revision === submission.revision) chat.draft = { revision: chat.draft.revision, text: '', skills: [] }
        }
      }
    })
  }
  async connect(): Promise<PersonalChatState> {
    if (this.options.nativeEnabled === false) { this.error = 'Native personal chats are unavailable in the fixture runtime.'; return this.get() }
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
      decisions.push({ ...answer, request, id: decisionId, status: 'submitting', createdAt: new Date().toISOString() })
    })
    let status: 'accepted' | 'uncertain' | 'failed' = 'uncertain'
    let failure: unknown
    try {
      const result = await this.host.execute({ ...definedFields(answer), type: 'answer', commandId: decisionId, threadId: chatId })
      status = result.accepted ? 'accepted' : 'uncertain'
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
