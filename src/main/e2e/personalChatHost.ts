import { join } from 'node:path'
import { z } from 'zod'
import { agentThreadSchema, type AgentHostSnapshot } from '../../shared/agents'
import type { AgentSkillCatalog } from '../../shared/agentSkills'
import type { CodexAppServerHost, CodexPersonalConversation } from '../agents/codex'
import type { AgentHostCommand, AgentHostResult } from '../agents/host'
import { AtomicJsonStore } from '../storage/atomicJsonStore'
import type { SottoE2EBridge } from '../../shared/e2e'

const conversationSchema = agentThreadSchema.omit({ projectId: true }).extend({ kind: z.literal('personal') })

/** Deterministic provider effects for the explicitly opted-in, unpackaged E2E runtime.
 * PersonalChatService, IPC, persistence and the complete application renderer remain real.
 * This fixture never starts a native executable or accesses an installed account.
 */
export class E2EPersonalChatHost {
  private readonly store: AtomicJsonStore<CodexPersonalConversation[]>
  private conversations: CodexPersonalConversation[] = []
  private connected = false
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private writing: Promise<void> = Promise.resolve()
  private readonly rejections = new Map<string, string>()

  constructor(directory: string, private readonly providerId: 'codex' | 'claude' | 'grok' = 'codex') {
    this.store = new AtomicJsonStore(join(directory, this.providerId === 'codex' ? 'e2e-personal-native.json' : `e2e-personal-${this.providerId}.json`), value => z.array(conversationSchema).parse(value), () => [])
  }

  private current(): AgentHostSnapshot {
    return { connected: this.connected, name: `${this.providerId} fixture`, version: 'e2e', projects: [], threads: [],
      models: [{ id: `${this.providerId}:test`, provider: this.providerId, providerId: this.providerId, name: `${this.providerId} fixture`, ready: this.connected, reasoningEfforts: ['low'] }],
      capabilities: { projects: false, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true,
        messageOrigin: true, reconcile: true, skills: true },
    }
  }

  private publish(): void { for (const listener of this.listeners) listener(this.current()) }
  private persist(): Promise<void> {
    this.writing = this.store.write(structuredClone(this.conversations))
    return this.writing
  }
  private conversation(id: string): CodexPersonalConversation {
    const conversation = this.conversations.find(value => value.id === id)
    if (!conversation) throw new Error('Fixture conversation is unavailable.')
    return conversation
  }
  async connect(): Promise<AgentHostSnapshot> {
    this.conversations = await this.store.read()
    this.connected = true
    this.publish()
    return this.current()
  }
  disconnect(): void { this.connected = false; this.publish() }
  async closed(): Promise<void> { await this.writing }
  async snapshot(): Promise<AgentHostSnapshot> { return this.current() }
  personalSnapshot(): CodexPersonalConversation[] { return structuredClone(this.conversations) }
  async refreshThread(id: string): Promise<AgentHostSnapshot> { this.conversation(id); this.publish(); return this.current() }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async event(event: Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]): Promise<void> {
    if (event.type === 'reject') { this.rejections.set(event.threadId, event.text); return }
    const conversation = this.conversation(event.threadId)
    if (event.type === 'question' || event.type === 'permission') {
      if (!event.request || event.request.kind !== event.type) throw new Error('E2E_PERSONAL_REQUEST_REQUIRED')
      conversation.requests.push(structuredClone(event.request))
    } else if (event.type !== 'ready') throw new Error('E2E_PERSONAL_EVENT_UNSUPPORTED')
    if (event.activities) conversation.activities = structuredClone(event.activities)
    if (event.status) conversation.status = event.status
    await this.persist()
    this.publish()
  }

  private rejectNext(id: string): void {
    const reason = this.rejections.get(id)
    if (reason === undefined) return
    this.rejections.delete(id)
    throw new Error(reason)
  }

  async createPersonalConversation(command: Parameters<CodexAppServerHost['createPersonalConversation']>[0]): Promise<AgentHostResult> {
    if (!this.connected) throw new Error('Connect the fixture provider.')
    if (!this.conversations.some(value => value.id === command.threadId)) {
      this.conversations.push({ id: command.threadId, kind: 'personal', title: command.title, modelId: command.modelId,
        ...(command.reasoningEffort ? { reasoningEffort: command.reasoningEffort } : {}),
        workingDirectory: command.workingDirectory, status: 'idle', messages: [], requests: [], activities: [] })
      await this.persist()
    }
    this.publish()
    return { accepted: true }
  }

  async sendPersonalConversation(command: Extract<AgentHostCommand, { type: 'send' }>): Promise<AgentHostResult> {
    if (!this.connected) throw new Error('Connect the fixture provider.')
    this.rejectNext(command.threadId)
    const conversation = this.conversation(command.threadId)
    if (conversation.messages.some(message => message.commandId === command.commandId)) return { accepted: true }
    const at = new Date().toISOString()
    conversation.messages.push({ id: command.messageId, commandId: command.commandId, role: 'user', text: command.text, createdAt: at })
    conversation.messages.push({ id: `reply-${command.messageId}`, role: 'assistant', createdAt: at,
      text: `## A saved conversation\n\nYou said: ${command.text}\n\nThis reply belongs to this personal chat.\n\n- Its history survives restart.\n- Project threads stay separate.` })
    conversation.status = 'idle'
    conversation.lastTurn = { id: `turn-${command.messageId}`, status: 'completed' }
    await this.persist()
    this.publish()
    return { accepted: true }
  }

  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (command.type !== 'answer' && command.type !== 'interrupt') throw new Error('This fixture only supports personal conversation controls.')
    if (!this.connected) throw new Error('Connect the fixture provider.')
    this.rejectNext(command.threadId)
    const conversation = this.conversation(command.threadId)
    if (command.type === 'answer') {
      if (!conversation.requests.some(request => request.id === command.requestId)) throw new Error('This request is no longer pending.')
      conversation.requests = conversation.requests.filter(request => request.id !== command.requestId)
    } else { conversation.status = 'idle'; conversation.requests = [] }
    await this.persist()
    this.publish()
    return { accepted: true }
  }

  async listThreadSkills(threadId: string): Promise<AgentSkillCatalog> {
    if (!this.connected) throw new Error('Connect the fixture provider.')
    return { threadId, providerId: this.providerId, cwd: this.conversations.find(value => value.id === threadId)?.workingDirectory ?? 'fixture-personal',
      status: 'ready', errors: [], skills: [{ name: 'brainstorm', path: '/fixture/personal/brainstorm/SKILL.md',
        description: 'Explore the choices in this synthetic personal chat.', scope: 'user' }] }
  }
}
