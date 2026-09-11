import type { AgentHostSnapshot } from '../../shared/agents'
import type { AgentHost, AgentHostCommand, AgentHostConnection, AgentHostResult } from './host'

/** Configuration is restored after construction, so select the provider only when connecting. */
export class ConfiguredProviderHost implements AgentHost {
  private active: 't3' | 'codex' = 't3'
  private observed: readonly string[] = []
  constructor(private readonly options: { hosts: Record<'t3' | 'codex', AgentHost>; provider: () => 't3' | 'codex' }) {}
  async connect(connection: AgentHostConnection): Promise<AgentHostSnapshot> {
    this.active = this.options.provider()
    this.options.hosts[this.active === 't3' ? 'codex' : 't3'].disconnect()
    this.options.hosts[this.active].observeThreads?.(this.observed)
    return this.options.hosts[this.active].connect(connection)
  }
  snapshot(): Promise<AgentHostSnapshot> { return this.options.hosts[this.active].snapshot() }
  execute(command: AgentHostCommand): Promise<AgentHostResult> { return this.options.hosts[this.active].execute(command) }
  observeThreads(ids: readonly string[]): void { this.observed = [...ids]; this.options.hosts[this.active].observeThreads?.(ids) }
  disconnect(): void { this.options.hosts[this.active].disconnect() }
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void {
    const unsubscribe = (['t3', 'codex'] as const).map(provider => this.options.hosts[provider].subscribe(snapshot => {
      if (this.active === provider) listener(snapshot)
    }))
    return () => unsubscribe.forEach(dispose => dispose())
  }
}
