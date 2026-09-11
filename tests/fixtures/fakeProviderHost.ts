import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../src/shared/agents'
import type { AgentHost, AgentHostCommand, AgentHostConnection, AgentHostResult } from '../../src/main/agents/host'

/** Provider-facing fake: session IDs deliberately differ from Sotto thread IDs. */
export class FakeProviderHost implements AgentHost {
  readonly commands: AgentHostCommand[] = []
  observed: readonly string[] = []
  connection: AgentHostConnection | undefined
  private readonly listeners = new Set<(snapshot: AgentHostSnapshot) => void>()
  readonly state: AgentHostSnapshot

  constructor(state?: AgentHostSnapshot) {
    this.state = structuredClone(state ?? {
      ...EMPTY_AGENT_HOST, name: 'Fake provider', version: '1',
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true,
        permissions: true, interrupt: true, messageOrigin: true, reconcile: true },
      projects: [{ id: 'project', title: 'Test project', path: 'C:/sotto-test' }],
      models: [{ id: 'fake:model', provider: 'Fake', name: 'Test model', ready: true }],
      threads: ['workshop', 'docs'].map((name): AgentThread => ({
        id: `session-${name}`, projectId: 'project', title: name === 'workshop' ? 'Workshop' : 'Docs',
        modelId: 'fake:model', status: 'idle', messages: [], requests: [],
      })),
    })
  }

  async connect(connection: AgentHostConnection): Promise<AgentHostSnapshot> {
    this.connection = connection
    this.state.connected = true
    return this.snapshot()
  }
  async snapshot(): Promise<AgentHostSnapshot> { return structuredClone(this.state) }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(): void { for (const listener of this.listeners) listener(structuredClone(this.state)) }
  observeThreads(threadIds: readonly string[]): void { this.observed = [...threadIds] }
  disconnect(): void { this.state.connected = false }

  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    this.commands.push(structuredClone(command))
    if (command.type === 'create-project') {
      this.state.projects.push({ id: command.projectId, title: command.title, path: command.path })
    } else if (command.type === 'create-thread') {
      if (!this.state.threads.some(thread => thread.id === command.threadId)) {
        this.state.threads.push({ id: command.threadId, projectId: command.projectId, title: command.title,
          modelId: command.modelId, status: 'idle', messages: [], requests: [] })
      }
    } else {
      const thread = this.state.threads.find(thread => thread.id === command.threadId)
      if (!thread) throw new Error('Unknown provider session')
      if (command.type === 'send') {
        if (command.expectedLastUserMessageId !== undefined && command.expectedLastUserMessageId !== (thread.messages.findLast(m => m.role === 'user')?.id ?? null)) {
          throw new Error('The thread changed in the provider before Sotto could reply.')
        }
        thread.messages.push({ id: command.messageId, commandId: command.commandId, role: 'user',
          text: command.text, createdAt: new Date().toISOString() })
        thread.status = 'running'
      } else if (command.type === 'answer') {
        thread.requests = thread.requests.filter(request => request.id !== command.requestId)
        thread.status = 'running'
      } else thread.status = 'idle'
    }
    this.emit()
    return { accepted: true }
  }
}
