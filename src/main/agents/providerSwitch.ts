import { providerIdSchema, type ProviderId, type AgentHostSnapshot } from '../../shared/agents'
import type { AgentHost, AgentHostCommand, AgentHostResult } from './host'

/** Configuration is restored after construction, so select the provider only when connecting. */
export class ConfiguredProviderHost implements AgentHost {
  private active: ProviderId = 'codex'
  private observed: readonly string[] = []
  constructor(private readonly options: { hosts: Record<ProviderId, AgentHost>; provider: () => ProviderId }) {}
  async connect(): Promise<AgentHostSnapshot> {
    this.active = this.options.provider()
    for (const provider of providerIdSchema.options) {
      if (provider !== this.active) this.options.hosts[provider].disconnect()
    }
    this.options.hosts[this.active].observeThreads?.(this.observed)
    return this.options.hosts[this.active].connect()
  }
  snapshot(): Promise<AgentHostSnapshot> { return this.options.hosts[this.active].snapshot() }
  execute(command: AgentHostCommand): Promise<AgentHostResult> { return this.options.hosts[this.active].execute(command) }
  observeThreads(ids: readonly string[]): void { this.observed = [...ids]; this.options.hosts[this.active].observeThreads?.(ids) }
  disconnect(): void { this.options.hosts[this.active].disconnect() }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    const unsubscribe = providerIdSchema.options.map(provider => this.options.hosts[provider].subscribe(snapshot => {
      if (this.active === provider) listener(snapshot)
    }))
    return () => unsubscribe.forEach(dispose => dispose())
  }
}
