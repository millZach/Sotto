import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentThread } from '../../src/shared/agents'
import type { AgentHost, AgentHostCommand, AgentHostResult, ShortTextPrompt, ThreadForkRequest } from '../../src/main/agents/host'
import { validatePromptAttachments } from '../../src/main/agents/threadOptions'

/** Provider-facing fake: session IDs deliberately differ from Sotto thread IDs. */
export class FakeProviderHost implements AgentHost {
  readonly commands: AgentHostCommand[] = []
  /** The bytes of every image a send or steer carried, read at this boundary the way an adapter reads them (ADR-0031). */
  readonly images: Uint8Array[] = []
  /** Every side call this provider was asked for, under its own session ID (ADR-0026). */
  readonly sideWrites: { sessionId: string; prompt: ShortTextPrompt }[] = []
  /** What a side call answers; absent, this provider writes nothing, the way Devin does. */
  sideWriter: ((sessionId: string, prompt: ShortTextPrompt) => Promise<string | null>) | undefined
  observed: readonly string[] = []
  /** The live-session set as last named, by this provider's session IDs; undefined until one is. */
  live: readonly string[] | undefined
  /** The provider's own copy of a conversation (#1028), when a test gives this provider one. */
  forkThread?: (request: ThreadForkRequest) => Promise<AgentHostResult>
  connectCalls = 0
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

  async connect(): Promise<AgentHostSnapshot> {
    this.connectCalls += 1
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
  keepSessionsLive(threadIds: readonly string[]): void { this.live = [...threadIds] }
  async writeShortText(sessionId: string, prompt: ShortTextPrompt): Promise<string | null> {
    this.sideWrites.push({ sessionId, prompt: structuredClone(prompt) })
    return this.sideWriter ? this.sideWriter(sessionId, prompt) : null
  }
  disconnect(): void { this.state.connected = false }

  async execute(command: AgentHostCommand): Promise<AgentHostResult> {
    // An image's reader is the store's and does not clone; the log keeps its handle, and its bytes are read here.
    const images = (command.type === 'send' || command.type === 'steer') ? command.attachments ?? [] : []
    // Like an adapter, it refuses images its model does not take before reading anything.
    if (images.length) validatePromptAttachments(this.state, this.state.threads.find(thread => 'threadId' in command && thread.id === command.threadId)?.modelId ?? '', images)
    for (const image of images) this.images.push(await image.read())
    this.commands.push(structuredClone(images.length ? { ...command, attachments: images.map(({ id, name, mimeType, sizeBytes, digest }) => ({ id, name, mimeType, sizeBytes, digest })) } as unknown as AgentHostCommand : command))
    if (command.type === 'create-project') {
      this.state.projects.push({ id: command.projectId, title: command.title, path: command.path })
    } else if (command.type === 'create-thread') {
      if (!this.state.threads.some(thread => thread.id === command.threadId)) {
        this.state.threads.push({ id: command.threadId, projectId: command.projectId, title: command.title,
          modelId: command.modelId, ...(command.speed ? { speed: command.speed } : {}), status: 'idle', messages: [], requests: [] })
      }
    } else {
      const thread = this.state.threads.find(thread => thread.id === command.threadId)
      if (!thread) throw new Error('Unknown provider session')
      if (command.type === 'send') {
        if (command.expectedLastUserMessageId !== undefined && command.expectedLastUserMessageId !== (thread.messages.findLast(m => m.role === 'user')?.id ?? null)) {
          throw new Error('The thread changed in the provider before Sotto could reply.')
        }
        thread.messages.push({ id: command.messageId, commandId: command.commandId, role: 'user',
          text: command.text, createdAt: new Date().toISOString(),
          ...(images.length ? { attachments: images.map(({ id, name, mimeType, sizeBytes }) => ({ id, name, mimeType, sizeBytes })) } : {}) })
        thread.status = 'running'
      } else if (command.type === 'answer') {
        thread.requests = thread.requests.filter(request => request.id !== command.requestId)
        thread.status = 'running'
      } else {
        // A settings change moves the session to the model it names, as an adapter's does.
        if (command.type === 'configure-thread' && command.modelId) thread.modelId = command.modelId
        thread.status = 'idle'
      }
    }
    this.emit()
    return { accepted: true }
  }
}
