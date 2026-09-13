import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { agentProjectSchema, type AgentHostSnapshot, type AgentThread, type AgentRequest, type AgentMessage } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentHost, AgentHostCommand, AgentHostResult } from './host'
import { validatePromptAttachments, validateThreadOptions } from './threadOptions'
import { findGrokExecutable, grokEnvironment, GROK_ACP_VERSION, GROK_CLI_VERSION, GrokRpc, GrokRejected, GrokUncertain, type GrokFrame } from './grokRpc'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const originSchema = z.object({ messageId: z.string(), commandId: z.string(), digest: z.string(), createdAt: z.string(), entryKey: z.string().optional() })
const aliasSchema = z.object({ grokSessionId: z.string().uuid().optional(), projectId: z.string(), cwd: z.string(), title: z.string(), modelId: z.string(), nativeModelId: z.string().optional(), settingsConfirmed: z.boolean().default(false), createdAt: z.string(), origins: z.array(originSchema), reasoningEffort: z.string().optional() })
type Alias = z.infer<typeof aliasSchema>
const catalogSchema = z.object({ currentModelId: z.string(), availableModels: z.array(z.object({ modelId: z.string(), name: z.string(), _meta: z.object({ reasoningEffort: z.string().optional(), supportsReasoningEffort: z.boolean().optional(), reasoningEfforts: z.array(z.object({ id: z.string(), value: z.string().optional() })).optional() }).optional() })).min(1) })
const questionSchema = z.object({ sessionId: z.string(), toolCallId: z.string(), questions: z.array(z.object({ question: z.string(), id: z.string().optional(), options: z.array(z.object({ label: z.string() })).default([]) })).min(1).max(30) })
const permissionSchema = z.object({ sessionId: z.string(), toolCall: z.object({ toolCallId: z.string(), title: z.string().optional(), rawInput: z.unknown().optional() }), options: z.array(z.object({ optionId: z.string(), name: z.string(), kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) })) })
type Pending = { wireId: string | number; threadId: string; toolCallId: string; request: AgentRequest; permission?: z.infer<typeof permissionSchema>; question?: z.infer<typeof questionSchema> }
const updateSchema = z.object({ sessionId: z.string(), _meta: z.object({ eventId: z.string().optional(), agentTimestampMs: z.number().optional() }).optional(), update: z.object({ sessionUpdate: z.string(), content: z.object({ type: z.string(), text: z.string().optional() }).optional(), stop_reason: z.string().optional(), stopReason: z.string().optional(), tool_call_id: z.string().optional() }).passthrough() })
const historySchema = z.object({ updates: z.array(z.object({ timestamp: z.union([z.number(), z.string()]), method: z.string(), params: z.unknown() })), totalCount: z.number().int().nonnegative(), hasMore: z.boolean() })
// Grok 1.0.5 restarts its event counter on CLI resume. eventId alone is not a message identity.
function eventKey(params: z.infer<typeof updateSchema>, fallback: string | number): string {
  return `grok-event-${digest(JSON.stringify([params._meta?.eventId, params._meta?.agentTimestampMs ?? fallback, params.update]))}`
}
function messageOrigin(alias: Alias, key: string, text: string, timestampMs: number) {
  const hash = digest(text)
  return alias.origins.find(origin => origin.entryKey === key && origin.digest === hash)
    ?? alias.origins.find((origin, index) => !origin.entryKey && origin.digest === hash && Date.parse(origin.createdAt) <= timestampMs
      && (!alias.origins[index + 1] || timestampMs < Date.parse(alias.origins[index + 1]!.createdAt)))
}
function completedStatus(stopReason: string | undefined): AgentThread['status'] {
  return ['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'].includes(stopReason ?? '') ? 'idle' : 'error'
}

export interface GrokAcpOptions { executable?: string; args?: string[]; environment?: NodeJS.ProcessEnv; requestTimeoutMs?: number; pollIntervalMs?: number }

/** Grok owns credentials, tools and durable sessions. Only alias/origin metadata belongs to Sotto. */
export class GrokAcpHost implements AgentHost {
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private aliases: Record<string, Alias> = {}
  private readonly threads = new Map<string, AgentThread>()
  private readonly pending = new Map<string, Pending>()
  private readonly deliveries = new Map<string, { resolve(): void; reject(error: Error): void }>()
  private readonly activePrompts = new Set<string>()
  private readonly streams = new Map<string, { threadId: string; message: AgentMessage }>()
  private readonly authored = new Map<string, { threadId: string; message: AgentMessage }>()
  private readonly liveStatus = new Map<string, { eventKey: string; status: AgentThread['status'] }>()
  private readonly selections = new Map<string, { model: string; effort: string | undefined }>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private rpc: GrokRpc | undefined
  private stopping = Promise.resolve()
  private writing = Promise.resolve()
  private polling: Promise<void> | undefined
  private readonly historyReads = new Map<string, Promise<void>>()
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private generation = 0
  private state: AgentHostSnapshot = { connected: false, name: 'Grok', version: '', projects: [], models: [], threads: [], capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: false } }
  constructor(private readonly userDataDirectory: string, private readonly options: GrokAcpOptions = {}) {
    this.aliasStore = new AtomicJsonStore(join(userDataDirectory, 'grok-threads.json'), z.record(z.string(), aliasSchema).parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(userDataDirectory, 'grok-projects.json'), z.array(agentProjectSchema).parse, () => [])
  }
  private current(): AgentHostSnapshot { return structuredClone({ ...this.state, threads: [...this.threads.values()] }) }
  private emit(): void { for (const listener of this.listeners) listener(this.current()) }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private persist(): Promise<void> { this.writing = this.aliasStore.write(structuredClone(this.aliases)); return this.writing }
  private thread(id: string): AgentThread {
    const alias = this.aliases[id]; if (!alias) throw new Error('The Grok thread does not exist.')
    if (!this.threads.has(id)) this.threads.set(id, { id, projectId: alias.projectId, title: alias.title, modelId: alias.settingsConfirmed ? alias.modelId : alias.nativeModelId ?? '', runtimeMode: 'approval-required', ...(alias.reasoningEffort && alias.settingsConfirmed ? { reasoningEffort: alias.reasoningEffort } : {}), status: alias.grokSessionId && alias.settingsConfirmed ? 'idle' : 'error', messages: [], requests: [] })
    return this.threads.get(id)!
  }
  private id(nativeId: string): string | undefined { return Object.keys(this.aliases).find(id => this.aliases[id]!.grokSessionId === nativeId) }
  async connect(): Promise<AgentHostSnapshot> {
    this.disconnect(); await this.closed()
    const generation = this.generation
    await mkdir(this.userDataDirectory, { recursive: true })
    const executable = this.options.executable ?? await findGrokExecutable(this.options.environment)
    if (!executable || !isAbsolute(executable)) throw new Error('Install Grok CLI and sign in before connecting Grok.')
    this.aliases = await this.aliasStore.read(); this.state.projects = await this.projectStore.read(); this.threads.clear(); this.streams.clear(); this.authored.clear(); this.liveStatus.clear(); this.selections.clear(); this.activePrompts.clear()
    if (generation !== this.generation) throw new Error('Grok connection was cancelled.')
    const rpc = new GrokRpc(executable, this.options.args ?? ['--permission-mode', 'default', 'agent', '--leader', 'stdio'], this.userDataDirectory,
      grokEnvironment(this.options.environment), this.options.requestTimeoutMs ?? 15000, frame => this.frame(frame), () => {
        if (this.rpc === rpc) { this.state.connected = false; clearInterval(this.pollTimer); for (const delivery of this.deliveries.values()) delivery.reject(new GrokUncertain('Grok disconnected.')); this.deliveries.clear(); this.pending.clear(); for (const thread of this.threads.values()) thread.requests = []; this.emit() }
      })
    this.rpc = rpc; this.stopping = rpc.closed
    try {
      await rpc.request('initialize', { protocolVersion: GROK_ACP_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'sotto', version: '1' } }, value => {
        const response = z.object({ protocolVersion: z.literal(GROK_ACP_VERSION), agentCapabilities: z.object({ loadSession: z.literal(true) }), authMethods: z.array(z.object({ id: z.string() })), _meta: z.object({ agentVersion: z.literal(GROK_CLI_VERSION), modelState: catalogSchema }) }).parse(value)
        if (!response.authMethods.some(auth => auth.id === 'cached_token') || response.authMethods.some(auth => /api.?key/iu.test(auth.id))) throw new Error('Subscription authentication required.')
        this.state.version = `${GROK_CLI_VERSION} / ACP ${GROK_ACP_VERSION}`
        this.state.models = response._meta.modelState.availableModels.map(model => ({ id: model.modelId, name: model.name, provider: 'Grok', ready: true, runtimeModes: ['approval-required'], supportsImages: false,
          reasoningEfforts: model._meta?.supportsReasoningEffort ? model._meta.reasoningEfforts?.map(effort => effort.value ?? effort.id) ?? [] : [], ...(model._meta?.reasoningEffort ? { defaultReasoningEffort: model._meta.reasoningEffort } : {}) }))
      })
      await rpc.request('authenticate', { methodId: 'cached_token', _meta: { headless: true } }, value => { z.object({}).parse(value) })
      for (const [id, alias] of Object.entries(this.aliases)) {
        this.thread(id)
        if (!alias.grokSessionId) continue
        await rpc.request('session/load', { sessionId: alias.grokSessionId, cwd: alias.cwd, mcpServers: [], _meta: { yoloMode: false, autoMode: false } }, async value => {
          const response = z.object({ models: catalogSchema, _meta: z.object({ sessionId: z.literal(alias.grokSessionId!) }) }).parse(value)
          alias.nativeModelId = response.models.currentModelId
          alias.settingsConfirmed = alias.nativeModelId === alias.modelId && (!alias.reasoningEffort || response.models.availableModels.find(model => model.modelId === alias.modelId)?._meta?.reasoningEffort === alias.reasoningEffort)
          this.thread(id).modelId = alias.nativeModelId; await this.persist()
        })
      }
      if (generation !== this.generation) throw new Error('Grok connection was cancelled.')
      this.state.connected = true; delete this.state.error
      await this.pollHistory()
      this.pollTimer = setInterval(() => { void this.pollHistory().catch(() => { this.state.error = 'Grok history could not be checked. Reconnect before sending automatic replies.'; this.emit() }) }, this.options.pollIntervalMs ?? 1500); this.pollTimer.unref()
      this.emit(); return this.current()
    } catch (error) { this.disconnect(); throw new Error(`Could not connect Grok. Sotto requires Grok CLI ${GROK_CLI_VERSION}, ACP ${GROK_ACP_VERSION}, and native subscription sign-in. ${error instanceof GrokUncertain ? error.message : ''}`.trim(), { cause: error }) }
  }
  observeThreads(_ids: readonly string[]): void { void _ids /* Known aliases are loaded at connect. Foreign sessions are never discovered. */ }
  async snapshot(): Promise<AgentHostSnapshot> { if (this.state.connected) await this.pollHistory(); return this.current() }
  async refreshThread(id: string): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]?.grokSessionId) throw new Error('This Grok thread has no confirmed provider session.')
    const generation = this.generation
    const work = (this.historyReads.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => {
      if (generation !== this.generation || !this.state.connected) throw new Error('Grok connection changed while reading the thread.')
      return this.readHistory(id)
    })
    this.historyReads.set(id, work)
    try { await work; return this.current() }
    finally { if (this.historyReads.get(id) === work) this.historyReads.delete(id) }
  }
  /** Native history query includes CLI-authored input and filters rewound branches. */
  pollHistory(): Promise<void> {
    if (this.polling) return this.polling
    this.polling = this.readHistories().finally(() => { this.polling = undefined })
    return this.polling
  }
  private async readHistories(): Promise<void> {
    if (!this.state.connected || !this.rpc) return
    for (const [id, alias] of Object.entries(this.aliases)) if (alias.grokSessionId) await this.refreshThread(id)
  }
  private async readHistory(id: string): Promise<void> {
    const generation = this.generation; const rpc = this.rpc!; const alias = this.aliases[id]!
    const messages: AgentMessage[] = []; let status: AgentThread['status'] = 'idle'; let offset = 0; let more = true; let changed = false
    const persistedStatusEvents = new Set<string>()
    let assistant: AgentMessage | undefined
    while (more) {
      await rpc.request('_x.ai/session/updates', { sessionId: alias.grokSessionId, cwd: alias.cwd, offset, limit: 100 }, value => {
        if (generation !== this.generation || rpc !== this.rpc) { more = false; return }
        const page = historySchema.parse(value)
        if (page.hasMore && !page.updates.length) throw new Error('Invalid Grok history page.')
        more = page.hasMore
        for (const entry of page.updates) {
          const ordinal = offset++
          const parsed = updateSchema.safeParse(entry.params); if (!parsed.success || parsed.data.sessionId !== alias.grokSessionId) continue
          const key = eventKey(parsed.data, `${entry.timestamp}-${ordinal}`)
          const createdAt = new Date(parsed.data._meta?.agentTimestampMs ?? (typeof entry.timestamp === 'number' ? entry.timestamp * 1000 : entry.timestamp)).toISOString()
          const update = parsed.data.update
          if (entry.method === 'session/update' && update.content?.type === 'text' && typeof update.content.text === 'string') {
            if (update.sessionUpdate === 'user_message_chunk') {
              persistedStatusEvents.add(eventKey(parsed.data, 0))
              assistant = undefined; status = 'running'
              const text = update.content.text
              const origin = messageOrigin(alias, key, text, Date.parse(createdAt))
              if (origin && !origin.entryKey) { origin.entryKey = key; changed = true }
              messages.push({ id: origin?.messageId ?? key, role: 'user', text, createdAt: origin?.createdAt ?? createdAt, ...(origin ? { commandId: origin.commandId } : {}) })
              if (origin) this.deliveries.get(origin.messageId)?.resolve()
            } else if (update.sessionUpdate === 'agent_message_chunk') {
              if (!assistant) { assistant = { id: key, role: 'assistant', text: '', createdAt }; messages.push(assistant) }
              assistant.text += update.content.text
            }
          }
          if (update.sessionUpdate === 'turn_completed') { persistedStatusEvents.add(eventKey(parsed.data, 0)); status = completedStatus(update.stop_reason ?? update.stopReason); assistant = undefined }
        }
      })
    }
    if (generation !== this.generation || rpc !== this.rpc || !this.state.connected) throw new Error('Grok connection changed while reading the thread.')
    if (changed) await this.persist()
    if (generation !== this.generation || rpc !== this.rpc || !this.state.connected) throw new Error('Grok connection changed while reading the thread.')
    const thread = this.thread(id)
    // A live native turn may belong to the CLI, not activePrompts. Older durable
    // status cannot supersede it until its event has entered the persisted timeline.
    const liveStatus = this.liveStatus.get(id)
    if (liveStatus) {
      if (persistedStatusEvents.has(liveStatus.eventKey)) this.liveStatus.delete(id)
      else status = liveStatus.status
    }
    // Native writes may lag behind live notifications. Keep their tail until the durable rail catches up.
    for (const live of [...[...this.authored.values()].filter(entry => entry.threadId === id).map(entry => entry.message), ...[...this.streams.values()].filter(stream => stream.threadId === id).map(stream => stream.message)]) {
      if (live.role === 'user') {
        if (!messages.some(message => message.id === live.id)) messages.push(live)
        else this.authored.delete(live.id)
      }
      if (live.role === 'assistant' && live.id.startsWith('grok-stream-')) {
        const userId = live.id.slice('grok-stream-'.length)
        const userIndex = messages.findIndex(message => message.id === userId)
        if (userIndex < 0) continue
        const nextUserIndex = messages.findIndex((message, index) => index > userIndex && message.role === 'user')
        const tail = messages.slice(userIndex + 1, nextUserIndex < 0 ? undefined : nextUserIndex).filter(message => message.role === 'assistant')
        if (!tail.some(message => message.text.includes(live.text))) {
          const partial = tail.at(-1)
          if (partial && live.text.startsWith(partial.text)) partial.text = live.text
          else messages.splice(nextUserIndex < 0 ? messages.length : nextUserIndex, 0, live)
        } else if (status === 'idle' && !this.activePrompts.has(id)) this.streams.delete(live.id)
      }
    }
    thread.messages = messages; thread.status = !alias.settingsConfirmed ? 'error' : this.activePrompts.has(id) ? 'running' : status
    this.emit()
  }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (!this.state.connected || !this.rpc) throw new Error('Connect Grok before managing threads.')
    const rpc = this.rpc
    try {
      if (command.type === 'create-project') {
        if (!isAbsolute(command.path)) throw new Error('Grok projects require an absolute working directory.')
        if (!this.state.projects.some(project => project.id === command.projectId)) { this.state.projects.push({ id: command.projectId, title: command.title, path: command.path }); await this.projectStore.write(this.state.projects) }
      } else if (command.type === 'create-thread') {
        if (this.aliases[command.threadId]) return this.aliases[command.threadId]!.settingsConfirmed ? { accepted: true } : { accepted: false, uncertain: true }
        validateThreadOptions(this.state, command)
        const project = this.state.projects.find(project => project.id === command.projectId); if (!project) throw new Error('Choose a Grok project first.')
        const alias: Alias = { projectId: project.id, cwd: project.path, title: command.title, modelId: command.modelId, settingsConfirmed: false, createdAt: new Date().toISOString(), origins: [], ...(command.reasoningEffort ? { reasoningEffort: command.reasoningEffort } : {}) }
        this.aliases[command.threadId] = alias; await this.persist()
        await rpc.request('session/new', { cwd: project.path, mcpServers: [], _meta: { yoloMode: false, autoMode: false } }, async value => {
          const response = z.object({ sessionId: z.string().uuid(), models: catalogSchema }).parse(value)
          alias.grokSessionId = response.sessionId; alias.nativeModelId = response.models.currentModelId; await this.persist(); this.thread(command.threadId).status = 'error'; this.emit()
        })
        await rpc.request('session/set_model', { sessionId: alias.grokSessionId, modelId: alias.modelId, ...(alias.reasoningEffort ? { _meta: { reasoningEffort: alias.reasoningEffort } } : {}) }, async value => {
          z.object({ _meta: z.object({ model: z.object({ Ok: z.literal(alias.modelId) }) }) }).parse(value)
          if (alias.reasoningEffort && this.selections.get(alias.grokSessionId!)?.effort !== alias.reasoningEffort) throw new Error('Grok did not confirm the requested reasoning effort.')
          alias.settingsConfirmed = true; alias.nativeModelId = alias.modelId; await this.persist()
          const thread = this.thread(command.threadId); thread.modelId = alias.modelId; thread.status = 'idle'; if (alias.reasoningEffort) thread.reasoningEffort = alias.reasoningEffort
        })
      } else {
        const alias = this.aliases[command.threadId]; if (!alias?.grokSessionId) throw new Error('This Grok thread has no confirmed provider session. Do not repeat its creation automatically.')
        if (command.type === 'configure-thread') throw new Error('Grok thread settings cannot be changed in Sotto yet.')
        if (command.type === 'send') {
          if (!alias.settingsConfirmed) throw new Error('Grok has not confirmed this thread’s model settings. Reconnect to check before sending.')
          validatePromptAttachments(this.state, alias.modelId, command.attachments)
          try { await this.refreshThread(command.threadId) }
          catch (error) { throw error instanceof GrokUncertain ? new Error('Grok history could not be verified before sending the prompt.', { cause: error }) : error }
          const thread = this.thread(command.threadId)
          if (command.expectedLastUserMessageId !== undefined && (thread.messages.filter(message => message.role === 'user').at(-1)?.id ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
          const previous = alias.origins.find(origin => origin.messageId === command.messageId || origin.commandId === command.commandId)
          if (previous) return previous.entryKey ? { accepted: true } : { accepted: false, uncertain: true }
          if (this.activePrompts.has(command.threadId) || thread.status === 'running') throw new Error('Grok is already running a prompt in this thread.')
          if (thread.requests.length) throw new Error('Answer the pending Grok request before sending another prompt.')
          const origin = { messageId: command.messageId, commandId: command.commandId, digest: digest(command.text), createdAt: new Date().toISOString() }
          alias.origins.push(origin)
          this.activePrompts.add(command.threadId)
          const generation = this.generation
          try {
            await this.persist()
            // Saving the origin is an async boundary at which native CLI input can revoke authority.
            await this.refreshThread(command.threadId)
            if (command.expectedLastUserMessageId !== undefined && (thread.messages.filter(message => message.role === 'user').at(-1)?.id ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
            if (thread.requests.length) throw new Error('Answer the pending Grok request before sending another prompt.')
            if (generation !== this.generation || !this.state.connected || !this.activePrompts.has(command.threadId)) throw new Error('The Grok prompt was cancelled before dispatch.')
          } catch (error) {
            // No prompt was written. Rolling back this reserved origin cannot duplicate native work.
            alias.origins = alias.origins.filter(item => item !== origin); this.activePrompts.delete(command.threadId); await this.persist()
            throw error instanceof GrokUncertain ? new Error('Grok history could not be verified before sending the prompt.', { cause: error }) : error
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          const delivery = new Promise<void>((resolve, reject) => { this.deliveries.set(command.messageId, { resolve, reject }); timer = setTimeout(() => reject(new GrokUncertain('Grok prompt delivery is uncertain.')), this.options.requestTimeoutMs ?? 15000) })
          // ACP prompt responds at turn completion. Its authored-message echo acknowledges delivery.
          void rpc.request('session/prompt', { sessionId: alias.grokSessionId, prompt: [{ type: 'text', text: command.text }] }, value => {
            z.object({ stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']) }).parse(value)
            this.activePrompts.delete(command.threadId); this.thread(command.threadId).status = 'idle'; this.deliveries.get(command.messageId)?.resolve(); this.emit()
          }, true).catch(async error => {
            if (error instanceof GrokRejected) { alias.origins = alias.origins.filter(item => item !== origin); await this.persist() }
            this.activePrompts.delete(command.threadId); this.deliveries.get(command.messageId)?.reject(error); this.thread(command.threadId).status = 'error'; this.emit()
          }).catch(() => this.disconnect())
          try { await delivery } finally { clearTimeout(timer); this.deliveries.delete(command.messageId) }
          await this.refreshThread(command.threadId)
        } else if (command.type === 'answer') {
          const pending = this.pending.get(command.requestId)
          if (!pending || pending.threadId !== command.threadId) throw new Error('That Grok request is no longer pending.')
          let result: unknown
          if (pending.permission) {
            const selected = pending.permission.options.find(option => option.kind === (command.approved === true ? 'allow_once' : 'reject_once'))
            if (command.approved === true && !selected) throw new Error('Grok did not offer a one-time permission. Answer in Grok.')
            result = selected ? { outcome: { outcome: 'selected', optionId: selected.optionId } } : { outcome: { outcome: 'cancelled' } }
          } else {
            const questions = pending.question!.questions
            let answers: Record<string, string>
            if (questions.length === 1) answers = { [questions[0]!.question]: command.answer }
            else {
              try { answers = z.record(z.string(), z.string()).parse(JSON.parse(command.answer)) } catch { throw new Error('Answer multiple Grok questions with a JSON object keyed by each question text.') }
              if (questions.some(question => !answers[question.question])) throw new Error('Answer every Grok question.')
            }
            result = { outcome: 'accepted', answers: Object.fromEntries(questions.map(question => [question.question, question.options.some(option => option.label === answers[question.question]) ? [answers[question.question]] : ['Other']])), annotations: Object.fromEntries(questions.filter(question => !question.options.some(option => option.label === answers[question.question])).map(question => [question.question, { notes: answers[question.question] }])) }
          }
          this.removeRequest(pending); await rpc.reply(pending.wireId, result)
        } else if (command.type === 'interrupt') {
          this.activePrompts.delete(command.threadId)
          await this.decline(command.threadId)
          rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: alias.grokSessionId } })
        }
      }
      this.emit(); return { accepted: true }
    } catch (error) { if (error instanceof GrokUncertain) return { accepted: false, uncertain: true }; throw error }
  }
  private async frame(frame: GrokFrame): Promise<void> {
    let method = frame.method; let params = frame.params
    if (method?.startsWith('_')) {
      method = method.slice(1)
      const wrapped = z.object({ method: z.string(), params: z.unknown() }).safeParse(params)
      if (wrapped.success) { method = wrapped.data.method; params = wrapped.data.params }
    }
    if (frame.id !== undefined && method) {
      let pending: Pending | undefined
      if (method === 'session/request_permission') {
        const permission = permissionSchema.parse(params); const id = this.id(permission.sessionId)
        const title = permission.toolCall.title ?? 'Grok requests permission to use a tool.'
        const details = permission.toolCall.rawInput === undefined ? '' : `\n${JSON.stringify(permission.toolCall.rawInput).slice(0, 20000)}`
        if (id) pending = { wireId: frame.id, threadId: id, toolCallId: permission.toolCall.toolCallId, permission, request: { id: `grok-request-${JSON.stringify(frame.id)}`, kind: 'permission', text: title + details, options: [] } }
      } else if (method === 'x.ai/ask_user_question') {
        const question = questionSchema.parse(params); const id = this.id(question.sessionId)
        if (id) pending = { wireId: frame.id, threadId: id, toolCallId: question.toolCallId, question, request: { id: `grok-request-${JSON.stringify(frame.id)}`, kind: 'question', text: question.questions.map(question => question.question).join('\n'), options: question.questions.length === 1 ? question.questions[0]!.options.map(option => ({ id: option.label, label: option.label })) : [] } }
      }
      if (pending) { this.pending.set(pending.request.id, pending); this.thread(pending.threadId).requests.push(pending.request); this.emit() }
      else this.rpc?.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Sotto does not handle this request.' } })
      return
    }
    if (['session/update', 'x.ai/session/update', 'x.ai/session_notification'].includes(method ?? '')) {
      const parsed = updateSchema.safeParse(params); if (!parsed.success) return
      const id = this.id(parsed.data.sessionId); if (!id) return
      const update = parsed.data.update; const thread = this.thread(id)
      if (update.sessionUpdate === 'model_changed' && typeof update.model_id === 'string') this.selections.set(parsed.data.sessionId, { model: update.model_id, effort: typeof update.reasoning_effort === 'string' ? update.reasoning_effort : undefined })
      if (update.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text' && update.content.text !== undefined) {
        const key = eventKey(parsed.data, Date.now())
        const origin = messageOrigin(this.aliases[id]!, key, update.content.text, parsed.data._meta?.agentTimestampMs ?? Date.now())
        const messageId = origin?.messageId ?? key
        if (messageId && !thread.messages.some(message => message.id === messageId)) {
          const message: AgentMessage = { id: messageId, role: 'user', text: update.content.text, createdAt: origin?.createdAt ?? new Date(parsed.data._meta?.agentTimestampMs ?? Date.now()).toISOString(), ...(origin ? { commandId: origin.commandId } : {}) }
          this.authored.set(messageId, { threadId: id, message }); thread.messages.push(message)
        }
        if (origin) this.deliveries.get(origin.messageId)?.resolve()
        this.liveStatus.set(id, { eventKey: eventKey(parsed.data, 0), status: 'running' })
        thread.status = 'running'
      }
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        const streamId = `grok-stream-${thread.messages.filter(message => message.role === 'user').at(-1)?.id ?? 'unknown'}`
        const previous = this.streams.get(streamId)?.message
        if (previous) previous.text += update.content.text ?? ''
        else {
          const message: AgentMessage = { id: streamId, role: 'assistant', text: update.content.text ?? '', createdAt: new Date().toISOString() }
          this.streams.set(streamId, { threadId: id, message }); thread.messages.push(message)
        }
      }
      if (update.sessionUpdate === 'turn_completed') {
        this.activePrompts.delete(id); thread.status = completedStatus(update.stop_reason ?? update.stopReason)
        this.liveStatus.set(id, { eventKey: eventKey(parsed.data, 0), status: thread.status })
      }
      if (update.sessionUpdate === 'interaction_resolved') for (const pending of this.pending.values()) if (pending.threadId === id && pending.toolCallId === update.tool_call_id) this.removeRequest(pending)
      this.emit()
    }
  }
  private removeRequest(pending: Pending): void { this.pending.delete(pending.request.id); this.thread(pending.threadId).requests = this.thread(pending.threadId).requests.filter(request => request.id !== pending.request.id); this.emit() }
  private refusal(pending: Pending): unknown { return pending.permission ? { outcome: { outcome: 'cancelled' } } : { outcome: 'cancelled' } }
  private async decline(id: string): Promise<void> { for (const pending of [...this.pending.values()]) if (pending.threadId === id) { this.removeRequest(pending); await this.rpc?.reply(pending.wireId, this.refusal(pending)) } }
  disconnect(): void {
    this.generation++; clearInterval(this.pollTimer)
    for (const pending of this.pending.values()) { try { this.rpc?.write({ jsonrpc: '2.0', id: pending.wireId, result: this.refusal(pending) }) } catch { /* Closed pipes never grant permission. */ } }
    this.pending.clear(); for (const thread of this.threads.values()) thread.requests = []
    for (const delivery of this.deliveries.values()) delivery.reject(new GrokUncertain('Grok disconnected before acknowledgement.'))
    this.deliveries.clear(); this.rpc?.close(); this.state.connected = false; this.emit()
  }
  async closed(): Promise<void> { await this.stopping; await this.polling?.catch(() => undefined); await Promise.allSettled(this.historyReads.values()); await this.writing }
}
