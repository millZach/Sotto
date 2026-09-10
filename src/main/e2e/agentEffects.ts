import { randomUUID } from 'node:crypto'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import type { SottoE2EBridge } from '../../shared/e2e'
import type { AgentHost, AgentHostCommand, AgentHostResult } from '../agents/host'
import type { AgentReasoner } from '../agents/reasoning'

/** External T3 effects only. The real controller, persistence, IPC and both renderers remain in the test. */
export class E2EAgentHost implements AgentHost {
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  private readonly commands = new Set<string>()
  private uncertain = false
  private rejection: string | null = null
  private connectRejection: string | null = null
  private state: AgentHostSnapshot = {
    ...structuredClone(EMPTY_AGENT_HOST), version: '0.0.38',
    capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
    models: [{ id: 'claude:test', provider: 'Claude', name: 'Claude Test', ready: true }],
    projects: [{ id: 'project', title: 'Sotto test', path: 'C:/sotto-test' }],
    threads: ['workshop', 'docs'].map((id): AgentThread => ({ id, title: id === 'workshop' ? 'Workshop' : 'Docs', projectId: 'project', modelId: 'claude:test', status: 'idle', messages: [], requests: [] })),
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
    else if (command.type === 'create-thread') this.state.threads.push({ id: command.threadId, title: command.title, projectId: command.projectId, modelId: command.modelId, status: 'idle', messages: [], requests: [] })
    else {
      const thread = this.state.threads.find(t => t.id === command.threadId)
      if (!thread) return { accepted: false }
      if (command.type === 'send') {
        if (command.expectedLastUserMessageId !== undefined && command.expectedLastUserMessageId !== (thread.messages.findLast(m => m.role === 'user')?.id ?? null)) return { accepted: false }
        thread.messages.push({ id: command.messageId, role: 'user', text: command.text, createdAt: new Date().toISOString(), commandId: command.commandId }); thread.status = 'running'
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
    if (event.type === 'question' || event.type === 'permission') thread.requests.push({ id: event.requestId ?? randomUUID(), kind: event.type, text: event.text, options: [] })
    else thread.messages.push({ id: randomUUID(), role: event.type === 'manual' ? 'user' : 'assistant', text: event.text, createdAt: new Date().toISOString() })
    thread.status = event.status ?? (event.type === 'manual' ? 'running' : event.type === 'failure' ? 'error' : 'idle')
    this.emit()
  }
}

const pendingReasoning = new Map<string, () => void>()
export const e2eAgentReasoner: AgentReasoner = {
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
