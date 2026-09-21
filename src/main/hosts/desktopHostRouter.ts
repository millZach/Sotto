import { agentCommandSchema, agentShell, isThreadProviderConnected, type AgentCommand, type AgentState, type AgentThreadDetail, type AgentThreadDetailUpdate, type AgentAttachmentPreviewRequest, type AgentAttachmentPreviewResult } from '../../shared/agents'
import { clientAgentState, hostEntityKey, mapHostReferences, parseHostEntityKey } from '../../shared/clientIdentity'
import type { ClientIdentity, HostService } from '../agents/hostService'

export interface DesktopHostConnection {
  hostId: string
  name: string
  kind: 'local' | 'remote'
  service: Pick<HostService, 'shell' | 'command' | 'subscribe'>
  detail(threadId: string): AgentThreadDetail | null | Promise<AgentThreadDetail | null>
  preview(request: AgentAttachmentPreviewRequest): AgentAttachmentPreviewResult | Promise<AgentAttachmentPreviewResult>
  observe?(threadIds: string[]): Promise<unknown>
  subscribeDetail?(listener: (detail: AgentThreadDetailUpdate) => void): () => void
  available?: () => boolean
}

/** Routing happens in main, before host-local IDs or privileged command schemas are decoded. */
export class DesktopHostRouter {
  private readonly hosts = new Map<string, { connection: DesktopHostConnection; off: (() => void)[] }>()
  private readonly listeners = new Set<(state: AgentState) => void>()
  private readonly detailListeners = new Set<(detail: AgentThreadDetailUpdate) => void>()
  private selectedHostId: string | undefined
  private selectedThreadId: string | null | undefined
  private selectedProjectId: string | null = null
  private notice: string | undefined

  constructor(private readonly empty: () => AgentState) {}

  add(connection: DesktopHostConnection): void {
    if (this.hosts.has(connection.hostId)) throw new Error('This host is already connected.')
    const off = [connection.service.subscribe(() => this.emit())]
    if (connection.subscribeDetail) off.push(connection.subscribeDetail(detail => {
      const scoped = mapHostReferences(detail, id => hostEntityKey(connection.hostId, id))
      for (const listener of this.detailListeners) listener(scoped)
    }))
    this.hosts.set(connection.hostId, { connection, off })
    this.selectedHostId ??= connection.hostId
    this.emit()
  }
  remove(hostId: string): void {
    this.hosts.get(hostId)?.off.forEach(off => off())
    this.hosts.delete(hostId)
    if (this.selectedHostId === hostId) this.selectedHostId = this.hosts.keys().next().value
    if (this.selectedThreadId && parseHostEntityKey(this.selectedThreadId)?.hostId === hostId) this.selectedThreadId = null
    this.emit()
  }
  select(hostId: string): void {
    if (!this.hosts.has(hostId)) throw new Error('Connect this host before selecting it.')
    this.selectedHostId = hostId; this.selectedThreadId = null; this.selectedProjectId = null; this.emit()
  }
  subscribe(listener: (state: AgentState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  subscribeThreadDetail(listener: (detail: AgentThreadDetailUpdate) => void): () => void { this.detailListeners.add(listener); return () => this.detailListeners.delete(listener) }
  get(): AgentState { return this.shell() }
  shell(): AgentState {
    const entries = [...this.hosts.values()].map(({ connection }) => {
      const original = connection.service.shell()
      return { connection, original, state: clientAgentState(original) }
    })
    const base = entries.find(item => item.connection.hostId === this.selectedHostId)?.state ?? this.empty()
    const multiple = entries.length > 1
    const threads = entries.flatMap(({ connection, original, state }) => state.host.threads.map((thread, index) => ({
      ...thread, hostId: connection.hostId, hostLabel: multiple ? connection.name : undefined, remoteHost: connection.kind === 'remote',
      clientConnected: connection.available?.() !== false && isThreadProviderConnected(original.host, original.host.threads[index]!),
    })))
    return {
      ...base, clientScoped: true,
      connections: entries.map(({ connection }) => ({ hostId: connection.hostId, name: connection.name, kind: connection.kind, connected: connection.available?.() !== false })),
      host: { ...base.host, connected: threads.some(thread => thread.clientConnected) || entries.some(item => item.state.host.connected),
        projects: entries.flatMap(item => item.state.host.projects), threads,
        clientHosts: entries.map(({ connection, original }) => ({ hostId: connection.hostId,
          connected: connection.available?.() !== false && original.host.connected,
          models: original.host.models, capabilities: original.host.capabilities,
          ...(original.host.providers ? { providers: original.host.providers } : {}),
        })),
      },
      assignments: entries.flatMap(item => item.state.assignments), queue: entries.flatMap(item => item.state.queue),
      threadDrafts: entries.flatMap(item => item.state.threadDrafts ?? []),
      threadDraftPersistence: entries.flatMap(item => item.state.threadDraftPersistence ?? []),
      deliveries: entries.flatMap(item => item.state.deliveries ?? []), followups: entries.flatMap(item => item.state.followups ?? []),
      busyThreadIds: entries.flatMap(item => item.state.busyThreadIds ?? []),
      activeThreadId: this.selectedThreadId === undefined ? base.activeThreadId : this.selectedThreadId,
      activeProjectId: this.selectedProjectId ?? base.activeProjectId,
      ...(this.notice ? { error: this.notice } : {}),
    }
  }
  private target(id?: string): { connection: DesktopHostConnection; id: string | undefined } {
    const key = id ? parseHostEntityKey(id) : null
    const hostId = key?.hostId ?? this.selectedHostId
    const entry = hostId ? this.hosts.get(hostId) : undefined
    if (!entry) throw new Error('Connect a host in Settings > Hosts to continue.')
    return { connection: entry.connection, id: key?.id ?? id }
  }
  async threadDetail(threadId: string): Promise<AgentThreadDetail | null> {
    const { connection, id } = this.target(threadId)
    const detail = await connection.detail(id!)
    return detail ? mapHostReferences(detail, value => hostEntityKey(connection.hostId, value)) : null
  }
  async attachmentPreview(request: AgentAttachmentPreviewRequest): Promise<AgentAttachmentPreviewResult> {
    const { connection, id } = this.target(request.threadId)
    return connection.preview({ ...request, threadId: id! })
  }
  async command(input: unknown, client: ClientIdentity): Promise<AgentState> {
    this.notice = undefined
    const references = new Set<string>()
    mapHostReferences(input, value => { const key = parseHostEntityKey(value); if (key) references.add(key.hostId); return value })
    const type = input && typeof input === 'object' && 'type' in input ? input.type : undefined
    if (type === 'observe-threads') {
      const parsed = agentCommandSchema.parse(mapHostReferences(input, id => parseHostEntityKey(id)?.id ?? id))
      if (parsed.type !== 'observe-threads') throw new Error('The viewed threads could not be read.')
      const rawIds = (input as { threadIds: string[] }).threadIds
      await Promise.all([...this.hosts.values()].map(async ({ connection }) => {
        if (connection.available?.() === false) return
        const ids = rawIds.filter(id => (parseHostEntityKey(id)?.hostId ?? this.selectedHostId) === connection.hostId).map(id => parseHostEntityKey(id)?.id ?? id)
        if (connection.observe) await connection.observe(ids)
        else await connection.service.command({ type: 'observe-threads', threadIds: ids }, client)
      }))
      return this.shell()
    }
    if (references.size > 1) throw new Error('This action includes items from different hosts. Select items from one host.')
    const hostId = [...references][0] ?? this.selectedHostId
    const { connection } = this.target(hostId ? hostEntityKey(hostId, '_') : undefined)
    const command = agentCommandSchema.parse(mapHostReferences(input, id => parseHostEntityKey(id)?.id ?? id))
    if (command.type === 'select-thread') {
      this.selectedHostId = connection.hostId
      this.selectedThreadId = command.threadId ? hostEntityKey(connection.hostId, command.threadId) : null
      this.selectedProjectId = this.shell().host.threads.find(thread => thread.id === this.selectedThreadId)?.projectId ?? null
      this.emit(); return this.shell()
    }
    if (command.type === 'select-project') {
      this.selectedHostId = connection.hostId; this.selectedProjectId = command.projectId ? hostEntityKey(connection.hostId, command.projectId) : null; this.selectedThreadId = null; this.emit(); return this.shell()
    }
    if (connection.available?.() === false) throw new Error('This host is disconnected. Connect again before sending. No command was sent.')
    if (connection.kind === 'remote' && ['open-thread-folder', 'open-folder'].includes(command.type)) throw new Error('This folder is on the host machine. Open it there.')
    const result = await connection.service.command(command as AgentCommand, client)
    if (result.error) this.notice = result.error
    this.emit()
    return agentShell(this.shell())
  }
  private emit(): void { const state = this.shell(); for (const listener of this.listeners) listener(state) }
  dispose(): void { for (const hostId of [...this.hosts.keys()]) this.remove(hostId); this.listeners.clear(); this.detailListeners.clear() }
}
