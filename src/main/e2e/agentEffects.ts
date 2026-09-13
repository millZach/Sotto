import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_AGENT_HOST, agentRuntimeModeSchema, attachmentSizeBytes, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import { designThreadsFixture, type E2EScenario, type SottoE2EBridge } from '../../shared/e2e'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../agents/host'
import type { AgentReasoner } from '../agents/reasoning'

/** External provider effects only. The real controller, persistence, IPC and both renderers remain in the test. */
export class E2EAgentHost implements AgentHost {
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly commands = new Set<string>()
  private uncertain = false
  private rejection: string | null = null
  private connectRejection: string | null = null
  private state: AgentHostSnapshot = {
    ...structuredClone(EMPTY_AGENT_HOST), version: 'fixture',
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true },
    models: [{ id: 'claude:test', provider: 'Claude', name: 'Claude Test', ready: true,
      reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', runtimeModes: [...agentRuntimeModeSchema.options], supportsImages: true }],
    projects: [{ id: 'project', title: 'Sotto test', path: 'C:/sotto-test' }],
    threads: ['workshop', 'docs'].map((id): AgentThread => ({ id, title: id === 'workshop' ? 'Workshop' : 'Docs', projectId: 'project', modelId: 'claude:test', status: 'idle', messages: [], requests: [] })),
  }
  constructor(scenario: E2EScenario = 'success') {
    if (scenario === 'design-threads' || scenario === 'design-threads-empty') {
      const fixture = designThreadsFixture()
      this.state.models = structuredClone([...fixture.models])
      this.state.projects = structuredClone([...fixture.projects])
      this.state.threads = scenario === 'design-threads' ? structuredClone([...fixture.threads]) : []
    }
  }
  /** Interactive journeys use real folders inside their owned profile, so normal cwd validation stays active. */
  async initializeWorkingFolders(root: string): Promise<void> {
    for (const project of this.state.projects) {
      project.path = join(root, project.id)
      await mkdir(project.path, { recursive: true })
    }
  }
  async connect(): Promise<AgentHostSnapshot> {
    if (this.connectRejection !== null) {
      const message = this.connectRejection
      this.connectRejection = null
      throw new Error(message)
    }
    this.state.connected = true
    return this.snapshot()
  }
  async snapshot(): Promise<AgentHostSnapshot> { return structuredClone(this.state) }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  disconnect(): void { this.state.connected = false }
  private emit(): void { for (const listener of this.listeners) listener(structuredClone(this.state)) }
  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    if (this.commands.has(command.commandId)) return { accepted: true }
    if (this.rejection !== null) {
      const message = this.rejection
      this.rejection = null
      throw new Error(message)
    }
    this.commands.add(command.commandId)
    if (command.type === 'create-project') this.state.projects.push({ id: command.projectId, title: command.title, path: command.path })
    else if (command.type === 'create-thread') this.state.threads.push({ id: command.threadId, title: command.title, projectId: command.projectId, modelId: command.modelId,
      runtimeMode: command.runtimeMode ?? 'approval-required', reasoningEffort: command.reasoningEffort ?? 'low', status: 'idle', messages: [], requests: [] })
    else {
      const thread = this.state.threads.find(t => t.id === command.threadId)
      if (!thread) return { accepted: false }
      if (command.type === 'configure-thread') {
        if (command.modelId !== undefined) { thread.modelId = command.modelId; thread.reasoningEffort = 'low' }
        if (command.reasoningEffort !== undefined) thread.reasoningEffort = command.reasoningEffort
        if (command.runtimeMode !== undefined) thread.runtimeMode = command.runtimeMode
      } else if (command.type === 'send') {
        if (command.expectedLastUserMessageId !== undefined && command.expectedLastUserMessageId !== (thread.messages.findLast(m => m.role === 'user')?.id ?? null)) return { accepted: false }
        thread.settledAt = null; thread.settledOverride = null; thread.updatedAt = new Date().toISOString()
        thread.messages.push({ id: command.messageId, role: 'user', text: command.text, createdAt: new Date().toISOString(), commandId: command.commandId,
          ...(command.attachments?.length ? { attachments: command.attachments.map(attachment => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachmentSizeBytes(attachment.dataUrl) })) } : {}) }); thread.status = 'running'
      } else if (command.type === 'answer') { thread.requests = thread.requests.filter(r => r.id !== command.requestId); thread.status = 'running' }
      else thread.status = 'idle'
    }
    if (this.uncertain && command.type === 'send') { this.uncertain = false; return { accepted: false, uncertain: true } }
    this.emit()
    return { accepted: true }
  }
  event(event: Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]): void {
    if (event.type === 'connect-reject') { this.connectRejection = event.text; return }
    if (event.type === 'uncertain') { this.uncertain = true; return }
    if (event.type === 'reject') { this.rejection = event.text; return }
    if (event.type === 'reasoner-release') { pendingReasoning.get(event.threadId)?.(); pendingReasoning.delete(event.threadId); return }
    if (event.type === 'disconnect') { this.state.connected = false; this.emit(); return }
    const thread = this.state.threads.find(t => t.id === event.threadId)
    if (!thread) throw new Error('E2E_THREAD_UNAVAILABLE')
    if (event.type === 'question' || event.type === 'permission') {
      const request = event.request ?? { id: event.requestId ?? randomUUID(), kind: event.type, text: event.text, options: [] }
      if (request.kind !== event.type) throw new Error('E2E_REQUEST_KIND_MISMATCH')
      thread.requests.push(structuredClone(request))
    }
    else thread.messages.push({ id: randomUUID(), role: event.type === 'manual' ? 'user' : 'assistant', text: event.text, createdAt: new Date().toISOString() })
    if (event.activities) thread.activities = structuredClone(event.activities)
    thread.status = event.status ?? (event.type === 'manual' ? 'running' : event.type === 'failure' ? 'error' : 'idle')
    this.emit()
  }
}

const pendingReasoning = new Map<string, () => void>()
export const e2eAgentReasoner: AgentReasoner = {
  async account(provider) {
    return { provider, label: provider === 'claude' ? 'Claude subscription' : provider === 'codex' ? 'ChatGPT subscription' : 'Grok subscription',
      installed: true, ready: true, detail: 'Connected through the provider app; no API key is needed.',
      defaultModelId: 'fixture-model', models: [
        { id: 'fixture-model', name: 'Fixture reasoning model', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
        { id: 'fixture-alternate', name: 'Another subscription model', reasoningEfforts: ['low', 'high', 'max'] },
      ] }
  },
  async intent(utterance) {
    if (utterance.toLowerCase().includes('create a project called clarified project')) {
      const folder = /(?:[A-Za-z]:[\\/]|\/)[^\r\n]+$/u.exec(utterance)?.[0]
      return folder
        ? { type: 'create-project', title: 'Clarified Project', path: folder }
        : { type: 'clarify', text: 'Which folder should contain Clarified Project?' }
    }
    return { type: 'clarify', text: 'Choose a project and thread using the controls.' }
  },
  async decide(_instruction, thread) {
    const text = thread.messages.at(-1)?.text ?? thread.requests[0]?.text ?? ''
    if (text.includes('await external decision')) await new Promise<void>(resolve => pendingReasoning.set(thread.id, resolve))
    return text.includes('fixable') ? { decision: 'followup', text: `Fix the failing test in the assigned scope: ${text}` } : { decision: 'human', text }
  },
}
