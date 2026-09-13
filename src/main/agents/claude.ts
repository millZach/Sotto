import { existingWorkingDirectory } from './threadWorktrees'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { agentAttachmentReferenceSchema, agentProjectSchema, attachmentSizeBytes, type AgentHostSnapshot, type AgentMessage, type AgentThread } from '../../shared/agents'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { AgentHost, AgentHostCommand, AgentHostResult } from './host'
import { ClaudeSubscriptionClient } from './subscriptionClaude'
import { ClaudeProtocol, object, type ClaudeFrame } from './claudeProtocol'
import { authoredClaudeUser, claudeDigest, ClaudeSessionLog, claudeText } from './claudeSessionLog'
import { claudeAnswer, claudeDenial, claudePending, type ClaudePending } from './claudeRequests'
import { validatePromptAttachments, validateThreadOptions } from './threadOptions'

const originSchema = z.object({ messageId: z.string(), commandId: z.string(), uuid: z.string().uuid(), digest: z.string(), createdAt: z.string(), attachments: z.array(agentAttachmentReferenceSchema).optional() })
const aliasSchema = z.object({ sessionId: z.string().uuid(), projectId: z.string(), cwd: z.string(), title: z.string(), modelId: z.string(), createdAt: z.string(),
  reasoningEffort: z.string().optional(), origins: z.array(originSchema).default([]) })
type Alias = z.infer<typeof aliasSchema>
export interface ClaudeStreamJsonHostOptions {
  userDataPath: string; executable?: string; args?: string[]; claudeHome?: string; environment?: NodeJS.ProcessEnv; requestTimeoutMs?: number; pollIntervalMs?: number
}
type Runtime = { protocol: ClaudeProtocol; requests: Map<string, ClaudePending> }

/** One native coding CLI per thread. Credentials and transcript persistence remain native. */
export class ClaudeStreamJsonHost implements AgentHost {
  private readonly aliasStore: AtomicJsonStore<Record<string, Alias>>
  private readonly projectStore: AtomicJsonStore<AgentHostSnapshot['projects']>
  private readonly client: ClaudeSubscriptionClient
  private aliases: Record<string, Alias> = {}
  private readonly threads = new Map<string, AgentThread>()
  private readonly runtimes = new Map<string, Runtime>()
  private readonly starting = new Map<string, Promise<Runtime>>()
  private readonly logs = new Map<string, ClaudeSessionLog>()
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly acknowledgements = new Map<string, () => void>()
  private readonly dispatching = new Set<string>()
  private readonly logOrigins = new Map<string, Set<string>>()
  private readonly lastLogDigest = new Map<string, string>()
  private readonly staleContexts = new Set<string>()
  private readonly completedOrigins = new Set<string>()
  private readonly assistantBlocks = new Map<string, Map<string, string>>()
  private readonly observed = new Set<string>()
  private executable = ''
  private generation = 0
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private closures: Promise<void>[] = []
  private state: AgentHostSnapshot = { connected: false, name: 'Claude Code', version: '', models: [], projects: [], threads: [],
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true } }
  constructor(private readonly options: ClaudeStreamJsonHostOptions) {
    this.aliasStore = new AtomicJsonStore(join(options.userDataPath, 'claude-threads.json'), z.record(z.string(), aliasSchema).parse, () => ({}))
    this.projectStore = new AtomicJsonStore(join(options.userDataPath, 'claude-projects.json'), z.array(agentProjectSchema).parse, () => [])
    this.client = new ClaudeSubscriptionClient(options.userDataPath, { ...(options.executable ? { executable: options.executable } : {}), ...(options.args ? { prefixArgs: options.args } : {}), ...(options.environment ? { environment: options.environment } : {}) })
  }
  async connect(): Promise<AgentHostSnapshot> {
    this.disconnect(); await this.closed()
    const generation = this.generation
    const [account, executable, aliases, projects] = await Promise.all([this.client.status(), this.client.findExecutable(), this.aliasStore.read(), this.projectStore.read()])
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    this.state.error = undefined; this.state.models = account.models.map(model => ({ ...model, provider: 'claude', ready: account.ready, runtimeModes: ['approval-required'], supportsImages: true }))
    if (!account.ready || !executable) { this.state.error = account.detail; this.emit(); return this.view() }
    this.executable = executable; this.aliases = aliases; this.state.projects = projects
    this.threads.clear(); this.logs.clear(); this.logOrigins.clear(); this.lastLogDigest.clear(); this.staleContexts.clear(); this.completedOrigins.clear(); this.assistantBlocks.clear()
    for (const [id, alias] of Object.entries(aliases)) {
      this.ensureThread(id, alias)
      await this.log(id).poll()
    }
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    this.state.connected = true
    for (const id of this.observed) {
      if (!aliases[id]) continue
      try { await this.start(id) } catch { this.threads.get(id)!.status = 'error'; this.state.error = 'A Claude thread could not resume. Check its native session before sending again.' }
      if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    }
    this.pollTimer = setInterval(() => { void this.pollSessionLogs().catch(() => { this.state.error = 'Claude history is unavailable. Check the native client before continuing.'; this.emit() }) }, this.options.pollIntervalMs ?? 1000)
    this.pollTimer.unref(); this.emit(); return this.view()
  }
  async snapshot(): Promise<AgentHostSnapshot> { await this.pollSessionLogs(); return this.view() }
  async refreshThread(id: string): Promise<AgentHostSnapshot> {
    if (!this.aliases[id]) throw new Error('That Claude thread is unavailable.')
    const generation = this.generation
    await this.log(id).poll()
    if (generation !== this.generation || !this.state.connected) throw new Error('Claude connection changed while reading the thread.')
    return this.view()
  }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  observeThreads(ids: readonly string[]): void {
    this.observed.clear(); for (const id of ids) this.observed.add(id)
    if (!this.state.connected) return
    for (const id of ids) if (this.aliases[id]) void this.start(id).catch(() => {
      const thread = this.threads.get(id); if (thread) thread.status = 'error'
      this.state.error = 'A Claude thread could not resume. Check the native client.'; this.emit()
    })
  }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (!this.state.connected) throw new Error('Connect Claude Code before continuing.')
    if (command.type === 'create-project') {
      if (!isAbsolute(command.path)) throw new Error('Choose an absolute project folder.')
      const projects = this.state.projects.filter(project => project.id !== command.projectId)
      projects.push({ id: command.projectId, title: command.title, path: command.path })
      await this.projectStore.write(projects); this.state.projects = projects; this.emit(); return { accepted: true }
    }
    if (command.type === 'create-thread') {
      if (this.aliases[command.threadId]) return { accepted: true }
      validateThreadOptions(this.state, command)
      const project = this.state.projects.find(candidate => candidate.id === command.projectId)
      if (!project) throw new Error('Choose an existing project.')
      const alias: Alias = { sessionId: randomUUID(), projectId: project.id, cwd: await existingWorkingDirectory(command.workingDirectory ?? project.path), title: command.title, modelId: command.modelId,
        reasoningEffort: command.reasoningEffort, createdAt: new Date().toISOString(), origins: [] }
      this.aliases[command.threadId] = alias
      try { await this.persist() } catch (error) { delete this.aliases[command.threadId]; throw error }
      this.ensureThread(command.threadId, alias); this.emit()
      // Creating a durable local identity does not require a paid model turn.
      try { await this.start(command.threadId) } catch { this.threads.get(command.threadId)!.status = 'error'; this.emit(); return { accepted: false, uncertain: true } }
      return { accepted: true }
    }
    const id = command.threadId; const alias = this.aliases[id]; const thread = this.threads.get(id)
    if (!alias || !thread) throw new Error('That Claude thread is unavailable.')
    if (command.type === 'configure-thread') {
      validateThreadOptions(this.state, command, alias.modelId)
      if (thread.status === 'running' || thread.requests.length) throw new Error('Wait for this Claude turn to finish before changing settings.')
      const runtime = this.runtimes.get(id)
      if (runtime) { this.runtimes.delete(id); runtime.protocol.stop(); await runtime.protocol.closed }
      alias.modelId = command.modelId ?? alias.modelId; alias.reasoningEffort = command.reasoningEffort ?? alias.reasoningEffort
      await this.persist(); thread.modelId = alias.modelId; thread.reasoningEffort = alias.reasoningEffort
      await this.start(id); this.emit(); return { accepted: true }
    }
    if (command.type === 'send') {
      validatePromptAttachments(this.state, alias.modelId, command.attachments)
      const checkLatestUserMessage = (): void => {
        if (command.expectedLastUserMessageId !== undefined && (thread.messages.filter(message => message.role === 'user').at(-1)?.id ?? null) !== command.expectedLastUserMessageId) throw new Error('The latest user message changed. Review the thread before replying.')
      }
      await this.refreshThread(id)
      checkLatestUserMessage()
      if (alias.origins.some(origin => origin.messageId === command.messageId)) return thread.messages.some(message => message.id === command.messageId) ? { accepted: true } : { accepted: false, uncertain: true }
      if (this.dispatching.has(id) || thread.status === 'running') throw new Error('Claude is already running a turn.')
      if (thread.requests.length) throw new Error('Answer the pending Claude request before sending another prompt.')
      this.dispatching.add(id)
      try {
        if (this.staleContexts.delete(id)) {
          const stale = this.runtimes.get(id)
          if (stale) { await this.denyPending(id, stale); this.runtimes.delete(id); stale.protocol.stop(); await stale.protocol.closed }
        }
        const runtime = await this.start(id)
        const origin = { messageId: command.messageId, commandId: command.commandId, uuid: randomUUID(), digest: claudeDigest(command.text), createdAt: new Date().toISOString(),
          ...(command.attachments?.length ? { attachments: command.attachments.map(attachment => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachmentSizeBytes(attachment.dataUrl) })) } : {}) }
        alias.origins.push(origin)
        try { await this.persist() } catch (error) { alias.origins = alias.origins.filter(candidate => candidate.uuid !== origin.uuid); throw error }
        const content: unknown = command.attachments?.length ? [
          { type: 'text', text: command.text }, ...command.attachments.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) } })),
        ] : command.text
        // Resume and durable origin writes can yield while the user takes over.
        // Recheck at the dispatch boundary; an undispatched origin is safe to remove.
        try {
          await this.refreshThread(id); checkLatestUserMessage()
          if (thread.requests.length || this.threads.get(id)?.status === 'running') throw new Error('The Claude thread started working or needs an answer before another prompt.')
        }
        catch (error) {
          alias.origins = alias.origins.filter(candidate => candidate.uuid !== origin.uuid)
          await this.persist(); throw error
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const acknowledged = new Promise<boolean>(resolve => {
          timer = setTimeout(() => { this.acknowledgements.delete(origin.uuid); resolve(false) }, this.options.requestTimeoutMs ?? 15000)
          this.acknowledgements.set(origin.uuid, () => { clearTimeout(timer); this.acknowledgements.delete(origin.uuid); resolve(true) })
        })
        thread.status = 'running'
        try {
          const delivery = runtime.protocol.write({ type: 'user', uuid: origin.uuid, session_id: alias.sessionId, parent_tool_use_id: null, message: { role: 'user', content } })
          this.emit(); await delivery
        }
        catch { clearTimeout(timer); this.acknowledgements.delete(origin.uuid); return { accepted: false, uncertain: true } }
        return await acknowledged ? { accepted: true } : { accepted: false, uncertain: true }
      } finally { this.dispatching.delete(id) }
    }
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('Claude is not attached to this thread. Reconnect before continuing.')
    if (command.type === 'answer') {
      const pending = runtime.requests.get(command.requestId)
      if (!pending) throw new Error('That request is no longer pending.')
      const answer = claudeAnswer(pending, command.answer, command.approved)
      runtime.requests.delete(pending.id); thread.requests = thread.requests.filter(request => request.id !== pending.id); this.emit()
      try { await this.reply(runtime, pending.id, answer); return { accepted: true } } catch { return { accepted: false, uncertain: true } }
    }
    if (command.type === 'interrupt') {
      await this.denyPending(id, runtime)
      try { await runtime.protocol.control({ subtype: 'interrupt' }); thread.status = 'idle'; this.emit(); return { accepted: true } }
      catch { return { accepted: false, uncertain: true } }
    }
    throw new Error('Unsupported Claude command.')
  }
  async pollSessionLogs(): Promise<void> { for (const log of this.logs.values()) await log.poll() }
  disconnect(): void {
    this.generation++; clearInterval(this.pollTimer); this.pollTimer = undefined; this.state.connected = false
    for (const [id, runtime] of this.runtimes) {
      const closure = this.denyPending(id, runtime).catch(() => undefined).then(() => { runtime.protocol.stop(); return runtime.protocol.closed })
      this.closures.push(closure)
    }
    this.runtimes.clear(); this.starting.clear(); this.emit()
  }
  async closed(): Promise<void> { await Promise.all(this.closures); this.closures = [] }
  private async start(id: string): Promise<Runtime> {
    const pending = this.starting.get(id); if (pending) return pending
    const runtime = this.runtimes.get(id); if (runtime) return runtime
    const work = this.launch(id); this.starting.set(id, work)
    try { return await work } finally { this.starting.delete(id) }
  }
  private async launch(id: string): Promise<Runtime> {
    const alias = this.aliases[id]!; const generation = this.generation
    const resume = await this.log(id).exists()
    if (generation !== this.generation) throw new Error('Claude connection was cancelled.')
    if (!resume && alias.origins.length) throw new Error('Claude native history is unavailable. Restore its session before continuing; Sotto will not recreate or resend an uncertain turn.')
    const args = [...(this.options.args ?? []), '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--replay-user-messages', '--permission-mode', 'default', '--permission-prompts', 'host',
      resume ? '--resume' : '--session-id', alias.sessionId, '--model', alias.modelId, ...(alias.reasoningEffort ? ['--effort', alias.reasoningEffort] : [])]
    const runtime: Runtime = { requests: new Map(), protocol: new ClaudeProtocol(this.executable, args, alias.cwd, this.client.environment(), this.options.requestTimeoutMs ?? 15000,
      frame => { if (this.runtimes.get(id) === runtime) this.frame(id, frame) }, () => {
        if (this.runtimes.get(id) !== runtime) return
        this.runtimes.delete(id); this.threads.get(id)!.requests = []; this.threads.get(id)!.status = 'error'
        this.state.connected = false; this.state.error = 'Claude Code disconnected. Reconnect to recover its existing session; uncertain prompts will not be resent.'; this.emit()
      }) }
    this.runtimes.set(id, runtime); this.closures.push(runtime.protocol.closed)
    try { await runtime.protocol.control({ subtype: 'initialize', hooks: {}, sdkMcpServers: [], promptSuggestions: false }) }
    catch (error) { this.runtimes.delete(id); runtime.protocol.stop(); throw error }
    if (generation !== this.generation) { runtime.protocol.stop(); throw new Error('Claude connection was cancelled.') }
    return runtime
  }
  private frame(id: string, frame: ClaudeFrame): void {
    const runtime = this.runtimes.get(id)!; const thread = this.threads.get(id)!; const alias = this.aliases[id]!
    if (typeof frame.session_id === 'string' && frame.session_id !== alias.sessionId) return
    if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.claude_code_version === 'string') this.state.version = frame.claude_code_version
    if (frame.type === 'control_request') {
      const pending = runtime.requests.size < 256 ? claudePending(frame) : undefined
      if (pending) { runtime.requests.set(pending.id, pending); thread.requests = [...runtime.requests.values()].map(value => value.request); this.emit() }
      else if (typeof frame.request_id === 'string') {
        const requestId = frame.request_id
        const response = object(frame.request)?.subtype === 'can_use_tool'
          ? this.reply(runtime, requestId, claudeDenial())
          : runtime.protocol.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'Unsupported Claude control request.' } })
        void response.catch(() => undefined)
      }
      return
    }
    if (frame.type === 'control_cancel_request' && typeof frame.request_id === 'string') { runtime.requests.delete(frame.request_id); thread.requests = [...runtime.requests.values()].map(value => value.request) }
    if (frame.parent_tool_use_id) return
    if (frame.type === 'user' && authoredClaudeUser(frame)) {
      this.message(id, frame, false)
      const uuid = typeof frame.uuid === 'string' ? frame.uuid : ''
      if (alias.origins.some(origin => origin.uuid === uuid)) { if (!this.completedOrigins.has(uuid)) thread.status = 'running'; this.acknowledgements.get(uuid)?.() }
    }
    if (frame.type === 'assistant') this.message(id, frame, false)
    if (frame.type === 'stream_event') {
      const event = object(frame.event)
      if (event?.type === 'message_start') {
        const message = object(event.message)
        if (typeof message?.id === 'string') this.addMessage(id, { id: message.id, role: 'assistant', text: '', createdAt: new Date().toISOString() })
      }
      const delta = object(event?.delta)
      if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        const last = thread.messages.at(-1)
        if (last?.role === 'assistant') last.text += delta.text
      }
    }
    if (frame.type === 'result') {
      const origin = typeof frame.user_message_uuid === 'string' ? frame.user_message_uuid : alias.origins.at(-1)?.uuid
      if (origin) this.completedOrigins.add(origin)
      thread.status = frame.is_error === true ? 'error' : 'idle'; runtime.requests.clear(); thread.requests = []
      if (frame.is_error === true) this.state.error = 'Claude could not complete this turn. Check its native subscription, model and usage limits.'
    }
    this.emit()
  }
  private message(id: string, frame: ClaudeFrame, fromLog: boolean): void {
    const message = object(frame.message); let text = claudeText(message?.content)
    if ((!text && frame.type !== 'user') || !['user', 'assistant'].includes(String(frame.type))) return
    if (frame.type === 'user' && !authoredClaudeUser(frame)) return
    const alias = this.aliases[id]!; const uuid = typeof frame.uuid === 'string' ? frame.uuid : ''
    const digest = claudeDigest(text)
    let origin = alias.origins.find(value => value.uuid === uuid)
    if (fromLog && frame.type === 'user') {
      const consumed = this.logOrigins.get(id) ?? new Set<string>(); this.logOrigins.set(id, consumed)
      origin ??= alias.origins.find(value => !consumed.has(value.uuid) && value.digest === digest)
      if (origin) { consumed.add(origin.uuid); this.lastLogDigest.set(id, digest) }
      else if (this.lastLogDigest.get(id) === digest) return
      else { this.lastLogDigest.delete(id); this.staleContexts.add(id) }
    }
    const providerId = frame.type === 'assistant' && typeof message?.id === 'string' ? message.id : uuid || `native-${digest}`
    if (frame.type === 'assistant') {
      const blockKey = `${id}:${providerId}`; const blocks = this.assistantBlocks.get(blockKey) ?? new Map<string, string>()
      blocks.set(uuid || digest, text); this.assistantBlocks.set(blockKey, blocks); text = [...blocks.values()].join('\n')
    }
    this.addMessage(id, { id: origin?.messageId ?? providerId, role: frame.type as 'user' | 'assistant', text,
      createdAt: origin?.createdAt ?? (typeof frame.timestamp === 'string' ? frame.timestamp : new Date().toISOString()), ...(origin ? { commandId: origin.commandId, ...(origin.attachments ? { attachments: origin.attachments } : {}) } : {}) })
  }
  private log(id: string): ClaudeSessionLog {
    let log = this.logs.get(id)
    if (!log) {
      const alias = this.aliases[id]!
      const generation = this.generation
      log = new ClaudeSessionLog(this.options.claudeHome ?? join(homedir(), '.claude'), alias.cwd, alias.sessionId, frame => {
        if (generation === this.generation) { this.message(id, frame, true); this.emit() }
      })
      this.logs.set(id, log)
    }
    return log
  }
  private ensureThread(id: string, alias: Alias): void {
    this.threads.set(id, { id, projectId: alias.projectId, workingDirectory: alias.cwd, title: alias.title, modelId: alias.modelId, reasoningEffort: alias.reasoningEffort, runtimeMode: 'approval-required', status: 'idle', messages: [], requests: [] })
  }
  private addMessage(id: string, message: AgentMessage): void {
    const thread = this.threads.get(id)!; const existing = thread.messages.find(value => value.id === message.id)
    if (existing) { existing.text = message.text; existing.createdAt = message.createdAt; if (message.commandId) existing.commandId = message.commandId; if (message.attachments) existing.attachments = message.attachments }
    else thread.messages.push(message)
  }
  private reply(runtime: Runtime, id: string, response: ClaudeFrame): Promise<void> {
    return runtime.protocol.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
  }
  private async denyPending(id: string, runtime: Runtime): Promise<void> {
    const pending = [...runtime.requests.keys()]; runtime.requests.clear()
    const thread = this.threads.get(id); if (thread) thread.requests = []
    await Promise.all(pending.map(requestId => this.reply(runtime, requestId, claudeDenial())))
  }
  private persist(): Promise<void> { return this.aliasStore.write(structuredClone(this.aliases)) }
  private view(): AgentHostSnapshot { return structuredClone({ ...this.state, threads: [...this.threads.values()] }) }
  private emit(): void { const snapshot = this.view(); for (const listener of this.listeners) listener(snapshot) }
}

