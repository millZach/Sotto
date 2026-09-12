import type { AgentAttachment, AgentHostSnapshot, AgentThreadOptions, ProviderId } from '../../shared/agents'

export type AgentHostCommand =
  | { readonly type: 'create-project'; readonly provider?: ProviderId; readonly commandId: string; readonly projectId: string; readonly title: string; readonly path: string }
  | ({ readonly type: 'create-thread'; readonly commandId: string; readonly threadId: string; readonly projectId: string; readonly title: string; readonly modelId: string } & AgentThreadOptions)
  | ({ readonly type: 'configure-thread'; readonly commandId: string; readonly threadId: string } & AgentThreadOptions)
  | { readonly type: 'send'; readonly commandId: string; readonly threadId: string; readonly messageId: string; readonly text: string; readonly attachments?: AgentAttachment[]; readonly expectedLastUserMessageId?: string | null }
  | { readonly type: 'answer'; readonly commandId: string; readonly threadId: string; readonly requestId: string; readonly answer: string; readonly approved?: boolean }
  | { readonly type: 'interrupt'; readonly commandId: string; readonly threadId: string }
export interface AgentHostResult { readonly accepted: boolean; readonly uncertain?: boolean }
/**
 * Sotto thread interface: create = execute create-thread; resume = observeThreads then snapshot;
 * prompt = execute send; cancel = execute interrupt; status = snapshot; events = subscribe.
 */
export interface AgentHost {
  connect(provider?: ProviderId): Promise<AgentHostSnapshot>
  snapshot(provider?: ProviderId): Promise<AgentHostSnapshot>
  /** Refresh only this thread's authoritative history/status, returning the full cached snapshot.
   * Native adapters must not join a refresh blocked on another thread or model discovery. */
  refreshThread?(threadId: string): Promise<AgentHostSnapshot>
  /** Throws only for a definitive rejection before commitment; unknown delivery returns uncertain. */
  execute(command: AgentHostCommand): Promise<AgentHostResult>
  /** Resolve saved pre-composite IDs without changing provider session identity. */
  providerForThread?(threadId: string): ProviderId | undefined
  resolveProjectId?(id: string): string
  resolveModelId?(id: string): string
  subscribe(listener: (snapshot: AgentHostSnapshot) => void): () => void
  observeThreads?(threadIds: readonly string[]): void
  disconnect(provider?: ProviderId): void
}
