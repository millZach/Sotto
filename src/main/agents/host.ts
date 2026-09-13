import type { AgentSkillCatalog, AgentSkillReference } from '../../shared/agentSkills'
import type { AgentAttachment, AgentHostSnapshot, AgentProject, AgentThreadOptions, ProviderId } from '../../shared/agents'

export type AgentHostCommand =
  | { readonly type: 'create-project'; readonly provider?: ProviderId; readonly commandId: string; readonly projectId: string; readonly title: string; readonly path: string }
  | ({ readonly type: 'create-thread'; readonly commandId: string; readonly threadId: string; readonly projectId: string; readonly title: string; readonly modelId: string; readonly project?: AgentProject; readonly workingCopy?: 'independent' | 'shared'; readonly workingDirectory?: string } & AgentThreadOptions)
  | ({ readonly type: 'configure-thread'; readonly commandId: string; readonly threadId: string } & AgentThreadOptions)
  | { readonly type: 'send'; readonly commandId: string; readonly threadId: string; readonly messageId: string; readonly text: string; readonly skills?: AgentSkillReference[]; readonly attachments?: AgentAttachment[]; readonly expectedLastUserMessageId?: string | null }
  | { readonly type: 'answer'; readonly commandId: string; readonly threadId: string; readonly requestId: string; readonly answer: string; readonly approved?: boolean }
  | { readonly type: 'interrupt'; readonly commandId: string; readonly threadId: string }
export interface AgentHostResult { readonly accepted: boolean; readonly uncertain?: boolean }
export interface AgentSkillScope { readonly providerId: ProviderId; readonly workingDirectory: string }
/**
 * Sotto thread interface: create = execute create-thread; resume = observeThreads then snapshot;
 * prompt = execute send; cancel = execute interrupt; status = snapshot; events = subscribe.
 */
export interface AgentHost {
  /** Scope is constructed only by WorkspaceHost for an unstarted local thread. */
  listThreadSkills?(threadId: string, forceReload?: boolean, scope?: AgentSkillScope): Promise<AgentSkillCatalog>
  readonly concurrentProviders?: boolean
  initialize?(): Promise<void>
  /** Local organization/history; available without a provider connection. */
  workspaceSnapshot?(): AgentHostSnapshot
  setWorkspaceSettled?(kind: 'project' | 'thread', id: string, settled: boolean): Promise<AgentHostSnapshot>
  updateThreadWorktree?(threadId: string, retry: boolean): Promise<AgentHostSnapshot>
  threadWorkingDirectory?(threadId: string): Promise<string>
  privacyChanged?(): Promise<void>
  createProjectId?(provider: ProviderId): string
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
